import fs from "node:fs";
import path from "node:path";
import { EVAL_ROOT } from "../config.mjs";
import { PILOT_GLOSSARY } from "./build-pilot-app.mjs";

const SYN_DIR = path.join(EVAL_ROOT, "synthetic");

function writeTree(baseDir, files) {
  fs.mkdirSync(baseDir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(baseDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
  }
}

export function renderGenericSyntheticHtml(appTitle, locale, items, flatMessages) {
  const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const dir = locale.startsWith("ar") ? "rtl" : "ltr";
  const tightItems = items.filter((i) => i.category === "tight-ui");
  const otherItems = items.filter((i) => i.category !== "tight-ui");

  return `<!doctype html>
<html lang="${locale}" dir="${dir}">
<head>
<meta charset="utf-8"/>
<title>${esc(appTitle)}</title>
<style>
  * { box-sizing: border-box; font-family: system-ui, sans-serif; }
  body { margin: 0; padding: 16px; background: #f8fafc; color: #0f172a; }
  nav[role="tablist"] { display: flex; gap: 8px; margin-bottom: 16px; }
  .tab-item { width: 96px; padding: 6px 8px; border: 1px solid #94a3b8; border-radius: 6px; background: #fff; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; text-align: center; font-size: 13px; }
  .tight-btn { width: 112px; padding: 6px 8px; border: 1px solid #334155; border-radius: 6px; background: #1e293b; color: #fff; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 13px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 10px; }
  section { background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 10px; font-size: 13px; }
</style>
</head>
<body>
  <nav role="tablist">
    ${tightItems.slice(0, 3).map((it) => `<button role="tab" class="tab-item" data-testid="${esc(it.key)}">${esc(flatMessages[it.key] ?? `[MISSING:${it.key}]`)}</button>`).join("")}
    ${tightItems.slice(3).map((it) => `<button class="tight-btn" data-testid="${esc(it.key)}">${esc(flatMessages[it.key] ?? `[MISSING:${it.key}]`)}</button>`).join("")}
  </nav>
  <main class="grid">
    ${otherItems.map((it) => `<section><h3>${esc(it.key)}</h3><p>${esc(flatMessages[it.key] ?? `[MISSING:${it.key}]`)}</p></section>`).join("")}
  </main>
</body>
</html>`;
}

// ============================================================================
// 1. Vue 3 + vue-i18n synthetic app (`vue-dashboard`)
// ============================================================================
export const VUE_ITEMS = [
  { key: "status.openBadge", source: "Open", category: "ambiguous", component: "IncidentCard.vue", intendedSense: "Adjective meaning a support ticket/incident is currently open/unresolved." },
  { key: "file.openAction", source: "Open", category: "ambiguous", component: "LogViewer.vue", intendedSense: "Imperative verb button to open a log file." },
  { key: "feed.postLabel", source: "Post", category: "ambiguous", component: "ReleaseFeed.vue", intendedSense: "Noun: a published status update post." },
  { key: "editor.postButton", source: "Post", category: "ambiguous", component: "StatusComposer.vue", intendedSense: "Imperative verb: publish a new status update." },
  { key: "dialog.closeAction", source: "Close", category: "ambiguous", component: "ConfirmModal.vue", intendedSense: "Imperative verb: close the modal dialog." },
  { key: "quota.freeLabel", source: "Free", category: "ambiguous", component: "ClusterStorage.vue", intendedSense: "Adjective: available/unoccupied memory or disk capacity." },
  { key: "form.saveAction", source: "Save", category: "ambiguous", component: "AlertRuleForm.vue", intendedSense: "Imperative verb: persist alert rule changes." },
  { key: "nav.backAction", source: "Back", category: "ambiguous", component: "StepHeader.vue", intendedSense: "Navigation button to return to the previous page." },
  { key: "alerts.archiveAction", source: "Archive", category: "ambiguous", component: "AlertToolbar.vue", intendedSense: "Imperative verb: archive selected alerts." },
  { key: "history.archiveTitle", source: "Archive", category: "ambiguous", component: "AuditSidebar.vue", intendedSense: "Noun: historical archive section." },
  { key: "brand.title", source: "PulseGrid Operations Console", category: "dnt", component: "StepHeader.vue", intendedSense: null },
  { key: "brand.sync", source: "Northstar synced your Workspace metrics to LedgerVault.", category: "dnt", component: "AuditSidebar.vue", intendedSense: null },
  { key: "glossary.seatNote", source: "Add a Seat to this Workspace before inviting engineers.", category: "glossary", component: "AlertRuleForm.vue", intendedSense: null },
  { key: "glossary.invoiceRow", source: "Download monthly Invoice", category: "glossary", component: "AuditSidebar.vue", intendedSense: null },
  { key: "plural.alerts", source: "no alerts | one alert | {count} alerts", category: "plural", component: "AlertToolbar.vue", intendedSense: null },
  { key: "plural.nodes", source: "no active nodes | one active node | {count} active nodes", category: "plural", component: "ClusterStorage.vue", intendedSense: null },
  { key: "msg.assigned", source: "{user} acknowledged incident {id}.", category: "placeholder", component: "IncidentCard.vue", intendedSense: null },
  { key: "msg.latency", source: "Average response time is {ms} ms over {window}.", category: "placeholder", component: "ClusterStorage.vue", intendedSense: null },
  { key: "tight.tabMetrics", source: "Metrics", category: "tight-ui", component: "StepHeader.vue", intendedSense: null },
  { key: "tight.tabLogs", source: "Logs", category: "tight-ui", component: "StepHeader.vue", intendedSense: null },
  { key: "tight.tabAlerts", source: "Alerts", category: "tight-ui", component: "StepHeader.vue", intendedSense: null },
  { key: "tight.btnExport", source: "Export CSV", category: "tight-ui", component: "AlertToolbar.vue", intendedSense: null },
  { key: "tight.btnReset", source: "Reset view", category: "tight-ui", component: "LogViewer.vue", intendedSense: null },
  { key: "general.emptyLogs", source: "No log lines matched your current filter.", category: "general", component: "LogViewer.vue", intendedSense: null },
  { key: "general.ruleSaved", source: "Alert thresholds take effect within thirty seconds.", category: "general", component: "AlertRuleForm.vue", intendedSense: null },
];

export function buildVueApp() {
  const dir = path.join(SYN_DIR, "vue-dashboard");
  const flatEn = Object.fromEntries(VUE_ITEMS.map((i) => [i.key, i.source]));
  const unflat = {};
  for (const [k, v] of Object.entries(flatEn)) {
    const [a, b] = k.split(".");
    unflat[a] = unflat[a] ?? {};
    unflat[a][b] = v;
  }

  const components = {
    "src/components/StepHeader.vue": `<template>
  <header>
    <h1>{{ $t('brand.title') }}</h1>
    <button>{{ $t('nav.backAction') }}</button>
    <nav role="tablist">
      <button class="w-24 truncate whitespace-nowrap overflow-hidden">{{ $t('tight.tabMetrics') }}</button>
      <button class="w-24 truncate whitespace-nowrap overflow-hidden">{{ $t('tight.tabLogs') }}</button>
      <button class="w-24 truncate whitespace-nowrap overflow-hidden">{{ $t('tight.tabAlerts') }}</button>
    </nav>
  </header>
</template>
`,
    "src/components/IncidentCard.vue": `<template>
  <!-- Support incident ticket status ("Open" means unresolved ticket) -->
  <article>
    <span class="badge">{{ $t('status.openBadge') }}</span>
    <p>{{ $t('msg.assigned', { user, id }) }}</p>
  </article>
</template>
`,
    "src/components/LogViewer.vue": `<template>
  <!-- Raw log viewer toolbar ("Open" is verb to open log file) -->
  <section>
    <button>{{ $t('file.openAction') }}</button>
    <button class="w-28 truncate whitespace-nowrap overflow-hidden">{{ $t('tight.btnReset') }}</button>
    <p>{{ $t('general.emptyLogs') }}</p>
  </section>
</template>
`,
    "src/components/ReleaseFeed.vue": `<template>
  <!-- Status update card ("Post" is noun: a published entry) -->
  <section><h2>{{ $t('feed.postLabel') }}</h2></section>
</template>
`,
    "src/components/StatusComposer.vue": `<template>
  <!-- Status composer submit button ("Post" is verb: publish) -->
  <form><button type="submit">{{ $t('editor.postButton') }}</button></form>
</template>
`,
    "src/components/ConfirmModal.vue": `<template>
  <div role="dialog"><button>{{ $t('dialog.closeAction') }}</button></div>
</template>
`,
    "src/components/ClusterStorage.vue": `<template>
  <!-- Cluster memory & disk capacity ("Free" means unoccupied capacity) -->
  <section>
    <span>{{ $t('quota.freeLabel') }}</span>
    <p>{{ $t('plural.nodes', count) }}</p>
    <p>{{ $t('msg.latency', { ms, window }) }}</p>
  </section>
</template>
`,
    "src/components/AlertRuleForm.vue": `<template>
  <form>
    <p>{{ $t('glossary.seatNote') }}</p>
    <button type="submit">{{ $t('form.saveAction') }}</button>
    <p>{{ $t('general.ruleSaved') }}</p>
  </form>
</template>
`,
    "src/components/AlertToolbar.vue": `<template>
  <div class="toolbar">
    <button>{{ $t('alerts.archiveAction') }}</button>
    <button class="w-28 truncate whitespace-nowrap overflow-hidden">{{ $t('tight.btnExport') }}</button>
    <span>{{ $t('plural.alerts', count) }}</span>
  </div>
</template>
`,
    "src/components/AuditSidebar.vue": `<template>
  <aside>
    <h3>{{ $t('history.archiveTitle') }}</h3>
    <p>{{ $t('brand.sync') }}</p>
    <a>{{ $t('glossary.invoiceRow') }}</a>
  </aside>
</template>
`,
  };

  writeTree(dir, {
    "package.json": JSON.stringify({ name: "pulsegrid-vue-dashboard", dependencies: { vue: "3.5.0", "vue-i18n": "10.0.0" } }, null, 2) + "\n",
    "locales/en.json": JSON.stringify(unflat, null, 2) + "\n",
    "challenge-labels.json": JSON.stringify({ items: VUE_ITEMS, glossary: PILOT_GLOSSARY }, null, 2) + "\n",
    ...components,
  });

  return { appDir: dir, stack: "vue-i18n", items: VUE_ITEMS, flatEn, components, glossary: PILOT_GLOSSARY };
}

// ============================================================================
// 2. Rails I18n YAML synthetic app (`rails-portal`)
// ============================================================================
export const RAILS_ITEMS = [
  { key: "orders.index.order_heading", source: "Order", category: "ambiguous", component: "index.html.erb", intendedSense: "Noun: a customer purchase order." },
  { key: "orders.index.sort_order", source: "Order", category: "ambiguous", component: "index.html.erb", intendedSense: "Noun: display sorting order/sequence." },
  { key: "billing.show.charge_label", source: "Charge", category: "ambiguous", component: "show.html.erb", intendedSense: "Noun: financial billing charge/fee." },
  { key: "hardware.show.charge_label", source: "Charge", category: "ambiguous", component: "hardware.html.erb", intendedSense: "Noun: electrical battery level of a terminal." },
  { key: "plans.show.free_badge", source: "Free", category: "ambiguous", component: "plans.html.erb", intendedSense: "Adjective: free of cost / gratis plan." },
  { key: "agreements.show.sign_button", source: "Sign", category: "ambiguous", component: "agreements.html.erb", intendedSense: "Imperative verb: sign legal contract." },
  { key: "wizard.show.back_link", source: "Back", category: "ambiguous", component: "agreements.html.erb", intendedSense: "Navigation link to previous screen." },
  { key: "settings.edit.save_button", source: "Save", category: "ambiguous", component: "edit.html.erb", intendedSense: "Imperative verb: save account settings." },
  { key: "brand.portal_title", source: "Northstar Merchant Portal", category: "dnt", component: "index.html.erb", intendedSense: null },
  { key: "brand.vault_notice", source: "All settlements are mirrored to LedgerVault and Northstar Pay.", category: "dnt", component: "show.html.erb", intendedSense: null },
  { key: "glossary.workspace_header", source: "Manage Workspace billing and Seats", category: "glossary", component: "edit.html.erb", intendedSense: null },
  { key: "glossary.invoice_ready", source: "Your latest Invoice is ready for download.", category: "glossary", component: "show.html.erb", intendedSense: null },
  { key: "messages.greeting", source: "Welcome back, %{name}. You have %{count} open requests.", category: "placeholder", component: "index.html.erb", intendedSense: null },
  { key: "messages.subtotal", source: "Subtotal: %<amount>.2f USD before tax.", category: "placeholder", component: "show.html.erb", intendedSense: null },
  { key: "tight.tab_orders", source: "Orders", category: "tight-ui", component: "index.html.erb", intendedSense: null },
  { key: "tight.tab_payouts", source: "Payouts", category: "tight-ui", component: "index.html.erb", intendedSense: null },
  { key: "tight.tab_team", source: "Team", category: "tight-ui", component: "index.html.erb", intendedSense: null },
  { key: "tight.btn_export", source: "Export PDF", category: "tight-ui", component: "show.html.erb", intendedSense: null },
  { key: "general.empty_orders", source: "No orders have been placed in this billing cycle yet.", category: "general", component: "index.html.erb", intendedSense: null },
  { key: "general.support_footer", source: "Need help? Contact support before closing your account.", category: "general", component: "edit.html.erb", intendedSense: null },
];

export function buildRailsApp() {
  const dir = path.join(SYN_DIR, "rails-portal");
  const enYml = `en:
  orders:
    index:
      order_heading: "Order"
      sort_order: "Order"
      items_count:
        one: "1 order item"
        other: "%{count} order items"
  billing:
    show:
      charge_label: "Charge"
  hardware:
    show:
      charge_label: "Charge"
  plans:
    show:
      free_badge: "Free"
  agreements:
    show:
      sign_button: "Sign"
  wizard:
    show:
      back_link: "Back"
  settings:
    edit:
      save_button: "Save"
  brand:
    portal_title: "Northstar Merchant Portal"
    vault_notice: "All settlements are mirrored to LedgerVault and Northstar Pay."
  glossary:
    workspace_header: "Manage Workspace billing and Seats"
    invoice_ready: "Your latest Invoice is ready for download."
  messages:
    greeting: "Welcome back, %{name}. You have %{count} open requests."
    subtotal: "Subtotal: %<amount>.2f USD before tax."
  tight:
    tab_orders: "Orders"
    tab_payouts: "Payouts"
    tab_team: "Team"
    btn_export: "Export PDF"
  general:
    empty_orders: "No orders have been placed in this billing cycle yet."
    support_footer: "Need help? Contact support before closing your account."
`;

  const components = {
    "app/views/orders/index.html.erb": `<header>
  <h1><%= t('brand.portal_title') %></h1>
  <nav role="tablist">
    <button class="w-24 truncate whitespace-nowrap overflow-hidden"><%= t('tight.tab_orders') %></button>
    <button class="w-24 truncate whitespace-nowrap overflow-hidden"><%= t('tight.tab_payouts') %></button>
    <button class="w-24 truncate whitespace-nowrap overflow-hidden"><%= t('tight.tab_team') %></button>
  </nav>
</header>
<section>
  <!-- Purchase order heading -->
  <h2><%= t('.order_heading') %></h2>
  <!-- Sort dropdown label -->
  <label><%= t('.sort_order') %></label>
  <p><%= t('.items_count', count: @count) %></p>
  <p><%= t('messages.greeting', name: @user.name, count: @open_count) %></p>
  <p><%= t('general.empty_orders') %></p>
</section>
`,
    "app/views/billing/show.html.erb": `<section>
  <!-- Financial charge line item -->
  <h2><%= t('billing.show.charge_label') %></h2>
  <p><%= t('messages.subtotal', amount: @subtotal) %></p>
  <p><%= t('glossary.invoice_ready') %></p>
  <p><%= t('brand.vault_notice') %></p>
  <button class="w-28 truncate whitespace-nowrap overflow-hidden"><%= t('tight.btn_export') %></button>
</section>
`,
    "app/views/hardware/hardware.html.erb": `<section>
  <!-- POS terminal electrical battery charge -->
  <h3><%= t('hardware.show.charge_label') %></h3>
</section>
`,
    "app/views/plans/plans.html.erb": `<section>
  <!-- $0 pricing tier badge -->
  <span class="badge"><%= t('plans.show.free_badge') %></span>
</section>
`,
    "app/views/agreements/agreements.html.erb": `<section>
  <!-- Legal e-signature submit button -->
  <button><%= t('agreements.show.sign_button') %></button>
  <!-- Wizard back link -->
  <a><%= t('wizard.show.back_link') %></a>
</section>
`,
    "app/views/settings/edit.html.erb": `<form>
  <h2><%= t('glossary.workspace_header') %></h2>
  <button type="submit"><%= t('settings.edit.save_button') %></button>
  <p><%= t('general.support_footer') %></p>
</form>
`,
  };

  writeTree(dir, {
    Gemfile: 'source "https://rubygems.org"\ngem "rails", "~> 7.1"\n',
    "config/application.rb": "module RailsPortal; end\n",
    "config/locales/en.yml": enYml,
    "challenge-labels.json": JSON.stringify({ items: RAILS_ITEMS, glossary: PILOT_GLOSSARY }, null, 2) + "\n",
    ...components,
  });

  const flatEn = {
    ...Object.fromEntries(RAILS_ITEMS.map((i) => [i.key, i.source])),
    "orders.index.items_count.one": "1 order item",
    "orders.index.items_count.other": "%{count} order items",
  };
  return { appDir: dir, stack: "rails", items: RAILS_ITEMS, flatEn, components, glossary: PILOT_GLOSSARY };
}

// ============================================================================
// 3. Django gettext PO synthetic app (`django-clinic`)
// ============================================================================
export const DJANGO_ITEMS = [
  { key: "Open", source: "Open", category: "ambiguous", component: "views.py", intendedSense: "Adjective meaning the medical clinic is currently open for patient walk-ins." },
  { key: "Close", source: "Close", category: "ambiguous", component: "appointment.html", intendedSense: "Imperative verb button to close the appointment modal." },
  { key: "Save", source: "Save", category: "ambiguous", component: "appointment.html", intendedSense: "Imperative verb button to save patient intake details." },
  { key: "Back", source: "Back", category: "ambiguous", component: "appointment.html", intendedSense: "Navigation link to return to the previous booking step." },
  { key: "Sign", source: "Sign", category: "ambiguous", component: "consent.html", intendedSense: "Imperative verb to electronically sign the HIPAA consent form." },
  { key: "Northstar Health Clinic", source: "Northstar Health Clinic", category: "dnt", component: "appointment.html", intendedSense: null },
  { key: "Records are archived securely in LedgerVault.", source: "Records are archived securely in LedgerVault.", category: "dnt", component: "consent.html", intendedSense: null },
  { key: "Select a Workspace to view patient Invoices.", source: "Select a Workspace to view patient Invoices.", category: "glossary", component: "views.py", intendedSense: null },
  { key: "Assigned %(doctor)s for %(patient)s.", source: "Assigned %(doctor)s for %(patient)s.", category: "placeholder", component: "views.py", intendedSense: null },
  { key: "Your visit is confirmed for %(date)s at %(time)s.", source: "Your visit is confirmed for %(date)s at %(time)s.", category: "placeholder", component: "appointment.html", intendedSense: null },
  { key: "Schedule", source: "Schedule", category: "tight-ui", component: "appointment.html", intendedSense: null },
  { key: "Patients", source: "Patients", category: "tight-ui", component: "appointment.html", intendedSense: null },
  { key: "Records", source: "Records", category: "tight-ui", component: "appointment.html", intendedSense: null },
  { key: "Cancel visit", source: "Cancel visit", category: "tight-ui", component: "appointment.html", intendedSense: null },
  { key: "Please arrive fifteen minutes before your scheduled appointment.", source: "Please arrive fifteen minutes before your scheduled appointment.", category: "general", component: "appointment.html", intendedSense: null },
  { key: "No upcoming laboratory results are available yet.", source: "No upcoming laboratory results are available yet.", category: "general", component: "views.py", intendedSense: null },
];

const PO_PLURAL_HEADERS = {
  "es-MX": "nplurals=2; plural=(n != 1);",
  de: "nplurals=2; plural=(n != 1);",
  ja: "nplurals=1; plural=0;",
  ar: "nplurals=6; plural=(n==0 ? 0 : n==1 ? 1 : n==2 ? 2 : n%100>=3 && n%100<=10 ? 3 : n%100>=11 ? 4 : 5);",
  pl: "nplurals=3; plural=(n==1 ? 0 : n%10>=2 && n%10<=4 && (n%100<10 || n%100>=20) ? 1 : 2);",
};

export function makeDjangoPoSkeleton(locale) {
  const pf = PO_PLURAL_HEADERS[locale] ?? "nplurals=2; plural=(n != 1);";
  const nplurals = Number(/nplurals=(\d+)/.exec(pf)?.[1] ?? 2);
  let body = `msgid ""
msgstr ""
"Language: ${locale}\\n"
"MIME-Version: 1.0\\n"
"Content-Type: text/plain; charset=UTF-8\\n"
"Content-Transfer-Encoding: 8bit\\n"
"Plural-Forms: ${pf}\\n"

`;
  for (const it of DJANGO_ITEMS) {
    const esc = it.source.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    body += `#: clinic/${it.component}\nmsgid "${esc}"\nmsgstr ""\n\n`;
  }
  body += `#: clinic/views.py\nmsgid "%(count)d appointment remaining"\nmsgid_plural "%(count)d appointments remaining"\n`;
  for (let i = 0; i < nplurals; i++) {
    body += `msgstr[${i}] ""\n`;
  }
  return body;
}

export function buildDjangoApp() {
  const dir = path.join(SYN_DIR, "django-clinic");
  const components = {
    "clinic/views.py": `from django.utils.translation import gettext as _, ngettext

def status_view(request, count):
    # Clinic walk-in status ("Open" means open for business)
    clinic_status = _("Open")
    workspace_msg = _("Select a Workspace to view patient Invoices.")
    assigned = _("Assigned %(doctor)s for %(patient)s.") % {"doctor": "Dr. Lee", "patient": "Sam"}
    empty = _("No upcoming laboratory results are available yet.")
    rem = ngettext("%(count)d appointment remaining", "%(count)d appointments remaining", count) % {"count": count}
    return [clinic_status, workspace_msg, assigned, empty, rem]
`,
    "templates/appointment.html": `{% load i18n %}
<header>
  <h1>{% translate "Northstar Health Clinic" %}</h1>
  <nav role="tablist">
    <button class="w-24 truncate whitespace-nowrap overflow-hidden">{% translate "Schedule" %}</button>
    <button class="w-24 truncate whitespace-nowrap overflow-hidden">{% translate "Patients" %}</button>
    <button class="w-24 truncate whitespace-nowrap overflow-hidden">{% translate "Records" %}</button>
  </nav>
</header>
<section>
  <p>{% blocktranslate %}Your visit is confirmed for {{ date }} at {{ time }}.{% endblocktranslate %}</p>
  <p>{% translate "Please arrive fifteen minutes before your scheduled appointment." %}</p>
  <button>{% translate "Save" %}</button>
  <button>{% translate "Close" %}</button>
  <a>{% translate "Back" %}</a>
  <button class="w-28 truncate whitespace-nowrap overflow-hidden">{% translate "Cancel visit" %}</button>
</section>
`,
    "templates/consent.html": `{% load i18n %}
<section>
  <p>{% translate "Records are archived securely in LedgerVault." %}</p>
  <!-- Electronic signature verb -->
  <button>{% translate "Sign" %}</button>
</section>
`,
  };

  const poFiles = {
    "locale/en/LC_MESSAGES/django.po": makeDjangoPoSkeleton("en"),
  };
  for (const loc of ["es-MX", "de", "ja", "ar", "pl"]) {
    const dirName = loc.replace(/-/g, "_");
    poFiles[`locale/${dirName}/LC_MESSAGES/django.po`] = makeDjangoPoSkeleton(loc);
  }

  writeTree(dir, {
    "manage.py": "#!/usr/bin/env python\n",
    "requirements.txt": "Django==5.1\n",
    "challenge-labels.json": JSON.stringify({ items: DJANGO_ITEMS, glossary: PILOT_GLOSSARY }, null, 2) + "\n",
    ...components,
    ...poFiles,
  });

  const flatEn = {
    ...Object.fromEntries(DJANGO_ITEMS.map((i) => [i.key, i.source])),
    "%(count)d appointment remaining": "%(count)d appointment remaining",
    "%(count)d appointments remaining": "%(count)d appointments remaining",
  };
  return { appDir: dir, stack: "django", items: DJANGO_ITEMS, flatEn, components, glossary: PILOT_GLOSSARY };
}

// ============================================================================
// 4. Never-internationalized Next.js app (`nextjs-unlocalized`) for Extraction Test
// ============================================================================
export const EXTRACTION_EXPECTED = [
  "Northstar Studio",
  "Create project",
  "Import repository",
  "Search projects...",
  "Filter by region",
  "Deployments",
  "Environment variables",
  "Billing overview",
  "All systems operational",
  "Last deployed 4 minutes ago",
  "Production branch",
  "Preview builds enabled",
  "Confirm deletion",
  "Delete workspace",
  "Enter your workspace slug",
  "Must be lowercase letters and numbers",
  "Deployment succeeded",
  "Unable to connect to build runner",
  "Upgrade to unlock unlimited seats",
  "Contact sales",
  "Read the documentation",
  "Company brand mark",
  "You have",
  "active builds",
];

export const EXTRACTION_MUST_NOT = [
  "application/json",
  "Bearer ",
  "/api/v1/deployments/",
  "X-Trace-Id",
  "SELECT id FROM projects",
  "console.info",
  "build_status_ok",
  "us-west-2",
  "flex items-center gap-2",
  "https://status.northstar.example",
];

export function buildExtractionApp() {
  const dir = path.join(SYN_DIR, "nextjs-unlocalized");
  writeTree(dir, {
    "package.json": JSON.stringify(
      {
        name: "northstar-studio-unlocalized",
        version: "0.1.0",
        private: true,
        dependencies: { next: "15.1.0", react: "19.0.0", "react-dom": "19.0.0", "next-intl": "4.0.0" },
        devDependencies: { typescript: "5.7.2" },
      },
      null,
      2
    ) + "\n",
    "tsconfig.json": JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          lib: ["DOM", "ES2022"],
          jsx: "react-jsx",
          module: "ESNext",
          moduleResolution: "Bundler",
          strict: true,
          noEmit: true,
          skipLibCheck: true,
        },
        include: ["src/**/*"],
      },
      null,
      2
    ) + "\n",
    "messages/en.json": "{}\n",
    "src/components/StudioDashboard.tsx": `import { useState } from "react";

const NAV_TABS = ["Deployments", "Environment variables", "Billing overview"] as const;

export function StudioDashboard({ activeCount, region }: { activeCount: number; region: string }) {
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [selectedRegion, setSelectedRegion] = useState("us-west-2");
  const statusBanner = activeCount > 0 ? "All systems operational" : "Last deployed 4 minutes ago";

  return (
    <main className="flex items-center gap-2">
      <header>
        <img src="/mark.svg" alt="Company brand mark" />
        <h1>Northstar Studio</h1>
        <button type="button" onClick={() => setStatusMsg("Deployment succeeded")}>Create project</button>
        <button type="button" onClick={() => setStatusMsg("Unable to connect to build runner")}>Import repository</button>
      </header>
      <nav>
        {NAV_TABS.map((tab) => <a key={tab} href="#">{tab}</a>)}
      </nav>
      <section>
        <input type="search" placeholder="Search projects..." aria-label="Filter by region" />
        <p>{statusBanner}</p>
        <p>You have {activeCount} active builds</p>
        <span>Production branch</span>
        <span>Preview builds enabled</span>
        {statusMsg && <div role="status">{statusMsg}</div>}
      </section>
      <section>
        <h2>Confirm deletion</h2>
        <Field label="Enter your workspace slug" hint="Must be lowercase letters and numbers" />
        <button type="button">Delete workspace</button>
      </section>
      <footer>
        <p>Upgrade to unlock unlimited seats</p>
        <a href="https://status.northstar.example">Contact sales</a>
        <a href="/docs">Read the documentation</a>
      </footer>
    </main>
  );
}
declare const Field: any;
`,
    "src/lib/runnerApi.ts": `export async function triggerBuild(projectId: string, token: string) {
  const endpoint = "/api/v1/deployments/" + projectId;
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
      "X-Trace-Id": projectId,
    },
    body: JSON.stringify({ region: "us-west-2", code: "build_status_ok" }),
  });
  console.info("Triggered build for " + projectId);
  const sql = "SELECT id FROM projects WHERE id = " + projectId;
  return { ok: res.ok, sql };
}
`,
    "extraction-labels.json": JSON.stringify(
      { expected: EXTRACTION_EXPECTED, mustNotFlag: EXTRACTION_MUST_NOT },
      null,
      2
    ) + "\n",
  });
  return { appDir: dir, expected: EXTRACTION_EXPECTED, mustNotFlag: EXTRACTION_MUST_NOT };
}

export function buildAllSyntheticApps() {
  return {
    vue: buildVueApp(),
    rails: buildRailsApp(),
    django: buildDjangoApp(),
    extraction: buildExtractionApp(),
  };
}
