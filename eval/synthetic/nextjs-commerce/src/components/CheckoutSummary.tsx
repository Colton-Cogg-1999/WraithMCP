import { useTranslations } from "next-intl";

/** Shopping cart purchase order summary ("Order" is a commercial purchase order). */
export function CheckoutSummary({ count, status }: { count: number; status: string }) {
  const checkout = useTranslations("checkout");
  const brand = useTranslations("brand");
  const icu = useTranslations("icu");
  const rich = useTranslations("rich");
  const general = useTranslations("general");
  return (
    <section className="checkout-summary">
      <h2>{checkout("orderLabel")}</h2>
      <p>{icu("cartItems", { count })}</p>
      <p>{icu("orderPipeline", { status, count })}</p>
      <p>{rich.rich("shippingFast", { strong: (c) => <strong>{c}</strong> })}</p>
      <button type="button">{brand("payCta")}</button>
      <p role="alert">{general("networkError")}</p>
    </section>
  );
}
