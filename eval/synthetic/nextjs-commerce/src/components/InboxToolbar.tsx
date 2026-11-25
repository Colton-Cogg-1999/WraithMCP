import { useTranslations } from "next-intl";

/** Notification inbox toolbar ("Archive" is the verb to archive selected items). */
export function InboxToolbar({ count, actor, ticket, assignee }: { count: number; actor: string; ticket: string; assignee: string }) {
  const inbox = useTranslations("inbox");
  const icu = useTranslations("icu");
  const general = useTranslations("general");
  return (
    <section className="inbox-toolbar">
      <button type="button">{inbox("archiveAction")}</button>
      <span>{icu("unreadAlerts", { count })}</span>
      <p>{icu("ticketAssign", { actor, ticket, assignee })}</p>
      <p>{general("emptyInbox")}</p>
    </section>
  );
}
