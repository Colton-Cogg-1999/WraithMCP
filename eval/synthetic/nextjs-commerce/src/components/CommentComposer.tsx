import { useTranslations } from "next-intl";

/** Reply form submit button ("Post" is the imperative verb to publish a reply). */
export function CommentComposer() {
  const composer = useTranslations("composer");
  return (
    <form>
      <textarea />
      <button type="submit">{composer("postAction")}</button>
    </form>
  );
}
