import { useTranslations } from "next-intl";

/** Action buttons on a PDF invoice row ("Open" is the verb to open the document). */
export function InvoiceActions() {
  const invoice = useTranslations("invoice");
  const glossary = useTranslations("glossary");
  const brand = useTranslations("brand");
  const tight = useTranslations("tight");
  return (
    <div className="invoice-row-actions">
      <button type="button">{invoice("openAction")}</button>
      <button type="button">{glossary("invoiceDownload")}</button>
      <button type="button" className="w-28 truncate whitespace-nowrap overflow-hidden">{tight("btnRefund")}</button>
      <small>{brand("vaultSync")}</small>
    </div>
  );
}
