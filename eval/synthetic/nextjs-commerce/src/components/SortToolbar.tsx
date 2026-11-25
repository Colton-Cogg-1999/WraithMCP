import { useTranslations } from "next-intl";

/** List sorting dropdown label ("Order" means sort sequence ascending/descending). */
export function SortToolbar() {
  const catalog = useTranslations("catalog");
  const tight = useTranslations("tight");
  return (
    <div className="sort-toolbar">
      <label htmlFor="sort-order">{catalog("orderLabel")}</label>
      <select id="sort-order" />
      <button type="button" className="w-28 truncate whitespace-nowrap overflow-hidden">{tight("btnFilters")}</button>
    </div>
  );
}
