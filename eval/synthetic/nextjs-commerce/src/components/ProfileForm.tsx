import { useTranslations } from "next-intl";

/** User settings form ("Save" is the verb to persist profile changes). */
export function ProfileForm({ role }: { role: string }) {
  const profile = useTranslations("profile");
  const glossary = useTranslations("glossary");
  const icu = useTranslations("icu");
  const general = useTranslations("general");
  return (
    <form className="profile-settings">
      <span>{icu("memberRole", { role })}</span>
      <p>{glossary("seatAssign")}</p>
      <button type="submit">{profile("saveButton")}</button>
      <p>{general("profileSaved")}</p>
    </form>
  );
}
