import type { View } from "./types";

/**
 * Live-refresh bookkeeping for the app shell. Server events mark resources
 * stale; a flush then refetches only what the visible view renders, and the
 * rest stays stale until a view that needs it is shown.
 */
export type LiveResource =
  /** GET /api/dashboard: overview listings, stats, watches and connectors. */
  | "dashboard"
  /** The connector rows alone (GET /api/connectors on the Connectors view). */
  | "connectors"
  /** Watch names and settings, which Analytics and Watches read from the dashboard. */
  | "watchList"
  | "listings"
  | "analytics"
  | "market";

export const allLiveResources: readonly LiveResource[] = ["dashboard", "connectors", "watchList", "listings", "analytics", "market"];

/** Everything a dashboard response refreshes. */
export const dashboardResources: readonly LiveResource[] = ["dashboard", "connectors", "watchList"];

/**
 * What each server event makes stale. `ai-description-verification` is absent
 * on purpose: verification columns are not part of any list payload, and the
 * scan that runs verification emits `scan` afterwards anyway. `log` belongs to
 * LogsPage and `search` to SearchPage.
 */
export const eventResources: Readonly<Record<string, readonly LiveResource[]>> = {
  scan: ["dashboard", "connectors", "listings", "analytics"],
  watch: ["dashboard", "connectors", "watchList", "listings", "analytics"],
  // Notifications only record connector runs.
  notification: ["dashboard", "connectors"],
  // Analytics counts ordinary watch scans only, so research scans leave it alone.
  "market-watch": ["market"],
  "listing-action": ["dashboard", "listings", "analytics"],
};

/** Pages that fetch their own data on mount and refetch when their refresh key changes. */
const pageResources = { listings: "listings", analytics: "analytics", "market-research": "market" } as const;

export type FlushPlan = {
  /** Fetch GET /api/dashboard. */
  dashboard: boolean;
  /** Fetch GET /api/connectors and merge it into the dashboard data. */
  connectors: boolean;
  /** Bump the mounted page's refresh key. */
  page: "listings" | "analytics" | "market" | null;
  /** Flags to clear now: whatever is fetched, plus page flags of unmounted pages. */
  clear: LiveResource[];
};

/**
 * Decide what a flush fetches for the visible view. `dashboardLoaded` is false
 * until the first dashboard response; `dashboardInFlight` defers a dashboard
 * refetch (the shared GET transport would hand back the in-flight response).
 */
export function planFlush(view: View, dirty: ReadonlySet<LiveResource>, dashboardLoaded: boolean, dashboardInFlight: boolean): FlushPlan {
  const clear: LiveResource[] = [];
  const needsDashboard =
    view === "overview" ||
    // Analytics lists watch names; Watches shows the dashboard's watches until its own list arrives.
    ((view === "analytics" || view === "watches") && (!dashboardLoaded || (view === "analytics" && dirty.has("watchList"))));
  const dashboard = needsDashboard && dirty.has("dashboard") && !dashboardInFlight;
  if (dashboard) clear.push(...dashboardResources);
  const connectors = view === "connectors" && dirty.has("connectors");
  if (connectors) clear.push("connectors");
  let page: FlushPlan["page"] = null;
  for (const [pageView, resource] of Object.entries(pageResources) as Array<[View, FlushPlan["page"] & LiveResource]>) {
    if (!dirty.has(resource)) continue;
    // An unmounted page fetches fresh data when it mounts.
    clear.push(resource);
    if (pageView === view) page = resource;
  }
  return { dashboard, connectors, page, clear };
}
