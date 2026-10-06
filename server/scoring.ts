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
/** A model variant's own median needs this many samples; its spread and the 30-sample floor are pooled across variants. */
export const VARIANT_MIN_SAMPLES = 10;

export interface PooledSpread {
  /** Median absolute deviation of price / variant-median ratios, or null before any variant has enough samples. */
  spreadRatio: number | null;
  /** Samples from variants that reached VARIANT_MIN_SAMPLES. */
  samples: number;
}

export function median(values: number[]) {
  const sorted = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Within-variant price noise measured across the whole watch: each price is
 * expressed as a ratio to its own variant's median and the ratios are pooled.
 * Variants below VARIANT_MIN_SAMPLES are left out because a small bucket's MAD
 * understates its spread (its median element contributes a zero deviation).
 */
export function pooledVariantSpread(buckets: Iterable<number[]>): PooledSpread {
  const deviations: number[] = [];
  for (const prices of buckets) {
    const usable = prices.filter((value) => Number.isFinite(value) && value > 0);
    if (usable.length < VARIANT_MIN_SAMPLES) continue;
    const typical = median(usable)!;
    for (const value of usable) deviations.push(Math.abs(value / typical - 1));
  }
  return { spreadRatio: median(deviations), samples: deviations.length };
}

/**
 * The listing-independent part of a baseline: its usable prices, their median
 * and a memo of the MAD per typical value. A scan scores every listing against
 * the same few buckets, so computing these once per bucket saves two sorts of
 * up to 400 prices per scored listing.
 */
export interface PriceStats {
  usable: number[];
  median: number | null;
  /** median(|price - typical|) keyed by typical; a reference override changes the typical. */
  madByTypical: Map<number, number>;
}

export function priceStats(prices: number[]): PriceStats {
  const usable = prices.filter((value) => Number.isFinite(value) && value > 0);
  return { usable, median: median(usable), madByTypical: new Map() };
}

type ScoreOptions = { minSamples?: number; minHours?: number; observedHours?: number; sensitivity?: number; typicalOverride?: number; pooled?: PooledSpread };

export function scoreDeal(prices: number[], price: number, options: ScoreOptions = {}): ScoreResult {
  return scoreDealFromStats(priceStats(prices), price, options);
}

/** scoreDeal against precomputed bucket stats; the arithmetic is identical. */
export function scoreDealFromStats(stats: PriceStats, price: number, options: ScoreOptions = {}): ScoreResult {
  // Named model variants pass their bucket's prices plus the pooled spread:
  // the typical comes from the variant, while the MAD and the 30-sample
  // readiness floor come from all named variants together.
  const pooled = options.pooled;
  const minSamples = options.minSamples ?? (pooled ? VARIANT_MIN_SAMPLES : BASELINE_MIN_SAMPLES);
  const minHours = options.minHours ?? BASELINE_MIN_HOURS;
  const usablePrices = stats.usable;
  // A typicalOverride (e.g. a reference series' probable-sale median) seeds the
  // typical for ranking/display while a watch's own baseline is still learning.
  // Readiness (and therefore the qualifies gate) still requires own samples.
  const override = options.typicalOverride !== undefined && Number.isFinite(options.typicalOverride) && options.typicalOverride > 0
    ? options.typicalOverride
    : null;
  const typical = override ?? stats.median;
  if (typical === null || price <= 0) return { typical, mad: null, deviation: null, discountPercent: null, confidence: 0, isReady: false, qualifies: false };
  const mad = pooled?.spreadRatio != null ? pooled.spreadRatio * typical : ownMad(stats, typical);
  const robustScale = Math.max(mad * 1.4826, typical * 0.035, 1);
  const deviation = (typical - price) / robustScale;
  const discountPercent = ((typical - price) / typical) * 100;
  const sampleReadiness = Math.min(1, usablePrices.length / minSamples, pooled ? pooled.samples / BASELINE_MIN_SAMPLES : 1);
  const timeReadiness = Math.min(1, (options.observedHours ?? 0) / minHours);
  const confidence = Math.round(Math.min(1, sampleReadiness * 0.62 + timeReadiness * 0.38) * 100);
  const rawSensitivity = options.sensitivity ?? 1;
  const sensitivity = Number.isFinite(rawSensitivity) && rawSensitivity >= 0.6 && rawSensitivity <= 1.6 ? rawSensitivity : 1;
  const isReady = usablePrices.length >= minSamples && (!pooled || pooled.samples >= BASELINE_MIN_SAMPLES) && (options.observedHours ?? 0) >= minHours;
  // A "Very strong" discount (the same >= 20% tier the feed labels) alerts even
  // when the watch's price spread is too wide to clear the robust z-score. A
  // heterogeneous watch can otherwise hold every genuine discount forever:
  // MAD/robustScale grows with the spread, so a 20-40% discount can sit below
  // the 3.1 deviation bar. Strong (18-20%) still has to clear it, and the
  // readiness floor plus the high-priority description verification still apply.
  const veryStrong = discountPercent >= 20;
  const qualifies = isReady && discountPercent >= 18 && (veryStrong || deviation >= 3.1 / sensitivity);
  return { typical, mad, deviation, discountPercent, confidence, isReady, qualifies };
}

/** Typical price at which a deal's strength equals its plain discount percentage. */
export const DEAL_STRENGTH_REFERENCE_PLN = 400;

/** Tier lower bounds on the blended deal index (see dealStrength). */
const DEAL_STRENGTH_TIERS = [
  { strength: 5, index: 30, minPercent: 20 },
  { strength: 4, index: 20, minPercent: 13 },
  { strength: 3, index: 12, minPercent: 8 },
] as const;

/**
 * Deal-strength tier (5 Exceptional, 4 Very strong, 3 Strong, 2 Watch, 1 none)
 * from both the discount percentage and the PLN saved, so 100 zł off 600 zł
 * outranks 50 zł off 200 zł. The index is the geometric mean of the two,
 * scaled to equal the percentage at a DEAL_STRENGTH_REFERENCE_PLN typical:
 * percent × √(typical / 400). Each tier also needs about two-thirds of its
 * index in plain percent (asking prices on expensive items swing widely), so
 * a small relative dip cannot ride the PLN amount alone. Returns null when
 * there is no usable typical.
 */
export function dealStrength(price: number, typical: number | null): number | null {
  if (typical === null || !Number.isFinite(typical) || typical <= 0 || !Number.isFinite(price)) return null;
  const percent = ((typical - price) / typical) * 100;
  if (percent <= 0) return 1;
  const index = percent * Math.sqrt(typical / DEAL_STRENGTH_REFERENCE_PLN);
  return DEAL_STRENGTH_TIERS.find((tier) => index >= tier.index && percent >= tier.minPercent)?.strength ?? 2;
}

function ownMad(stats: PriceStats, typical: number) {
  let mad = stats.madByTypical.get(typical);
  if (mad === undefined) {
    mad = median(stats.usable.map((value) => Math.abs(value - typical))) ?? 0;
    stats.madByTypical.set(typical, mad);
  }
  return mad;
}

export function pruneBefore<T extends { observedAt: string }>(rows: T[], now = Date.now(), retentionDays = 180) {
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
  return rows.filter((row) => Date.parse(row.observedAt) >= cutoff);
}
