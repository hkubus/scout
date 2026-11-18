/**
 * Shared loaders and helpers for scoring.ts and scoring-replay.ts.
 *
 * - Loaders read watches, watch listings, listings and observations from an
 *   improvement export (read-only).
 * - `buildBaselines` mirrors ScoutService.watchBaselines (server/service.ts):
 *   latest in-bounds price per associated listing, AI-irrelevant and
 *   (shipping-only) non-shipping listings left out, bucketed by the stored
 *   variant_key, newest 400 per bucket, pooled spread over named variants.
 *   It takes options for what-if experiments (exclusions, time window,
 *   repost dedupe). scoring-replay.ts checks the mirror against the real
 *   method at the export time, so a change to the service query shows up as
 *   a mirror mismatch rather than silently diverging.
 * - Independent heuristics (variant classes from titles, junk titles) give a
 *   second opinion that does not reuse Scout's own rules. They are rough and
 *   label-free: read their example tables before trusting a rate.
 */

import { assignVariant, OTHER_VARIANT_KEY, parseVariantGroups, type VariantGroup } from '../../server/variants';
import {
  BASELINE_MIN_SAMPLES,
  VARIANT_MIN_SAMPLES,
  dealStrength,
  pooledVariantSpread,
  priceStats,
  scoreDealFromStats,
  type PooledSpread,
  type PriceStats,
  type ScoreResult,
} from '../../server/scoring';
import { normalizeFilterText, parseIncludedExcluded, splitTerms, termMatches } from '../../server/text';
import type { Db } from './lib';

export { OTHER_VARIANT_KEY, assignVariant };

export interface WatchCfg {
  id: string;
  name: string;
  query: string;
  excludedTerms: string;
  minPrice: number | null;
  maxPrice: number | null;
  shippingOnly: boolean;
  aiRelevance: boolean;
  sensitivity: number;
  enabled: boolean;
  archived: boolean;
  groups: VariantGroup[];
  minSaving: number | null;
  targetPrice: number | null;
  referenceMarketWatchId: string | null;
  raw: Record<string, unknown>;
}

export interface ListingInfo {
  id: number;
  marketplace: string;
  listingId: string;
  /** `<Marketplace>:<listingId>`. */
  key: string;
  title: string;
  condition: string | null;
  price: number;
  shipping: number | null;
  flags: string[];
  hidden: boolean;
  decision: string | null;
  firstSeen: string;
  lastSeen: string;
  verification: string | null;
}

export interface Assoc {
  wlId: number;
  watchId: string;
  listingId: number;
  variantKey: string | null;
  variantSource: string | null;
  typical: number | null;
  strength: number | null;
  label: string | null;
  typicalSource: string | null;
  discount: number | null;
  deviation: number | null;
  confidence: number | null;
  qualifies: number | null;
  firstSeen: string;
  lastSeen: string;
  /** listing_relevance status for (watch, listing): 'irrelevant' | 'relevant' | 'unknown' | null (no row). */
  relevance: string | null;
}

export interface Obs {
  id: number;
  watchId: string;
  listingId: number;
  price: number;
  at: number;
  scanId: number | null;
  baseline: number | null;
  discount: number | null;
  strength: number | null;
  label: string | null;
}

const num = (value: unknown) => (value === null || value === undefined ? null : Number(value));

export function loadWatches(db: Db): WatchCfg[] {
  const rows = db.prepare('SELECT * FROM watches ORDER BY created_at').all() as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: String(row.id),
    name: String(row.name),
    query: String(row.query ?? ''),
    excludedTerms: String(row.excluded_terms ?? ''),
    minPrice: num(row.min_price_pln),
    maxPrice: num(row.max_price_pln),
    shippingOnly: Boolean(row.shipping_only),
    aiRelevance: !(row.ai_relevance === 0 || row.ai_relevance === false),
    sensitivity: Number(row.sensitivity ?? 1),
    enabled: Boolean(row.enabled),
    archived: row.archived_at !== null && row.archived_at !== undefined,
    groups: parseVariantGroups(row.variant_groups_json),
    minSaving: num(row.min_saving_pln),
    targetPrice: num(row.target_price_pln),
    referenceMarketWatchId: row.reference_market_watch_id ? String(row.reference_market_watch_id) : null,
    raw: row,
  }));
}

/** Listings that some watch matched, with their triage and stored quick flags. */
export function loadListings(db: Db): Map<number, ListingInfo> {
  const rows = db.prepare(`SELECT l.id, l.marketplace, l.listing_id, l.title, l.condition, l.price_pln, l.shipping_available, l.flags_json,
      l.first_seen_at, l.last_seen_at, l.ai_description_verification_status, a.hidden, a.decision
    FROM listings l LEFT JOIN listing_actions a ON a.marketplace = l.marketplace AND a.listing_id = l.listing_id
    WHERE l.id IN (SELECT listing_id FROM watch_listings)`).all() as Array<Record<string, unknown>>;
  const map = new Map<number, ListingInfo>();
  for (const row of rows) {
    let flags: string[] = [];
    try {
      const parsed = JSON.parse(String(row.flags_json ?? '[]'));
      if (Array.isArray(parsed)) flags = parsed.map((flag) => String(flag?.flag)).filter(Boolean);
    } catch { /* unreadable flags count as none */ }
    map.set(Number(row.id), {
      id: Number(row.id),
      marketplace: String(row.marketplace),
      listingId: String(row.listing_id),
      key: `${row.marketplace}:${row.listing_id}`,
      title: String(row.title ?? ''),
      condition: row.condition === null || row.condition === undefined ? null : String(row.condition),
      price: Number(row.price_pln),
      shipping: num(row.shipping_available),
      flags,
      hidden: Number(row.hidden ?? 0) === 1,
      decision: row.decision === null || row.decision === undefined ? null : String(row.decision),
      firstSeen: String(row.first_seen_at),
      lastSeen: String(row.last_seen_at),
      verification: row.ai_description_verification_status ? String(row.ai_description_verification_status) : null,
    });
  }
  return map;
}

export function loadAssocs(db: Db): Assoc[] {
  const rows = db.prepare(`SELECT wl.*, r.relevance_status, r.relevant
    FROM watch_listings wl JOIN listings l ON l.id = wl.listing_id
    LEFT JOIN listing_relevance r ON r.watch_id = wl.watch_id AND r.marketplace = l.marketplace AND r.listing_id = l.listing_id`).all() as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    wlId: Number(row.id),
    watchId: String(row.watch_id),
    listingId: Number(row.listing_id),
    variantKey: row.variant_key === null || row.variant_key === undefined ? null : String(row.variant_key),
    variantSource: row.variant_source ? String(row.variant_source) : null,
    typical: num(row.typical_pln),
    strength: num(row.deal_strength),
    label: row.deal_label ? String(row.deal_label) : null,
    typicalSource: row.typical_source ? String(row.typical_source) : null,
    discount: num(row.discount_percent),
    deviation: num(row.deviation),
    confidence: num(row.confidence),
    qualifies: num(row.qualifies),
    firstSeen: String(row.first_seen_at),
    lastSeen: String(row.last_seen_at),
    // Same predicate as watchBaselines: irrelevant, or a legacy row with relevant = 0.
    relevance: row.relevance_status
      ? String(row.relevance_status)
      : row.relevant === null || row.relevant === undefined ? null : Number(row.relevant) === 0 ? 'irrelevant' : 'relevant',
  }));
}

/** Every observation, grouped per watch and sorted by (observed_at, id). ~680k rows ≈ 1–2 s. */
export function loadObservations(db: Db): Map<string, Obs[]> {
  const statement = db.prepare('SELECT id, watch_id, listing_id, price_pln, observed_at, scan_id, baseline_pln, discount_percent, deal_strength, deal_label FROM observations');
  const arrays = typeof (statement as { setReturnArrays?: unknown }).setReturnArrays === 'function';
  if (arrays) (statement as unknown as { setReturnArrays(value: boolean): void }).setReturnArrays(true);
  const byWatch = new Map<string, Obs[]>();
  const rows = statement.all() as unknown[];
  for (const raw of rows) {
    const r = arrays ? raw as unknown[] : Object.values(raw as Record<string, unknown>);
    const obs: Obs = {
      id: Number(r[0]),
      watchId: String(r[1]),
      listingId: Number(r[2]),
      price: Number(r[3]),
      at: Date.parse(String(r[4])),
      scanId: num(r[5]),
      baseline: num(r[6]),
      discount: num(r[7]),
      strength: num(r[8]),
      label: r[9] === null || r[9] === undefined ? null : String(r[9]),
    };
    let list = byWatch.get(obs.watchId);
    if (!list) byWatch.set(obs.watchId, (list = []));
    list.push(obs);
  }
  for (const list of byWatch.values()) list.sort((a, b) => a.at - b.at || a.id - b.id);
  return byWatch;
}

export function loadScanStarts(db: Db): Map<number, number> {
  const map = new Map<number, number>();
  for (const row of db.prepare('SELECT id, started_at FROM scans').all() as Array<{ id: number; started_at: string }>) {
    map.set(Number(row.id), Date.parse(row.started_at));
  }
  return map;
}

// ------------------------------------------------------------------ baselines

export function inBounds(watch: WatchCfg, price: number) {
  return (watch.minPrice === null || price >= watch.minPrice) && (watch.maxPrice === null || price <= watch.maxPrice);
}

/** watchBaselines' association filter: AI-irrelevant and, for shipping-only watches, non-shipping listings never feed the baseline. */
export function baselineCandidate(watch: WatchCfg, assoc: Assoc, listing: ListingInfo | undefined) {
  if (!listing) return false;
  if (watch.aiRelevance && assoc.relevance === 'irrelevant') return false;
  if (watch.shippingOnly && !(listing.marketplace === 'Vinted' || listing.shipping === 1)) return false;
  return true;
}

/** Per listing: the latest and the first in-bounds observation known at some time. */
export interface ListingState {
  assoc: Assoc;
  listing: ListingInfo;
  latestPrice: number;
  latestAt: number;
  firstAt: number;
}

export interface Sample {
  listingId: number;
  price: number;
  at: number;
}

export interface Bucket {
  key: string;
  samples: Sample[];
  prices: number[];
  firstObservedAt: number | null;
  stats: PriceStats;
}

export interface Baselines {
  groups: VariantGroup[];
  buckets: Map<string, Bucket>;
  pooled: PooledSpread | null;
}

export interface BaselineOptions {
  /** Leave a listing out of every bucket (what-if exclusions). */
  exclude?: (state: ListingState) => boolean;
  /** Only listings whose latest in-bounds price is at most this many days old at `now`. */
  windowDays?: number;
  /** Count one sample per (normalized title, price) within a bucket: reposts and cross-posts. */
  dedupeReposts?: boolean;
  /** Per-bucket cap; the service keeps the newest 400. */
  cap?: number;
}

export function buildBaselines(watch: WatchCfg, states: Iterable<ListingState>, now: number, options: BaselineOptions = {}): Baselines {
  const cap = options.cap ?? 400;
  const rows: ListingState[] = [];
  const firstByVariant = new Map<string, number>();
  for (const state of states) {
    if (options.exclude?.(state)) continue;
    if (options.windowDays !== undefined && now - state.latestAt > options.windowDays * 86_400_000) continue;
    rows.push(state);
    const key = state.assoc.variantKey ?? OTHER_VARIANT_KEY;
    const known = firstByVariant.get(key);
    if (known === undefined || state.firstAt < known) firstByVariant.set(key, state.firstAt);
  }
  // Newest first, as the service orders by o.observed_at DESC, o.id DESC.
  rows.sort((a, b) => b.latestAt - a.latestAt);
  const buckets = new Map<string, Bucket>();
  const seen = new Map<string, Set<string>>();
  for (const state of rows) {
    const key = state.assoc.variantKey ?? OTHER_VARIANT_KEY;
    if (!(state.latestPrice > 0)) continue;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { key, samples: [], prices: [], firstObservedAt: null, stats: priceStats([]) };
      buckets.set(key, bucket);
    }
    if (options.dedupeReposts) {
      const signature = `${foldTitle(state.listing.title)}|${state.latestPrice}`;
      let set = seen.get(key);
      if (!set) seen.set(key, (set = new Set()));
      if (set.has(signature)) continue;
      set.add(signature);
    }
    if (bucket.prices.length < cap) {
      bucket.prices.push(state.latestPrice);
      bucket.samples.push({ listingId: state.listing.id, price: state.latestPrice, at: state.latestAt });
    }
  }
  for (const [key, first] of firstByVariant) {
    const bucket = buckets.get(key);
    if (bucket) bucket.firstObservedAt = first;
  }
  for (const bucket of buckets.values()) bucket.stats = priceStats(bucket.prices);
  const pooled = watch.groups.length ? pooledVariantSpread(watch.groups.map((group) => buckets.get(group.id)?.prices ?? [])) : null;
  return { groups: watch.groups, buckets, pooled };
}

/** States as of the end of the export: latest/first in-bounds observation per baseline candidate. */
export function statesAt(watch: WatchCfg, observations: Obs[], assocs: Map<number, Assoc>, listings: Map<number, ListingInfo>, before = Infinity): Map<number, ListingState> {
  const states = new Map<number, ListingState>();
  for (const obs of observations) {
    if (obs.at >= before) break;
    applyObservation(watch, states, obs, assocs, listings);
  }
  return states;
}

/** Folds one observation into the per-listing state (observations must arrive in time order). */
export function applyObservation(watch: WatchCfg, states: Map<number, ListingState>, obs: Obs, assocs: Map<number, Assoc>, listings: Map<number, ListingInfo>) {
  if (!inBounds(watch, obs.price)) return;
  const current = states.get(obs.listingId);
  if (current) {
    current.latestPrice = obs.price;
    current.latestAt = obs.at;
    return;
  }
  const assoc = assocs.get(obs.listingId);
  const listing = listings.get(obs.listingId);
  if (!assoc || !baselineCandidate(watch, assoc, listing)) return;
  states.set(obs.listingId, { assoc, listing: listing!, latestPrice: obs.price, latestAt: obs.at, firstAt: obs.at });
}

export interface Scored {
  score: ScoreResult;
  strength: number | null;
  key: string;
  named: boolean;
}

/** variantDealScore + dealScore without a reference band (no export watch uses one; see report notes). */
export function scoreIn(watch: WatchCfg, baselines: Baselines, key: string, price: number, now: number): Scored {
  const bucket = baselines.buckets.get(key) ?? { prices: [], firstObservedAt: null, stats: priceStats([]) };
  const named = key !== OTHER_VARIANT_KEY && baselines.groups.length > 0;
  const observedHours = bucket.firstObservedAt ? Math.max(0, (now - bucket.firstObservedAt) / 3_600_000) : 0;
  const score = scoreDealFromStats(bucket.stats, price, {
    observedHours,
    sensitivity: watch.sensitivity,
    ...(named && baselines.pooled ? { pooled: baselines.pooled } : {}),
  });
  return { score, strength: score.discountPercent === null ? null : dealStrength(price, score.typical), key, named };
}

/** Would storeListing alert on this score (deal path; target price is separate)? */
export function alertsOn(watch: WatchCfg, scored: Scored, price: number) {
  const { score } = scored;
  if (!score.isReady || score.typical === null) return false;
  const minSaving = watch.minSaving;
  return score.qualifies && (minSaving === null || minSaving <= 0 || score.typical - price >= minSaving);
}

export const MIN_SAMPLES = { baseline: BASELINE_MIN_SAMPLES, variant: VARIANT_MIN_SAMPLES };

/**
 * Re-tag one saved listing the way ScoutService.retagVariantRules does after
 * the variant rules change: a manual pick stays, a rule match to a named
 * group wins, a Jev pick stays where the rules find none, the rest is Other.
 */
export function retaggedVariant(watch: WatchCfg, listing: Pick<ListingInfo, 'title'>, assoc: Pick<Assoc, 'variantKey' | 'variantSource'>): string {
  const ids = new Set(watch.groups.map((group) => group.id));
  const kept = assoc.variantKey !== null && ids.has(assoc.variantKey);
  if (assoc.variantSource === 'manual' && kept) return assoc.variantKey!;
  const rule = assignVariant(listing.title, watch.groups);
  if (rule !== OTHER_VARIANT_KEY) return rule;
  return assoc.variantSource === 'jev' && kept ? assoc.variantKey! : OTHER_VARIANT_KEY;
}

/**
 * What-if variant rule: assignVariant (server/variants.ts) with the watch
 * filter's term matching (server/text.ts termMatches), so glued model tokens
 * ("1660ti", "rtx2060") reach their group the way they already pass the
 * include/exclude filter. Since VARIANT_RULES_VERSION 2 the repo's own
 * assignVariant does this; unlike retaggedVariant this overrides manual and
 * Jev picks too.
 */
export function assignVariantGlued(title: string, groups: VariantGroup[]): string {
  if (!groups.length) return OTHER_VARIANT_KEY;
  const spaced = normalizeFilterText(title);
  const glued = spaced.replace(/ /g, '');
  const weight = (terms: string) => splitTerms(terms).reduce((total, term) => total + term.split(' ').filter(Boolean).length, 0);
  const ordered = groups.map((group, index) => ({ group, index, weight: weight(group.terms) })).sort((a, b) => b.weight - a.weight || a.index - b.index);
  for (const { group } of ordered) {
    const required = splitTerms(group.terms);
    if (!required.length) continue;
    const excluded = splitTerms(group.exclude ?? '');
    if (required.every((term) => termMatches(spaced, glued, term)) && !excluded.some((term) => termMatches(spaced, glued, term))) return group.id;
  }
  return OTHER_VARIANT_KEY;
}

/** termMatches as of 06e9554, before numbers learned units and exclusions learned inflections. */
function termMatchesAt06e9554(spaced: string, glued: string, term: string) {
  if (!term) return false;
  if (/^\d+$/.test(term)) return spaced.split(' ').some((token) => token.split(/[a-z]+/).includes(term));
  if (spaced.includes(term)) return true;
  const compact = term.replace(/ /g, '');
  return /\d/.test(compact) && compact.length >= 3 && glued.includes(compact);
}

/**
 * The watch's term filter (query or included terms, excluded terms; title
 * only) as of 06e9554. A listing that passed it but fails the repo's
 * filterListings now is one the change keeps out; one that failed both got
 * in by the AI rescue or a typo variant, which the replay leaves alone.
 */
export function passedTermFilterAt06e9554(watch: WatchCfg, title: string) {
  const { included, excluded } = parseIncludedExcluded(watch.query, String(watch.raw.included_terms ?? ''), watch.excludedTerms);
  const spaced = normalizeFilterText(title);
  const glued = spaced.replace(/ /g, '');
  return included.every((term) => termMatchesAt06e9554(spaced, glued, term)) && !excluded.some((term) => termMatchesAt06e9554(spaced, glued, term));
}

// ------------------------------------------------------------ text heuristics

/** Lowercase, ł → l, accents stripped, non-alphanumerics to single spaces. */
export function foldTitle(value: string) {
  return value.toLowerCase().replace(/ł/g, 'l').normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9+]+/g, ' ').trim();
}

/** The model number a watch query is about: its longest digit run ("1660", "12400", "12"). */
export function modelAnchor(query: string): string | null {
  const runs = query.match(/\d+/g) ?? [];
  return runs.sort((a, b) => b.length - a.length)[0] ?? null;
}

const GPU_MODELS = /(?:^|[^0-9])(10[5-8]0|16[5-6]0|20[6-8]0|30[5-9]0|40[6-9]0|50[6-9]0)(?![0-9])/g;

/**
 * An independent model class for a title, not using Scout's variant rules:
 * '' (the plain model), 'super', 'ti', 'f', 'mini', 'pro', 'pro max', '6gb';
 * 'missing' when the anchor number is absent; 'multi' when the title lists
 * several GPU models (fan, cooler or bundle listings).
 */
export function independentVariantClass(title: string, anchor: string, query: string): string {
  const folded = foldTitle(title);
  const tokens = folded.split(' ').filter(Boolean);
  const isGpu = /^(10|16|20|30|40|50)\d0$/.test(anchor);
  const isPhone = /iphone/i.test(query);
  if (isGpu) {
    const models = new Set([...folded.matchAll(GPU_MODELS)].map((match) => match[1]));
    if (models.size >= 2) return 'multi';
  }
  for (let i = 0; i < tokens.length; i += 1) {
    const match = tokens[i].match(/^([a-z]*)(\d+)([a-z]*)$/);
    if (!match || match[2] !== anchor) continue;
    if (isPhone && !(['iphone', 'iphon', 'ip'].includes(match[1]) || ['iphone', 'iphon', 'phone'].includes(tokens[i - 1] ?? ''))) continue;
    const glued = match[3];
    const next = tokens[i + 1] ?? '';
    const after = tokens[i + 2] ?? '';
    if (isPhone) {
      if (glued === 'promax' || (glued === 'pro' && next === 'max') || (next === 'pro' && after === 'max') || next === 'promax') return 'pro max';
      if (glued === 'pro' || next === 'pro') return 'pro';
      if (glued === 'mini' || next === 'mini') return 'mini';
      return '';
    }
    if (anchor === '12400') return glued === 'f' || next === 'f' ? 'f' : '';
    if (isGpu) {
      if (glued === 'ti' || next === 'ti') return 'ti';
      if (glued === 's' || glued === 'super' || next === 'super' || next === 's') return 'super';
      if (anchor === '3050') return /(^|\s)6\s?gb(\s|$)/.test(folded) || /(^|\s)6gb/.test(folded) ? '6gb' : '';
      return '';
    }
    return '';
  }
  return 'missing';
}

/** Group id per independent class, by classifying each group's own terms. */
export function groupClassMap(watch: WatchCfg): Map<string, string> {
  const anchor = modelAnchor(watch.query);
  const map = new Map<string, string>();
  if (!anchor) return map;
  for (const group of watch.groups) {
    const cls = independentVariantClass(group.terms, anchor, watch.query);
    if (cls !== 'missing' && cls !== 'multi' && !map.has(cls)) map.set(cls, group.id);
  }
  return map;
}

export type JunkKind = 'broken' | 'part_or_accessory' | 'whole_system' | 'bundle' | 'wanted' | 'locked' | 'multi_model' | 'wrong_model';

const BROKEN = /\b(uszkodz\w*|niesprawn\w*|nie ?dzial\w*|brak obrazu|bez obrazu|artefakt\w*|na czesci|do naprawy|spalon\w*|dawca|zepsut\w*|nie wlacza\w*|nie odpala\w*|broken|faulty|for parts)\b/;
const NOT_BROKEN = /\b(bez|brak|nie) (uszkodz\w*|wad)\b|uszkodzen brak/;
/** GPU/CPU parts and accessories; they count only before the model number ("Wentylator … 1660", not "1660 Super single fan"). */
const PART_GPU_CPU = /\b(wentylator\w*|wiatrak\w*|chlodzeni\w*|chlodzenie|radiator\w*|backplate|plyt\w* glown\w*|tasm\w*|riser\w*|cooler|heatsink|fan|fany|termopad\w*|pudelko|pudelka|atrapa|uchwyt\w*|zaslepk\w*|sledz\w*|obudow\w*)\b/;
/** Phone accessories, Polish plus the Czech, Slovak, Hungarian and German words Vinted titles use; they count anywhere unless they read as an extra ("+ etui"). */
const ACCESSORY_PHONE = /\b(etui|case|szkl\w*|folia|folie|pokrowi\w*|pokrowc\w*|atrapa|magsafe|airpods|uchwyt\w*|obal\w*|kryt\w*|tok|tokok|telefontok\w*|husa|huse|hulle|coque|funda|cover|bumper|szett|mobilfox)\b/;
/** Phone components; like GPU parts they count only ahead of the model ("Bateria iPhone 12", not "iPhone 12 bateria 88%"). */
const COMPONENT_PHONE = /\b(bateri\w*|ekran\w*|wyswietlacz\w*|plyt\w* glown\w*|obudow\w*|klapk\w*|tasm\w*|aparat\w*|pudelko|kabel|ladowark\w*)\b/;
const ACCESSORY_IS_EXTRA = /(\+|\b(z|wraz|plus|oraz|gratis|i)\b)\s*(\w+\s+){0,1}$/;
const SYSTEM = /\b(komputer\w*|laptop\w*|notebook\w*|stacja robocza|zestaw komputerowy|pelikone|desktop|jednostka centralna|gaming pc|all in one|thinkcentre|optiplex|prodesk|elitedesk|m920\w*|omen|legion|nitro|predator|helios)\b/;
const CPU_BUNDLE = /(\+|\bzestaw\b|\bz plyta\b|\bplyta\b|\bram\b|\bddr[345]\b)/;
const WANTED = /\b(kupie|kupimy|skup\w*|szukam|poszukuje|wtb)\b/;
const LOCKED = /\b(icloud|blokad\w*|zablokowan\w*)\b/;

/** Where the watched model number first appears in a folded title, or -1. */
function anchorIndex(folded: string, anchor: string, isPhone: boolean) {
  const pattern = isPhone ? new RegExp(`(iphone|iphon|phone|ip) ?${anchor}(?![0-9])`) : new RegExp(`(^|[^0-9])${anchor}(?![0-9])`);
  const match = pattern.exec(folded);
  return match ? match.index : -1;
}

/**
 * Independent junk-title heuristic (not flags.ts): kinds a reseller would not
 * buy as the watched item. Rough by design; scoring.ts prints examples of
 * every kind so its precision can be eyeballed.
 */
export function junkKinds(title: string, query: string): JunkKind[] {
  const folded = foldTitle(title);
  const kinds: JunkKind[] = [];
  const anchor = modelAnchor(query);
  const isPhone = /iphone/i.test(query);
  const isCpu = anchor === '12400';
  const at = anchor ? anchorIndex(folded, anchor, isPhone) : 0;
  if (BROKEN.test(folded) && !NOT_BROKEN.test(folded)) kinds.push('broken');
  const accessory = isPhone ? ACCESSORY_PHONE.exec(folded) : null;
  const component = (isPhone ? COMPONENT_PHONE : PART_GPU_CPU).exec(folded);
  if ((accessory && !ACCESSORY_IS_EXTRA.test(folded.slice(0, accessory.index))) || (component && (at === -1 || component.index < at))) {
    kinds.push('part_or_accessory');
  }
  if (!isPhone && SYSTEM.test(folded)) kinds.push('whole_system');
  if (isCpu && CPU_BUNDLE.test(folded)) kinds.push('bundle');
  if (WANTED.test(folded)) kinds.push('wanted');
  if (isPhone && LOCKED.test(folded) && !/\b(bez|brak) (blokad\w*|icloud)\b/.test(folded)) kinds.push('locked');
  if (anchor && !isPhone && independentVariantClass(title, anchor, query) === 'multi') kinds.push('multi_model');
  if (anchor && at === -1) kinds.push('wrong_model');
  return kinds;
}

/** Junk by any proxy: stored flag, hidden/passed by the user, AI-irrelevant, description check rejected, or a junk title. */
export interface JunkProxies {
  flagged: boolean;
  hidden: boolean;
  irrelevant: boolean;
  rejected: boolean;
  junkTitle: boolean;
  any: boolean;
}

export function junkProxies(watch: WatchCfg, assoc: Assoc, listing: ListingInfo): JunkProxies {
  const flagged = listing.flags.length > 0;
  const hidden = listing.hidden || listing.decision === 'pass';
  const irrelevant = assoc.relevance === 'irrelevant';
  const rejected = listing.verification === 'reject';
  const junkTitle = junkKinds(listing.title, watch.query).length > 0;
  return { flagged, hidden, irrelevant, rejected, junkTitle, any: flagged || hidden || irrelevant || rejected || junkTitle };
}

export const DAY_MS = 86_400_000;

export function pct(value: number | null | undefined, digits = 1) {
  return value === null || value === undefined || !Number.isFinite(value) ? null : Math.round(value * 100 * 10 ** digits) / 10 ** digits;
}

export function round(value: number | null | undefined, digits = 1) {
  return value === null || value === undefined || !Number.isFinite(value) ? null : Math.round(value * 10 ** digits) / 10 ** digits;
}
