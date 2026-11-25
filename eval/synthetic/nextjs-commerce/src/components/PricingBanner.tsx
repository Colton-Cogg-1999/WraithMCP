import { useTranslations } from "next-intl";

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
