import { useState } from "react";

const NAV_TABS = ["Deployments", "Environment variables", "Billing overview"] as const;

export function StudioDashboard({ activeCount, region }: { activeCount: number; region: string }) {
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [selectedRegion, setSelectedRegion] = useState("us-west-2");
  const statusBanner = activeCount > 0 ? "All systems operational" : "Last deployed 4 minutes ago";

  return (
    <main className="flex items-center gap-2">
      <header>
        <img src="/mark.svg" alt="Company brand mark" />
        <h1>Northstar Studio</h1>
        <button type="button" onClick={() => setStatusMsg("Deployment succeeded")}>Create project</button>
        <button type="button" onClick={() => setStatusMsg("Unable to connect to build runner")}>Import repository</button>
      </header>
      <nav>
        {NAV_TABS.map((tab) => <a key={tab} href="#">{tab}</a>)}
      </nav>
      <section>
        <input type="search" placeholder="Search projects..." aria-label="Filter by region" />
        <p>{statusBanner}</p>
        <p>You have {activeCount} active builds</p>
        <span>Production branch</span>
        <span>Preview builds enabled</span>
        {statusMsg && <div role="status">{statusMsg}</div>}
      </section>
      <section>
        <h2>Confirm deletion</h2>
        <Field label="Enter your workspace slug" hint="Must be lowercase letters and numbers" />
        <button type="button">Delete workspace</button>
      </section>
      <footer>
        <p>Upgrade to unlock unlimited seats</p>
        <a href="https://status.northstar.example">Contact sales</a>
        <a href="/docs">Read the documentation</a>
      </footer>
    </main>
  );
}
declare const Field: any;
