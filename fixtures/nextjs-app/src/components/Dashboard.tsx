import { useTranslations } from "next-intl";

declare const toast: { success: (msg: string) => void };

export function Dashboard({ count, userName, role }: { count: number; userName: string; role: string }) {
  const t = useTranslations("home");
  const feed = useTranslations("feed");

  const summary = "You have " + count + " pending reviews";
  const greeting = `Hello ${userName}, ready to ship?`;

  function handleSave() {
    toast.success("Changes saved successfully");
  }

  return (
    <main className="flex flex-col gap-4 p-6">
      <h1>{t("title")}</h1>
      <p>{t("subtitle")}</p>
      <p>{t("items", { count })}</p>
      <span>{t("roleBadge", { role, count })}</span>
      <section>
        <h2>{feed("postHeading")}</h2>
        <button aria-label="Close notification banner" onClick={handleSave}>
          Save settings
        </button>
        <input placeholder="Search your workspace" title="Workspace search box" />
        <button>{feed("postAction")}</button>
        <button>{feed("openMenu")}</button>
      </section>
      <p>{summary}</p>
      <p>{greeting}</p>
    </main>
  );
}
