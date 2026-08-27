export interface ScoreResult {
  typical: number | null;
  mad: number | null;
  deviation: number | null;
  discountPercent: number | null;
  confidence: number;
  isReady: boolean;
  qualifies: boolean;
}

export const BASELINE_MIN_SAMPLES = 30;
export const BASELINE_MIN_HOURS = 6;

export function median(values: number[]) {
  const sorted = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function scoreDeal(prices: number[], price: number, options: { minSamples?: number; minHours?: number; observedHours?: number; sensitivity?: number } = {}): ScoreResult {
  const minSamples = options.minSamples ?? BASELINE_MIN_SAMPLES;
  const minHours = options.minHours ?? BASELINE_MIN_HOURS;
  const usablePrices = prices.filter((value) => Number.isFinite(value) && value > 0);
  const typical = median(usablePrices);
  if (typical === null || price <= 0) return { typical, mad: null, deviation: null, discountPercent: null, confidence: 0, isReady: false, qualifies: false };
  const deviations = usablePrices.map((value) => Math.abs(value - typical));
  const mad = median(deviations) ?? 0;
  const robustScale = Math.max(mad * 1.4826, typical * 0.035, 1);
  const deviation = (typical - price) / robustScale;
  const discountPercent = ((typical - price) / typical) * 100;
  const sampleReadiness = Math.min(1, usablePrices.length / minSamples);
  const timeReadiness = Math.min(1, (options.observedHours ?? 0) / minHours);
  const confidence = Math.round(Math.min(1, sampleReadiness * 0.62 + timeReadiness * 0.38) * 100);
  const sensitivity = options.sensitivity ?? 1;
  const isReady = usablePrices.length >= minSamples && (options.observedHours ?? 0) >= minHours;
  const qualifies = isReady && deviation >= 3.1 / sensitivity && discountPercent >= 18;
  return { typical, mad, deviation, discountPercent, confidence, isReady, qualifies };
}

export function pruneBefore<T extends { observedAt: string }>(rows: T[], now = Date.now(), retentionDays = 180) {
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
  return rows.filter((row) => Date.parse(row.observedAt) >= cutoff);
}
