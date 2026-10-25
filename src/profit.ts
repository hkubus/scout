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
 * What buying at `price` and reselling at the typical asking price on a
 * channel would net after its seller fee, in whole złoty; null without a
 * typical. Asking prices overstate what an item sells for, so callers label
 * it as an estimate.
 */
export function estimatedNetAtTypical(price: number, typical: number | null | undefined, preset: FeePreset) {
  if (typical === null || typical === undefined || !Number.isFinite(typical) || typical <= 0 || !Number.isFinite(price)) return null;
  return Math.round(estimateFlipNet({ buyPrice: price, buyCosts: 0, resalePrice: typical, preset }).net);
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

export const LISTING_CONDITIONS = ["new-with-tags", "new", "like-new", "good", "damaged"] as const;
export type ListingCondition = (typeof LISTING_CONDITIONS)[number];

/** How each marketplace words Scout's listing conditions, for form filling. */
export const LISTING_CONDITION_LABELS: Record<ListingCondition, { label: string; OLX: string; "Allegro Lokalnie": string; Vinted: string }> = {
  "new-with-tags": { label: "New with tags", OLX: "Nowe", "Allegro Lokalnie": "Nowy", Vinted: "Nowy z metką" },
  new: { label: "New", OLX: "Nowe", "Allegro Lokalnie": "Nowy", Vinted: "Nowy bez metki" },
  "like-new": { label: "Used, like new", OLX: "Używane", "Allegro Lokalnie": "Używany", Vinted: "Bardzo dobry" },
  good: { label: "Used, good", OLX: "Używane", "Allegro Lokalnie": "Używany", Vinted: "Dobry" },
  damaged: { label: "Damaged / for parts", OLX: "Uszkodzone", "Allegro Lokalnie": "Uszkodzony", Vinted: "Zadowalający" },
};

/**
 * Scout's condition for a marketplace's own wording ("Używane", "Bardzo
 * dobry", "Nowy z metką", "Used"), or null when it can't tell.
 */
export function listingConditionFromLabel(label: string | null | undefined): ListingCondition | null {
  const text = (label ?? "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/ł/g, "l").trim();
  if (!text) return null;
  if (/bez metki/.test(text)) return "new";
  if (/\bz metk|with tags|z etykiet/.test(text)) return "new-with-tags";
  if (/uszkodz|na czesci|zadowalaj|damaged|for parts|broken/.test(text)) return "damaged";
  if (/^now[eya]\b|^new\b|brand new/.test(text)) return "new";
  if (/bardzo dobr|jak nowy|like new|very good|idealn/.test(text)) return "like-new";
  if (/uzywan|dobry|used|good|refurb|odnowion/.test(text)) return "good";
  return null;
}

/**
 * The nearest price ending in 9.99 (1450 → 1449.99, 1525 → 1529.99), the way
 * shops price. Prices under 5 zł have no such neighbour and are kept.
 */
export function roundToNines(price: number) {
  if (!Number.isFinite(price) || price < 5) return price;
  return Number((Math.round((price + 0.01) / 10) * 10 - 0.01).toFixed(2));
}

/** What the operator wants to post for a flip. */
export interface FlipListing {
  title: string;
  description: string;
  condition: ListingCondition | null;
  /**
   * The item's kind as marketplaces name their categories ("Słuchawki",
   * "Karty graficzne"); the extension searches and ranks categories by it.
   */
  category?: string;
  /** Asking price per platform; missing platforms fall back to `basePrice`. */
  prices: Partial<Record<FlipChannel, number>>;
  /** What the operator wants to receive before fees; drives the suggestions. */
  basePrice: number | null;
  /** How the buyer gets it. Older drafts have none; the server fills in `NO_DELIVERY`. */
  delivery?: FlipDelivery;
}

/** The marketplaces a flip can be posted on; "Other" is a ledger channel only. */
export const LISTING_CHANNELS = ["OLX", "Allegro Lokalnie", "Vinted"] as const;
export type ListingChannel = (typeof LISTING_CHANNELS)[number];

export function isListingChannel(value: unknown): value is ListingChannel {
  return typeof value === "string" && (LISTING_CHANNELS as readonly string[]).includes(value);
}

/** Vinted's parcel sizes: small fits a shoebox, large a moving box. */
export const PARCEL_SIZES = ["small", "medium", "large"] as const;
export type ParcelSize = (typeof PARCEL_SIZES)[number];

export interface FlipDelivery {
  shipping: boolean;
  pickup: boolean;
  /** Vinted asks for it; OLX and Allegro Lokalnie don't. */
  parcelSize: ParcelSize | null;
}

export const NO_DELIVERY: FlipDelivery = { shipping: false, pickup: false, parcelSize: null };

export const LISTING_CHANNEL_STATUSES = ["ready", "listed", "failed", "declined"] as const;
export type ListingChannelStatus = (typeof LISTING_CHANNEL_STATUSES)[number];

/** One marketplace a flip is to be posted on, and how that went. */
export interface FlipListingChannel {
  channel: ListingChannel;
  status: ListingChannelStatus;
  /** The live listing, once `listed`. */
  url: string | null;
  error: string | null;
  updatedAt: string;
}

/** The asking price a channel is posted at: its own, else the base price. */
export function listingPrice(listing: FlipListing | null, channel: ListingChannel) {
  return listing?.prices[channel] ?? listing?.basePrice ?? null;
}

const joinAnd = (items: string[]) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`);

/**
 * What a draft still needs before it can be posted on `channels`, in plain
 * words ("a description", "a price for Vinted"); empty when it's complete.
 */
export function readyToListGaps(listing: FlipListing | null, photoCount: number, channels: readonly ListingChannel[]): string[] {
  const gaps: string[] = [];
  if (!listing?.title.trim()) gaps.push("a title");
  if (!listing?.description.trim()) gaps.push("a description");
  if (!listing?.condition) gaps.push("the condition");
  const unpriced = channels.filter((channel) => !listingPrice(listing, channel));
  if (unpriced.length) gaps.push(`a price for ${joinAnd(unpriced)}`);
  const delivery = listing?.delivery ?? NO_DELIVERY;
  const undelivered = channels.filter((channel) => channel !== "Vinted" && !delivery.shipping && !delivery.pickup);
  if (undelivered.length) gaps.push(`shipping or pickup for ${joinAnd(undelivered)}`);
  if (channels.includes("Vinted") && !delivery.parcelSize) gaps.push("the parcel size for Vinted");
  if (photoCount < 1) gaps.push("at least one photo");
  return gaps;
}

export function readyToListMessage(gaps: string[]) {
  return `Before it can be listed, add ${joinAnd(gaps)}.`;
}

/**
 * Asking price on a platform that leaves the same amount as `receive` on a
 * fee-free one, rounded up to whole złoty. Display-only suggestion.
 */
export function suggestedListingPrice(receive: number, preset: FeePreset) {
  if (!Number.isFinite(receive) || receive <= 0) return null;
  const share = 1 - preset.percent / 100;
  if (share <= 0) return null;
  return Math.ceil((receive + preset.fixed) / share);
}
