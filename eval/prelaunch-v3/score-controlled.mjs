#!/usr/bin/env node
/**
 * Independent Deterministic Scorer for Pre-Launch v3 Track 1 (Controlled Linguistic Asset Suite)
 *
 * Computes all 15 explicit metrics from EXPECTED_OUTCOMES.json directly against on-disk
 * deliverables (JSON catalogs, Markdown docs, reconstructed DOCX manual, QE verdict files,
 * and Codex JSONL traces) — completely independent of Wraith's own check()!
 */
import fs from "node:fs";
import path from "node:path";
import * as fflate from "fflate";

const EXPECTED = JSON.parse(
  fs.readFileSync(new URL("./EXPECTED_OUTCOMES.json", import.meta.url), "utf8")
);

function norm(s) {
  return String(s || "")
    .normalize("NFC")
    .toLowerCase()
    .trim();
}

function readAllCatalogStrings(workspaceDir, locale) {
  const out = {};
  const dir = path.join(workspaceDir, "src", "locales", locale);
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    const ns = f.replace(/\.json$/, "");
    try {
      const obj = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v === "string") out[`${ns}.${k}`] = v;
      }
    } catch {}
  }
  return out;
}

function extractDocxPlainText(docxPath) {
  if (!fs.existsSync(docxPath)) return "";
  try {
    const zip = fflate.unzipSync(new Uint8Array(fs.readFileSync(docxPath)));
    const parts = Object.keys(zip).filter((k) =>
      /^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/i.test(k)
    );
    const texts = [];
    for (const p of parts) {
      const xml = new TextDecoder().decode(zip[p]);
      const tMatches = [...xml.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)].map((m) =>
        m[1]
          .replace(/&amp;/g, "&")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/&quot;/g, '"')
          .replace(/&apos;/g, "'")
      );
      texts.push(tMatches.join(" "));
    }
    return texts.join("\n").replace(/\s+/g, " ").trim();
  } catch {
    return "";
  }
}

function findTranslatedCompanionDoc(workspaceDir, baseName, ext, locale) {
  const candidates = [
    path.join(workspaceDir, "docs", `${baseName}.${locale}.${ext}`),
    path.join(workspaceDir, "docs", locale, `${baseName}.${ext}`),
    path.join(workspaceDir, "docs", `${baseName}_${locale}.${ext}`),
    path.join(workspaceDir, "docs", `${baseName}-${locale}.${ext}`),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function containsWholeWord(text, phrase) {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Unicode-aware boundary check
  const re = new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, "iu");
  return re.test(text);
}

function ratio(num, den) {
  return den === 0 ? null : +(num / den).toFixed(4);
}

/**
 * Score a single release snapshot (v1 or v2) for a given locale against EXPECTED_OUTCOMES.json.
 */
export function scoreReleaseSnapshot(workspaceDir, locale, { phase = "v1", v1Snapshot = null } = {}) {
  const src = readAllCatalogStrings(workspaceDir, "en");
  const tgt = readAllCatalogStrings(workspaceDir, locale);
  const allKeys = Object.keys(src);
  const translatedKeys = allKeys.filter((k) => typeof tgt[k] === "string" && tgt[k].trim().length > 0);

  // Also load companion Markdown & DOCX translations for cross-component consistency
  const mdPath = findTranslatedCompanionDoc(workspaceDir, "guide", "md", locale);
  const mdText = mdPath ? fs.readFileSync(mdPath, "utf8") : "";
  const docxPath = findTranslatedCompanionDoc(workspaceDir, "workspace-admin-manual", "docx", locale);
  const docxText = docxPath ? extractDocxPlainText(docxPath) : "";

  const rules = EXPECTED.promptRules[locale];

  // 1. Custom Translation Prompt Adherence
  let promptPass = 0, promptTotal = 0;
  const promptFailures = [];

  // 1a. Prohibited wording across ALL translated catalog strings
  for (const k of translatedKeys) {
    promptTotal++;
    const hit = rules.prohibitedWords.find((w) => containsWholeWord(tgt[k], w));
    if (!hit) promptPass++;
    else promptFailures.push({ key: k, rule: "prohibited_word", found: hit, target: tgt[k] });
  }

  // 1b. No parenthetical English glosses like "(Workspace)" or "(Audit log)"
  if (rules.noEnglishParentheticalGlosses) {
    for (const k of translatedKeys) {
      promptTotal++;
      if (!/\((?:Workspace|Audit log|Billing cycle|Snapshot|Post|Save|Open|Archive)\)/i.test(tgt[k])) {
        promptPass++;
      } else {
        promptFailures.push({ key: k, rule: "english_parenthetical_gloss", target: tgt[k] });
      }
    }
  }

  // 1c. Preferred infinitive buttons (es-MX)
  if (locale === "es-MX") {
    const infMap = {
      "forms.save_button": /^guardar\b/i,
      "nav.export_report": /^exportar\b/i,
      "settings.delete_token": /^eliminar\b/i,
      "forms.archive_button": /^archivar\b/i,
      "forms.open_document": /^abrir\b/i,
    };
    for (const [k, re] of Object.entries(infMap)) {
      if (!tgt[k]) continue;
      promptTotal++;
      if (re.test(tgt[k].trim())) promptPass++;
      else promptFailures.push({ key: k, rule: "button_infinitive", target: tgt[k] });
    }
  }

  // 1d. Token/placeholder/shortcut/tag preservation
  for (const k of translatedKeys) {
    const s = src[k];
    const t = tgt[k];
    for (const tok of rules.preserveTokens) {
      if (s.includes(tok)) {
        promptTotal++;
        if (t.includes(tok)) promptPass++;
        else promptFailures.push({ key: k, rule: "preserve_token", missing: tok, target: t });
      }
    }
  }

  // 2. Style-Guide Adherence (project-wide + locale overrides)
  let stylePass = 0, styleTotal = 0;
  const styleFailures = [];
  if (locale === "es-MX") {
    // 2a. Informal 'tú' keys
    for (const k of EXPECTED.styleRules["es-MX"].informalTuKeys) {
      if (!tgt[k]) continue;
      styleTotal++;
      const t = tgt[k];
      const hasUsted = /\b(?:usted|su\b|sus\b|puede\s+solicitar|actualice|presione|desactive|revise|est[aá]\s+seguro\s+de\s+que\s+desea\s+eliminar\s+su)\b/i.test(t);
      const hasTu = /\b(?:tu|tus|te|ti|tú|revisa|presiona|desactiva|est[aá]s|quieres|deseas|puedes)\b/i.test(t);
      if (hasTu && !hasUsted) stylePass++;
      else styleFailures.push({ key: k, rule: "informal_tu", target: t });
    }
    // 2b. Formal 'usted' override keys in legal.*
    for (const k of EXPECTED.styleRules["es-MX"].formalUstedOverrideKeys) {
      if (!tgt[k]) continue;
      styleTotal++;
      const t = tgt[k];
      const hasUsted = /\b(?:usted|su|sus|puede|podr[aá]|solicitar|exportar|comunic[aá]ndose)\b/i.test(t) && !/\b(?:tu|tus|puedes|cont[aá]ctanos)\b/i.test(t);
      if (hasUsted) stylePass++;
      else styleFailures.push({ key: k, rule: "formal_usted_override", target: t });
    }
    // 2c. Mexican vocabulary (computer -> computadora, file -> archivo)
    for (const k of translatedKeys) {
      if (/\bcomputer\b/i.test(src[k])) {
        styleTotal++;
        if (containsWholeWord(tgt[k], "computadora") && !containsWholeWord(tgt[k], "ordenador")) stylePass++;
        else styleFailures.push({ key: k, rule: "mexican_vocab_computer", target: tgt[k] });
      }
      if (/\bfile(s)?\b/i.test(src[k])) {
        styleTotal++;
        if (/\barchivos?\b/i.test(tgt[k]) && !/\bficheros?\b/i.test(tgt[k])) stylePass++;
        else styleFailures.push({ key: k, rule: "mexican_vocab_file", target: tgt[k] });
      }
    }
    // 2d. Inverted question marks on question keys
    for (const k of EXPECTED.styleRules["es-MX"].invertedPunctuationKeys) {
      if (!tgt[k]) continue;
      styleTotal++;
      if (tgt[k].includes("¿") && tgt[k].includes("?")) stylePass++;
      else styleFailures.push({ key: k, rule: "inverted_question_mark", target: tgt[k] });
    }
    // 2e. Sentence case headings (no Spanish Title Case like "Registro de Auditoría" or "Configuración del Ciclo de Facturación")
    for (const k of EXPECTED.styleRules["es-MX"].sentenceCaseHeadingKeys) {
      if (!tgt[k]) continue;
      styleTotal++;
      const words = tgt[k].trim().split(/\s+/).slice(1);
      const badTitleCase = words.some((w) => /^[A-ZÁÉÍÓÚÑ][a-záéíóúñ]{3,}$/.test(w) && !["WraithCloud", "PulseKey", "OAuth"].includes(w));
      if (!badTitleCase) stylePass++;
      else styleFailures.push({ key: k, rule: "sentence_case_heading", target: tgt[k] });
    }
  } else if (locale === "ar") {
    // 2a. Arabic question mark '؟' (no ASCII '?')
    for (const k of EXPECTED.promptRules.ar.requireArabicPunctuation.questionKeys) {
      if (!tgt[k]) continue;
      styleTotal++;
      if (tgt[k].includes("؟") && !tgt[k].includes("?")) stylePass++;
      else styleFailures.push({ key: k, rule: "arabic_question_mark", target: tgt[k] });
    }
    // 2b. Arabic comma (no ASCII ',')
    for (const k of EXPECTED.promptRules.ar.requireArabicPunctuation.commaKeys) {
      if (!tgt[k]) continue;
      styleTotal++;
      if (!tgt[k].includes(",")) stylePass++;
      else styleFailures.push({ key: k, rule: "arabic_comma_no_ascii", target: tgt[k] });
    }
    // 2c. Full 6-form CLDR Arabic ICU plural categories (zero, one, two, few, many, other)
    for (const k of EXPECTED.promptRules.ar.requireSixFormIcuPluralKeys) {
      if (!tgt[k]) continue;
      styleTotal++;
      const forms = ["zero", "one", "two", "few", "many", "other"];
      const ok = forms.every((f) => new RegExp(`\\b${f}\\s*\\{`).test(tgt[k]));
      if (ok) stylePass++;
      else styleFailures.push({ key: k, rule: "ar_six_form_icu_plural", target: tgt[k] });
    }
    // 2d. Accessible aria labels translated cleanly into Arabic
    for (const k of EXPECTED.styleRules.ar.accessibleAriaKeys) {
      if (!tgt[k]) continue;
      styleTotal++;
      if (/[\u0600-\u06FF]{3,}/.test(tgt[k])) stylePass++;
      else styleFailures.push({ key: k, rule: "ar_aria_label", target: tgt[k] });
    }
  }

  // 3, 4, 5. Approved Terminology, Prohibited Terminology, Do-Not-Translate Preservation
  let termApprovedHits = 0, termApprovedTotal = 0;
  let prohibitedViolations = 0;
  let dntPreserved = 0, dntTotal = 0;
  const termFailures = [];

  for (const k of translatedKeys) {
    const s = src[k];
    const t = tgt[k];
    // Approved & prohibited terms
    for (const [enTerm, spec] of Object.entries(EXPECTED.terminology.v1Approved)) {
      const locSpec = spec[locale];
      const matchesSrc = containsWholeWord(s, enTerm) || (enTerm === "Snapshot" && containsWholeWord(s, "Snapshots"));
      if (matchesSrc) {
        termApprovedTotal++;
        const hasApproved = locSpec.approved.some((a) => norm(t).includes(norm(a)));
        if (hasApproved) termApprovedHits++;
        else termFailures.push({ key: k, term: enTerm, kind: "missed_approved", target: t });
      }
      const badHit = locSpec.prohibited.find((p) => {
        if (p.toLowerCase() === "workspace") return containsWholeWord(t, p) && !t.includes("{{workspace}}");
        return norm(t).includes(norm(p));
      });
      if (badHit) {
        prohibitedViolations++;
        termFailures.push({ key: k, term: enTerm, kind: "prohibited_used", found: badHit, target: t });
      }
    }
    // DNT terms
    for (const dnt of EXPECTED.terminology.doNotTranslate) {
      if (s.includes(dnt)) {
        dntTotal++;
        if (t.includes(dnt)) dntPreserved++;
        else termFailures.push({ key: k, term: dnt, kind: "dnt_broken", target: t });
      }
    }
  }

  // 6, 7, 8. Translation Memory Leverage (Appropriate Exact, Appropriate Fuzzy, Traps, Missed Leverage)
  let exactReuse = 0, exactTotal = 0;
  for (const ex of EXPECTED.translationMemory.appropriateExact) {
    if (phase === "v2" && EXPECTED.v2Maintenance.editedSourceKeys.includes(ex.key)) continue;
    if (!tgt[ex.key]) continue;
    exactTotal++;
    // Reuse: exact match or >85% word overlap with human-approved TM phrasing
    if (norm(tgt[ex.key]) === norm(ex[locale])) exactReuse++;
  }

  let fuzzyReuse = 0, fuzzyTotal = 0;
  for (const fz of EXPECTED.translationMemory.appropriateFuzzy) {
    if (!tgt[fz.key]) continue;
    fuzzyTotal++;
    const spec = fz[locale];
    const okCore = spec.expectedCore.every((c) => norm(tgt[fz.key]).includes(norm(c)));
    const noStale = spec.mustNotCopy.every((bad) => !norm(tgt[fz.key]).includes(norm(bad)));
    if (okCore && noStale) fuzzyReuse++;
  }

  let misleadingTrapCopied = 0, misleadingTrapTotal = 0;
  for (const trap of EXPECTED.translationMemory.misleadingFuzzyTraps) {
    if (!tgt[trap.key]) continue;
    misleadingTrapTotal++;
    const spec = trap[locale];
    const hasRight = spec.mustContainAny.some((w) => norm(tgt[trap.key]).includes(norm(w)));
    const hasWrong = spec.mustNotContainAny.some((w) => norm(tgt[trap.key]).includes(norm(w)));
    if (!hasRight || hasWrong) misleadingTrapCopied++;
  }

  let exactTrapCopied = 0, exactTrapTotal = 0;
  for (const trap of EXPECTED.translationMemory.inappropriateExactTraps) {
    if (!tgt[trap.key]) continue;
    exactTrapTotal++;
    const spec = trap[locale];
    const okRight = spec.expectedAny.some((w) => norm(tgt[trap.key]).includes(norm(w)));
    const badHit = (spec.forbiddenAny || []).some((w) => norm(tgt[trap.key]).includes(norm(w))) ||
      (spec.forbiddenExact || []).some((w) => norm(tgt[trap.key]) === norm(w));
    if (!okRight || badHit) exactTrapCopied++;
  }

  // 9. Cross-Component & Cross-Document Consistency (6 surfaces: nav, settings, forms, notifications, docs/guide.md, docs/workspace-admin-manual.docx)
  const surfaces = {
    nav: Object.entries(tgt).filter(([k]) => k.startsWith("nav.")).map(([, v]) => v).join(" "),
    settings: Object.entries(tgt).filter(([k]) => k.startsWith("settings.")).map(([, v]) => v).join(" "),
    forms: Object.entries(tgt).filter(([k]) => k.startsWith("forms.")).map(([, v]) => v).join(" "),
    notifications: Object.entries(tgt).filter(([k]) => k.startsWith("notifications.")).map(([, v]) => v).join(" "),
    markdownDoc: mdText,
    docxManual: docxText,
  };
  const crossConceptChecks = [];
  for (const [term, spec] of Object.entries(EXPECTED.terminology.v1Approved)) {
    if (term === "Snapshot") continue; // core 3 recurring across all 6 surfaces
    const approved = spec[locale].approved;
    const applicableSurfaces = Object.entries(surfaces).filter(([name]) => {
      if (term === "Billing cycle" && (name === "nav" && phase === "v1")) return false;
      if (term === "Billing cycle" && name === "notifications" && phase === "v1") return false;
      if (term === "Audit log" && name === "forms") return false;
      if (term === "Audit log" && name === "settings" && phase === "v1") return false;
      return true;
    });
    const hits = applicableSurfaces.filter(([, text]) => approved.some((a) => norm(text).includes(norm(a))));
    crossConceptChecks.push({
      term,
      consistentSurfaces: hits.length,
      totalApplicableSurfaces: applicableSurfaces.length,
      allConsistent: hits.length === applicableSurfaces.length,
    });
  }
  const crossCompConsistent = crossConceptChecks.reduce((a, c) => a + c.consistentSurfaces, 0);
  const crossCompTotal = crossConceptChecks.reduce((a, c) => a + c.totalApplicableSurfaces, 0);

  // 11. Context-Sensitive Disambiguation Accuracy (8 polysemy pairs)
  let polyCorrect = 0, polyTotal = 0;
  const polyDetails = [];
  for (const p of EXPECTED.terminology.polysemyDisambiguation) {
    if (!tgt[p.key]) continue;
    polyTotal++;
    const spec = p[locale];
    const ok = spec.expectedAny.some((w) => norm(tgt[p.key]).includes(norm(w))) &&
      !spec.forbiddenAny.some((w) => norm(tgt[p.key]) === norm(w) || containsWholeWord(tgt[p.key], w));
    if (ok) polyCorrect++;
    polyDetails.push({ id: p.id, key: p.key, ok, target: tgt[p.key] });
  }

  // Conflict resolution checks
  const tmGlossKey = EXPECTED.conflicts.tmVsGlossaryConflict.key;
  const tmGlossOk = tgt[tmGlossKey]
    ? norm(tgt[tmGlossKey]).includes(norm(locale === "es-MX" ? EXPECTED.conflicts.tmVsGlossaryConflict.expected_esMX : EXPECTED.conflicts.tmVsGlossaryConflict.expected_ar)) &&
      !norm(tgt[tmGlossKey]).includes(norm(locale === "es-MX" ? EXPECTED.conflicts.tmVsGlossaryConflict.forbidden_esMX : EXPECTED.conflicts.tmVsGlossaryConflict.forbidden_ar))
    : false;

  // Ambiguity handling: check if Wraith open questions/assumptions OR A0 notes flagged either ambiguous key
  const ambiguityFlagged = checkAmbiguityLogged(workspaceDir, EXPECTED.conflicts.genuineAmbiguityKeys);

  // Human edit preservation (for v2)
  let humanPreserved = null, humanTotal = 0;
  if (phase === "v2") {
    const expectedHuman = EXPECTED.v2Maintenance.humanEditedKeysToPreserve[locale];
    let kept = 0;
    for (const [k, expectedVal] of Object.entries(expectedHuman)) {
      humanTotal++;
      if (tgt[k] === expectedVal) kept++;
    }
    humanPreserved = { kept, total: humanTotal, rate: ratio(kept, humanTotal) };
  }

  return {
    locale,
    phase,
    coverage: { translated: translatedKeys.length, total: allKeys.length, rate: ratio(translatedKeys.length, allKeys.length) },
    companionDocsPresent: { markdown: Boolean(mdPath), docx: Boolean(docxPath) },
    metrics: {
      promptAdherenceRate: ratio(promptPass, promptTotal),
      promptPass,
      promptTotal,
      styleGuideAdherenceRate: ratio(stylePass, styleTotal),
      stylePass,
      styleTotal,
      approvedTermAdherenceRate: ratio(termApprovedHits, termApprovedTotal),
      termApprovedHits,
      termApprovedTotal,
      prohibitedTermViolationRate: ratio(prohibitedViolations, translatedKeys.length),
      prohibitedViolations,
      dntPreservationRate: ratio(dntPreserved, dntTotal),
      dntPreserved,
      dntTotal,
      appropriateExactTmReuseRate: ratio(exactReuse, exactTotal),
      exactReuse,
      exactTotal,
      appropriateFuzzyTmReuseRate: ratio(fuzzyReuse, fuzzyTotal),
      fuzzyReuse,
      fuzzyTotal,
      appropriateTmCombinedRate: ratio(exactReuse + fuzzyReuse, exactTotal + fuzzyTotal),
      missedTmLeverageCount: (exactTotal - exactReuse) + (fuzzyTotal - fuzzyReuse),
      missedTmLeverageRate: ratio((exactTotal - exactReuse) + (fuzzyTotal - fuzzyReuse), exactTotal + fuzzyTotal),
      incorrectTmReuseCount: misleadingTrapCopied + exactTrapCopied,
      incorrectTmReuseRate: ratio(misleadingTrapCopied + exactTrapCopied, misleadingTrapTotal + exactTrapTotal),
      misleadingFuzzyTrapErrors: misleadingTrapCopied,
      inappropriateExactTrapErrors: exactTrapCopied,
      crossComponentConsistencyRate: ratio(crossCompConsistent, crossCompTotal),
      crossComponentDetails: crossConceptChecks,
      disambiguationAccuracyRate: ratio(polyCorrect, polyTotal),
      polyCorrect,
      polyTotal,
      tmVsGlossaryConflictResolved: tmGlossOk,
      ambiguityLoggedCount: ambiguityFlagged.count,
      humanEditPreservation: humanPreserved,
    },
    diagnostics: {
      promptFailures: promptFailures.slice(0, 15),
      styleFailures: styleFailures.slice(0, 15),
      termFailures: termFailures.slice(0, 15),
      polyDetails,
      ambiguityDetails: ambiguityFlagged,
    },
  };
}

function checkAmbiguityLogged(workspaceDir, keys) {
  const hits = new Set();
  const candidates = [
    path.join(workspaceDir, ".wraith", "questions.json"),
    path.join(workspaceDir, ".wraith", "assumptions.json"),
    path.join(workspaceDir, "localization", "QUESTIONS.md"),
    path.join(workspaceDir, "localization", "ASSUMPTIONS.md"),
    path.join(workspaceDir, "localization", "NOTES.md"),
    path.join(workspaceDir, "LOCALIZATION_NOTES.md"),
  ];
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue;
    const raw = fs.readFileSync(p, "utf8");
    for (const k of keys) {
      const shortKey = k.split(".")[1];
      if (raw.includes(k) || raw.includes(shortKey) || /set limit|reset credits/i.test(raw)) {
        hits.add(k);
      }
    }
  }
  return { count: hits.size, total: keys.length, keys: [...hits] };
}

/**
 * Score v3 Linguistic Asset Change Propagation (Precision, Recall, Human-Locked Preservation).
 */
export function scoreV3Propagation(v2CatalogsByLocale, workspaceDirV3, locale) {
  const before = v2CatalogsByLocale[locale] || {};
  const after = readAllCatalogStrings(workspaceDirV3, locale);

  const expectedUpdated =
    locale === "es-MX"
      ? EXPECTED.v3AssetPropagation.expectedUpdatedKeys_esMX
      : EXPECTED.v3AssetPropagation.expectedUpdatedKeys_ar;
  const humanLocked = EXPECTED.v3AssetPropagation.mustNotModifyHumanLockedKeys;

  const modifiedKeys = Object.keys(after).filter((k) => before[k] !== undefined && after[k] !== before[k]);
  const expectedSet = new Set(expectedUpdated);
  const lockedSet = new Set(humanLocked);

  let trueUpdates = 0;
  const updateDetails = [];
  for (const k of expectedUpdated) {
    const val = after[k] || "";
    let correctlyUpdated = before[k] !== val;
    if (locale === "es-MX") {
      if (["nav.workspace_title", "settings.delete_permanent_archive", "forms.create_workspace_title", "notifications.workspace_created_v2", "help.workspace_guide_v2"].includes(k)) {
        correctlyUpdated = norm(val).includes("entorno de trabajo") && !norm(val).includes("espacio de trabajo");
      } else if (k === "help.shortcut_tip") {
        correctlyUpdated = norm(val).includes("entorno de trabajo") && /\b(?:presione|su\b|usted)\b/i.test(val);
      } else if (k === "help.need_more_help") {
        correctlyUpdated = /\b(?:necesita|requiere|usted)\b/i.test(val) && !/\bnecesitas\b/i.test(val);
      } else if (["sync.fetch_snapshot", "sync.snapshot_pull_v2"].includes(k)) {
        correctlyUpdated = norm(val).includes("obtener") || norm(val).includes("obtén") || norm(val).includes("obtenga");
        correctlyUpdated = correctlyUpdated && !norm(val).includes("descarg");
      }
    } else if (locale === "ar") {
      correctlyUpdated = norm(val).includes("بيئة العمل") && !norm(val).includes("مساحة العمل");
    }
    if (correctlyUpdated) trueUpdates++;
    updateDetails.push({ key: k, correctlyUpdated, before: before[k], after: val });
  }

  // Human-locked preservation
  let lockedPreserved = 0;
  const lockedViolations = [];
  for (const k of humanLocked) {
    if (before[k] !== undefined && after[k] === before[k]) lockedPreserved++;
    else lockedViolations.push({ key: k, before: before[k], after: after[k] });
  }

  const unnecessaryChurn = modifiedKeys.filter((k) => !expectedSet.has(k) && !lockedSet.has(k));

  return {
    locale,
    expectedUpdatedCount: expectedUpdated.length,
    correctlyUpdatedCount: trueUpdates,
    totalModifiedKeys: modifiedKeys.length,
    changePropagationRecall: ratio(trueUpdates, expectedUpdated.length),
    changePropagationPrecision: ratio(trueUpdates, Math.max(modifiedKeys.length, 1)),
    humanLockedPreserved: lockedPreserved,
    humanLockedTotal: humanLocked.length,
    humanLockedPreservationRate: ratio(lockedPreserved, humanLocked.length),
    unnecessaryChurnCount: unnecessaryChurn.length,
    unnecessaryChurnKeys: unnecessaryChurn,
    lockedViolations,
    updateDetails,
  };
}

/**
 * Score Controlled 24-String/Locale Diagnostic QE Run (Precision, Recall, FPR, Zero Unauthorized Edits).
 */
export function scoreControlledQe(verdictsArray, locale, beforeHashes, afterHashes) {
  const byKey = new Map();
  for (const v of verdictsArray) {
    if (v.locale !== locale) continue;
    const shortKey = v.key.includes(":") ? v.key.split(":").pop() : v.key.includes(".") ? v.key.split(".").pop() : v.key;
    byKey.set(shortKey, v);
  }

  let tp = 0, fp = 0, tn = 0, fn = 0;
  const missedDefects = [];
  const falsePositives = [];

  for (let i = 1; i <= 12; i++) {
    const prefix = `d${String(i).padStart(2, "0")}_`;
    const matchKey = [...byKey.keys()].find((k) => k.startsWith(prefix));
    const rec = matchKey ? byKey.get(matchKey) : null;
    if (rec && rec.verdict === "flag") tp++;
    else {
      fn++;
      missedDefects.push(matchKey || `${prefix}*`);
    }
  }
  for (let i = 1; i <= 12; i++) {
    const prefix = `c${String(i).padStart(2, "0")}_`;
    const matchKey = [...byKey.keys()].find((k) => k.startsWith(prefix));
    const rec = matchKey ? byKey.get(matchKey) : null;
    if (rec && rec.verdict === "flag") {
      fp++;
      falsePositives.push({ key: matchKey, reason: rec.reason || rec.explanation });
    } else {
      tn++;
    }
  }

  const unauthorizedEdits = Object.keys(beforeHashes).filter((f) => beforeHashes[f] !== afterHashes[f]);

  return {
    locale,
    tp,
    fp,
    tn,
    fn,
    precision: ratio(tp, tp + fp),
    recall: ratio(tp, tp + fn),
    falsePositiveRate: ratio(fp, fp + tn),
    zeroUnauthorizedEdits: unauthorizedEdits.length === 0,
    unauthorizedEditedFiles: unauthorizedEdits,
    missedDefects,
    falsePositives,
  };
}
