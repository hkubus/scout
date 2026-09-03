import type { WatchAnalytics } from "./types";

const formatPln = (value: number | null) =>
  value === null ? "Learning" : `${value.toLocaleString("pl-PL")} zł`;

export function formatAnalyticsPrice(value: number | null) {
  return value === null ? "—" : formatPln(value);
}

export function formatAnalyticsDate(value: string | null) {
  if (!value) return "—";
  let date: Date;
  if (value.includes("T")) {
    date = new Date(value);
  } else {
    const parts = value.split("-").map(Number);
    date = parts.length === 3 && parts.every(Number.isFinite)
      ? new Date(parts[0], parts[1] - 1, parts[2])
      : new Date(value);
  }
  return date.toLocaleDateString("pl-PL", {
    day: "2-digit",
    month: "short",
  });
}

/**
 * Shared daily price-trend chart (median line + shaded p25–p75 band).
 * `referenceMedian` optionally draws a dashed horizontal reference line —
 * used by research trend dialogs for the probable-sale median.
 */
export function AnalyticsTrendChart({ analytics, referenceMedian = null }: { analytics: Pick<WatchAnalytics, "watchName" | "points">; referenceMedian?: number | null }) {
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
  const domainValues = referenceMedian !== null && referenceMedian !== undefined && Number.isFinite(referenceMedian) ? [...values, referenceMedian] : values;
  const rawMin = Math.min(...domainValues);
  const rawMax = Math.max(...domainValues);
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
  const showReference = referenceMedian !== null && referenceMedian !== undefined && Number.isFinite(referenceMedian);
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
        {showReference ? <line x1={padding.left} x2={width - padding.right} y1={y(referenceMedian as number)} y2={y(referenceMedian as number)} className="analytics-reference-line" /> : null}
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
