import { useTranslations } from "next-intl";

/** Forum article card heading ("Post" is a noun: a forum post/entry). */
export function CommunityFeed() {
  const community = useTranslations("community");
  return (
    <article>
      <h2>{community("postHeading")}</h2>
    </article>
  );
}
