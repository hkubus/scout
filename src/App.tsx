import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ComponentProps, type ComponentType, type FormEvent } from "react";
import {
  AlertTriangle,
  ArrowRight,
  BarChart3,
  Bell,
  CheckCircle2,
  Info,
  LoaderCircle,
  LogIn,
  LogOut,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  Tag,
  Wallet,
  WifiOff,
} from "lucide-react";
import { api, ApiError, forgetInFlightGets, UNAUTHORIZED_EVENT, type AuthSession } from "./api";
import { emptyDashboard } from "./data";
import { reconnectPending, subscribe, subscribeStatus, type StreamStatus } from "./events";
import { isListingActionEvent, patchListingRows } from "./listingActions";
import { reuseUnchangedListings } from "./listingRows";
import { allLiveResources, dashboardResources, eventResources, planFlush, streamDecidesConnection, type LiveResource } from "./liveRefresh";
import ListingTable from "./ListingTable";
import type { ListingsPreset } from "./ListingsPage";
import type { WatchPreset } from "./presets";
import type {
  DashboardData,
  Listing,
  Marketplace,
  Theme,
  View,
  Watch,
} from "./types";
import { PageHeader, SelectControl } from "./ui";

/**
 * Six sections, mirroring the iOS tabs. A section with several pages shows
 * them as tabs; each page keeps its own URL.
 */
const navSections: Array<{ label: string; icon: typeof Tag; views: Array<{ id: View; label: string }> }> = [
  { label: "Deals", icon: Tag, views: [{ id: "overview", label: "Top deals" }, { id: "listings", label: "All listings" }] },
  { label: "Search", icon: Search, views: [{ id: "search", label: "Search" }] },
  { label: "Watches", icon: Bell, views: [{ id: "watches", label: "Watches" }] },
  { label: "Market", icon: BarChart3, views: [{ id: "market-research", label: "Research" }, { id: "analytics", label: "Analytics" }] },
  { label: "Flips", icon: Wallet, views: [{ id: "flips", label: "Flips" }] },
  { label: "System", icon: Settings2, views: [{ id: "settings", label: "Settings" }, { id: "connectors", label: "Connectors" }, { id: "logs", label: "Logs" }] },
];
const sectionFor = (view: View) => navSections.find((section) => section.views.some((item) => item.id === view)) ?? navSections[0];

/** The shell's one phone breakpoint; styles.css uses the same width. */
const MOBILE_SHELL_QUERY = "(max-width: 800px)";

/**
 * React.lazy suspends on its first render even when the chunk is already
 * loaded, and React then holds the reveal ~300 ms after the fallback. Once
 * preload() has resolved, this renders the module's component directly, so a
 * preloaded route, drawer or dialog mounts in the same commit. The type is
 * pinned per mounted instance: switching a mounted Lazy to the loaded
 * component would remount it and lose its state.
 */
function lazyWithPreload<C extends ComponentType<any>>(loader: () => Promise<{ default: C }>) {
  let Loaded: C | null = null;
  let pending: Promise<{ default: C }> | null = null;
  const preload = () => {
    pending ??= loader().then((module) => {
      Loaded = module.default;
      return module;
    });
    // A failed chunk load can be retried by the next preload or render.
    pending.catch(() => { pending = null; });
    return pending;
  };
  const Lazy = lazy(preload);
  function Preloadable(props: ComponentProps<C>) {
    const [Impl] = useState(() => (Loaded ?? Lazy) as ComponentType<ComponentProps<C>>);
    return <Impl {...props} />;
  }
  return Object.assign(Preloadable, { preload });
}

const LazyMarketResearchPage = lazyWithPreload(() => import("./MarketResearchPage"));
const LazyAnalyticsPage = lazyWithPreload(() => import("./AnalyticsPage"));
const LazySettingsPage = lazyWithPreload(() => import("./SettingsPage"));
const LazyConnectorsPage = lazyWithPreload(() => import("./ConnectorsPage"));
const LazyLogsPage = lazyWithPreload(() => import("./LogsPage"));
const LazySearchPage = lazyWithPreload(() => import("./SearchPage"));
const LazyListingsPage = lazyWithPreload(() => import("./ListingsPage"));
const LazyFlipsPage = lazyWithPreload(() => import("./FlipsPage"));
const LazyListingDetailDrawer = lazyWithPreload(() => import("./ListingDetailDrawer"));
const loadWatchesPage = () => import("./WatchesPage");
const LazyWatchesPage = lazyWithPreload(loadWatchesPage);
const LazyWatchAnalyticsDialog = lazyWithPreload(() => loadWatchesPage().then((module) => ({ default: module.WatchAnalyticsDialog })));
const loadDialogs = () => import("./Dialogs");
const LazyWatchDialog = lazyWithPreload(() => loadDialogs().then((module) => ({ default: module.WatchDialog })));
const LazyHistoryDialog = lazyWithPreload(() => loadDialogs().then((module) => ({ default: module.HistoryDialog })));

const routePages: Partial<Record<View, { preload: () => Promise<unknown> }>> = {
  search: LazySearchPage,
  watches: LazyWatchesPage,
  "market-research": LazyMarketResearchPage,
  analytics: LazyAnalyticsPage,
  listings: LazyListingsPage,
  flips: LazyFlipsPage,
  connectors: LazyConnectorsPage,
  logs: LazyLogsPage,
  settings: LazySettingsPage,
};

const preloadView = (view: View) => {
  void routePages[view]?.preload().catch(() => {});
};

/**
 * Fetch every remaining route, drawer and dialog chunk once the browser is
 * idle after `delayMs` (skipped on Save-Data), so they do not compete with
 * the first view's own data request.
 */
let idlePreloadScheduled = false;
function preloadRestWhenIdle(delayMs: number) {
  if (idlePreloadScheduled) return;
  idlePreloadScheduled = true;
  if ((navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData) return;
  const run = () => {
    for (const component of [...Object.values(routePages), LazyListingDetailDrawer, LazyWatchAnalyticsDialog, LazyWatchDialog, LazyHistoryDialog]) {
      void component?.preload().catch(() => {});
    }
  };
  window.setTimeout(() => {
    if (typeof window.requestIdleCallback === "function") window.requestIdleCallback(run, { timeout: 3000 });
    else run();
  }, delayMs);
}

function viewFromLocation(): View {
  const raw = window.location.pathname.split(/[?#]/)[0].replace(/\/+$/, "").replace(/^\//, "") as View;
  return navSections.some((section) => section.views.some((item) => item.id === raw)) ? raw : "overview";
}

const initialView = viewFromLocation();
/** Whether the first view renders the dashboard (see planFlush). */
const initialViewNeedsDashboard = planFlush(initialView, new Set(allLiveResources), false, false).dashboard;
// A deep-linked route's chunk loads alongside the session check, so it mounts without suspending.
preloadView(initialView);

// Boot requests start with the module, in parallel: the session check and,
// when the first view shows it, the dashboard. ScoutApp's first refresh takes
// the dashboard promise exactly once (in flight or already settled). A 401 on
// a signed-out load is ignored while the session check decides (see App).
// A tab opened in the background skips the dashboard: it could be shown hours
// later, and a hidden tab fetches when it is shown.
const bootSession = api.authSession();
bootSession.catch(() => {});
let bootDashboard: Promise<DashboardData> | null = initialViewNeedsDashboard && !document.hidden ? api.dashboard() : null;
bootDashboard?.catch(() => {});
function takeBootDashboard() {
  const pending = bootDashboard;
  bootDashboard = null;
  return pending;
}

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "Something went wrong";
type Toast = { message: string; type: "success" | "error" | "info" };

function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => {
    const requested = new URLSearchParams(window.location.search).get("theme");
    if (requested === "light" || requested === "dark" || requested === "system")
      return requested;
    return (localStorage.getItem("scout-theme") as Theme | null) ?? "light";
  });
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const resolved =
        theme === "system" ? (media.matches ? "dark" : "light") : theme;
      document.documentElement.dataset.theme = resolved;
      document.documentElement.style.colorScheme = resolved;
    };
    apply();
    if (theme === "system") media.addEventListener("change", apply);
    localStorage.setItem("scout-theme", theme);
    return () => media.removeEventListener("change", apply);
  }, [theme]);
  return { theme, setTheme };
}

function App() {
  const [auth, setAuth] = useState<"checking" | "login" | "ready">("checking");
  const [session, setSession] = useState<AuthSession | null>(null);
  useEffect(() => {
    let active = true;
    bootSession.then((value) => {
      if (!active) return;
      setSession(value);
      setAuth(value.authenticated ? "ready" : "login");
    }).catch(() => {
      // Unreachable server: render the app so it shows its offline state.
      if (active) setAuth("ready");
    });
    // The session check decides the first screen; a boot prefetch's 401 must not pre-empt it.
    const onUnauthorized = () => setAuth((current) => (current === "checking" ? current : "login"));
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => {
      active = false;
      window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    };
  }, []);
  if (auth === "checking") return null;
  if (auth === "login") return <LoginScreen passwordLogin={session?.passwordLogin ?? true} tokenLogin={session?.tokenLogin ?? false} />;
  const logout = session?.authEnabled && (session.passwordLogin || session.tokenLogin)
    ? () => { void api.logout().finally(() => window.location.reload()); }
    : null;
  return <ScoutApp onLogout={logout} />;
}

function LoginScreen({ passwordLogin, tokenLogin }: { passwordLogin: boolean; tokenLogin: boolean }) {
  useTheme();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await api.login(password);
      // Reload so live events and every cached request start under the new session.
      window.location.reload();
    } catch (reason) {
      setError(errorMessage(reason));
      setSubmitting(false);
    }
  };
  return (
    <main className="login-shell">
      <form className="login-card" onSubmit={submit}>
        <div className="brand-row">
          <div className="brand-mark" aria-hidden="true">
            <Search size={24} strokeWidth={2.7} />
            <span />
          </div>
          <span className="brand-name">Scout</span>
        </div>
        {passwordLogin || tokenLogin ? (
          <>
            <label className="field-label">
              <span>{passwordLogin && tokenLogin ? "Password or API token" : passwordLogin ? "Password" : "API token"}</span>
              <input
                type="password"
                autoComplete="current-password"
                autoFocus
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>
            {error ? <p className="login-error" role="alert">{error}</p> : null}
            <button className="primary-button" type="submit" disabled={submitting || !password}>
              {submitting ? <LoaderCircle size={18} className="spin" /> : <LogIn size={18} />}
              Sign in
            </button>
          </>
        ) : (
          <p className="login-error" role="alert">
            Sign-in is not configured. Set SCOUT_PASSWORD_HASH or SCOUT_API_TOKENS on the server.
          </p>
        )}
      </form>
    </main>
  );
}

function ScoutApp({ onLogout }: { onLogout: (() => void) | null }) {
  const { theme, setTheme } = useTheme();
  const [view, setView] = useState<View>(() => viewFromLocation());
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [data, setData] = useState<DashboardData>(emptyDashboard);
  const [isLoading, setIsLoading] = useState(true);
  const [connection, setConnection] = useState<
    "loading" | "online" | "offline"
  >("loading");
  const [showWatchDialog, setShowWatchDialog] = useState(false);
  const [watchPreset, setWatchPreset] = useState<WatchPreset | null>(null);
  const [editingFullWatch, setEditingFullWatch] = useState<Watch | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [marketRefreshKey, setMarketRefreshKey] = useState(0);
  const [analyticsRefreshKey, setAnalyticsRefreshKey] = useState(0);
  const [listingsRefreshKey, setListingsRefreshKey] = useState(0);
  // Remounts Listings with these filters whenever another page opens it.
  const [listingsPreset, setListingsPreset] = useState<{ key: number; filters: ListingsPreset }>({ key: 0, filters: {} });
  const [analyticsWatch, setAnalyticsWatch] = useState<Watch | null>(null);
  const [selectedListing, setSelectedListing] = useState<Listing | null>(null);
  const [busyWatchIds, setBusyWatchIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [scanning, setScanning] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const [allWatches, setAllWatches] = useState<Watch[] | null>(null);
  const [watchRefreshKey, setWatchRefreshKey] = useState(0);
  const refreshSequence = useRef(0);

  const notify = useCallback(
    (message: string, type: Toast["type"] = "success") =>
      setToast({ message, type }),
    [],
  );
  // Live refresh (see liveRefresh.ts): server events only mark resources
  // stale in refs, so they do not re-render the app by themselves. flush()
  // refetches what the visible view shows and leaves the rest stale until a
  // view that needs it is shown; hidden tabs wait until they are visible.
  const viewRef = useRef(view);
  const dirty = useRef(new Set<LiveResource>(allLiveResources));
  const dashboardLoaded = useRef(false);
  const dashboardFetches = useRef(0);
  const connectorsSequence = useRef(0);
  const streamStatus = useRef<StreamStatus | null>(null);
  const flushTimer = useRef<number | null>(null);
  const flushRef = useRef<() => Promise<void>>(async () => {});
  const scheduleFlush = useCallback(() => {
    if (flushTimer.current !== null) return;
    flushTimer.current = window.setTimeout(() => {
      flushTimer.current = null;
      void flushRef.current();
    }, 100);
  }, []);
  const refreshData = useCallback(
    async (showLoader = false) => {
      const sequence = ++refreshSequence.current;
      for (const resource of dashboardResources) dirty.current.delete(resource);
      dashboardFetches.current += 1;
      if (showLoader) setIsLoading(true);
      const boot = takeBootDashboard();
      try {
        const next = await (boot ?? api.dashboard());
        if (sequence !== refreshSequence.current) return;
        dashboardLoaded.current = true;
        // Unchanged rows keep their identity, so Overview's filtered list and rows skip.
        setData((previous) => {
          const listings = reuseUnchangedListings(previous.listings, next.listings);
          return listings === next.listings ? next : { ...next, listings };
        });
        setConnection("online");
        // Events that arrived while this request was in flight need a fresh one.
        if (dirty.current.has("dashboard")) scheduleFlush();
      } catch (error) {
        // The boot request's 401 fired while the session check was still deciding.
        if (boot && error instanceof ApiError && error.status === 401) window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
        if (sequence !== refreshSequence.current) return;
        for (const resource of dashboardResources) dirty.current.add(resource);
        setConnection("offline");
        if (showLoader) notify(errorMessage(error), "error");
      } finally {
        dashboardFetches.current -= 1;
        if (sequence === refreshSequence.current) {
          setIsLoading(false);
        }
      }
    },
    [notify, scheduleFlush],
  );
  const flush = useCallback(async () => {
    if (document.hidden) return;
    const plan = planFlush(viewRef.current, dirty.current, dashboardLoaded.current, dashboardFetches.current > 0);
    for (const resource of plan.clear) dirty.current.delete(resource);
    // A failed dashboard fetch shows the offline banner; on views that do not
    // refetch the dashboard, the live stream decides it again.
    if (streamDecidesConnection(viewRef.current, plan) && dashboardFetches.current === 0 && streamStatus.current === "online") {
      setConnection((current) => (current === "offline" ? "online" : current));
    }
    if (plan.page === "listings") setListingsRefreshKey((value) => value + 1);
    if (plan.page === "analytics") setAnalyticsRefreshKey((value) => value + 1);
    if (plan.page === "market") setMarketRefreshKey((value) => value + 1);
    const pending: Array<Promise<unknown>> = [];
    if (plan.dashboard) pending.push(refreshData(!dashboardLoaded.current));
    if (plan.connectors) {
      // Only the newest request applies, so an older one landing late cannot overwrite it.
      const sequence = ++connectorsSequence.current;
      pending.push(api.connectors().then(
        (result) => {
          if (sequence === connectorsSequence.current) setData((previous) => ({ ...previous, connectors: result.connectors }));
        },
        () => { dirty.current.add("connectors"); },
      ));
    }
    await Promise.all(pending);
  }, [refreshData]);
  flushRef.current = flush;

  useEffect(() => {
    viewRef.current = view;
    void flush();
  }, [flush, view]);
  // Once the first view has rendered its data, fetch the other chunks in the
  // background. Pages that load their own data get a head start instead.
  useEffect(() => {
    if (initialViewNeedsDashboard ? !isLoading : true) preloadRestWhenIdle(initialViewNeedsDashboard ? 0 : 2500);
  }, [isLoading]);
  useEffect(() => {
    const onVisibility = () => {
      // A stream released while hidden reopens now; its "ready" reconciles
      // everything once, so flushing here too would fetch the dashboard twice.
      if (!document.hidden && !reconnectPending()) void flush();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [flush]);
  useEffect(() => {
    const markDirty = (resources: readonly LiveResource[]) => {
      for (const resource of resources) dirty.current.add(resource);
      // Refetches must not share a GET that started before this event.
      forgetInFlightGets();
      scheduleFlush();
    };
    // Triage clicks (in any tab) patch the loaded rows at once and reconcile
    // stats and pages once, 2 s after the last click of a burst.
    let triageTimer: number | null = null;
    const onListingAction = (payload: unknown) => {
      if (!isListingActionEvent(payload)) return;
      setData((previous) => {
        const listings = patchListingRows(previous.listings, payload);
        return listings === previous.listings ? previous : { ...previous, listings };
      });
      for (const resource of eventResources["listing-action"]) dirty.current.add(resource);
      forgetInFlightGets();
      if (triageTimer !== null) window.clearTimeout(triageTimer);
      triageTimer = window.setTimeout(() => {
        triageTimer = null;
        void flushRef.current();
      }, 2000);
    };
    const unsubscribers = [
      // A stream that comes back after a gap (server restart, hidden tab) may have missed events.
      subscribeStatus((status, reconnected) => {
        streamStatus.current = status;
        setConnection(status);
        if (reconnected) markDirty(allLiveResources);
      }),
      ...Object.entries(eventResources)
        .filter(([event]) => event !== "listing-action")
        .map(([event, resources]) => subscribe(event, () => markDirty(resources))),
      subscribe("listing-action", onListingAction),
    ];
    return () => {
      if (flushTimer.current !== null) window.clearTimeout(flushTimer.current);
      if (triageTimer !== null) window.clearTimeout(triageTimer);
      flushTimer.current = null;
      for (const unsubscribe of unsubscribers) unsubscribe();
    };
  }, [scheduleFlush]);
  /** After a watch mutation: refetch what this view shows, mark the rest stale. */
  const refreshAfterWatchChange = async () => {
    for (const resource of eventResources.watch) dirty.current.add(resource);
    if (viewRef.current !== "watches") {
      // Watches refetches its own list when it is next shown.
      setAllWatches(null);
      return flush();
    }
    try {
      const result = await api.watches(true);
      setAllWatches(result.watches);
    } catch (error) {
      notify(errorMessage(error), "error");
    }
  };
  useEffect(() => {
    if (view !== "watches") return;
    void api.watches(true).then((result) => setAllWatches(result.watches)).catch((error) => notify(errorMessage(error), "error"));
  }, [notify, view, watchRefreshKey]);
  // An open listing drawer owns one history entry, so Back closes it.
  const drawerHistory = useRef(false);
  useEffect(() => {
    const onPopState = () => {
      if (drawerHistory.current) {
        drawerHistory.current = false;
        setSelectedListing(null);
        return;
      }
      setView(viewFromLocation());
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);
  const openListing = useCallback((listing: Listing) => {
    if (!drawerHistory.current) {
      window.history.pushState({ scoutDrawer: true }, "");
      drawerHistory.current = true;
    }
    setSelectedListing(listing);
  }, []);
  const closeListing = useCallback(() => {
    setSelectedListing(null);
    if (drawerHistory.current) {
      drawerHistory.current = false;
      window.history.back();
    }
  }, []);
  const modalOpen = Boolean(showWatchDialog || editingFullWatch || analyticsWatch || showHistory || selectedListing);
  useEffect(() => {
    if (!modalOpen) return;
    const dialogs = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]'));
    const dialog = dialogs.at(-1);
    const main = document.querySelector<HTMLElement>("main");
    const sidebar = document.querySelector<HTMLElement>(".sidebar");
    if (!dialog) return;
    const previous = document.activeElement as HTMLElement | null;
    if (main) main.inert = true;
    if (sidebar) sidebar.inert = true;
    const focusable = () => Array.from(dialog.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])')).filter((element) => element.offsetParent !== null);
    const first = focusable()[0];
    first?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        dialog.querySelector<HTMLButtonElement>('[aria-label^="Close"]')?.click();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusable();
      if (!items.length) return;
      const current = items.indexOf(document.activeElement as HTMLElement);
      const next = event.shiftKey ? (current <= 0 ? items.length - 1 : current - 1) : (current === items.length - 1 ? 0 : current + 1);
      if (current === -1 || next !== current) {
        event.preventDefault();
        items[next].focus();
      }
    };
    dialog.addEventListener("keydown", onKeyDown);
    return () => {
      dialog.removeEventListener("keydown", onKeyDown);
      if (main) main.inert = false;
      if (sidebar) {
        const mobileHidden = window.matchMedia(MOBILE_SHELL_QUERY).matches && !sidebarOpen;
        sidebar.inert = mobileHidden;
        sidebar.setAttribute("aria-hidden", String(mobileHidden));
      }
      previous?.focus();
    };
  }, [modalOpen, sidebarOpen]);
  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(null), 3600);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  const openView = (nextView: View, preset: ListingsPreset = {}) => {
    if (nextView === "listings") setListingsPreset((current) => ({ key: current.key + 1, filters: preset }));
    setView(nextView);
    window.history.pushState({}, "", nextView === "overview" ? "/" : `/${nextView}`);
    setSidebarOpen(false);
  };
  const requestScan = async (watchId?: string) => {
    setScanning(true);
    try {
      const result = await api.scan(watchId);
      notify(
        `${result.message}. Connector results will appear shortly.`,
        "info",
      );
    } catch (error) {
      notify(errorMessage(error), "error");
    } finally {
      setScanning(false);
    }
  };
  const createWatch = async (watch: Omit<Watch, "id"> & { id?: string }) => {
    const result = await api.createWatch(watch);
    setData((previous) => ({
      ...previous,
      watches: [result.watch, ...previous.watches],
      stats: { ...previous.stats, watching: previous.stats.watching + 1 },
    }));
    setShowWatchDialog(false);
    setWatchPreset(null);
    setAllWatches(null);
    setWatchRefreshKey((value) => value + 1);
    notify(
      `${result.watch.name} is learning. Alerts begin after 30 listings and 6 hours.`,
    );
  };
  const withBusyWatch = async (watch: Watch, action: () => Promise<void>) => {
    setBusyWatchIds((current) => new Set(current).add(watch.id));
    try {
      await action();
    } finally {
      setBusyWatchIds((current) => {
        const next = new Set(current);
        next.delete(watch.id);
        return next;
      });
    }
  };
  const toggleWatch = (watch: Watch) =>
    withBusyWatch(watch, async () => {
      try {
        await api.updateWatch(watch.id, { enabled: !watch.enabled });
        await refreshAfterWatchChange();
        notify(
          watch.enabled ? `${watch.name} paused.` : `${watch.name} resumed.`,
        );
      } catch (error) {
        notify(errorMessage(error), "error");
      }
    });
  const toggleShipping = (watch: Watch) =>
    withBusyWatch(watch, async () => {
      try {
        await api.updateWatch(watch.id, { shippingOnly: !watch.shippingOnly });
        await refreshAfterWatchChange();
        notify(
          `Shipping-only filter ${watch.shippingOnly ? "disabled" : "enabled"} for ${watch.name}.`,
        );
      } catch (error) {
        notify(errorMessage(error), "error");
      }
    });
  const toggleAiRelevance = (watch: Watch) =>
    withBusyWatch(watch, async () => {
      try {
        await api.updateWatch(watch.id, { aiRelevance: !watch.aiRelevance });
        await refreshAfterWatchChange();
        notify(
          `AI relevance filter ${watch.aiRelevance ? "disabled" : "enabled"} for ${watch.name}.`,
        );
      } catch (error) {
        notify(errorMessage(error), "error");
      }
    });
  const updateWatch = async (watch: Omit<Watch, "id"> & { id?: string }) => {
    if (!watch.id) {
      notify("Watch id is missing.", "error");
      throw new Error("Watch id is missing");
    }
    const fullWatch = watch as Watch;
    return withBusyWatch(fullWatch, async () => {
      try {
        await api.updateWatch(fullWatch.id, { name: fullWatch.name, query: fullWatch.query, terms: fullWatch.terms, excluded: fullWatch.excluded, sources: fullWatch.sources, condition: fullWatch.condition, interval: fullWatch.interval, sourceIntervals: fullWatch.sourceIntervals, exactUrls: fullWatch.exactUrls, sensitivity: fullWatch.sensitivity, shippingOnly: fullWatch.shippingOnly, typoVariants: fullWatch.typoVariants, variantGroups: fullWatch.variantGroups, variantGroupsAuto: fullWatch.variantGroupsAuto, aiRelevance: fullWatch.aiRelevance, referenceMarketWatchId: fullWatch.referenceMarketWatchId, minPrice: fullWatch.minPrice, maxPrice: fullWatch.maxPrice, olxCategory: fullWatch.olxCategory ?? null, sellerType: fullWatch.sellerType ?? null, ignorePromoted: fullWatch.ignorePromoted ?? false, enabled: fullWatch.enabled });
        await refreshAfterWatchChange();
        setEditingFullWatch(null);
        notify(`${fullWatch.name} updated.`);
      } catch (error) {
        notify(errorMessage(error), "error");
        throw error;
      }
    });
  };
  const archiveWatch = (watch: Watch) =>
    withBusyWatch(watch, async () => {
      const archived = Boolean(watch.archivedAt);
      if (!window.confirm(`${archived ? "Restore" : "Archive"} “${watch.name}”? Its observations and analytics will be kept.`))
        return;
      try {
        await api.updateWatch(watch.id, { archived: !archived });
        await refreshAfterWatchChange();
        notify(`${watch.name} ${archived ? "restored" : "archived"}. Its history is still retained.`);
      } catch (error) {
        notify(errorMessage(error), "error");
      }
    });
  const deleteWatch = (watch: Watch) =>
    withBusyWatch(watch, async () => {
      if (!window.confirm(`Permanently delete “${watch.name}”? All observations and analytics will be removed.`)) return;
      try {
        await api.deleteWatch(watch.id);
        await refreshAfterWatchChange();
        notify(`${watch.name} permanently deleted.`);
      } catch (error) {
        notify(errorMessage(error), "error");
      }
    });
  const scanWatch = (watch: Watch) =>
    withBusyWatch(watch, async () => requestScan(watch.id));
  const showWatchListings = (watch: Watch, strongOnly = false) =>
    openView("listings", { watchId: watch.id, watchName: watch.name, ...(strongOnly ? { minStrength: 3, sort: "Strongest" as const } : {}) });
  const updateListingAction = useCallback((listing: Listing) => {
    setData((previous) => ({
      ...previous,
      listings: previous.listings.map((item) =>
        item.id === listing.id
          ? { ...item, decision: listing.decision, note: listing.note, hidden: listing.hidden }
          : item,
      ),
    }));
    setSelectedListing((current) =>
      current?.id === listing.id ? { ...current, decision: listing.decision, note: listing.note, hidden: listing.hidden } : current,
    );
  }, []);
  // Stable, so the memoized SearchPage skips App re-renders (toasts, connection).
  const saveSearchAsWatch = useCallback((preset: WatchPreset) => {
    setWatchPreset(preset);
    setShowWatchDialog(true);
  }, []);
  const toggleListingHidden = useCallback(async (listing: Listing) => {
    const nextHidden = !listing.hidden;
    try {
      // Hide-only save: the server keeps the stored decision and note.
      const result = await api.updateListingAction(listing.marketplaceListingKey ?? listing.id, { hidden: nextHidden });
      updateListingAction({ ...listing, decision: result.action.decision, note: result.action.note, hidden: result.action.hidden });
      notify(nextHidden ? "Listing hidden from the overview and alerts." : "Listing unhidden.");
      return result.action;
    } catch (error) {
      notify(errorMessage(error), "error");
      return null;
    }
  }, [notify, updateListingAction]);

  return (
    <div className="app-shell">
      <Sidebar
        view={view}
        onNavigate={openView}
        open={sidebarOpen}
        collapsed={sidebarCollapsed}
        connection={connection}
        onCollapse={() => setSidebarCollapsed((value) => !value)}
        onLogout={onLogout}
      />
      {sidebarOpen ? (
        <button
          className="sidebar-scrim"
          aria-label="Close navigation"
          onClick={() => setSidebarOpen(false)}
        />
      ) : null}
      <main
        className={`main-content ${sidebarCollapsed ? "main-content--wide" : ""}`}
      >
        <div className="mobile-bar">
          <button
            className="mobile-menu"
            aria-label="Open navigation"
            aria-expanded={sidebarOpen}
            aria-controls="primary-navigation"
            onClick={() => setSidebarOpen(true)}
          >
            <Menu size={21} />
          </button>
          <strong>{sectionFor(view).label}</strong>
        </div>
        {connection === "offline" ? (
          <div className="offline-banner" role="alert">
            <WifiOff size={17} />
            <span>
              Scout’s API is unavailable. Changes are disabled until the
              connection returns.
            </span>
            <button onClick={() => refreshData(true)}>Retry</button>
          </div>
        ) : null}
        <SectionTabs view={view} onNavigate={openView} />
        {view === "overview" ? (
        <Overview
          data={data}
          isLoading={isLoading}
          scanning={scanning}
          onNewWatch={() => { setWatchPreset(null); setShowWatchDialog(true); }}
          onNavigate={openView}
          onScan={() => requestScan()}
          onSelectListing={openListing}
          onToggleHidden={toggleListingHidden}
        />
        ) : null}
        {view === "search" ? (
          <Suspense fallback={<div className="table-loading"><LoaderCircle size={18} className="spin" />Loading search…</div>}>
            <LazySearchPage onSelectListing={openListing} onSaveWatch={saveSearchAsWatch} />
          </Suspense>
        ) : null}
        {view === "watches" ? (
          <Suspense fallback={<div className="table-loading"><LoaderCircle size={18} className="spin" />Loading watches…</div>}>
            <LazyWatchesPage
              watches={allWatches ?? data.watches}
              busyWatchIds={busyWatchIds}
              onNewWatch={() => { setWatchPreset(null); setShowWatchDialog(true); }}
              onToggle={toggleWatch}
              onToggleShipping={toggleShipping}
              onToggleAiRelevance={toggleAiRelevance}
              onEdit={setEditingFullWatch}
              onArchive={archiveWatch}
              onDelete={deleteWatch}
              onScan={scanWatch}
              onViewListings={showWatchListings}
              onAnalytics={setAnalyticsWatch}
            />
          </Suspense>
        ) : null}
        {view === "market-research" ? (
          <Suspense fallback={<div className="table-loading"><LoaderCircle size={18} className="spin" />Loading market research…</div>}>
            <LazyMarketResearchPage refreshKey={marketRefreshKey} onToast={notify} />
          </Suspense>
        ) : null}
        {view === "analytics" ? (
          <Suspense fallback={<div className="table-loading"><LoaderCircle size={18} className="spin" />Loading analytics…</div>}>
            <LazyAnalyticsPage watches={data.watches} refreshKey={analyticsRefreshKey} onToast={notify} />
          </Suspense>
        ) : null}
        {view === "listings" ? (
          <Suspense fallback={<div className="table-loading"><LoaderCircle size={18} className="spin" />Loading listings…</div>}>
            <LazyListingsPage
              key={listingsPreset.key}
              listings={data.listings}
              refreshKey={listingsRefreshKey}
              preset={listingsPreset.filters}
              onSelectListing={openListing}
              onToggleHidden={toggleListingHidden}
            />
          </Suspense>
        ) : null}
        {view === "flips" ? (
          <Suspense fallback={<div className="table-loading"><LoaderCircle size={18} className="spin" />Loading flips…</div>}>
            <LazyFlipsPage onToast={notify} />
          </Suspense>
        ) : null}
        {view === "connectors" ? (
          <Suspense fallback={<div className="table-loading"><LoaderCircle size={18} className="spin" />Loading connectors…</div>}>
            <LazyConnectorsPage
              connectors={data.connectors}
              scanning={scanning}
              onScan={() => requestScan()}
              onHistory={() => setShowHistory(true)}
              onOpenSettings={() => openView("settings")}
              onToast={notify}
            />
          </Suspense>
        ) : null}
        {view === "logs" ? (
          <Suspense fallback={<div className="table-loading"><LoaderCircle size={18} className="spin" />Loading logs…</div>}>
            <LazyLogsPage onToast={notify} />
          </Suspense>
        ) : null}
        {view === "settings" ? (
          <Suspense fallback={<div className="table-loading"><LoaderCircle size={18} className="spin" />Loading settings…</div>}>
            <LazySettingsPage
              theme={theme}
              onTheme={setTheme}
              onToast={notify}
              onHistory={() => setShowHistory(true)}
            />
          </Suspense>
        ) : null}
      </main>
      {showWatchDialog ? (
        <Suspense fallback={<div className="modal-backdrop"><div className="table-loading"><LoaderCircle size={18} className="spin" />Loading watch editor…</div></div>}>
          <LazyWatchDialog
            key="new-watch"
            onClose={() => { setShowWatchDialog(false); setWatchPreset(null); }}
            onSubmit={createWatch}
            preset={watchPreset}
          />
        </Suspense>
      ) : null}
      {editingFullWatch ? <Suspense fallback={<div className="modal-backdrop"><div className="table-loading"><LoaderCircle size={18} className="spin" />Loading watch editor…</div></div>}><LazyWatchDialog key={editingFullWatch.id} initialWatch={editingFullWatch} onClose={() => setEditingFullWatch(null)} onSubmit={updateWatch} /></Suspense> : null}
      {analyticsWatch ? (
        <Suspense fallback={<div className="modal-backdrop"><div className="table-loading"><LoaderCircle size={18} className="spin" />Loading analytics…</div></div>}>
          <LazyWatchAnalyticsDialog
            watch={analyticsWatch}
            onClose={() => setAnalyticsWatch(null)}
          />
        </Suspense>
      ) : null}
      {showHistory ? (
        <Suspense fallback={<div className="modal-backdrop"><div className="table-loading"><LoaderCircle size={18} className="spin" />Loading notification history…</div></div>}>
          <LazyHistoryDialog onClose={() => setShowHistory(false)} />
        </Suspense>
      ) : null}
      {selectedListing ? (
        <Suspense fallback={<div className="modal-backdrop"><div className="table-loading"><LoaderCircle size={18} className="spin" />Loading listing…</div></div>}>
          <LazyListingDetailDrawer
            listing={selectedListing}
            onClose={closeListing}
            onUpdated={updateListingAction}
            onFlipAdded={(flip) => notify(`${flip.title} added to Flips.`)}
            onCreateWatch={(preset) => {
              closeListing();
              setWatchPreset(preset);
              setShowWatchDialog(true);
            }}
          />
        </Suspense>
      ) : null}
      {toast ? (
        <div
          className={`toast toast--${toast.type}`}
          role={toast.type === "error" ? "alert" : "status"}
        >
          {toast.type === "error" ? (
            <AlertTriangle size={18} />
          ) : toast.type === "info" ? (
            <Info size={18} />
          ) : (
            <CheckCircle2 size={18} />
          )}
          {toast.message}
        </div>
      ) : null}
    </div>
  );
}

function Sidebar({
  view,
  onNavigate,
  open,
  collapsed,
  connection,
  onCollapse,
  onLogout,
}: {
  view: View;
  onNavigate: (view: View) => void;
  open: boolean;
  collapsed: boolean;
  connection: "loading" | "online" | "offline";
  onCollapse: () => void;
  onLogout: (() => void) | null;
}) {
  const sidebarRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const media = window.matchMedia(MOBILE_SHELL_QUERY);
    const updateAccessibility = () => {
      const mobileHidden = media.matches && !open;
      if (sidebarRef.current) {
        sidebarRef.current.inert = mobileHidden;
        sidebarRef.current.setAttribute("aria-hidden", String(mobileHidden));
      }
    };
    updateAccessibility();
    media.addEventListener("change", updateAccessibility);
    return () => media.removeEventListener("change", updateAccessibility);
  }, [open]);
  const current = sectionFor(view);
  return (
    <aside
      ref={sidebarRef}
      className={`sidebar ${open ? "sidebar--open" : ""} ${collapsed ? "sidebar--collapsed" : ""}`}
    >
      <div className="brand-row">
        <div className="brand-mark" aria-hidden="true">
          <Search size={24} strokeWidth={2.7} />
          <span />
        </div>
        {collapsed ? null : <span className="brand-name">Scout</span>}
      </div>
      <nav id="primary-navigation" className="sidebar-nav" aria-label="Primary navigation">
        {navSections.map((section) => {
          const { label, icon: Icon } = section;
          const target = section.views[0].id;
          const active = section === current;
          return (
            <button
              key={label}
              className={`nav-item ${active ? "nav-item--active" : ""}`}
              onClick={() => onNavigate(target)}
              onMouseEnter={() => preloadView(target)}
              onFocus={() => preloadView(target)}
              title={collapsed ? label : undefined}
              aria-current={active ? "page" : undefined}
            >
              <Icon size={22} strokeWidth={1.9} />
              {collapsed ? null : <span>{label}</span>}
            </button>
          );
        })}
      </nav>
      <div className="sidebar-footer">
        {/* Only worth a line when something is wrong. */}
        {collapsed || connection === "online" ? null : (
          <div className="running-state">
            <span className={`status-dot status-dot--${connection}`} />
            <strong>{connection === "loading" ? "Connecting…" : "Scout is offline"}</strong>
          </div>
        )}
        {onLogout ? (
          <button className="collapse-button" onClick={onLogout} aria-label="Sign out" title="Sign out">
            <LogOut size={19} />
          </button>
        ) : null}
        <button
          className="collapse-button collapse-button--sidebar"
          onClick={onCollapse}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {collapsed ? (
            <PanelLeftOpen size={19} />
          ) : (
            <PanelLeftClose size={19} />
          )}
        </button>
      </div>
    </aside>
  );
}

/** The pages of the current section (Deals, Market, System) as tabs. */
function SectionTabs({ view, onNavigate }: { view: View; onNavigate: (view: View) => void }) {
  const section = sectionFor(view);
  if (section.views.length < 2) return null;
  return (
    <nav className="section-tabs" aria-label={`${section.label} pages`}>
      {section.views.map((item) => (
        <button
          key={item.id}
          className={`section-tab${item.id === view ? " section-tab--active" : ""}`}
          aria-current={item.id === view ? "page" : undefined}
          onClick={() => onNavigate(item.id)}
          onMouseEnter={() => preloadView(item.id)}
        >
          {item.label}
        </button>
      ))}
    </nav>
  );
}

/** How many deals Overview shows; the rest are one click away in Listings. */
const TOP_DEALS = 20;

function Overview({
  data,
  isLoading,
  scanning,
  onNewWatch,
  onNavigate,
  onScan,
  onSelectListing,
  onToggleHidden,
}: {
  data: DashboardData;
  isLoading: boolean;
  scanning: boolean;
  onNewWatch: () => void;
  onNavigate: (view: View, preset?: ListingsPreset) => void;
  onScan: () => void;
  onSelectListing: (listing: Listing) => void;
  onToggleHidden: (listing: Listing) => void;
}) {
  const [marketplace, setMarketplace] = useState<"All" | Marketplace>("All");
  // Strong+ deals still worth a look: not hidden, not filtered by AI, not
  // passed (the widget's rule). Untriaged rows lead within a tier.
  const { topDeals, total, aiFilteredCount } = useMemo(() => {
    let aiFilteredCount = 0;
    const candidates: Listing[] = [];
    for (const listing of data.listings) {
      if (listing.hidden) continue;
      if (listing.aiFiltered) {
        aiFilteredCount += 1;
        continue;
      }
      if (listing.decision === "pass" || listing.dealStrength < 3) continue;
      if (marketplace !== "All" && listing.marketplace !== marketplace) continue;
      candidates.push(listing);
    }
    candidates.sort((a, b) => {
      if (b.dealStrength !== a.dealStrength) return b.dealStrength - a.dealStrength;
      const aTriaged = a.decision ? 1 : 0;
      const bTriaged = b.decision ? 1 : 0;
      if (aTriaged !== bTriaged) return aTriaged - bTriaged;
      return (Date.parse(b.firstSeenAt ?? b.observedAt) || 0) - (Date.parse(a.firstSeenAt ?? a.observedAt) || 0);
    });
    return { topDeals: candidates.slice(0, TOP_DEALS), total: candidates.length, aiFilteredCount };
  }, [data.listings, marketplace]);
  const troubled = data.connectors.filter((connector) => connector.status === "Degraded" || connector.status === "Warning");
  return (
    <>
      <PageHeader title="Deals">
        <button className="outline-button" disabled={scanning || data.watches.length === 0} onClick={onScan}>
          {scanning ? <LoaderCircle size={15} className="spin" /> : <RefreshCw size={15} />}
          {scanning ? "Queueing…" : "Scan now"}
        </button>
        <button className="primary-button" onClick={onNewWatch}>
          <Plus size={18} strokeWidth={2.3} />
          New watch
        </button>
      </PageHeader>
      <div className="overview-summary" aria-label="Overview statistics">
        <button type="button" onClick={() => onNavigate("listings", { minStrength: 3, sort: "Strongest" })}>
          <strong>{data.stats.strongDeals}</strong> strong deals
        </button>
        <span>
          <strong>{data.stats.newToday}</strong> new today
        </span>
        <button type="button" onClick={() => onNavigate("watches")}>
          <strong>{data.stats.watching}</strong> active {data.stats.watching === 1 ? "watch" : "watches"}
        </button>
        <span title={data.lastScanTime ? `Last scan at ${data.lastScanTime}` : undefined}>last scan {data.lastScan}</span>
        {troubled.length ? (
          <button type="button" className="overview-summary-warning" onClick={() => onNavigate("connectors")}>
            <AlertTriangle size={14} />
            {troubled.map((connector) => `${connector.name} ${connector.status.toLowerCase()}`).join(", ")}
          </button>
        ) : null}
      </div>
      {!isLoading && data.watches.length === 0 ? (
        <div className="setup-banner">
          <div>
            <Bell size={19} />
            <span>
              <strong>Create your first watch</strong>
              <span>Scout needs a search before it can collect prices.</span>
            </span>
          </div>
          <button className="outline-button" onClick={onNewWatch}>
            <Plus size={16} />
            New watch
          </button>
        </div>
      ) : null}
      <section className="fresh-section">
        <div className="section-heading-row">
          <h2>Top deals</h2>
          <div className="filters">
            <SelectControl
              label="Marketplace"
              value={marketplace}
              options={[{ value: "All", label: "All marketplaces" }, "OLX", "Allegro Lokalnie", "Vinted"]}
              onChange={(value) => setMarketplace(value as "All" | Marketplace)}
            />
          </div>
        </div>
        <ListingTable
          listings={topDeals}
          isLoading={isLoading}
          onSelect={onSelectListing}
          onToggleHidden={onToggleHidden}
          empty={
            <div className="empty-state">
              <Search size={25} />
              <strong>No strong deals right now</strong>
              <span>Listings at least 12% below their typical price show up here.</span>
            </div>
          }
        />
        <div className="section-footer">
          <button className="link-button" onClick={() => onNavigate("listings", { minStrength: 3, sort: "Strongest" })}>
            {total > topDeals.length ? `All ${total} strong deals` : "All listings"} <ArrowRight size={17} />
          </button>
          {aiFilteredCount ? (
            <button className="link-button link-button--muted" onClick={() => onNavigate("listings", { visibility: "AI" })}>
              {aiFilteredCount} filtered by AI
            </button>
          ) : null}
        </div>
      </section>
    </>
  );
}

export default App;
