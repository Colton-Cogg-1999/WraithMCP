import { useTranslations } from "next-intl";

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
