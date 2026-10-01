/**
 * Flip ledger maths, shared by the server and the web client. Everything
 * here is forward-only and display-only: it tells the operator what a flip
 * netted or would net, and never feeds baselines, scoring or alerts.
 */

export const FLIP_CHANNELS = ["OLX", "Allegro Lokalnie", "Vinted", "Other"] as const;
export type FlipChannel = (typeof FLIP_CHANNELS)[number];

export interface FeePreset {
  /** Seller commission as a percentage of the sale price. */
  percent: number;
  /** Fixed seller fee per sale, in PLN. */
  fixed: number;
}

export type FeePresets = Record<FlipChannel, FeePreset>;

/**
 * Seller-side fees for private sellers as of 2026-09. The buyer pays
 * shipping and buyer protection on all three platforms.
 * - OLX: a standard listing with OLX Przesyłka has no seller commission. The
 *   optional "Zapłać, jeśli sprzedasz" model charges roughly 6–10% in
 *   Elektronika depending on price, so set the rate here if you use it.
 * - Allegro Lokalnie: 4,9% for Kup teraz or auctions in Elektronika (7,9%
 *   elsewhere); free local listings have no commission.
 * - Vinted: no seller fee.
 */
export const DEFAULT_FEE_PRESETS: FeePresets = {
  OLX: { percent: 0, fixed: 0 },
  "Allegro Lokalnie": { percent: 4.9, fixed: 0 },
  Vinted: { percent: 0, fixed: 0 },
  Other: { percent: 0, fixed: 0 },
};

export const FEE_PRESET_NOTES: Record<FlipChannel, string> = {
  OLX: "Standard listing with OLX Przesyłka: no seller fee. If you use “Zapłać, jeśli sprzedasz”, enter its rate (about 6–10% in Elektronika).",
  "Allegro Lokalnie": "Kup teraz or auction in Elektronika: 4,9% (7,9% in other categories). Free local listings: 0%.",
  Vinted: "No seller fee; the buyer pays buyer protection.",
  Other: "Anything else, e.g. a sale in person.",
};

const round2 = (value: number) => Math.round(value * 100) / 100;

export function isFlipChannel(value: unknown): value is FlipChannel {
  return typeof value === "string" && (FLIP_CHANNELS as readonly string[]).includes(value);
}

/** Merge stored presets over the defaults, dropping anything malformed. */
export function normalizeFeePresets(value: unknown): FeePresets {
  const stored = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const presets = { ...DEFAULT_FEE_PRESETS };
  for (const channel of FLIP_CHANNELS) {
    const entry = stored[channel];
    if (typeof entry !== "object" || entry === null) continue;
    const { percent, fixed } = entry as Record<string, unknown>;
    presets[channel] = {
      percent: typeof percent === "number" && Number.isFinite(percent) && percent >= 0 && percent <= 50 ? percent : DEFAULT_FEE_PRESETS[channel].percent,
      fixed: typeof fixed === "number" && Number.isFinite(fixed) && fixed >= 0 && fixed <= 1000 ? fixed : DEFAULT_FEE_PRESETS[channel].fixed,
    };
  }
  return presets;
}

export function saleFee(salePrice: number, preset: FeePreset) {
  if (!Number.isFinite(salePrice) || salePrice <= 0) return 0;
  return round2((salePrice * preset.percent) / 100 + preset.fixed);
}

export interface FlipAmounts {
  buyPrice: number;
  /** Shipping in, buyer fees, repairs: everything spent to own the item. */
  buyCosts: number;
  salePrice: number | null;
  saleFee: number | null;
  /** Shipping or packaging the seller paid on the way out. */
  saleCosts: number | null;
}

export function flipCost(flip: Pick<FlipAmounts, "buyPrice" | "buyCosts">) {
  return round2(flip.buyPrice + flip.buyCosts);
}

/** Realised net profit, or null while the item is unsold. */
export function flipNet(flip: FlipAmounts) {
  if (flip.salePrice === null) return null;
  return round2(flip.salePrice - (flip.saleFee ?? 0) - (flip.saleCosts ?? 0) - flipCost(flip));
}

/** What a resale at `resalePrice` on a channel would net after its seller fee. */
export function estimateFlipNet(input: { buyPrice: number; buyCosts: number; resalePrice: number; preset: FeePreset; saleCosts?: number }) {
  const fee = saleFee(input.resalePrice, input.preset);
  return { fee, net: round2(input.resalePrice - fee - (input.saleCosts ?? 0) - input.buyPrice - input.buyCosts) };
}

/**
 * Działalność nierejestrowana: quarterly revenue (przychód, the full sale
 * price) may not exceed 225% of the minimum wage. From 2026 the limit is
 * quarterly; earlier years used a different, monthly rule, so no limit is
 * reported for them.
 */
export const UNREGISTERED_QUARTERLY_LIMITS: Record<number, number> = { 2026: 10_813.5 };

/**
 * DAC7: a platform reports a seller to the tax office after 30 sales or
 * 2 000 € of sales on that platform in a calendar year. Reporting only; it
 * does not create tax by itself.
 */
export const DAC7_THRESHOLD = { sales: 30, euro: 2_000 } as const;

export interface DatedSale {
  soldOn: string | null;
  salePrice: number | null;
}

export function quarterOf(date: string) {
  const [year, month] = date.split("-").map(Number);
  return { year, quarter: Math.floor((month - 1) / 3) + 1 };
}

export function inQuarter(date: string, year: number, quarter: number) {
  const parsed = quarterOf(date);
  return parsed.year === year && parsed.quarter === quarter;
}

export interface SalesRecordRow {
  index: number;
  date: string;
  daySales: number;
  /** Running total since the start of the quarter. */
  quarterToDate: number;
}

/**
 * Uproszczona ewidencja sprzedaży for one quarter: one row per day with
 * sales, the day's total, and the running total in the quarter (the figure
 * the quarterly limit applies to). Purchase costs are not part of it.
 */
export function salesRecord(sales: DatedSale[], year: number, quarter: number): SalesRecordRow[] {
  const byDay = new Map<string, number>();
  for (const sale of sales) {
    if (!sale.soldOn || sale.salePrice === null || !inQuarter(sale.soldOn, year, quarter)) continue;
    byDay.set(sale.soldOn, round2((byDay.get(sale.soldOn) ?? 0) + sale.salePrice));
  }
  let running = 0;
  return [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, daySales], index) => {
    running = round2(running + daySales);
    return { index: index + 1, date, daySales, quarterToDate: running };
  });
}

export function salesRecordCsv(rows: SalesRecordRow[]) {
  const pln = (value: number) => value.toFixed(2).replace(".", ",");
  return [
    "Lp.;Data sprzedaży;Wartość sprzedaży danego dnia (zł);Wartość sprzedaży narastająco w kwartale (zł)",
    ...rows.map((row) => `${row.index};${row.date};${pln(row.daySales)};${pln(row.quarterToDate)}`),
  ].join("\r\n");
}
