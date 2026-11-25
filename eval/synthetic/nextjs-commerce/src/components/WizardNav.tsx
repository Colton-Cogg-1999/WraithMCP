import { useTranslations } from "next-intl";

/** Multi-step setup wizard navigation ("Back" goes to the previous step). */
export function WizardNav() {
  const wizard = useTranslations("wizard");
  return (
    <nav className="wizard-steps">
      <button type="button">{wizard("backButton")}</button>
    </nav>
  );
}
