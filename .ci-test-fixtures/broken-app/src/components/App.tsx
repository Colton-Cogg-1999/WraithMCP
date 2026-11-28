import { useTranslation } from "react-i18next";
export function App({ user }: { user: string }) {
  const { t } = useTranslation("common");
  return <div><h1>{t("welcome", { user })}</h1><p>{t("brand")}</p><p>Hardcoded untranslated banner text</p></div>;
}
