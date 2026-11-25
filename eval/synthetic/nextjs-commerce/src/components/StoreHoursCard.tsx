import { useTranslations } from "next-intl";

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
