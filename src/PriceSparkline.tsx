import { useId } from "react";
import type { PriceHistoryPoint } from "./types";

/** `reference` (the typical price) draws as a dashed line, so the history reads against it. */
export function PriceSparkline({ points, reference = null }: { points: PriceHistoryPoint[]; reference?: number | null }) {
  const fillId = `price-chart-fill-${useId().replace(/:/g, "")}`;
  if (!points.length) return <div className="price-chart-empty">No saved price observations yet.</div>;
  const values = [...points.map((point) => point.price), ...(reference !== null && reference > 0 ? [reference] : [])];
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
  const referenceY = reference !== null && reference > 0 ? 88 - ((reference - chartMinimum) / Math.max(chartMaximum - chartMinimum, 1)) * 76 : null;
  return (
    <svg className="price-chart" viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="Listing price history">
      <defs>
        <linearGradient id={fillId} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="var(--blue)" stopOpacity=".18" />
          <stop offset="1" stopColor="var(--blue)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`M ${coordinates.join(" L ")} L 100,100 L 0,100 Z`} fill={`url(#${fillId})`} />
      {referenceY !== null ? <line x1="0" x2="100" y1={referenceY} y2={referenceY} stroke="var(--muted)" strokeWidth="1.2" strokeDasharray="4 4" vectorEffect="non-scaling-stroke" /> : null}
      <polyline points={coordinates.join(" ")} fill="none" stroke="var(--blue)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
