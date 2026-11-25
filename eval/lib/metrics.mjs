/**
 * Pure-JS evaluation metrics:
 * - chrF2 (sacrebleu-compatible character n-gram F-score, n=1..6, beta=2)
 * - Deterministic QA metrics (expansion ratio, consistency, untranslated leakage)
 * - Bootstrap 95% confidence intervals (deterministic seeded PRNG)
 * - Cohen's kappa for inter-rater agreement
 */

function charNgrams(str, n) {
  const counts = new Map();
  if (str.length < n) return counts;
  for (let i = 0; i <= str.length - n; i++) {
    const gram = str.slice(i, i + n);
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  return counts;
}

/**
 * Standard chrF2 score in [0..100] (character n-grams 1..6, whitespace stripped, beta=2).
 */
export function computeChrF(hypothesis, reference, { maxN = 6, beta = 2 } = {}) {
  const hyp = String(hypothesis ?? "").replace(/\s+/g, "");
  const ref = String(reference ?? "").replace(/\s+/g, "");
  if (!hyp && !ref) return 100;
  if (!hyp || !ref) return 0;

  let avgPrec = 0;
  let avgRec = 0;
  let usedN = 0;

  for (let n = 1; n <= maxN; n++) {
    const hypGrams = charNgrams(hyp, n);
    const refGrams = charNgrams(ref, n);
    const hypTotal = Math.max(0, hyp.length - n + 1);
    const refTotal = Math.max(0, ref.length - n + 1);
    if (hypTotal === 0 || refTotal === 0) continue;

    let overlap = 0;
    for (const [g, c] of hypGrams) {
      const r = refGrams.get(g) ?? 0;
      if (r > 0) overlap += Math.min(c, r);
    }
    avgPrec += overlap / hypTotal;
    avgRec += overlap / refTotal;
    usedN++;
  }

  if (usedN === 0) return 0;
  const p = avgPrec / usedN;
  const r = avgRec / usedN;
  if (p === 0 && r === 0) return 0;
  const beta2 = beta * beta;
  const f = ((1 + beta2) * p * r) / (beta2 * p + r);
  return Number((f * 100).toFixed(2));
}

export function corpusChrF(pairs, opts) {
  if (!pairs.length) return 0;
  // Corpus-level micro-averaged chrF2 (matches sacrebleu default)
  const maxN = opts?.maxN ?? 6;
  const beta = opts?.beta ?? 2;
  let sumPrec = 0;
  let sumRec = 0;
  let usedN = 0;

  for (let n = 1; n <= maxN; n++) {
    let overlapTotal = 0;
    let hypTotal = 0;
    let refTotal = 0;
    for (const { hyp, ref } of pairs) {
      const h = String(hyp ?? "").replace(/\s+/g, "");
      const r = String(ref ?? "").replace(/\s+/g, "");
      if (h.length >= n) hypTotal += h.length - n + 1;
      if (r.length >= n) refTotal += r.length - n + 1;
      if (h.length < n || r.length < n) continue;
      const hg = charNgrams(h, n);
      const rg = charNgrams(r, n);
      for (const [g, c] of hg) {
        const rc = rg.get(g) ?? 0;
        if (rc > 0) overlapTotal += Math.min(c, rc);
      }
    }
    if (hypTotal === 0 || refTotal === 0) continue;
    sumPrec += overlapTotal / hypTotal;
    sumRec += overlapTotal / refTotal;
    usedN++;
  }

  if (usedN === 0) return 0;
  const p = sumPrec / usedN;
  const r = sumRec / usedN;
  if (p === 0 && r === 0) return 0;
  const beta2 = beta * beta;
  return Number(((((1 + beta2) * p * r) / (beta2 * p + r)) * 100).toFixed(2));
}

/** Deterministic mulberry32 PRNG */
export function makePrng(seed = 1337) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function wilsonCI(successes, total, z = 1.959964) {
  if (total <= 0) return { mean: 0, low: 0, high: 0, successes: 0, n: 0, method: "wilson" };
  const p = successes / total;
  const z2 = z * z;
  const denom = 1 + z2 / total;
  const center = (p + z2 / (2 * total)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total)) / denom;
  return {
    mean: Number(p.toFixed(4)),
    low: Number(Math.max(0, center - margin).toFixed(4)),
    high: Number(Math.min(1, center + margin).toFixed(4)),
    successes,
    n: total,
    method: "wilson",
  };
}

export function proportionCI(binaryValues, opts = {}) {
  const n = binaryValues.length;
  if (n === 0) return { mean: 0, low: 0, high: 0, n: 0, method: "wilson" };
  const successes = binaryValues.reduce((a, b) => a + (b ? 1 : 0), 0);
  // Always use Wilson score interval for proportions when 0% or 100% (or in general for bounded proportions)
  if (successes === 0 || successes === n || opts.preferWilson !== false) {
    return wilsonCI(successes, n);
  }
  return { ...bootstrapMeanCI(binaryValues, opts), method: "bootstrap" };
}

export function bootstrapMeanCI(values, { iterations = 2000, alpha = 0.05, seed = 42 } = {}) {
  const n = values.length;
  if (n === 0) return { mean: 0, low: 0, high: 0, n: 0 };
  const mean = values.reduce((a, b) => a + b, 0) / n;
  if (n === 1) return { mean, low: mean, high: mean, n: 1 };

  const rng = makePrng(seed);
  const samples = new Array(iterations);
  for (let b = 0; b < iterations; b++) {
    let sum = 0;
    for (let i = 0; i < n; i++) {
      sum += values[Math.floor(rng() * n)];
    }
    samples[b] = sum / n;
  }
  samples.sort((a, b) => a - b);
  const lowIdx = Math.max(0, Math.floor((alpha / 2) * iterations));
  const highIdx = Math.min(iterations - 1, Math.floor((1 - alpha / 2) * iterations));
  return {
    mean: Number(mean.toFixed(4)),
    low: Number(samples[lowIdx].toFixed(4)),
    high: Number(samples[highIdx].toFixed(4)),
    n,
  };
}

/**
 * Cohen's kappa for two arrays of categorical labels of equal length.
 */
export function cohensKappa(labelsA, labelsB) {
  const n = Math.min(labelsA.length, labelsB.length);
  if (n === 0) return { kappa: 0, observedAgreement: 0, expectedAgreement: 0, n: 0 };

  const cats = new Set([...labelsA.slice(0, n), ...labelsB.slice(0, n)]);
  const countA = new Map();
  const countB = new Map();
  let agree = 0;

  for (let i = 0; i < n; i++) {
    const a = labelsA[i];
    const b = labelsB[i];
    if (a === b) agree++;
    countA.set(a, (countA.get(a) ?? 0) + 1);
    countB.set(b, (countB.get(b) ?? 0) + 1);
  }

  const po = agree / n;
  let pe = 0;
  for (const c of cats) {
    pe += ((countA.get(c) ?? 0) / n) * ((countB.get(c) ?? 0) / n);
  }
  const kappa = Math.abs(1 - pe) < 1e-12 ? (po === 1 ? 1 : 0) : (po - pe) / (1 - pe);
  return {
    kappa: Number(kappa.toFixed(4)),
    observedAgreement: Number(po.toFixed(4)),
    expectedAgreement: Number(pe.toFixed(4)),
    n,
  };
}

/**
 * Deterministic catalog metrics independent of Polyglot's own check.
 */
export function computeCatalogMetrics(sourceMap, targetMap, glossaryEntries = [], contextGroups = null) {
  const keys = Object.keys(sourceMap);
  let translated = 0;
  let untranslated = 0;
  let missing = 0;
  const expansionRatios = [];

  const dntTerms = glossaryEntries.filter((g) => g.doNotTranslate).map((g) => g.term);
  let dntApplicable = 0;
  let dntAdhered = 0;
  let termApplicable = 0;
  let termAdheredExact = 0;
  let termAdheredInflected = 0;

  const stripDiacritics = (s) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

  for (const k of keys) {
    const src = String(sourceMap[k] ?? "");
    const tgt = targetMap[k];
    if (tgt === undefined || String(tgt).trim() === "") {
      missing++;
      continue;
    }
    const tgtStr = String(tgt);
    translated++;
    if (src.trim().length >= 4 && src.trim() === tgtStr.trim() && !dntTerms.includes(src.trim())) {
      untranslated++;
    }
    if (src.length >= 3) {
      expansionRatios.push(tgtStr.length / src.length);
    }

    for (const g of glossaryEntries) {
      const re = new RegExp(`\\b${g.term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, g.caseSensitive ? "" : "i");
      if (!re.test(src)) continue;
      if (g.doNotTranslate) {
        dntApplicable++;
        if (tgtStr.includes(g.term)) dntAdhered++;
      } else if (g.expectedTranslation) {
        termApplicable++;
        const exp = g.expectedTranslation;
        if (tgtStr.toLowerCase().includes(exp.toLowerCase())) {
          termAdheredExact++;
          termAdheredInflected++;
        } else {
          // Inflection-tolerant stem check (first >=4 chars of normalized words)
          const stem = stripDiacritics(exp).slice(0, Math.max(4, Math.floor(exp.length * 0.7)));
          if (stem.length >= 4 && stripDiacritics(tgtStr).includes(stem)) {
            termAdheredInflected++;
          }
        }
      }
    }
  }

  // Consistency: same (source, contextGroup) should map to same target
  const bySourceCtx = new Map();
  for (const k of keys) {
    const tgt = targetMap[k];
    if (!tgt) continue;
    const group = contextGroups?.[k] ?? "default";
    const sig = `${group}\0${sourceMap[k]}`;
    const set = bySourceCtx.get(sig) ?? new Set();
    set.add(tgt);
    bySourceCtx.set(sig, set);
  }
  let repeatedPairs = 0;
  let consistentPairs = 0;
  for (const [sig, targets] of bySourceCtx) {
    // Count how many keys share this sig
    const count = keys.filter((k) => `${contextGroups?.[k] ?? "default"}\0${sourceMap[k]}` === sig && targetMap[k]).length;
    if (count >= 2) {
      repeatedPairs++;
      if (targets.size === 1) consistentPairs++;
    }
  }

  const avgExpansion =
    expansionRatios.length > 0
      ? Number((expansionRatios.reduce((a, b) => a + b, 0) / expansionRatios.length).toFixed(3))
      : 0;
  const maxExpansion =
    expansionRatios.length > 0 ? Number(Math.max(...expansionRatios).toFixed(3)) : 0;

  return {
    totalKeys: keys.length,
    translated,
    missing,
    untranslated,
    avgExpansionRatio: avgExpansion,
    maxExpansionRatio: maxExpansion,
    dntAdherence: dntApplicable > 0 ? Number((dntAdhered / dntApplicable).toFixed(4)) : null,
    dntCounts: { adhered: dntAdhered, applicable: dntApplicable },
    glossaryExactAdherence: termApplicable > 0 ? Number((termAdheredExact / termApplicable).toFixed(4)) : null,
    glossaryInflectedAdherence: termApplicable > 0 ? Number((termAdheredInflected / termApplicable).toFixed(4)) : null,
    glossaryCounts: { exact: termAdheredExact, inflected: termAdheredInflected, applicable: termApplicable },
    consistencyRate: repeatedPairs > 0 ? Number((consistentPairs / repeatedPairs).toFixed(4)) : null,
    consistencyCounts: { consistent: consistentPairs, repeatedGroups: repeatedPairs },
  };
}
