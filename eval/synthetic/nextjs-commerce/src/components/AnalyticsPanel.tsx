import { useTranslations } from "next-intl";

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
