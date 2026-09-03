import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  Archive,
  BarChart3,
  Calculator,
  Bell,
  Clock3,
  Database,
  ExternalLink,
  Info,
  ListFilter,
  LoaderCircle,
  MoreHorizontal,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Tag,
  Trash2,
  X,
} from "lucide-react";
import { api } from "./api";
import { marketplaceColors } from "./data";
import { AnalyticsTrendChart, formatAnalyticsDate, formatAnalyticsPrice } from "./AnalyticsTrendChart";
import type { Watch, WatchAnalytics } from "./types";

const formatPln = (value: number | null) =>
  value === null ? "Learning" : `${value.toLocaleString("pl-PL")} zł`;

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "Something went wrong";

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
  actionIcon?: ReactNode;
  actionDisabled?: boolean;
  onAction?: () => void;
}) {
  return (
    <header className="page-header page-header--inner">
      <div>
        <h1>{title}</h1>
        {description ? <p>{description}</p> : null}
      </div>
      {action ? <button className="primary-button" disabled={actionDisabled} onClick={onAction}>{actionIcon}{action}</button> : null}
    </header>
  );
}

export default function WatchesPage({
  watches,
  busyWatchIds,
  onNewWatch,
  onToggle,
  onToggleShipping,
  onToggleAiRelevance,
  onEdit,
  onPriceEdit,
  onArchive,
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
  onToggleAiRelevance: (watch: Watch) => void;
  onEdit: (watch: Watch) => void;
  onPriceEdit: (watch: Watch) => void;
  onArchive: (watch: Watch) => void;
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
              onToggleAiRelevance={() => onToggleAiRelevance(watch)}
              onEdit={() => onEdit(watch)}
              onPriceEdit={() => onPriceEdit(watch)}
              onArchive={() => onArchive(watch)}
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
          can be configured in Settings; Scout never captures passwords or
          bypasses CAPTCHAs. Seller messages are sent only after you review
          and confirm them; automatic negotiation is off by default.
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
  onToggleAiRelevance,
  onEdit,
  onPriceEdit,
  onArchive,
  onDelete,
  onScan,
  onListings,
  onAnalytics,
}: {
  watch: Watch;
  busy: boolean;
  onToggle: () => void;
  onToggleShipping: () => void;
  onToggleAiRelevance: () => void;
  onEdit: () => void;
  onPriceEdit: () => void;
  onArchive: () => void;
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
            {watch.aiRelevance ? <span>AI relevance</span> : null}
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
          <i style={{ width: `${Number.isFinite(watch.readiness) ? Math.min(100, Math.max(0, watch.readiness)) : 0}%` }} />
        </b>
        <small>
          {watch.observationHours}h observed · {Number.isFinite(watch.readiness) ? Math.min(100, Math.max(0, watch.readiness)) : 0}% ready
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
          disabled={busy || Boolean(watch.archivedAt)}
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
            aria-label={`More actions for ${watch.name}`}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((value) => !value)}
          >
            <MoreHorizontal size={18} />
          </button>
          {menuOpen ? (
            <div className="action-menu" role="menu">
              <button
                role="menuitem"
                disabled={busy || !watch.enabled || Boolean(watch.archivedAt)}
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
                Edit watch
              </button>
              <button
                role="menuitem"
                disabled={busy}
                onClick={() => {
                  setMenuOpen(false);
                  onPriceEdit();
                }}
              >
                <Calculator size={15} />
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
                disabled={busy}
                onClick={() => {
                  setMenuOpen(false);
                  onToggleAiRelevance();
                }}
              >
                <ListFilter size={15} />
                {watch.aiRelevance ? "Allow broad matches" : "Use AI relevance filter"}
              </button>
              <button
                role="menuitem"
                className="danger-action"
                disabled={busy}
                onClick={() => {
                  setMenuOpen(false);
                  onArchive();
                }}
              >
                <Archive size={15} />
                {watch.archivedAt ? "Restore watch" : "Archive watch"}
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
                Permanently delete
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </article>
  );
}

export function WatchAnalyticsDialog({ watch, onClose }: { watch: Watch; onClose: () => void }) {
  const [days, setDays] = useState(30);
  const [analytics, setAnalytics] = useState<WatchAnalytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const sequenceRef = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    const sequence = ++sequenceRef.current;
    setLoading(true);
    setError(null);
    void api.watchAnalytics(watch.id, days, controller.signal).then((result) => {
      if (sequence !== sequenceRef.current || controller.signal.aborted) return;
      setAnalytics(result);
    }).catch((requestError) => {
      if (sequence !== sequenceRef.current || controller.signal.aborted) return;
      setError(errorMessage(requestError));
    }).finally(() => {
      if (sequence === sequenceRef.current && !controller.signal.aborted) setLoading(false);
    });
    return () => { controller.abort(); };
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


