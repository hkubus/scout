import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Archive,
  BarChart3,
  Bell,
  Database,
  ListFilter,
  LoaderCircle,
  MoreHorizontal,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Tag,
  Trash2,
  X,
} from "lucide-react";
import { api } from "./api";
import { marketplaceColors } from "./data";
import { AnalyticsTrendChart, formatAnalyticsDate, formatAnalyticsPrice } from "./AnalyticsTrendChart";
import type { Watch, WatchAnalytics } from "./types";
import { formatPln, PageHeader } from "./ui";

const intervalLabel = (watch: Watch): string => {
  const overrides = watch.sourceIntervals;
  if (!overrides || !Object.keys(overrides).length) return `every ${watch.interval} min`;
  return watch.sources
    .map((source) => `${source} ${overrides[source] ?? watch.interval}m`)
    .join(" · ");
};

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "Something went wrong";

const priceRangeLabel = (watch: Watch) =>
  `${watch.minPrice === null ? "0" : watch.minPrice.toLocaleString("pl-PL")}–${watch.maxPrice === null ? "∞" : watch.maxPrice.toLocaleString("pl-PL")} zł`;

/** Only the settings that differ from a new watch's defaults, so cards stay short. */
function watchTags(watch: Watch) {
  return [
    watch.terms ? `include: ${watch.terms}` : null,
    watch.excluded ? `exclude: ${watch.excluded}` : null,
    watch.minPrice !== null || watch.maxPrice !== null ? priceRangeLabel(watch) : null,
    watch.shippingOnly ? "shipping only" : null,
    watch.olxCategory && watch.sources.includes("OLX") ? `OLX: ${watch.olxCategory.label}` : null,
    watch.sellerType ? (watch.sellerType === "private" ? "private sellers" : "business sellers") : null,
    watch.ignorePromoted ? "no promoted" : null,
    watch.aiRelevance ? "AI relevance" : null,
    watch.exactUrls.length ? `${watch.exactUrls.length} exact URL${watch.exactUrls.length === 1 ? "" : "s"}` : null,
  ].filter((tag): tag is string => Boolean(tag));
}

export default function WatchesPage({
  watches,
  busyWatchIds,
  onNewWatch,
  onToggle,
  onToggleShipping,
  onToggleAiRelevance,
  onEdit,
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
  onArchive: (watch: Watch) => void;
  onDelete: (watch: Watch) => void;
  onScan: (watch: Watch) => void;
  onViewListings: (watch: Watch, strongOnly?: boolean) => void;
  onAnalytics: (watch: Watch) => void;
}) {
  const [search, setSearch] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const archivedCount = watches.filter((watch) => watch.archivedAt).length;
  const archivedView = showArchived && archivedCount > 0;
  const filtered = watches.filter((watch) =>
    Boolean(watch.archivedAt) === archivedView
    && `${watch.name} ${watch.query}`.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <>
      <PageHeader title="Watches">
        <button className="primary-button" onClick={onNewWatch}><Plus size={18} />New watch</button>
      </PageHeader>
      <div className="toolbar toolbar--watches">
        <label className="search-input">
          <Search size={17} />
          <input
            aria-label="Search watches"
            placeholder="Search watches"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        {archivedCount ? (
          <div className="segmented" role="group" aria-label="Watch list">
            <button type="button" aria-pressed={!archivedView} className={!archivedView ? "segmented-option segmented-option--active" : "segmented-option"} onClick={() => setShowArchived(false)}>Active</button>
            <button type="button" aria-pressed={archivedView} className={archivedView ? "segmented-option segmented-option--active" : "segmented-option"} onClick={() => setShowArchived(true)}>Archived ({archivedCount})</button>
          </div>
        ) : null}
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
              onArchive={() => onArchive(watch)}
              onDelete={() => onDelete(watch)}
              onScan={() => onScan(watch)}
              onListings={(strongOnly) => onViewListings(watch, strongOnly)}
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
  onArchive: () => void;
  onDelete: () => void;
  onScan: () => void;
  onListings: (strongOnly?: boolean) => void;
  onAnalytics: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const readiness = Number.isFinite(watch.readiness) ? Math.min(100, Math.max(0, watch.readiness)) : 0;
  const tags = watchTags(watch);
  const deals = [
    { key: "exceptional", count: watch.dealCounts.exceptional, label: "Exceptional", title: "30%+ below typical" },
    { key: "very-strong", count: watch.dealCounts.veryStrong, label: "Very strong", title: "20%+ below typical" },
    { key: "strong", count: watch.dealCounts.strong, label: "Strong", title: "12%+ below typical" },
  ].filter((deal) => deal.count > 0);
  const learning = watch.status === "Learning" && readiness < 100;
  return (
    <article
      className={`watch-card ${!watch.enabled ? "watch-card--paused" : ""}`}
    >
      <div className="watch-copy">
        <div className="watch-title-row">
          <h3>{watch.name}</h3>
          <span
            className={`state-chip state-chip--${watch.status.toLowerCase()}`}
            title={learning ? `${watch.samples} / ${watch.targetSamples} samples · ${watch.observationHours}h observed` : undefined}
          >
            <i />
            {learning ? `Learning ${readiness}%` : watch.status}
          </span>
        </div>
        <p>
          {watch.query.toLowerCase() !== watch.name.toLowerCase() ? <>{watch.query} <span>·</span> </> : null}
          {watch.sources.join(", ")} <span>·</span> {watch.enabled ? `next ${watch.nextScan}` : "paused"}
          <span>·</span> {intervalLabel(watch)}
        </p>
        {tags.length ? (
          <div className="watch-tags">
            {tags.map((tag) => <span key={tag}>{tag}</span>)}
          </div>
        ) : null}
        {watch.variants?.length ? (
          <div className="watch-variants" aria-label="Model variants">
            {watch.variants.map((variant) => {
              const ready = variant.readiness >= 100;
              return (
                <span
                  key={variant.key}
                  className={`variant-chip ${ready ? "variant-chip--ready" : "variant-chip--learning"}`}
                  title={`${variant.samples} / ${variant.targetSamples} samples · ${variant.observationHours}h observed`}
                >
                  <strong>{variant.label}</strong>
                  <small>{ready ? formatPln(variant.typical) : `${variant.samples}/${variant.targetSamples}`}</small>
                </span>
              );
            })}
          </div>
        ) : null}
      </div>
      <div className="watch-actions">
        {deals.length ? (
          <button type="button" className="watch-deals" onClick={() => onListings(true)} title="Show this watch's strong deals">
            {deals.map((deal) => (
              <span key={deal.key} className={`deal-count deal-count--${deal.key}`} title={deal.title}>
                <i aria-hidden="true" />
                <strong>{deal.count}</strong>
                {deal.label}
              </span>
            ))}
          </button>
        ) : (
          <button type="button" className="link-button link-button--muted" onClick={() => onListings()}>No strong deals</button>
        )}
        <button
          className="outline-button watch-listings-button"
          onClick={() => onListings()}
        >
          Listings
        </button>
        <button
          className="icon-button"
          onClick={onAnalytics}
          title="Price trend"
          aria-label={`Price trend for ${watch.name}`}
        >
          <BarChart3 size={17} />
        </button>
        <button
          className="icon-button"
          disabled={busy || Boolean(watch.archivedAt)}
          onClick={onToggle}
          title={watch.enabled ? "Pause" : "Resume"}
          aria-label={
            watch.enabled ? `Pause ${watch.name}` : `Resume ${watch.name}`
          }
        >
          {busy ? (
            <LoaderCircle size={16} className="spin" />
          ) : watch.enabled ? (
            <Pause size={16} />
          ) : (
            <Play size={16} />
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
                {watch.aiRelevance ? "Turn off AI relevance" : "Turn on AI relevance"}
              </button>
              <button
                role="menuitem"
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
            <span className="modal-kicker">Price trend</span>
            <h2 id="watch-analytics-title">{watch.name}</h2>
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
                <div className="analytics-stat"><span>Strong+ rate</span><strong>{current?.strongDealRate === null || current?.strongDealRate === undefined ? "Learning" : `${current.strongDealRate.toFixed(0)}%`}</strong><small>{current?.strongDealCount ?? 0} listings ≥12% below typical</small></div>
              </div>
              <section className="analytics-section">
                <div className="analytics-section-heading"><h3>Median asking price</h3><span>Middle 50% shaded</span></div>
                <div className="analytics-chart-card"><AnalyticsTrendChart analytics={analytics} /></div>
              </section>
              <div className="analytics-detail-grid">
                <section className="analytics-section analytics-section--card">
                  <div className="analytics-section-heading"><h3>Today's spread</h3><Database size={16} /></div>
                  <div className="analytics-distribution-grid analytics-distribution-grid--four">
                    <div><span>Lowest</span><strong>{formatAnalyticsPrice(current?.minPrice ?? null)}</strong></div>
                    <div title="25th percentile"><span>Lower 25%</span><strong>{formatAnalyticsPrice(current?.lowerPrice ?? null)}</strong></div>
                    <div title="75th percentile"><span>Upper 25%</span><strong>{formatAnalyticsPrice(current?.upperPrice ?? null)}</strong></div>
                    <div><span>Highest</span><strong>{formatAnalyticsPrice(current?.maxPrice ?? null)}</strong></div>
                  </div>
                </section>
                <section className="analytics-section analytics-section--card">
                  <div className="analytics-section-heading"><h3>By marketplace</h3><Tag size={16} /></div>
                  {analytics.sources.length ? <div className="analytics-source-list">{analytics.sources.map((source) => <div className="analytics-source-row" key={source.source}><span><i style={{ background: marketplaceColors[source.source] }} />{source.source}</span><strong>{formatAnalyticsPrice(source.medianPrice)}</strong><small>{source.listingCount} listing{source.listingCount === 1 ? "" : "s"}</small></div>)}</div> : <div className="analytics-inline-empty">No current listings in this range.</div>}
                </section>
              </div>
            </>
          ) : null}
        </div>
      </section>
    </div>
  );
}


