import { useTranslations } from "next-intl";

/** Distance badge for a retail location 0.2 km away ("Close" means geographically nearby). */
export function NearbyBranchCard() {
  const branch = useTranslations("branch");
  return (
    <div className="branch-distance">
      <span className="distance-badge">{branch("closeBadge")}</span>
    </div>
  );
}
