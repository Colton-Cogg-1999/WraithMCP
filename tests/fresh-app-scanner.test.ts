import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initProject, scanProject } from "../src/index.js";

const tmpDirs: string[] = [];
function mkProject(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "polyglot-fresh-app-"));
  tmpDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
  }
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

/**
 * Independent fresh app (clinical appointment scheduling portal — completely distinct
 * domain and patterns from both the audit fixture and the earlier SaaS held-out app).
 */
const FRESH_APP = {
  "package.json": JSON.stringify({
    name: "clinic-portal",
    dependencies: { next: "15.1.0", react: "19.0.0", "next-intl": "4.0.0" },
  }),
  "messages/en.json": JSON.stringify({ common: { back: "Back" } }, null, 2) + "\n",
  "src/app/appointments/BookingForm.tsx": `
import { useState } from "react";
import { useTranslations } from "next-intl";

const VISIT_TYPES = ["Annual physical", "Follow-up visit", "Lab draw"] as const;
const STATUS_COPY = { confirmed: "Appointment confirmed", rescheduled: "Time slot updated" };

export function BookingForm({ hasInsurance, slotsLeft }: { hasInsurance: boolean; slotsLeft: number }) {
  const t = useTranslations("common");
  const [notice, setNotice] = useState<string | null>(null);
  const [selectedTab, setSelectedTab] = useState("calendar");
  const banner = hasInsurance ? "Covered by your current plan" : "Self-pay rates apply";

  return (
    <section>
      <button onClick={() => setSelectedTab("list")}>{t("back")}</button>
      <h1>Book a clinic visit</h1>
      <p>{banner}</p>
      <ul>{VISIT_TYPES.map((vt) => <li key={vt}>{vt}</li>)}</ul>
      <span>{STATUS_COPY.confirmed}</span>
      <Field label="Member ID" hint="Found on the back of your card" placeholder="e.g. MBR-90210" />
      {notice && <Banner>{notice}</Banner>}
      <button onClick={() => setNotice("Please select an available morning slot")}>
        {\`Reserve (\${slotsLeft} openings)\`}
      </button>
      <img src="/clinic-map.png" alt="Downtown clinic entrance" />
    </section>
  );
}
declare const Field: any, Banner: any;
`,
  "src/lib/ehrClient.ts": `
export async function fetchPatient(mrn: string) {
  const url = "/api/v2/patients/" + mrn;
  const resp = await fetch(url, {
    headers: {
      Authorization: "Bearer " + process.env.EHR_TOKEN,
      "Content-Type": "application/json",
      "X-Clinic-Region": "us-east",
    },
  });
  console.info(\`Loaded patient \${mrn} from EHR\`);
  if (!resp.ok) throw new Error("EHR lookup failed: " + resp.status);
  return resp.json();
}
export const SQL = "SELECT id, mrn FROM patients WHERE active = " + 1;
`,
};

const EXPECTED_UI_STRINGS = [
  "Annual physical",
  "Follow-up visit",
  "Lab draw",
  "Appointment confirmed",
  "Time slot updated",
  "Covered by your current plan",
  "Self-pay rates apply",
  "Book a clinic visit",
  "Member ID",
  "Found on the back of your card",
  "e.g. MBR-90210",
  "Please select an available morning slot",
  "Reserve",
  "Downtown clinic entrance",
];

const MUST_NOT_FLAG = [
  "/api/v2/patients/",
  "Bearer ",
  "application/json",
  "us-east",
  "Loaded patient",
  "EHR lookup failed",
  "SELECT id",
  "calendar",
  "list",
];

describe("Fresh unseen app scanner recall & precision (N7)", () => {
  it("achieves high recall and zero technical false positives on an independent clinic booking app", () => {
    const dir = mkProject(FRESH_APP);
    initProject({ rootDir: dir, sourceLocale: "en", targetLocales: ["es-MX"], writeAgentRule: false });
    const res = scanProject({ rootDir: dir, limit: 100 });

    const allFound = [
      ...res.hardcodedStrings.items.map((h) => h.text),
      ...res.concatenations.items.map((c) => c.expression),
    ];
    const joined = allFound.join("\n");

    const hits = EXPECTED_UI_STRINGS.filter((s) => joined.includes(s));
    const missed = EXPECTED_UI_STRINGS.filter((s) => !joined.includes(s));
    const fps = allFound.filter((text) => MUST_NOT_FLAG.some((bad) => text.includes(bad)));

    console.log(
      `[FRESH-APP] recall=${hits.length}/${EXPECTED_UI_STRINGS.length} (${Math.round((hits.length / EXPECTED_UI_STRINGS.length) * 100)}%) missed=${JSON.stringify(missed)} FPs=${JSON.stringify(fps)}`
    );

    expect(hits.length / EXPECTED_UI_STRINGS.length).toBeGreaterThanOrEqual(0.85);
    expect(fps).toEqual([]);
  });
});
