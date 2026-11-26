#!/usr/bin/env node
/**
 * Proof-of-concept (NOT publishable evidence): does the binary in-context review catch planted
 * meaning errors that deterministic checks cannot see?
 *
 *   node eval/poc/qe-poc.mjs setup     # build project + review tasks; labels kept outside the project
 *   (a blind reviewer in a fresh context answers .wraith/qe-tasks.json → verdicts.json in the project dir)
 *   node eval/poc/qe-poc.mjs score     # submit verdicts, compute detection metrics
 *
 * Data: Stage 4 synthetic-app de gold (recurring strings: 20 clean + 20 corrupted) plus 10 one-off
 * checkout strings (5 clean + 5 corrupted) whose source appears nowhere else, so consistency with
 * sibling translations cannot give the error away. Every corruption keeps placeholders/ICU/tags
 * intact so `check` passes and only the reviewer can catch it.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const WORK = path.join(REPO, "eval/work/poc-qe");
const PROJECT = path.join(WORK, "project");
const LABELS = path.join(WORK, "labels.json");
const RESULTS = path.join(REPO, "eval/results/poc-qe.json");
const SYN = path.join(REPO, "eval/work/tm-ablation/synthetic-app");

const wraith = await import(path.join(REPO, "dist/index.js"));

// key -> [corrupted de, error class]
const CORRUPT = {
  "BillingForm.save": ["Sparen", "wrong-sense"], // save money
  "SignupForm.submit": ["Unterwerfen", "wrong-sense"], // submit = surrender
  "ApiKeysPanel.close": ["Nah", "wrong-sense"], // close = near
  "FileUploader.cancel": ["Kündigen", "wrong-sense"], // cancel a subscription
  "OrderHistory.active": ["Aktion", "wrong-sense"],
  "ApiKeysPanel.confirmDelete": ["Möchten Sie {name} wirklich nicht löschen?", "negation"],
  "UserProfileForm.required": ["Dieses Feld ist optional.", "inversion"],
  "SignupForm.minChars": ["Darf höchstens {min} Zeichen lang sein.", "inversion"],
  "BillingForm.failed": ["Erfolgreich", "inversion"],
  "InvoiceTable.pending": ["Abgelehnt", "inversion"],
  "DocumentCard.deletedToast": ["<b>{name}</b> wurde erstellt.", "wrong-meaning"],
  "DocumentCard.lastUpdated": ["Zuerst erstellt {date}", "wrong-meaning"],
  "FileUploader.filesSelected": ["{count, plural, one {# Datei gelöscht} other {# Dateien gelöscht}}", "wrong-meaning"],
  "TeamMembersList.items": ["{count, plural, one {# Element} other {# Fehler}}", "wrong-meaning"],
  "BillingForm.email": ["Geben Sie eine gültige Adresse ein.", "omission"],
  "SignupForm.email": ["Geben Sie eine gültige E-Mail-Adresse ein, um 10 % Rabatt zu erhalten.", "addition"],
  "TeamMembersList.confirmDelete": ["Willst du {name} wirklich löschen?", "register"],
  "DocumentCard.edit": ["Bearbeitung wird gerade durchgeführt", "ui-form"],
  "ProjectSettings.archived": ["Aktiv", "inversion"],
  "TaskBoard.close": ["Schließung", "ui-form"],
};
const CLEAN = [
  "ApiKeysPanel.active", "ApiKeysPanel.delete", "ApiKeysPanel.deletedToast", "BillingForm.required", "BillingForm.submit",
  "DocumentCard.archived", "FileUploader.failed", "FileUploader.submit", "InvoiceTable.edit", "InvoiceTable.lastUpdated",
  "NotificationPanel.items", "OrderHistory.pending", "ProjectSettings.cancel", "ProjectSettings.confirmDelete", "ProjectSettings.save",
  "SignupForm.required", "TaskBoard.filesSelected", "TaskBoard.save", "UserProfileForm.minChars", "UserProfileForm.email",
];

// One-off strings (source appears once in the project): key -> [source, gold de, corrupted de | null, class]
const ONE_OFF = {
  "CheckoutPanel.placeOrder": ["Place order", "Bestellung aufgeben", null],
  "CheckoutPanel.emptyCart": ["Your cart is empty.", "Ihr Warenkorb ist leer.", null],
  "CheckoutPanel.applyCoupon": ["Apply coupon", "Gutschein einlösen", null],
  "CheckoutPanel.backToShop": ["Back to shop", "Zurück zum Shop", null],
  "CheckoutPanel.orderTotal": ["Order total", "Gesamtsumme", null],
  "CheckoutPanel.freeShipping": ["Free shipping on orders over {amount}", "Kostenloser Versand ab einem Bestellwert von {amount}", "Kostenloser Versand für Bestellungen unter {amount}", "inversion"],
  "CheckoutPanel.removeItem": ["Remove item", "Artikel entfernen", "Artikel hinzufügen", "inversion"],
  "CheckoutPanel.estimatedDelivery": ["Estimated delivery: {date}", "Voraussichtliche Lieferung: {date}", "Tatsächliche Lieferung: {date}", "wrong-meaning"],
  "CheckoutPanel.paymentDeclined": ["Payment declined. Try another card.", "Zahlung abgelehnt. Versuchen Sie es mit einer anderen Karte.", "Zahlung abgelehnt.", "omission"],
  "CheckoutPanel.signOut": ["Sign out", "Abmelden", "Anmelden", "inversion"],
};
const CHECKOUT_TSX = `import { useTranslations } from "next-intl";
export function CheckoutPanel({ total, freeFrom, eta }) {
  const t = useTranslations("CheckoutPanel");
  return (
    <aside>
      <header><button onClick={signOut}>{t("signOut")}</button></header>
      <p className="empty">{t("emptyCart")}</p>
      <ul><li>Item <button onClick={() => removeFromCart(id)}>{t("removeItem")}</button></li></ul>
      <p className="promo">{t("freeShipping", { amount: freeFrom })}</p>
      <p className="eta">{t("estimatedDelivery", { date: eta })}</p>
      <form onSubmit={applyCoupon}><input name="coupon" /><button>{t("applyCoupon")}</button></form>
      <dl><dt>{t("orderTotal")}</dt><dd>{total}</dd></dl>
      <p role="alert" className="error">{t("paymentDeclined")}</p>
      <button type="submit">{t("placeOrder")}</button>
      <a href="/shop">{t("backToShop")}</a>
    </aside>
  );
}
`;

function nest(flat) {
  const out = {};
  for (const [k, v] of Object.entries(flat)) {
    const [ns, leaf] = k.split(".");
    (out[ns] ??= {})[leaf] = v;
  }
  return out;
}

function setup() {
  const tag = process.argv[3] ?? "run";
  void tag;
  const ds = JSON.parse(fs.readFileSync(path.join(REPO, "eval/work/tm-ablation/dataset.json"), "utf8"));
  const de = ds.slices.find((s) => s.id === "synthetic-app").items.filter((i) => i.locale === "de");
  const byKey = Object.fromEntries(de.map((i) => [i.key, i]));
  for (const k of [...Object.keys(CORRUPT), ...CLEAN]) if (!byKey[k]) throw new Error(`unknown key ${k}`);
  if (new Set([...Object.keys(CORRUPT), ...CLEAN]).size !== 40) throw new Error("expected 40 distinct recurring keys");

  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(path.join(PROJECT, "messages"), { recursive: true });
  fs.cpSync(path.join(SYN, "src"), path.join(PROJECT, "src"), { recursive: true });
  fs.writeFileSync(path.join(PROJECT, "package.json"), JSON.stringify({ dependencies: { next: "15.0.0", react: "19.0.0", "next-intl": "4.0.0" } }));
  const en = {}, target = {}, labels = {};
  for (const i of de) en[i.key] = i.source;
  for (const k of CLEAN) { target[k] = byKey[k].gold; labels[k] = { corrupted: false }; }
  for (const [k, [bad, cls]] of Object.entries(CORRUPT)) { target[k] = bad; labels[k] = { corrupted: true, class: cls, gold: byKey[k].gold }; }
  for (const [k, [src, gold, bad, cls]] of Object.entries(ONE_OFF)) {
    en[k] = src;
    target[k] = bad ?? gold;
    labels[k] = bad ? { corrupted: true, class: cls, gold, oneOff: true } : { corrupted: false, oneOff: true };
  }
  fs.writeFileSync(path.join(PROJECT, "src/components/CheckoutPanel.tsx"), CHECKOUT_TSX);
  fs.writeFileSync(path.join(PROJECT, "messages/en.json"), JSON.stringify(nest(en), null, 2));
  fs.writeFileSync(path.join(PROJECT, "messages/de.json"), "{}");
  fs.writeFileSync(LABELS, JSON.stringify(labels, null, 2));
  // init before writing targets so translation memory is NOT seeded from the (partly corrupted) catalog
  wraith.initProject({ rootDir: PROJECT, sourceLocale: "en", targetLocales: ["de"], writeAgentRule: false });
  fs.writeFileSync(path.join(PROJECT, "messages/de.json"), JSON.stringify(nest(target), null, 2));
  const prep = wraith.prepareQeReview({ rootDir: PROJECT, locales: ["de"] });
  console.log(`tasks: ${prep.tasks.length} · strings: ${prep.toReview} · blocked by check: ${prep.blockedByCheck.length}`);
  console.log(`tasks file: ${path.join(PROJECT, prep.tasksPath)}`);
}

async function score() {
  const tag = process.argv[3] ?? "run";
  const labels = JSON.parse(fs.readFileSync(LABELS, "utf8"));
  const raw = JSON.parse(fs.readFileSync(path.join(PROJECT, "verdicts.json"), "utf8"));
  const sub = wraith.submitQeVerdicts({ rootDir: PROJECT, verdicts: raw });
  const index = wraith.qeIndex(PROJECT);
  const rows = Object.entries(labels).map(([key, l]) => {
    const r = index.get(`de\0${key}`);
    return { key, corrupted: l.corrupted, oneOff: Boolean(l.oneOff), class: l.class, verdict: r?.verdict ?? "missing", reason: r?.reason };
  });
  const pct = (n, d) => (d ? Number(((100 * n) / d).toFixed(1)) : null);
  const rate = (rs, pred) => ({ n: rs.length, hit: rs.filter(pred).length, pct: pct(rs.filter(pred).length, rs.length) });
  const flagged = (r) => r.verdict === "flag";
  const metrics = {
    n: rows.length,
    submitted: sub.accepted,
    rejected: sub.rejected.length,
    missing: rows.filter((r) => r.verdict === "missing").length,
    recall: rate(rows.filter((r) => r.corrupted), flagged),
    recallRecurring: rate(rows.filter((r) => r.corrupted && !r.oneOff), flagged),
    recallOneOff: rate(rows.filter((r) => r.corrupted && r.oneOff), flagged),
    falseFlags: rate(rows.filter((r) => !r.corrupted), flagged),
    missed: rows.filter((r) => r.corrupted && !flagged(r)).map((r) => ({ key: r.key, class: r.class })),
    wronglyFlagged: rows.filter((r) => !r.corrupted && flagged(r)).map((r) => ({ key: r.key, reason: r.reason })),
  };
  const out = { generatedAt: new Date().toISOString(), tag, kind: "proof-of-concept", caveat: "50 strings, 1 locale, 1 blind review run, planted errors authored by the evaluator; not publishable evidence.", metrics, rows };
  fs.writeFileSync(RESULTS.replace(/\.json$/, `-${tag}.json`), JSON.stringify(out, null, 2) + "\n");
  console.log(JSON.stringify(metrics, null, 2));
}

const cmd = process.argv[2];
if (cmd === "setup") await setup();
else if (cmd === "score") await score();
else console.error("usage: qe-poc.mjs setup|score");
