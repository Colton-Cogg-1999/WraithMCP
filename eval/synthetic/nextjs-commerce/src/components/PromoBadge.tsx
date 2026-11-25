import { useTranslations } from "next-intl";

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
