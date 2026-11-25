import { useTranslations } from "next-intl";

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
