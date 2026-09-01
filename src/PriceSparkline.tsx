import type { PriceHistoryPoint } from "./types";

export function PriceSparkline({ points }: { points: PriceHistoryPoint[] }) {
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
