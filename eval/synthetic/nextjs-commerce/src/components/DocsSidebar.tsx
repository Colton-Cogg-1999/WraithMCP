import { useTranslations } from "next-intl";

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
