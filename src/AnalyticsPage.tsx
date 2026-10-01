import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  BarChart3,
  Database,
  LoaderCircle,
  TrendingUp,
} from "lucide-react";
import { api } from "./api";
import { marketplaceColors } from "./data";
import { AnalyticsTrendChart } from "./AnalyticsTrendChart";
import { dayMonth, formatDate } from "./format";
import { PageHeader, SelectControl } from "./ui";
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
      if (sequence === loadSequence.current) setLoading(false);
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

  const hasDealData = Boolean(data && data.trend.length);

  return (
    <>
      <PageHeader title="Analytics" />
      <div className="analytics-toolbar">
        <span>
          {data
            ? `${scopeLabel} · last ${data.rangeDays} days`
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
        </div>
      </div>

      {loading && !data ? <div className="analytics-loading"><LoaderCircle size={20} className="spin" />Loading analytics…</div> : null}
      {error && !data ? <div className="analytics-error" role="alert"><AlertTriangle size={16} />{error}</div> : null}

      {data ? (
        <div className="analytics-body">
          {error ? <div className="analytics-error" role="alert"><AlertTriangle size={16} />{error}</div> : null}

          <div className="analytics-stat-grid">
            <div className="analytics-stat"><span>Tracked listings</span><strong>{formatCount(data.overview.trackedListings)}</strong><small>{formatCount(data.overview.newListings)} new in range</small></div>
            <div className="analytics-stat"><span>Strong deals</span><strong>{formatCount(data.overview.strongDeals)}</strong><small>≥12% below typical</small></div>
            <div className="analytics-stat"><span>Median discount</span><strong>{formatPercent(data.overview.medianDiscountPercent)}</strong><small>below typical</small></div>
            <div className="analytics-stat"><span>Median move</span><strong className={trendChange === null || watchId === "All" ? "" : trendChange < 0 ? "analytics-value--positive" : trendChange > 0 ? "analytics-value--negative" : ""}>{watchId === "All" ? "—" : formatPercent(trendChange)}</strong><small>{watchId === "All" ? "pick a watch" : "first vs latest day"}</small></div>
          </div>

          <section className="analytics-section">
            <div className="analytics-section-heading">
              <h3>Median asking price</h3>
              <span>{watchId === "All" ? "" : "Middle 50% shaded"}</span>
            </div>
            {watchId === "All" ? (
              // A median across unrelated products (a Kindle and a laptop) means nothing.
              <div className="analytics-chart-card analytics-chart-empty analytics-chart-empty--short">Pick a watch above to see its price trend.</div>
            ) : (
              <div className="analytics-chart-card">
                <AnalyticsTrendChart analytics={{ watchName: scopeLabel, points: data.trend }} />
              </div>
            )}
          </section>

          <section className="analytics-section analytics-section--card">
            <div className="analytics-section-heading">
              <h3>Discount distribution</h3>
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
              <h3>Watch performance</h3>
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
                      <td>{row.lastSeenAt ? formatDate(dayMonth, row.lastSeenAt) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <div className="analytics-inline-empty">No observed listings in this range yet.</div>}
          </section>

          <section className="analytics-section analytics-section--card">
            <div className="analytics-section-heading">
              <h3>Marketplace comparison</h3>
              <BarChart3 size={16} />
            </div>
            {data.marketplaceComparison.length ? (
              <table className="analytics-table">
                <thead>
                  <tr><th>Marketplace</th><th>Listings</th><th>Strong deals</th><th>Median discount</th><th>Scans OK</th></tr>
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
                      <td title={`${formatCount(row.scanRuns)} runs · average ${formatLatency(row.averageLatencyMs)}`}>{formatPercent(row.scanSuccessRate, 0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <div className="analytics-inline-empty">No marketplace scans in this range yet.</div>}
          </section>

          <details className="analytics-section analytics-diagnostics">
            <summary>Diagnostics: scans, triage and AI quality</summary>
            <div className="analytics-stat-grid">
              <div className="analytics-stat"><span>Scan runs</span><strong>{formatCount(data.overview.scanRuns)}</strong><small>{formatPercent(data.overview.scanSuccessRate, 0)} completed</small></div>
              <div className="analytics-stat"><span>Triaged</span><strong>{formatCount(data.triage.buy + data.triage.watch + data.triage.pass)}</strong><small>{formatCount(data.triage.buy)} buy · {formatCount(data.triage.watch)} maybe · {formatCount(data.triage.pass)} pass</small></div>
              <div className="analytics-stat"><span>AI relevance</span><strong>{formatPercent(data.aiQuality.relevancePassRate, 0)}</strong><small>kept of {formatCount(data.aiQuality.relevanceJudged)} judged</small></div>
              <div className="analytics-stat"><span>Jev shadow agreement</span><strong>{formatPercent(data.aiQuality.shadowAgreementRate, 0)}</strong><small>{formatCount(data.aiQuality.shadowJudged)} samples</small></div>
            </div>
          </details>

          <p className="analytics-footnote">
            Discounts compare asking prices with Scout’s typical price; they are not sale prices.
            {hasDealData ? "" : " No observations in this range yet."}
          </p>
        </div>
      ) : null}
    </>
  );
}
