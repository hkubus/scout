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
/** A group's own median needs this many samples; its spread and the 30-sample floor are pooled across groups. */
export const GROUP_MIN_SAMPLES = 10;

export interface PooledSpread {
  /** Median absolute deviation of price / group-median ratios, or null before any group has enough samples. */
  spreadRatio: number | null;
  /** Samples from groups that reached GROUP_MIN_SAMPLES. */
  samples: number;
}

export function median(values: number[]) {
  const sorted = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Within-group price noise measured across the whole watch: each price is
 * expressed as a ratio to its own group's median and the ratios are pooled.
 * Groups below GROUP_MIN_SAMPLES are left out because a small group's MAD
 * understates its spread (its median element contributes a zero deviation).
 */
export function pooledGroupSpread(groups: Iterable<number[]>): PooledSpread {
  const deviations: number[] = [];
  for (const prices of groups) {
    const usable = prices.filter((value) => Number.isFinite(value) && value > 0);
    if (usable.length < GROUP_MIN_SAMPLES) continue;
    const typical = median(usable)!;
    for (const value of usable) deviations.push(Math.abs(value / typical - 1));
  }
  return { spreadRatio: median(deviations), samples: deviations.length };
}

export function scoreDeal(prices: number[], price: number, options: { minSamples?: number; minHours?: number; observedHours?: number; sensitivity?: number; typicalOverride?: number; pooled?: PooledSpread } = {}): ScoreResult {
  // Grouped watches pass their group's prices plus the pooled spread: the
  // typical comes from the group, while the MAD and the 30-sample readiness
  // floor come from all groups together.
  const pooled = options.pooled;
  const minSamples = options.minSamples ?? (pooled ? GROUP_MIN_SAMPLES : BASELINE_MIN_SAMPLES);
  const minHours = options.minHours ?? BASELINE_MIN_HOURS;
  const usablePrices = prices.filter((value) => Number.isFinite(value) && value > 0);
  // A typicalOverride (e.g. a reference series' probable-sale median) seeds the
  // typical for ranking/display while a watch's own baseline is still learning.
  // Readiness (and therefore the qualifies gate) still requires own samples.
  const override = options.typicalOverride !== undefined && Number.isFinite(options.typicalOverride) && options.typicalOverride > 0
    ? options.typicalOverride
    : null;
  const typical = override ?? median(usablePrices);
  if (typical === null || price <= 0) return { typical, mad: null, deviation: null, discountPercent: null, confidence: 0, isReady: false, qualifies: false };
  const deviations = usablePrices.map((value) => Math.abs(value - typical));
  const mad = pooled?.spreadRatio != null ? pooled.spreadRatio * typical : median(deviations) ?? 0;
  const robustScale = Math.max(mad * 1.4826, typical * 0.035, 1);
  const deviation = (typical - price) / robustScale;
  const discountPercent = ((typical - price) / typical) * 100;
  const sampleReadiness = Math.min(1, usablePrices.length / minSamples, pooled ? pooled.samples / BASELINE_MIN_SAMPLES : 1);
  const timeReadiness = Math.min(1, (options.observedHours ?? 0) / minHours);
  const confidence = Math.round(Math.min(1, sampleReadiness * 0.62 + timeReadiness * 0.38) * 100);
  const rawSensitivity = options.sensitivity ?? 1;
  const sensitivity = Number.isFinite(rawSensitivity) && rawSensitivity >= 0.6 && rawSensitivity <= 1.6 ? rawSensitivity : 1;
  const isReady = usablePrices.length >= minSamples && (!pooled || pooled.samples >= BASELINE_MIN_SAMPLES) && (options.observedHours ?? 0) >= minHours;
  const qualifies = isReady && deviation >= 3.1 / sensitivity && discountPercent >= 18;
  return { typical, mad, deviation, discountPercent, confidence, isReady, qualifies };
}

export function pruneBefore<T extends { observedAt: string }>(rows: T[], now = Date.now(), retentionDays = 180) {
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
  return rows.filter((row) => Date.parse(row.observedAt) >= cutoff);
}
