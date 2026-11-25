import { useTranslations } from "next-intl";

/** POS card reader battery indicator ("Charge" means electrical battery level). */
export function DeviceBatteryStatus() {
  const device = useTranslations("device");
  const general = useTranslations("general");
  return (
    <section className="battery-status">
      <h3>{device("chargeHeading")}: 84%</h3>
      <p>{general("batteryTip")}</p>
    </section>
  );
}
