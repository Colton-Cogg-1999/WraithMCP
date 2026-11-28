#!/usr/bin/env node
/**
 * Frozen Pre-Launch v3 Controlled Linguistic Asset Fixture Generator ("PulseDesk")
 *
 * Generates byte-for-byte identical starting workspaces for both Vanilla Codex (A0)
 * and Codex + Wraith (W) across:
 *   - Condition 1: Equal-Information single-release benchmark
 *   - Condition 2: Persistent-Workflow multi-release benchmark (v1 -> v2 -> v3)
 *   - Controlled 24-string/locale Diagnostic QE ground-truth benchmark (12 defects + 12 clean controls)
 */
import fs from "node:fs";
import path from "node:path";
import * as fflate from "fflate";

export function buildMinimalDocx(paragraphs, { header = "", footer = "", tableRows = [] } = {}) {
  const esc = (s) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  const paraXml = (p) => {
    if (typeof p === "string") {
      return `<w:p><w:r><w:t xml:space="preserve">${esc(p)}</w:t></w:r></w:p>`;
    }
    const runs = p.runs
      .map((r) => {
        const rPr = r.bold ? "<w:rPr><w:b/></w:rPr>" : r.italic ? "<w:rPr><w:i/></w:rPr>" : "";
        return `<w:r>${rPr}<w:t xml:space="preserve">${esc(r.text)}</w:t></w:r>`;
      })
      .join("");
    return `<w:p>${runs}</w:p>`;
  };

  const tblXml =
    tableRows.length > 0
      ? `<w:tbl>${tableRows
          .map(
            (row) =>
              `<w:tr>${row
                .map((cell) => `<w:tc><w:p><w:r><w:t xml:space="preserve">${esc(cell)}</w:t></w:r></w:p></w:tc>`)
                .join("")}</w:tr>`
          )
          .join("")}</w:tbl>`
      : "";

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>
    ${paragraphs.map(paraXml).join("\n    ")}
    ${tblXml}
    <w:sectPr>
      ${header ? '<w:headerReference w:type="default" r:id="rId1"/>' : ""}
      ${footer ? '<w:footerReference w:type="default" r:id="rId2"/>' : ""}
    </w:sectPr>
  </w:body>
</w:document>`;

  const files = {
    "[Content_Types].xml": fflate.strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  ${header ? '<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>' : ""}
  ${footer ? '<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>' : ""}
</Types>`),
    "_rels/.rels": fflate.strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`),
    "word/_rels/document.xml.rels": fflate.strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${header ? '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>' : ""}
  ${footer ? '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>' : ""}
</Relationships>`),
    "word/document.xml": fflate.strToU8(documentXml),
  };

  if (header) {
    files["word/header1.xml"] = fflate.strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t xml:space="preserve">${esc(header)}</w:t></w:r></w:p></w:hdr>`);
  }
  if (footer) {
    files["word/footer1.xml"] = fflate.strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t xml:space="preserve">${esc(footer)}</w:t></w:r></w:p></w:ftr>`);
  }
  return Buffer.from(fflate.zipSync(files));
}

export const STYLE_GUIDE_V1 = `# PulseDesk Project Style Guide (v1)

## Voice, Tone & Reading Level
- Write direct, active, plain-language product UI copy (8th-grade reading level; avoid legalese outside legal notices).
- Use sentence case for headings, navigation items, and buttons in target languages (do not copy English Title Case into Spanish).
- Accessibility: \`aria-label\` strings must state an explicit action and target (e.g., "Search Workspace", "Close dialog").

## Register & Precedence
- Project default for Spanish UI: informal \`tú\` ("tu cuenta", "guarda tus cambios").
- **Locale-specific rules take precedence over project defaults** where they define section overrides (for example, formal \`usted\` in \`legal.*\` notices).
- **Active Termbase/Glossary rules take precedence over Translation Memory** when an older TM segment uses a deprecated or prohibited term.
- Always verify TM matches (even 100% lexical matches) against UI component context before reusing. Never reuse a TM match with opposite polarity or wrong part of speech.
`;

export const TRANSLATION_PROMPT_V1 = `PulseDesk Custom Translation Instructions (v1):
1. Prohibited wording:
   - es-MX: NEVER use anglicisms "checar", "cliquear", "clickear", "link", "links", or Spain-regional "ordenador", "fichero". Use "revisar", "hacer clic", "enlace", "computadora", "archivo".
   - ar: NEVER use English transliterations "أكاونت", "لينك", "داشبورد", "فولدر". Use standard MSA equivalents ("حساب", "رابط", "لوحة التحكم", "مجلد").
2. Preferred constructions:
   - es-MX action buttons (Save, Export, Delete, Archive, Open, Post) MUST use infinitive verbs ("Guardar", "Exportar", "Eliminar", "Archivar", "Abrir", "Publicar"), not conjugated imperatives.
3. Preservation:
   - Keep all placeholders ({{count}}, {{workspace}}, {{user}}), ICU plural syntax, inline tags (<code>...</code>), keyboard shortcuts (Ctrl+K), and DNT brand/standard tokens (WraithCloud, PulseKey, OAuth 2.0, ISO-27001) verbatim.
4. Methodology:
   - Do NOT append parenthetical English glosses such as "(Workspace)" or "(Audit log)" after translated terms.
   - When a source string is genuinely ambiguous even after reading source code (e.g., missing unit or unclear billing vs. quota meaning), record a concise open question or assumption rather than inventing facts absent from the source.`;

export const LOCALE_RULES_V1 = {
  "es-MX":
    "Mexican Spanish (es-MX): use informal 'tú' in general UI (nav, settings, forms, notifications, help), Mexican vocabulary ('computadora', 'archivo', 'correo electrónico'), sentence-case headings, and Spanish inverted punctuation ('¿...?', '¡...!'). OVERRIDE: in legal.* keys (legal.json), ALWAYS use formal 'usted' ('su información', 'puede solicitar') overriding the project-wide 'tú' default.",
  ar: "Modern Standard Arabic (ar): clear formal MSA, Arabic comma ('،') and Arabic question mark ('؟') instead of Latin ',' or '?' in Arabic prose, full 6-form CLDR ICU pluralization (zero, one, two, few, many, other) for pluralized counts, and clean RTL directionality while keeping DNT brand/standard tokens (WraithCloud, PulseKey, OAuth 2.0, ISO-27001) and shortcuts (Ctrl+K) intact.",
};

export const GLOSSARY_CSV_V1 = `term,doNotTranslate,es-MX,ar,notes
WraithCloud,true,,,DNT cloud platform brand name. Keep verbatim.
PulseKey,true,,,DNT security token product name. Keep verbatim.
OAuth 2.0,true,,,DNT protocol standard. Keep verbatim.
ISO-27001,true,,,DNT compliance certification code. Keep verbatim.
Workspace,false,Espacio de trabajo,مساحة العمل,"Approved v1 term across all surfaces. PROHIBITED in es-MX: 'Área de trabajo', 'Workspace'. PROHIBITED in ar: 'بيئة العمل', 'منطقة العمل'."
Snapshot,false,Instantánea,لقطة النظام,"System state snapshot. PROHIBITED in es-MX: 'captura de respaldo'; ar: 'صورة احتياطية'."
`;

export const TERMBASE_TBX_V1 = `<?xml version="1.0" encoding="UTF-8"?>
<martif type="TBX-Basic" xml:lang="en">
  <text>
    <body>
      <termEntry id="te-billing-cycle">
        <descrip type="context">Multiword billing period term. Prohibited es-MX: Periodo de cobro, Ciclo de cobro. Prohibited ar: فترة الدفع, مدة السداد.</descrip>
        <langSet xml:lang="en"><tig><term>Billing cycle</term></tig></langSet>
        <langSet xml:lang="es-MX"><tig><term>Ciclo de facturación</term></tig></langSet>
        <langSet xml:lang="ar"><tig><term>دورة الفوترة</term></tig></langSet>
      </termEntry>
      <termEntry id="te-audit-log">
        <descrip type="context">Multiword compliance activity trail. Prohibited es-MX: Bitácora de cambios, Historial de auditoría. Prohibited ar: سجل التغييرات, دفتر المراجعة.</descrip>
        <langSet xml:lang="en"><tig><term>Audit log</term></tig></langSet>
        <langSet xml:lang="es-MX"><tig><term>Registro de auditoría</term></tig></langSet>
        <langSet xml:lang="ar"><tig><term>سجل التدقيق</term></tig></langSet>
      </termEntry>
    </body>
  </text>
</martif>
`;

export const MEMORY_TMX_V1 = `<?xml version="1.0" encoding="UTF-8"?>
<tmx version="1.4">
  <header creationtool="PulseDeskTMS" srclang="en" datatype="plaintext"/>
  <body>
    <!-- 4 Appropriate Exact Matches (human-approved phrasing) -->
    <tu tuid="tm-exact-1">
      <prop type="x-context">notifications.session_expired (human-reviewed)</prop>
      <tuv xml:lang="en"><seg>Your session timed out for security reasons.</seg></tuv>
      <tuv xml:lang="es-MX"><seg>Tu sesión venció por motivos de seguridad.</seg></tuv>
      <tuv xml:lang="ar"><seg>انتهت صلاحية جلستك لأسباب أمنية.</seg></tuv>
    </tu>
    <tu tuid="tm-exact-2">
      <prop type="x-context">settings.two_factor_active (human-reviewed)</prop>
      <tuv xml:lang="en"><seg>Two-factor protection is active on this account.</seg></tuv>
      <tuv xml:lang="es-MX"><seg>La protección en dos pasos está activa en esta cuenta.</seg></tuv>
      <tuv xml:lang="ar"><seg>الحماية الثنائية مفعّلة على هذا الحساب.</seg></tuv>
    </tu>
    <tu tuid="tm-exact-3">
      <prop type="x-context">notifications.export_queued (human-reviewed)</prop>
      <tuv xml:lang="en"><seg>Your compliance bundle is queued for generation.</seg></tuv>
      <tuv xml:lang="es-MX"><seg>Tu paquete de cumplimiento está en fila para generarse.</seg></tuv>
      <tuv xml:lang="ar"><seg>حزمة الامتثال الخاصة بك في قائمة الانتظار للإنشاء.</seg></tuv>
    </tu>
    <tu tuid="tm-exact-4">
      <prop type="x-context">help.contact_admin (human-reviewed)</prop>
      <tuv xml:lang="en"><seg>Reach out to your organization administrator for access.</seg></tuv>
      <tuv xml:lang="es-MX"><seg>Comunícate con el administrador de tu organización para solicitar acceso.</seg></tuv>
      <tuv xml:lang="ar"><seg>تواصل مع مسؤول مؤسستك لطلب صلاحية الوصول.</seg></tuv>
    </tu>

    <!-- 4 Useful Fuzzy Matches (adapt number/protocol/cadence) -->
    <tu tuid="tm-fuzzy-1">
      <prop type="x-context">notifications.export_ready</prop>
      <tuv xml:lang="en"><seg>Your Audit log export for {{workspace}} is ready, and will expire in 48 hours.</seg></tuv>
      <tuv xml:lang="es-MX"><seg>Tu exportación del Registro de auditoría para {{workspace}} está lista y vencerá en 48 horas.</seg></tuv>
      <tuv xml:lang="ar"><seg>تصدير سجل التدقيق الخاص بـ {{workspace}} جاهز، وستنتهي صلاحيته خلال 48 ساعة.</seg></tuv>
    </tu>
    <tu tuid="tm-fuzzy-2">
      <prop type="x-context">settings.sso_connected</prop>
      <tuv xml:lang="en"><seg>Connected to WraithCloud using SAML credentials.</seg></tuv>
      <tuv xml:lang="es-MX"><seg>Conectado a WraithCloud con credenciales SAML.</seg></tuv>
      <tuv xml:lang="ar"><seg>متصل بـ WraithCloud باستخدام بيانات اعتماد SAML.</seg></tuv>
    </tu>
    <tu tuid="tm-fuzzy-3">
      <prop type="x-context">forms.invite_limit_notice</prop>
      <tuv xml:lang="en"><seg>You can invite up to 10 teammates per Billing cycle.</seg></tuv>
      <tuv xml:lang="es-MX"><seg>Puedes invitar hasta 10 compañeros por Ciclo de facturación.</seg></tuv>
      <tuv xml:lang="ar"><seg>يمكنك دعوة ما يصل إلى 10 زملاء في كل دورة الفوترة.</seg></tuv>
    </tu>
    <tu tuid="tm-fuzzy-4">
      <prop type="x-context">sync.snapshot_scheduled</prop>
      <tuv xml:lang="en"><seg>Weekly Snapshot replication is scheduled for 03:00 UTC.</seg></tuv>
      <tuv xml:lang="es-MX"><seg>La replicación semanal de Instantánea está programada para las 03:00 UTC.</seg></tuv>
      <tuv xml:lang="ar"><seg>تمت جدولة النسخ المتماثل الأسبوعي لـ لقطة النظام عند الساعة 03:00 UTC.</seg></tuv>
    </tu>

    <!-- 3 Misleading Fuzzy Match TRAPS (opposite polarity / different noun) -->
    <tu tuid="tm-trap-fuzzy-1">
      <prop type="x-context">settings.backup_enabled_legacy</prop>
      <tuv xml:lang="en"><seg>Enable automatic backups for your Workspace.</seg></tuv>
      <tuv xml:lang="es-MX"><seg>Activa las copias de seguridad automáticas para tu Espacio de trabajo.</seg></tuv>
      <tuv xml:lang="ar"><seg>تفعيل النسخ الاحتياطي التلقائي لـ مساحة العمل الخاصة بك.</seg></tuv>
    </tu>
    <tu tuid="tm-trap-fuzzy-2">
      <prop type="x-context">settings.delete_temp_cache</prop>
      <tuv xml:lang="en"><seg>Delete temporary cache files from this Workspace.</seg></tuv>
      <tuv xml:lang="es-MX"><seg>Elimina los archivos temporales de caché de este Espacio de trabajo.</seg></tuv>
      <tuv xml:lang="ar"><seg>احذف ملفات التخزين المؤقت المؤقتة من مساحة العمل هذه.</seg></tuv>
    </tu>
    <tu tuid="tm-trap-fuzzy-3">
      <prop type="x-context">settings.rotate_key_info</prop>
      <tuv xml:lang="en"><seg>Rotating PulseKey will seamlessly preserve API traffic.</seg></tuv>
      <tuv xml:lang="es-MX"><seg>Rotar PulseKey mantendrá sin interrupciones el tráfico de API.</seg></tuv>
      <tuv xml:lang="ar"><seg>سيؤدي تدوير PulseKey إلى الحفاظ على حركة API بسلاسة.</seg></tuv>
    </tu>

    <!-- 3 Contextually Inappropriate Exact Match TRAPS (wrong UI sense) -->
    <tu tuid="tm-trap-exact-1">
      <prop type="x-context">marketing.promo_banner (Save 20% discount)</prop>
      <tuv xml:lang="en"><seg>Save</seg></tuv>
      <tuv xml:lang="es-MX"><seg>Ahorra</seg></tuv>
      <tuv xml:lang="ar"><seg>وفّر</seg></tuv>
    </tu>
    <tu tuid="tm-trap-exact-2">
      <prop type="x-context">checkout.shipping_address_type (Home vs Office)</prop>
      <tuv xml:lang="en"><seg>Home</seg></tuv>
      <tuv xml:lang="es-MX"><seg>Domicilio</seg></tuv>
      <tuv xml:lang="ar"><seg>المنزل</seg></tuv>
    </tu>
    <tu tuid="tm-trap-exact-3">
      <prop type="x-context">sidebar.archive_folder_noun</prop>
      <tuv xml:lang="en"><seg>Archive</seg></tuv>
      <tuv xml:lang="es-MX"><seg>Archivo</seg></tuv>
      <tuv xml:lang="ar"><seg>الأرشيف</seg></tuv>
    </tu>

    <!-- 1 Stale TM vs Active Glossary CONFLICT (deprecated term in TM; active termbase MUST win) -->
    <tu tuid="tm-conflict-glossary">
      <prop type="x-context">legacy_v0.workspace_banner (OUTDATED TERM)</prop>
      <tuv xml:lang="en"><seg>Manage members and security policies for your Workspace.</seg></tuv>
      <tuv xml:lang="es-MX"><seg>Administra los miembros y políticas de seguridad de tu Área de trabajo.</seg></tuv>
      <tuv xml:lang="ar"><seg>أدر الأعضاء وسياسات الأمان لبيئة العمل الخاصة بك.</seg></tuv>
    </tu>
  </body>
</tmx>
`;

export const CATALOGS_V1 = {
  "nav.json": {
    home_link: "Home",
    workspace_title: "Workspace Overview",
    audit_log: "Audit Log",
    export_report: "Export",
    search_aria: "Search Workspace and Audit log",
  },
  "settings.json": {
    account_intro: "Check your computer and email preferences before updating your Workspace.",
    billing_cycle_heading: "Billing Cycle Settings",
    security_heading: "Security & Authentication",
    workspace_banner: "Manage members and security policies for your Workspace.",
    two_factor_active: "Two-factor protection is active on this account.",
    sso_connected: "Connected to WraithCloud using OAuth 2.0 credentials.",
    monthly_charge: "Monthly charge",
    battery_charge: "Battery charge",
    api_key_label: "API key",
    delete_token: "Delete",
    delete_permanent_archive: "Delete permanent archive files from this Workspace.",
    revoke_access_warning: "Revoking PulseKey will immediately block API traffic.",
    reset_credits_ambiguous: "Reset credits",
  },
  "forms.json": {
    save_button: "Save",
    archive_button: "Archive",
    post_button: "Post",
    open_document: "Open",
    post_count: "{count, plural, one {# saved post} other {# saved posts}}",
    create_workspace_title: "Create Workspace",
    invite_limit_notice: "You can invite up to 25 teammates per Billing cycle.",
    confirm_delete_prompt: "Are you sure you want to delete this file from your computer?",
    close_dialog_aria: "Close dialog",
    set_limit_ambiguous: "Set limit",
  },
  "notifications.json": {
    session_expired: "Your session timed out for security reasons.",
    export_queued: "Your compliance bundle is queued for generation.",
    export_ready: "Your Audit log export for {{workspace}} is ready, and will expire in 24 hours.",
    backup_disabled: "Disable automatic backups for your Workspace.",
    ticket_status_open: "Open",
    pending_invites: "{count, plural, one {You have # pending invite in {{workspace}}} other {You have # pending invites in {{workspace}}}}",
  },
  "legal.json": {
    privacy_notice: "Under ISO-27001 controls, your medical and billing records are protected, and you may request deletion at any time.",
    data_request: "You may export your Audit log and account data by contacting our privacy officer.",
    audit_retention: "Your organization's Billing cycle invoices and Audit log records are retained for seven years.",
  },
  "sync.json": {
    snapshot_scheduled: "Nightly Snapshot replication is scheduled for 02:00 UTC.",
    fetch_snapshot: "Download the latest Snapshot for {{workspace}} to your computer.",
    cli_command_hint: "Run <code>pulsekey sync --iso ISO-27001</code> to verify local files.",
  },
  "help.json": {
    contact_admin: "Reach out to your organization administrator for access.",
    shortcut_tip: "Press Ctrl+K anywhere to search your Workspace or click a link to inspect an Audit log entry.",
    press_any_key: "Press any key to continue",
    need_more_help: "Need more help configuring WraithCloud or PulseKey?",
  },
};

export const DOC_GUIDE_MD_V1 = `# PulseDesk Administrator Guide

Welcome to **WraithCloud** administration. Use this guide to configure your **Workspace**, review your **Billing cycle**, and inspect the **Audit log** under **ISO-27001** compliance.

## Security with PulseKey
Every administrator must authenticate via **OAuth 2.0** before generating a **PulseKey** token or exporting a **Snapshot** file to their computer.
`;

export function createControlledWorkspace(destDir, { initWraith = false, wraithApi = null } = {}) {
  fs.rmSync(destDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(destDir, "src", "locales", "en"), { recursive: true });
  fs.mkdirSync(path.join(destDir, "src", "components"), { recursive: true });
  fs.mkdirSync(path.join(destDir, "docs"), { recursive: true });
  fs.mkdirSync(path.join(destDir, "localization"), { recursive: true });

  // Package.json so React + i18next adapter detects cleanly
  fs.writeFileSync(
    path.join(destDir, "package.json"),
    JSON.stringify(
      {
        name: "pulsedesk-l10n-eval",
        version: "1.0.0",
        private: true,
        dependencies: { react: "^19.0.0", "react-i18next": "^15.0.0", i18next: "^24.0.0" },
      },
      null,
      2
    ) + "\n"
  );

  // Source English catalogs
  for (const [file, content] of Object.entries(CATALOGS_V1)) {
    fs.writeFileSync(
      path.join(destDir, "src", "locales", "en", file),
      JSON.stringify(content, null, 2) + "\n"
    );
  }

  // Realistic TSX components providing clear usage-site context for polysemy & TM traps
  fs.writeFileSync(
    path.join(destDir, "src", "components", "NavBar.tsx"),
    `import { useTranslation } from "react-i18next";
export function NavBar() {
  const { t } = useTranslation("nav");
  return (
    <nav aria-label="Main navigation">
      <a href="/">{t("home_link")}</a>
      <h1>{t("workspace_title")}</h1>
      <a href="/audit">{t("audit_log")}</a>
      <button type="button">{t("export_report")}</button>
      <input type="search" aria-label={t("search_aria")} />
    </nav>
  );
}
`
  );

  fs.writeFileSync(
    path.join(destDir, "src", "components", "SettingsPanel.tsx"),
    `import { useTranslation } from "react-i18next";
export function SettingsPanel() {
  const { t } = useTranslation("settings");
  return (
    <section>
      <p>{t("account_intro")}</p>
      <h2>{t("billing_cycle_heading")}</h2>
      <div className="billing-row"><span>{t("monthly_charge")}</span></div>
      <div className="device-hardware-panel"><span>{t("battery_charge")}</span></div>
      <h2>{t("security_heading")}</h2>
      <p>{t("workspace_banner")}</p>
      <p>{t("two_factor_active")}</p>
      <p>{t("sso_connected")}</p>
      <label htmlFor="api-key">{t("api_key_label")}</label>
      <button type="button" className="danger">{t("delete_token")}</button>
      <p>{t("delete_permanent_archive")}</p>
      <p className="warning">{t("revoke_access_warning")}</p>
      {/* Generic button with no clarifying props/comments */}
      <button type="button">{t("reset_credits_ambiguous")}</button>
    </section>
  );
}
`
  );

  fs.writeFileSync(
    path.join(destDir, "src", "components", "ProfileForm.tsx"),
    `import { useTranslation } from "react-i18next";
export function ProfileForm({ count }: { count: number }) {
  const { t } = useTranslation("forms");
  return (
    <form>
      <h2>{t("create_workspace_title")}</h2>
      <p>{t("invite_limit_notice")}</p>
      <p>{t("confirm_delete_prompt")}</p>
      <div className="composer-actions">
        <button type="submit">{t("save_button")}</button>
        <button type="button">{t("archive_button")}</button>
        <button type="submit">{t("post_button")}</button>
        <button type="button">{t("open_document")}</button>
      </div>
      <span className="feed-counter">{t("post_count", { count })}</span>
      <button type="button" aria-label={t("close_dialog_aria")}>×</button>
      {/* Ambiguous widget: no unit or resource specified */}
      <button type="button">{t("set_limit_ambiguous")}</button>
    </form>
  );
}
`
  );

  fs.writeFileSync(
    path.join(destDir, "src", "components", "NotificationsCenter.tsx"),
    `import { useTranslation } from "react-i18next";
export function NotificationsCenter({ workspace, count }: { workspace: string; count: number }) {
  const { t } = useTranslation("notifications");
  return (
    <aside>
      <p>{t("session_expired")}</p>
      <p>{t("export_queued")}</p>
      <p>{t("export_ready", { workspace })}</p>
      <p>{t("backup_disabled")}</p>
      <span className="ticket-status-badge">{t("ticket_status_open")}</span>
      <p>{t("pending_invites", { count, workspace })}</p>
    </aside>
  );
}
`
  );

  fs.writeFileSync(
    path.join(destDir, "src", "components", "LegalAndHelp.tsx"),
    `import { useTranslation } from "react-i18next";
export function LegalAndHelp({ workspace }: { workspace: string }) {
  const { t: tl } = useTranslation("legal");
  const { t: ts } = useTranslation("sync");
  const { t: th } = useTranslation("help");
  return (
    <div>
      <section className="legal-compliance">
        <p>{tl("privacy_notice")}</p>
        <p>{tl("data_request")}</p>
        <p>{tl("audit_retention")}</p>
      </section>
      <section className="sync-panel">
        <p>{ts("snapshot_scheduled")}</p>
        <p>{ts("fetch_snapshot", { workspace })}</p>
        <p>{ts("cli_command_hint")}</p>
      </section>
      <section className="help-modal">
        <p>{th("contact_admin")}</p>
        <p>{th("shortcut_tip")}</p>
        <p>{th("press_any_key")}</p>
        <p>{th("need_more_help")}</p>
      </section>
    </div>
  );
}
`
  );

  // Markdown doc & companion DOCX manual sharing exact terminology
  fs.writeFileSync(path.join(destDir, "docs", "guide.md"), DOC_GUIDE_MD_V1);
  const docxBuf = buildMinimalDocx(
    [
      { runs: [{ text: "PulseDesk ", bold: true }, { text: "Workspace Administration Manual" }] },
      {
        runs: [
          { text: "This manual explains how to manage your " },
          { text: "Workspace", bold: true },
          { text: ", review each " },
          { text: "Billing cycle", italic: true },
          { text: ", and export the " },
          { text: "Audit log", bold: true },
          { text: " on WraithCloud using OAuth 2.0 and PulseKey." },
        ],
      },
      "Check your computer before downloading a Snapshot file for ISO-27001 review.",
    ],
    {
      header: "WraithCloud — Workspace Operations Manual",
      footer: "ISO-27001 Controlled Document — PulseKey Security",
      tableRows: [
        ["Feature", "Requirement"],
        ["Workspace", "Requires active OAuth 2.0 session"],
        ["Audit log", "Exportable once per Billing cycle"],
      ],
    }
  );
  fs.writeFileSync(path.join(destDir, "docs", "workspace-admin-manual.docx"), docxBuf);

  // Equal-information linguistic assets in localization/
  fs.writeFileSync(path.join(destDir, "localization", "STYLE_GUIDE.md"), STYLE_GUIDE_V1);
  fs.writeFileSync(path.join(destDir, "localization", "TRANSLATION_PROMPT.md"), TRANSLATION_PROMPT_V1);
  fs.writeFileSync(
    path.join(destDir, "localization", "LOCALE_RULES.json"),
    JSON.stringify(LOCALE_RULES_V1, null, 2) + "\n"
  );
  fs.writeFileSync(path.join(destDir, "localization", "glossary.csv"), GLOSSARY_CSV_V1);
  fs.writeFileSync(path.join(destDir, "localization", "termbase.tbx"), TERMBASE_TBX_V1);
  fs.writeFileSync(path.join(destDir, "localization", "memory.tmx"), MEMORY_TMX_V1);

  if (initWraith && wraithApi) {
    wraithApi.initProject({
      rootDir: destDir,
      sourceLocale: "en",
      targetLocales: ["es-MX", "ar"],
      framework: "react",
      localesPath: "src/locales",
    });
    const store = new wraithApi.WraithStore(destDir);
    const cfg = store.readConfig();
    cfg.paths.documents = ["docs/workspace-admin-manual.docx", "docs/guide.md"];
    cfg.styleGuide = {
      file: "localization/STYLE_GUIDE.md",
      translationPrompt: TRANSLATION_PROMPT_V1,
      byLocale: LOCALE_RULES_V1,
    };
    store.writeConfig(cfg);
    wraithApi.importGlossaryCsv(destDir, "localization/glossary.csv");
    wraithApi.importGlossaryTbx(destDir, "localization/termbase.tbx");
    wraithApi.importMemoryTmx(destDir, "localization/memory.tmx");
    wraithApi.scanProject({ rootDir: destDir });
  }
}

export function applyV2ReleaseChanges(destDir, { expectedOutcomes, isWraith = false, wraithApi = null } = {}) {
  // 1. Add 15 new keys across namespaces + edit 3 existing source keys
  const readCat = (f) => JSON.parse(fs.readFileSync(path.join(destDir, "src", "locales", "en", f), "utf8"));
  const writeCat = (f, obj) =>
    fs.writeFileSync(path.join(destDir, "src", "locales", "en", f), JSON.stringify(obj, null, 2) + "\n");

  const nav = readCat("nav.json");
  nav.billing_nav_v2 = "Billing cycle";
  nav.snapshots_nav_v2 = "Snapshots";
  writeCat("nav.json", nav);

  const settings = readCat("settings.json");
  settings.two_factor_active = "Two-factor protection is required and active on this account."; // edited
  settings.oauth_rotation_v2 = "Rotate your OAuth 2.0 credentials for WraithCloud every 90 days.";
  settings.audit_export_v2 = "Export the Audit log file to your computer.";
  settings.pulsekey_status_v2 = "PulseKey hardware enforcement is enabled.";
  writeCat("settings.json", settings);

  const forms = readCat("forms.json");
  forms.post_reply_v2 = "Post"; // verb again
  forms.charge_fee_v2 = "One-time charge";
  forms.open_file_v2 = "Open"; // verb again
  forms.workspace_name_label_v2 = "Workspace name";
  writeCat("forms.json", forms);

  const notifications = readCat("notifications.json");
  notifications.session_expired = "Your session timed out after 30 minutes for security reasons."; // edited
  notifications.workspace_created_v2 = "Your new Workspace {{workspace}} is ready.";
  notifications.billing_renewed_v2 = "Your Billing cycle renewed with zero extra charges.";
  notifications.issue_open_v2 = "Open"; // status badge again
  writeCat("notifications.json", notifications);

  const legal = readCat("legal.json");
  legal.iso_compliance_v2 = "You may download our ISO-27001 certificate and verify Audit log integrity.";
  writeCat("legal.json", legal);

  const sync = readCat("sync.json");
  sync.snapshot_pull_v2 = "Download a Snapshot archive for {{workspace}} from WraithCloud.";
  writeCat("sync.json", sync);

  const help = readCat("help.json");
  help.shortcut_tip = "Press Ctrl+K anytime to search your Workspace or click a link to open an Audit log entry."; // edited
  help.workspace_guide_v2 = "Check your Workspace settings and press any key to view shortcuts.";
  help.help_question_v2 = "Do you want to inspect the Audit log for this Billing cycle?";
  writeCat("help.json", help);

  // Update TSX components with the new v2 usage sites
  fs.appendFileSync(
    path.join(destDir, "src", "components", "ProfileForm.tsx"),
    `\nexport function V2FormExtras() {
  const { t } = useTranslation("forms");
  return (
    <div>
      <button type="submit">{t("post_reply_v2")}</button>
      <span>{t("charge_fee_v2")}</span>
      <button type="button">{t("open_file_v2")}</button>
      <label>{t("workspace_name_label_v2")}</label>
    </div>
  );
}\n`
  );
  fs.appendFileSync(
    path.join(destDir, "src", "components", "NotificationsCenter.tsx"),
    `\nexport function V2NotifBadge() {
  const { t } = useTranslation("notifications");
  return <span className="status-badge">{t("issue_open_v2")}</span>;
}\n`
  );

  // 2. Inject 3 human edits per target locale into the existing v1 target files
  const humanEdits = expectedOutcomes.v2Maintenance.humanEditedKeysToPreserve;
  for (const loc of ["es-MX", "ar"]) {
    for (const [fullKey, editedVal] of Object.entries(humanEdits[loc])) {
      const [ns, key] = fullKey.split(".");
      const targetPath = path.join(destDir, "src", "locales", loc, `${ns}.json`);
      if (fs.existsSync(targetPath)) {
        const obj = JSON.parse(fs.readFileSync(targetPath, "utf8"));
        obj[key] = editedVal;
        fs.writeFileSync(targetPath, JSON.stringify(obj, null, 2) + "\n");
      }
    }
  }
  // Give A0 explicit equal notice in localization/HUMAN_EDITS_V2.json (while W detects manual edits via Wraith records/check!)
  fs.writeFileSync(
    path.join(destDir, "localization", "HUMAN_EDITS_V2.json"),
    JSON.stringify(
      {
        note: "Human linguists manually edited these keys after v1; do NOT overwrite them during v2 maintenance.",
        edits: humanEdits,
      },
      null,
      2
    ) + "\n"
  );

  if (isWraith && wraithApi) {
    wraithApi.scanProject({ rootDir: destDir });
  }
}

export function applyV3AssetUpdates(destDir, { expectedOutcomes, isWraith = false, wraithApi = null } = {}) {
  // 1. Update Glossary ("Workspace" -> es-MX "Entorno de trabajo", ar "بيئة العمل")
  const updatedCsv = GLOSSARY_CSV_V1.replace(
    `Workspace,false,Espacio de trabajo,مساحة العمل,"Approved v1 term across all surfaces. PROHIBITED in es-MX: 'Área de trabajo', 'Workspace'. PROHIBITED in ar: 'بيئة العمل', 'منطقة العمل'."`,
    `Workspace,false,Entorno de trabajo,بيئة العمل,"UPDATED in v3! Approved v3 term across all surfaces. PROHIBITED in es-MX: 'Espacio de trabajo', 'Área de trabajo', 'Workspace'. PROHIBITED in ar: 'مساحة العمل', 'منطقة العمل'."`
  );
  fs.writeFileSync(path.join(destDir, "localization", "glossary.csv"), updatedCsv);

  // 2. Update Locale rules (help.* in es-MX switches to formal usted)
  const updatedLocaleRules = {
    ...LOCALE_RULES_V1,
    "es-MX":
      LOCALE_RULES_V1["es-MX"] +
      " V3 OVERRIDE: in help.* keys (help.json), switch from informal 'tú' to formal 'usted' ('su entorno', 'puede consultar'), while keeping nav, settings, forms, and notifications on informal 'tú'.",
  };
  fs.writeFileSync(
    path.join(destDir, "localization", "LOCALE_RULES.json"),
    JSON.stringify(updatedLocaleRules, null, 2) + "\n"
  );

  // 3. Update Translation Prompt (sync.* must use 'obtener' instead of 'descargar')
  const updatedPrompt =
    TRANSLATION_PROMPT_V1 +
    `\n5. V3 Sync Rule (es-MX): In sync.* keys (sync.json), NEVER use "descargar" for cloud Snapshots; use "obtener" instead.`;
  fs.writeFileSync(path.join(destDir, "localization", "TRANSLATION_PROMPT.md"), updatedPrompt);

  // 4. Mark the 2 human-approved Workspace keys as locked / human-verified (EQUAL info for A0 & W)
  const locked = expectedOutcomes.v3AssetPropagation.humanLockedWorkspaceKeys;
  fs.writeFileSync(
    path.join(destDir, "localization", "HUMAN_APPROVED_LOCKED.json"),
    JSON.stringify(
      {
        note: "These keys were formally signed off by legal/human linguists and MUST NOT be overwritten automatically during v3 asset propagation.",
        lockedKeys: [...locked, ...Object.keys(expectedOutcomes.v2Maintenance.humanEditedKeysToPreserve["es-MX"])],
      },
      null,
      2
    ) + "\n"
  );

  if (isWraith && wraithApi) {
    // Mark human-verified in Wraith QE verdicts & records BEFORE running glossary update
    const store = new wraithApi.WraithStore(destDir);
    const records = store.readRecords();
    const qePath = store.filePath("qe-verdicts.json");
    const qeFile = fs.existsSync(qePath)
      ? JSON.parse(fs.readFileSync(qePath, "utf8"))
      : { version: 2, records: [] };

    for (const loc of ["es-MX", "ar"]) {
      for (const fullKey of [...locked, ...Object.keys(expectedOutcomes.v2Maintenance.humanEditedKeysToPreserve[loc])]) {
        const [ns, key] = fullKey.split(".");
        const srcPath = path.join(destDir, "src", "locales", "en", `${ns}.json`);
        const tgtPath = path.join(destDir, "src", "locales", loc, `${ns}.json`);
        if (fs.existsSync(srcPath) && fs.existsSync(tgtPath)) {
          const srcVal = JSON.parse(fs.readFileSync(srcPath, "utf8"))[key];
          const tgtVal = JSON.parse(fs.readFileSync(tgtPath, "utf8"))[key];
          if (srcVal && tgtVal) {
            // Namespaced key format in Wraith react/i18next adapter
            const wraithKey = `${ns}:${key}`;
            for (const candidateKey of [wraithKey, fullKey, `${ns}.${key}`]) {
              if (records.records[candidateKey]?.[loc]) {
                records.records[candidateKey][loc].origin = "human";
                records.records[candidateKey][loc].reviewStatus = "approved";
              }
            }
            qeFile.records.push({
              locale: loc,
              key: wraithKey,
              source: srcVal,
              target: tgtVal,
              verdict: "human-verified",
              reviewer: "human-lead-linguist",
              reviewedAt: new Date().toISOString(),
            });
          }
        }
      }
    }
    store.writeRecords(records);
    fs.writeFileSync(qePath, JSON.stringify(qeFile, null, 2) + "\n");

    const cfg = store.readConfig();
    cfg.styleGuide = {
      file: "localization/STYLE_GUIDE.md",
      translationPrompt: updatedPrompt,
      byLocale: updatedLocaleRules,
    };
    store.writeConfig(cfg);

    // Propagate glossary change via Wraith's real API
    wraithApi.recordGlossaryTerm(destDir, {
      term: "Workspace",
      doNotTranslate: false,
      translations: { "es-MX": "Entorno de trabajo", ar: "بيئة العمل" },
      notes: "UPDATED in v3! Approved v3 term across all surfaces.",
      origin: "user",
    });
  }
}

/**
 * Generates the Controlled 24-String/Locale Diagnostic QE Ground-Truth Workspace
 * (12 planted true defects + 12 clean / intentional-style controls, plus visual-qa manifest).
 */
export function createControlledQeWorkspace(destDir, { initWraith = false, wraithApi = null } = {}) {
  fs.rmSync(destDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(destDir, "src", "locales", "en"), { recursive: true });
  fs.mkdirSync(path.join(destDir, "src", "locales", "es-MX"), { recursive: true });
  fs.mkdirSync(path.join(destDir, "src", "locales", "ar"), { recursive: true });
  fs.mkdirSync(path.join(destDir, "src", "components"), { recursive: true });
  fs.mkdirSync(path.join(destDir, "localization"), { recursive: true });
  fs.mkdirSync(path.join(destDir, ".wraith", "artifacts", "visual-qa"), { recursive: true });

  fs.writeFileSync(
    path.join(destDir, "package.json"),
    JSON.stringify({ name: "pulsedesk-qe-eval", version: "1.0.0", private: true, dependencies: { react: "^19.0.0", "react-i18next": "^15.0.0", i18next: "^24.0.0" } }, null, 2) + "\n"
  );

  // 24 keys: d01..d12 = TRUE DEFECTS, c01..c12 = CLEAN / INTENTIONAL-STYLE CONTROLS
  const en = {
    // 12 TRUE DEFECTS
    d01_prompt_prohibited: "Check the link in your email to confirm your computer.",
    d02_style_register_tu: "Update your notification preferences for your account.",
    d03_locale_override_legal: "You may request deletion of your medical and billing records under ISO-27001.",
    d04_approved_term_violation: "Review the Billing cycle summary for your Workspace.",
    d05_prohibited_term_used: "Export your Audit log from this Workspace.",
    d06_dnt_altered: "Authenticate with WraithCloud using PulseKey and OAuth 2.0.",
    d07_polysemy_wrong_sense: "Post",
    d08_misleading_fuzzy_copy: "Disable automatic backups for your Workspace.",
    d09_placeholder_icu_broken: "{count, plural, one {You have # pending invite in {{workspace}}} other {You have # pending invites in {{workspace}}}}",
    d10_cross_component_drift: "Workspace members",
    d11_visual_clipping_defect: "Export compliance bundle",
    d12_factual_omission: "Revoking PulseKey will immediately block API traffic for 24 hours.",
    // 12 CLEAN / INTENTIONAL-STYLE CONTROLS
    c01_clean_prompt_ok: "Check the link in your email to verify access.",
    c02_clean_button_infinitive: "Save",
    c03_clean_legal_usted_override: "You may export your Audit log and account data by contacting our privacy officer.",
    c04_clean_dnt_in_rtl: "Connected to WraithCloud using OAuth 2.0 credentials.",
    c05_clean_human_tm_idiom: "Your compliance bundle is queued for generation.",
    c06_clean_polysemy_battery: "Battery charge",
    c07_clean_polysemy_billing: "Monthly charge",
    c08_clean_polysemy_status: "Open",
    c09_clean_polysemy_verb: "Open",
    c10_clean_shortcut_code: "Press Ctrl+K or run <code>pulsekey sync</code> to inspect files.",
    c11_clean_plural_ok: "{count, plural, one {# saved post} other {# saved posts}}",
    c12_clean_workspace_ref: "Workspace settings",
  };

  const esMX = {
    // 12 TRUE DEFECTS
    d01_prompt_prohibited: "Checa el link en tu correo para confirmar tu ordenador.", // violates prompt (checar, link, ordenador)
    d02_style_register_tu: "Actualice sus preferencias de notificaciones para su cuenta.", // violates informal tú UI rule
    d03_locale_override_legal: "Puedes pedir que borren tu información médica y de facturación bajo ISO-27001.", // violates legal.* formal usted override
    d04_approved_term_violation: "Revisa el resumen del periodo de cobro de tu Espacio de trabajo.", // violates Billing cycle -> Ciclo de facturación
    d05_prohibited_term_used: "Exporta tu Bitácora de cambios desde esta Área de trabajo.", // uses TWO prohibited terms
    d06_dnt_altered: "Autentícate con NubeWraith usando LlavePulso y OAuth 2.0.", // translates DNT WraithCloud & PulseKey
    d07_polysemy_wrong_sense: "Publicación", // noun instead of verb on <button type="submit">
    d08_misleading_fuzzy_copy: "Activa las copias de seguridad automáticas para tu Espacio de trabajo.", // copied opposite polarity from fuzzy TM
    d09_placeholder_icu_broken: "{count, plural, one {Tienes # invitación pendiente} other {Tienes # invitaciones pendientes}}", // dropped {{workspace}}
    d10_cross_component_drift: "Miembros del Área de trabajo", // term drift vs c12 "Espacio de trabajo"
    d11_visual_clipping_defect: "Exportar el paquete completo de documentación de cumplimiento regulatorio", // triggers visual clipping in visual-qa manifest
    d12_factual_omission: "Revocar PulseKey bloqueará el tráfico de API.", // dropped "immediately" and "for 24 hours"
    // 12 CLEAN / INTENTIONAL-STYLE CONTROLS
    c01_clean_prompt_ok: "Revisa el enlace en tu correo electrónico para verificar el acceso.",
    c02_clean_button_infinitive: "Guardar",
    c03_clean_legal_usted_override: "Usted puede exportar su Registro de auditoría y los datos de su cuenta comunicándose con nuestro responsable de privacidad.",
    c04_clean_dnt_in_rtl: "Conectado a WraithCloud con credenciales OAuth 2.0.",
    c05_clean_human_tm_idiom: "Tu paquete de cumplimiento está en fila para generarse.",
    c06_clean_polysemy_battery: "Carga de la batería",
    c07_clean_polysemy_billing: "Cargo mensual",
    c08_clean_polysemy_status: "Abierto",
    c09_clean_polysemy_verb: "Abrir",
    c10_clean_shortcut_code: "Presiona Ctrl+K o ejecuta <code>pulsekey sync</code> para inspeccionar archivos.",
    c11_clean_plural_ok: "{count, plural, one {# publicación guardada} other {# publicaciones guardadas}}",
    c12_clean_workspace_ref: "Configuración del Espacio de trabajo",
  };

  const ar = {
    // 12 TRUE DEFECTS
    d01_prompt_prohibited: "افتح اللينك في بريدك لتأكيد الأكاونت من الداشبورد.", // violates prompt prohibited transliterations
    d02_style_register_tu: "هل تريد تحديث إعدادات الإشعارات في حسابك?", // violates Arabic question mark rule (ASCII '?')
    d03_locale_override_legal: "يمكنك طلب حذف سجلاتك الطبية وسجلات الفوترة, بموجب معيار ISO-27001.", // violates Arabic comma rule (ASCII ',')
    d04_approved_term_violation: "راجع ملخص فترة الدفع الخاصة بـ مساحة العمل.", // violates Billing cycle -> دورة الفوترة
    d05_prohibited_term_used: "صدّر سجل التغييرات من منطقة العمل هذه.", // uses TWO prohibited terms
    d06_dnt_altered: "سجّل الدخول إلى سحابة رايث باستخدام مفتاح بالس وOAuth 2.0.", // translates DNT WraithCloud & PulseKey
    d07_polysemy_wrong_sense: "منشور", // noun instead of verb on <button type="submit">
    d08_misleading_fuzzy_copy: "تفعيل النسخ الاحتياطي التلقائي لـ مساحة العمل الخاصة بك.", // opposite polarity copied from fuzzy TM
    d09_placeholder_icu_broken: "{count, plural, one {لديك دعوة واحدة معلقة} other {لديك # دعوات معلقة}}", // missing {{workspace}} AND missing zero/two/few/many Arabic ICU forms
    d10_cross_component_drift: "أعضاء بيئة العمل", // term drift vs c12 "مساحة العمل"
    d11_visual_clipping_defect: "تصدير حزمة وثائق الامتثال والتدقيق التنظيمي الكاملة والشاملة", // visual clipping in manifest
    d12_factual_omission: "سيؤدي إلغاء PulseKey إلى حظر حركة API.", // dropped "immediately" and "for 24 hours"
    // 12 CLEAN / INTENTIONAL-STYLE CONTROLS
    c01_clean_prompt_ok: "راجع الرابط في بريدك الإلكتروني لتأكيد صلاحية الوصول.",
    c02_clean_button_infinitive: "حفظ",
    c03_clean_legal_usted_override: "يمكنك تصدير سجل التدقيق وبيانات حسابك عبر التواصل مع مسؤول الخصوصية لدينا.",
    c04_clean_dnt_in_rtl: "متصل بـ WraithCloud باستخدام بيانات اعتماد OAuth 2.0.",
    c05_clean_human_tm_idiom: "حزمة الامتثال الخاصة بك في قائمة الانتظار للإنشاء.",
    c06_clean_polysemy_battery: "شحن البطارية",
    c07_clean_polysemy_billing: "الرسوم الشهرية",
    c08_clean_polysemy_status: "مفتوح",
    c09_clean_polysemy_verb: "فتح",
    c10_clean_shortcut_code: "اضغط على Ctrl+K أو شغّل <code>pulsekey sync</code> لفحص الملفات.",
    c11_clean_plural_ok: "{count, plural, zero {لا توجد منشورات محفوظة} one {منشور واحد محفوظ} two {منشوران محفوظان} few {# منشورات محفوظة} many {# منشورًا محفوظًا} other {# منشور محفوظ}}",
    c12_clean_workspace_ref: "إعدادات مساحة العمل",
  };

  fs.writeFileSync(path.join(destDir, "src", "locales", "en", "common.json"), JSON.stringify(en, null, 2) + "\n");
  fs.writeFileSync(path.join(destDir, "src", "locales", "es-MX", "common.json"), JSON.stringify(esMX, null, 2) + "\n");
  fs.writeFileSync(path.join(destDir, "src", "locales", "ar", "common.json"), JSON.stringify(ar, null, 2) + "\n");

  // Component providing real UI context (button vs status badge, legal notice, toolbar button)
  fs.writeFileSync(
    path.join(destDir, "src", "components", "AppView.tsx"),
    `import { useTranslation } from "react-i18next";
export function AppView({ count, workspace }: { count: number; workspace: string }) {
  const { t } = useTranslation("common");
  return (
    <main>
      <p>{t("d01_prompt_prohibited")}</p>
      <p>{t("d02_style_register_tu")}</p>
      <section className="legal-notice"><p>{t("d03_locale_override_legal")}</p><p>{t("c03_clean_legal_usted_override")}</p></section>
      <p>{t("d04_approved_term_violation")}</p>
      <p>{t("d05_prohibited_term_used")}</p>
      <p>{t("d06_dnt_altered")}</p>
      <button type="submit">{t("d07_polysemy_wrong_sense")}</button>
      <p>{t("d08_misleading_fuzzy_copy")}</p>
      <p>{t("d09_placeholder_icu_broken", { count, workspace })}</p>
      <h3>{t("d10_cross_component_drift")}</h3>
      <h3>{t("c12_clean_workspace_ref")}</h3>
      <button className="w-[140px] truncate overflow-hidden">{t("d11_visual_clipping_defect")}</button>
      <p>{t("d12_factual_omission")}</p>
      <p>{t("c01_clean_prompt_ok")}</p>
      <button type="submit">{t("c02_clean_button_infinitive")}</button>
      <p>{t("c04_clean_dnt_in_rtl")}</p>
      <p>{t("c05_clean_human_tm_idiom")}</p>
      <div className="battery-panel">{t("c06_clean_polysemy_battery")}</div>
      <div className="billing-panel">{t("c07_clean_polysemy_billing")}</div>
      <span className="ticket-status-badge">{t("c08_clean_polysemy_status")}</span>
      <button type="button">{t("c09_clean_polysemy_verb")}</button>
      <p>{t("c10_clean_shortcut_code")}</p>
      <p>{t("c11_clean_plural_ok", { count })}</p>
    </main>
  );
}
`
  );

  // Visual QA manifest recording real clipping defect on d11_visual_clipping_defect
  const visualManifest = {
    version: 1,
    generatedAt: "2026-11-27T00:00:00Z",
    defects: [
      {
        locale: "es-MX",
        key: "d11_visual_clipping_defect",
        type: "text_clipping",
        viewport: "375x812",
        message: "Button text overflows 140px container (scrollWidth 412px > clientWidth 140px)",
        screenshot: ".wraith/artifacts/visual-qa/es-MX-mobile-d11.png",
      },
      {
        locale: "ar",
        key: "d11_visual_clipping_defect",
        type: "text_clipping",
        viewport: "375x812",
        message: "Button text overflows 140px container in RTL (scrollWidth 388px > clientWidth 140px)",
        screenshot: ".wraith/artifacts/visual-qa/ar-mobile-d11.png",
      },
    ],
  };
  fs.writeFileSync(
    path.join(destDir, ".wraith", "artifacts", "visual-qa", "manifest.json"),
    JSON.stringify(visualManifest, null, 2) + "\n"
  );

  // Linguistic assets
  fs.writeFileSync(path.join(destDir, "localization", "STYLE_GUIDE.md"), STYLE_GUIDE_V1);
  fs.writeFileSync(path.join(destDir, "localization", "TRANSLATION_PROMPT.md"), TRANSLATION_PROMPT_V1);
  fs.writeFileSync(
    path.join(destDir, "localization", "LOCALE_RULES.json"),
    JSON.stringify(
      {
        ...LOCALE_RULES_V1,
        "es-MX":
          LOCALE_RULES_V1["es-MX"] +
          " Note: legal-notice keys (d03_locale_override_legal, c03_clean_legal_usted_override) require formal 'usted'.",
      },
      null,
      2
    ) + "\n"
  );
  fs.writeFileSync(path.join(destDir, "localization", "glossary.csv"), GLOSSARY_CSV_V1);
  fs.writeFileSync(path.join(destDir, "localization", "termbase.tbx"), TERMBASE_TBX_V1);
  fs.writeFileSync(path.join(destDir, "localization", "memory.tmx"), MEMORY_TMX_V1);

  if (initWraith && wraithApi) {
    wraithApi.initProject({
      rootDir: destDir,
      sourceLocale: "en",
      targetLocales: ["es-MX", "ar"],
      framework: "react",
      localesPath: "src/locales",
    });
    const store = new wraithApi.WraithStore(destDir);
    const cfg = store.readConfig();
    cfg.styleGuide = {
      file: "localization/STYLE_GUIDE.md",
      translationPrompt: TRANSLATION_PROMPT_V1,
      byLocale: JSON.parse(fs.readFileSync(path.join(destDir, "localization", "LOCALE_RULES.json"), "utf8")),
    };
    store.writeConfig(cfg);
    wraithApi.importGlossaryCsv(destDir, "localization/glossary.csv");
    wraithApi.importGlossaryTbx(destDir, "localization/termbase.tbx");
    wraithApi.importMemoryTmx(destDir, "localization/memory.tmx");
    wraithApi.scanProject({ rootDir: destDir });
  }
}
