import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  BarChart3,
  Calculator,
  Bell,
  Check,
  CheckCircle2,
  ChevronDown,
  Clock3,
  Database,
  ExternalLink,
  Grid2X2,
  Info,
  ListFilter,
  LoaderCircle,
  Menu,
  Moon,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Pause,
  Play,
  PlugZap,
  Plus,
  RefreshCw,
  Search,
  Send,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Sun,
  Tag,
  Trash2,
  WifiOff,
  X,
  Zap,
} from "lucide-react";
import { api } from "./api";
import { emptyDashboard, marketplaceColors } from "./data";
import type {
  Connector,
  ConnectorRun,
  DashboardData,
  Listing,
  ListingDetail,
  ListingDecision,
  Marketplace,
  MarketResearchData,
  MarketTrackedListing,
  MarketWatch,
  MarketWatchInput,
  NotificationPriority,
  PriceHistoryPoint,
  NotificationRecord,
  SearchSourceStatus,
  SettingsData,
  Theme,
  View,
  Watch,
  WatchAnalytics,
} from "./types";

const navItems: Array<{ id: View; label: string; icon: typeof Grid2X2 }> = [
  { id: "overview", label: "Overview", icon: Grid2X2 },
  { id: "search", label: "Search", icon: Search },
  { id: "watches", label: "Watches", icon: Bell },
  { id: "market-research", label: "Market research", icon: BarChart3 },
  { id: "listings", label: "Listings", icon: Tag },
  { id: "connectors", label: "Connectors", icon: PlugZap },
  { id: "settings", label: "Settings", icon: Settings2 },
];

const formatPln = (value: number | null) =>
  value === null ? "Learning" : `${value.toLocaleString("pl-PL")} zł`;
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
  const [view, setView] = useState<View>("overview");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [data, setData] = useState<DashboardData>(emptyDashboard);
  const [isLoading, setIsLoading] = useState(true);
  const [connection, setConnection] = useState<
    "loading" | "online" | "offline"
  >("loading");
  const [showWatchDialog, setShowWatchDialog] = useState(false);
  const [editingWatch, setEditingWatch] = useState<Watch | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [marketRefreshKey, setMarketRefreshKey] = useState(0);
  const [selectedWatchName, setSelectedWatchName] = useState<string | null>(
    null,
  );
  const [analyticsWatch, setAnalyticsWatch] = useState<Watch | null>(null);
  const [selectedListing, setSelectedListing] = useState<Listing | null>(null);
  const [busyWatchIds, setBusyWatchIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [scanning, setScanning] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);

  const notify = useCallback(
    (message: string, type: Toast["type"] = "success") =>
      setToast({ message, type }),
    [],
  );
  const refreshData = useCallback(
    async (showLoader = false) => {
      if (showLoader) setIsLoading(true);
      try {
        setData(await api.dashboard());
        setConnection("online");
      } catch (error) {
        setConnection("offline");
        if (showLoader) notify(errorMessage(error), "error");
      } finally {
        if (showLoader) setIsLoading(false);
      }
    },
    [notify],
  );

  useEffect(() => {
    void refreshData(true);
  }, [refreshData]);
  useEffect(() => {
    const source = new EventSource("/events");
    const refresh = () => void refreshData(false);
    source.addEventListener("ready", () => setConnection("online"));
    source.addEventListener("scan", refresh);
    source.addEventListener("watch", refresh);
    source.addEventListener("notification", refresh);
    source.addEventListener("listing-action", refresh);
    source.addEventListener("market-watch", () => setMarketRefreshKey((value) => value + 1));
    source.onerror = () => setConnection("offline");
    return () => source.close();
  }, [refreshData]);
  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(null), 3600);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  const openView = (nextView: View) => {
    if (nextView === "listings") setSelectedWatchName(null);
    setView(nextView);
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
        notify(
          `Shipping-only filter ${watch.shippingOnly ? "disabled" : "enabled"} for ${watch.name}.`,
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
        setEditingWatch(null);
        notify(`Price filter updated for ${watch.name}.`);
      } catch (error) {
        notify(errorMessage(error), "error");
        throw error;
      }
    });
  const deleteWatch = (watch: Watch) =>
    withBusyWatch(watch, async () => {
      if (
        !window.confirm(`Delete “${watch.name}”? Listing history will be kept.`)
      )
        return;
      try {
        await api.deleteWatch(watch.id);
        await refreshData(false);
        notify(`${watch.name} deleted.`);
      } catch (error) {
        notify(errorMessage(error), "error");
      }
    });
  const scanWatch = (watch: Watch) =>
    withBusyWatch(watch, async () => requestScan(watch.id));
  const showWatchListings = (watch: Watch) => {
    setSelectedWatchName(watch.name);
    setView("listings");
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
          onNewWatch={() => setShowWatchDialog(true)}
          onNavigate={openView}
          onScan={() => requestScan()}
          onSelectListing={setSelectedListing}
        />
        ) : null}
        {view === "search" ? <SearchPage onSelectListing={setSelectedListing} /> : null}
        {view === "watches" ? (
          <WatchesPage
            watches={data.watches}
            busyWatchIds={busyWatchIds}
            onNewWatch={() => setShowWatchDialog(true)}
            onToggle={toggleWatch}
            onToggleShipping={toggleShipping}
            onEdit={setEditingWatch}
            onDelete={deleteWatch}
            onScan={scanWatch}
            onViewListings={showWatchListings}
            onAnalytics={setAnalyticsWatch}
          />
        ) : null}
        {view === "market-research" ? (
          <MarketResearchPage refreshKey={marketRefreshKey} onToast={notify} />
        ) : null}
        {view === "listings" ? (
          <ListingsPage
            listings={data.listings}
            selectedWatchName={selectedWatchName}
            onClearWatch={() => setSelectedWatchName(null)}
            onSelectListing={setSelectedListing}
          />
        ) : null}
        {view === "connectors" ? (
          <ConnectorsPage
            connectors={data.connectors}
            scanning={scanning}
            onScan={() => requestScan()}
            onHistory={() => setShowHistory(true)}
            onToast={notify}
          />
        ) : null}
        {view === "settings" ? (
          <SettingsPage
            theme={theme}
            onTheme={setTheme}
            onToast={notify}
            onHistory={() => setShowHistory(true)}
          />
        ) : null}
      </main>
      {showWatchDialog ? (
        <WatchDialog
          onClose={() => setShowWatchDialog(false)}
          onSubmit={createWatch}
        />
      ) : null}
      {editingWatch ? (
        <PriceFilterDialog
          watch={editingWatch}
          onClose={() => setEditingWatch(null)}
          onSubmit={(min, max) => updatePriceRange(editingWatch, min, max)}
        />
      ) : null}
      {analyticsWatch ? (
        <WatchAnalyticsDialog
          watch={analyticsWatch}
          onClose={() => setAnalyticsWatch(null)}
        />
      ) : null}
      {showHistory ? (
        <HistoryDialog onClose={() => setShowHistory(false)} />
      ) : null}
      {selectedListing ? (
        <ListingDetailDrawer
          listing={selectedListing}
          onClose={() => setSelectedListing(null)}
          onUpdated={updateListingAction}
        />
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
  return (
    <aside
      className={`sidebar ${open ? "sidebar--open" : ""} ${collapsed ? "sidebar--collapsed" : ""}`}
    >
      <div className="brand-row">
        <div className="brand-mark" aria-hidden="true">
          <Search size={24} strokeWidth={2.7} />
          <span />
        </div>
        {collapsed ? null : <span className="brand-name">Scout</span>}
      </div>
      <nav className="sidebar-nav" aria-label="Primary navigation">
        {navItems.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            className={`nav-item ${view === id ? "nav-item--active" : ""}`}
            onClick={() => onNavigate(id)}
            title={collapsed ? label : undefined}
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

function PageHeader({
  title,
  description,
  action,
  actionIcon = <Plus size={19} />,
  actionDisabled,
  onAction,
}: {
  title: string;
  description?: string;
  action?: string;
  actionIcon?: React.ReactNode;
  actionDisabled?: boolean;
  onAction?: () => void;
}) {
  return (
    <header className="page-header page-header--inner">
      <div>
        <h1>{title}</h1>
        {description ? <p>{description}</p> : null}
      </div>
      {action ? (
        <button
          className="primary-button"
          disabled={actionDisabled}
          onClick={onAction}
        >
          {actionIcon}
          {action}
        </button>
      ) : null}
    </header>
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
              <strong>Create your first watch</strong>Scout needs a search
              before it can collect prices.
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
  options: string[];
  onChange: (value: string) => void;
}) {
  return (
    <label className="select-control">
      <select
        aria-label={value}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <option key={option}>{option}</option>
        ))}
      </select>
      <ChevronDown size={16} />
    </label>
  );
}

function ListingTable({
  listings,
  compact = false,
  isLoading = false,
  onSelect,
}: {
  listings: Listing[];
  compact?: boolean;
  isLoading?: boolean;
  onSelect?: (listing: Listing) => void;
}) {
  if (isLoading)
    return (
      <div className="table-loading">
        <RefreshCw size={20} className="spin" />
        Loading matches…
      </div>
    );
  if (!listings.length)
    return (
      <div className="empty-state">
        <Search size={25} />
        <strong>No listings yet</strong>
        <span>Run a watch to start building its price history.</span>
      </div>
    );
  return (
    <div
      className={`listing-table-wrap ${compact ? "listing-table-wrap--compact" : ""}`}
    >
      <div className="listing-table listing-table--head">
        <span>Item</span>
        <span>Marketplace</span>
        <span>Price (PLN)</span>
        <span>Typical (PLN)</span>
        <span>Below typical</span>
        <span>Observed</span>
        <span>Deal strength</span>
        <span aria-label="Open listing" />
      </div>
      {listings.map((listing) => (
        <ListingRow key={listing.id} listing={listing} onSelect={onSelect} />
      ))}
    </div>
  );
}
function ListingThumbnail({ listing }: { listing: Listing }) {
  const [failed, setFailed] = useState(false);
  return listing.image && !failed ? (
    <img
      src={listing.image}
      alt=""
      loading="lazy"
      onError={() => setFailed(true)}
    />
  ) : (
    <div className="listing-thumb-placeholder">
      <Tag size={20} />
    </div>
  );
}
function ListingRow({ listing, onSelect }: { listing: Listing; onSelect?: (listing: Listing) => void }) {
  return (
    <div className="listing-table listing-row">
      <button
        type="button"
        className="listing-item listing-item--button"
        onClick={() => onSelect?.(listing)}
        disabled={!onSelect}
        aria-label={`View details for ${listing.title}`}
      >
        <ListingThumbnail listing={listing} />
        <div>
          <strong>{listing.title}</strong>
          <span>{listing.subtitle || listing.watch}</span>
          {listing.decision ? (
            <em className={`decision-chip decision-chip--${listing.decision}`}>
              {listing.decision === "buy"
                ? "Buy"
                : listing.decision === "watch"
                  ? "Watch"
                  : "Pass"}
            </em>
          ) : null}
        </div>
      </button>
      <div className="marketplace-cell">
        <i style={{ background: marketplaceColors[listing.marketplace] }} />
        {listing.marketplace}
      </div>
      <strong className="price-cell">{formatPln(listing.price)}</strong>
      <span>{formatPln(listing.typical)}</span>
      <strong className="discount-cell">
        {listing.belowTypical === null
          ? "—"
          : `${listing.belowTypical.toFixed(1)}%`}
      </strong>
      <span className="observed-cell">{listing.observed}</span>
      <div className="strength-cell">
        <DealBars strength={listing.dealStrength} />
        <span>{listing.typical === null ? "Learning" : listing.dealLabel}</span>
      </div>
      <a
        href={listing.url}
        target="_blank"
        rel="noreferrer"
        className="external-link"
        aria-label={`Open ${listing.title}`}
      >
        <ExternalLink size={17} />
      </a>
    </div>
  );
}
function DealBars({ strength }: { strength: number }) {
  return (
    <span
      className={`deal-bars deal-bars--${strength}`}
      aria-label={`${strength} of 5 deal strength`}
    >
      {[1, 2, 3, 4, 5].map((bar) => (
        <i key={bar} className={bar <= strength ? "is-filled" : ""} />
      ))}
    </span>
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

function SearchPage({ onSelectListing }: { onSelectListing: (listing: Listing) => void }) {
  const [query, setQuery] = useState("");
  const [terms, setTerms] = useState("");
  const [excluded, setExcluded] = useState("");
  const [minPrice, setMinPrice] = useState("");
  const [maxPrice, setMaxPrice] = useState("");
  const [condition, setCondition] = useState("Any");
  const [location, setLocation] = useState("");
  const [shippingOnly, setShippingOnly] = useState(false);
  const [sources, setSources] = useState<Marketplace[]>([
    "OLX",
    "Allegro Lokalnie",
    "Vinted",
  ]);
  const [listings, setListings] = useState<Listing[]>([]);
  const [sourceStatuses, setSourceStatuses] = useState<SearchSourceStatus[]>(
    [],
  );
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const numericMin = minPrice === "" ? null : Number(minPrice);
  const numericMax = maxPrice === "" ? null : Number(maxPrice);
  const validPrices =
    (numericMin === null || (Number.isFinite(numericMin) && numericMin >= 0)) &&
    (numericMax === null || (Number.isFinite(numericMax) && numericMax > 0)) &&
    (numericMin === null || numericMax === null || numericMin <= numericMax);
  const toggleSource = (source: Marketplace) =>
    setSources((current) =>
      current.includes(source)
        ? current.filter((item) => item !== source)
        : [...current, source],
    );
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!query.trim() || !sources.length || !validPrices) return;
    setLoading(true);
    setError(null);
    setSearched(true);
    setListings([]);
    setSourceStatuses([]);
    try {
      const result = await api.search({
        query: query.trim(),
        terms: terms.trim(),
        excluded: excluded.trim(),
        sources,
        minPrice: numericMin,
        maxPrice: numericMax,
        shippingOnly,
        condition,
        location: location.trim(),
      });
      setListings(result.listings);
      setSourceStatuses(result.sources);
    } catch (searchError) {
      setError(errorMessage(searchError));
    } finally {
      setLoading(false);
    }
  };
  return (
    <>
      <PageHeader
        title="Search"
        description="Search all marketplaces now without creating a watch or changing its price history."
      />
      <form className="manual-search-panel" onSubmit={submit}>
        <div className="manual-search-query">
          <Search size={19} />
          <input
            autoFocus
            aria-label="Search marketplaces"
            placeholder="What are you looking for?"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <button
            className="primary-button"
            disabled={
              loading || !query.trim() || !sources.length || !validPrices
            }
          >
            {loading ? (
              <LoaderCircle size={18} className="spin" />
            ) : (
              <Search size={18} />
            )}
            {loading ? "Searching…" : "Search all"}
          </button>
        </div>
        <div className="search-filter-grid">
          <label className="field-label">
            Minimum price <span>PLN</span>
            <input
              type="number"
              min="0"
              step="1"
              placeholder="No minimum"
              value={minPrice}
              onChange={(event) => setMinPrice(event.target.value)}
            />
          </label>
          <label className="field-label">
            Maximum price <span>PLN</span>
            <input
              type="number"
              min="1"
              step="1"
              placeholder="No maximum"
              value={maxPrice}
              onChange={(event) => setMaxPrice(event.target.value)}
            />
          </label>
          <label className="field-label">
            Condition
            <select
              value={condition}
              onChange={(event) => setCondition(event.target.value)}
            >
              <option>Any</option>
              <option>New</option>
              <option>Used</option>
            </select>
          </label>
          <label className="field-label">
            Location <span>where available</span>
            <input
              placeholder="Anywhere"
              value={location}
              onChange={(event) => setLocation(event.target.value)}
            />
          </label>
        </div>
        <div className="search-advanced-row">
          <label className="field-label">
            Included terms
            <input
              placeholder="e.g. oled, 512gb"
              value={terms}
              onChange={(event) => setTerms(event.target.value)}
            />
          </label>
          <label className="field-label">
            Excluded terms
            <input
              placeholder="e.g. broken, parts"
              value={excluded}
              onChange={(event) => setExcluded(event.target.value)}
            />
          </label>
        </div>
        <div className="search-options-row">
          <div>
            <span className="filter-label">Sources</span>
            <div className="source-options">
              {(["OLX", "Allegro Lokalnie", "Vinted"] as Marketplace[]).map(
                (source) => (
                  <button
                    type="button"
                    key={source}
                    className={`source-option ${sources.includes(source) ? "source-option--selected" : ""}`}
                    onClick={() => toggleSource(source)}
                  >
                    <i style={{ background: marketplaceColors[source] }} />
                    {source}
                    {sources.includes(source) ? <Check size={15} /> : null}
                  </button>
                ),
              )}
            </div>
          </div>
          <label className="check-option">
            <input
              type="checkbox"
              checked={shippingOnly}
              onChange={(event) => setShippingOnly(event.target.checked)}
            />
            <span>
              <strong>Shipping only</strong>
              <small>Hide pickup-only and unknown delivery results</small>
            </span>
          </label>
        </div>
        {!validPrices ? (
          <div className="form-error" role="alert">
            <AlertTriangle size={15} />
            Enter a valid price range; the minimum cannot exceed the maximum.
          </div>
        ) : null}
      </form>
      {sourceStatuses.length ? (
        <div
          className="search-source-statuses"
          aria-label="Marketplace search status"
        >
          {sourceStatuses.map((status) => (
            <div
              key={status.source}
              className={`search-source-status search-source-status--${status.status}`}
            >
              <i style={{ background: marketplaceColors[status.source] }} />
              <div>
                <strong>{status.source}</strong>
                <span>
                  {status.message}
                  {status.pendingShipping
                    ? ` · ${status.pendingShipping} delivery checks pending`
                    : ""}
                </span>
              </div>
              <small>{(status.durationMs / 1000).toFixed(1)}s</small>
            </div>
          ))}
        </div>
      ) : null}
      {error ? (
        <div className="search-error" role="alert">
          <AlertTriangle size={18} />
          {error}
        </div>
      ) : null}
      <section className="search-results">
        <div className="section-heading-row">
          <h2>
            {searched
              ? `${listings.length} ${listings.length === 1 ? "result" : "results"}`
              : "Results"}
          </h2>
          {searched && !loading ? (
            <span className="toolbar-meta">Sorted by lowest price</span>
          ) : null}
        </div>
        {loading ? (
          <div className="table-loading">
            <LoaderCircle size={20} className="spin" />
            Searching public marketplace pages…
          </div>
        ) : listings.length ? (
          <SearchResultsTable listings={listings} onSelect={onSelectListing} />
        ) : (
          <div className="empty-state">
            <ListFilter size={25} />
            <strong>
              {searched ? "No matching listings" : "Ready when you are"}
            </strong>
            <span>
              {searched
                ? "Try widening the price range or removing a filter."
                : "Choose filters and search across the selected marketplaces."}
            </span>
          </div>
        )}
      </section>
    </>
  );
}

function SearchResultsTable({ listings, onSelect }: { listings: Listing[]; onSelect: (listing: Listing) => void }) {
  return (
    <div className="search-table-wrap">
      <div className="search-table search-table--head">
        <span>Item</span>
        <span>Marketplace</span>
        <span>Price</span>
        <span>Shipping</span>
        <span>Condition / location</span>
        <span />
      </div>
      {listings.map((listing) => (
        <div className="search-table search-result-row" key={listing.id}>
          <button
            type="button"
            className="listing-item listing-item--button"
            onClick={() => onSelect(listing)}
            aria-label={`View details for ${listing.title}`}
          >
            <ListingThumbnail listing={listing} />
            <div>
              <strong>{listing.title}</strong>
              <span>{listing.subtitle || "No extra details"}</span>
            </div>
          </button>
          <div className="marketplace-cell">
            <i style={{ background: marketplaceColors[listing.marketplace] }} />
            {listing.marketplace}
          </div>
          <strong className="price-cell">{formatPln(listing.price)}</strong>
          <span
            className={`shipping-state shipping-state--${listing.shippingAvailable === true ? "yes" : listing.shippingAvailable === false ? "no" : "unknown"}`}
          >
            {listing.shippingAvailable === true
              ? "Available"
              : listing.shippingAvailable === false
                ? "Pickup only"
                : "Unknown"}
          </span>
          <span>
            {[listing.condition, listing.location]
              .filter(Boolean)
              .join(" · ") || "—"}
          </span>
          <a
            href={listing.url}
            target="_blank"
            rel="noreferrer"
            className="external-link"
            aria-label={`Open ${listing.title}`}
          >
            <ExternalLink size={17} />
          </a>
        </div>
      ))}
    </div>
  );
}

function WatchesPage({
  watches,
  busyWatchIds,
  onNewWatch,
  onToggle,
  onToggleShipping,
  onEdit,
  onDelete,
  onScan,
  onViewListings,
  onAnalytics,
}: {
  watches: Watch[];
  busyWatchIds: Set<string>;
  onNewWatch: () => void;
  onToggle: (watch: Watch) => void;
  onToggleShipping: (watch: Watch) => void;
  onEdit: (watch: Watch) => void;
  onDelete: (watch: Watch) => void;
  onScan: (watch: Watch) => void;
  onViewListings: (watch: Watch) => void;
  onAnalytics: (watch: Watch) => void;
}) {
  const [search, setSearch] = useState("");
  const filtered = watches.filter((watch) =>
    `${watch.name} ${watch.query}`.toLowerCase().includes(search.toLowerCase()),
  );
  const activeCount = watches.filter((watch) => watch.enabled).length;
  return (
    <>
      <PageHeader
        title="Watches"
        description="Searches Scout checks on a calm, predictable rhythm."
        action="New watch"
        onAction={onNewWatch}
      />
      <div className="toolbar">
        <label className="search-input">
          <Search size={17} />
          <input
            aria-label="Search watches"
            placeholder="Search watches"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <span className="toolbar-meta">
          {activeCount} active {activeCount === 1 ? "search" : "searches"} ·
          safe minimum 5 minutes
        </span>
      </div>
      {filtered.length ? (
        <div className="watch-list">
          {filtered.map((watch) => (
            <WatchRow
              key={watch.id}
              watch={watch}
              busy={busyWatchIds.has(watch.id)}
              onToggle={() => onToggle(watch)}
              onToggleShipping={() => onToggleShipping(watch)}
              onEdit={() => onEdit(watch)}
              onDelete={() => onDelete(watch)}
              onScan={() => onScan(watch)}
              onListings={() => onViewListings(watch)}
              onAnalytics={() => onAnalytics(watch)}
            />
          ))}
        </div>
      ) : (
        <div className="page-empty">
          <Bell size={27} />
          <strong>
            {watches.length ? "No watches match that search" : "No watches yet"}
          </strong>
          <span>
            {watches.length
              ? "Try a different name or query."
              : "Create a watch to begin learning marketplace prices."}
          </span>
          {watches.length ? null : (
            <button className="primary-button" onClick={onNewWatch}>
              <Plus size={17} />
              New watch
            </button>
          )}
        </div>
      )}
      <div className="soft-note">
        <ShieldCheck size={18} />
        <span>
          Scout reads public pages by default. Optional authenticated sessions
          can be configured in Settings; Scout never captures passwords,
          bypasses CAPTCHAs, or contacts sellers.
        </span>
      </div>
    </>
  );
}
function WatchRow({
  watch,
  busy,
  onToggle,
  onToggleShipping,
  onEdit,
  onDelete,
  onScan,
  onListings,
  onAnalytics,
}: {
  watch: Watch;
  busy: boolean;
  onToggle: () => void;
  onToggleShipping: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onScan: () => void;
  onListings: () => void;
  onAnalytics: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <article
      className={`watch-card ${!watch.enabled ? "watch-card--paused" : ""}`}
    >
      <div className="watch-card-main">
        <div className="watch-icon">
          <Bell size={21} />
        </div>
        <div className="watch-copy">
          <div className="watch-title-row">
            <h3>{watch.name}</h3>
            <span
              className={`state-chip state-chip--${watch.status.toLowerCase()}`}
            >
              <i />
              {watch.status}
            </span>
          </div>
          <p>
            {watch.query} <span>·</span> {watch.location} <span>·</span>{" "}
            {watch.sources.join(", ")}
          </p>
          <div className="watch-tags">
            <span>include: {watch.terms || "query terms"}</span>
            <span>exclude: {watch.excluded || "none"}</span>
            <span>every {watch.interval} min</span>
            {watch.minPrice !== null || watch.maxPrice !== null ? (
              <span>
                price:{" "}
                {watch.minPrice === null
                  ? "0"
                  : watch.minPrice.toLocaleString("pl-PL")}
                –
                {watch.maxPrice === null
                  ? "∞"
                  : watch.maxPrice.toLocaleString("pl-PL")}{" "}
                zł
              </span>
            ) : null}
            {watch.shippingOnly ? <span>shipping only</span> : null}
            {watch.exactUrls.length ? (
              <span>
                {watch.exactUrls.length} exact URL
                {watch.exactUrls.length === 1 ? "" : "s"}
              </span>
            ) : null}
          </div>
        </div>
      </div>
      <div className="watch-progress">
        <div>
          <span>Learning baseline</span>
          <strong>
            {watch.samples} / {watch.targetSamples} samples
          </strong>
        </div>
        <b>
          <i style={{ width: `${watch.readiness}%` }} />
        </b>
        <small>
          {watch.observationHours}h observed · {watch.readiness}% ready
        </small>
      </div>
      <div className="watch-actions">
        <span className="next-scan">
          <Clock3 size={15} />
          {watch.enabled ? `Next ${watch.nextScan}` : "Paused"}
        </span>
        <button
          className="icon-button"
          onClick={onAnalytics}
          title="View watch analytics"
          aria-label={`View analytics for ${watch.name}`}
        >
          <BarChart3 size={17} />
        </button>
        <button
          className="icon-button"
          onClick={onListings}
          title="View listings"
          aria-label={`View listings for ${watch.name}`}
        >
          <ExternalLink size={17} />
        </button>
        <button
          className={`toggle ${watch.enabled ? "toggle--on" : ""}`}
          disabled={busy}
          onClick={onToggle}
          aria-label={
            watch.enabled ? `Pause ${watch.name}` : `Resume ${watch.name}`
          }
        >
          {busy ? (
            <LoaderCircle size={13} className="spin" />
          ) : watch.enabled ? (
            <Pause size={13} />
          ) : (
            <Play size={13} />
          )}
        </button>
        <div className="menu-anchor">
          <button
            className="icon-button"
            title="More actions"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((value) => !value)}
          >
            <MoreHorizontal size={18} />
          </button>
          {menuOpen ? (
            <div className="action-menu" role="menu">
              <button
                role="menuitem"
                disabled={busy || !watch.enabled}
                onClick={() => {
                  setMenuOpen(false);
                  onScan();
                }}
              >
                <RefreshCw size={15} />
                Scan now
              </button>
              <button
                role="menuitem"
                disabled={busy}
                onClick={() => {
                  setMenuOpen(false);
                  onEdit();
                }}
              >
                <SlidersHorizontal size={15} />
                Edit price filter
              </button>
              <button
                role="menuitem"
                disabled={busy}
                onClick={() => {
                  setMenuOpen(false);
                  onToggleShipping();
                }}
              >
                <Tag size={15} />
                {watch.shippingOnly ? "Allow pickup-only" : "Require shipping"}
              </button>
              <button
                role="menuitem"
                className="danger-action"
                disabled={busy}
                onClick={() => {
                  setMenuOpen(false);
                  onDelete();
                }}
              >
                <Trash2 size={15} />
                Delete watch
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </article>
  );
}

function formatAnalyticsPrice(value: number | null) {
  return value === null ? "—" : formatPln(value);
}

function formatAnalyticsDate(value: string | null) {
  if (!value) return "—";
  return new Date(value.includes("T") ? value : `${value}T00:00:00Z`).toLocaleDateString("pl-PL", {
    day: "2-digit",
    month: "short",
  });
}

function AnalyticsTrendChart({ analytics }: { analytics: WatchAnalytics }) {
  const width = 760;
  const height = 250;
  const padding = { top: 18, right: 18, bottom: 28, left: 48 };
  const plotted = analytics.points
    .map((point, index) => ({ point, index }))
    .filter(({ point }) => point.medianPrice !== null);
  if (!plotted.length) {
    return <div className="analytics-chart-empty">Not enough observations to draw a trend yet.</div>;
  }
  const values = plotted.flatMap(({ point }) => [point.lowerPrice, point.medianPrice, point.upperPrice]).filter((value): value is number => value !== null);
  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  const spread = rawMax - rawMin;
  const min = spread ? rawMin : Math.max(0, rawMin - Math.max(rawMin * 0.05, 1));
  const max = spread ? rawMax : rawMax + Math.max(rawMax * 0.05, 1);
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const x = (index: number) => padding.left + (analytics.points.length === 1 ? 0.5 : index / (analytics.points.length - 1)) * plotWidth;
  const y = (value: number) => padding.top + ((max - value) / (max - min || 1)) * plotHeight;
  const upperPath = plotted.map(({ point, index }) => `${x(index)},${y(point.upperPrice ?? point.medianPrice!)}`).join(" ");
  const lowerPath = plotted.slice().reverse().map(({ point, index }) => `${x(index)},${y(point.lowerPrice ?? point.medianPrice!)}`).join(" ");
  const medianPath = plotted.map(({ point, index }) => `${x(index)},${y(point.medianPrice!)}`).join(" ");
  const labelPoints = analytics.points.length > 2 ? [analytics.points[0], analytics.points[Math.floor((analytics.points.length - 1) / 2)], analytics.points[analytics.points.length - 1]] : analytics.points;
  return (
    <>
      <svg className="analytics-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${analytics.watchName} median price trend`}>
        <title>{analytics.watchName} price trend</title>
        {[0, 0.5, 1].map((ratio) => {
          const value = max - (max - min) * ratio;
          return (
            <g key={ratio}>
              <line x1={padding.left} x2={width - padding.right} y1={y(value)} y2={y(value)} className="analytics-grid-line" />
              <text x={padding.left - 9} y={y(value) + 4} textAnchor="end" className="analytics-axis-label">{Math.round(value).toLocaleString("pl-PL")}</text>
            </g>
          );
        })}
        <path d={`${upperPath} ${lowerPath} Z`} className="analytics-band" />
        <polyline points={medianPath} className="analytics-line" />
        {plotted.map(({ point, index }) => (
          <circle key={`${point.date}-${index}`} cx={x(index)} cy={y(point.medianPrice!)} r="3.5" className="analytics-point">
            <title>{`${formatAnalyticsDate(point.date)} · ${formatAnalyticsPrice(point.medianPrice)}`}</title>
          </circle>
        ))}
      </svg>
      <div className="analytics-chart-labels">
        {labelPoints.map((point) => <span key={point.date}>{formatAnalyticsDate(point.date)}</span>)}
      </div>
    </>
  );
}

function WatchAnalyticsDialog({ watch, onClose }: { watch: Watch; onClose: () => void }) {
  const [days, setDays] = useState(30);
  const [analytics, setAnalytics] = useState<WatchAnalytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void api.watchAnalytics(watch.id, days).then((result) => {
      if (!cancelled) setAnalytics(result);
    }).catch((requestError) => {
      if (!cancelled) setError(errorMessage(requestError));
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [watch.id, days]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const current = analytics?.current;
  const trend = analytics?.medianChangePercent ?? null;
  const trendClass = trend === null ? "" : trend < 0 ? "analytics-value--positive" : trend > 0 ? "analytics-value--negative" : "";
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="modal modal--analytics" role="dialog" aria-modal="true" aria-labelledby="watch-analytics-title">
        <div className="modal-header">
          <div>
            <span className="modal-kicker">Watch analytics</span>
            <h2 id="watch-analytics-title">{watch.name}</h2>
            <p>Daily price movement and current market shape from Scout’s observations.</p>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close watch analytics"><X size={20} /></button>
        </div>
        <div className="modal-body analytics-body">
          <div className="analytics-toolbar">
            <span>{analytics ? `${analytics.totalObservations.toLocaleString("pl-PL")} observations · ${formatAnalyticsDate(analytics.firstObservedAt)}–${formatAnalyticsDate(analytics.lastObservedAt)}` : "Loading observation history…"}</span>
            <div className="analytics-range-options" role="group" aria-label="Analytics time range">
              {[30, 90, 180].map((option) => <button key={option} className={days === option ? "analytics-range-option analytics-range-option--active" : "analytics-range-option"} onClick={() => setDays(option)}>{option}d</button>)}
            </div>
          </div>
          {loading && !analytics ? <div className="analytics-loading"><LoaderCircle size={20} className="spin" />Loading analytics…</div> : null}
          {error ? <div className="analytics-error" role="alert"><AlertTriangle size={16} />{error}</div> : null}
          {analytics && !error ? (
            <>
              <div className="analytics-stat-grid">
                <div className="analytics-stat"><span>Current median</span><strong>{formatAnalyticsPrice(current?.medianPrice ?? null)}</strong><small>latest daily snapshot</small></div>
                <div className="analytics-stat"><span>Trend</span><strong className={trendClass}>{trend === null ? "Learning" : `${trend > 0 ? "+" : ""}${trend.toFixed(1)}%`}</strong><small>versus first day in range</small></div>
                <div className="analytics-stat"><span>Current listings</span><strong>{current?.listingCount ?? 0}</strong><small>latest observed day</small></div>
                <div className="analytics-stat"><span>Strong+ rate</span><strong>{current?.strongDealRate === null || current?.strongDealRate === undefined ? "Learning" : `${current.strongDealRate.toFixed(0)}%`}</strong><small>{current?.strongDealCount ?? 0} qualifying listings</small></div>
              </div>
              <section className="analytics-section">
                <div className="analytics-section-heading"><div><span className="drawer-section-kicker">Price trend</span><h3>Median asking price</h3></div><span>Middle 50% shaded</span></div>
                <div className="analytics-chart-card"><AnalyticsTrendChart analytics={analytics} /></div>
              </section>
              <div className="analytics-detail-grid">
                <section className="analytics-section analytics-section--card">
                  <div className="analytics-section-heading"><div><span className="drawer-section-kicker">Current snapshot</span><h3>Price distribution</h3></div><Database size={16} /></div>
                  <div className="analytics-distribution-grid">
                    <div><span>Lowest</span><strong>{formatAnalyticsPrice(current?.minPrice ?? null)}</strong></div>
                    <div><span>25th percentile</span><strong>{formatAnalyticsPrice(current?.lowerPrice ?? null)}</strong></div>
                    <div><span>Median</span><strong>{formatAnalyticsPrice(current?.medianPrice ?? null)}</strong></div>
                    <div><span>75th percentile</span><strong>{formatAnalyticsPrice(current?.upperPrice ?? null)}</strong></div>
                    <div><span>Highest</span><strong>{formatAnalyticsPrice(current?.maxPrice ?? null)}</strong></div>
                  </div>
                </section>
                <section className="analytics-section analytics-section--card">
                  <div className="analytics-section-heading"><div><span className="drawer-section-kicker">Current snapshot</span><h3>By marketplace</h3></div><Tag size={16} /></div>
                  {analytics.sources.length ? <div className="analytics-source-list">{analytics.sources.map((source) => <div className="analytics-source-row" key={source.source}><span><i style={{ background: marketplaceColors[source.source] }} />{source.source}</span><strong>{formatAnalyticsPrice(source.medianPrice)}</strong><small>{source.listingCount} listing{source.listingCount === 1 ? "" : "s"}</small></div>)}</div> : <div className="analytics-inline-empty">No current listings in this range.</div>}
                </section>
              </div>
              <div className="analytics-note"><Info size={16} /><span>Trend points use one latest observation per listing per day, so frequent polling does not distort the median. Strong+ rate appears after Scout has learned a baseline.</span></div>
            </>
          ) : null}
        </div>
      </section>
    </div>
  );
}

function MarketResearchPage({ refreshKey, onToast }: { refreshKey: number; onToast: (message: string, type?: Toast["type"]) => void }) {
  const [data, setData] = useState<MarketResearchData>({ watches: [], listings: [] });
  const [loading, setLoading] = useState(true);
  const [showDialog, setShowDialog] = useState(false);
  const [editingWatch, setEditingWatch] = useState<MarketWatch | null>(null);
  const [selectedWatch, setSelectedWatch] = useState<string>("All");
  const [status, setStatus] = useState<"All" | "active" | "ended">("All");
  const [busyIds, setBusyIds] = useState<Set<string>>(() => new Set());
  const load = useCallback(async (showLoader = false) => {
    if (showLoader) setLoading(true);
    try { setData(await api.marketResearch()); }
    catch (error) { onToast(errorMessage(error), "error"); }
    finally { if (showLoader) setLoading(false); }
  }, [onToast]);
  useEffect(() => { void load(true); }, [load]);
  useEffect(() => { if (refreshKey) void load(false); }, [load, refreshKey]);
  const withBusy = async (watch: MarketWatch, action: () => Promise<void>) => {
    setBusyIds((current) => new Set(current).add(watch.id));
    try { await action(); } finally { setBusyIds((current) => { const next = new Set(current); next.delete(watch.id); return next; }); }
  };
  const openCreate = () => { setEditingWatch(null); setShowDialog(true); };
  const openEdit = (watch: MarketWatch) => { setEditingWatch(watch); setShowDialog(true); };
  const closeDialog = () => { if (!showDialog) return; setShowDialog(false); setEditingWatch(null); };
  const create = async (input: MarketWatchInput) => {
    const result = await api.createMarketWatch(input); closeDialog(); await load(false); onToast(`${result.watch.name} created. Its first market snapshot is running.`, "info");
  };
  const update = async (input: MarketWatchInput) => {
    if (!editingWatch) return;
    await api.updateMarketWatch(editingWatch.id, input); closeDialog(); await load(false); onToast(`${input.name} filters saved. The next scan will use them.`);
  };
  const toggle = (watch: MarketWatch) => withBusy(watch, async () => { await api.updateMarketWatch(watch.id, { enabled: !watch.enabled }); await load(false); onToast(watch.enabled ? `${watch.name} paused.` : `${watch.name} resumed.`); });
  const scan = (watch: MarketWatch) => withBusy(watch, async () => { const result = await api.scanMarketWatch(watch.id); onToast(`${result.message}. Results will update shortly.`, "info"); });
  const remove = (watch: MarketWatch) => withBusy(watch, async () => { if (!window.confirm(`Delete “${watch.name}” and its saved research history?`)) return; await api.deleteMarketWatch(watch.id); if (selectedWatch === watch.id) setSelectedWatch("All"); await load(false); onToast(`${watch.name} deleted.`); });
  const visible = useMemo(() => data.listings.filter((listing) => selectedWatch === "All" || listing.marketWatchId === selectedWatch).filter((listing) => status === "All" || listing.status === status), [data.listings, selectedWatch, status]);
  const totalEnded = data.watches.reduce((sum, watch) => sum + watch.endedListings, 0);
  const totalActive = data.watches.reduce((sum, watch) => sum + watch.activeListings, 0);
  const endedPrices = data.listings.filter((listing) => listing.status === "ended").map((listing) => listing.lastPrice).sort((a, b) => a - b);
  const overallEstimate = endedPrices.length ? endedPrices[Math.floor(endedPrices.length / 2)] : null;
  return <>
    <PageHeader title="Market research" description="Daily snapshots that reveal asking-price movement and estimate where listings leave the market." action="New research watch" onAction={openCreate} />
    <div className="research-explainer"><BarChart3 size={22} /><div><strong>Track the market, separately from deal alerts.</strong><span>Scout records every observed asking price. After a listing is missing from three successful scans, it is marked ended and its last asking price becomes the sale estimate.</span></div></div>
    <section className="research-stats" aria-label="Market research summary"><Stat label="Research watches" value={String(data.watches.length)} detail={`${data.watches.filter((watch) => watch.enabled).length} active`} /><Stat label="Live listings" value={String(totalActive)} detail="currently observed" /><Stat label="Ended listings" value={String(totalEnded)} detail="estimated outcomes" /><Stat label="Median estimate" value={overallEstimate === null ? "—" : formatPln(overallEstimate)} detail="last asking price" /></section>
    <div className="research-section-heading"><h2>Research watches</h2><span>Default cadence: once every 24 hours</span></div>
    {loading ? <div className="table-loading"><LoaderCircle size={20} className="spin" />Loading market research…</div> : data.watches.length ? <div className="research-watch-list">{data.watches.map((watch) => <article className={`research-watch ${watch.enabled ? "" : "research-watch--paused"}`} key={watch.id}><div className="research-watch-heading"><div><strong>{watch.name}</strong><span>{watch.query}</span></div><span className={`state-chip state-chip--${watch.enabled ? "ready" : "paused"}`}><i />{watch.enabled ? "Active" : "Paused"}</span></div><div className="research-watch-sources">{watch.sources.map((source) => <span key={source}><i style={{ background: marketplaceColors[source] }} />{source}</span>)}</div><MarketWatchFilterSummary watch={watch} /><div className="research-watch-metrics"><div><span>Tracked</span><strong>{watch.totalListings}</strong></div><div><span>Ended</span><strong>{watch.endedListings}</strong></div><div><span>Median estimate</span><strong>{watch.estimatedMedianPrice === null ? "—" : formatPln(watch.estimatedMedianPrice)}</strong></div></div><div className="research-watch-footer"><span><Clock3 size={14} />Every {watch.intervalHours}h · Last {watch.lastScan} · Next {watch.nextScan}</span><div><button className="icon-button" title="Edit research filters" aria-label={`Edit ${watch.name}`} disabled={busyIds.has(watch.id)} onClick={() => openEdit(watch)}><SlidersHorizontal size={16} /></button><button className="icon-button" title="Scan research watch now" aria-label={`Scan ${watch.name} now`} disabled={busyIds.has(watch.id) || !watch.enabled} onClick={() => void scan(watch)}>{busyIds.has(watch.id) ? <LoaderCircle size={16} className="spin" /> : <RefreshCw size={16} />}</button><button className={`toggle ${watch.enabled ? "toggle--on" : ""}`} aria-label={watch.enabled ? `Pause ${watch.name}` : `Resume ${watch.name}`} disabled={busyIds.has(watch.id)} onClick={() => void toggle(watch)}>{watch.enabled ? <Pause size={13} /> : <Play size={13} />}</button><button className="icon-button danger-icon" title="Delete research watch" aria-label={`Delete ${watch.name}`} disabled={busyIds.has(watch.id)} onClick={() => void remove(watch)}><Trash2 size={16} /></button></div></div></article>)}</div> : <div className="page-empty"><BarChart3 size={28} /><strong>No market research watches yet</strong><span>Create one to start collecting daily asking-price snapshots.</span><button className="primary-button" onClick={openCreate}><Plus size={17} />New research watch</button></div>}
    {data.watches.length ? <section className="research-history"><div className="section-heading-row"><h2>Saved listings</h2><div className="filters"><SelectControl value={selectedWatch === "All" ? "All research watches" : data.watches.find((watch) => watch.id === selectedWatch)?.name ?? "All research watches"} options={["All research watches", ...data.watches.map((watch) => watch.name)]} onChange={(value) => setSelectedWatch(value === "All research watches" ? "All" : data.watches.find((watch) => watch.name === value)?.id ?? "All")} /><SelectControl value={status === "All" ? "All statuses" : status === "active" ? "Active" : "Ended"} options={["All statuses", "Active", "Ended"]} onChange={(value) => setStatus(value === "Active" ? "active" : value === "Ended" ? "ended" : "All")} /></div></div><MarketResearchTable listings={visible} /></section> : null}
    {showDialog ? <MarketWatchDialog key={editingWatch?.id ?? "new"} initialWatch={editingWatch} onClose={closeDialog} onSubmit={editingWatch ? update : create} /> : null}
  </>;
}

function MarketWatchFilterSummary({ watch }: { watch: MarketWatch }) {
  const tags: string[] = [];
  if (watch.terms) tags.push(`include: ${watch.terms}`);
  if (watch.excluded) tags.push(`exclude: ${watch.excluded}`);
  if (watch.minPrice !== null || watch.maxPrice !== null) tags.push(`price: ${watch.minPrice === null ? "0" : watch.minPrice.toLocaleString("pl-PL")}–${watch.maxPrice === null ? "∞" : watch.maxPrice.toLocaleString("pl-PL")} zł`);
  if (watch.condition !== "Any") tags.push(`condition: ${watch.condition}`);
  if (watch.location && watch.location !== "Polska") tags.push(`location: ${watch.location}`);
  if (watch.shippingOnly) tags.push("shipping only");
  return <div className="research-watch-filters">{tags.length ? tags.map((tag) => <span key={tag}>{tag}</span>) : <span>All prices · any condition</span>}</div>;
}

function MarketResearchTable({ listings }: { listings: MarketTrackedListing[] }) {
  if (!listings.length) return <div className="empty-state"><Database size={24} /><strong>No saved listings in this view</strong><span>The first successful snapshot will populate this history.</span></div>;
  return <div className="research-table-wrap"><div className="research-table research-table--head"><span>Listing</span><span>Status</span><span>First price</span><span>Last price</span><span>Change</span><span>Observations</span><span>Last seen / ended</span><span /></div>{listings.map((listing) => <div className="research-table research-listing-row" key={listing.id}><div className="research-listing"><MarketThumbnail listing={listing} /><div><strong>{listing.title}</strong><span><i style={{ background: marketplaceColors[listing.marketplace] }} />{listing.marketplace} · {listing.watchName}</span></div></div><span className={`research-status research-status--${listing.status}`}><i />{listing.status === "ended" ? "Ended" : listing.missingScans ? `Checking (${listing.missingScans}/3)` : "Active"}</span><span>{formatPln(listing.firstPrice)}</span><strong>{formatPln(listing.lastPrice)}{listing.status === "ended" ? <small>estimated sold</small> : null}</strong><span className={listing.priceChangePercent < 0 ? "price-down" : listing.priceChangePercent > 0 ? "price-up" : ""}>{listing.priceChangePercent === 0 ? "—" : `${listing.priceChangePercent > 0 ? "+" : ""}${listing.priceChangePercent.toFixed(1)}%`}</span><span>{listing.observations}</span><span>{new Date(listing.endedAt ?? listing.lastSeenAt).toLocaleDateString("pl-PL", { day: "2-digit", month: "short", year: "numeric" })}</span><a href={listing.url} target="_blank" rel="noreferrer" className="external-link" aria-label={`Open ${listing.title}`}><ExternalLink size={17} /></a></div>)}</div>;
}

function MarketThumbnail({ listing }: { listing: MarketTrackedListing }) {
  const [failed, setFailed] = useState(false);
  return listing.image && !failed ? <img src={listing.image} alt="" loading="lazy" onError={() => setFailed(true)} /> : <div className="listing-thumb-placeholder"><Tag size={20} /></div>;
}

function MarketWatchDialog({ initialWatch, onClose, onSubmit }: { initialWatch: MarketWatch | null; onClose: () => void; onSubmit: (watch: MarketWatchInput) => Promise<void> }) {
  const [name, setName] = useState(initialWatch?.name ?? "");
  const [query, setQuery] = useState(initialWatch?.query ?? "");
  const [terms, setTerms] = useState(initialWatch?.terms ?? "");
  const [excluded, setExcluded] = useState(initialWatch?.excluded ?? "");
  const [location, setLocation] = useState(initialWatch?.location ?? "Polska");
  const [condition, setCondition] = useState(initialWatch?.condition ?? "Any");
  const [interval, setIntervalValue] = useState(String(initialWatch?.intervalHours ?? 24));
  const [sources, setSources] = useState<Marketplace[]>(initialWatch?.sources ?? ["OLX", "Allegro Lokalnie", "Vinted"]);
  const [minPrice, setMinPrice] = useState(initialWatch?.minPrice === null || initialWatch?.minPrice === undefined ? "" : String(initialWatch.minPrice));
  const [maxPrice, setMaxPrice] = useState(initialWatch?.maxPrice === null || initialWatch?.maxPrice === undefined ? "" : String(initialWatch.maxPrice));
  const [shippingOnly, setShippingOnly] = useState(initialWatch?.shippingOnly ?? false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const numericInterval = Number(interval);
  const numericMin = minPrice === "" ? null : Number(minPrice);
  const numericMax = maxPrice === "" ? null : Number(maxPrice);
  const validPrices = (numericMin === null || (Number.isFinite(numericMin) && numericMin >= 0)) && (numericMax === null || (Number.isFinite(numericMax) && numericMax > 0)) && (numericMin === null || numericMax === null || numericMin <= numericMax);
  const valid = Boolean(name.trim() && query.trim() && sources.length && Number.isInteger(numericInterval) && numericInterval >= 6 && numericInterval <= 168 && validPrices);
  useEffect(() => { const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !submitting) onClose(); }; window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey); }, [onClose, submitting]);
  const toggleSource = (source: Marketplace) => setSources((current) => current.includes(source) ? current.filter((item) => item !== source) : [...current, source]);
  const submit = async () => {
    if (!valid) return;
    setSubmitting(true); setError(null);
    try { await onSubmit({ name: name.trim(), query: query.trim(), terms: terms.trim(), excluded: excluded.trim(), location: location.trim() || "Polska", condition, sources, intervalHours: numericInterval, minPrice: numericMin, maxPrice: numericMax, shippingOnly }); }
    catch (submitError) { setError(errorMessage(submitError)); setSubmitting(false); }
  };
  const editing = Boolean(initialWatch);
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !submitting && onClose()}><section className="modal" role="dialog" aria-modal="true" aria-labelledby="market-watch-title"><div className="modal-header"><div><span className="modal-kicker">Market research</span><h2 id="market-watch-title">{editing ? "Edit research watch" : "New research watch"}</h2><p>{editing ? "Adjust the search and price filters used by future snapshots." : "Save recurring search snapshots and estimate where listings leave the market."}</p></div><button className="icon-button" disabled={submitting} onClick={onClose} aria-label="Close"><X size={20} /></button></div><div className="modal-body"><label className="field-label">Watch name<input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Used RTX 4070 market" /></label><label className="field-label">Search phrase<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="e.g. RTX 4070" /></label><div className="field-row"><label className="field-label">Included terms<input value={terms} onChange={(event) => setTerms(event.target.value)} placeholder="e.g. 12gb, founders edition" /></label><label className="field-label">Excluded terms<input value={excluded} onChange={(event) => setExcluded(event.target.value)} placeholder="e.g. broken, parts" /></label></div><div className="field-row"><label className="field-label">Location <span>where available</span><input value={location} onChange={(event) => setLocation(event.target.value)} placeholder="Anywhere" /></label><label className="field-label">Condition<select value={condition} onChange={(event) => setCondition(event.target.value)}><option>Any</option><option>New</option><option>Used</option><option>Like new</option><option>Very good</option><option>Good</option></select></label></div><div className="field-row"><label className="field-label">Minimum price <span>PLN · optional</span><input type="number" min="0" step="1" value={minPrice} onChange={(event) => setMinPrice(event.target.value)} placeholder="No minimum" /></label><label className="field-label">Maximum price <span>PLN · optional</span><input type="number" min="1" step="1" value={maxPrice} onChange={(event) => setMaxPrice(event.target.value)} placeholder="No maximum" /></label></div><div className="field-row"><label className="field-label">Snapshot interval <span>6–168 hours</span><input type="number" min="6" max="168" value={interval} onChange={(event) => setIntervalValue(event.target.value)} /></label><div className="field-label"><span>Sources</span><div className="source-options">{(["OLX", "Allegro Lokalnie", "Vinted"] as Marketplace[]).map((source) => <button type="button" key={source} className={`source-option ${sources.includes(source) ? "source-option--selected" : ""}`} onClick={() => toggleSource(source)}><i style={{ background: marketplaceColors[source] }} />{source}{sources.includes(source) ? <Check size={15} /> : null}</button>)}</div></div></div><label className="check-option check-option--modal"><input type="checkbox" checked={shippingOnly} onChange={(event) => setShippingOnly(event.target.checked)} /><span><strong>Require shipping</strong><small>Only save listings with confirmed delivery options</small></span></label>{error ? <div className="form-error" role="alert"><AlertTriangle size={15} />{error}</div> : null}{!validPrices ? <div className="form-error" role="alert"><AlertTriangle size={15} />Minimum price cannot exceed maximum price.</div> : null}<div className="modal-note"><Info size={16} /><span>Scout cannot see private checkout prices. “Estimated sold” means the last public asking price before three consecutive successful scans no longer found the listing.</span></div></div><div className="modal-footer"><button className="outline-button" disabled={submitting} onClick={onClose}>Cancel</button><button className="primary-button" disabled={!valid || submitting} onClick={submit}>{submitting ? <LoaderCircle size={17} className="spin" /> : editing ? <Check size={17} /> : <Plus size={17} />}{submitting ? "Saving…" : editing ? "Save research watch" : "Create research watch"}</button></div></section></div>;
}

function ListingsPage({
  listings,
  selectedWatchName,
  onClearWatch,
  onSelectListing,
}: {
  listings: Listing[];
  selectedWatchName: string | null;
  onClearWatch: () => void;
  onSelectListing: (listing: Listing) => void;
}) {
  const [search, setSearch] = useState("");
  const [marketplace, setMarketplace] = useState<"All" | Marketplace>("All");
  const [sort, setSort] = useState<"Newest" | "Strongest" | "Price">("Newest");
  const [decision, setDecision] = useState<"All" | ListingDecision>("All");
  const filtered = useMemo(
    () =>
      listings
        .filter(
          (listing) =>
            marketplace === "All" || listing.marketplace === marketplace,
        )
        .filter(
          (listing) =>
            !selectedWatchName || listing.watch === selectedWatchName,
        )
        .filter((listing) =>
          `${listing.title} ${listing.subtitle} ${listing.condition ?? ""} ${listing.location ?? ""}`
            .toLowerCase()
            .includes(search.toLowerCase()),
        )
        .filter((listing) => decision === "All" || listing.decision === decision)
        .slice()
        .sort((a, b) =>
          sort === "Strongest"
            ? b.dealStrength - a.dealStrength
            : sort === "Price"
              ? a.price - b.price
              : Date.parse(b.observedAt) - Date.parse(a.observedAt),
        ),
    [listings, marketplace, search, selectedWatchName, sort, decision],
  );
  return (
    <>
      <PageHeader
        title="Listings"
        description="Every normalized match, with the baseline behind the deal score."
      />
      <div className="toolbar toolbar--listings">
        <label className="search-input">
          <Search size={17} />
          <input
            aria-label="Search listings"
            placeholder="Search title or condition"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <SelectControl
          value={marketplace === "All" ? "All marketplaces" : marketplace}
          options={["All marketplaces", "OLX", "Allegro Lokalnie", "Vinted"]}
          onChange={(value) =>
            setMarketplace(
              value === "All marketplaces" ? "All" : (value as Marketplace),
            )
          }
        />
        <SelectControl
          value={
            sort === "Newest"
              ? "Newest first"
              : sort === "Strongest"
                ? "Strongest first"
                : "Lowest price"
          }
          options={["Newest first", "Strongest first", "Lowest price"]}
          onChange={(value) =>
            setSort(
              value === "Strongest first"
                ? "Strongest"
                : value === "Lowest price"
                  ? "Price"
                  : "Newest",
            )
          }
        />
        <SelectControl
          value={decision === "All" ? "All decisions" : decision === "buy" ? "Buy" : decision === "watch" ? "Watch" : "Pass"}
          options={["All decisions", "Buy", "Watch", "Pass"]}
          onChange={(value) => setDecision(value === "Buy" ? "buy" : value === "Watch" ? "watch" : value === "Pass" ? "pass" : "All")}
        />
      </div>
      {selectedWatchName ? (
        <div className="active-filter">
          <span>
            Showing listings for <strong>{selectedWatchName}</strong>
          </span>
          <button onClick={onClearWatch}>
            <X size={14} />
            Clear filter
          </button>
        </div>
      ) : null}
      <ListingTable listings={filtered} onSelect={onSelectListing} />
      <div className="retention-note">
        <Database size={17} />
        <span>
          Listing history is retained for 180 days. Thumbnail cache is pruned
          separately.
        </span>
      </div>
    </>
  );
}

function PriceSparkline({ points }: { points: PriceHistoryPoint[] }) {
  if (!points.length) return <div className="price-chart-empty">No saved price observations yet.</div>;
  const values = points.map((point) => point.price);
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const padding = Math.max((maximum - minimum) * 0.14, Math.max(maximum, 1) * 0.025, 1);
  const chartMinimum = Math.max(0, minimum - padding);
  const chartMaximum = maximum + padding;
  const coordinates = points.map((point, index) => {
    const x = points.length === 1 ? 50 : (index / (points.length - 1)) * 100;
    const y = 88 - ((point.price - chartMinimum) / Math.max(chartMaximum - chartMinimum, 1)) * 76;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });
  const latest = coordinates[coordinates.length - 1].split(",");
  return (
    <svg className="price-chart" viewBox="0 0 100 100" role="img" aria-label="Listing price history">
      <defs>
        <linearGradient id="price-chart-fill" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="var(--blue)" stopOpacity=".18" />
          <stop offset="1" stopColor="var(--blue)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`M ${coordinates.join(" L ")} L 100,100 L 0,100 Z`} fill="url(#price-chart-fill)" />
      <polyline points={coordinates.join(" ")} fill="none" stroke="var(--blue)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      <circle cx={latest[0]} cy={latest[1]} r="3.2" fill="var(--surface)" stroke="var(--blue)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function ListingDetailDrawer({
  listing,
  onClose,
  onUpdated,
}: {
  listing: Listing;
  onClose: () => void;
  onUpdated: (listing: Listing) => void;
}) {
  const [detail, setDetail] = useState<ListingDetail>({
    listing,
    history: [],
    action: { decision: listing.decision ?? null, note: listing.note ?? '', updatedAt: null },
    firstSeenAt: listing.observedAt,
    lastSeenAt: listing.observedAt,
  });
  const [decision, setDecision] = useState<ListingDecision | null>(listing.decision ?? null);
  const [note, setNote] = useState(listing.note ?? "");
  const [shippingCost, setShippingCost] = useState("");
  const [extraCost, setExtraCost] = useState("");
  const [resalePrice, setResalePrice] = useState(listing.typical === null ? "" : String(listing.typical));
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const currentListing = detail.listing;
  const totalCost = currentListing.price + (Number(shippingCost) || 0) + (Number(extraCost) || 0);
  const expectedResale = resalePrice === "" ? null : Number(resalePrice);
  const expectedProfit = expectedResale === null || !Number.isFinite(expectedResale) ? null : expectedResale - totalCost;
  const expectedMargin = expectedProfit === null || totalCost <= 0 ? null : (expectedProfit / totalCost) * 100;
  const typicalSavings = currentListing.typical === null ? null : currentListing.typical - totalCost;

  useEffect(() => {
    let active = true;
    const fallback: ListingDetail = {
      listing,
      history: [],
      action: { decision: listing.decision ?? null, note: listing.note ?? '', updatedAt: null },
      firstSeenAt: listing.observedAt,
      lastSeenAt: listing.observedAt,
    };
    setDetail(fallback);
    setDecision(listing.decision ?? null);
    setNote(listing.note ?? "");
    setResalePrice(listing.typical === null ? "" : String(listing.typical));
    setShippingCost("");
    setExtraCost("");
    setError(null);
    setLoading(true);
    api
      .listingDetail(listing.id)
      .then((result) => {
        if (!active) return;
        setDetail(result);
        setDecision(result.action.decision);
        setNote(result.action.note);
        if (result.listing.typical !== null) setResalePrice(String(result.listing.typical));
      })
      .catch(async () => {
        // Manual search results do not have stored observations yet, but their triage action can still persist.
        try {
          const action = await api.listingAction(listing.id);
          if (!active) return;
          setDetail((current) => ({ ...current, action }));
          setDecision(action.decision);
          setNote(action.note);
        } catch {
          // The listing itself remains useful when the API is offline or the result is not stored.
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [listing.id]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, saving]);

  const saveAction = async (nextDecision = decision) => {
    setSaving(true);
    setError(null);
    try {
      const result = await api.updateListingAction(listing.id, { decision: nextDecision, note });
      const updatedListing = { ...detail.listing, decision: result.action.decision, note: result.action.note };
      setDetail((current) => ({ ...current, listing: updatedListing, action: result.action }));
      setDecision(result.action.decision);
      setNote(result.action.note);
      onUpdated(updatedListing);
    } catch (saveError) {
      setError(errorMessage(saveError));
    } finally {
      setSaving(false);
    }
  };

  const chartPoints = detail.history.length
    ? detail.history
    : [{ price: currentListing.price, observedAt: currentListing.observedAt }];
  const lastPoint = chartPoints[chartPoints.length - 1];
  return (
    <div
      className="listing-drawer-backdrop"
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && !saving && onClose()}
    >
      <aside className="listing-drawer" role="dialog" aria-modal="true" aria-labelledby="listing-detail-title">
        <div className="listing-drawer-header">
          <div>
            <span className="drawer-kicker">{currentListing.marketplace} · {currentListing.watch}</span>
            <h2 id="listing-detail-title">{currentListing.title}</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close listing details">
            <X size={20} />
          </button>
        </div>
        <div className="listing-drawer-body">
          <div className="drawer-hero">
            <div className="drawer-image-wrap">
              <ListingThumbnail listing={currentListing} />
            </div>
            <div className="drawer-hero-copy">
              <strong className="drawer-price">{formatPln(currentListing.price)}</strong>
              <span>{currentListing.typical === null ? "Baseline is still learning" : `${Math.abs(currentListing.belowTypical ?? 0).toFixed(1)}% below typical`}</span>
              <small>{currentListing.condition || "Condition not specified"}{currentListing.location ? ` · ${currentListing.location}` : ""}</small>
            </div>
          </div>

          <section className="drawer-section drawer-section--decision">
            <div className="drawer-section-heading">
              <div><span className="drawer-section-kicker">Triage</span><h3>What do you want to do?</h3></div>
              {decision ? <span className={`decision-chip decision-chip--${decision}`}>{decision === "buy" ? "Buy" : decision === "watch" ? "Watch" : "Pass"}</span> : null}
            </div>
            <div className="decision-grid">
              {(["buy", "watch", "pass"] as ListingDecision[]).map((option) => {
                const Icon = option === "buy" ? Check : option === "watch" ? Bell : X;
                const label = option === "buy" ? "Buy" : option === "watch" ? "Watch" : "Pass";
                return (
                  <button
                    type="button"
                    key={option}
                    className={`decision-button decision-button--${option} ${decision === option ? "decision-button--active" : ""}`}
                    disabled={saving}
                    onClick={() => void saveAction(option)}
                  >
                    <Icon size={16} />{label}
                  </button>
                );
              })}
            </div>
            {decision ? <button className="clear-decision" type="button" disabled={saving} onClick={() => void saveAction(null)}>Clear decision</button> : null}
            <label className="drawer-note-label">
              Note
              <textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="e.g. Ask for a battery-health screenshot" />
            </label>
            <button className="outline-button drawer-save-note" type="button" disabled={saving} onClick={() => void saveAction()}>
              {saving ? <LoaderCircle size={15} className="spin" /> : <Check size={15} />}
              {saving ? "Saving…" : "Save note"}
            </button>
            {error ? <div className="form-error" role="alert"><AlertTriangle size={15} />{error}</div> : null}
          </section>

          <section className="drawer-section">
            <div className="drawer-section-heading">
              <div><span className="drawer-section-kicker">Evidence</span><h3>Price history</h3></div>
              {loading ? <LoaderCircle size={16} className="spin" /> : <span className="drawer-muted">{detail.history.length ? `${detail.history.length} observations` : "First look"}</span>}
            </div>
            <div className="price-chart-card"><PriceSparkline points={chartPoints} /><div className="price-chart-labels"><span>{formatPln(Math.min(...chartPoints.map((point) => point.price)))}</span><strong>Latest {formatPln(lastPoint.price)}</strong><span>{formatPln(Math.max(...chartPoints.map((point) => point.price)))}</span></div></div>
            <div className="drawer-meta-grid">
              <div><span>First seen</span><strong>{new Date(detail.firstSeenAt).toLocaleDateString("pl-PL", { day: "2-digit", month: "short" })}</strong></div>
              <div><span>Last seen</span><strong>{new Date(detail.lastSeenAt).toLocaleDateString("pl-PL", { day: "2-digit", month: "short" })}</strong></div>
              <div><span>Shipping</span><strong>{currentListing.shippingAvailable === true ? "Available" : currentListing.shippingAvailable === false ? "Pickup only" : "Unknown"}</strong></div>
            </div>
          </section>

          <section className="drawer-section drawer-section--calculator">
            <div className="drawer-section-heading">
              <div><span className="drawer-section-kicker">Scenario</span><h3>Total cost & resale</h3></div>
              <Calculator size={17} />
            </div>
            <p className="drawer-section-copy">Estimate what this deal costs after delivery and what is left if you resell it.</p>
            <div className="calculator-fields">
              <label className="field-label">Shipping / fees <span>PLN</span><input type="number" min="0" step="1" value={shippingCost} onChange={(event) => setShippingCost(event.target.value)} placeholder="0" /></label>
              <label className="field-label">Other cost <span>PLN</span><input type="number" min="0" step="1" value={extraCost} onChange={(event) => setExtraCost(event.target.value)} placeholder="0" /></label>
              <label className="field-label">Expected resale <span>PLN</span><input type="number" min="0" step="1" value={resalePrice} onChange={(event) => setResalePrice(event.target.value)} placeholder="Add estimate" /></label>
            </div>
            <div className="calculator-results">
              <div><span>Total cost</span><strong>{formatPln(totalCost)}</strong></div>
              <div><span>Expected profit</span><strong className={expectedProfit === null ? "" : expectedProfit >= 0 ? "result-positive" : "result-negative"}>{expectedProfit === null ? "Add resale" : formatPln(expectedProfit)}</strong></div>
              <div><span>Margin</span><strong className={expectedMargin === null ? "" : expectedMargin >= 0 ? "result-positive" : "result-negative"}>{expectedMargin === null ? "—" : `${expectedMargin.toFixed(1)}%`}</strong></div>
            </div>
            {typicalSavings !== null ? <div className={`calculator-callout ${typicalSavings >= 0 ? "calculator-callout--positive" : "calculator-callout--negative"}`}><Info size={15} />{typicalSavings >= 0 ? `${formatPln(typicalSavings)} below the learned typical price after extra costs.` : `${formatPln(Math.abs(typicalSavings))} above the learned typical price after extra costs.`}</div> : null}
          </section>
        </div>
        <div className="listing-drawer-footer">
          <span>{currentListing.observed}</span>
          <a className="primary-button" href={currentListing.url} target="_blank" rel="noreferrer"><ExternalLink size={16} />Open listing</a>
        </div>
      </aside>
    </div>
  );
}

function ConnectorsPage({
  connectors,
  scanning,
  onScan,
  onHistory,
  onToast,
}: {
  connectors: Connector[];
  scanning: boolean;
  onScan: () => void;
  onHistory: () => void;
  onToast: (message: string, type?: Toast["type"]) => void;
}) {
  const [runs, setRuns] = useState<ConnectorRun[]>([]);
  const [loadingRuns, setLoadingRuns] = useState(true);
  const [testing, setTesting] = useState(false);
  const loadRuns = useCallback(async () => {
    try {
      setRuns((await api.connectorRuns()).runs);
    } catch (error) {
      onToast(errorMessage(error), "error");
    } finally {
      setLoadingRuns(false);
    }
  }, [onToast]);
  useEffect(() => {
    void loadRuns();
  }, [loadRuns]);
  const testWebhook = async () => {
    setTesting(true);
    try {
      await api.testWebhook();
      onToast("Discord test delivered.");
      await loadRuns();
    } catch (error) {
      onToast(errorMessage(error), "error");
    } finally {
      setTesting(false);
    }
  };
  const testNtfy = async () => {
    setTesting(true);
    try {
      await api.testNtfy();
      onToast("ntfy test delivered.");
      await loadRuns();
    } catch (error) {
      onToast(errorMessage(error), "error");
    } finally {
      setTesting(false);
    }
  };
  const connectorColor = (source: string) =>
    connectors.find((connector) => connector.name === source)?.color ??
    "#8a94a6";
  return (
    <>
      <PageHeader
        title="Connectors"
        description="Public-page health, pacing, and notification delivery."
        action={scanning ? "Queueing…" : "Scan now"}
        actionIcon={
          scanning ? (
            <LoaderCircle size={18} className="spin" />
          ) : (
            <RefreshCw size={18} />
          )
        }
        actionDisabled={scanning}
        onAction={onScan}
      />
      <div className="connector-banner">
        <div className="banner-icon">
          <Activity size={22} />
        </div>
        <div>
          <strong>Monitoring is best-effort by design.</strong>
          <span>
            Failures are recorded per source; one blocked marketplace never
            stops the others.
          </span>
        </div>
        <button onClick={onHistory}>
          Notification history <ArrowRight size={16} />
        </button>
      </div>
      <div className="connector-cards">
        {connectors.map((connector) => (
          <ConnectorCard
            connector={connector}
            key={connector.name}
            testing={testing}
            onTest={connector.name === "Discord" ? testWebhook : connector.name === "ntfy" ? testNtfy : undefined}
          />
        ))}
      </div>
      <div className="connector-runs">
        <div className="section-heading-row">
          <h2>Recent connector runs</h2>
          <button
            className="icon-button"
            aria-label="Refresh connector runs"
            onClick={() => {
              setLoadingRuns(true);
              void loadRuns();
            }}
          >
            <RefreshCw size={16} className={loadingRuns ? "spin" : ""} />
          </button>
        </div>
        <div className="run-table">
          <div className="run-head">
            <span>Source</span>
            <span>Result</span>
            <span>Duration</span>
            <span>Started</span>
          </div>
          {loadingRuns ? (
            <div className="table-loading">
              <LoaderCircle size={18} className="spin" />
              Loading runs…
            </div>
          ) : runs.length ? (
            runs.map((run) => (
              <div className="run-row" key={run.id}>
                <span className="connector-name">
                  <i style={{ background: connectorColor(run.source) }} />
                  {run.source}
                </span>
                <span className={`run-result run-result--${run.status}`}>
                  <i />
                  {run.status === "ok"
                    ? "Completed"
                    : run.status === "running"
                      ? "Running"
                      : "Failed"}
                </span>
                <span>{run.duration}</span>
                <span title={run.startedAt}>
                  {new Date(run.startedAt).toLocaleString("pl-PL", {
                    month: "short",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
              </div>
            ))
          ) : (
            <div className="panel-empty panel-empty--large">
              No connector runs yet. Start a scan to test the selected sources.
            </div>
          )}
        </div>
      </div>
    </>
  );
}
function ConnectorCard({
  connector,
  testing,
  onTest,
}: {
  connector: Connector;
  testing: boolean;
  onTest?: () => void;
}) {
  const configured =
    (connector.name !== "Discord" && connector.name !== "ntfy") ||
    !connector.detail.toLowerCase().includes("not configured");
  return (
    <article className="connector-card">
      <div className="connector-card-top">
        <span className="connector-logo" style={{ color: connector.color }}>
          {connector.kind === "discord"
            ? "D"
            : connector.kind === "ntfy"
              ? "N"
              : connector.name === "Allegro Lokalnie"
                ? "A"
                : connector.name[0]}
        </span>
        <span
          className={`status-pill status-pill--${connector.status.toLowerCase()}`}
        >
          <i />
          {connector.status}
        </span>
      </div>
      <h3>{connector.name}</h3>
      <p>{connector.detail}</p>
      <div className="connector-metrics">
        <div>
          <span>Runs</span>
          <strong>{connector.requests}</strong>
        </div>
        <div>
          <span>Last duration</span>
          <strong>{connector.latency}</strong>
        </div>
        <div>
          <span>Last good</span>
          <strong>{connector.lastSuccess}</strong>
        </div>
      </div>
      {onTest ? (
        <button
          className="outline-button connector-test"
          disabled={testing || !configured}
          onClick={onTest}
        >
          {testing ? (
            <LoaderCircle size={15} className="spin" />
          ) : (
            <Send size={15} />
          )}
          {configured
            ? testing
              ? "Sending…"
              : connector.kind === "ntfy" ? "Test ntfy notification" : "Test webhook"
            : "Configure in Settings"}
        </button>
      ) : null}
    </article>
  );
}

function SettingsPage({
  theme,
  onTheme,
  onToast,
  onHistory,
}: {
  theme: Theme;
  onTheme: (theme: Theme) => void;
  onToast: (message: string, type?: Toast["type"]) => void;
  onHistory: () => void;
}) {
  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [webhook, setWebhook] = useState("");
  const [interval, setIntervalValue] = useState("5");
  const [nightInterval, setNightInterval] = useState("30");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testingNtfy, setTestingNtfy] = useState(false);
  const [discordMinimumPriority, setDiscordMinimumPriority] = useState<NotificationPriority>("strong");
  const [ntfyServerUrl, setNtfyServerUrl] = useState("https://ntfy.sh");
  const [ntfyTopic, setNtfyTopic] = useState("");
  const [ntfyToken, setNtfyToken] = useState("");
  const [ntfyMinimumPriority, setNtfyMinimumPriority] = useState<NotificationPriority>("exceptional");
  const [sessionMarketplace, setSessionMarketplace] = useState<Marketplace>("OLX");
  const [sessionLabel, setSessionLabel] = useState("");
  const [storageStateInput, setStorageStateInput] = useState("");
  const [storageStateFile, setStorageStateFile] = useState("");
  const [savingSession, setSavingSession] = useState(false);
  const loadSettings = useCallback(async () => {
    try {
      const result = await api.settings();
      setSettings(result);
      setIntervalValue(String(result.defaultInterval));
      setNightInterval(String(result.nightInterval));
      setDiscordMinimumPriority(result.discordMinimumPriority);
      setNtfyServerUrl(result.ntfy?.serverUrl ?? "https://ntfy.sh");
      setNtfyMinimumPriority(result.ntfy?.minimumPriority ?? "exceptional");
    } catch (error) {
      onToast(errorMessage(error), "error");
    }
  }, [onToast]);
  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);
  const save = async () => {
    const numericInterval = Number(interval);
    const numericNightInterval = Number(nightInterval);
    if (
      !Number.isInteger(numericInterval) ||
      numericInterval < 5 ||
      numericInterval > 1440
    ) {
      onToast("Polling interval must be between 5 and 1440 minutes.", "error");
      return;
    }
    if (
      !Number.isInteger(numericNightInterval) ||
      numericNightInterval < 5 ||
      numericNightInterval > 1440
    ) {
      onToast("Night polling interval must be between 5 and 1440 minutes.", "error");
      return;
    }
    setSaving(true);
    try {
      const ntfyTouched = Boolean(
        settings?.ntfy?.configured ||
        ntfyTopic.trim() ||
        ntfyToken.trim() ||
        ntfyServerUrl.trim() !== "https://ntfy.sh",
      );
      const result = await api.saveSettings({
        interval: numericInterval,
        nightInterval: numericNightInterval,
        webhook: webhook.trim() || undefined,
        discordMinimumPriority,
        ntfy: ntfyTouched
          ? {
              serverUrl: ntfyServerUrl.trim() || undefined,
              topic: ntfyTopic.trim() || undefined,
              token: ntfyToken.trim() || undefined,
              minimumPriority: ntfyMinimumPriority,
            }
          : undefined,
      });
      setSettings(result);
      setIntervalValue(String(result.defaultInterval));
      setNightInterval(String(result.nightInterval));
      setWebhook("");
      setNtfyTopic("");
      setNtfyToken("");
      setNtfyServerUrl(result.ntfy?.serverUrl ?? "https://ntfy.sh");
      onToast("Settings saved securely.");
    } catch (error) {
      onToast(errorMessage(error), "error");
    } finally {
      setSaving(false);
    }
  };
  const clearWebhook = async () => {
    if (!window.confirm("Remove the saved Discord webhook?")) return;
    setSaving(true);
    try {
      setSettings(
        await api.saveSettings({
          interval: Number(interval),
          clearWebhook: true,
        }),
      );
      onToast("Discord webhook removed.");
    } catch (error) {
      onToast(errorMessage(error), "error");
    } finally {
      setSaving(false);
    }
  };
  const testWebhook = async () => {
    setTesting(true);
    try {
      await api.testWebhook();
      onToast("Discord test delivered.");
    } catch (error) {
      onToast(errorMessage(error), "error");
    } finally {
      setTesting(false);
    }
  };
  const clearNtfy = async () => {
    if (!window.confirm("Remove the saved ntfy configuration?")) return;
    setSaving(true);
    try {
      const result = await api.saveSettings({
        interval: Number(interval),
        clearNtfy: true,
      });
      setSettings(result);
      setNtfyServerUrl("https://ntfy.sh");
      setNtfyTopic("");
      setNtfyToken("");
      setNtfyMinimumPriority(result.ntfy?.minimumPriority ?? "exceptional");
      onToast("ntfy configuration removed.");
    } catch (error) {
      onToast(errorMessage(error), "error");
    } finally {
      setSaving(false);
    }
  };
  const testNtfy = async () => {
    setTestingNtfy(true);
    try {
      await api.testNtfy();
      onToast("ntfy test delivered.");
    } catch (error) {
      onToast(errorMessage(error), "error");
    } finally {
      setTestingNtfy(false);
    }
  };
  const saveMarketplaceSession = async () => {
    if (!storageStateInput.trim()) {
      onToast("Choose a storage-state JSON file or paste its contents.", "error");
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(storageStateInput);
    } catch {
      onToast("Storage-state input must be valid JSON.", "error");
      return;
    }
    setSavingSession(true);
    try {
      setSettings(await api.saveMarketplaceSession(sessionMarketplace, sessionLabel, parsed));
      setStorageStateInput("");
      setStorageStateFile("");
      onToast(`${sessionMarketplace} session saved securely.`);
    } catch (error) {
      onToast(errorMessage(error), "error");
    } finally {
      setSavingSession(false);
    }
  };
  const removeMarketplaceSession = async (marketplace: Marketplace) => {
    if (!window.confirm(`Remove the saved ${marketplace} session?`)) return;
    setSavingSession(true);
    try {
      setSettings(await api.deleteMarketplaceSession(marketplace));
      if (marketplace === sessionMarketplace) {
        setStorageStateInput("");
        setStorageStateFile("");
      }
      onToast(`${marketplace} session removed.`);
    } catch (error) {
      onToast(errorMessage(error), "error");
    } finally {
      setSavingSession(false);
    }
  };
  const configured = settings?.webhookConfigured ?? false;
  const ntfyConfigured = settings?.ntfy?.configured ?? false;
  const settingsLoaded = settings !== null;
  return (
    <>
      <PageHeader
        title="Settings"
        description="Keep Scout quiet, safe, and easy to operate on your home server."
      />
      <div className="settings-grid">
        <section className="settings-section">
          <div className="settings-section-heading">
            <div className="settings-symbol">
              <Sun size={18} />
            </div>
            <div>
              <h2>Appearance</h2>
              <p>Choose how the dashboard looks on this device.</p>
            </div>
          </div>
          <div className="theme-options">
            {(["light", "dark", "system"] as Theme[]).map((choice) => (
              <button
                key={choice}
                className={`theme-option ${theme === choice ? "theme-option--selected" : ""}`}
                onClick={() => onTheme(choice)}
              >
                {choice === "light" ? (
                  <Sun size={18} />
                ) : choice === "dark" ? (
                  <Moon size={18} />
                ) : (
                  <Settings2 size={18} />
                )}
                <span>{choice[0].toUpperCase() + choice.slice(1)}</span>
                {theme === choice ? <Check size={16} /> : null}
              </button>
            ))}
          </div>
        </section>
        <section className="settings-section">
          <div className="settings-section-heading">
            <div className="settings-symbol">
              <SlidersHorizontal size={18} />
            </div>
            <div>
              <h2>Scan defaults</h2>
              <p>New watches use these values unless overridden.</p>
            </div>
          </div>
          <div className="field-row">
            <label className="field-label">
              Default polling interval <span>minutes</span>
              <input
                type="number"
                min="5"
                max="1440"
                value={interval}
                onChange={(event) => setIntervalValue(event.target.value)}
              />
            </label>
            <label className="field-label">
              Night polling interval <span>22:00–08:00 · server local time</span>
              <input
                type="number"
                min="5"
                max="1440"
                value={nightInterval}
                onChange={(event) => setNightInterval(event.target.value)}
              />
            </label>
          </div>
          <div className="field-help">
            <Info size={15} />
            Night polling is a floor: watches that already run slower will not
            be accelerated. The default is 30 minutes overnight.
          </div>
        </section>
        <section className="settings-section settings-section--wide">
          <div className="settings-section-heading">
            <div className="settings-symbol settings-symbol--blue">
              <ShieldCheck size={18} />
            </div>
            <div>
              <h2>Marketplace accounts</h2>
              <p>
                Use a session from your own logged-in browser to keep requests
                associated with your account.
              </p>
            </div>
          </div>
          <div className="session-status-list">
            {(settings?.marketplaceSessions ?? []).map((session) => (
              <div className="session-status-row" key={session.marketplace}>
                <i className={session.connected ? "session-dot session-dot--connected" : "session-dot"} />
                <div>
                  <strong>{session.marketplace}{session.label ? ` · ${session.label}` : ""}</strong>
                  <span>{session.detail}</span>
                </div>
                {session.createdAt ? (
                  <button
                    className="link-button danger-link"
                    disabled={savingSession}
                    onClick={() => void removeMarketplaceSession(session.marketplace)}
                  >
                    Remove
                  </button>
                ) : null}
              </div>
            ))}
          </div>
          <div className="field-row">
            <label className="field-label">
              Marketplace
              <select value={sessionMarketplace} onChange={(event) => setSessionMarketplace(event.target.value as Marketplace)}>
                {(["OLX", "Allegro Lokalnie", "Vinted"] as Marketplace[]).map((marketplace) => <option key={marketplace}>{marketplace}</option>)}
              </select>
            </label>
            <label className="field-label">
              Label <span>optional</span>
              <input value={sessionLabel} onChange={(event) => setSessionLabel(event.target.value)} placeholder="e.g. personal account" maxLength={80} />
            </label>
          </div>
          <label className="field-label">
            Playwright storage-state JSON
            <textarea
              value={storageStateInput}
              onChange={(event) => { setStorageStateInput(event.target.value); setStorageStateFile(""); }}
              placeholder={'{"cookies":[...],"origins":[...]}' }
              spellCheck={false}
              autoComplete="off"
            />
          </label>
          <div className="settings-actions">
            <label className="outline-button file-button">
              <input
                type="file"
                accept="application/json,.json"
                onChange={async (event) => {
                  const file = event.currentTarget.files?.[0];
                  if (!file) return;
                  try {
                    setStorageStateInput(await file.text());
                    setStorageStateFile(file.name);
                  } catch {
                    onToast("Could not read the storage-state file.", "error");
                  }
                }}
              />
              {storageStateFile || "Choose JSON file"}
            </label>
            <button className="primary-button" disabled={savingSession || !settingsLoaded} onClick={() => void saveMarketplaceSession()}>
              {savingSession ? <LoaderCircle size={16} className="spin" /> : <ShieldCheck size={16} />}
              {savingSession ? "Saving…" : "Save session"}
            </button>
          </div>
          <div className="security-note">
            <ShieldCheck size={17} />
            <span>
              Log in manually, export Playwright storage state, and import it
              here. Scout encrypts it with SCOUT_SECRET and never returns it.
              Do not paste a raw Cookie header or share the JSON.
            </span>
          </div>
        </section>
        <section className="settings-section settings-section--wide">
          <div className="settings-section-heading">
            <div className="settings-symbol settings-symbol--blue">
              <Send size={18} />
            </div>
            <div>
              <h2>Discord notifications</h2>
              <p>
                One idempotent embed per qualifying listing. The webhook is
                encrypted at rest.
              </p>
            </div>
            <span
              className={`settings-status ${configured ? "" : "settings-status--idle"}`}
            >
              <i />
              {settingsLoaded
                ? configured
                  ? "Configured"
                  : "Not configured"
                : "Loading…"}
            </span>
          </div>
          <label className="field-label">
            Webhook URL
            <input
              type="url"
              autoComplete="off"
              disabled={!settingsLoaded}
              placeholder={
                configured
                  ? (settings?.webhookMasked ?? "Saved webhook")
                  : "https://discord.com/api/webhooks/…"
              }
              value={webhook}
              onChange={(event) => setWebhook(event.target.value)}
            />
          </label>
          <label className="field-label">
            Minimum deal priority <span>Discord channel filter</span>
            <select value={discordMinimumPriority} onChange={(event) => setDiscordMinimumPriority(event.target.value as NotificationPriority)}>
              <option value="strong">Strong and above</option>
              <option value="very-strong">Very strong and above</option>
              <option value="exceptional">Exceptional only</option>
            </select>
          </label>
          <div className="settings-actions">
            <button
              className="outline-button"
              disabled={testing || !configured}
              onClick={testWebhook}
            >
              {testing ? (
                <LoaderCircle size={15} className="spin" />
              ) : (
                <Send size={15} />
              )}
              {testing ? "Sending…" : "Send test notification"}
            </button>
            {configured ? (
              <button
                className="outline-button danger-outline"
                disabled={saving}
                onClick={clearWebhook}
              >
                <Trash2 size={15} />
                Remove webhook
              </button>
            ) : null}
            <button className="link-button" onClick={onHistory}>
              View notification history <ArrowRight size={16} />
            </button>
          </div>
          <div className="security-note">
            <ShieldCheck size={17} />
            <span>
              Secret encryption uses the deployment secret. The stored webhook
              is never returned to the browser.
            </span>
          </div>
        </section>
        <section className="settings-section settings-section--wide">
          <div className="settings-section-heading">
            <div className="settings-symbol settings-symbol--blue">
              <Send size={18} />
            </div>
            <div>
              <h2>ntfy notifications</h2>
              <p>
                Send only the priority tier you choose to an ntfy topic. The
                default is Exceptional only, keeping this channel quiet.
              </p>
            </div>
            <span className={`settings-status ${ntfyConfigured ? "" : "settings-status--idle"}`}>
              <i />
              {settingsLoaded ? ntfyConfigured ? "Configured" : "Not configured" : "Loading…"}
            </span>
          </div>
          <div className="field-row">
            <label className="field-label">
              Server URL
              <input
                type="url"
                autoComplete="off"
                disabled={!settingsLoaded}
                value={ntfyServerUrl}
                onChange={(event) => setNtfyServerUrl(event.target.value)}
                placeholder="https://ntfy.sh"
              />
            </label>
            <label className="field-label">
              Topic
              <input
                autoComplete="off"
                disabled={!settingsLoaded}
                value={ntfyTopic}
                onChange={(event) => setNtfyTopic(event.target.value)}
                placeholder={ntfyConfigured ? (settings?.ntfy?.topicMasked ?? "Saved topic") : "e.g. scout-deals"}
              />
            </label>
          </div>
          <div className="field-row">
            <label className="field-label">
              Access token <span>optional</span>
              <input
                type="password"
                autoComplete="new-password"
                disabled={!settingsLoaded}
                value={ntfyToken}
                onChange={(event) => setNtfyToken(event.target.value)}
                placeholder={settings?.ntfy?.tokenConfigured ? "Saved token" : "tk_…"}
              />
            </label>
            <label className="field-label">
              Minimum deal priority <span>ntfy channel filter</span>
              <select value={ntfyMinimumPriority} onChange={(event) => setNtfyMinimumPriority(event.target.value as NotificationPriority)}>
                <option value="strong">Strong and above</option>
                <option value="very-strong">Very strong and above</option>
                <option value="exceptional">Exceptional only</option>
              </select>
            </label>
          </div>
          <div className="settings-actions">
            <button className="outline-button" disabled={testingNtfy || !ntfyConfigured} onClick={testNtfy}>
              {testingNtfy ? <LoaderCircle size={15} className="spin" /> : <Send size={15} />}
              {testingNtfy ? "Sending…" : "Send test notification"}
            </button>
            {ntfyConfigured ? (
              <button className="outline-button danger-outline" disabled={saving} onClick={clearNtfy}>
                <Trash2 size={15} />
                Remove ntfy
              </button>
            ) : null}
          </div>
          <div className="security-note">
            <ShieldCheck size={17} />
            <span>
              The topic and optional access token are encrypted at rest. Topic
              names behave like passwords, so avoid sharing them publicly.
            </span>
          </div>
        </section>
        <section
          className={`settings-section warning-section ${settings?.publicExposureWarning ? "warning-section--active" : ""}`}
        >
          <div className="settings-section-heading">
            <div className="settings-symbol settings-symbol--amber">
              <AlertTriangle size={18} />
            </div>
            <div>
              <h2>LAN/VPN access only</h2>
              <p>
                {!settingsLoaded
                  ? "Checking exposure configuration…"
                  : settings.publicExposureWarning
                    ? "Public exposure is enabled. Add authentication before continuing."
                    : "No public exposure was reported by this Scout instance."}
              </p>
            </div>
          </div>
          <div className="warning-copy">
            Scout has no built-in authentication. Keep it behind your LAN, VPN,
            or an authenticated reverse proxy.
          </div>
        </section>
      </div>
      <div className="settings-footer">
        <span>Changes are stored locally on this server.</span>
        <button
          className="primary-button"
          disabled={saving || !settings}
          onClick={save}
        >
          {saving ? (
            <LoaderCircle size={18} className="spin" />
          ) : (
            <Check size={18} />
          )}
          {saving ? "Saving…" : "Save settings"}
        </button>
      </div>
    </>
  );
}

function WatchDialog({
  onClose,
  onSubmit,
}: {
  onClose: () => void;
  onSubmit: (watch: Watch) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [query, setQuery] = useState("");
  const [terms, setTerms] = useState("");
  const [excluded, setExcluded] = useState("");
  const [location, setLocation] = useState("Polska");
  const [condition, setCondition] = useState("Any");
  const [interval, setIntervalValue] = useState("5");
  const [sensitivity, setSensitivity] = useState("1");
  const [exactUrls, setExactUrls] = useState("");
  const [sources, setSources] = useState<Marketplace[]>([
    "OLX",
    "Allegro Lokalnie",
    "Vinted",
  ]);
  const [minPrice, setMinPrice] = useState("");
  const [maxPrice, setMaxPrice] = useState("");
  const [shippingOnly, setShippingOnly] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const numericInterval = Number(interval);
  const numericMin = minPrice === "" ? null : Number(minPrice);
  const numericMax = maxPrice === "" ? null : Number(maxPrice);
  const validPrices =
    (numericMin === null || numericMin >= 0) &&
    (numericMax === null || numericMax > 0) &&
    (numericMin === null || numericMax === null || numericMin <= numericMax);
  const canSubmit = Boolean(
    name.trim() &&
      query.trim() &&
      sources.length &&
      Number.isInteger(numericInterval) &&
      numericInterval >= 5 &&
      numericInterval <= 1440 &&
      validPrices,
  );
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !submitting) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, submitting]);
  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit({
        id: `watch-${Date.now()}`,
        name: name.trim(),
        query: query.trim(),
        terms: terms.trim(),
        excluded: excluded.trim(),
        sources,
        location: location.trim() || "Polska",
        condition,
        samples: 0,
        targetSamples: 30,
        observationHours: 0,
        readiness: 0,
        status: "Learning",
        interval: numericInterval,
        nextScan: "due now",
        enabled: true,
        exactUrls: exactUrls
          .split(/\r?\n/)
          .map((url) => url.trim())
          .filter(Boolean),
        sensitivity: Number(sensitivity),
        shippingOnly,
        minPrice: numericMin,
        maxPrice: numericMax,
      });
    } catch (submitError) {
      setError(errorMessage(submitError));
      setSubmitting(false);
    }
  };
  const toggleSource = (source: Marketplace) =>
    setSources((current) =>
      current.includes(source)
        ? current.filter((item) => item !== source)
        : [...current, source],
    );
  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) =>
        event.target === event.currentTarget && !submitting && onClose()
      }
    >
      <section
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="watch-dialog-title"
      >
        <div className="modal-header">
          <div>
            <span className="modal-kicker">Create a search</span>
            <h2 id="watch-dialog-title">New watch</h2>
            <p>
              Scout learns first, then alerts when the price breaks its normal
              range.
            </p>
          </div>
          <button
            className="icon-button"
            disabled={submitting}
            onClick={onClose}
            aria-label="Close"
          >
            <X size={20} />
          </button>
        </div>
        <div className="modal-body">
          <label className="field-label">
            Watch name
            <input
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. Steam Deck OLED 512GB"
            />
          </label>
          <label className="field-label">
            Search terms
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="What should Scout search for?"
            />
          </label>
          <div className="field-row">
            <label className="field-label">
              Included terms
              <input
                value={terms}
                onChange={(event) => setTerms(event.target.value)}
                placeholder="oled, 512gb"
              />
            </label>
            <label className="field-label">
              Excluded terms
              <input
                value={excluded}
                onChange={(event) => setExcluded(event.target.value)}
                placeholder="broken, parts"
              />
            </label>
          </div>
          <div className="field-row">
            <label className="field-label">
              Location
              <input
                value={location}
                onChange={(event) => setLocation(event.target.value)}
              />
            </label>
            <label className="field-label">
              Condition
              <select
                value={condition}
                onChange={(event) => setCondition(event.target.value)}
              >
                <option>Any</option>
                <option>New</option>
                <option>Like new</option>
                <option>Very good</option>
                <option>Good</option>
              </select>
            </label>
          </div>
          <div className="field-row">
            <label className="field-label">
              Minimum price <span>PLN · optional</span>
              <input type="number" min="0" value={minPrice} onChange={(event) => setMinPrice(event.target.value)} placeholder="No minimum" />
            </label>
            <label className="field-label">
              Maximum price <span>PLN · optional</span>
              <input type="number" min="1" value={maxPrice} onChange={(event) => setMaxPrice(event.target.value)} placeholder="No maximum" />
            </label>
          </div>
          <div className="field-row">
            <label className="field-label">
              Polling interval <span>5–1440 min</span>
              <input
                type="number"
                min="5"
                max="1440"
                value={interval}
                onChange={(event) => setIntervalValue(event.target.value)}
              />
            </label>
            <label className="field-label">
              Sensitivity
              <select
                value={sensitivity}
                onChange={(event) => setSensitivity(event.target.value)}
              >
                <option value="0.8">Conservative</option>
                <option value="1">Balanced</option>
                <option value="1.3">Sensitive</option>
              </select>
            </label>
          </div>
          <div className="field-label">
            <span>Sources</span>
            <div className="source-options">
              {(["OLX", "Allegro Lokalnie", "Vinted"] as Marketplace[]).map(
                (source) => (
                  <button
                    type="button"
                    key={source}
                    className={`source-option ${sources.includes(source) ? "source-option--selected" : ""}`}
                    onClick={() => toggleSource(source)}
                  >
                    <i style={{ background: marketplaceColors[source] }} />
                    {source}
                    {sources.includes(source) ? <Check size={15} /> : null}
                  </button>
                ),
              )}
            </div>
          </div>
          <label className="check-option check-option--modal">
            <input type="checkbox" checked={shippingOnly} onChange={(event) => setShippingOnly(event.target.checked)} />
            <span><strong>Require shipping</strong><small>Only learn from and alert on listings with confirmed shipping</small></span>
          </label>
          <label className="field-label">
            Exact search URLs <span>optional · one per line</span>
            <textarea
              rows={3}
              value={exactUrls}
              onChange={(event) => setExactUrls(event.target.value)}
              placeholder={
                "https://www.olx.pl/d/oferty/q-steam-deck/\nhttps://www.vinted.pl/catalog?search_text=steam%20deck"
              }
            />
          </label>
          {error ? (
            <div className="form-error" role="alert">
              <AlertTriangle size={15} />
              {error}
            </div>
          ) : null}
          {!validPrices ? <div className="form-error" role="alert"><AlertTriangle size={15} />Minimum price cannot exceed maximum price.</div> : null}
          <div className="modal-note">
            <Zap size={16} />
            <span>
              Baseline learning needs 30 comparable listings and 6 hours of
              observations. No deal alerts fire while learning.
            </span>
          </div>
        </div>
        <div className="modal-footer">
          <button
            className="outline-button"
            disabled={submitting}
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            className="primary-button"
            disabled={!canSubmit || submitting}
            onClick={submit}
          >
            {submitting ? (
              <LoaderCircle size={17} className="spin" />
            ) : (
              <Plus size={17} />
            )}
            {submitting ? "Creating…" : "Create watch"}
          </button>
        </div>
      </section>
    </div>
  );
}

function PriceFilterDialog({ watch, onClose, onSubmit }: { watch: Watch; onClose: () => void; onSubmit: (minPrice: number | null, maxPrice: number | null) => Promise<void> }) {
  const [minPrice, setMinPrice] = useState(watch.minPrice === null ? "" : String(watch.minPrice));
  const [maxPrice, setMaxPrice] = useState(watch.maxPrice === null ? "" : String(watch.maxPrice));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const numericMin = minPrice === "" ? null : Number(minPrice);
  const numericMax = maxPrice === "" ? null : Number(maxPrice);
  const valid = (numericMin === null || (Number.isFinite(numericMin) && numericMin >= 0)) && (numericMax === null || (Number.isFinite(numericMax) && numericMax > 0)) && (numericMin === null || numericMax === null || numericMin <= numericMax);
  useEffect(() => { const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !saving) onClose(); }; window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey); }, [onClose, saving]);
  const save = async () => { if (!valid) return; setSaving(true); setError(null); try { await onSubmit(numericMin, numericMax); } catch (saveError) { setError(errorMessage(saveError)); setSaving(false); } };
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !saving && onClose()}><section className="modal modal--compact" role="dialog" aria-modal="true" aria-labelledby="price-filter-title"><div className="modal-header"><div><span className="modal-kicker">Watch filters</span><h2 id="price-filter-title">Price range</h2><p>Only matching prices count toward {watch.name}’s learned baseline and alerts.</p></div><button className="icon-button" disabled={saving} onClick={onClose} aria-label="Close"><X size={20} /></button></div><div className="modal-body"><div className="field-row"><label className="field-label">Minimum price <span>PLN</span><input autoFocus type="number" min="0" placeholder="No minimum" value={minPrice} onChange={(event) => setMinPrice(event.target.value)} /></label><label className="field-label">Maximum price <span>PLN</span><input type="number" min="1" placeholder="No maximum" value={maxPrice} onChange={(event) => setMaxPrice(event.target.value)} /></label></div>{!valid ? <div className="form-error" role="alert"><AlertTriangle size={15} />Enter a valid range; minimum cannot exceed maximum.</div> : null}{error ? <div className="form-error" role="alert"><AlertTriangle size={15} />{error}</div> : null}<div className="modal-note"><Info size={16} /><span>Clearing both fields removes the price filter. Existing history is kept but excluded from this watch while outside the range.</span></div></div><div className="modal-footer"><button className="outline-button" disabled={saving} onClick={onClose}>Cancel</button><button className="primary-button" disabled={!valid || saving} onClick={save}>{saving ? <LoaderCircle size={17} className="spin" /> : <Check size={17} />}{saving ? 'Saving…' : 'Save price filter'}</button></div></section></div>;
}

function HistoryDialog({ onClose }: { onClose: () => void }) {
  const [rows, setRows] = useState<NotificationRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    api
      .notifications()
      .then((result) => {
        if (active) setRows(result.notifications);
      })
      .catch((loadError) => {
        if (active) setError(errorMessage(loadError));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <section
        className="modal modal--history"
        role="dialog"
        aria-modal="true"
        aria-labelledby="history-title"
      >
        <div className="modal-header">
          <div>
            <span className="modal-kicker">Delivery log</span>
            <h2 id="history-title">Notification history</h2>
            <p>Actual delivery attempts from this Scout instance.</p>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close">
            <X size={20} />
          </button>
        </div>
        <div className="history-list">
          {loading ? (
            <div className="table-loading">
              <LoaderCircle size={18} className="spin" />
              Loading notifications…
            </div>
          ) : error ? (
            <div className="form-error">
              <AlertTriangle size={15} />
              {error}
            </div>
          ) : rows.length ? (
            rows.map((row) => (
              <div className="history-row" key={row.id}>
                <div className="history-icon">
                  <Send size={15} />
                </div>
                <div>
                  <strong>{row.title}</strong>
                  <span>
                    {row.reason} ·{" "}
                    {new Date(row.observedAt).toLocaleString("pl-PL")}
                  </span>
                </div>
                <em className={`history-status history-status--${row.status}`}>
                  {row.status === "delivered" ? (
                    <CheckCircle2 size={15} />
                  ) : (
                    <AlertTriangle size={15} />
                  )}
                  {row.status}
                </em>
              </div>
            ))
          ) : (
            <div className="panel-empty panel-empty--large">
              No notifications have been sent yet.
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button className="outline-button" onClick={onClose}>
            Done
          </button>
        </div>
      </section>
    </div>
  );
}

export default App;
