import fs from "node:fs";
import path from "node:path";
import { EVAL_ROOT } from "../config.mjs";

export const PILOT_APP_DIR = path.join(EVAL_ROOT, "synthetic", "nextjs-commerce");

export const PILOT_GLOSSARY = [
  { term: "Northstar", doNotTranslate: true, caseSensitive: true, translations: {}, notes: "Company brand name — never translate." },
  { term: "Northstar Pay", doNotTranslate: true, caseSensitive: true, translations: {}, notes: "Payment product name — never translate." },
  { term: "PulseGrid", doNotTranslate: true, caseSensitive: true, translations: {}, notes: "Analytics suite brand — never translate." },
  { term: "LedgerVault", doNotTranslate: true, caseSensitive: true, translations: {}, notes: "Compliance module brand — never translate." },
  {
    term: "Workspace",
    doNotTranslate: false,
    caseSensitive: false,
    translations: {
      "es-MX": "espacio de trabajo",
      de: "Arbeitsbereich",
      ja: "ワークスペース",
      ar: "مساحة العمل",
      pl: "obszar roboczy",
    },
    notes: "Use consistently for team container.",
  },
  {
    term: "Invoice",
    doNotTranslate: false,
    caseSensitive: false,
    translations: {
      "es-MX": "factura",
      de: "Rechnung",
      ja: "請求書",
      ar: "فاتورة",
      pl: "faktura",
    },
    notes: "Standard billing document term.",
  },
  {
    term: "Seat",
    doNotTranslate: false,
    caseSensitive: false,
    translations: {
      "es-MX": "licencia",
      de: "Lizenz",
      ja: "シート",
      ar: "مقعد",
      pl: "stanowisko",
    },
    notes: "Per-user subscription license.",
  },
];

/**
 * 60 labelled challenge strings across 7 components:
 * - 20 context-ambiguous homonyms (10 pairs)
 * - 6 DNT brand-name strings
 * - 6 glossary-term strings
 * - 10 ICU plurals / ordinals / selects / formatted args
 * - 6 rich-text tag strings
 * - 6 tight-width button / tab / badge strings
 * - 6 general realistic product copy strings
 */
export const PILOT_ITEMS = [
  // === 1. Context-ambiguous homonyms (20 items, 10 disambiguated pairs) ===
  {
    key: "hours.openBadge",
    source: "Open",
    category: "ambiguous",
    component: "StoreHoursCard.tsx",
    intendedSense: "Adjective meaning the retail store is currently open for business (NOT the verb 'to open' a file).",
  },
  {
    key: "invoice.openAction",
    source: "Open",
    category: "ambiguous",
    component: "InvoiceActions.tsx",
    intendedSense: "Imperative verb button to open/view a PDF invoice document (NOT 'open for business').",
  },
  {
    key: "community.postHeading",
    source: "Post",
    category: "ambiguous",
    component: "CommunityFeed.tsx",
    intendedSense: "Noun referring to a published forum post / article entry (NOT the action verb 'to publish').",
  },
  {
    key: "composer.postAction",
    source: "Post",
    category: "ambiguous",
    component: "CommentComposer.tsx",
    intendedSense: "Imperative verb button to publish/submit a new reply (NOT the noun 'a post').",
  },
  {
    key: "checkout.orderLabel",
    source: "Order",
    category: "ambiguous",
    component: "CheckoutSummary.tsx",
    intendedSense: "Noun referring to a customer's commercial purchase order (NOT sorting sequence).",
  },
  {
    key: "catalog.orderLabel",
    source: "Order",
    category: "ambiguous",
    component: "SortToolbar.tsx",
    intendedSense: "Noun referring to display sort sequence/arrangement of list items (NOT a purchase order).",
  },
  {
    key: "modal.closeButton",
    source: "Close",
    category: "ambiguous",
    component: "ModalHeader.tsx",
    intendedSense: "Imperative verb button to dismiss/close a dialog window (NOT proximity 'nearby').",
  },
  {
    key: "branch.closeBadge",
    source: "Close",
    category: "ambiguous",
    component: "NearbyBranchCard.tsx",
    intendedSense: "Adjective meaning geographically nearby / short distance away (NOT the verb 'close window').",
  },
  {
    key: "pricing.freeTag",
    source: "Free",
    category: "ambiguous",
    component: "PricingBanner.tsx",
    intendedSense: "Adjective meaning zero cost / gratis ($0 pricing tier), NOT available disk space.",
  },
  {
    key: "storage.freeTag",
    source: "Free",
    category: "ambiguous",
    component: "StorageQuota.tsx",
    intendedSense: "Adjective meaning unoccupied/available storage space remaining (NOT 'free of charge').",
  },
  {
    key: "profile.saveButton",
    source: "Save",
    category: "ambiguous",
    component: "ProfileForm.tsx",
    intendedSense: "Imperative verb to persist/store form changes (NOT 'save money').",
  },
  {
    key: "promo.saveLabel",
    source: "Save",
    category: "ambiguous",
    component: "PromoBadge.tsx",
    intendedSense: "Verb meaning to save money / get a price reduction on an annual plan (NOT 'save file').",
  },
  {
    key: "wizard.backButton",
    source: "Back",
    category: "ambiguous",
    component: "WizardNav.tsx",
    intendedSense: "Navigation control to return to the previous step (NOT physical back or verb 'support').",
  },
  {
    key: "warranty.backPromise",
    source: "We back every purchase for two years.",
    category: "ambiguous",
    component: "WarrantyCard.tsx",
    intendedSense: "Verb 'back' meaning to guarantee / stand behind a product warranty (NOT 'go back').",
  },
  {
    key: "billing.chargeHeading",
    source: "Charge",
    category: "ambiguous",
    component: "BillingStatement.tsx",
    intendedSense: "Noun meaning a financial fee / line-item debit on a statement (NOT electrical battery charge).",
  },
  {
    key: "device.chargeHeading",
    source: "Charge",
    category: "ambiguous",
    component: "DeviceBatteryStatus.tsx",
    intendedSense: "Noun meaning remaining electrical battery level of a hardware terminal (NOT a billing fee).",
  },
  {
    key: "contract.signAction",
    source: "Sign",
    category: "ambiguous",
    component: "ContractFooter.tsx",
    intendedSense: "Imperative verb to electronically sign a legal agreement (NOT a physical notice/signage).",
  },
  {
    key: "storefront.signNotice",
    source: "Check the sign at the pickup counter.",
    category: "ambiguous",
    component: "StorefrontAlert.tsx",
    intendedSense: "Noun meaning a physical posted notice/placard at a store counter (NOT the verb 'to sign').",
  },
  {
    key: "inbox.archiveAction",
    source: "Archive",
    category: "ambiguous",
    component: "InboxToolbar.tsx",
    intendedSense: "Imperative verb button to move selected notifications to the archive (NOT the noun 'archive').",
  },
  {
    key: "docs.archiveHeading",
    source: "Archive",
    category: "ambiguous",
    component: "DocsSidebar.tsx",
    intendedSense: "Noun referring to the historical collection/repository of past releases (NOT action verb).",
  },

  // === 2. DNT Brand Names (6 items) ===
  {
    key: "brand.welcome",
    source: "Welcome to Northstar Commerce",
    category: "dnt",
    component: "HeaderNav.tsx",
    intendedSense: null,
  },
  {
    key: "brand.payCta",
    source: "Pay faster with Northstar Pay",
    category: "dnt",
    component: "CheckoutSummary.tsx",
    intendedSense: null,
  },
  {
    key: "brand.analyticsDesc",
    source: "PulseGrid tracks live checkout conversion without cookies.",
    category: "dnt",
    component: "AnalyticsPanel.tsx",
    intendedSense: null,
  },
  {
    key: "brand.auditExport",
    source: "Export signed tax records to LedgerVault.",
    category: "dnt",
    component: "BillingStatement.tsx",
    intendedSense: null,
  },
  {
    key: "brand.footerNote",
    source: "Powered by Northstar and PulseGrid.",
    category: "dnt",
    component: "ContractFooter.tsx",
    intendedSense: null,
  },
  {
    key: "brand.vaultSync",
    source: "LedgerVault synced your latest receipt.",
    category: "dnt",
    component: "InvoiceActions.tsx",
    intendedSense: null,
  },

  // === 3. Glossary preferred terms (6 items) ===
  {
    key: "glossary.workspaceCreate",
    source: "Create a new Workspace for your retail team.",
    category: "glossary",
    component: "HeaderNav.tsx",
    intendedSense: null,
  },
  {
    key: "glossary.workspaceSwitch",
    source: "Switch Workspace",
    category: "glossary",
    component: "HeaderNav.tsx",
    intendedSense: null,
  },
  {
    key: "glossary.invoiceDownload",
    source: "Download PDF Invoice",
    category: "glossary",
    component: "InvoiceActions.tsx",
    intendedSense: null,
  },
  {
    key: "glossary.invoicePaid",
    source: "This Invoice was paid on time.",
    category: "glossary",
    component: "BillingStatement.tsx",
    intendedSense: null,
  },
  {
    key: "glossary.seatAssign",
    source: "Assign a Seat to a new teammate.",
    category: "glossary",
    component: "ProfileForm.tsx",
    intendedSense: null,
  },
  {
    key: "glossary.seatLimit",
    source: "Your Workspace includes one complimentary Seat.",
    category: "glossary",
    component: "PricingBanner.tsx",
    intendedSense: null,
  },

  // === 4. ICU Plurals, Ordinals, Selects & Formatted Arguments (10 items) ===
  {
    key: "icu.cartItems",
    source: "{count, plural, one {# item in cart} other {# items in cart}}",
    category: "icu",
    component: "CheckoutSummary.tsx",
    intendedSense: null,
  },
  {
    key: "icu.unreadAlerts",
    source: "{count, plural, =0 {No unread alerts} one {# unread alert} other {# unread alerts}}",
    category: "icu",
    component: "InboxToolbar.tsx",
    intendedSense: null,
  },
  {
    key: "icu.seatsRemaining",
    source: "{count, plural, one {# team Seat remaining} other {# team Seats remaining}}",
    category: "icu",
    component: "PricingBanner.tsx",
    intendedSense: null,
  },
  {
    key: "icu.rankOrdinal",
    source: "Ranked {rank, selectordinal, one {#st} two {#nd} few {#rd} other {#th}} in regional sales",
    category: "icu",
    component: "AnalyticsPanel.tsx",
    intendedSense: null,
  },
  {
    key: "icu.memberRole",
    source: "{role, select, owner {Workspace owner} admin {Administrator} billing {Billing manager} other {Team member}}",
    category: "icu",
    component: "ProfileForm.tsx",
    intendedSense: null,
  },
  {
    key: "icu.orderPipeline",
    source: "{status, select, pending {{count, plural, one {# pending order} other {# pending orders}}} shipped {{count, plural, one {# shipped order} other {# shipped orders}}} other {No active orders}}",
    category: "icu",
    component: "CheckoutSummary.tsx",
    intendedSense: null,
  },
  {
    key: "icu.totalDue",
    source: "Total due: {amount, number, ::currency/USD}",
    category: "icu",
    component: "BillingStatement.tsx",
    intendedSense: null,
  },
  {
    key: "icu.renewalDate",
    source: "Subscription renews on {date, date, medium}.",
    category: "icu",
    component: "BillingStatement.tsx",
    intendedSense: null,
  },
  {
    key: "icu.promoThreshold",
    source: "{discount}% off orders over {minTotal}",
    category: "icu",
    component: "PromoBadge.tsx",
    intendedSense: null,
  },
  {
    key: "icu.ticketAssign",
    source: "{actor} assigned ticket {ticket} to {assignee}.",
    category: "icu",
    component: "InboxToolbar.tsx",
    intendedSense: null,
  },

  // === 5. Rich-text inline tags (6 items) ===
  {
    key: "rich.termsAccept",
    source: "By continuing, you agree to the <link>Terms of Service</link>.",
    category: "rich-text",
    component: "ContractFooter.tsx",
    intendedSense: null,
  },
  {
    key: "rich.deleteWarn",
    source: "This action is <b>permanent</b> and cannot be undone.",
    category: "rich-text",
    component: "ModalHeader.tsx",
    intendedSense: null,
  },
  {
    key: "rich.shippingFast",
    source: "Orders placed before <strong>3:00 PM</strong> ship the same day.",
    category: "rich-text",
    component: "CheckoutSummary.tsx",
    intendedSense: null,
  },
  {
    key: "rich.helpLink",
    source: "Need billing assistance? Visit the <link>Northstar Help Center</link>.",
    category: "rich-text",
    component: "BillingStatement.tsx",
    intendedSense: null,
  },
  {
    key: "rich.backupNotice",
    source: "Automatic snapshots are stored in <b>LedgerVault</b> every <codeTag>24h</codeTag>.",
    category: "rich-text",
    component: "StorageQuota.tsx",
    intendedSense: null,
  },
  {
    key: "rich.trialEnd",
    source: "Your trial ends in <strong>{days} days</strong>; <link>upgrade now</link> to keep PulseGrid active.",
    category: "rich-text",
    component: "PricingBanner.tsx",
    intendedSense: null,
  },

  // === 6. Tight-width buttons, tabs & badges (6 items) ===
  {
    key: "tight.tabOverview",
    source: "Overview",
    category: "tight-ui",
    component: "HeaderNav.tsx",
    intendedSense: null,
  },
  {
    key: "tight.tabSettings",
    source: "Settings",
    category: "tight-ui",
    component: "HeaderNav.tsx",
    intendedSense: null,
  },
  {
    key: "tight.tabBilling",
    source: "Billing",
    category: "tight-ui",
    component: "HeaderNav.tsx",
    intendedSense: null,
  },
  {
    key: "tight.btnRefund",
    source: "Issue refund",
    category: "tight-ui",
    component: "InvoiceActions.tsx",
    intendedSense: null,
  },
  {
    key: "tight.btnFilters",
    source: "Clear filters",
    category: "tight-ui",
    component: "SortToolbar.tsx",
    intendedSense: null,
  },
  {
    key: "tight.badgeVerified",
    source: "Verified",
    category: "tight-ui",
    component: "WarrantyCard.tsx",
    intendedSense: null,
  },

  // === 7. General UI & multi-sentence copy (6 items) ===
  {
    key: "general.emptyInbox",
    source: "You are all caught up. New customer messages and payout notices will appear here.",
    category: "general",
    component: "InboxToolbar.tsx",
    intendedSense: null,
  },
  {
    key: "general.networkError",
    source: "We could not reach the payment gateway. Please check your connection and try again.",
    category: "general",
    component: "CheckoutSummary.tsx",
    intendedSense: null,
  },
  {
    key: "general.hoursSubtitle",
    source: "Mon–Fri 9:00 AM – 6:00 PM local time. Holiday hours may vary by branch.",
    category: "general",
    component: "StoreHoursCard.tsx",
    intendedSense: null,
  },
  {
    key: "general.batteryTip",
    source: "Place the card reader on its dock overnight to maintain full battery health.",
    category: "general",
    component: "DeviceBatteryStatus.tsx",
    intendedSense: null,
  },
  {
    key: "general.profileSaved",
    source: "Your account details have been updated across all active devices.",
    category: "general",
    component: "ProfileForm.tsx",
    intendedSense: null,
  },
  {
    key: "general.exportHint",
    source: "Exports include itemized taxes, refunds, and settlement timestamps in UTC.",
    category: "general",
    component: "DocsSidebar.tsx",
    intendedSense: null,
  },
];

function unflatten(flat) {
  const root = {};
  for (const [k, v] of Object.entries(flat)) {
    const parts = k.split(".");
    let cur = root;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!cur[parts[i]] || typeof cur[parts[i]] !== "object") cur[parts[i]] = {};
      cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = v;
  }
  return root;
}

const COMPONENTS = {
  "src/components/HeaderNav.tsx": `import { useTranslations } from "next-intl";

export function HeaderNav() {
  const brand = useTranslations("brand");
  const glossary = useTranslations("glossary");
  const tight = useTranslations("tight");
  return (
    <header className="flex items-center justify-between border-b px-4 py-3">
      <div>
        <h1>{brand("welcome")}</h1>
        <p>{glossary("workspaceCreate")}</p>
      </div>
      <nav role="tablist" className="flex gap-2">
        <button role="tab" className="w-24 truncate whitespace-nowrap overflow-hidden">{tight("tabOverview")}</button>
        <button role="tab" className="w-24 truncate whitespace-nowrap overflow-hidden">{tight("tabSettings")}</button>
        <button role="tab" className="w-24 truncate whitespace-nowrap overflow-hidden">{tight("tabBilling")}</button>
        <button className="whitespace-nowrap">{glossary("workspaceSwitch")}</button>
      </nav>
    </header>
  );
}
`,
  "src/components/StoreHoursCard.tsx": `import { useTranslations } from "next-intl";

/** Retail store business hours indicator ("Open" means currently open for business). */
export function StoreHoursCard() {
  const hours = useTranslations("hours");
  const general = useTranslations("general");
  return (
    <section data-section="store-hours">
      <span className="badge status-open">{hours("openBadge")}</span>
      <p>{general("hoursSubtitle")}</p>
    </section>
  );
}
`,
  "src/components/InvoiceActions.tsx": `import { useTranslations } from "next-intl";

/** Action buttons on a PDF invoice row ("Open" is the verb to open the document). */
export function InvoiceActions() {
  const invoice = useTranslations("invoice");
  const glossary = useTranslations("glossary");
  const brand = useTranslations("brand");
  const tight = useTranslations("tight");
  return (
    <div className="invoice-row-actions">
      <button type="button">{invoice("openAction")}</button>
      <button type="button">{glossary("invoiceDownload")}</button>
      <button type="button" className="w-28 truncate whitespace-nowrap overflow-hidden">{tight("btnRefund")}</button>
      <small>{brand("vaultSync")}</small>
    </div>
  );
}
`,
  "src/components/CommunityFeed.tsx": `import { useTranslations } from "next-intl";

/** Forum article card heading ("Post" is a noun: a forum post/entry). */
export function CommunityFeed() {
  const community = useTranslations("community");
  return (
    <article>
      <h2>{community("postHeading")}</h2>
    </article>
  );
}
`,
  "src/components/CommentComposer.tsx": `import { useTranslations } from "next-intl";

/** Reply form submit button ("Post" is the imperative verb to publish a reply). */
export function CommentComposer() {
  const composer = useTranslations("composer");
  return (
    <form>
      <textarea />
      <button type="submit">{composer("postAction")}</button>
    </form>
  );
}
`,
  "src/components/CheckoutSummary.tsx": `import { useTranslations } from "next-intl";

/** Shopping cart purchase order summary ("Order" is a commercial purchase order). */
export function CheckoutSummary({ count, status }: { count: number; status: string }) {
  const checkout = useTranslations("checkout");
  const brand = useTranslations("brand");
  const icu = useTranslations("icu");
  const rich = useTranslations("rich");
  const general = useTranslations("general");
  return (
    <section className="checkout-summary">
      <h2>{checkout("orderLabel")}</h2>
      <p>{icu("cartItems", { count })}</p>
      <p>{icu("orderPipeline", { status, count })}</p>
      <p>{rich.rich("shippingFast", { strong: (c) => <strong>{c}</strong> })}</p>
      <button type="button">{brand("payCta")}</button>
      <p role="alert">{general("networkError")}</p>
    </section>
  );
}
`,
  "src/components/SortToolbar.tsx": `import { useTranslations } from "next-intl";

/** List sorting dropdown label ("Order" means sort sequence ascending/descending). */
export function SortToolbar() {
  const catalog = useTranslations("catalog");
  const tight = useTranslations("tight");
  return (
    <div className="sort-toolbar">
      <label htmlFor="sort-order">{catalog("orderLabel")}</label>
      <select id="sort-order" />
      <button type="button" className="w-28 truncate whitespace-nowrap overflow-hidden">{tight("btnFilters")}</button>
    </div>
  );
}
`,
  "src/components/ModalHeader.tsx": `import { useTranslations } from "next-intl";

/** Dialog dismiss button ("Close" is the verb to close the modal). */
export function ModalHeader() {
  const modal = useTranslations("modal");
  const rich = useTranslations("rich");
  return (
    <div role="dialog">
      <button type="button" data-action="dismiss">{modal("closeButton")}</button>
      <p>{rich.rich("deleteWarn", { b: (c) => <b>{c}</b> })}</p>
    </div>
  );
}
`,
  "src/components/NearbyBranchCard.tsx": `import { useTranslations } from "next-intl";

/** Distance badge for a retail location 0.2 km away ("Close" means geographically nearby). */
export function NearbyBranchCard() {
  const branch = useTranslations("branch");
  return (
    <div className="branch-distance">
      <span className="distance-badge">{branch("closeBadge")}</span>
    </div>
  );
}
`,
  "src/components/PricingBanner.tsx": `import { useTranslations } from "next-intl";

/** Pricing tier card ("Free" means $0 / gratis subscription plan). */
export function PricingBanner({ count, days }: { count: number; days: number }) {
  const pricing = useTranslations("pricing");
  const glossary = useTranslations("glossary");
  const icu = useTranslations("icu");
  const rich = useTranslations("rich");
  return (
    <section className="pricing-tier">
      <span className="tier-price">{pricing("freeTag")}</span>
      <p>{glossary("seatLimit")}</p>
      <p>{icu("seatsRemaining", { count })}</p>
      <p>{rich.rich("trialEnd", { days, strong: (c) => <strong>{c}</strong>, link: (c) => <a href="/upgrade">{c}</a> })}</p>
    </section>
  );
}
`,
  "src/components/StorageQuota.tsx": `import { useTranslations } from "next-intl";

/** Disk usage meter showing 42 GB available ("Free" means unoccupied storage capacity). */
export function StorageQuota({ gbRemaining }: { gbRemaining: number }) {
  const storage = useTranslations("storage");
  const rich = useTranslations("rich");
  return (
    <section className="disk-quota">
      <meter value={58} max={100} />
      <span>{gbRemaining} {storage("freeTag")}</span>
      <p>{rich.rich("backupNotice", { b: (c) => <b>{c}</b>, codeTag: (c) => <code>{c}</code> })}</p>
    </section>
  );
}
`,
  "src/components/ProfileForm.tsx": `import { useTranslations } from "next-intl";

/** User settings form ("Save" is the verb to persist profile changes). */
export function ProfileForm({ role }: { role: string }) {
  const profile = useTranslations("profile");
  const glossary = useTranslations("glossary");
  const icu = useTranslations("icu");
  const general = useTranslations("general");
  return (
    <form className="profile-settings">
      <span>{icu("memberRole", { role })}</span>
      <p>{glossary("seatAssign")}</p>
      <button type="submit">{profile("saveButton")}</button>
      <p>{general("profileSaved")}</p>
    </form>
  );
}
`,
  "src/components/PromoBadge.tsx": `import { useTranslations } from "next-intl";

/** Annual discount badge ("Save" means save money / pay less). */
export function PromoBadge({ discount, minTotal }: { discount: number; minTotal: string }) {
  const promo = useTranslations("promo");
  const icu = useTranslations("icu");
  return (
    <aside className="discount-banner">
      <strong>{promo("saveLabel")} 20%</strong>
      <span>{icu("promoThreshold", { discount, minTotal })}</span>
    </aside>
  );
}
`,
  "src/components/WizardNav.tsx": `import { useTranslations } from "next-intl";

/** Multi-step setup wizard navigation ("Back" goes to the previous step). */
export function WizardNav() {
  const wizard = useTranslations("wizard");
  return (
    <nav className="wizard-steps">
      <button type="button">{wizard("backButton")}</button>
    </nav>
  );
}
`,
  "src/components/WarrantyCard.tsx": `import { useTranslations } from "next-intl";

/** Product guarantee box ("back" means guarantee / stand behind every purchase). */
export function WarrantyCard() {
  const warranty = useTranslations("warranty");
  const tight = useTranslations("tight");
  return (
    <section className="warranty-box">
      <span className="w-20 truncate whitespace-nowrap overflow-hidden">{tight("badgeVerified")}</span>
      <p>{warranty("backPromise")}</p>
    </section>
  );
}
`,
  "src/components/BillingStatement.tsx": `import { useTranslations } from "next-intl";

/** Monthly credit card statement table ("Charge" is a financial debit/fee). */
export function BillingStatement({ amount, date }: { amount: number; date: Date }) {
  const billing = useTranslations("billing");
  const brand = useTranslations("brand");
  const glossary = useTranslations("glossary");
  const icu = useTranslations("icu");
  const rich = useTranslations("rich");
  return (
    <section className="billing-statement">
      <h3>{billing("chargeHeading")}</h3>
      <p>{icu("totalDue", { amount })}</p>
      <p>{icu("renewalDate", { date })}</p>
      <p>{glossary("invoicePaid")}</p>
      <button type="button">{brand("auditExport")}</button>
      <p>{rich.rich("helpLink", { link: (c) => <a href="/help">{c}</a> })}</p>
    </section>
  );
}
`,
  "src/components/DeviceBatteryStatus.tsx": `import { useTranslations } from "next-intl";

/** POS card reader battery indicator ("Charge" means electrical battery level). */
export function DeviceBatteryStatus() {
  const device = useTranslations("device");
  const general = useTranslations("general");
  return (
    <section className="battery-status">
      <h3>{device("chargeHeading")}: 84%</h3>
      <p>{general("batteryTip")}</p>
    </section>
  );
}
`,
  "src/components/ContractFooter.tsx": `import { useTranslations } from "next-intl";

/** E-signature legal footer ("Sign" is the verb to sign an agreement). */
export function ContractFooter() {
  const contract = useTranslations("contract");
  const rich = useTranslations("rich");
  const brand = useTranslations("brand");
  return (
    <footer className="contract-footer">
      <p>{rich.rich("termsAccept", { link: (c) => <a href="/terms">{c}</a> })}</p>
      <button type="button">{contract("signAction")}</button>
      <small>{brand("footerNote")}</small>
    </footer>
  );
}
`,
  "src/components/StorefrontAlert.tsx": `import { useTranslations } from "next-intl";

/** In-store pickup instructions ("sign" is a physical placard/notice at the counter). */
export function StorefrontAlert() {
  const storefront = useTranslations("storefront");
  return (
    <div className="pickup-alert">
      <p>{storefront("signNotice")}</p>
    </div>
  );
}
`,
  "src/components/InboxToolbar.tsx": `import { useTranslations } from "next-intl";

/** Notification inbox toolbar ("Archive" is the verb to archive selected items). */
export function InboxToolbar({ count, actor, ticket, assignee }: { count: number; actor: string; ticket: string; assignee: string }) {
  const inbox = useTranslations("inbox");
  const icu = useTranslations("icu");
  const general = useTranslations("general");
  return (
    <section className="inbox-toolbar">
      <button type="button">{inbox("archiveAction")}</button>
      <span>{icu("unreadAlerts", { count })}</span>
      <p>{icu("ticketAssign", { actor, ticket, assignee })}</p>
      <p>{general("emptyInbox")}</p>
    </section>
  );
}
`,
  "src/components/DocsSidebar.tsx": `import { useTranslations } from "next-intl";

/** Documentation sidebar navigation ("Archive" is the noun for historical release notes). */
export function DocsSidebar() {
  const docs = useTranslations("docs");
  const general = useTranslations("general");
  return (
    <aside className="docs-sidebar">
      <h3>{docs("archiveHeading")}</h3>
      <p>{general("exportHint")}</p>
    </aside>
  );
}
`,
  "src/components/AnalyticsPanel.tsx": `import { useTranslations } from "next-intl";

export function AnalyticsPanel({ rank }: { rank: number }) {
  const brand = useTranslations("brand");
  const icu = useTranslations("icu");
  return (
    <section className="analytics-panel">
      <p>{brand("analyticsDesc")}</p>
      <p>{icu("rankOrdinal", { rank })}</p>
    </section>
  );
}
`,
};

/**
 * Render the pilot synthetic UI into standalone HTML for Playwright visual overflow/clipping QA.
 * Uses the exact same tight-width constraints (`w-24 = 96px`, `w-28 = 112px`, `w-20 = 80px`,
 * `overflow: hidden; white-space: nowrap; text-overflow: ellipsis`) declared in the TSX components!
 */
export function renderPilotAppHtml(locale, flatMessages) {
  const t = (k) =>
    String(flatMessages[k] ?? `[MISSING:${k}]`)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  const dir = locale.startsWith("ar") ? "rtl" : "ltr";

  return `<!doctype html>
<html lang="${locale}" dir="${dir}">
<head>
<meta charset="utf-8" />
<title>${t("brand.welcome")}</title>
<style>
  * { box-sizing: border-box; font-family: system-ui, -apple-system, sans-serif; }
  body { margin: 0; padding: 16px; background: #f8fafc; color: #0f172a; }
  header { display: flex; align-items: center; justify-content: space-between; gap: 12px; border-bottom: 1px solid #cbd5e1; padding-bottom: 12px; }
  nav[role="tablist"] { display: flex; gap: 8px; }
  .tab-item { width: 96px; padding: 6px 8px; border: 1px solid #94a3b8; border-radius: 6px; background: #fff; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; text-align: center; font-size: 13px; }
  .tight-btn { width: 112px; padding: 6px 8px; border: 1px solid #334155; border-radius: 6px; background: #1e293b; color: #fff; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 13px; }
  .badge { display: inline-block; width: 80px; padding: 3px 6px; border-radius: 999px; background: #dcfce7; color: #166534; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; text-align: center; font-size: 12px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; margin-top: 16px; }
  section { background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  h2, h3 { font-size: 15px; margin: 0 0 8px; }
  p { font-size: 13px; line-height: 1.4; margin: 6px 0; }
  .btn { padding: 6px 12px; border: 1px solid #94a3b8; border-radius: 6px; background: #fff; font-size: 13px; }
</style>
</head>
<body>
  <header>
    <div>
      <h1>${t("brand.welcome")}</h1>
      <p>${t("glossary.workspaceCreate")}</p>
    </div>
    <nav role="tablist">
      <button role="tab" class="tab-item" data-testid="tab-overview">${t("tight.tabOverview")}</button>
      <button role="tab" class="tab-item" data-testid="tab-settings">${t("tight.tabSettings")}</button>
      <button role="tab" class="tab-item" data-testid="tab-billing">${t("tight.tabBilling")}</button>
      <button class="btn" data-testid="btn-switch">${t("glossary.workspaceSwitch")}</button>
    </nav>
  </header>
  <main class="grid">
    <section>
      <h2>${t("checkout.orderLabel")}</h2>
      <p>${t("icu.cartItems")}</p>
      <p>${t("rich.shippingFast")}</p>
      <button class="btn">${t("brand.payCta")}</button>
    </section>
    <section>
      <h2>${t("billing.chargeHeading")}</h2>
      <p>${t("icu.totalDue")}</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn">${t("invoice.openAction")}</button>
        <button class="tight-btn" data-testid="btn-refund">${t("tight.btnRefund")}</button>
      </div>
      <p>${t("glossary.invoicePaid")}</p>
    </section>
    <section>
      <h2>${t("catalog.orderLabel")}</h2>
      <button class="tight-btn" data-testid="btn-filters">${t("tight.btnFilters")}</button>
      <p><span class="badge" data-testid="badge-verified">${t("tight.badgeVerified")}</span> ${t("warranty.backPromise")}</p>
    </section>
    <section>
      <h2>${t("hours.openBadge")} / ${t("branch.closeBadge")}</h2>
      <p>${t("general.hoursSubtitle")}</p>
      <p>${t("storefront.signNotice")}</p>
    </section>
    <section>
      <h2>${t("pricing.freeTag")} / ${t("storage.freeTag")}</h2>
      <p>${t("glossary.seatLimit")}</p>
      <p>${t("promo.saveLabel")} — ${t("icu.promoThreshold")}</p>
    </section>
    <section>
      <h2>${t("device.chargeHeading")} / ${t("docs.archiveHeading")}</h2>
      <p>${t("general.batteryTip")}</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn">${t("profile.saveButton")}</button>
        <button class="btn">${t("wizard.backButton")}</button>
        <button class="btn">${t("modal.closeButton")}</button>
        <button class="btn">${t("inbox.archiveAction")}</button>
        <button class="btn">${t("contract.signAction")}</button>
        <button class="btn">${t("composer.postAction")}</button>
      </div>
    </section>
  </main>
</body>
</html>`;
}

export function buildPilotApp() {
  fs.mkdirSync(path.join(PILOT_APP_DIR, "messages"), { recursive: true });
  fs.mkdirSync(path.join(PILOT_APP_DIR, "src", "components"), { recursive: true });

  fs.writeFileSync(
    path.join(PILOT_APP_DIR, "package.json"),
    JSON.stringify(
      {
        name: "northstar-commerce-pilot",
        version: "0.1.0",
        private: true,
        dependencies: {
          next: "15.1.0",
          react: "19.0.0",
          "react-dom": "19.0.0",
          "next-intl": "4.0.0",
        },
      },
      null,
      2
    ) + "\n"
  );

  const flatEn = {};
  for (const item of PILOT_ITEMS) flatEn[item.key] = item.source;
  fs.writeFileSync(
    path.join(PILOT_APP_DIR, "messages", "en.json"),
    JSON.stringify(unflatten(flatEn), null, 2) + "\n"
  );

  for (const [rel, code] of Object.entries(COMPONENTS)) {
    const abs = path.join(PILOT_APP_DIR, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, code, "utf8");
  }

  fs.writeFileSync(
    path.join(PILOT_APP_DIR, "challenge-labels.json"),
    JSON.stringify({ items: PILOT_ITEMS, glossary: PILOT_GLOSSARY }, null, 2) + "\n"
  );

  return {
    appDir: PILOT_APP_DIR,
    itemCount: PILOT_ITEMS.length,
    flatEn,
    components: COMPONENTS,
    glossary: PILOT_GLOSSARY,
  };
}
