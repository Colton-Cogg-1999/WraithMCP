import { useTranslations } from "next-intl";

export function HeaderNav() {
  const brand = useTranslations("brand");
  const glossary = useTranslations("glossary");
  const tight = useTranslations("tight");
  return (
    <header className="flex items-center justify-between border-b px-4 py-3">
      <div>
        <h1>{brand("welcome")}</h1>
        <p>{glossary("workspaceCreate")}</p>
      </div>
      <nav role="tablist" className="flex gap-2">
        <button role="tab" className="w-24 truncate whitespace-nowrap overflow-hidden">{tight("tabOverview")}</button>
        <button role="tab" className="w-24 truncate whitespace-nowrap overflow-hidden">{tight("tabSettings")}</button>
        <button role="tab" className="w-24 truncate whitespace-nowrap overflow-hidden">{tight("tabBilling")}</button>
        <button className="whitespace-nowrap">{glossary("workspaceSwitch")}</button>
      </nav>
    </header>
  );
}
