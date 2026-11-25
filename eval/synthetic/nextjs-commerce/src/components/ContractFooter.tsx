import { useTranslations } from "next-intl";

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
