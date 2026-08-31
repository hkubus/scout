import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  BarChart3,
  Bell,
  CheckCircle2,
  ChevronDown,
  Grid2X2,
  Info,
  LoaderCircle,
  MessageSquare,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  PlugZap,
  Plus,
  RefreshCw,
  ScrollText,
  Search,
  Settings2,
  SlidersHorizontal,
  Tag,
  WifiOff,
} from "lucide-react";
import { api } from "./api";
import { emptyDashboard } from "./data";
import ListingTable from "./ListingTable";
import type {
  Connector,
  DashboardData,
  Listing,
  Marketplace,
  Theme,
  View,
  Watch,
} from "./types";

const navItems: Array<{ id: View; label: string; icon: typeof Grid2X2 }> = [
  { id: "overview", label: "Overview", icon: Grid2X2 },
  { id: "search", label: "Search", icon: Search },
  { id: "watches", label: "Watches", icon: Bell },
  { id: "market-research", label: "Market research", icon: BarChart3 },
  { id: "listings", label: "Listings", icon: Tag },
  { id: "messages", label: "Messages", icon: MessageSquare },
  { id: "connectors", label: "Connectors", icon: PlugZap },
  { id: "logs", label: "Logs", icon: ScrollText },
  { id: "settings", label: "Settings", icon: Settings2 },
];

const loadMessagesPage = () => import("./MessagesPage");
const loadMarketResearchPage = () => import("./MarketResearchPage");
const loadSettingsPage = () => import("./SettingsPage");
const loadConnectorsPage = () => import("./ConnectorsPage");
const loadLogsPage = () => import("./LogsPage");
const loadSearchPage = () => import("./SearchPage");
const loadListingsPage = () => import("./ListingsPage");
const LazyMessagesPage = lazy(loadMessagesPage);
const LazyMarketResearchPage = lazy(loadMarketResearchPage);
const LazySettingsPage = lazy(loadSettingsPage);
const LazyConnectorsPage = lazy(loadConnectorsPage);
const LazyLogsPage = lazy(loadLogsPage);
const LazySearchPage = lazy(loadSearchPage);
const LazyListingsPage = lazy(loadListingsPage);
const LazyListingDetailDrawer = lazy(() => import("./ListingDetailDrawer"));
const loadWatchesPage = () => import("./WatchesPage");
const LazyWatchesPage = lazy(loadWatchesPage);
const LazyWatchAnalyticsDialog = lazy(() => loadWatchesPage().then((module) => ({ default: module.WatchAnalyticsDialog })));
const loadDialogs = () => import("./Dialogs");
const LazyWatchDialog = lazy(() => loadDialogs().then((module) => ({ default: module.WatchDialog })));
const LazyPriceFilterDialog = lazy(() => loadDialogs().then((module) => ({ default: module.PriceFilterDialog })));
const LazyHistoryDialog = lazy(() => loadDialogs().then((module) => ({ default: module.HistoryDialog })));

const routeLoaders: Partial<Record<View, () => Promise<unknown>>> = {
  search: loadSearchPage,
  watches: loadWatchesPage,
  "market-research": loadMarketResearchPage,
  listings: loadListingsPage,
  messages: loadMessagesPage,
  connectors: loadConnectorsPage,
  logs: loadLogsPage,
  settings: loadSettingsPage,
};

const preloadView = (view: View) => {
  void routeLoaders[view]?.();
};

type WatchPreset = {
  query: string;
  terms: string;
  excluded: string;
  sources: Marketplace[];
  location: string;
  condition: string;
  minPrice: number | null;
  maxPrice: number | null;
  shippingOnly: boolean;
};

function viewFromLocation(): View {
  const candidate = window.location.pathname.replace(/^\//, "") as View;
  return navItems.some((item) => item.id === candidate) ? candidate : "overview";
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
  const [editingWatch, setEditingWatch] = useState<Watch | null>(null);
  const [editingFullWatch, setEditingFullWatch] = useState<Watch | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [marketRefreshKey, setMarketRefreshKey] = useState(0);
  const [messagesRefreshKey, setMessagesRefreshKey] = useState(0);
  const [logsRefreshKey, setLogsRefreshKey] = useState(0);
  const [selectedWatchId, setSelectedWatchId] = useState<string | null>(
    null,
  );
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
  const refreshData = useCallback(
    async (showLoader = false) => {
      const sequence = ++refreshSequence.current;
      if (showLoader) setIsLoading(true);
      try {
        const next = await api.dashboard();
        if (sequence !== refreshSequence.current) return;
        setData(next);
        setConnection("online");
      } catch (error) {
        if (sequence !== refreshSequence.current) return;
        setConnection("offline");
        if (showLoader) notify(errorMessage(error), "error");
      } finally {
        if (sequence === refreshSequence.current) {
          setIsLoading(false);
        }
      }
    },
    [notify],
  );

  useEffect(() => {
    void refreshData(true);
  }, [refreshData]);
  useEffect(() => {
    const source = new EventSource("/events");
    let refreshTimer: number | null = null;
    const refresh = () => {
      if (refreshTimer !== null) return;
      refreshTimer = window.setTimeout(() => {
        refreshTimer = null;
        void refreshData(false);
      }, 100);
    };
    source.addEventListener("ready", () => setConnection("online"));
    source.addEventListener("scan", refresh);
    source.addEventListener("watch", refresh);
    source.addEventListener("notification", refresh);
    source.addEventListener("listing-action", refresh);
    source.addEventListener("ai-normalization", refresh);
    source.addEventListener("ai-description-verification", refresh);
    source.addEventListener("market-watch", () => setMarketRefreshKey((value) => value + 1));
    source.addEventListener("seller-message", () => setMessagesRefreshKey((value) => value + 1));
    source.addEventListener("log", () => setLogsRefreshKey((value) => value + 1));
    source.onerror = () => setConnection("offline");
    return () => {
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
      source.close();
    };
  }, [refreshData]);
  useEffect(() => {
    if (view !== "watches") return;
    void api.watches(true).then((result) => setAllWatches(result.watches)).catch((error) => notify(errorMessage(error), "error"));
  }, [notify, view, watchRefreshKey]);
  useEffect(() => {
    const onPopState = () => setView(viewFromLocation());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);
  const modalOpen = Boolean(showWatchDialog || editingWatch || analyticsWatch || showHistory || selectedListing);
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
        const mobileHidden = window.matchMedia("(max-width: 900px)").matches && !sidebarOpen;
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

  const openView = (nextView: View) => {
    if (nextView === "listings") setSelectedWatchId(null);
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
  const createWatch = async (watch: Watch) => {
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
        await refreshData(false);
        setWatchRefreshKey((value) => value + 1);
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
        await refreshData(false);
        setWatchRefreshKey((value) => value + 1);
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
        await refreshData(false);
        setWatchRefreshKey((value) => value + 1);
        notify(
          `AI relevance filter ${watch.aiRelevance ? "disabled" : "enabled"} for ${watch.name}.`,
        );
      } catch (error) {
        notify(errorMessage(error), "error");
      }
    });
  const updatePriceRange = async (
    watch: Watch,
    minPrice: number | null,
    maxPrice: number | null,
  ) =>
    withBusyWatch(watch, async () => {
      try {
        await api.updateWatch(watch.id, { minPrice, maxPrice });
        await refreshData(false);
        setWatchRefreshKey((value) => value + 1);
        setEditingWatch(null);
        notify(`Price filter updated for ${watch.name}.`);
      } catch (error) {
        notify(errorMessage(error), "error");
        throw error;
      }
    });
  const updateWatch = async (watch: Watch) =>
    withBusyWatch(watch, async () => {
      try {
        await api.updateWatch(watch.id, { name: watch.name, query: watch.query, terms: watch.terms, excluded: watch.excluded, sources: watch.sources, location: watch.location, condition: watch.condition, interval: watch.interval, exactUrls: watch.exactUrls, sensitivity: watch.sensitivity, shippingOnly: watch.shippingOnly, aiRelevance: watch.aiRelevance, minPrice: watch.minPrice, maxPrice: watch.maxPrice, enabled: watch.enabled });
        await refreshData(false);
        setEditingFullWatch(null);
        setAllWatches(null);
        setWatchRefreshKey((value) => value + 1);
        notify(`${watch.name} updated.`);
      } catch (error) {
        notify(errorMessage(error), "error");
        throw error;
      }
    });
  const archiveWatch = (watch: Watch) =>
    withBusyWatch(watch, async () => {
      const archived = Boolean(watch.archivedAt);
      if (!window.confirm(`${archived ? "Restore" : "Archive"} “${watch.name}”? Its observations and analytics will be kept.`))
        return;
      try {
        await api.updateWatch(watch.id, { archived: !archived });
        await refreshData(false);
        setAllWatches(null);
        setWatchRefreshKey((value) => value + 1);
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
        await refreshData(false);
        setWatchRefreshKey((value) => value + 1);
        notify(`${watch.name} permanently deleted.`);
      } catch (error) {
        notify(errorMessage(error), "error");
      }
    });
  const scanWatch = (watch: Watch) =>
    withBusyWatch(watch, async () => requestScan(watch.id));
  const showWatchListings = (watch: Watch) => {
    setSelectedWatchId(watch.id);
    openView("listings");
  };
  const updateListingAction = useCallback((listing: Listing) => {
    setData((previous) => ({
      ...previous,
      listings: previous.listings.map((item) =>
        item.id === listing.id
          ? { ...item, decision: listing.decision, note: listing.note }
          : item,
      ),
    }));
    setSelectedListing((current) =>
      current?.id === listing.id ? { ...current, decision: listing.decision, note: listing.note } : current,
    );
  }, []);

  return (
    <div className="app-shell">
      <Sidebar
        view={view}
        onNavigate={openView}
        open={sidebarOpen}
        collapsed={sidebarCollapsed}
        connection={connection}
        onCollapse={() => setSidebarCollapsed((value) => !value)}
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
        <button
          className="mobile-menu"
          aria-label="Open navigation"
          aria-expanded={sidebarOpen}
          aria-controls="primary-navigation"
          onClick={() => setSidebarOpen(true)}
        >
          <Menu size={21} />
        </button>
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
        {view === "overview" ? (
        <Overview
          data={data}
          isLoading={isLoading}
          scanning={scanning}
          onNewWatch={() => { setWatchPreset(null); setShowWatchDialog(true); }}
          onNavigate={openView}
          onScan={() => requestScan()}
          onSelectListing={setSelectedListing}
        />
        ) : null}
        {view === "search" ? (
          <Suspense fallback={<div className="table-loading"><LoaderCircle size={18} className="spin" />Loading search…</div>}>
            <LazySearchPage onSelectListing={setSelectedListing} onSaveWatch={(preset) => { setWatchPreset(preset); setShowWatchDialog(true); }} />
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
              onPriceEdit={setEditingWatch}
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
        {view === "listings" ? (
          <Suspense fallback={<div className="table-loading"><LoaderCircle size={18} className="spin" />Loading listings…</div>}>
            <LazyListingsPage
              listings={data.listings}
              selectedWatchId={selectedWatchId}
              onClearWatch={() => setSelectedWatchId(null)}
              onSelectListing={setSelectedListing}
            />
          </Suspense>
        ) : null}
        {view === "messages" ? (
          <Suspense fallback={<div className="table-loading"><LoaderCircle size={18} className="spin" />Loading messages…</div>}>
            <LazyMessagesPage refreshKey={messagesRefreshKey} />
          </Suspense>
        ) : null}
        {view === "connectors" ? (
          <Suspense fallback={<div className="table-loading"><LoaderCircle size={18} className="spin" />Loading connectors…</div>}>
            <LazyConnectorsPage
              connectors={data.connectors}
              scanning={scanning}
              onScan={() => requestScan()}
              onHistory={() => setShowHistory(true)}
              onToast={notify}
            />
          </Suspense>
        ) : null}
        {view === "logs" ? (
          <Suspense fallback={<div className="table-loading"><LoaderCircle size={18} className="spin" />Loading logs…</div>}>
            <LazyLogsPage refreshKey={logsRefreshKey} onToast={notify} />
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
      {editingWatch ? (
        <Suspense fallback={<div className="modal-backdrop"><div className="table-loading"><LoaderCircle size={18} className="spin" />Loading price filter…</div></div>}>
          <LazyPriceFilterDialog
            watch={editingWatch}
            onClose={() => setEditingWatch(null)}
            onSubmit={(min, max) => updatePriceRange(editingWatch, min, max)}
          />
        </Suspense>
      ) : null}
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
            onClose={() => setSelectedListing(null)}
            onUpdated={updateListingAction}
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
}: {
  view: View;
  onNavigate: (view: View) => void;
  open: boolean;
  collapsed: boolean;
  connection: "loading" | "online" | "offline";
  onCollapse: () => void;
}) {
  const sidebarRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 900px)");
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
        {navItems.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            className={`nav-item ${view === id ? "nav-item--active" : ""}`}
            onClick={() => onNavigate(id)}
            onMouseEnter={() => preloadView(id)}
            onFocus={() => preloadView(id)}
            title={collapsed ? label : undefined}
            aria-current={view === id ? "page" : undefined}
          >
            <Icon size={22} strokeWidth={1.9} />
            {collapsed ? null : <span>{label}</span>}
          </button>
        ))}
      </nav>
      <div className="sidebar-footer">
        {collapsed ? null : (
          <div className="running-state">
            <span className={`status-dot status-dot--${connection}`} />
            <div>
              <strong>
                {connection === "online"
                  ? "Scout is running"
                  : connection === "loading"
                    ? "Connecting…"
                    : "Scout is offline"}
              </strong>
              <span>v1.0.0</span>
            </div>
          </div>
        )}
        <button
          className="collapse-button"
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

function Overview({
  data,
  isLoading,
  scanning,
  onNewWatch,
  onNavigate,
  onScan,
  onSelectListing,
}: {
  data: DashboardData;
  isLoading: boolean;
  scanning: boolean;
  onNewWatch: () => void;
  onNavigate: (view: View) => void;
  onScan: () => void;
  onSelectListing: (listing: Listing) => void;
}) {
  const [marketplace, setMarketplace] = useState<"All" | Marketplace>("All");
  const [strength, setStrength] = useState<"All" | "Strong" | "Exceptional">(
    "All",
  );
  const [sort, setSort] = useState<"Newest" | "Deal">("Newest");
  const visibleListings = useMemo(
    () =>
      data.listings
        .filter(
          (listing) =>
            marketplace === "All" || listing.marketplace === marketplace,
        )
        .filter(
          (listing) =>
            strength === "All" ||
            (strength === "Exceptional"
              ? listing.dealStrength >= 5
              : listing.dealStrength >= 3),
        )
        .slice()
        .sort((a, b) =>
          sort === "Deal"
            ? b.dealStrength - a.dealStrength
            : Date.parse(b.observedAt) - Date.parse(a.observedAt),
        ),
    [data.listings, marketplace, strength, sort],
  );
  return (
    <>
      <header className="page-header overview-header">
        <h1>Good deals, before they’re gone.</h1>
        <button className="primary-button" onClick={onNewWatch}>
          <Plus size={19} strokeWidth={2.3} />
          New watch
        </button>
      </header>
      <section className="overview-stats" aria-label="Overview statistics">
        <Stat
          label="Watching"
          value={data.stats.watching.toString()}
          detail="watches"
        />
        <Stat
          label="New today"
          value={data.stats.newToday.toString()}
          detail="listings"
        />
        <Stat
          label="Strong deals"
          value={data.stats.strongDeals.toString()}
          detail="high confidence"
        />
        <Stat
          label="Last scan"
          value={data.lastScan}
          detail={data.lastScanTime}
        />
        <div className="manage-callout">
          <SlidersHorizontal size={25} />
          <span>
            Polling intervals are
            <br />
            configurable per watch.
            <button className="text-link" onClick={() => onNavigate("watches")}>
              Manage watches
            </button>
          </span>
        </div>
      </section>
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
          <h2>Fresh matches</h2>
          <div className="filters">
            <SelectControl
              value={marketplace === "All" ? "All marketplaces" : marketplace}
              options={[
                "All marketplaces",
                "OLX",
                "Allegro Lokalnie",
                "Vinted",
              ]}
              onChange={(value) =>
                setMarketplace(
                  value === "All marketplaces" ? "All" : (value as Marketplace),
                )
              }
            />
            <SelectControl
              value={
                strength === "All"
                  ? "All strengths"
                  : strength === "Strong"
                    ? "Strong+"
                    : "Exceptional"
              }
              options={["All strengths", "Strong+", "Exceptional"]}
              onChange={(value) =>
                setStrength(
                  value === "All strengths"
                    ? "All"
                    : value === "Exceptional"
                      ? "Exceptional"
                      : "Strong",
                )
              }
            />
            <SelectControl
              value={sort === "Newest" ? "Newest first" : "Strongest first"}
              options={["Newest first", "Strongest first"]}
              onChange={(value) =>
                setSort(value === "Newest first" ? "Newest" : "Deal")
              }
            />
          </div>
        </div>
        <ListingTable
          listings={visibleListings}
          isLoading={isLoading}
          compact
          onSelect={onSelectListing}
        />
        <div className="section-footer">
          <button
            className="link-button"
            onClick={() => onNavigate("listings")}
          >
            View all matches <ArrowRight size={17} />
          </button>
          <button
            className="scan-button"
            disabled={scanning || data.watches.length === 0}
            onClick={onScan}
          >
            {scanning ? (
              <LoaderCircle size={15} className="spin" />
            ) : (
              <RefreshCw size={15} />
            )}
            {scanning ? "Queueing…" : "Scan now"}
          </button>
        </div>
      </section>
      <section className="overview-panels">
        <LearningPanel
          watches={data.watches}
          onManage={() => onNavigate("watches")}
        />
        <ConnectorPanel
          connectors={data.connectors}
          onManage={() => onNavigate("connectors")}
        />
      </section>
    </>
  );
}

function Stat({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="stat">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  );
}
function SelectControl({
  value,
  options,
  onChange,
}: {
  value: string;
  options: Array<string | { value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  return (
    <label className="select-control">
      <select
        aria-label={value}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => {
          const item = typeof option === "string" ? { value: option, label: option } : option;
          return <option key={item.value} value={item.value}>{item.label}</option>;
        })}
      </select>
      <ChevronDown size={16} />
    </label>
  );
}

function LearningPanel({
  watches,
  onManage,
}: {
  watches: Watch[];
  onManage: () => void;
}) {
  return (
    <div className="info-panel">
      <div className="panel-title">
        <h3>Learning progress</h3>
        <Info size={16} />
      </div>
      {watches.length ? (
        <>
          <div className="learning-head">
            <span>Watch</span>
            <span>Samples</span>
            <span>Status</span>
            <span>Readiness</span>
          </div>
          {watches.slice(0, 4).map((watch) => (
            <div className="learning-row" key={watch.id}>
              <span>{watch.name}</span>
              <span>
                {watch.samples} / {watch.targetSamples}
              </span>
              <span
                className={`learning-status learning-status--${watch.status.toLowerCase()}`}
              >
                <i />
                {watch.status}
              </span>
              <span className="readiness">
                <em>{watch.readiness}%</em>
                <b>
                  <i style={{ width: `${watch.readiness}%` }} />
                </b>
              </span>
            </div>
          ))}
        </>
      ) : (
        <div className="panel-empty">No watches are learning yet.</div>
      )}
      <button className="panel-link" onClick={onManage}>
        Manage watches <ArrowRight size={16} />
      </button>
    </div>
  );
}
function ConnectorPanel({
  connectors,
  onManage,
}: {
  connectors: Connector[];
  onManage: () => void;
}) {
  return (
    <div className="info-panel">
      <div className="panel-title connector-title">
        <h3>Connector health</h3>
        <span>Last successful check</span>
      </div>
      <div className="connector-list">
        {connectors.map((connector) => (
          <div className="connector-row" key={connector.name}>
            <span className="connector-name">
              <i style={{ background: connector.color }} />
              {connector.name}
            </span>
            <span
              className={`connector-status connector-status--${connector.status.toLowerCase()}`}
            >
              <i />
              {connector.status}
            </span>
            <span>{connector.lastSuccess}</span>
          </div>
        ))}
      </div>
      <button className="panel-link" onClick={onManage}>
        View connector details <ArrowRight size={16} />
      </button>
    </div>
  );
}

export default App;
