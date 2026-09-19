import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  BarChart3,
  ChevronDown,
  Database,
  Info,
  LoaderCircle,
  MessagesSquare,
  RefreshCw,
  Sparkles,
  Tag,
  TrendingUp,
} from "lucide-react";
import { api } from "./api";
import { marketplaceColors } from "./data";
import { AnalyticsTrendChart, formatAnalyticsPrice } from "./AnalyticsTrendChart";
import type { AnalyticsData, Marketplace, Watch } from "./types";

type ToastType = "success" | "error" | "info";

const MARKETPLACES: Marketplace[] = ["OLX", "Allegro Lokalnie", "Vinted"];

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "Something went wrong";

const formatCount = (value: number) => value.toLocaleString("pl-PL");

const formatPercent = (value: number | null, digits = 1) =>
  value === null || !Number.isFinite(value) ? "—" : `${value.toFixed(digits)}%`;

const formatLatency = (value: number | null) => {
  if (value === null || !Number.isFinite(value)) return "—";
  return value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(1)} s`;
};

function PageHeader({ title, description }: { title: string; description: string }) {
  return (
    <header className="page-header page-header--inner">
      <div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
    </header>
  );
}

function SelectControl({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: Array<string | { value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  return (
    <label className="select-control" aria-label={label}>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => {
          const item = typeof option === "string" ? { value: option, label: option } : option;
          return <option key={item.value} value={item.value}>{item.label}</option>;
        })}
      </select>
      <ChevronDown size={16} />
    </label>
  );
}

function ChartHeading({ kicker, title, detail }: { kicker: string; title: string; detail: string }) {
  return (
    <div className="analytics-section-heading">
      <div><span className="drawer-section-kicker">{kicker}</span><h3>{title}</h3></div>
      <span>{detail}</span>
    </div>
  );
}

export default function AnalyticsPage({
  watches,
  refreshKey,
  onToast,
}: {
  watches: Watch[];
  refreshKey: number;
  onToast: (message: string, type?: ToastType) => void;
}) {
  const [days, setDays] = useState(30);
  const [watchId, setWatchId] = useState("All");
  const [marketplace, setMarketplace] = useState("All");
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const loadSequence = useRef(0);
  const loadController = useRef<AbortController | null>(null);

  const load = useCallback(async (showLoader = false) => {
    loadController.current?.abort();
    const controller = new AbortController();
    loadController.current = controller;
    const sequence = ++loadSequence.current;
    if (showLoader) setLoading(true);
    setError(null);
    try {
      const result = await api.analytics({
        days,
        watchId: watchId === "All" ? undefined : watchId,
        marketplace: marketplace === "All" ? undefined : (marketplace as Marketplace),
      }, controller.signal);
      if (sequence !== loadSequence.current || controller.signal.aborted) return;
      setData(result);
    } catch (requestError) {
      if (sequence !== loadSequence.current || controller.signal.aborted) return;
      const message = errorMessage(requestError);
      setError(message);
      if (!showLoader) onToast(message, "error");
    } finally {
      if (showLoader && sequence === loadSequence.current) setLoading(false);
    }
  }, [days, marketplace, onToast, watchId]);

  useEffect(() => { void load(true); }, [load]);
  useEffect(() => { if (refreshKey) void load(false); }, [load, refreshKey]);

  const watchOptions = useMemo(
    () => [{ value: "All", label: "All watches" }, ...watches.map((watch) => ({ value: watch.id, label: watch.name }))],
    [watches],
  );
  const marketplaceOptions = useMemo(
    () => [{ value: "All", label: "All marketplaces" }, ...MARKETPLACES.map((item) => ({ value: item, label: item }))],
    [],
  );

  const scopeLabel = watchId !== "All"
    ? watches.find((watch) => watch.id === watchId)?.name ?? "Watch"
    : marketplace !== "All" ? marketplace : "All watches";

  const trendChange = useMemo(() => {
    if (!data) return null;
    const priced = data.trend.filter((point) => point.medianPrice !== null);
    if (priced.length < 2) return null;
    const first = priced[0].medianPrice as number;
    const last = priced[priced.length - 1].medianPrice as number;
    return first > 0 ? ((last - first) / first) * 100 : null;
  }, [data]);

  const latestMedian = useMemo(() => {
    if (!data) return null;
    const priced = data.trend.filter((point) => point.medianPrice !== null);
    return priced.length ? priced[priced.length - 1].medianPrice : null;
  }, [data]);

  const hasDealData = Boolean(data && data.trend.length);

  return (
    <>
      <PageHeader
        title="Analytics"
        description="Cross-watch deal performance, price movement, and marketplace health from Scout’s observations."
      />
      <div className="analytics-toolbar">
        <span>
          {data
            ? `${scopeLabel} · ${data.rangeDays}d · generated ${new Date(data.generatedAt).toLocaleTimeString("pl-PL", { hour: "2-digit", minute: "2-digit" })}`
            : "Loading analytics…"}
        </span>
        <div className="analytics-toolbar-controls">
          <SelectControl label="Watch" value={watchId} options={watchOptions} onChange={setWatchId} />
          <SelectControl label="Marketplace" value={marketplace} options={marketplaceOptions} onChange={setMarketplace} />
          <div className="analytics-range-options" role="group" aria-label="Analytics time range">
            {[7, 30, 90, 180].map((option) => (
              <button
                key={option}
                className={days === option ? "analytics-range-option analytics-range-option--active" : "analytics-range-option"}
                onClick={() => setDays(option)}
              >
                {option}d
              </button>
            ))}
          </div>
          <button className="icon-button" onClick={() => void load(false)} aria-label="Refresh analytics" title="Refresh analytics">
            <RefreshCw size={17} />
          </button>
        </div>
      </div>

      {loading && !data ? <div className="analytics-loading"><LoaderCircle size={20} className="spin" />Loading analytics…</div> : null}
      {error && !data ? <div className="analytics-error" role="alert"><AlertTriangle size={16} />{error}</div> : null}

      {data ? (
        <div className="analytics-body">
          {error ? <div className="analytics-error" role="alert"><AlertTriangle size={16} />{error}</div> : null}

          <div className="analytics-stat-grid">
            <div className="analytics-stat"><span>Tracked listings</span><strong>{formatCount(data.overview.trackedListings)}</strong><small>observed in range</small></div>
            <div className="analytics-stat"><span>New listings</span><strong>{formatCount(data.overview.newListings)}</strong><small>first seen in range</small></div>
            <div className="analytics-stat"><span>Strong deals</span><strong>{formatCount(data.overview.strongDeals)}</strong><small>≥18% below baseline</small></div>
            <div className="analytics-stat"><span>Median discount</span><strong>{formatPercent(data.overview.medianDiscountPercent)}</strong><small>vs learned baseline</small></div>
          </div>

          <section className="analytics-section">
            <ChartHeading
              kicker="Price trend"
              title="Median asking price"
              detail={trendChange === null ? "Not enough days" : `${trendChange > 0 ? "+" : ""}${trendChange.toFixed(1)}% in range`}
            />
            <div className="analytics-chart-card">
              <AnalyticsTrendChart analytics={{ watchName: scopeLabel, points: data.trend }} />
            </div>
            <div className="analytics-stat-grid">
              <div className="analytics-stat"><span>Latest median</span><strong>{formatAnalyticsPrice(latestMedian)}</strong><small>most recent day</small></div>
              <div className="analytics-stat"><span>Scan runs</span><strong>{formatCount(data.overview.scanRuns)}</strong><small>{formatPercent(data.overview.scanSuccessRate, 0)} completed</small></div>
              <div className="analytics-stat"><span>Median move</span><strong className={trendChange === null ? "" : trendChange < 0 ? "analytics-value--positive" : trendChange > 0 ? "analytics-value--negative" : ""}>{formatPercent(trendChange)}</strong><small>first vs latest day</small></div>
              <div className="analytics-stat"><span>Activity seen</span><strong>{formatCount(data.watchLeaderboard.length)}</strong><small>{data.watchLeaderboard.length === 1 ? "watch" : "watches"} with data</small></div>
            </div>
          </section>

          <div className="analytics-detail-grid">
            <section className="analytics-section analytics-section--card">
              <div className="analytics-section-heading">
                <div><span className="drawer-section-kicker">Deal shape</span><h3>Discount distribution</h3></div>
                <Database size={16} />
              </div>
              <div className="analytics-distribution-grid">
                {data.discountDistribution.map((bucket) => (
                  <div key={bucket.label}><span>{bucket.label}</span><strong>{formatCount(bucket.count)}</strong></div>
                ))}
              </div>
            </section>
            <section className="analytics-section analytics-section--card">
              <div className="analytics-section-heading">
                <div><span className="drawer-section-kicker">Decisions</span><h3>Triage review</h3></div>
                <Tag size={16} />
              </div>
              <div className="analytics-funnel">
                <div><span>Buy</span><strong>{formatCount(data.triage.buy)}</strong></div>
                <div><span>Watch</span><strong>{formatCount(data.triage.watch)}</strong></div>
                <div><span>Pass</span><strong>{formatCount(data.triage.pass)}</strong></div>
                <div><span>Undecided</span><strong>{formatCount(data.triage.none)}</strong></div>
              </div>
              <div className="analytics-note"><Info size={15} /><span>Triage decisions are not watch-scoped, so this section honors the date range and marketplace filters only.</span></div>
            </section>
          </div>

          <section className="analytics-section analytics-section--card">
            <div className="analytics-section-heading">
              <div><span className="drawer-section-kicker">Leaderboard</span><h3>Watch performance</h3></div>
              <TrendingUp size={16} />
            </div>
            {data.watchLeaderboard.length ? (
              <table className="analytics-table">
                <thead>
                  <tr><th>Watch</th><th>Listings</th><th>Strong deals</th><th>Median discount</th><th>Last seen</th></tr>
                </thead>
                <tbody>
                  {data.watchLeaderboard.map((row) => (
                    <tr key={row.watchId}>
                      <td><span className="analytics-table-name">{row.watchName}</span></td>
                      <td>{formatCount(row.listings)}</td>
                      <td><strong>{formatCount(row.strongDeals)}</strong></td>
                      <td>{formatPercent(row.medianDiscountPercent)}</td>
                      <td>{row.lastSeenAt ? new Date(row.lastSeenAt).toLocaleDateString("pl-PL", { day: "2-digit", month: "short" }) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <div className="analytics-inline-empty">No observed listings in this range yet.</div>}
          </section>

          <section className="analytics-section analytics-section--card">
            <div className="analytics-section-heading">
              <div><span className="drawer-section-kicker">Sources</span><h3>Marketplace comparison</h3></div>
              <BarChart3 size={16} />
            </div>
            {data.marketplaceComparison.length ? (
              <table className="analytics-table">
                <thead>
                  <tr><th>Marketplace</th><th>Listings</th><th>Strong deals</th><th>Median discount</th><th>Scan success</th><th>Avg latency</th></tr>
                </thead>
                <tbody>
                  {data.marketplaceComparison.map((row) => (
                    <tr key={row.marketplace}>
                      <td>
                        <span className="analytics-table-name">
                          <i style={{ background: marketplaceColors[row.marketplace] }} />{row.marketplace}
                        </span>
                      </td>
                      <td>{formatCount(row.listings)}</td>
                      <td><strong>{formatCount(row.strongDeals)}</strong></td>
                      <td>{formatPercent(row.medianDiscountPercent)}</td>
                      <td>{formatPercent(row.scanSuccessRate, 0)}<small className="analytics-table-muted"> · {formatCount(row.scanRuns)} runs</small></td>
                      <td>{formatLatency(row.averageLatencyMs)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <div className="analytics-inline-empty">No marketplace scans in this range yet.</div>}
          </section>

          <div className="analytics-detail-grid">
            <section className="analytics-section analytics-section--card">
              <div className="analytics-section-heading">
                <div><span className="drawer-section-kicker">Outreach</span><h3>Negotiation</h3></div>
                <MessagesSquare size={16} />
              </div>
              <div className="analytics-stat-grid analytics-stat-grid--compact">
                <div className="analytics-stat"><span>Offers sent</span><strong>{formatCount(data.negotiation.offersSent)}</strong><small>manual + automatic</small></div>
                <div className="analytics-stat"><span>Success rate</span><strong>{formatPercent(data.negotiation.successRate, 0)}</strong><small>delivered messages</small></div>
                <div className="analytics-stat"><span>Automatic</span><strong>{formatCount(data.negotiation.automatic)}</strong><small>tracked negotiations</small></div>
                <div className="analytics-stat"><span>Avg discount</span><strong>{formatPercent(data.negotiation.averageDiscountPercent)}</strong><small>automatic offers</small></div>
              </div>
            </section>
            <section className="analytics-section analytics-section--card">
              <div className="analytics-section-heading">
                <div><span className="drawer-section-kicker">Calibration</span><h3>AI quality</h3></div>
                <Sparkles size={16} />
              </div>
              <div className="analytics-stat-grid analytics-stat-grid--compact">
                <div className="analytics-stat"><span>Relevance judged</span><strong>{formatCount(data.aiQuality.relevanceJudged)}</strong><small>decided in range</small></div>
                <div className="analytics-stat"><span>Pass rate</span><strong>{formatPercent(data.aiQuality.relevancePassRate, 0)}</strong><small>kept by relevance</small></div>
                <div className="analytics-stat"><span>Shadow judged</span><strong>{formatCount(data.aiQuality.shadowJudged)}</strong><small>Jev shadow samples</small></div>
                <div className="analytics-stat"><span>Shadow agreement</span><strong>{formatPercent(data.aiQuality.shadowAgreementRate, 0)}</strong><small>vs driving decision</small></div>
              </div>
            </section>
          </div>

          <div className="analytics-note">
            <Info size={16} />
            <span>
              Discounts compare the asking price with Scout’s learned baseline and are deal heuristics, not confirmed sale prices.
              {hasDealData ? "" : " No observations in this range yet — scanning a watch populates this page."} Scout prunes raw observations after 180 days, which bounds every trend here.
            </span>
          </div>
        </div>
      ) : null}
    </>
  );
}
