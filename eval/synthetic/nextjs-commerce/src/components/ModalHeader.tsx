import { useTranslations } from "next-intl";

/** Dialog dismiss button ("Close" is the verb to close the modal). */
export function ModalHeader() {
  const modal = useTranslations("modal");
  const rich = useTranslations("rich");
  return (
    <div role="dialog">
      <button type="button" data-action="dismiss">{modal("closeButton")}</button>
      <p>{rich.rich("deleteWarn", { b: (c) => <b>{c}</b> })}</p>
    </div>
  );
}
