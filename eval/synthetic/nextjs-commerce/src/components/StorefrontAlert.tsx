import { useTranslations } from "next-intl";

/** In-store pickup instructions ("sign" is a physical placard/notice at the counter). */
export function StorefrontAlert() {
  const storefront = useTranslations("storefront");
  return (
    <div className="pickup-alert">
      <p>{storefront("signNotice")}</p>
    </div>
  );
}
