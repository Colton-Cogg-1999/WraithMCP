import { useTranslations } from "next-intl";

/** Disk usage meter showing 42 GB available ("Free" means unoccupied storage capacity). */
export function StorageQuota({ gbRemaining }: { gbRemaining: number }) {
  const storage = useTranslations("storage");
  const rich = useTranslations("rich");
  return (
    <section className="disk-quota">
      <meter value={58} max={100} />
      <span>{gbRemaining} {storage("freeTag")}</span>
      <p>{rich.rich("backupNotice", { b: (c) => <b>{c}</b>, codeTag: (c) => <code>{c}</code> })}</p>
    </section>
  );
}
