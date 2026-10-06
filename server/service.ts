import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { Readable } from 'node:stream';
// @ts-ignore node:sqlite is present in the supported Node 22+ runtime.
import { DatabaseSync } from 'node:sqlite';
import { connect as connectHttp2, type SecureClientSessionOptions } from 'node:http2';
import { brotliDecompressSync, gunzipSync, inflateRawSync, inflateSync } from 'node:zlib';
import type { Browser, BrowserContext } from 'playwright-core';
import { buildDiscordEmbed, buildNtfyPayload, isSafeNetworkHost, meetsMinimumPriority, notificationKey, notificationPriorityRank, parseNotificationPriority, priorityFromDiscount, publishNtfy, SCOUT_APP_DEALS_LINK, validateNtfyConfig, type NtfyConfig } from './notifications';
import { SearchConfigError, buildMarketplaceSearchUrl, buildOlxCategoryFacetsUrl, buildOlxFriendlyLinksUrl, buildOlxSearchApiUrl, createAllegroLokalnieAdapter, createOlxJsonAdapter, createPublicAdapter, createVintedJsonAdapter, exponentialBackoff, isMarketplaceImageUrl, parseListingDescription, parseListingImageUrls, parseShippingAvailability, validateSearchUrl, type AllegroApiFetchResult, type ConnectorAdapter, type ConnectorPathReporter, type ListingAvailability, type Marketplace, type NormalizedListing, type OlxApiFetchResult, type OlxCategory, type OlxCategoryFacet, type OlxSearchPathParams, type SellerType, parseOlxCategoryFacets, parseOlxFriendlyLinks, resolveOlxSearchPath, type VintedApiFetchResult, type VintedPageFetchResult, olxDetailHint } from './marketplaces';
import { MarketplaceSessionValidationError, parseMarketplaceStorageState, type MarketplaceStorageState } from './marketplace-sessions';
import { DEFAULT_DEEPSEEK_MODEL, classifyListingRelevanceWithDeepSeek, suggestVariantGroupsWithDeepSeek, writeResaleListingWithDeepSeek, legacyListingRelevanceInputHash, listingConditionMatchInputHash, listingDescriptionVerificationInputHash, listingNegotiabilityInputHash, listingVariantInputHash, listingRelevanceInputHash, listingTermMatchInputHash, normalizeOpenRouterModel, DeepSeekError, parseStoredListingDescriptionVerification, parseVerificationChecks, verifyListingDescriptionWithDeepSeek, type ListingDescriptionVerificationContext, type ListingRelevanceContext, type VerificationCheck } from './ai';
import { DEFAULT_JEV_MODEL, JevError, classifyConditionMatchWithJev, classifyListingRelevanceWithJev, classifyNegotiabilityWithJev, classifyTermMatchWithJev, classifyChecksWithJev, classifyWatchVariantWithJev, summarizeCheckResults, checkIssue, verifyListingDescriptionWithJev, type JevRelevanceJudgment, type JevVerificationJudgment } from './jev';
import { DEFAULT_VISION_MODEL, VisionError, classifyListingRelevanceWithVision, verifyListingDescriptionWithVision, visionToVerification } from './vision';
import { discardResponse, fetchDiscardSummary } from './fetch-diagnostics';
import { Limiter, mapPool } from './limiter';
import { BASELINE_MIN_HOURS, BASELINE_MIN_SAMPLES, VARIANT_MIN_SAMPLES, dealStrength, median, pooledVariantSpread, priceStats, scoreDealFromStats, type PooledSpread, type PriceStats, type ScoreResult } from './scoring';
import { pickVariantBatch, typoVariants } from './typos';
import { normalizeFilterText } from './text';
import { AUTO_VARIANT_MIN_LISTINGS, OTHER_VARIANT_KEY, OTHER_VARIANT_LABEL, assignVariant, finalizeVariantSuggestions, parseVariantGroups, suggestVariantGroupsFromTitles, variantLabelFor, type VariantGroup, type VariantSample } from './variants';
import { computeSaleBand, MIN_BAND_SAMPLES, type MarketBandSample } from './marketBand';
import { bucketDailyObservations, type MarketTrendObservation } from './marketTrend';
import { dealOverview, discountDistribution, marketplaceDeals, trendPoints, watchLeaderboard, type AnalyticsObservation } from './analytics';
import type { AnalyticsAiQuality, AnalyticsData, AnalyticsMarketplaceRow, AnalyticsOverview, AnalyticsTriage, Connector, ConnectorRun, DailyDigestSettings, DashboardData, DealLabel, Listing, ListingAction, ListingDecision, ListingDescriptionVerification, ListingDetail, ListingDetailSnapshot, ListingDescriptionVerificationStatus, LogEntry, ManualSearchResponse, MarketListingSnapshot, MarketResearchData, MarketTrackedListing, MarketWatch, MarketWatchTrend, NotificationPriority, NotificationRecord, PriceHistoryPoint, SearchFilters, SearchSourceStatus, SettingsData, VerificationComparison, VerificationTraceEntry, Watch, WatchAnalytics, WatchAnalyticsPoint, WatchAnalyticsSource, WatchDealCounts, WatchVariantStat, ResaleListingDraft } from '../src/types';
import { listingConditionFromLabel } from '../src/profit';

type Database = any;
type WatchRow = Record<string, any>;
type ListingRelevanceSearch = Pick<ListingRelevanceContext, 'query' | 'includedTerms' | 'excludedTerms'>;
type RelevanceFilterResult = {
  listings: NormalizedListing[];
  excluded: number;
  failed: number;
  unknown: number;
  /** Listings kept without an AI call because the deal-strength gate excluded them. */
  skipped: number;
  notConfigured: boolean;
};

type DealNotificationCandidate = {
  watchId: string;
  listing: NormalizedListing;
  typical: number;
  discountPercent: number;
  confidence: number;
  requiresDescriptionVerification: boolean;
  /** Watch search terms naming the sought item; verification uses them to reject accessories/parts. */
  query?: string;
  includedTerms?: string;
  excludedTerms?: string;
  /** Watch-specific things the verifier must confirm (require) or rule out (exclude). */
  verificationChecks?: VerificationCheck[];
  /** Model-variant bucket this listing was scored against, when the watch groups variants. */
  variantKey?: string | null;
  variantLabel?: string | null;
};

/**
 * Per-variant price history for one scan. The window query returns the latest
 * observation per listing with its assigned variant_key; the buckets split them
 * so each model scores against its own median/readiness instead of a blend.
 * With no configured groups every row lands in the single OTHER bucket, which
 * reproduces the legacy watch-wide baseline exactly.
 */
/** `stats` is filled once the bucket is complete, so every listing in a scan reuses its median and MAD. */
type WatchVariantBucket = { prices: number[]; firstObservedAt: string | null; stats?: PriceStats };
type WatchBaselines = {
  groups: VariantGroup[];
  buckets: Map<string, WatchVariantBucket>;
  /** Spread pooled across the named variants; null when the watch has no groups. */
  pooled: PooledSpread | null;
};
/**
 * A listing's variant for one scan. `key` is the baseline bucket (OTHER when
 * unmatched or ungrouped); `source` records how a named variant was chosen and
 * is null only for watches without groups.
 */
type VariantAssignment = { key: string; source: 'manual' | 'rule' | 'jev' | null };

/**
 * Notification/verification configuration snapshotted once per scan: reading
 * it per candidate re-decrypted the webhook, ntfy, and AI credentials for
 * every deal. Built lazily so scans without candidates never decrypt.
 */
type ScanNotifyContext = {
  encryptedDiscord: string | null;
  ntfy: NtfyConfig | null;
  digest: DailyDigestConfig;
  discordMinimumPriority: NotificationPriority;
  deepSeek: { apiKey: string | null; model: string; source: 'settings' | 'environment' | 'none' };
};

type DigestChannel = 'Discord' | 'ntfy';
type DailyDigestConfig = Omit<DailyDigestSettings, 'lastSentAt'>;

type DigestCandidateRow = {
  id: number;
  watch_id: string;
  watch_name: string;
  marketplace: Marketplace;
  listing_id: string;
  sequence: number;
  title: string;
  url: string;
  image_url: string | null;
  price_pln: number;
  typical_pln: number;
  discount_percent: number;
  confidence: number;
  priority: NotificationPriority;
  observed_at: string;
};

const DEFAULT_DAILY_DIGEST_CONFIG: DailyDigestConfig = {
  enabled: false,
  time: '08:00',
  discord: true,
  ntfy: false,
};

const connectorDefinitions: Array<Pick<Connector, 'name' | 'kind' | 'color'>> = [
  { name: 'OLX', kind: 'marketplace', color: '#159b96' },
  { name: 'Allegro Lokalnie', kind: 'marketplace', color: '#f27526' },
  { name: 'Vinted', kind: 'marketplace', color: '#55a9b0' },
  { name: 'Discord', kind: 'discord', color: '#32a85b' },
  { name: 'ntfy', kind: 'ntfy', color: '#4f9da6' },
];
const marketplaces: Marketplace[] = ['OLX', 'Allegro Lokalnie', 'Vinted'];
export const DEFAULT_NIGHT_INTERVAL_MINUTES = 30;
const MATCH_VISIBILITY_MS = 12 * 60 * 60_000;
/**
 * Rows a single manual-search request keeps per source before truncating. The
 * client pages past it with `page` instead of losing results silently.
 */
const MANUAL_SEARCH_RESULT_CAP = 200;
/**
 * Manual-search Jev checks, per source per page: at most this many uncached
 * Jev calls, and detail-page fetches for at most this many listings whose
 * description the search API did not already return. The rest stay unchecked.
 */
const SEARCH_CHECK_JEV_BUDGET = 40;
const SEARCH_CHECK_DETAIL_BUDGET = 12;
const NIGHT_START_HOUR = 22;
const NIGHT_END_HOUR = 8;
const MAX_RESEARCH_DETAIL_CHECKS = 100;
/** Extra per-source searches a typo-variant scan may fetch (each still one page). */
const TYPO_VARIANTS_PER_SCAN = 2;
/** Jev variant assignments a grouped watch may request per scan and source. */
const VARIANT_JEV_BUDGET = 10;
/**
 * A standing deal that cannot alert (already alerted at this price, no due
 * channel or digest) is not re-verified while its stored verdict for the
 * active model is younger than this. Anything that makes it alertable (a
 * price drop, a higher priority, a new channel) verifies it as before.
 */
const DESCRIPTION_VERIFICATION_FRESH_MS = 6 * 60 * 60_000;
/** Rolling window of ended listings that feed probable-sale bands. */
const SALE_BAND_WINDOW_DAYS = 90;
/** Bounded per-scan capture of preserved listing copies (description + downloaded images). */
const SNAPSHOT_CAPTURES_PER_SCAN = 8;
const SNAPSHOT_MAX_IMAGES = 12;
const SNAPSHOT_MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const SNAPSHOT_MAX_ATTEMPTS = 3;
// In-flight request cap per marketplace, shared by watch scans, research
// scans, manual searches and detail checks; queued requests wait FIFO.
const MARKETPLACE_REQUEST_CONCURRENCY = 2;
// playwright-core costs ~80 MB RSS and ~200 ms to import, and most instances
// never render: it loads on the first render once a browser is configured.
let playwright: Promise<typeof import('playwright-core')> | undefined;
function loadPlaywright() {
  playwright ??= import('playwright-core').catch((error) => {
    playwright = undefined;
    throw error;
  });
  return playwright;
}

// Concurrent Chromium renders across all marketplaces (each its own context;
// a Browserless connection is its own browser process).
const BROWSER_RENDER_CONCURRENCY = 2;
/** A locally launched Chromium is shared across renders and closed this long after the last one. */
const BROWSER_IDLE_CLOSE_MS = 20_000;
// A wedged Chromium must not hold up shutdown (and the database close after it).
const BROWSER_CLOSE_TIMEOUT_MS = 5_000;
/**
 * Served for marketplace CDN images during renders: only page.content() is
 * read, and a real (tiny) image keeps onerror handlers from rewriting src.
 */
const ONE_PIXEL_GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
/**
 * The anonymous marketplace APIs (OLX offers, Vinted catalog, Lokalnie
 * additional-data) reject Scout's plain identifier UA; a modern Chrome UA plus
 * `Accept: application/json` is the verified anonymous access contract.
 * OLX additionally requires HTTP/2: its CloudFront distribution answers
 * HTTP/1.1 API requests with `403 Request blocked` while the same request over
 * HTTP/2 returns 200, so the OLX fetcher below uses `node:http2` (Node's
 * undici `fetch` is HTTP/1.1-only).
 */
const MARKETPLACE_API_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
/** Scan-path log entries kept in memory for the Logs tab; pure diagnostics, never persisted. */
const LOG_BUFFER_LIMIT = 500;

/**
 * Jev relevance and fuzzy-rescue judgments are independent network round trips,
 * so a search runs a bounded pool of them at once instead of waiting on each
 * one in turn. Six hides most of the round-trip latency while staying polite to
 * OpenRouter; raise (or lower) per deployment with SCOUT_JEV_CONCURRENCY.
 */
const DEFAULT_JEV_CHECK_CONCURRENCY = 6;
const MAX_JEV_CHECK_CONCURRENCY = 16;
function jevCheckConcurrency() {
  const configured = Number.parseInt(process.env.SCOUT_JEV_CONCURRENCY ?? '', 10);
  if (!Number.isFinite(configured) || configured < 1) return DEFAULT_JEV_CHECK_CONCURRENCY;
  return Math.min(configured, MAX_JEV_CHECK_CONCURRENCY);
}

export class ServiceError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export interface ScoutServiceDependencies {
  classifyListingRelevance?: typeof classifyListingRelevanceWithDeepSeek;
  verifyListingDescription?: typeof verifyListingDescriptionWithDeepSeek;
  classifyListingRelevanceWithJev?: typeof classifyListingRelevanceWithJev;
  verifyListingDescriptionWithJev?: typeof verifyListingDescriptionWithJev;
  classifyTermMatchWithJev?: typeof classifyTermMatchWithJev;
  classifyNegotiabilityWithJev?: typeof classifyNegotiabilityWithJev;
  classifyConditionMatchWithJev?: typeof classifyConditionMatchWithJev;
  classifyWatchVariantWithJev?: typeof classifyWatchVariantWithJev;
  classifyChecksWithJev?: typeof classifyChecksWithJev;
  suggestVariantGroups?: typeof suggestVariantGroupsWithDeepSeek;
  writeResaleListing?: typeof writeResaleListingWithDeepSeek;
  classifyListingRelevanceWithVision?: typeof classifyListingRelevanceWithVision;
  verifyListingDescriptionWithVision?: typeof verifyListingDescriptionWithVision;
  fetchListingDetailHtml?: (url: string, marketplace: Marketplace) => Promise<string>;
  publicExposureWarning?: boolean;
  authEnabled?: boolean;
}

export function marketStatusAfterMiss(currentMissingScans: number, threshold = 3) {
  const missingScans = Math.max(0, Math.floor(currentMissingScans)) + 1;
  return { missingScans, status: missingScans >= threshold ? 'ended' as const : 'active' as const };
}

export function isNightPollingWindow(value = new Date()) {
  const hour = value.getHours();
  return hour >= NIGHT_START_HOUR || hour < NIGHT_END_HOUR;
}

function nextPollingBoundary(from: Date, night: boolean) {
  const boundary = new Date(from);
  if (night && from.getHours() >= NIGHT_START_HOUR) boundary.setDate(boundary.getDate() + 1);
  boundary.setHours(night ? NIGHT_END_HOUR : NIGHT_START_HOUR, 0, 0, 0);
  return boundary;
}

export function nextWatchScanAt(finishedAt: string, dayIntervalMinutes: number, nightIntervalMinutes = DEFAULT_NIGHT_INTERVAL_MINUTES) {
  const from = new Date(finishedAt);
  const dayInterval = Math.max(5, Math.floor(Number(dayIntervalMinutes) || 5));
  const configuredNightInterval = Number(nightIntervalMinutes);
  const nightInterval = Math.max(dayInterval, Math.floor(Number.isFinite(configuredNightInterval) ? configuredNightInterval : DEFAULT_NIGHT_INTERVAL_MINUTES));
  const night = isNightPollingWindow(from);
  const next = new Date(from.getTime() + (night ? nightInterval : dayInterval) * 60_000);
  const boundary = nextPollingBoundary(from, night);
  if (next > boundary) return boundary.toISOString();
  return next.toISOString();
}

/**
 * Keep only the per-marketplace interval overrides that apply to the selected
 * sources, clamping each to the 5-minute safety floor and 1440-minute ceiling.
 * Values that are missing, non-numeric, or for unselected sources are dropped
 * so a stale stored map can never schedule a source that is no longer used.
 */
export function normalizeSourceIntervals(
  sources: Marketplace[],
  overrides: Record<string, unknown> = {},
): Record<string, number> {
  const normalized: Record<string, number> = {};
  for (const source of sources) {
    const raw = overrides?.[source];
    if (raw === undefined || raw === null) continue;
    const value = Number(raw);
    if (!Number.isFinite(value)) continue;
    normalized[source] = Math.min(1440, Math.max(5, Math.floor(value)));
  }
  return normalized;
}

/**
 * Resolve the polling cadence for every selected marketplace: an explicit
 * per-source override when present, otherwise the watch-wide default. This is
 * the effective schedule the running watch uses, independent of how many
 * overrides are stored.
 */
export function watchSourceIntervals(
  sources: Marketplace[],
  defaultMinutes: number,
  overrides: Record<string, unknown> = {},
): Record<string, number> {
  const fallback = Math.max(5, Math.floor(Number(defaultMinutes) || 5));
  const resolved = normalizeSourceIntervals(sources, overrides);
  for (const source of sources) {
    if (resolved[source] === undefined) resolved[source] = fallback;
  }
  return resolved;
}

/**
 * Pick the sources whose recorded next-check time has arrived. A source with
 * no recorded time (first run, newly added source, or a legacy watch written
 * before per-marketplace scheduling) is always due so it can never be starved.
 */
export function dueWatchSources(
  sources: Marketplace[],
  sourceNext: Record<string, string | undefined> = {},
  now = Date.now(),
): Marketplace[] {
  return sources.filter((source) => {
    const scheduledAt = sourceNext[source];
    return !scheduledAt || !Number.isFinite(Date.parse(scheduledAt)) || Date.parse(scheduledAt) <= now;
  });
}

/**
 * Compute the next check time for every selected source after a run. Scanned
 * sources advance by their own interval (or connector backoff, whichever is
 * later); sources that were not due keep their existing time. The watch-wide
 * next_scan_at is the earliest source time, so the scheduler wakes the watch
 * exactly when its next marketplace is ready.
 */
export function nextWatchScanSchedule(options: {
  sources: Marketplace[];
  intervals: Record<string, number>;
  prior: Record<string, string | undefined>;
  scanned: Iterable<Marketplace>;
  finishedAt: string;
  nightIntervalMinutes: number;
  backoff?: Record<string, string | undefined>;
}): { nextBySource: Record<string, string>; nextScanAt: string } {
  const scannedSet = new Set(options.scanned);
  const nextBySource: Record<string, string> = {};
  for (const source of options.sources) {
    const interval = options.intervals[source] ?? 5;
    if (scannedSet.has(source)) {
      let next = nextWatchScanAt(options.finishedAt, interval, options.nightIntervalMinutes);
      const backoffUntil = options.backoff?.[source];
      if (backoffUntil && Date.parse(backoffUntil) > Date.parse(next)) next = backoffUntil;
      nextBySource[source] = next;
    } else if (options.prior[source]) {
      nextBySource[source] = options.prior[source] as string;
    } else {
      nextBySource[source] = nextWatchScanAt(options.finishedAt, interval, options.nightIntervalMinutes);
    }
  }
  const nextScanAt = Object.values(nextBySource).sort()[0] ?? nextWatchScanAt(options.finishedAt, 5, options.nightIntervalMinutes);
  return { nextBySource, nextScanAt };
}

const nowIso = () => new Date().toISOString();

// /api/export: [response key, table] in response order, then redacted settings.
const EXPORT_TABLES = [
  ['watches', 'watches'],
  // The operator's own flip ledger: their data, so it is exported, but
  // never exposed through the debug API.
  ['flips', 'flips'],
  ['listings', 'listings'],
  ['observations', 'observations'],
  ['listingRelevance', 'listing_relevance'],
  ['scans', 'scans'],
  ['notificationDeliveries', 'notification_deliveries'],
  ['marketWatches', 'market_watches'],
  ['marketWatchVersions', 'market_watch_versions'],
  ['marketListings', 'market_listings'],
  ['marketPriceObservations', 'market_price_observations'],
  ['listingActions', 'listing_actions'],
  ['notifications', 'notifications'],
  ['connectorRuns', 'connector_runs'],
] as const;
const EXPORT_NOTE = 'Encrypted credentials, browser sessions, and raw secret values are intentionally omitted. Use the authenticated database backup command for a complete restore point.';
const EXPORT_CHUNK_CHARS = 64 * 1024;
const EXPORT_MAX_OPEN_MS = 10 * 60_000;
const redactExportSetting = (row: Record<string, unknown>) => {
  const key = String(row.key);
  return { key, configured: Boolean(row.value), value: /(?:webhook|ntfy_config|api_key)/i.test(key) ? null : row.value };
};

/** Escape seller text for Discord markdown so a title cannot open its own masked link. */
export function escapeDiscordMarkdown(value: string) {
  return value.replace(/[\\[\]()*_~`|<>]/g, (character) => `\\${character}`);
}

function relativeTime(value?: string | null) {
  if (!value) return 'Never';
  const diff = Math.max(0, Date.now() - Date.parse(value));
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function timeOnly(value?: string | null) {
  if (!value) return '—';
  return new Date(value).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function percentile(values: number[], fraction: number) {
  const sorted = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

type WatchAnalyticsObservation = {
  listingId: number;
  marketplace: Marketplace;
  price: number;
  typical: number | null;
  observedAt: string;
};

function analyticsPriceStats(rows: WatchAnalyticsObservation[]) {
  const prices = rows.map((row) => row.price).filter(Number.isFinite);
  const medianPrice = median(prices);
  const baselinedRows = rows.filter((row) => row.typical !== null && row.typical > 0);
  const strongDealCount = baselinedRows.filter((row) => (dealStrength(row.price, row.typical) ?? 0) >= 3).length;
  return {
    medianPrice,
    lowerPrice: percentile(prices, 0.25),
    upperPrice: percentile(prices, 0.75),
    minPrice: prices.length ? Math.min(...prices) : null,
    maxPrice: prices.length ? Math.max(...prices) : null,
    listingCount: rows.length,
    strongDealCount,
    strongDealRate: baselinedRows.length ? (strongDealCount / baselinedRows.length) * 100 : null,
  };
}

function duration(started?: string | null, finished?: string | null) {
  if (!started || !finished) return '—';
  const milliseconds = Math.max(0, Date.parse(finished) - Date.parse(started));
  return milliseconds < 1000 ? `${milliseconds} ms` : `${(milliseconds / 1000).toFixed(1)} s`;
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  try { return value ? JSON.parse(value) as T : fallback; } catch { return fallback; }
}

function parseListingKey(key: string): { marketplace: Marketplace; listingId: string } {
  const separator = key.indexOf(':');
  const marketplace = separator === -1 ? '' : key.slice(0, separator);
  const listingId = separator === -1 ? '' : key.slice(separator + 1);
  if (!marketplaces.includes(marketplace as Marketplace) || !listingId) throw new ServiceError('Invalid listing key', 400);
  return { marketplace: marketplace as Marketplace, listingId };
}

/**
 * Single OLX offers-API request over HTTP/2. OLX's CloudFront distribution
 * answers HTTP/1.1 API requests with `403 Request blocked` while the identical
 * request over HTTP/2 returns 200 (verified 2026-09-14 with curl
 * `--http1.1` vs default, and Node undici vs `node:http2`), so this bypasses
 * `fetch` (HTTP/1.1-only in undici) for the OLX path. A fresh session per
 * request keeps scan volumes simple; bodies are fully consumed before the
 * session closes, so no socket-diagnostic discard is needed. `node:http2`
 * adds no Accept-Encoding of its own, so the header is sent explicitly and the
 * body decoded here (see decodeOlxApiBody). `connectOptions` exists for tests
 * against a local TLS server.
 */
export function fetchOlxApiSingleRequest(url: string, timeoutMs: number, connectOptions?: SecureClientSessionOptions): Promise<{ status: number; json: unknown; location: string | null }> {
  return new Promise((resolve, reject) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      reject(new Error('Invalid URL'));
      return;
    }
    const session = connectHttp2(`${parsed.protocol}//${parsed.host}`, connectOptions);
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        session.destroy();
      } catch { /* session already gone */ }
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const timer = setTimeout(() => fail(new Error('OLX offers API request timed out')), timeoutMs);
    timer.unref?.();
    session.on('error', fail);
    const request = session.request({
      ':method': 'GET',
      ':path': `${parsed.pathname}${parsed.search}`,
      'user-agent': MARKETPLACE_API_USER_AGENT,
      accept: 'application/json',
      'accept-encoding': 'gzip, deflate, br',
    });
    request.on('error', fail);
    request.on('close', () => {
      if (!settled) fail(new Error('OLX offers API request closed before completing'));
    });
    const chunks: Buffer[] = [];
    let status = 0;
    let location: string | null = null;
    let contentEncoding: string | null = null;
    request.on('response', (headers) => {
      status = Number(headers[':status'] ?? 0);
      const rawEncoding = headers['content-encoding'];
      contentEncoding = (Array.isArray(rawEncoding) ? rawEncoding[0] : rawEncoding) ?? null;
      const rawLocation = headers.location;
      location = Array.isArray(rawLocation) ? (rawLocation[0] ?? null) : (rawLocation ?? null);
    });
    request.on('data', (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
    });
    request.on('end', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        session.close();
      } catch { /* session already gone */ }
      let json: unknown = null;
      try {
        const raw = decodeOlxApiBody(Buffer.concat(chunks), contentEncoding).toString('utf8');
        json = raw ? JSON.parse(raw) : null;
      } catch { /* undecodable or non-JSON bodies (e.g. challenge pages) surface through the status */ }
      resolve({ status, json, location });
    });
    request.end();
  });
}

/** Decompression-bomb guard: an offers page is ~200 KB decoded. */
const OLX_API_MAX_DECODED_BYTES = 16 * 1024 * 1024;

/**
 * Decodes an offers-API body by its Content-Encoding. Identity and unknown
 * encodings pass through unchanged; a corrupt or oversized body throws, which
 * the caller turns into `json: null` so status handling stays fail-closed.
 */
export function decodeOlxApiBody(body: Buffer, contentEncoding: string | null): Buffer {
  if (!body.length) return body;
  const options = { maxOutputLength: OLX_API_MAX_DECODED_BYTES };
  switch (contentEncoding?.trim().toLowerCase()) {
    case 'gzip':
    case 'x-gzip':
      return gunzipSync(body, options);
    case 'deflate':
      // Servers disagree on zlib-wrapped vs raw deflate; accept both.
      try {
        return inflateSync(body, options);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') throw error;
        return inflateRawSync(body, options);
      }
    case 'br':
      return brotliDecompressSync(body, options);
    default:
      return body;
  }
}

function parseListingDecision(value: unknown): ListingDecision | null {
  return value === 'buy' || value === 'watch' || value === 'pass' ? value : null;
}

const runtimeSecret = process.env.SCOUT_SECRET?.trim() || randomBytes(32).toString('base64url');

function secretKey() {
  return createHash('sha256').update(runtimeSecret).digest();
}

export function encryptSecret(value: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', secretKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${encrypted.toString('base64url')}`;
}

export function decryptSecret(value: string) {
  const [ivRaw, tagRaw, encryptedRaw] = value.split('.');
  if (!ivRaw || !tagRaw || !encryptedRaw) throw new Error('Invalid encrypted secret');
  const decipher = createDecipheriv('aes-256-gcm', secretKey(), Buffer.from(ivRaw, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagRaw, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(encryptedRaw, 'base64url')), decipher.final()]).toString('utf8');
}

export function validateDiscordWebhook(value: string) {
  let url: URL;
  try { url = new URL(value); } catch { throw new ServiceError('Enter a valid Discord webhook URL'); }
  const allowedHosts = new Set(['discord.com', 'discordapp.com', 'canary.discord.com', 'ptb.discord.com']);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !allowedHosts.has(url.hostname.toLowerCase()) || !/^\/api\/webhooks\/[^/]+\/[^/]+$/.test(url.pathname) || url.pathname.length > 512) {
    throw new ServiceError('Webhook must be an HTTPS Discord webhook URL');
  }
  return url.toString();
}

function dealLabelFromStrength(strength: number): DealLabel {
  return strength >= 5 ? 'Exceptional' : strength === 4 ? 'Very strong' : strength === 3 ? 'Strong' : 'Watch';
}

/**
 * The widget's deal order (WidgetSnapshot.make in the iOS ScoutKit): visible,
 * untriaged-or-kept rows by deal strength, then the deepest discount, then
 * the newest. Array.prototype.sort is stable, so ties keep feed order.
 */
/** Parses the `?top=` query value of GET /api/dashboard; anything but an integer from 1 to 50 means the full dashboard. */
export function dashboardTopParam(value: unknown): number | undefined {
  if (typeof value !== 'string' || !/^\d{1,2}$/.test(value)) return undefined;
  const top = Number(value);
  return top >= 1 && top <= 50 ? top : undefined;
}

export function widgetDeals(listings: Listing[], limit: number) {
  return listings
    .filter((listing) => listing.hidden !== true && listing.aiFiltered !== true && listing.decision !== 'pass')
    .sort((left, right) => {
      if (left.dealStrength !== right.dealStrength) return right.dealStrength - left.dealStrength;
      const leftBelow = left.belowTypical ?? 0;
      const rightBelow = right.belowTypical ?? 0;
      if (leftBelow !== rightBelow) return leftBelow - rightBelow;
      return left.observedAt === right.observedAt ? 0 : left.observedAt > right.observedAt ? -1 : 1;
    })
    .slice(0, limit);
}

export class ScoutService {
  private db: Database;
  private emit: (event: string, payload: unknown) => void;
  private running = new Set<string>();
  private descriptionVerificationInFlight = new Map<string, Promise<boolean>>();
  private lastSchedulerTickAt: string | null = null;
  private digestRunning = false;
  private readonly classifyListingRelevance: typeof classifyListingRelevanceWithDeepSeek;
  private readonly verifyListingDescription: typeof verifyListingDescriptionWithDeepSeek;
  private readonly jevRelevance: typeof classifyListingRelevanceWithJev;
  private readonly jevVerification: typeof verifyListingDescriptionWithJev;
  private readonly jevTermMatch: typeof classifyTermMatchWithJev;
  private readonly jevNegotiability: typeof classifyNegotiabilityWithJev;
  private readonly jevConditionMatch: typeof classifyConditionMatchWithJev;
  private readonly jevVariant: typeof classifyWatchVariantWithJev;
  private readonly jevChecks: typeof classifyChecksWithJev;
  private readonly aiVariantSuggestions: typeof suggestVariantGroupsWithDeepSeek;
  private readonly aiResaleListing: typeof writeResaleListingWithDeepSeek;
  private readonly visionRelevance: typeof classifyListingRelevanceWithVision;
  private readonly visionVerification: typeof verifyListingDescriptionWithVision;
  private readonly detailHtml: (url: string, marketplace: Marketplace) => Promise<string>;
  private readonly publicExposureWarning: boolean;
  private readonly authEnabled: boolean;
  private readonly schedulerOwner = `scheduler-${process.pid}-${randomBytes(8).toString('hex')}`;
  private activeManualSearches = 0;
  private logSequence = 0;
  private readonly logBuffer: LogEntry[] = [];

  constructor(db: Database, emit: (event: string, payload: unknown) => void, dependencies: ScoutServiceDependencies = {}) {
    this.db = db;
    this.emit = emit;
    this.classifyListingRelevance = dependencies.classifyListingRelevance ?? classifyListingRelevanceWithDeepSeek;
    this.verifyListingDescription = dependencies.verifyListingDescription ?? verifyListingDescriptionWithDeepSeek;
    this.jevRelevance = dependencies.classifyListingRelevanceWithJev ?? classifyListingRelevanceWithJev;
    this.jevVerification = dependencies.verifyListingDescriptionWithJev ?? verifyListingDescriptionWithJev;
    this.jevTermMatch = dependencies.classifyTermMatchWithJev ?? classifyTermMatchWithJev;
    this.jevNegotiability = dependencies.classifyNegotiabilityWithJev ?? classifyNegotiabilityWithJev;
    this.jevConditionMatch = dependencies.classifyConditionMatchWithJev ?? classifyConditionMatchWithJev;
    this.jevVariant = dependencies.classifyWatchVariantWithJev ?? classifyWatchVariantWithJev;
    this.jevChecks = dependencies.classifyChecksWithJev ?? classifyChecksWithJev;
    this.aiVariantSuggestions = dependencies.suggestVariantGroups ?? suggestVariantGroupsWithDeepSeek;
    this.aiResaleListing = dependencies.writeResaleListing ?? writeResaleListingWithDeepSeek;
    this.visionRelevance = dependencies.classifyListingRelevanceWithVision ?? classifyListingRelevanceWithVision;
    this.visionVerification = dependencies.verifyListingDescriptionWithVision ?? verifyListingDescriptionWithVision;
    this.detailHtml = dependencies.fetchListingDetailHtml ?? ((url, marketplace) => this.fetchPublicPage(url, marketplace));
    this.publicExposureWarning = dependencies.publicExposureWarning ?? false;
    this.authEnabled = dependencies.authEnabled ?? false;
  }

  private transaction<T>(callback: () => T, retries = 3): T {
    let attempt = 0;
    for (;;) {
      try {
        this.db.exec('BEGIN IMMEDIATE');
        try {
          const result = callback();
          this.db.exec('COMMIT');
          return result;
        } catch (error) {
          try { this.db.exec('ROLLBACK'); } catch { /* preserve the original database error */ }
          throw error;
        }
      } catch (error) {
        const busy = error instanceof Error && /SQLITE_BUSY|database is locked|busy/i.test(error.message);
        if (busy && attempt < retries) {
          attempt += 1;
          const wait = attempt * 50;
          const start = Date.now();
          while (Date.now() - start < wait) { /* brief backoff for SQLITE_BUSY */ }
          continue;
        }
        throw error;
      }
    }
  }

  // node:sqlite has no internal statement cache and every prepare() re-parses
  // the SQL, so hot loops (storeListing, relevance filtering, shipping
  // enrichment) memoize their statements here. The map is keyed by the full
  // SQL string, so dynamically assembled queries (page predicates) stay
  // distinct per shape and no user text ever lands in a key — filters travel
  // through bind parameters.
  private statements = new Map<string, any>();
  private static readonly STATEMENT_CACHE_LIMIT = 200;

  private stmt(sql: string) {
    let statement = this.statements.get(sql);
    if (!statement) {
      if (this.statements.size >= ScoutService.STATEMENT_CACHE_LIMIT) {
        // Evict the oldest entry so dynamically shaped pagination queries stay bounded.
        const oldest = this.statements.keys().next().value;
        if (oldest !== undefined) this.statements.delete(oldest);
      }
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  /** Escape `%`, `_` and `\` so user text cannot widen a LIKE pattern. */
  private static escapeLike(value: string) {
    return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
  }

  private createScan(watchId: string, watchKind: 'watch' | 'research', marketplace: Marketplace, startedAt = nowIso()) {
    const result = this.stmt('INSERT INTO scans (watch_id, watch_kind, marketplace, status, started_at) VALUES (?, ?, ?, ?, ?)').run(watchId, watchKind, marketplace, 'running', startedAt);
    return Number(result.lastInsertRowid);
  }

  /**
   * Stable ordinal for rotating typo-variant batches: the number of scan
   * attempts recorded for this watch (including the running one). Deterministic
   * per attempt, needs no extra state, and never depends on wall-clock time.
   */
  /**
   * How many scans this watch has run, which rotates the typo-variant batch.
   * watch_kind is not in scans_watch_status, so the kind-filtered count reads
   * every retained scan row; the covering count by watch_id alone is exact
   * unless a watch of the other kind shares the id (ids are client-supplied
   * on create), and then the filtered count is used.
   */
  private scanOrdinal(watchId: string, watchKind: 'watch' | 'research') {
    const otherKind = watchKind === 'watch'
      ? this.stmt('SELECT 1 AS found FROM market_watches WHERE id = ?').get(watchId)
      : this.stmt('SELECT 1 AS found FROM watches WHERE id = ?').get(watchId);
    const row = (otherKind
      ? this.stmt('SELECT COUNT(*) AS count FROM scans WHERE watch_id = ? AND watch_kind = ?').get(watchId, watchKind)
      : this.stmt('SELECT COUNT(*) AS count FROM scans WHERE watch_id = ?').get(watchId)) as { count?: number };
    return Number(row?.count ?? 0);
  }

  private completeScan(scanId: number, message?: string) {
    this.stmt("UPDATE scans SET status = 'completed', completed_at = ?, error = ? WHERE id = ?").run(nowIso(), message ?? null, scanId);
  }

  private failScan(scanId: number, error: unknown) {
    const message = (error instanceof Error ? error.message : String(error || 'Scan failed')).slice(0, 500);
    this.stmt("UPDATE scans SET status = 'failed', completed_at = ?, error = ? WHERE id = ?").run(nowIso(), message, scanId);
  }

  private log(level: LogEntry['level'], scope: LogEntry['scope'], message: string) {
    const entry: LogEntry = { id: ++this.logSequence, at: nowIso(), level, scope, message };
    this.logBuffer.push(entry);
    if (this.logBuffer.length > LOG_BUFFER_LIMIT) this.logBuffer.splice(0, this.logBuffer.length - LOG_BUFFER_LIMIT);
    if (level === 'error') console.error(`[${scope}] ${message}`);
    else console.info(`[${scope}] ${message}`);
    this.emit('log', entry);
  }

  logs(): LogEntry[] {
    return [...this.logBuffer].reverse();
  }

  /** Runtime diagnostics (memory, fetch body discards) surfaced through the same log buffer and SSE stream as scan logs. */
  logDiagnostic(message: string) {
    this.log('info', 'diagnostics', message);
  }

  schedulerTick() {
    // A failed tick is logged and retried on the next interval instead of
    // escaping setInterval and ending the process. The tick timestamp only
    // advances on success, so /api/ready reports a scheduler that keeps failing.
    try {
      if (this.tryAcquireSchedulerLease()) this.queueDue();
      this.lastSchedulerTickAt = nowIso();
    } catch (error) {
      this.logBackgroundError('Scheduler tick', error);
    }
  }

  /** Runs detached async work; a rejection is logged instead of becoming an unhandled rejection. */
  private background(label: string, task: Promise<unknown>) {
    task.catch((error) => this.logBackgroundError(label, error));
  }

  private logBackgroundError(label: string, error: unknown) {
    this.log('error', 'diagnostics', `${label} failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  private tryAcquireSchedulerLease() {
    const now = nowIso();
    const expiresAt = new Date(Date.now() + 45_000).toISOString();
    try {
      const update = this.stmt('UPDATE scheduler_leases SET owner_id = ?, expires_at = ? WHERE id = 1 AND (owner_id = ? OR expires_at <= ?)').run(this.schedulerOwner, expiresAt, this.schedulerOwner, now);
      if (Number(update.changes) > 0) return true;
      const insert = this.stmt('INSERT OR IGNORE INTO scheduler_leases (id, owner_id, expires_at) VALUES (1, ?, ?)').run(this.schedulerOwner, expiresAt);
      return Number(insert.changes) > 0;
    } catch {
      return false;
    }
  }

  readiness() {
    let database = false;
    let databaseError: string | null = null;
    try {
      const result = this.stmt('SELECT 1 AS ok').get() as { ok?: number } | undefined;
      database = result?.ok === 1;
    } catch (error) {
      databaseError = error instanceof Error ? error.message : 'Database probe failed';
    }
    const lastTickAgeMs = this.lastSchedulerTickAt ? Math.max(0, Date.now() - Date.parse(this.lastSchedulerTickAt)) : null;
    let staleScans = 0;
    let migration: { count?: number; latest?: string | null } = { count: 0, latest: null };
    let degradedConnectors: Array<Connector['name']> = [];
    try {
      if (database) {
        staleScans = Number((this.stmt("SELECT COUNT(*) AS count FROM scans WHERE status = 'running' OR status = 'interrupted'").get() as { count?: number } | undefined)?.count ?? 0);
        migration = this.stmt('SELECT COUNT(*) AS count, MAX(id) AS latest FROM migrations').get() as { count?: number; latest?: string | null };
        degradedConnectors = this.getConnectors(false).filter((connector) => connector.status === 'Degraded').map((connector) => connector.name);
      }
    } catch (error) {
      database = false;
      databaseError = error instanceof Error ? error.message : 'Database readiness probe failed';
    }
    const scheduler = {
      lastTickAt: this.lastSchedulerTickAt,
      ageMs: lastTickAgeMs,
      healthy: lastTickAgeMs !== null && lastTickAgeMs < 90_000,
    };
    const ready = database && scheduler.healthy;
    return {
      status: ready ? 'ready' as const : 'not-ready' as const,
      database: { ok: database, error: databaseError },
      scheduler,
      scans: { staleOrInterrupted: staleScans },
      migrations: { count: Number(migration?.count ?? 0), latest: migration?.latest ?? null },
      connectors: { degraded: degradedConnectors, degradedCount: degradedConnectors.length },
    };
  }

  private getSetting(key: string) {
    const row = this.stmt('SELECT value FROM settings WHERE key = ?').get(key) as { value?: string } | undefined;
    return row?.value ?? null;
  }

  private setSetting(key: string, value: string) {
    this.stmt('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run(key, value, nowIso());
  }

  private dailyDigestConfig(): DailyDigestConfig {
    const stored = parseJson<Partial<DailyDigestConfig>>(this.getSetting('daily_digest_config'), {});
    const time = typeof stored.time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(stored.time)
      ? stored.time
      : DEFAULT_DAILY_DIGEST_CONFIG.time;
    return {
      enabled: stored.enabled === true,
      time,
      discord: stored.discord === undefined ? DEFAULT_DAILY_DIGEST_CONFIG.discord : stored.discord === true,
      ntfy: stored.ntfy === true,
    };
  }

  private dailyDigestSettings(): DailyDigestSettings {
    return { ...this.dailyDigestConfig(), lastSentAt: this.getSetting('daily_digest_last_sent_at') };
  }

  private localDateAndTime(value = new Date()) {
    const pad = (part: number) => String(part).padStart(2, '0');
    return {
      date: `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`,
      time: `${pad(value.getHours())}:${pad(value.getMinutes())}`,
    };
  }

  private deepSeekApiKey() {
    // Keep reading the old key name so switching providers does not invalidate
    // an already saved token; newly saved credentials use the OpenRouter name.
    for (const key of ['openrouter_api_key', 'deepseek_api_key']) {
      const stored = this.getSetting(key);
      if (stored) {
        try {
          const decrypted = decryptSecret(stored).trim();
          if (decrypted) return { apiKey: decrypted, source: 'settings' as const };
        } catch {
          // Fall through to the next stored key or environment variable so a
          // damaged optional setting cannot prevent the rest of Scout from starting.
        }
      }
    }
    const environment = process.env.SCOUT_OPENROUTER_API_KEY?.trim()
      || process.env.OPENROUTER_API_KEY?.trim()
      || process.env.SCOUT_DEEPSEEK_API_KEY?.trim();
    return environment ? { apiKey: environment, source: 'environment' as const } : { apiKey: null, source: 'none' as const };
  }

  private deepSeekModel() {
    return normalizeOpenRouterModel(this.getSetting('deepseek_model')?.trim()
      || process.env.SCOUT_OPENROUTER_MODEL?.trim()
      || process.env.SCOUT_DEEPSEEK_MODEL?.trim()
      || DEFAULT_DEEPSEEK_MODEL);
  }

  private deepSeekConfig() {
    const credential = this.deepSeekApiKey();
    return {
      apiKey: credential.apiKey,
      model: this.deepSeekModel(),
      source: credential.source,
    };
  }

  /**
   * Jev shadow configuration (Phase 1: measure-only). Only SCOUT_JEV_MODE=shadow
   * opts in — shadow calls double AI traffic and must never surprise a
   * production scan. Reuses the OpenRouter key.
   */
  private jevShadowConfig() {
    const mode = process.env.SCOUT_JEV_MODE?.trim().toLowerCase();
    if (mode !== 'shadow') return null;
    const apiKey = this.deepSeekApiKey().apiKey;
    if (!apiKey) return null;
    return {
      mode,
      apiKey,
      jevModel: process.env.SCOUT_JEV_MODEL?.trim() || DEFAULT_JEV_MODEL,
      visionModel: process.env.SCOUT_VISION_MODEL?.trim() || DEFAULT_VISION_MODEL,
    };
  }

  /**
   * Jev live configuration (Phase 2: Jev decides, vision escalates, DeepSeek
   * is out of the relevance/verification loop). Live is the default whenever
   * an OpenRouter key is available — opt out explicitly with
   * SCOUT_JEV_MODE=legacy, or measure against DeepSeek with
   * SCOUT_JEV_MODE=shadow. Allowlisted on purpose: anything unrecognized
   * (including typos of either mode) keeps legacy behavior instead of
   * surprising anyone with new traffic.
   */
  private jevLiveConfig() {
    const mode = process.env.SCOUT_JEV_MODE?.trim().toLowerCase();
    if (mode !== undefined && mode !== '' && mode !== 'live') return null;
    const apiKey = this.deepSeekApiKey().apiKey;
    if (!apiKey) return null;
    return {
      apiKey,
      jevModel: process.env.SCOUT_JEV_MODEL?.trim() || DEFAULT_JEV_MODEL,
      visionModel: process.env.SCOUT_VISION_MODEL?.trim() || DEFAULT_VISION_MODEL,
    };
  }

  private logJevLive(
    task: 'relevance' | 'verification' | 'term-match' | 'negotiability' | 'condition' | 'variant',
    inputHash: string,
    live: NonNullable<ReturnType<ScoutService['jevLiveConfig']>>,
    jev: { jevAnswer?: unknown; jevConfidence?: number | null; jevUnsure?: boolean; jevError?: string | null },
    vision?: { visionVerdict?: string | null; visionConfidence?: number | null; visionImagesSeen?: number | null; visionError?: string | null },
  ) {
    this.logJevShadow({
      task, inputHash, jevModel: live.jevModel,
      jevAnswer: jev.jevAnswer, jevConfidence: jev.jevConfidence, jevUnsure: jev.jevUnsure, jevError: jev.jevError,
      deepseekDecision: null, agreement: null,
      visionVerdict: vision?.visionVerdict, visionConfidence: vision?.visionConfidence,
      visionImagesSeen: vision?.visionImagesSeen, visionError: vision?.visionError,
      note: 'live',
    });
  }

  private logJevShadow(row: {
    task: 'relevance' | 'verification' | 'term-match' | 'negotiability' | 'condition' | 'variant';
    inputHash: string;
    jevModel: string;
    jevAnswer?: unknown;
    jevConfidence?: number | null;
    jevUnsure?: boolean;
    jevError?: string | null;
    deepseekDecision?: string | null;
    agreement?: boolean | null;
    visionVerdict?: string | null;
    visionConfidence?: number | null;
    visionImagesSeen?: number | null;
    visionError?: string | null;
    note?: string | null;
  }) {
    try {
      this.stmt(`INSERT INTO jev_shadow_log (created_at, task, input_hash, jev_model, jev_answer_json, jev_confidence, jev_unsure, jev_error, deepseek_decision, agreement, vision_verdict, vision_confidence, vision_images_seen, vision_error, note)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        nowIso(),
        row.task,
        row.inputHash,
        row.jevModel,
        row.jevAnswer !== undefined ? JSON.stringify(row.jevAnswer).slice(0, 2000) : null,
        row.jevConfidence ?? null,
        row.jevUnsure ? 1 : 0,
        row.jevError?.slice(0, 500) ?? null,
        row.deepseekDecision?.slice(0, 60) ?? null,
        row.agreement === undefined || row.agreement === null ? null : row.agreement ? 1 : 0,
        row.visionVerdict?.slice(0, 60) ?? null,
        row.visionConfidence ?? null,
        row.visionImagesSeen ?? null,
        row.visionError?.slice(0, 500) ?? null,
        row.note?.slice(0, 500) ?? null,
      );
    } catch {
      // Shadow logging must never break scans; a missing table (migration not
      // yet applied) or locked DB simply drops the sample.
    }
  }

  /**
   * Shadow Jev relevance: runs after the DeepSeek decision, compares, and —
   * when Jev is unsure — tiebreaks with the vision model over the thumbnail
   * (option (a)). Fire-and-forget; behavior always follows DeepSeek in Phase 1.
   */
  private shadowJevRelevance(
    context: ListingRelevanceContext,
    inputHash: string,
    deepseekRelevant: boolean | null,
    imageUrl: string | null | undefined,
    shadow: NonNullable<ReturnType<ScoutService['jevShadowConfig']>>,
  ) {
    void (async () => {
      let judgment: JevRelevanceJudgment;
      try {
        judgment = await classifyListingRelevanceWithJev(context, { apiKey: shadow.apiKey, model: shadow.jevModel });
      } catch (error) {
        this.logJevShadow({
          task: 'relevance', inputHash, jevModel: shadow.jevModel,
          jevError: error instanceof Error ? error.message : String(error),
          deepseekDecision: deepseekRelevant === null ? 'unknown' : deepseekRelevant ? 'relevant' : 'irrelevant',
        });
        return;
      }
      const deepseekDecision = deepseekRelevant === null ? 'unknown' : deepseekRelevant ? 'relevant' : 'irrelevant';
      const agreement = deepseekRelevant === null ? null : (judgment.relevant ? 'relevant' : 'irrelevant') === deepseekDecision;
      if (!judgment.unsure) {
        this.logJevShadow({
          task: 'relevance', inputHash, jevModel: shadow.jevModel,
          jevAnswer: judgment, jevConfidence: judgment.p, jevUnsure: false,
          deepseekDecision, agreement,
        });
        return;
      }
      try {
        const vision = await classifyListingRelevanceWithVision(
          { query: context.query, title: context.title, condition: context.condition, imageUrl: imageUrl ?? null },
          { apiKey: shadow.apiKey, model: shadow.visionModel },
        );
        this.logJevShadow({
          task: 'relevance', inputHash, jevModel: shadow.jevModel,
          jevAnswer: judgment, jevConfidence: judgment.p, jevUnsure: true,
          deepseekDecision, agreement,
          visionVerdict: vision.relevant ? 'relevant' : 'irrelevant',
          visionConfidence: vision.confidence, visionImagesSeen: vision.imagesSeen,
        });
      } catch (error) {
        this.logJevShadow({
          task: 'relevance', inputHash, jevModel: shadow.jevModel,
          jevAnswer: judgment, jevConfidence: judgment.p, jevUnsure: true,
          deepseekDecision, agreement,
          visionError: error instanceof Error ? error.message : String(error),
        });
      }
    })().catch(() => { /* shadow path never rejects */ });
  }

  /**
   * Shadow Jev verification with vision escalation for high-priority deals:
   * Jev unsure (unknown verdict or confidence below threshold) or Jev call
   * failure routes to the vision model over gallery photos parsed from the
   * already-fetched detail HTML. Measure-only in Phase 1.
   */
  private shadowJevVerification(
    context: ListingDescriptionVerificationContext,
    inputHash: string,
    deepseekDecision: string,
    galleryImageUrls: string[],
    shadow: NonNullable<ReturnType<ScoutService['jevShadowConfig']>>,
  ) {
    void (async () => {
      let judgment: JevVerificationJudgment;
      try {
        judgment = await verifyListingDescriptionWithJev(context, { apiKey: shadow.apiKey, model: shadow.jevModel });
      } catch (error) {
        await this.shadowVisionVerification(context, inputHash, deepseekDecision, galleryImageUrls, shadow, {
          jevModel: shadow.jevModel, jevError: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      const agreement = judgment.decision === deepseekDecision;
      if (!judgment.unsure) {
        this.logJevShadow({
          task: 'verification', inputHash, jevModel: shadow.jevModel,
          jevAnswer: judgment, jevConfidence: judgment.confidence, jevUnsure: false,
          deepseekDecision, agreement,
        });
        return;
      }
      await this.shadowVisionVerification(context, inputHash, deepseekDecision, galleryImageUrls, shadow, {
        jevModel: shadow.jevModel, jevAnswer: judgment, jevConfidence: judgment.confidence, jevUnsure: true,
        agreement,
      });
    })().catch(() => { /* shadow path never rejects */ });
  }

  private async shadowVisionVerification(
    context: ListingDescriptionVerificationContext,
    inputHash: string,
    deepseekDecision: string,
    galleryImageUrls: string[],
    shadow: NonNullable<ReturnType<ScoutService['jevShadowConfig']>>,
    jev: { jevModel: string; jevAnswer?: unknown; jevConfidence?: number | null; jevUnsure?: boolean; jevError?: string | null; agreement?: boolean | null },
  ) {
    try {
      const vision = await verifyListingDescriptionWithVision(
        { marketplace: context.marketplace, title: context.title, condition: context.condition, description: context.description, imageUrls: galleryImageUrls, query: context.query, includedTerms: context.includedTerms, excludedTerms: context.excludedTerms, checks: context.checks },
        { apiKey: shadow.apiKey, model: shadow.visionModel },
      );
      this.logJevShadow({
        task: 'verification', inputHash, ...jev,
        deepseekDecision,
        visionVerdict: vision.decision, visionConfidence: vision.confidence, visionImagesSeen: vision.imagesSeen,
      });
    } catch (error) {
      this.logJevShadow({
        task: 'verification', inputHash, ...jev,
        deepseekDecision,
        visionError: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Live relevance decision (Phase 2, spend-controlled): exactly one Jev call
   * per uncached listing. A confident judgment decides; an unsure judgment
   * falls back to its lean (cached as a decisive verdict so repeat scans
   * reuse it); a Jev failure stays 'unknown' (kept, like the legacy path).
   * Vision escalation is reserved for high-priority description verification,
   * never for filter-only relevance — the relevance unsure rate (~88% in
   * production) made every filtered listing cost 2 Jev calls plus vision.
   */
  private async decideRelevanceLive(
    context: ListingRelevanceContext,
    inputHash: string,
    live: NonNullable<ReturnType<ScoutService['jevLiveConfig']>>,
  ): Promise<{ relevant: boolean; status: 'relevant' | 'irrelevant' | 'unknown'; reason: string; error?: string }> {
    try {
      const judgment = await this.jevRelevance(context, { apiKey: live.apiKey, model: live.jevModel });
      const status: 'relevant' | 'irrelevant' = judgment.relevant ? 'relevant' : 'irrelevant';
      this.logJevLive('relevance', inputHash, live, { jevAnswer: judgment, jevConfidence: judgment.p, jevUnsure: judgment.unsure });
      if (!judgment.unsure) return { relevant: judgment.relevant, status, reason: `Jev classified listing as ${status} (p=${judgment.p.toFixed(2)})` };
      // Unsure: follow the lean rather than spending a second Jev call plus
      // vision — an accessory-leaning judgment excludes the listing outright
      // instead of alerting on it.
      return { relevant: judgment.relevant, status, reason: `Jev leaned ${status} (p=${judgment.p.toFixed(2)})` };
    } catch (error) {
      const message = (error instanceof Error ? error.message : 'Jev could not classify listing relevance').slice(0, 500);
      this.logJevLive('relevance', inputHash, live, { jevError: message });
      return { relevant: true, status: 'unknown', reason: 'Jev relevance check failed', error: message };
    }
  }

  /**
   * Live description verification (Phase 2): Jev decides; unsure or Jev
   * failure escalates to exactly one vision call over the gallery photos.
   * When vision fails after an unsure Jev answer, Jev's lean decides; when
   * Jev failed too, the error propagates so the caller keeps the fail-open
   * alert behavior for provider outages.
   */
  private async verifyDescriptionLive(
    context: ListingDescriptionVerificationContext,
    inputHash: string,
    galleryImageUrls: string[],
    live: NonNullable<ReturnType<ScoutService['jevLiveConfig']>>,
  ): Promise<ListingDescriptionVerification> {
    const visionInput = {
      marketplace: context.marketplace,
      title: context.title,
      condition: context.condition,
      description: context.description,
      imageUrls: galleryImageUrls,
      query: context.query,
      includedTerms: context.includedTerms,
      excludedTerms: context.excludedTerms,
      checks: context.checks,
    };
    const visionConfig = { apiKey: live.apiKey, model: live.visionModel };

    let judgment: JevVerificationJudgment | null = null;
    let jevFailed: string | null = null;
    try {
      judgment = await this.jevVerification(context, { apiKey: live.apiKey, model: live.jevModel });
      if (!judgment.unsure) {
        const verification: ListingDescriptionVerification = {
          decision: judgment.decision,
          confidence: judgment.confidence ?? 0,
          summary: `Jev verification ${judgment.decision}.`,
          issues: judgment.issues ?? [],
          evidence: [],
        };
        this.logJevLive('verification', inputHash, live, { jevAnswer: judgment, jevConfidence: judgment.confidence, jevUnsure: false });
        return verification;
      }
    } catch (error) {
      jevFailed = error instanceof Error ? error.message : String(error);
    }

    try {
      const vision = await this.visionVerification(visionInput, visionConfig);
      const verification = visionToVerification(vision, judgment ? 'Jev was unsure; vision tiebreak.' : 'Jev failed; vision decided directly.');
      this.logJevLive('verification', inputHash, live,
        judgment
          ? { jevAnswer: judgment, jevConfidence: judgment.confidence, jevUnsure: true }
          : { jevError: jevFailed },
        { visionVerdict: vision.decision, visionConfidence: vision.confidence, visionImagesSeen: vision.imagesSeen });
      return verification;
    } catch (visionError) {
      const message = visionError instanceof Error ? visionError.message : String(visionError);
      this.logJevLive('verification', inputHash, live,
        judgment
          ? { jevAnswer: judgment, jevConfidence: judgment.confidence, jevUnsure: true }
          : { jevError: jevFailed },
        { visionError: message.slice(0, 500) });
      // A failed tiebreak must not discard a Jev answer we already have: the
      // unsure verdict stands as the lean (a 0.59 pass still alerts).
      if (judgment) {
        const confidence = judgment.confidence === null ? 'none' : judgment.confidence.toFixed(2);
        return {
          decision: judgment.decision,
          confidence: judgment.confidence ?? 0,
          summary: `Jev leaned ${judgment.decision} (confidence ${confidence}); vision tiebreak failed.`.slice(0, 240),
          issues: judgment.issues ?? [],
          evidence: [],
        };
      }
      throw visionError;
    }
  }

  private saveListingRelevance(input: {
    watchId: string;
    listing: NormalizedListing;
    inputHash: string;
    model: string;
    relevant: boolean;
    status: 'relevant' | 'irrelevant' | 'unknown';
    reason: string;
    error?: string | null;
  }) {
    this.stmt(`INSERT INTO listing_relevance (watch_id, marketplace, listing_id, input_hash, model, relevant, reason, error, checked_at, relevance_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(watch_id, marketplace, listing_id) DO UPDATE SET input_hash = excluded.input_hash, model = excluded.model, relevant = excluded.relevant, reason = excluded.reason, error = excluded.error, checked_at = excluded.checked_at, relevance_status = excluded.relevance_status`).run(
      input.watchId,
      input.listing.marketplace,
      input.listing.listingId,
      input.inputHash,
      input.model,
      input.relevant ? 1 : 0,
      input.reason.slice(0, 240),
      input.error?.slice(0, 500) ?? null,
      nowIso(),
      input.status,
    );
  }

  /**
   * Manual-search relevance cache. Same input hash + model the watch path uses,
   * but with no watch row; a hit skips the Jev/DeepSeek call entirely. Reads are
   * best-effort: a missing table (migration not yet applied) is a miss.
   */
  private readManualRelevance(inputHash: string, legacyInputHash: string, model: string): 'relevant' | 'irrelevant' | null {
    try {
      const row = (this.stmt('SELECT relevant, relevance_status, error FROM manual_relevance_cache WHERE input_hash = ? AND model = ?').get(inputHash, model)
        ?? this.stmt('SELECT relevant, relevance_status, error FROM manual_relevance_cache WHERE input_hash = ? AND model = ?').get(legacyInputHash, model)) as
        { relevant?: number; relevance_status?: string; error?: string | null } | undefined;
      if (!row || row.error) return null;
      if (row.relevance_status === 'irrelevant' || row.relevant === 0) return 'irrelevant';
      if (row.relevance_status === 'relevant' || row.relevant === 1) return 'relevant';
      return null;
    } catch {
      return null;
    }
  }

  private saveManualRelevance(input: {
    inputHash: string;
    model: string;
    relevant: boolean;
    status: 'relevant' | 'irrelevant';
    reason: string;
    error?: string | null;
  }) {
    this.stmt(`INSERT INTO manual_relevance_cache (input_hash, model, relevant, relevance_status, reason, error, checked_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(input_hash, model) DO UPDATE SET relevant = excluded.relevant, relevance_status = excluded.relevance_status, reason = excluded.reason, error = excluded.error, checked_at = excluded.checked_at`).run(
      input.inputHash,
      input.model,
      input.relevant ? 1 : 0,
      input.status,
      input.reason.slice(0, 240),
      input.error?.slice(0, 500) ?? null,
      nowIso(),
    );
  }

  /**
   * Human-readable scan note for the AI relevance pass. Mirrors the inline
   * wording manual search uses, plus the deal-strength skip count.
   */
  private relevanceNote(relevance: RelevanceFilterResult, row: WatchRow): string {
    if (relevance.notConfigured && (row.ai_relevance === undefined || Boolean(row.ai_relevance))) return ' · AI relevance inactive';
    const parts: string[] = [];
    if (relevance.unknown) parts.push(`${relevance.unknown} AI checks unknown`);
    if (relevance.excluded) parts.push(`${relevance.excluded} excluded by AI`);
    if (relevance.skipped) parts.push(`${relevance.skipped} below AI check threshold`);
    return parts.length ? ` · ${parts.join(' · ')}` : '';
  }

  private async filterListingsByAiRelevance(
    listings: NormalizedListing[],
    search: ListingRelevanceSearch,
    watchId: string | undefined,
    enabled: boolean,
    /**
     * Optional deal-strength gate: when supplied, a listing whose price does
     * not (yet) clear the bar is kept as `unknown` without spending an AI call.
     * Cache reads still run first, so a decision made when the listing was
     * stronger is reused.
     */
    gate?: (listing: NormalizedListing) => boolean,
  ): Promise<RelevanceFilterResult> {
    if (!enabled || !listings.length) return { listings, excluded: 0, failed: 0, unknown: 0, skipped: 0, notConfigured: false };
    const config = this.deepSeekConfig();
    if (!config.apiKey) return { listings, excluded: 0, failed: 0, unknown: 0, skipped: 0, notConfigured: true };
    const apiKey = config.apiKey;
    // Shadow fires only on live DeepSeek calls below: cache hits, cross-listing
    // reuse, and budget-exhausted rows return before the hook by design (nothing
    // new to compare), while the error path shadows with a null decision.
    const jevShadow = this.jevShadowConfig();
    const jevLive = this.jevLiveConfig();
    // Live mode scopes every cache read/write to the Jev model so legacy
    // DeepSeek rows are never reused as live decisions (first live scan
    // re-evaluates them; afterwards Jev rows reuse normally).
    const activeModel = jevLive ? jevLive.jevModel : config.model;
    const AI_RELEVANCE_BUDGET_PER_SCAN = 40;
    let aiCalls = 0;
    let skipped = 0;
    const pendingClassifications = new Map<string, Promise<{ relevant: boolean }>>();
    const pendingLive = new Map<string, Promise<{ relevant: boolean; status: 'relevant' | 'irrelevant' | 'unknown'; reason: string; error?: string }>>();
    // Relevance rows are collected while the AI calls are awaited and flushed
    // in one transaction after the pass: a per-row autocommit would mean a
    // commit per listing, and the transaction must never span an await.
    const relevanceWrites: Array<Parameters<ScoutService['saveListingRelevance']>[0]> = [];
    // Manual searches have no watch row to key `listing_relevance` on, so their
    // decisions go to a listing-scoped cache keyed by the same input hash. A
    // repeat of the same search then costs no AI calls and no wait.
    const manualRelevanceWrites: Array<Parameters<ScoutService['saveManualRelevance']>[0]> = [];
    const persistRelevance = (
      listing: NormalizedListing,
      inputHash: string,
      model: string,
      relevant: boolean,
      status: 'relevant' | 'irrelevant' | 'unknown',
      reason: string,
      error: string | null = null,
    ) => {
      if (watchId) relevanceWrites.push({ watchId, listing, inputHash, model, relevant, status, reason, error });
      // Unknown means "not judged" — caching it would suppress a later real check.
      else if (status !== 'unknown') manualRelevanceWrites.push({ inputHash, model, relevant, status, reason, error });
    };
    type CachedRelevance = { input_hash?: string; model?: string; relevant?: number; reason?: string; error?: string | null; relevance_status?: string };
    // Gate-skipped and budget-exhausted listings are re-marked 'unknown' on
    // every scan. When the stored row already says exactly that, rewriting it
    // would only move checked_at (read by nothing but the 180-day prune), so
    // the write is skipped.
    const persistNotJudged = (listing: NormalizedListing, inputHash: string, cached: CachedRelevance | undefined, reason: string) => {
      if (cached
        && cached.input_hash === inputHash
        && cached.model === activeModel
        && cached.relevance_status === 'unknown'
        && Number(cached.relevant) === 1
        && (cached.reason ?? '') === reason.slice(0, 240)
        && (cached.error ?? null) === null) return;
      persistRelevance(listing, inputHash, activeModel, true, 'unknown', reason);
    };

    // Jev relevance calls are network round trips and independent per listing,
    // so they run through a worker pool: a slow call holds only its own slot
    // and cache hits never wait for one. Workers start listings in index
    // order and everything before a listing's first await (cache reads, the
    // gate, the budget count and the in-flight dedup) runs synchronously, so
    // budgets and dedup match a sequential pass.
    const classified = await mapPool(listings, jevCheckConcurrency(), async (listing): Promise<{ listing: NormalizedListing; status: 'relevant' | 'irrelevant' | 'unknown' }> => {
      const context: ListingRelevanceContext = {
        marketplace: listing.marketplace,
        title: listing.title,
        condition: listing.condition,
        location: listing.location,
        query: search.query,
        includedTerms: search.includedTerms,
        excludedTerms: search.excludedTerms,
      };
      const inputHash = listingRelevanceInputHash(context);
      const legacyInputHash = legacyListingRelevanceInputHash(context);
      let cached: CachedRelevance | undefined;
      if (watchId) {
        cached = this.stmt('SELECT input_hash, model, relevant, reason, error, relevance_status FROM listing_relevance WHERE watch_id = ? AND marketplace = ? AND listing_id = ?').get(watchId, listing.marketplace, listing.listingId) as CachedRelevance | undefined;
        const cachedStatus: 'relevant' | 'irrelevant' | 'unknown' = cached?.relevance_status === 'irrelevant' || cached?.relevance_status === 'unknown' || cached?.relevance_status === 'relevant'
          ? cached.relevance_status
          : cached?.error ? 'unknown' : cached?.relevant === 0 ? 'irrelevant' : 'relevant';
        if ((cached?.input_hash === inputHash || cached?.input_hash === legacyInputHash) && cached.model === activeModel && cachedStatus !== 'unknown' && !cached.error) {
          if (cached.input_hash === legacyInputHash) persistRelevance(listing, inputHash, activeModel, cachedStatus === 'relevant', cachedStatus, cached.reason ?? 'Reused cached relevance decision');
          return { listing, status: cachedStatus };
        }
      } else {
        const manual = this.readManualRelevance(inputHash, legacyInputHash, activeModel);
        if (manual) return { listing, status: manual };
      }

      // Cross-listing reuse is keyed by input hash, which omits the per-listing
      // URL/thumbnail live escalation uses — live mode relies on the
      // per-listing watch cache above instead.
      const reusable = !jevLive ? this.stmt(`SELECT relevant, reason, relevance_status FROM listing_relevance
        WHERE input_hash = ? AND model = ? AND relevance_status IN ('relevant', 'irrelevant') AND error IS NULL
        ORDER BY checked_at DESC LIMIT 1`).get(inputHash, activeModel) as { relevant?: number; reason?: string; relevance_status?: string } | undefined : undefined;
      if (reusable) {
        const status: 'relevant' | 'irrelevant' = reusable.relevance_status === 'irrelevant' || reusable.relevant === 0 ? 'irrelevant' : 'relevant';
        persistRelevance(listing, inputHash, activeModel, status === 'relevant', status, reusable.reason ?? 'Reused cached relevance decision');
        return { listing, status };
      }

      // Deal-strength gate: an uncached listing that is neither a notifiable
      // deal nor a very strong display candidate is kept (unknown) without
      // spending an AI call. This is the main lever on Jev/DeepSeek spend —
      // the check runs after cache reuse so cached decisions still apply.
      if (gate && !gate(listing)) {
        skipped += 1;
        persistNotJudged(listing, inputHash, cached, 'AI relevance skipped: deal below the Very strong threshold');
        return { listing, status: 'unknown' as const };
      }

      // Per-scan budget: uncached listings beyond the budget stay unknown
      // instead of burning quota on every scan before the cache warms.
      // Live dedupe is per listing (not per input hash): the escalation path
      // uses each listing's own URL and thumbnail, which the hash omits.
      const liveKey = `${inputHash}|${listing.url}|${listing.imageUrl ?? ''}`;
      if (aiCalls >= AI_RELEVANCE_BUDGET_PER_SCAN && !pendingClassifications.has(inputHash) && !pendingLive.has(liveKey)) {
        persistNotJudged(listing, inputHash, cached, 'AI relevance budget exhausted for this scan');
        return { listing, status: 'unknown' as const };
      }
      if (jevLive) {
        try {
          let decision = pendingLive.get(liveKey);
          if (!decision) {
            aiCalls += 1;
            decision = this.decideRelevanceLive(context, inputHash, jevLive);
            pendingLive.set(liveKey, decision);
          }
          const live = await decision;
          persistRelevance(listing, inputHash, jevLive.jevModel, live.relevant, live.status, live.reason, live.error ?? null);
          return { listing, status: live.status };
        } catch (error) {
          const message = (error instanceof Error ? error.message : 'Jev could not classify listing relevance').slice(0, 500);
          persistRelevance(listing, inputHash, jevLive.jevModel, true, 'unknown', 'Jev relevance check failed unexpectedly', message);
          return { listing, status: 'unknown' };
        }
      }
      try {
        let classification = pendingClassifications.get(inputHash);
        if (!classification) {
          aiCalls += 1;
          classification = this.classifyListingRelevance(context, { apiKey, model: config.model });
          pendingClassifications.set(inputHash, classification);
        }
        const result = await classification;
        if (jevShadow) this.shadowJevRelevance(context, inputHash, result.relevant, listing.imageUrl, jevShadow);
        const status: 'relevant' | 'irrelevant' = result.relevant ? 'relevant' : 'irrelevant';
        persistRelevance(listing, inputHash, activeModel, result.relevant, status, result.relevant ? 'AI classified listing as relevant' : 'AI classified listing as irrelevant');
        return { listing, status };
      } catch (error) {
        const message = (error instanceof Error ? error.message : 'OpenRouter could not classify listing relevance').slice(0, 500);
        persistRelevance(listing, inputHash, activeModel, true, 'unknown', 'AI relevance check failed', message);
        if (jevShadow) this.shadowJevRelevance(context, inputHash, null, listing.imageUrl, jevShadow);
        return { listing, status: 'unknown' };
      }
    });
    if (relevanceWrites.length || manualRelevanceWrites.length) {
      this.transaction(() => {
        for (const input of relevanceWrites) this.saveListingRelevance(input);
        for (const input of manualRelevanceWrites) this.saveManualRelevance(input);
      });
    }

    return {
      listings: classified.filter((item) => item.status !== 'irrelevant').map((item) => item.listing),
      excluded: classified.filter((item) => item.status === 'irrelevant').length,
      failed: classified.filter((item) => item.status === 'unknown').length - skipped,
      unknown: classified.filter((item) => item.status === 'unknown').length - skipped,
      skipped,
      notConfigured: false,
    };
  }

  /**
   * Manual-search Jev checks. Listings Jev rejects (a near-certain exclude
   * match or a confidently missing requirement) are dropped; the rest come
   * back tagged passed / unconfirmed / unchecked so the page can show only
   * confirmed matches. Descriptions come from the OLX offers API for free and
   * from a bounded number of detail pages otherwise; title-only judgments are
   * never cached, so a later search with a description can still decide.
   */
  private async applySearchChecks(listings: NormalizedListing[], checks: VerificationCheck[]): Promise<{
    listings: NormalizedListing[];
    status: Map<NormalizedListing, { state: 'passed' | 'unconfirmed' | 'unchecked'; note: string }>;
    rejected: number;
    inactive: boolean;
  }> {
    const status = new Map<NormalizedListing, { state: 'passed' | 'unconfirmed' | 'unchecked'; note: string }>();
    const live = this.jevLiveConfig();
    if (!checks.length || !listings.length || !live) {
      if (checks.length) for (const listing of listings) status.set(listing, { state: 'unchecked', note: 'Jev checks need an OpenRouter key and Jev live mode' });
      return { listings, status, rejected: 0, inactive: Boolean(checks.length && listings.length && !live) };
    }
    const checksKey = checks.map((check) => `${check.mode}:${check.text.toLowerCase()}`).sort();
    let jevCalls = 0;
    let detailFetches = 0;
    const outcomes = await mapPool(listings, jevCheckConcurrency(), async (listing): Promise<'rejected' | 'passed' | 'unconfirmed' | 'unchecked'> => {
      const inputHash = createHash('sha256').update(JSON.stringify({
        version: 1, marketplace: listing.marketplace, listingId: listing.listingId, title: listing.title, condition: listing.condition ?? null, checks: checksKey,
      })).digest('hex');
      const cached = this.readFuzzyCache(inputHash, live.jevModel, 'checks');
      if (cached) {
        const parsed = parseJson<{ summary?: string; issues?: string[] }>(cached.decision, {});
        if (parsed.summary === 'rejected') return 'rejected';
        if (parsed.summary === 'passed' || parsed.summary === 'unconfirmed') {
          status.set(listing, { state: parsed.summary, note: (parsed.issues ?? []).join(' · ') });
          return parsed.summary;
        }
      }
      if (jevCalls >= SEARCH_CHECK_JEV_BUDGET) {
        status.set(listing, { state: 'unchecked', note: 'Jev check budget for this search used up' });
        return 'unchecked';
      }
      jevCalls += 1;
      let description = olxDetailHint(listing)?.description ?? null;
      if (!description && detailFetches < SEARCH_CHECK_DETAIL_BUDGET) {
        detailFetches += 1;
        try {
          description = parseListingDescription(await this.detailHtml(listing.url, listing.marketplace), listing.marketplace);
        } catch {
          description = null;
        }
      }
      try {
        const results = await this.jevChecks({ marketplace: listing.marketplace, title: listing.title, condition: listing.condition, description, checks }, { apiKey: live.apiKey, model: live.jevModel });
        const summary = summarizeCheckResults(results);
        const issues = results.map(checkIssue).filter((issue): issue is string => issue !== null);
        if (description) this.writeFuzzyCache(inputHash, live.jevModel, 'checks', JSON.stringify({ summary, issues, results }), null, summary !== 'rejected');
        if (summary === 'rejected') return 'rejected';
        status.set(listing, { state: summary, note: issues.join(' · ') + (description ? '' : `${issues.length ? ' · ' : ''}Judged from the title only`) });
        return summary;
      } catch (error) {
        status.set(listing, { state: 'unchecked', note: `Jev check failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 200) });
        return 'unchecked';
      }
    });
    return {
      listings: listings.filter((_, index) => outcomes[index] !== 'rejected'),
      status,
      rejected: outcomes.filter((outcome) => outcome === 'rejected').length,
      inactive: false,
    };
  }

  /**
   * P1/P3: rescue deterministic near-misses with Jev. Only listings that fail
   * exactly one fuzzy dimension (terms XOR condition) while passing price,
   * shipping, and location are considered, at most 10 per call, fail-closed
   * (Jev error/unsure keeps the drop). Returns rescued listings to merge.
   *
   * Spend-controlled: an optional deal-strength `gate` (same predicate as the
   * AI-relevance pass) filters candidates before any Jev call, and every
   * verdict is cached in `jev_fuzzy_cache` by input hash + model so repeat
   * scans reuse it instead of re-spending on the same near-miss title.
   */
  private readFuzzyCache(inputHash: string, model: string, task: 'term-match' | 'condition' | 'variant' | 'checks'): { rescued: boolean; decision: string } | null {
    try {
      const row = this.stmt('SELECT rescued, decision FROM jev_fuzzy_cache WHERE input_hash = ? AND model = ? AND task = ?').get(inputHash, model, task) as { rescued?: number; decision?: string } | undefined;
      if (!row || row.rescued === undefined || row.rescued === null) return null;
      return { rescued: Number(row.rescued) === 1, decision: String(row.decision ?? '') };
    } catch {
      // Missing table (migration not yet applied) means cache miss.
      return null;
    }
  }

  private writeFuzzyCache(inputHash: string, model: string, task: 'term-match' | 'condition' | 'variant' | 'checks', decision: string, confidence: number | null, rescued: boolean) {
    try {
      this.stmt(`INSERT INTO jev_fuzzy_cache (input_hash, model, task, decision, confidence, rescued, checked_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(input_hash, model, task) DO UPDATE SET decision = excluded.decision, confidence = excluded.confidence, rescued = excluded.rescued, checked_at = excluded.checked_at`).run(
        inputHash, model, task, decision, confidence, rescued ? 1 : 0, nowIso(),
      );
    } catch {
      // Cache writes must never break scans.
    }
  }

  private async rescueFuzzyMisses(
    candidates: { termCandidates: NormalizedListing[]; conditionCandidates: NormalizedListing[] },
    search: { query: string; includedTerms: string; excludedTerms: string; condition?: string },
    live: NonNullable<ReturnType<ScoutService['jevLiveConfig']>>,
    /**
     * Optional deal-strength gate: callers that can score listings (watch
     * scans) pass the same predicate as the AI-relevance pass so rescue only
     * spends Jev where an alert or Very-strong display could result. Manual
     * searches omit it (no baseline to score against) and rely on the cache.
     */
    gate?: (listing: NormalizedListing) => boolean,
  ): Promise<{ rescued: NormalizedListing[]; rescuedByTerm: number; rescuedByCondition: number }> {
    const rescued: NormalizedListing[] = [];
    let rescuedByTerm = 0;
    let rescuedByCondition = 0;
    if (!live) return { rescued, rescuedByTerm, rescuedByCondition };
    const FUZZY_RESCUE_BUDGET = 10;
    let budget = FUZZY_RESCUE_BUDGET;
    const gatedTerm = gate ? candidates.termCandidates.filter(gate) : candidates.termCandidates;
    const gatedCondition = gate ? candidates.conditionCandidates.filter(gate) : candidates.conditionCandidates;
    const termSlice = gatedTerm.slice(0, FUZZY_RESCUE_BUDGET);
    budget -= termSlice.length;
    const conditionSlice = gatedCondition.slice(0, Math.max(0, budget));
    // Each candidate is an independent Jev round trip, so run a bounded pool
    // concurrently and replay the outcomes in candidate order: `rescued` keeps
    // the old term-then-condition ordering regardless of completion order.
    // Verdicts still round-trip through `jev_fuzzy_cache`, so repeating a scan
    // reuses them instead of re-spending.
    type RescueTask = { listing: NormalizedListing; run: () => Promise<boolean> };
    const termTasks: RescueTask[] = termSlice.map((listing) => ({
      listing,
      run: async () => {
        const inputHash = listingTermMatchInputHash({
          title: listing.title, listingCondition: listing.condition,
          query: search.query,
          includedTerms: search.includedTerms, excludedTerms: search.excludedTerms,
        });
        const cached = this.readFuzzyCache(inputHash, live.jevModel, 'term-match');
        if (cached) return cached.rescued;
        try {
          const judgment = await this.jevTermMatch({
            query: search.query, includedTerms: search.includedTerms, excludedTerms: search.excludedTerms,
            title: listing.title, condition: listing.condition,
          }, { apiKey: live.apiKey, model: live.jevModel });
          this.logJevLive('term-match', inputHash, live, { jevAnswer: judgment, jevConfidence: judgment.confidence, jevUnsure: judgment.unsure });
          const rescuedListing = judgment.decision === 'pass' && !judgment.unsure;
          this.writeFuzzyCache(inputHash, live.jevModel, 'term-match', judgment.decision, judgment.confidence, rescuedListing);
          return rescuedListing;
        } catch (error) {
          this.logJevLive('term-match', inputHash, live, { jevError: error instanceof Error ? error.message : String(error) });
          return false;
        }
      },
    }));
    const conditionTasks: RescueTask[] = conditionSlice.map((listing) => ({
      listing,
      run: async () => {
        const inputHash = listingConditionMatchInputHash({
          title: listing.title, listingCondition: listing.condition, requestedCondition: search.condition ?? 'Any',
        });
        const cached = this.readFuzzyCache(inputHash, live.jevModel, 'condition');
        if (cached) return cached.rescued;
        try {
          const judgment = await this.jevConditionMatch({
            requestedCondition: search.condition ?? 'Any', listingCondition: listing.condition, title: listing.title,
          }, { apiKey: live.apiKey, model: live.jevModel });
          this.logJevLive('condition', inputHash, live, { jevAnswer: judgment, jevConfidence: judgment.confidence, jevUnsure: judgment.unsure });
          const rescuedListing = judgment.decision === 'match' && !judgment.unsure;
          this.writeFuzzyCache(inputHash, live.jevModel, 'condition', judgment.decision, judgment.confidence, rescuedListing);
          return rescuedListing;
        } catch (error) {
          this.logJevLive('condition', inputHash, live, { jevError: error instanceof Error ? error.message : String(error) });
          return false;
        }
      },
    }));
    const tasks = [...termTasks, ...conditionTasks];
    const outcomes = new Array<boolean>(tasks.length).fill(false);
    let cursor = 0;
    const worker = async () => {
      while (cursor < tasks.length) {
        const index = cursor++;
        outcomes[index] = await tasks[index].run();
      }
    };
    await Promise.all(Array.from({ length: Math.min(jevCheckConcurrency(), tasks.length) }, worker));
    for (let index = 0; index < tasks.length; index += 1) {
      if (!outcomes[index]) continue;
      rescued.push(tasks[index].listing);
      if (index < termTasks.length) rescuedByTerm += 1;
      else rescuedByCondition += 1;
    }
    return { rescued, rescuedByTerm, rescuedByCondition };
  }

  /**
   * P1/P3 entry point shared by watch scans and manual search. Candidates are
   * collected from `fetched` ignoring shipping (near-misses never reach the
   * enriched `comparable` set), then the small pool is shipping-enriched when
   * the final filters require it, re-checked against the final filters, and
   * sent to the bounded Jev rescue. Returns listings to merge into `filtered`.
   */
  private async fuzzyRescueForSearch(
    fetched: NormalizedListing[],
    search: { query: string; includedTerms: string; excludedTerms: string; condition?: string },
    finalFilters: { minPrice?: number | null; maxPrice?: number | null; condition?: string; shippingOnly: boolean; sellerType?: SellerType | null; ignorePromoted?: boolean },
    source: Marketplace,
    gate?: (listing: NormalizedListing) => boolean,
  ): Promise<NormalizedListing[]> {
    const live = this.jevLiveConfig();
    if (!live) return [];
    const unshipped = { ...finalFilters, shippingOnly: false };
    const candidates = findFuzzyRescueCandidates(fetched, search.query, search.includedTerms, search.excludedTerms, unshipped);
    const pool = [...candidates.termCandidates, ...candidates.conditionCandidates].slice(0, 10);
    if (!pool.length) return [];
    if (finalFilters.shippingOnly) {
      await this.enrichShipping(pool, source, { limit: 10 });
      const shippable = pool.filter((listing) => listing.shippingAvailable === true);
      if (!shippable.length) return [];
      const rechecked = findFuzzyRescueCandidates(shippable, search.query, search.includedTerms, search.excludedTerms, finalFilters);
      // Candidates that no longer qualify (e.g. a price edge) stay dropped.
      const rescue = await this.rescueFuzzyMisses(rechecked, search, live, gate);
      return rescue.rescued;
    }
    const aligned = findFuzzyRescueCandidates(pool, search.query, search.includedTerms, search.excludedTerms, finalFilters);
    const rescue = await this.rescueFuzzyMisses(aligned, search, live, gate);
    return rescue.rescued;
  }

  /**
   * P2: resolve unknown negotiability from description text. Never overrides
   * an explicit signal: only runs when the in-memory listing and the stored
   * row are both null/unknown, requires a confident Jev verdict, and writes
   * with `WHERE price_negotiable IS NULL`. Confident `negotiable` upgrades to
   * 1 (and mutates the candidate so same-scan consumers see it without a
   * re-scan); confident `fixed` persists as 0 so the listing never re-spends
   * a call on repeat scans. Fail-open: any error is a no-op.
   */
  private async upgradeNegotiabilityFromDescription(
    candidate: DealNotificationCandidate,
    description: string | null,
    live: NonNullable<ReturnType<ScoutService['jevLiveConfig']>>,
  ): Promise<boolean> {
    if (!live || !description) return false;
    if (candidate.listing.marketplace !== 'OLX' && candidate.listing.marketplace !== 'Allegro Lokalnie') return false;
    if (candidate.listing.priceNegotiable != null) return false;
    try {
      const stored = this.stmt('SELECT price_negotiable FROM listings WHERE marketplace = ? AND listing_id = ?').get(
        candidate.listing.marketplace, candidate.listing.listingId,
      ) as { price_negotiable?: number | null } | undefined;
      if (!stored) return false;
      if (stored.price_negotiable !== null && stored.price_negotiable !== undefined) return false;
      const judgment = await this.jevNegotiability({
        marketplace: candidate.listing.marketplace, title: candidate.listing.title,
        condition: candidate.listing.condition, description,
      }, { apiKey: live.apiKey, model: live.jevModel });
      const inputHash = listingNegotiabilityInputHash({
        marketplace: candidate.listing.marketplace, title: candidate.listing.title,
        condition: candidate.listing.condition, description,
      });
      this.logJevLive('negotiability', inputHash, live, { jevAnswer: judgment, jevConfidence: judgment.confidence, jevUnsure: judgment.unsure });
      if (judgment.unsure) return false;
      if (judgment.decision === 'fixed') {
        this.stmt('UPDATE listings SET price_negotiable = 0 WHERE marketplace = ? AND listing_id = ? AND price_negotiable IS NULL').run(
          candidate.listing.marketplace, candidate.listing.listingId,
        );
        return false;
      }
      if (judgment.decision !== 'negotiable') return false;
      const result = this.stmt('UPDATE listings SET price_negotiable = 1 WHERE marketplace = ? AND listing_id = ? AND price_negotiable IS NULL').run(
        candidate.listing.marketplace, candidate.listing.listingId,
      );
      if ((result as { changes?: number }).changes) {
        candidate.listing.priceNegotiable = true;
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  private saveDescriptionVerification(input: {
    marketplace: Marketplace;
    listingId: string;
    status: ListingDescriptionVerificationStatus;
    verification?: ListingDescriptionVerification | null;
    inputHash?: string | null;
    model?: string | null;
    error?: string | null;
  }) {
    if (input.status === 'pending') {
      this.stmt(`UPDATE listings SET
        ai_description_verification_model = COALESCE(?, ai_description_verification_model),
        ai_description_verification_at = ?,
        ai_description_verification_status = ?
        WHERE marketplace = ? AND listing_id = ?`).run(
        input.model ?? null,
        nowIso(),
        input.status,
        input.marketplace,
        input.listingId,
      );
      return;
    }
    const json = input.verification ? JSON.stringify(input.verification) : null;
    const error = input.error?.slice(0, 500) ?? null;
    if (error !== null) {
      // Error and fallback rows always refresh their timestamp: the 6-hour
      // retry window is measured from the latest failure.
      this.stmt(`UPDATE listings SET
        ai_description_verification_json = ?,
        ai_description_verification_input_hash = ?,
        ai_description_verification_model = ?,
        ai_description_verification_at = ?,
        ai_description_verification_status = ?,
        ai_description_verification_error = ?
        WHERE marketplace = ? AND listing_id = ?`).run(json, input.inputHash ?? null, input.model ?? null, nowIso(), input.status, error, input.marketplace, input.listingId);
      return;
    }
    // A repeat of the stored verdict (a cache hit, or no key on every scan)
    // changes nothing but the timestamp, so it is not rewritten, except to
    // renew a timestamp older than the freshness window: a standing deal that
    // cannot alert skips re-verification while its verdict is fresh.
    this.stmt(`UPDATE listings SET
      ai_description_verification_json = ?,
      ai_description_verification_input_hash = ?,
      ai_description_verification_model = ?,
      ai_description_verification_at = ?,
      ai_description_verification_status = ?,
      ai_description_verification_error = NULL
      WHERE marketplace = ? AND listing_id = ?
        AND (ai_description_verification_json IS NOT ? OR ai_description_verification_input_hash IS NOT ?
          OR ai_description_verification_model IS NOT ? OR ai_description_verification_status IS NOT ?
          OR ai_description_verification_error IS NOT NULL
          OR ai_description_verification_at IS NULL OR ai_description_verification_at < ?)`).run(
      json, input.inputHash ?? null, input.model ?? null, nowIso(), input.status,
      input.marketplace, input.listingId,
      json, input.inputHash ?? null, input.model ?? null, input.status,
      new Date(Date.now() - DESCRIPTION_VERIFICATION_FRESH_MS).toISOString(),
    );
  }

  private captureListingDetailSnapshot(candidate: DealNotificationCandidate, description: string | null) {
    const stored = this.stmt('SELECT id FROM listings WHERE marketplace = ? AND listing_id = ?').get(candidate.listing.marketplace, candidate.listing.listingId) as { id?: number } | undefined;
    if (!stored?.id) return null;
    const stateHash = createHash('sha256').update(JSON.stringify({
      title: candidate.listing.title,
      price: candidate.listing.price,
      condition: candidate.listing.condition ?? null,
      location: candidate.listing.location ?? null,
      url: candidate.listing.url,
      description,
    })).digest('hex');
    // An already captured state keeps its row and status: the caller sets the
    // final status, and only the fresh-AI path marks it pending while it waits.
    const existing = this.stmt('SELECT id FROM listing_detail_snapshots WHERE listing_id = ? AND state_hash = ?').get(stored.id, stateHash) as { id?: number } | undefined;
    if (existing?.id) return { id: Number(existing.id), stateHash };
    const capturedAt = nowIso();
    this.stmt(`INSERT INTO listing_detail_snapshots (
      listing_id, marketplace, external_listing_id, title, price_pln, url,
      condition, location, description, state_hash, verification_status, captured_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
    ON CONFLICT(listing_id, state_hash) DO UPDATE SET verification_status = 'pending'`).run(
      stored.id,
      candidate.listing.marketplace,
      candidate.listing.listingId,
      candidate.listing.title,
      candidate.listing.price,
      candidate.listing.url,
      candidate.listing.condition ?? null,
      candidate.listing.location ?? null,
      description,
      stateHash,
      capturedAt,
    );
    const snapshot = this.stmt('SELECT id FROM listing_detail_snapshots WHERE listing_id = ? AND state_hash = ?').get(stored.id, stateHash) as { id?: number } | undefined;
    return snapshot?.id ? { id: Number(snapshot.id), stateHash } : null;
  }

  private updateListingDetailSnapshot(snapshotId: number | null, status: ListingDescriptionVerificationStatus, inputHash: string | null) {
    if (!snapshotId) return;
    this.stmt('UPDATE listing_detail_snapshots SET verification_status = ?, verification_input_hash = ? WHERE id = ? AND (verification_status IS NOT ? OR verification_input_hash IS NOT ?)').run(status, inputHash, snapshotId, status, inputHash);
  }

  private async verifyHighPriorityDealOnce(candidate: DealNotificationCandidate, notifyContext?: ScanNotifyContext): Promise<boolean> {
    const marketplace = candidate.listing.marketplace;
    const listingId = candidate.listing.listingId;
    const config = notifyContext?.deepSeek ?? this.deepSeekConfig();
    const jevLive = this.jevLiveConfig();
    // Live mode scopes every cache read/write to the Jev model so legacy
    // DeepSeek rows are never reused as live decisions.
    const apiKey = jevLive ? jevLive.apiKey : config.apiKey;
    const activeModel = jevLive ? jevLive.jevModel : config.model;
    if (!apiKey) {
      this.transaction(() => {
        const snapshot = this.captureListingDetailSnapshot(candidate, null);
        this.updateListingDetailSnapshot(snapshot?.id ?? null, 'not-configured', null);
        this.saveDescriptionVerification({ marketplace, listingId, status: 'not-configured' });
      });
      return true;
    }

    let description: string | null;
    let galleryImageUrls: string[] = [];
    // Read once: gallery parsing below must stay inert when both modes are off,
    // and this also avoids re-decrypting the OpenRouter key per candidate.
    const jevShadow = this.jevShadowConfig();
    // The OLX offers API already returned this scan's description and photos,
    // so the HTML offer page is fetched only when that text is missing.
    const hint = marketplace === 'OLX' ? olxDetailHint(candidate.listing) : undefined;
    try {
      if (hint?.description) {
        description = hint.description;
        if (jevShadow || jevLive) galleryImageUrls = hint.imageUrls.slice(0, 3);
      } else {
        const html = await this.fetchPublicPage(candidate.listing.url, marketplace);
        description = parseListingDescription(html, marketplace);
        if (jevShadow || jevLive) {
          try {
            galleryImageUrls = parseListingImageUrls(html, marketplace, 12).slice(0, 3);
          } catch {
            galleryImageUrls = [];
          }
        }
      }
    } catch (error) {
      const message = (error instanceof Error ? error.message : 'Could not fetch the high-priority listing detail page').slice(0, 500);
      this.transaction(() => {
        const snapshot = this.captureListingDetailSnapshot(candidate, null);
        this.updateListingDetailSnapshot(snapshot?.id ?? null, 'unknown', null);
        this.saveDescriptionVerification({ marketplace, listingId, status: 'unknown', model: activeModel, error: message });
      });
      this.emit('ai-description-verification', { key: `${marketplace}:${listingId}`, status: 'unknown' });
      return false;
    }

    const context: ListingDescriptionVerificationContext = {
      marketplace,
      title: candidate.listing.title,
      condition: candidate.listing.condition,
      description,
      query: candidate.query?.trim() ? candidate.query : null,
      includedTerms: candidate.includedTerms?.trim() ? candidate.includedTerms : null,
      excludedTerms: candidate.excludedTerms?.trim() ? candidate.excludedTerms : null,
      checks: candidate.verificationChecks?.length ? candidate.verificationChecks : null,
    };
    const inputHash = listingDescriptionVerificationInputHash(context);
    // Everything up to the fresh AI call is synchronous, so the snapshot and
    // any cached decision are written in one transaction.
    type CachedOutcome = { done: true; allowed: boolean; emit: ListingDescriptionVerificationStatus | null } | { done: false; snapshotId: number | null };
    const outcome = this.transaction((): CachedOutcome => {
      const snapshot = this.captureListingDetailSnapshot(candidate, description);
      const row = this.stmt(`SELECT ai_description_verification_json, ai_description_verification_input_hash,
        ai_description_verification_model, ai_description_verification_at, ai_description_verification_error,
        ai_description_verification_status
        FROM listings WHERE marketplace = ? AND listing_id = ?`).get(marketplace, listingId) as Record<string, any> | undefined;
      const cached = parseStoredListingDescriptionVerification(row?.ai_description_verification_json);
      if (cached && row?.ai_description_verification_input_hash === inputHash && row.ai_description_verification_model === activeModel) {
        this.updateListingDetailSnapshot(snapshot?.id ?? null, cached.decision, inputHash);
        this.saveDescriptionVerification({ marketplace, listingId, status: cached.decision, verification: cached, inputHash, model: activeModel });
        return { done: true, allowed: cached.decision === 'pass', emit: null };
      }
      if (row?.ai_description_verification_error && row.ai_description_verification_input_hash === inputHash
        && row.ai_description_verification_model === activeModel && row.ai_description_verification_at
        && Date.now() - Date.parse(row.ai_description_verification_at) < 6 * 60 * 60_000) {
        const status: ListingDescriptionVerificationStatus = row.ai_description_verification_status === 'fallback' ? 'fallback' : 'unknown';
        this.updateListingDetailSnapshot(snapshot?.id ?? null, status, inputHash);
        this.saveDescriptionVerification({ marketplace, listingId, status, inputHash, model: activeModel, error: row.ai_description_verification_error });
        return { done: true, allowed: status === 'fallback', emit: null };
      }

      if (!description) {
        const unknown: ListingDescriptionVerification = {
          decision: 'unknown',
          confidence: 0,
          summary: 'The detail page did not expose a listing description.',
          issues: ['No listing description was available to verify.'],
          evidence: [],
        };
        this.updateListingDetailSnapshot(snapshot?.id ?? null, unknown.decision, inputHash);
        this.saveDescriptionVerification({ marketplace, listingId, status: unknown.decision, verification: unknown, inputHash, model: activeModel });
        return { done: true, allowed: false, emit: unknown.decision };
      }

      // Cross-listing reuse is keyed by input hash, which omits the gallery
      // photos live escalation uses — live mode relies on the per-listing cache
      // above instead.
      const reusable = !jevLive ? this.stmt(`SELECT ai_description_verification_json
        FROM listings
        WHERE ai_description_verification_input_hash = ?
          AND ai_description_verification_model = ?
          AND ai_description_verification_json IS NOT NULL
        ORDER BY ai_description_verification_at DESC LIMIT 1`).get(inputHash, activeModel) as { ai_description_verification_json?: string } | undefined : undefined;
      const shared = parseStoredListingDescriptionVerification(reusable?.ai_description_verification_json);
      if (shared) {
        this.updateListingDetailSnapshot(snapshot?.id ?? null, shared.decision, inputHash);
        this.saveDescriptionVerification({ marketplace, listingId, status: shared.decision, verification: shared, inputHash, model: activeModel });
        return { done: true, allowed: shared.decision === 'pass', emit: null };
      }
      // A fresh AI call follows: the snapshot shows pending while it runs.
      if (snapshot?.id) this.stmt("UPDATE listing_detail_snapshots SET verification_status = 'pending' WHERE id = ? AND verification_status IS NOT 'pending'").run(snapshot.id);
      return { done: false, snapshotId: snapshot?.id ?? null };
    });
    if (outcome.done) {
      if (outcome.emit) this.emit('ai-description-verification', { key: `${marketplace}:${listingId}`, status: outcome.emit });
      return outcome.allowed;
    }
    const snapshot = outcome.snapshotId === null ? null : { id: outcome.snapshotId };

    // P2: same description upgrades unknown negotiability. Runs only on the
    // fresh-verification path — after every cache early-return above — so an
    // already-verified listing never re-spends a negotiability call on repeat
    // scans. Confident `fixed` verdicts are persisted as 0 for the same
    // reason (previously only `negotiable` was written, so fixed listings
    // re-fired every scan). Fail-open no-op.
    if (jevLive && description) {
      await this.upgradeNegotiabilityFromDescription(candidate, description, jevLive);
    }

    try {
      this.saveDescriptionVerification({ marketplace, listingId, status: 'pending', model: activeModel });
      const verification = jevLive
        ? await this.verifyDescriptionLive(context, inputHash, galleryImageUrls, jevLive)
        : await this.verifyListingDescription(context, { apiKey, model: config.model });
      if (jevShadow) this.shadowJevVerification(context, inputHash, verification.decision, galleryImageUrls, jevShadow);
      this.updateListingDetailSnapshot(snapshot?.id ?? null, verification.decision, inputHash);
      this.saveDescriptionVerification({ marketplace, listingId, status: verification.decision, verification, inputHash, model: activeModel });
      this.emit('ai-description-verification', { key: `${marketplace}:${listingId}`, status: verification.decision });
      return verification.decision === 'pass';
    } catch (error) {
      const message = (error instanceof Error ? error.message : 'OpenRouter could not verify the listing description').slice(0, 500);
      // Only genuine provider outages keep the historical fail-open alert. A
      // malformed or refused model reply means no AI check completed, so the
      // alert is held as unknown instead of sent without verification.
      const errorKind = error instanceof DeepSeekError || error instanceof JevError || error instanceof VisionError ? error.kind : null;
      const status: ListingDescriptionVerificationStatus = errorKind === 'provider' ? 'fallback' : 'unknown';
      if (jevShadow) this.shadowJevVerification(context, inputHash, status, galleryImageUrls, jevShadow);
      this.updateListingDetailSnapshot(snapshot?.id ?? null, status, inputHash);
      this.saveDescriptionVerification({ marketplace, listingId, status, inputHash, model: activeModel, error: message });
      this.emit('ai-description-verification', { key: `${marketplace}:${listingId}`, status });
      return status === 'fallback';
    }
  }

  private verifyHighPriorityDeal(candidate: DealNotificationCandidate, notifyContext?: ScanNotifyContext) {
    const key = `${candidate.listing.marketplace}:${candidate.listing.listingId}`;
    const existing = this.descriptionVerificationInFlight.get(key);
    if (existing) return existing;
    const verification = this.verifyHighPriorityDealOnce(candidate, notifyContext).finally(() => {
      if (this.descriptionVerificationInFlight.get(key) === verification) this.descriptionVerificationInFlight.delete(key);
    });
    this.descriptionVerificationInFlight.set(key, verification);
    return verification;
  }

  /**
   * True when the listing already holds a finished verdict (pass, reject, or
   * unknown for a page without a description; not an error) from the active
   * model that is younger than DESCRIPTION_VERIFICATION_FRESH_MS, for a
   * listing state (title, price, condition, location, url) that was already
   * captured. Without an AI key verification is a write-free no-op anyway.
   */
  private hasFreshDescriptionVerification(candidate: DealNotificationCandidate, notifyContext?: ScanNotifyContext) {
    const config = notifyContext?.deepSeek ?? this.deepSeekConfig();
    const jevLive = this.jevLiveConfig();
    const apiKey = jevLive ? jevLive.apiKey : config.apiKey;
    if (!apiKey) return false;
    const activeModel = jevLive ? jevLive.jevModel : config.model;
    const { listing } = candidate;
    const row = this.stmt(`SELECT id, ai_description_verification_model AS model, ai_description_verification_status AS status,
      ai_description_verification_error AS error, ai_description_verification_at AS at
      FROM listings WHERE marketplace = ? AND listing_id = ?`).get(listing.marketplace, listing.listingId) as { id?: number; model?: string | null; status?: string | null; error?: string | null; at?: string | null } | undefined;
    if (!row?.id || row.model !== activeModel || row.error) return false;
    if (row.status !== 'pass' && row.status !== 'reject' && row.status !== 'unknown') return false;
    const verifiedAt = row.at ? Date.parse(row.at) : Number.NaN;
    if (!Number.isFinite(verifiedAt) || Date.now() - verifiedAt >= DESCRIPTION_VERIFICATION_FRESH_MS) return false;
    return Boolean(this.stmt(`SELECT 1 AS found FROM listing_detail_snapshots
      WHERE listing_id = ? AND title = ? AND price_pln = ? AND url = ? AND condition IS ? AND location IS ? LIMIT 1`).get(
      row.id, listing.title, listing.price, listing.url, listing.condition ?? null, listing.location ?? null,
    ));
  }

  /** Read once per scan — see ScanNotifyContext. */
  private scanNotifyContext(): ScanNotifyContext {
    return {
      encryptedDiscord: this.getSetting('discord_webhook'),
      ntfy: this.ntfyConfig(),
      digest: this.dailyDigestConfig(),
      discordMinimumPriority: this.discordMinimumPriority(),
      deepSeek: this.deepSeekConfig(),
    };
  }

  /**
   * Deal candidates run through a two-worker pool: verification and delivery
   * spend their time on marketplace and OpenRouter round trips. Candidates
   * for the same listing are grouped and each group is consumed sequentially
   * — the alert-state and delivery-claim logic is per listing and must not
   * race itself.
   */
  private async processDealCandidates(candidates: DealNotificationCandidate[], buildContext: () => ScanNotifyContext) {
    if (!candidates.length) return;
    const groups = new Map<string, DealNotificationCandidate[]>();
    for (const candidate of candidates) {
      const key = `${candidate.listing.marketplace}:${candidate.listing.listingId}`;
      const group = groups.get(key);
      if (group) group.push(candidate);
      else groups.set(key, [candidate]);
    }
    const context = buildContext();
    const queue = [...groups.values()];
    let cursor = 0;
    const worker = async () => {
      while (cursor < queue.length) {
        const group = queue[cursor++];
        for (const candidate of group) {
          // notifyDeal ignores hidden listings, so verifying one would only
          // fetch its page and spend an AI call for nothing.
          if (this.isListingHidden(candidate.listing)) continue;
          if (candidate.requiresDescriptionVerification) {
            // notifyDeal re-plans after the awaits, since state can change.
            const plan = this.planDealNotification(candidate.watchId, candidate.listing, candidate.discountPercent, context);
            if (!plan.channels.length && !plan.digestDue && this.hasFreshDescriptionVerification(candidate, context)) continue;
            if (!await this.verifyHighPriorityDeal(candidate, context)) continue;
          }
          await this.notifyDeal(candidate.watchId, candidate.listing, candidate.typical, candidate.discountPercent, candidate.confidence, context, candidate.variantLabel ?? null);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(2, queue.length) }, worker));
  }

  private discordMinimumPriority(): NotificationPriority {
    return parseNotificationPriority(this.getSetting('discord_minimum_priority'), 'strong');
  }

  private ntfyConfig(): NtfyConfig | null {
    const encrypted = this.getSetting('ntfy_config');
    if (!encrypted) return null;
    try {
      const parsed = JSON.parse(decryptSecret(encrypted)) as { serverUrl?: string; topic?: string; token?: string; minimumPriority?: unknown; openInApp?: unknown };
      return validateNtfyConfig(parsed);
    } catch {
      return null;
    }
  }

  private marketplaceSessionRow(marketplace: Marketplace) {
    return this.stmt('SELECT * FROM marketplace_sessions WHERE marketplace = ?').get(marketplace) as Record<string, any> | undefined;
  }

  private setMarketplaceSessionError(marketplace: Marketplace, message: string | null) {
    this.marketplaceSessionCache.delete(marketplace);
    this.stmt('UPDATE marketplace_sessions SET last_error = ?, updated_at = ? WHERE marketplace = ?').run(message ? message.slice(0, 500) : null, nowIso(), marketplace);
  }

  // Page fetches, shipping checks, and AI verifications read the session many
  // times per scan; the AES-GCM decrypt + parse runs once per stored value
  // instead of once per read. Keyed on the ciphertext so a re-imported
  // session (new ciphertext) is re-read, and invalidated wherever the row is
  // written or removed.
  private marketplaceSessionCache = new Map<Marketplace, { ciphertext: string; state: MarketplaceStorageState }>();

  private readMarketplaceSession(marketplace: Marketplace): MarketplaceStorageState | null {
    const row = this.marketplaceSessionRow(marketplace);
    if (!row) return null;
    const ciphertext = String(row.storage_state_encrypted);
    const cached = this.marketplaceSessionCache.get(marketplace);
    if (cached && cached.ciphertext === ciphertext) return cached.state;
    try {
      const state = parseMarketplaceStorageState(decryptSecret(ciphertext), marketplace);
      this.marketplaceSessionCache.set(marketplace, { ciphertext, state });
      return state;
    } catch {
      this.setMarketplaceSessionError(marketplace, 'Stored session could not be read; import it again');
      throw new Error(`${marketplace} authenticated session could not be read; import it again`);
    }
  }

  private touchMarketplaceSession(marketplace: Marketplace) {
    this.stmt('UPDATE marketplace_sessions SET last_used_at = ?, last_error = NULL, updated_at = ? WHERE marketplace = ?').run(nowIso(), nowIso(), marketplace);
  }

  marketplaceSessions() {
    return marketplaces.map((marketplace) => {
      const row = this.marketplaceSessionRow(marketplace);
      if (!row) return { marketplace, label: '', connected: false, createdAt: null, updatedAt: null, lastUsedAt: null, detail: 'No authenticated session' };
      const lastError = typeof row.last_error === 'string' ? row.last_error : null;
      return {
        marketplace,
        label: String(row.label ?? ''),
        connected: !lastError,
        createdAt: row.created_at ?? null,
        updatedAt: row.updated_at ?? null,
        lastUsedAt: row.last_used_at ?? null,
        detail: lastError ?? 'Authenticated browser session ready',
      };
    });
  }

  saveMarketplaceSession(marketplace: Marketplace, label: string | undefined, input: unknown) {
    let state: MarketplaceStorageState;
    try {
      state = parseMarketplaceStorageState(input, marketplace);
    } catch (error) {
      const message = error instanceof MarketplaceSessionValidationError ? error.message : 'Invalid marketplace session';
      throw new ServiceError(message);
    }
    const timestamp = nowIso();
    const safeLabel = (label ?? '').trim().slice(0, 80);
    this.stmt(`INSERT INTO marketplace_sessions (marketplace, label, storage_state_encrypted, created_at, updated_at, last_used_at, last_error)
      VALUES (?, ?, ?, ?, ?, NULL, NULL)
      ON CONFLICT(marketplace) DO UPDATE SET label = excluded.label, storage_state_encrypted = excluded.storage_state_encrypted, updated_at = excluded.updated_at, last_used_at = NULL, last_error = NULL`)
      .run(marketplace, safeLabel, encryptSecret(JSON.stringify(state)), timestamp, timestamp);
    this.marketplaceSessionCache.delete(marketplace);
    return this.settings();
  }

  deleteMarketplaceSession(marketplace: Marketplace) {
    const result = this.stmt('DELETE FROM marketplace_sessions WHERE marketplace = ?').run(marketplace);
    if (!result.changes) throw new ServiceError('Marketplace session not found', 404);
    this.marketplaceSessionCache.delete(marketplace);
    return this.settings();
  }

  private watchFromRow(
    row: WatchRow,
    stats: { samples: number; first_observed: string | null } = { samples: 0, first_observed: null },
    variantStats: Map<string, { samples: number; first_observed: string | null; typical: number | null }> = new Map(),
    dealCounts: WatchDealCounts = { exceptional: 0, veryStrong: 0, strong: 0 },
  ): Watch {
    const samples = Number(stats?.samples ?? 0);
    const observationHours = stats?.first_observed ? Math.max(0, Math.floor((Date.now() - Date.parse(stats.first_observed)) / 3_600_000)) : 0;
    const readiness = Math.round(Math.min(1, samples / BASELINE_MIN_SAMPLES, observationHours / BASELINE_MIN_HOURS) * 100);
    const archived = Boolean(row.archived_at);
    const enabled = Boolean(row.enabled) && !archived;
    const sources = parseJson<Marketplace[]>(row.sources_json, []);
    const variantGroups = parseVariantGroups(row.variant_groups_json);
    // Mirrors scoring: a named variant needs its own VARIANT_MIN_SAMPLES and
    // the named variants that reached it must together hold the 30-sample
    // floor; Other keeps the full watch-style floor on its own.
    const pooledSamples = variantGroups.reduce((total, group) => {
      const count = Number(variantStats.get(group.id)?.samples ?? 0);
      return count >= VARIANT_MIN_SAMPLES ? total + count : total;
    }, 0);
    const variantStatFor = (key: string, label: string): WatchVariantStat => {
      const entry = variantStats.get(key);
      const entrySamples = Number(entry?.samples ?? 0);
      const entryHours = entry?.first_observed ? Math.max(0, Math.floor((Date.now() - Date.parse(entry.first_observed)) / 3_600_000)) : 0;
      const named = key !== OTHER_VARIANT_KEY;
      const targetSamples = named ? VARIANT_MIN_SAMPLES : BASELINE_MIN_SAMPLES;
      return {
        key,
        label,
        samples: entrySamples,
        targetSamples,
        observationHours: entryHours,
        readiness: Math.round(Math.min(1, entrySamples / targetSamples, named ? pooledSamples / BASELINE_MIN_SAMPLES : 1, entryHours / BASELINE_MIN_HOURS) * 100),
        typical: entry?.typical ?? null,
      };
    };
    // Only surface the breakdown once the user configured groups; a legacy
    // watch keeps its single watch-wide progress bar.
    const variants: WatchVariantStat[] = variantGroups.length
      ? [
          ...variantGroups.map((group) => variantStatFor(group.id, group.label)),
          ...(variantStats.has(OTHER_VARIANT_KEY) ? [variantStatFor(OTHER_VARIANT_KEY, OTHER_VARIANT_LABEL)] : []),
        ]
      : [];
    return {
      id: row.id,
      name: row.name,
      query: row.query,
      terms: row.included_terms,
      excluded: row.excluded_terms,
      sources,
      location: NO_LOCATION_FILTER,
      condition: row.condition,
      samples,
      targetSamples: BASELINE_MIN_SAMPLES,
      observationHours,
      readiness,
      status: archived ? 'Archived' : enabled ? (readiness >= 100 ? 'Ready' : 'Learning') : 'Paused',
      interval: Number(row.interval_minutes),
      sourceIntervals: normalizeSourceIntervals(sources, parseJson<Record<string, unknown>>(row.source_intervals_json, {})),
      nextScan: enabled ? relativeTimeFuture(row.next_scan_at) : 'Paused',
      enabled,
      exactUrls: parseJson<string[]>(row.exact_urls_json, []),
      sensitivity: Number(row.sensitivity ?? 1),
      shippingOnly: Boolean(row.shipping_only),
      typoVariants: Boolean(row.typo_variants),
      aiRelevance: row.ai_relevance === undefined ? true : Boolean(row.ai_relevance),
      verificationChecks: parseVerificationChecks(row.verification_checks_json),
      referenceMarketWatchId: row.reference_market_watch_id ?? null,
      variantGroups,
      variantGroupsAuto: !variantGroups.length && row.variant_groups_auto !== undefined && Boolean(row.variant_groups_auto),
      variants,
      dealCounts,
      minPrice: row.min_price_pln === null ? null : Number(row.min_price_pln),
      maxPrice: row.max_price_pln === null ? null : Number(row.max_price_pln),
      olxCategory: olxCategoryFromJson(row.olx_category_json),
      sellerType: sellerTypeFromRow(row.seller_type),
      ignorePromoted: Boolean(row.ignore_promoted),
      archivedAt: row.archived_at ?? null,
    };
  }

  private listingFromRow(row: Record<string, any>, baselineReady: boolean, variantGroups: VariantGroup[] = []): Listing {
    const typicalSource = row.typical_source === 'reference-band' || row.typical_source === 'own-history' ? row.typical_source : null;
    const associationTypical = row.watch_typical_pln ?? row.typical_pln;
    // An own-history typical is only written once the listing's own variant is
    // ready, so it can be shown per variant; a band-seeded typical is
    // display-only and shows while any baseline is still learning. The
    // watch-wide readiness flag remains the fallback for legacy rows that
    // predate typical_source.
    const showTypical = typicalSource === 'own-history' || typicalSource === 'reference-band' || baselineReady;
    const typical = showTypical && associationTypical !== null && associationTypical !== undefined ? Number(associationTypical) : null;
    const price = Number(row.price_pln);
    const belowTypical = typical && typical > 0 ? -Math.max(0, ((typical - price) / typical) * 100) : null;
    const strength = row.watch_deal_strength === null || row.watch_deal_strength === undefined
      ? dealStrength(price, typical) ?? 1
      : Number(row.watch_deal_strength);
    const dealLabel: DealLabel = row.watch_deal_label === 'Exceptional' || row.watch_deal_label === 'Very strong' || row.watch_deal_label === 'Strong' || row.watch_deal_label === 'Watch'
      ? row.watch_deal_label
      : dealLabelFromStrength(strength);
    const marketplaceListingKey = `${row.marketplace}:${row.listing_id}`;
    const associationId = row.watch_listing_id === null || row.watch_listing_id === undefined
      ? row.watch_id ? `${row.watch_id}:${marketplaceListingKey}` : undefined
      : `${row.watch_id}:${row.watch_listing_id}`;
    return {
      id: marketplaceListingKey,
      marketplaceListingKey,
      associationId,
      watchId: row.watch_id ?? null,
      watchListingId: row.watch_listing_id === null || row.watch_listing_id === undefined ? null : Number(row.watch_listing_id),
      title: row.title,
      subtitle: row.subtitle || row.condition || row.location || '',
      marketplace: row.marketplace,
      price,
      typical,
      typicalSource,
      variantKey: row.variant_key ?? null,
      variantLabel: row.variant_key ? variantLabelFor(String(row.variant_key), variantGroups) : null,
      variantSource: row.variant_key && (row.variant_source === 'manual' || row.variant_source === 'jev') ? row.variant_source : row.variant_key ? 'rule' : null,
      belowTypical,
      observed: relativeTime(row.watch_last_seen_at ?? row.last_seen_at),
      observedAt: row.watch_last_seen_at ?? row.last_seen_at,
      dealStrength: strength,
      dealLabel,
      image: row.image_url || '',
      url: row.url,
      watch: row.watch_name || 'Unassigned',
      condition: row.condition || undefined,
      location: row.location || undefined,
      shippingAvailable: row.marketplace === 'Vinted' ? true : row.shipping_available === null ? null : Boolean(row.shipping_available),
      priceNegotiable: row.price_negotiable === null || row.price_negotiable === undefined ? null : Boolean(row.price_negotiable),
      firstSeenAt: row.watch_first_seen_at ?? row.first_seen_at ?? null,
      postedAt: row.posted_at ?? null,
      refreshedAt: row.refreshed_at ?? null,
      promoted: row.promoted === null || row.promoted === undefined ? null : Boolean(row.promoted),
      sellerType: row.seller_type === 'private' || row.seller_type === 'business' ? row.seller_type : null,
      listingId: String(row.listing_id),
      decision: parseListingDecision(row.listing_decision),
      note: typeof row.listing_note === 'string' ? row.listing_note : '',
      hidden: row.listing_hidden === undefined ? undefined : Number(row.listing_hidden) === 1,
      aiFiltered: row.ai_filtered === undefined ? undefined : Number(row.ai_filtered) === 1,
      // Only rows with a check carry the fields, so the feed doesn't grow by
      // four nulls for every listing that was never verified.
      ...(row.ai_description_verification_json != null || row.ai_description_verification_status != null ? {
        aiDescriptionVerification: parseStoredListingDescriptionVerification(row.ai_description_verification_json),
        aiDescriptionVerificationAt: row.ai_description_verification_at ?? null,
        aiDescriptionVerificationStatus: row.ai_description_verification_status === 'pass'
          || row.ai_description_verification_status === 'reject'
          || row.ai_description_verification_status === 'unknown'
          || row.ai_description_verification_status === 'pending'
          || row.ai_description_verification_status === 'not-configured'
          || row.ai_description_verification_status === 'fallback'
          ? row.ai_description_verification_status
          : null,
        aiDescriptionVerificationError: row.ai_description_verification_error ?? null,
      } : {}),
    };
  }

  /**
   * Watches with their baseline stats. `onlyWatchId` restricts every query to
   * one watch (archived or not) for callers that need a single watch's
   * readiness or groups; the filtered statements are separate fixed shapes
   * with the id bound as a parameter.
   */
  private watches(includeArchived: boolean, onlyWatchId?: string) {
    const single = onlyWatchId !== undefined;
    const rows = (single
      ? this.stmt('SELECT * FROM watches WHERE id = ?').all(onlyWatchId)
      : this.stmt(`SELECT * FROM watches ${includeArchived ? '' : 'WHERE archived_at IS NULL '}ORDER BY created_at DESC`).all()) as WatchRow[];
    if (!rows.length) return [];
    if (single) includeArchived = true;
    // One row per (watch, listing) association: listing-level filters run once
    // per association and the earliest in-range observation is an ordered
    // LIMIT-1 probe of observations_watch_listing, so the cost scales with
    // associations instead of the whole observation history. Every
    // observation's watch_listing_id is its (watch_id, listing_id)
    // association, so this matches the per-observation aggregate exactly.
    // MATERIALIZED keeps SQLite from flattening the CTE and re-running the
    // probe per aggregate; HAVING drops variants with no in-range observation.
    const statsRows = this.stmt(`WITH a AS MATERIALIZED (
        SELECT wl.watch_id AS watch_id, COALESCE(wl.variant_key, ?1) AS variant_key,
          (SELECT o.observed_at FROM observations o INDEXED BY observations_watch_listing
            WHERE o.watch_id = wl.watch_id AND o.listing_id = wl.listing_id
              AND (w.min_price_pln IS NULL OR o.price_pln >= w.min_price_pln)
              AND (w.max_price_pln IS NULL OR o.price_pln <= w.max_price_pln)
            ORDER BY o.observed_at LIMIT 1) AS first_observed
        FROM watch_listings wl
        JOIN watches w ON w.id = wl.watch_id
        JOIN listings l ON l.id = wl.listing_id
        WHERE (?2 = 1 OR w.archived_at IS NULL)${single ? ' AND wl.watch_id = ?3' : ''}
          AND NOT EXISTS (SELECT 1 FROM listing_relevance r WHERE r.watch_id = wl.watch_id AND r.marketplace = l.marketplace AND r.listing_id = l.listing_id AND (r.relevance_status = 'irrelevant' OR (r.relevance_status IS NULL AND r.relevant = 0)) AND w.ai_relevance = 1)
          AND (w.shipping_only = 0 OR (l.marketplace = 'Vinted' OR l.shipping_available = 1))
      )
      SELECT watch_id, variant_key, COUNT(first_observed) AS samples, MIN(first_observed) AS first_observed
      FROM a GROUP BY watch_id, variant_key HAVING COUNT(first_observed) > 0`).all(OTHER_VARIANT_KEY, includeArchived ? 1 : 0, ...(single ? [onlyWatchId] : [])) as Array<{ watch_id: string; variant_key: string; samples: number; first_observed: string | null }>;
    // Latest stored typical per variant. Every association in a variant shares
    // the value written by the most recent scan; MAX(last_seen_at) picks that
    // row so a stale pre-regroup value cannot win.
    const typicalRows = this.stmt(`SELECT wl.watch_id, COALESCE(wl.variant_key, ?) AS variant_key, wl.typical_pln AS typical, MAX(wl.last_seen_at) AS last_seen_at
      FROM watch_listings wl
      JOIN watches w ON w.id = wl.watch_id
      WHERE wl.typical_pln IS NOT NULL${includeArchived ? '' : ' AND w.archived_at IS NULL'}${single ? ' AND wl.watch_id = ?' : ''}
      GROUP BY wl.watch_id, COALESCE(wl.variant_key, ?)`).all(OTHER_VARIANT_KEY, ...(single ? [onlyWatchId] : []), OTHER_VARIANT_KEY) as Array<{ watch_id: string; variant_key: string; typical: number }>;
    const statsByWatch = new Map<string, { samples: number; first_observed: string | null }>();
    const variantsByWatch = new Map<string, Map<string, { samples: number; first_observed: string | null; typical: number | null }>>();
    const variantEntry = (watchId: string, key: string) => {
      let byVariant = variantsByWatch.get(watchId);
      if (!byVariant) { byVariant = new Map(); variantsByWatch.set(watchId, byVariant); }
      let entry = byVariant.get(key);
      if (!entry) { entry = { samples: 0, first_observed: null, typical: null }; byVariant.set(key, entry); }
      return entry;
    };
    for (const stats of statsRows) {
      const entry = variantEntry(stats.watch_id, stats.variant_key ?? OTHER_VARIANT_KEY);
      entry.samples = Number(stats.samples);
      entry.first_observed = stats.first_observed;
      // A listing belongs to exactly one variant, so summing the per-variant
      // distinct counts reproduces the watch-wide distinct count.
      const aggregate = statsByWatch.get(stats.watch_id) ?? { samples: 0, first_observed: null };
      aggregate.samples += entry.samples;
      if (stats.first_observed && (!aggregate.first_observed || stats.first_observed < aggregate.first_observed)) aggregate.first_observed = stats.first_observed;
      statsByWatch.set(stats.watch_id, aggregate);
    }
    for (const row of typicalRows) {
      variantEntry(row.watch_id, row.variant_key ?? OTHER_VARIANT_KEY).typical = Number(row.typical);
    }
    // Current Strong+ findings per watch, bucketed by tier. The predicates
    // mirror listingsPage (fresh association, not AI-filtered irrelevant, the
    // watch's shipping/price filters) and additionally skip rows the user hid,
    // so the card's counts always match the feed it links to.
    const freshnessCutoff = new Date(Date.now() - MATCH_VISIBILITY_MS).toISOString();
    const dealRows = this.stmt(`SELECT wl.watch_id AS watch_id, COALESCE(wl.deal_strength, 0) AS deal_strength, COUNT(*) AS count
      FROM watch_listings wl
      JOIN listings l ON l.id = wl.listing_id
      JOIN watches w ON w.id = wl.watch_id
      LEFT JOIN listing_actions a ON a.marketplace = l.marketplace AND a.listing_id = l.listing_id
      WHERE wl.last_seen_at > ?
        AND (? = 1 OR w.archived_at IS NULL)${single ? ' AND wl.watch_id = ?' : ''}
        AND COALESCE(a.hidden, 0) = 0
        AND (w.shipping_only = 0 OR (l.marketplace = 'Vinted' OR l.shipping_available = 1))
        AND (w.min_price_pln IS NULL OR l.price_pln >= w.min_price_pln)
        AND (w.max_price_pln IS NULL OR l.price_pln <= w.max_price_pln)
        AND NOT EXISTS (SELECT 1 FROM listing_relevance r WHERE r.watch_id = wl.watch_id AND r.marketplace = l.marketplace AND r.listing_id = l.listing_id AND (r.relevance_status = 'irrelevant' OR (r.relevance_status IS NULL AND r.relevant = 0)) AND w.ai_relevance = 1)
      GROUP BY wl.watch_id, COALESCE(wl.deal_strength, 0)`).all(freshnessCutoff, includeArchived ? 1 : 0, ...(single ? [onlyWatchId] : [])) as Array<{ watch_id: string; deal_strength: number; count: number }>;
    const dealCountsByWatch = new Map<string, WatchDealCounts>();
    for (const row of dealRows) {
      const counts = dealCountsByWatch.get(row.watch_id) ?? { exceptional: 0, veryStrong: 0, strong: 0 };
      const strength = Number(row.deal_strength ?? 0);
      const count = Number(row.count ?? 0);
      if (strength >= 5) counts.exceptional += count;
      else if (strength === 4) counts.veryStrong += count;
      else if (strength === 3) counts.strong += count;
      dealCountsByWatch.set(row.watch_id, counts);
    }
    return rows.map((row) => this.watchFromRow(row, statsByWatch.get(row.id), variantsByWatch.get(row.id) ?? new Map(), dealCountsByWatch.get(row.id) ?? { exceptional: 0, veryStrong: 0, strong: 0 }));
  }

  getWatches() {
    return this.watches(false);
  }

  allWatches() {
    return this.watches(true);
  }

  /** One watch (archived included) with the same stats as allWatches(). */
  watchById(id: string): Watch | undefined {
    return this.watches(true, id)[0];
  }

  /**
   * Re-derive every saved listing association's variant_key from the watch's
   * current groups. Called after a group edit so history is repartitioned
   * immediately instead of converging one listing per scan. Deterministic and
   * idempotent; with no groups every key is cleared back to NULL.
   */
  retagWatchVariants(watchId: string) {
    const row = this.stmt('SELECT variant_groups_json FROM watches WHERE id = ?').get(watchId) as { variant_groups_json?: string } | undefined;
    if (!row) return;
    const groups = parseVariantGroups(row.variant_groups_json);
    const ids = new Set(groups.map((group) => group.id));
    const associations = this.stmt('SELECT wl.id AS association_id, wl.variant_source AS variant_source, wl.variant_key AS variant_key, l.title AS title FROM watch_listings wl JOIN listings l ON l.id = wl.listing_id WHERE wl.watch_id = ?').all(watchId) as Array<{ association_id: number; variant_source: string | null; variant_key: string | null; title: string }>;
    if (!associations.length) return;
    this.transaction(() => {
      const update = this.stmt('UPDATE watch_listings SET variant_key = ?, variant_source = ? WHERE id = ?');
      for (const association of associations) {
        // Manual picks survive while their variant exists. Jev picks are
        // re-derived: they were made against the old definitions, and the
        // next scan asks again (gated and cached).
        if (association.variant_source === 'manual' && association.variant_key && ids.has(association.variant_key)) continue;
        update.run(groups.length ? assignVariant(association.title, groups) : null, groups.length ? 'rule' : null, association.association_id);
      }
    });
  }

  /**
   * Saved listings a variant proposal is drawn from: this watch's matches that
   * are neither hidden nor rejected by AI relevance (when the watch uses it),
   * newest first, with their current asking price.
   */
  private variantSuggestionSamples(row: WatchRow, limit = 300): VariantSample[] {
    const rows = this.stmt(`SELECT l.title, l.price_pln FROM watch_listings wl JOIN listings l ON l.id = wl.listing_id
      WHERE wl.watch_id = ? AND l.price_pln > 0
        AND NOT EXISTS (SELECT 1 FROM listing_actions a WHERE a.marketplace = l.marketplace AND a.listing_id = l.listing_id AND a.hidden = 1)
        AND (? = 0 OR NOT EXISTS (SELECT 1 FROM listing_relevance r WHERE r.watch_id = wl.watch_id AND r.marketplace = l.marketplace AND r.listing_id = l.listing_id AND (r.relevance_status = 'irrelevant' OR (r.relevance_status IS NULL AND r.relevant = 0))))
      ORDER BY wl.last_seen_at DESC, wl.id DESC LIMIT ?`).all(row.id, row.ai_relevance === false || row.ai_relevance === 0 ? 0 : 1, limit) as Array<{ title: string; price_pln: number }>;
    return rows.map((item) => ({ title: String(item.title ?? ''), price: Number(item.price_pln) }));
  }

  /**
   * Propose model-variant groups from a watch's saved listings. The AI
   * proposal is used when OpenRouter is configured and falls back to the
   * title heuristic on any failure; either way every group is re-checked
   * against the same titles by the deterministic matcher, and groups whose
   * terms equal an existing group keep that group's id (and baseline).
   */
  async suggestWatchVariantGroups(watchId: string): Promise<{ groups: VariantGroup[]; listings: number; method: 'ai' | 'titles' }> {
    const row = this.stmt('SELECT * FROM watches WHERE id = ?').get(watchId) as WatchRow | undefined;
    if (!row) throw new ServiceError('Watch not found', 404);
    const samples = this.variantSuggestionSamples(row);
    const existing = parseVariantGroups(row.variant_groups_json);
    const context = { query: String(row.query ?? ''), terms: String(row.included_terms ?? '') };
    if (samples.length < 2) return { groups: [], listings: samples.length, method: 'titles' };
    const { apiKey, model } = this.deepSeekConfig();
    if (apiKey) {
      try {
        const proposed = await this.aiVariantSuggestions({
          query: context.query,
          includedTerms: context.terms,
          excludedTerms: String(row.excluded_terms ?? ''),
          listings: samples.slice(0, 150),
        }, { apiKey, model });
        return { groups: finalizeVariantSuggestions(proposed, samples, existing), listings: samples.length, method: 'ai' };
      } catch (error) {
        this.log('error', 'watch', `${row.name}: AI variant suggestions failed, using title analysis — ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return { groups: finalizeVariantSuggestions(suggestVariantGroupsFromTitles(samples, context), samples, existing), listings: samples.length, method: 'titles' };
  }

  /**
   * Draft the operator's resale listing from the listing a flip was bought
   * through: its saved description, or the live page when Scout never saved
   * one. The AI rewrites it as the operator's own listing; without an API key
   * (or when the call fails) the original text is returned to edit by hand.
   * With `photos`, the original gallery comes back too: a preserved research
   * copy's images, else the live page's gallery, else the search thumbnail.
   */
  async draftResaleListing(listingKey: string, options: { photos?: boolean } = {}): Promise<{ draft: ResaleListingDraft; images: Array<{ mime: string; data: Buffer }> }> {
    const { marketplace, listingId } = parseListingKey(listingKey);
    const ordinary = this.stmt('SELECT id, title, condition, url, image_url FROM listings WHERE marketplace = ? AND listing_id = ?').get(marketplace, listingId) as Record<string, any> | undefined;
    const research = ordinary ? undefined : this.stmt('SELECT id, title, NULL AS condition, url, image_url FROM market_listings WHERE marketplace = ? AND listing_id = ? ORDER BY last_seen_at DESC, id DESC LIMIT 1').get(marketplace, listingId) as Record<string, any> | undefined;
    const row = ordinary ?? research;
    if (!row) throw new ServiceError('Scout no longer has the listing this flip was bought from', 404);
    const url = String(row.url);
    // The detail page is fetched at most once, and only when something needs it.
    let page: Promise<string | null> | undefined;
    const html = () => page ??= this.detailHtml(url, marketplace).catch((error) => {
      this.log('info', 'diagnostics', `Resale draft: could not fetch the original ${marketplace} listing ${listingId} — ${error instanceof Error ? error.message : String(error)}`);
      return null;
    });

    const saved = (ordinary
      ? this.stmt('SELECT description FROM listing_detail_snapshots WHERE listing_id = ? AND description IS NOT NULL ORDER BY captured_at DESC, id DESC LIMIT 1').get(row.id)
      : this.stmt('SELECT description FROM market_listing_snapshots WHERE market_listing_id = ? AND description IS NOT NULL ORDER BY captured_at DESC, id DESC LIMIT 1').get(row.id)) as { description?: string | null } | undefined;
    let description = saved?.description?.trim() || null;
    if (!description) {
      const fetched = await html();
      description = fetched ? parseListingDescription(fetched, marketplace)?.trim() || null : null;
    }

    const images: Array<{ mime: string; data: Buffer }> = [];
    if (options.photos) {
      // Flip photos must be JPEG, PNG or WebP; other formats are skipped.
      const usable = (mime: string) => mime === 'image/jpeg' || mime === 'image/png' || mime === 'image/webp';
      if (research) {
        const stored = this.stmt(`SELECT i.mime_type, i.data FROM market_listing_snapshot_images i
          WHERE i.snapshot_id = (SELECT id FROM market_listing_snapshots WHERE market_listing_id = ? AND image_count > 0 ORDER BY captured_at DESC, id DESC LIMIT 1)
          ORDER BY i.position, i.id`).all(row.id) as Array<{ mime_type: string; data: Uint8Array }>;
        for (const image of stored) if (usable(image.mime_type)) images.push({ mime: image.mime_type, data: Buffer.from(image.data) });
      }
      if (!images.length) {
        const fetched = await html();
        let urls: string[] = [];
        try { urls = fetched ? parseListingImageUrls(fetched, marketplace, SNAPSHOT_MAX_IMAGES * 4).slice(0, SNAPSHOT_MAX_IMAGES) : []; } catch { urls = []; }
        if (!urls.length && row.image_url) urls = [String(row.image_url)];
        for (let offset = 0; offset < urls.length; offset += 3) {
          const batch = await Promise.all(urls.slice(offset, offset + 3).map((imageUrl) => this.fetchSnapshotImage(imageUrl, url).catch(() => null)));
          for (const image of batch) if (image && usable(image.mime)) images.push(image);
        }
      }
    }

    const source = { marketplace, title: String(row.title), url, description };
    // The original's own condition label, used when AI can't say or is off.
    const sourceCondition = listingConditionFromLabel(row.condition ? String(row.condition) : null);
    const { apiKey, model } = this.deepSeekConfig();
    if (apiKey) {
      try {
        const written = await this.aiResaleListing({ marketplace, title: source.title, condition: row.condition ? String(row.condition) : null, description }, { apiKey, model });
        return { draft: { ...written, condition: written.condition ?? sourceCondition, method: 'ai', source }, images };
      } catch (error) {
        this.log('error', 'diagnostics', `Resale draft for ${marketplace} ${listingId}: AI failed, returning the original text — ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return { draft: { title: source.title.slice(0, 70), description: description ?? '', condition: sourceCondition, category: '', method: 'copy', source }, images };
  }

  /**
   * Write a listing for a flip that was not bought through Scout, from the
   * operator's own title and notes. Needs OpenRouter; there is no original
   * text to copy instead.
   */
  async draftResaleListingFromNotes(input: { title: string; notes: string; condition: string | null }): Promise<ResaleListingDraft> {
    const { apiKey, model } = this.deepSeekConfig();
    if (!apiKey) throw new ServiceError('Writing a listing needs an OpenRouter API key in Settings', 409);
    try {
      const written = await this.aiResaleListing({ marketplace: null, title: input.title, condition: input.condition, description: input.notes.trim() || null }, { apiKey, model });
      return { ...written, method: 'ai', source: null };
    } catch (error) {
      this.log('error', 'diagnostics', `Resale draft from notes: AI failed — ${error instanceof Error ? error.message : String(error)}`);
      throw new ServiceError(`AI could not write the listing: ${error instanceof Error ? error.message : String(error)}`, 502);
    }
  }

  /**
   * After a scan, give a watch that is still waiting for automatic groups its
   * first proposal once it has {@link AUTO_VARIANT_MIN_LISTINGS} listings.
   * Found groups are stored like hand-made ones (and remain editable); the
   * flag is cleared so later scans never overwrite them. When the listings
   * look like a single product the attempt is recorded and retried only after
   * the watch has grown by half again.
   */
  private async autoGenerateVariantGroups(watchId: string) {
    const row = this.stmt('SELECT * FROM watches WHERE id = ?').get(watchId) as WatchRow | undefined;
    if (!row || !row.variant_groups_auto || parseVariantGroups(row.variant_groups_json).length) return;
    const available = this.variantSuggestionSamples(row, AUTO_VARIANT_MIN_LISTINGS * 40).length;
    const checked = Number(row.variant_groups_auto_checked ?? 0);
    if (available < AUTO_VARIANT_MIN_LISTINGS || (checked && available < checked * 1.5)) return;
    const suggestion = await this.suggestWatchVariantGroups(watchId);
    // The user may have edited the watch while the proposal was being made.
    const current = this.stmt('SELECT variant_groups_auto, variant_groups_json FROM watches WHERE id = ?').get(watchId) as WatchRow | undefined;
    if (!current?.variant_groups_auto || parseVariantGroups(current.variant_groups_json).length) return;
    if (!suggestion.groups.length) {
      this.stmt('UPDATE watches SET variant_groups_auto_checked = ? WHERE id = ?').run(available, watchId);
      this.log('info', 'watch', `${row.name}: no model variants found in ${suggestion.listings} listings; will look again as more arrive`);
      return;
    }
    this.stmt('UPDATE watches SET variant_groups_json = ?, variant_groups_auto = 0, variant_groups_auto_checked = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(suggestion.groups), available, nowIso(), watchId);
    this.retagWatchVariants(watchId);
    this.log('info', 'watch', `${row.name}: generated ${suggestion.groups.length} model variants from ${suggestion.listings} listings (${suggestion.method === 'ai' ? 'AI' : 'title analysis'}): ${suggestion.groups.map((group) => group.label).join(', ')}`);
    this.emit('watch', { id: watchId });
  }

  /**
   * Per-scan variant resolution. Precedence: a manual pick from the listing
   * drawer, then the variants' term rules, then a Jev pick (stored from an
   * earlier scan or made in this one), else Other / unclassified.
   */
  private scanVariantResolver(row: WatchRow, baselines: WatchBaselines) {
    const groups = baselines.groups;
    const ids = new Set(groups.map((group) => group.id));
    const saved = new Map<string, VariantAssignment>();
    if (groups.length) {
      const rows = this.stmt(`SELECT l.marketplace, l.listing_id, wl.variant_key, wl.variant_source FROM watch_listings wl JOIN listings l ON l.id = wl.listing_id
        WHERE wl.watch_id = ? AND wl.variant_source IN ('manual', 'jev')`).all(row.id) as Array<{ marketplace: string; listing_id: string; variant_key: string | null; variant_source: 'manual' | 'jev' }>;
      for (const item of rows) {
        if (item.variant_key && ids.has(item.variant_key)) saved.set(`${item.marketplace}:${item.listing_id}`, { key: item.variant_key, source: item.variant_source });
      }
    }
    return {
      get(listing: NormalizedListing): VariantAssignment {
        if (!groups.length) return { key: OTHER_VARIANT_KEY, source: null };
        const stored = saved.get(`${listing.marketplace}:${listing.listingId}`);
        if (stored?.source === 'manual') return stored;
        const rule = assignVariant(listing.title, groups);
        if (rule !== OTHER_VARIANT_KEY) return { key: rule, source: 'rule' };
        return stored ?? { key: OTHER_VARIANT_KEY, source: 'rule' };
      },
      setJev(listing: NormalizedListing, key: string) {
        saved.set(`${listing.marketplace}:${listing.listingId}`, { key, source: 'jev' });
      },
    };
  }

  /** Score a price in one bucket: named variants use the pooled spread, Other keeps its own. */
  private variantDealScore(row: WatchRow, price: number, baselines: WatchBaselines, key: string, referenceMedian: number | null) {
    const bucket = baselines.buckets.get(key) ?? { prices: [], firstObservedAt: null };
    const named = key !== OTHER_VARIANT_KEY && baselines.groups.length > 0;
    return this.dealScore(row, price, bucket, referenceMedian, named ? baselines.pooled : null);
  }

  /**
   * Jev fallback for listings no variant rule matched. Spend-controlled like
   * the fuzzy rescue: only listings that would be a deal in at least one named
   * variant are asked, at most VARIANT_JEV_BUDGET per scan, and answers are
   * cached against the full variant definitions. Only a confident pick
   * assigns; any failure leaves the listing in Other.
   */
  private async assignVariantsWithJev(listings: NormalizedListing[], row: WatchRow, baselines: WatchBaselines, resolver: ReturnType<ScoutService['scanVariantResolver']>) {
    const groups = baselines.groups;
    const live = groups.length ? this.jevLiveConfig() : null;
    if (!live) return;
    const ids = new Set(groups.map((group) => group.id));
    const couldBeDeal = (listing: NormalizedListing) => groups.some((group) => {
      const { score, dealStrength } = this.variantDealScore(row, listing.price, baselines, group.id, null);
      return score.qualifies || (dealStrength ?? 0) >= 4;
    });
    const candidates = listings.filter((listing) => resolver.get(listing).key === OTHER_VARIANT_KEY && couldBeDeal(listing)).slice(0, VARIANT_JEV_BUDGET);
    // The calls are independent round trips, so they run through the same
    // bounded pool as the fuzzy rescue. Candidates sharing an input hash are
    // asked once: sequentially the repeat would have hit the cache the first
    // one wrote. Assignments are applied in candidate order after the pool.
    type VariantOutcome = { variantId: string | null; cached: boolean } | null;
    const byHash = new Map<string, { context: Parameters<ScoutService['jevVariant']>[0]; outcome?: VariantOutcome }>();
    const hashes = candidates.map((listing) => {
      const context = { query: String(row.query ?? ''), title: listing.title, condition: listing.condition, variants: groups };
      const inputHash = listingVariantInputHash(context);
      if (!byHash.has(inputHash)) byHash.set(inputHash, { context });
      return inputHash;
    });
    await mapPool([...byHash.entries()], jevCheckConcurrency(), async ([inputHash, task]) => {
      const cached = this.readFuzzyCache(inputHash, live.jevModel, 'variant');
      if (cached) {
        task.outcome = { variantId: cached.rescued && ids.has(cached.decision) ? cached.decision : null, cached: true };
        return;
      }
      try {
        const judgment = await this.jevVariant(task.context, { apiKey: live.apiKey, model: live.jevModel });
        this.logJevLive('variant', inputHash, live, { jevAnswer: judgment, jevConfidence: judgment.confidence, jevUnsure: judgment.unsure });
        const variantId = judgment.decision === 'variant' && !judgment.unsure ? judgment.variantId : null;
        this.writeFuzzyCache(inputHash, live.jevModel, 'variant', judgment.variantId ?? judgment.decision, judgment.confidence, variantId !== null);
        task.outcome = { variantId, cached: false };
      } catch (error) {
        this.logJevLive('variant', inputHash, live, { jevError: error instanceof Error ? error.message : String(error) });
        task.outcome = null;
      }
    });
    const applied = new Set<string>();
    candidates.forEach((listing, index) => {
      const outcome = byHash.get(hashes[index])?.outcome;
      if (!outcome) return;
      // A repeat reads what the first answer cached, which only counts a
      // known variant id.
      const repeat = applied.has(hashes[index]);
      applied.add(hashes[index]);
      const variantId = repeat && !outcome.cached && outcome.variantId !== null && !ids.has(outcome.variantId) ? null : outcome.variantId;
      if (variantId) resolver.setJev(listing, variantId);
    });
  }

  /**
   * Manually move a listing to one of its watch's variants, or pass null to
   * return it to automatic assignment (rules; a Jev pick is re-asked on the
   * next scan). The listing is re-scored against its new variant immediately.
   */
  setListingVariant(watchId: string, listingKey: string, variantId: string | null): ListingDetail {
    const row = this.stmt('SELECT * FROM watches WHERE id = ?').get(watchId) as WatchRow | undefined;
    if (!row) throw new ServiceError('Watch not found', 404);
    const groups = parseVariantGroups(row.variant_groups_json);
    if (!groups.length) throw new ServiceError('This watch has no model variants');
    if (variantId !== null && !groups.some((group) => group.id === variantId)) throw new ServiceError('Unknown variant for this watch');
    const { marketplace, listingId } = parseListingKey(listingKey);
    const association = this.stmt(`SELECT wl.id, l.title, l.price_pln FROM watch_listings wl JOIN listings l ON l.id = wl.listing_id
      WHERE wl.watch_id = ? AND l.marketplace = ? AND l.listing_id = ?`).get(watchId, marketplace, listingId) as { id: number; title: string; price_pln: number } | undefined;
    if (!association) throw new ServiceError('Listing is not part of this watch', 404);
    const next: VariantAssignment = variantId !== null ? { key: variantId, source: 'manual' } : { key: assignVariant(association.title, groups), source: 'rule' };
    this.stmt('UPDATE watch_listings SET variant_key = ?, variant_source = ? WHERE id = ?').run(next.key, next.source, association.id);
    const { score, dealStrength } = this.variantDealScore(row, Number(association.price_pln), this.watchBaselines(row), next.key, null);
    if (score.isReady && score.typical !== null) {
      const strength = dealStrength ?? 1;
      this.stmt("UPDATE watch_listings SET typical_pln = ?, deal_strength = ?, deal_label = ?, typical_source = 'own-history' WHERE id = ?").run(score.typical, strength, dealLabelFromStrength(strength), association.id);
    } else {
      this.stmt('UPDATE watch_listings SET typical_pln = NULL, deal_strength = NULL, deal_label = NULL, typical_source = NULL WHERE id = ?').run(association.id);
    }
    this.emit('scan', { refresh: true, watchId });
    return this.listingDetail(listingKey, watchId);
  }

  watchAnalytics(id: string, rangeDays = 30): WatchAnalytics {
    const row = this.stmt('SELECT id, name, shipping_only, min_price_pln, max_price_pln FROM watches WHERE id = ?').get(id) as WatchRow | undefined;
    if (!row) throw new ServiceError('Watch not found', 404);
    const days = Math.max(7, Math.min(180, Math.floor(rangeDays)));
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60_000).toISOString();
    // Driven from the watch's associations: listing-level filters (relevance,
    // shipping) run once per association and observations are range seeks on
    // observations_watch_listing. Every observation belongs to its
    // (watch_id, listing_id) association, so the row set is unchanged.
    const filters = `NOT EXISTS (SELECT 1 FROM listing_relevance r WHERE r.watch_id = wl.watch_id AND r.marketplace = l.marketplace AND r.listing_id = l.listing_id AND (r.relevance_status = 'irrelevant' OR (r.relevance_status IS NULL AND r.relevant = 0)) AND EXISTS (SELECT 1 FROM watches rw WHERE rw.id = r.watch_id AND rw.ai_relevance = 1))
        AND (?3 = 0 OR (l.marketplace = 'Vinted' OR l.shipping_available = 1))
        AND (?4 IS NULL OR o.price_pln >= ?4)
        AND (?5 IS NULL OR o.price_pln <= ?5)`;
    const filterParams = [id, cutoff, row.shipping_only ? 1 : 0, row.min_price_pln, row.max_price_pln] as unknown[];
    // Daily reduction in SQL: the last observation per listing per day
    // (ISO-8601 UTC timestamps sort correctly under date()). SQLite takes
    // bare columns from the MAX(observed_at) row, so price and typical are
    // the ones observed last — matching the previous JS-side dedupe. COUNT is
    // not a min/max aggregate, so it leaves that choice intact; adding
    // MIN(observed_at) here would not.
    const dailyRows = this.stmt(`SELECT date(o.observed_at) AS day, o.listing_id, l.marketplace, o.price_pln, COALESCE(o.baseline_pln, CASE WHEN o.scan_id IS NULL THEN l.typical_pln END) AS typical_pln, MAX(o.observed_at) AS observed_at, COUNT(*) AS n
      FROM watch_listings wl
      JOIN listings l ON l.id = wl.listing_id
      CROSS JOIN observations o INDEXED BY observations_watch_listing ON o.watch_id = wl.watch_id AND o.listing_id = wl.listing_id AND o.observed_at >= ?2
      WHERE wl.watch_id = ?1 AND ${filters}
      GROUP BY day, o.listing_id`).all(...filterParams) as Array<Record<string, any>>;
    // Raw-row totals come from the per-group counts; the window's first and
    // last observation are ordered LIMIT-1 probes with the same filters.
    const probe = (direction: 'ASC' | 'DESC') => (this.stmt(`SELECT o.observed_at AS at FROM observations o
      JOIN listings l ON l.id = o.listing_id
      JOIN watch_listings wl ON wl.watch_id = o.watch_id AND wl.listing_id = o.listing_id
      WHERE o.watch_id = ?1 AND o.observed_at >= ?2 AND ${filters}
      ORDER BY o.observed_at ${direction} LIMIT 1`).get(...filterParams) as { at?: string } | undefined)?.at ?? null;
    let totalObservations = 0;
    for (const item of dailyRows) totalObservations += Number(item.n);
    const bounds = { total: totalObservations, first_at: dailyRows.length ? probe('ASC') : null, last_at: dailyRows.length ? probe('DESC') : null };
    const observations = dailyRows.map((item): WatchAnalyticsObservation => ({
      listingId: Number(item.listing_id),
      marketplace: item.marketplace as Marketplace,
      price: Number(item.price_pln),
      typical: item.typical_pln === null || item.typical_pln === undefined ? null : Number(item.typical_pln),
      observedAt: String(item.observed_at),
    }));
    const daily = new Map<string, Map<number, WatchAnalyticsObservation>>();
    for (const observation of observations) {
      const date = observation.observedAt.slice(0, 10);
      const day = daily.get(date) ?? new Map<number, WatchAnalyticsObservation>();
      const previousForDay = day.get(observation.listingId);
      if (!previousForDay || observation.observedAt > previousForDay.observedAt) day.set(observation.listingId, observation);
      daily.set(date, day);
    }
    const points: WatchAnalyticsPoint[] = Array.from(daily.entries()).sort(([a], [b]) => a.localeCompare(b)).map(([date, rowsForDay]) => {
      const stats = analyticsPriceStats(Array.from(rowsForDay.values()));
      return { date, medianPrice: stats.medianPrice, lowerPrice: stats.lowerPrice, upperPrice: stats.upperPrice, listingCount: stats.listingCount };
    });
    const currentRows = points.length ? daily.get(points[points.length - 1].date) : undefined;
    const current = analyticsPriceStats(currentRows ? Array.from(currentRows.values()) : []);
    const firstMedian = points.find((point) => point.medianPrice !== null)?.medianPrice ?? null;
    const medianChangePercent = firstMedian !== null && current.medianPrice !== null && firstMedian > 0
      ? ((current.medianPrice - firstMedian) / firstMedian) * 100
      : null;
    const sourceRows = new Map<Marketplace, WatchAnalyticsObservation[]>();
    for (const observation of currentRows ? Array.from(currentRows.values()) : []) {
      const source = sourceRows.get(observation.marketplace) ?? [];
      source.push(observation);
      sourceRows.set(observation.marketplace, source);
    }
    const sources: WatchAnalyticsSource[] = Array.from(sourceRows.entries()).sort(([a], [b]) => a.localeCompare(b)).map(([source, sourceListings]) => {
      const stats = analyticsPriceStats(sourceListings);
      return { source, medianPrice: stats.medianPrice, listingCount: stats.listingCount, strongDealCount: stats.strongDealCount };
    });
    return {
      watchId: id,
      watchName: String(row.name),
      rangeDays: days,
      firstObservedAt: bounds.first_at ?? null,
      lastObservedAt: bounds.last_at ?? null,
      totalObservations: Number(bounds.total ?? 0),
      current: {
        medianPrice: current.medianPrice,
        lowerPrice: current.lowerPrice,
        upperPrice: current.upperPrice,
        minPrice: current.minPrice,
        maxPrice: current.maxPrice,
        listingCount: current.listingCount,
        strongDealCount: current.strongDealCount,
        strongDealRate: current.strongDealRate,
      },
      medianChangePercent,
      points,
      sources,
    };
  }

  /**
   * Cross-watch analytics for the Analytics page. Deal metrics come from
   * daily-deduped `observations` (asking price vs learned baseline); triage
   * and AI-quality sections are operational signals that are not watch-scoped,
   * so they honor only the range and marketplace filters.
   */
  analytics(options: { days?: number; watchId?: string; marketplace?: Marketplace } = {}): AnalyticsData {
    const days = Math.max(7, Math.min(180, Math.floor(options.days ?? 30)));
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60_000).toISOString();
    const watchId = options.watchId ?? null;
    const marketplace = options.marketplace ?? null;

    // Identical relevance/shipping/price semantics to watchAnalytics so the
    // page never counts listings a watch itself would ignore. Driven from the
    // associations (the result already inner-joined them) so listing-level
    // filters run per association and observations are range seeks on
    // observations_watch_listing instead of a full scan.
    const predicates = [
      'w.archived_at IS NULL',
      'o.observed_at >= ?',
      "NOT EXISTS (SELECT 1 FROM listing_relevance r WHERE r.watch_id = wl.watch_id AND r.marketplace = l.marketplace AND r.listing_id = l.listing_id AND (r.relevance_status = 'irrelevant' OR (r.relevance_status IS NULL AND r.relevant = 0)) AND w.ai_relevance = 1)",
      "(w.shipping_only = 0 OR (l.marketplace = 'Vinted' OR l.shipping_available = 1))",
      '(w.min_price_pln IS NULL OR o.price_pln >= w.min_price_pln)',
      '(w.max_price_pln IS NULL OR o.price_pln <= w.max_price_pln)',
    ];
    const params: unknown[] = [cutoff];
    if (watchId) { predicates.push('w.id = ?'); params.push(watchId); }
    if (marketplace) { predicates.push('l.marketplace = ?'); params.push(marketplace); }
    const rows = this.stmt(`SELECT date(o.observed_at) AS day, o.listing_id AS listing_id, o.watch_id AS watch_id, w.name AS watch_name, l.marketplace AS marketplace, o.price_pln AS price_pln, COALESCE(o.baseline_pln, CASE WHEN o.scan_id IS NULL THEN l.typical_pln END) AS typical_pln, MAX(o.observed_at) AS observed_at, wl.first_seen_at AS first_seen_at
      FROM watches w
      JOIN watch_listings wl ON wl.watch_id = w.id
      JOIN listings l ON l.id = wl.listing_id
      CROSS JOIN observations o INDEXED BY observations_watch_listing ON o.watch_id = wl.watch_id AND o.listing_id = wl.listing_id
      WHERE ${predicates.join(' AND ')}
      GROUP BY day, o.watch_id, o.listing_id`).all(...params) as Array<Record<string, any>>;
    const observations: AnalyticsObservation[] = rows.map((row) => ({
      day: String(row.day),
      listingId: Number(row.listing_id),
      watchId: String(row.watch_id),
      watchName: String(row.watch_name),
      marketplace: row.marketplace as Marketplace,
      price: Number(row.price_pln),
      typical: row.typical_pln === null || row.typical_pln === undefined ? null : Number(row.typical_pln),
      observedAt: String(row.observed_at),
      firstSeenAt: String(row.first_seen_at),
    }));

    const scanPredicates = ["watch_kind = 'watch'", 'started_at >= ?'];
    const scanParams: unknown[] = [cutoff];
    if (marketplace) { scanPredicates.push('marketplace = ?'); scanParams.push(marketplace); }
    if (watchId) { scanPredicates.push('watch_id = ?'); scanParams.push(watchId); }
    const scanRows = this.stmt(`SELECT marketplace, COUNT(*) AS runs, SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed, AVG(CASE WHEN completed_at IS NOT NULL THEN (julianday(completed_at) - julianday(started_at)) * 86400000 END) AS average_ms
      FROM scans WHERE ${scanPredicates.join(' AND ')} GROUP BY marketplace`).all(...scanParams) as Array<Record<string, any>>;
    const scanByMarketplace = new Map<string, { runs: number; completed: number; averageMs: number | null }>();
    let scanRuns = 0;
    let scansCompleted = 0;
    for (const row of scanRows) {
      const runs = Number(row.runs);
      const completed = Number(row.completed);
      scanRuns += runs;
      scansCompleted += completed;
      scanByMarketplace.set(String(row.marketplace), {
        runs,
        completed,
        averageMs: row.average_ms === null || row.average_ms === undefined ? null : Number(row.average_ms),
      });
    }
    const marketplaceComparison: AnalyticsMarketplaceRow[] = marketplaceDeals(observations).map((row) => {
      const scan = scanByMarketplace.get(row.marketplace);
      return {
        ...row,
        scanRuns: scan?.runs ?? 0,
        scanSuccessRate: scan && scan.runs > 0 ? (scan.completed / scan.runs) * 100 : null,
        averageLatencyMs: scan?.averageMs ?? null,
      };
    });

    const triagePredicates = ['a.updated_at >= ?'];
    const triageParams: unknown[] = [cutoff];
    if (marketplace) { triagePredicates.push('a.marketplace = ?'); triageParams.push(marketplace); }
    const triageRows = this.stmt(`SELECT a.decision AS decision, COUNT(*) AS count FROM listing_actions a WHERE ${triagePredicates.join(' AND ')} GROUP BY a.decision`).all(...triageParams) as Array<{ decision?: string | null; count: number }>;
    const triage: AnalyticsTriage = { buy: 0, watch: 0, pass: 0, none: 0 };
    for (const row of triageRows) {
      const count = Number(row.count);
      if (row.decision === 'buy') triage.buy += count;
      else if (row.decision === 'watch') triage.watch += count;
      else if (row.decision === 'pass') triage.pass += count;
      else triage.none += count;
    }

    const relevanceRow = this.stmt("SELECT SUM(CASE WHEN relevance_status IN ('relevant', 'irrelevant') THEN 1 ELSE 0 END) AS judged, SUM(CASE WHEN relevance_status = 'relevant' THEN 1 ELSE 0 END) AS passed FROM listing_relevance WHERE checked_at >= ?").get(cutoff) as { judged?: number; passed?: number };
    const shadowRow = this.stmt('SELECT SUM(CASE WHEN agreement IS NOT NULL THEN 1 ELSE 0 END) AS judged, SUM(CASE WHEN agreement = 1 THEN 1 ELSE 0 END) AS agreed FROM jev_shadow_log WHERE created_at >= ?').get(cutoff) as { judged?: number; agreed?: number };
    const relevanceJudged = Number(relevanceRow.judged ?? 0);
    const shadowJudged = Number(shadowRow.judged ?? 0);
    const aiQuality: AnalyticsAiQuality = {
      relevanceJudged,
      relevancePassRate: relevanceJudged > 0 ? (Number(relevanceRow.passed ?? 0) / relevanceJudged) * 100 : null,
      shadowJudged,
      shadowAgreementRate: shadowJudged > 0 ? (Number(shadowRow.agreed ?? 0) / shadowJudged) * 100 : null,
    };

    const overview: AnalyticsOverview = {
      ...dealOverview(observations, cutoff),
      scanRuns,
      scanSuccessRate: scanRuns > 0 ? (scansCompleted / scanRuns) * 100 : null,
    };

    return {
      rangeDays: days,
      watchId,
      marketplace,
      generatedAt: nowIso(),
      overview,
      trend: trendPoints(observations),
      discountDistribution: discountDistribution(observations),
      watchLeaderboard: watchLeaderboard(observations),
      marketplaceComparison,
      triage,
      aiQuality,
    };
  }

  listingsPage(options: {
    page?: number;
    pageSize?: number;
    marketplace?: Marketplace;
    q?: string;
    watchId?: string;
    includeAiFiltered?: boolean;
    /** `only` lists just the rows AI relevance filtering hid; it wins over includeAiFiltered. */
    aiFiltered?: 'exclude' | 'include' | 'only';
    /** Lowest deal strength (1-5) to include. */
    minStrength?: number;
    sort?: 'newest' | 'strongest' | 'price';
    /** `none` keeps only untriaged rows. */
    decision?: ListingDecision | 'none';
    /** Defaults to `all` so internal callers (dashboard feed) keep today's rows. */
    visibility?: 'visible' | 'hidden' | 'all';
  } = {}, knownWatches?: Watch[]) {
    const freshnessCutoff = new Date(Date.now() - MATCH_VISIBILITY_MS).toISOString();
    const aiFilteredPredicate = 'EXISTS (SELECT 1 FROM listing_relevance r WHERE r.watch_id = wl.watch_id AND r.marketplace = l.marketplace AND r.listing_id = l.listing_id AND (r.relevance_status = \'irrelevant\' OR (r.relevance_status IS NULL AND r.relevant = 0)) AND w.ai_relevance = 1)';
    // The feed shows matches seen in the last 12 h, but listings you marked
    // (Buy/Watch/Pass) or hid stay reviewable after newer posts push them off
    // the scanned page, until retention prunes them.
    const keepStale = (Boolean(options.decision) && options.decision !== 'none') || options.visibility === 'hidden';
    const aiFiltered = options.aiFiltered ?? (options.includeAiFiltered ? 'include' : 'exclude');
    const predicates = [
      'w.archived_at IS NULL',
      ...(keepStale ? [] : ['wl.last_seen_at > ?']),
      ...(aiFiltered === 'exclude' ? [`NOT (${aiFilteredPredicate})`] : aiFiltered === 'only' ? [aiFilteredPredicate] : []),
      "(w.shipping_only = 0 OR (l.marketplace = 'Vinted' OR l.shipping_available = 1))",
      '(w.min_price_pln IS NULL OR l.price_pln >= w.min_price_pln)',
      '(w.max_price_pln IS NULL OR l.price_pln <= w.max_price_pln)',
    ];
    const params: unknown[] = keepStale ? [] : [freshnessCutoff];
    if (options.marketplace) { predicates.push('l.marketplace = ?'); params.push(options.marketplace); }
    if (options.watchId) { predicates.push('w.id = ?'); params.push(options.watchId); }
    if (options.decision === 'none') predicates.push('a.decision IS NULL');
    else if (options.decision) { predicates.push('a.decision = ?'); params.push(options.decision); }
    if (options.minStrength && options.minStrength > 1) { predicates.push('COALESCE(wl.deal_strength, 1) >= ?'); params.push(Math.min(5, Math.floor(options.minStrength))); }
    if (options.visibility === 'hidden') predicates.push('COALESCE(a.hidden, 0) = 1');
    else if (options.visibility === 'visible') predicates.push('COALESCE(a.hidden, 0) = 0');
    const query = options.q?.trim().toLowerCase() ?? '';
    if (query) {
      predicates.push("lower(COALESCE(l.title, '') || ' ' || COALESCE(l.subtitle, '') || ' ' || COALESCE(l.condition, '') || ' ' || COALESCE(l.location, '')) LIKE ? ESCAPE '\\'");
      params.push(`%${ScoutService.escapeLike(query)}%`);
    }
    const where = predicates.join(' AND ');
    const orderBy = options.sort === 'strongest'
      ? 'wl.deal_strength DESC, wl.last_seen_at DESC, wl.id DESC'
      : options.sort === 'price'
        ? 'l.price_pln ASC, wl.last_seen_at DESC, wl.id DESC'
        : 'wl.last_seen_at DESC, wl.id DESC';
    const total = Number((this.stmt(`SELECT COUNT(*) AS count FROM listings l JOIN watch_listings wl ON wl.listing_id = l.id JOIN watches w ON w.id = wl.watch_id LEFT JOIN listing_actions a ON a.marketplace = l.marketplace AND a.listing_id = l.listing_id WHERE ${where}`).get(...params) as { count?: number }).count ?? 0);
    const page = Math.max(1, Math.floor(options.page ?? 1));
    const pageSize = Math.max(1, Math.min(500, Math.floor(options.pageSize ?? 200)));
    const rows = this.stmt(`SELECT l.marketplace, l.listing_id, l.title, l.subtitle, l.price_pln, l.typical_pln, l.url, l.image_url, l.condition, l.location, l.shipping_available, l.price_negotiable, l.posted_at, l.refreshed_at, l.promoted, l.seller_type, l.last_seen_at, wl.id AS watch_listing_id, wl.watch_id, wl.first_seen_at AS watch_first_seen_at, wl.last_seen_at AS watch_last_seen_at, wl.typical_pln AS watch_typical_pln, wl.typical_source AS typical_source, wl.variant_key AS variant_key, wl.variant_source AS variant_source, wl.deal_strength AS watch_deal_strength, wl.deal_label AS watch_deal_label, w.name AS watch_name, w.enabled AS watch_enabled, w.archived_at AS watch_archived_at, w.shipping_only AS watch_shipping_only, w.min_price_pln AS watch_min_price_pln, w.max_price_pln AS watch_max_price_pln, a.decision AS listing_decision, a.note AS listing_note, a.hidden AS listing_hidden, l.ai_description_verification_json, l.ai_description_verification_at, l.ai_description_verification_status, l.ai_description_verification_error, CASE WHEN ${aiFilteredPredicate} THEN 1 ELSE 0 END AS ai_filtered
      FROM listings l
      JOIN watch_listings wl ON wl.listing_id = l.id
      JOIN watches w ON w.id = wl.watch_id
      LEFT JOIN listing_actions a ON a.marketplace = l.marketplace AND a.listing_id = l.listing_id
      WHERE ${where}
      ORDER BY ${orderBy} LIMIT ? OFFSET ?`).all(...params, pageSize, (page - 1) * pageSize) as Array<Record<string, any>>;
    const watches = new Map((knownWatches ?? this.getWatches()).map((watch) => [watch.id, watch]));
    const listings = rows.map((row) => this.listingFromRow(row, watches.get(row.watch_id)?.readiness === 100, watches.get(row.watch_id)?.variantGroups ?? []));
    return { listings, pagination: { page, pageSize, total, hasNext: page * pageSize < total } };
  }

  getListings(knownWatches?: Watch[], includeAiFiltered = false) {
    return this.listingsPage({ page: 1, pageSize: 500, includeAiFiltered }, knownWatches).listings;
  }

  listingDetail(key: string, watchId?: string | null): ListingDetail {
    const { marketplace, listingId } = parseListingKey(key);
    const row = this.stmt(`SELECT l.*, wl.id AS watch_listing_id, wl.watch_id, wl.first_seen_at AS watch_first_seen_at, wl.last_seen_at AS watch_last_seen_at, wl.typical_pln AS watch_typical_pln, wl.typical_source AS typical_source, wl.variant_key AS variant_key, wl.variant_source AS variant_source, wl.deal_strength AS watch_deal_strength, wl.deal_label AS watch_deal_label, w.name AS watch_name, a.decision AS listing_decision, a.note AS listing_note, a.hidden AS listing_hidden, a.updated_at AS action_updated_at
      FROM listings l
      LEFT JOIN watch_listings wl ON wl.listing_id = l.id AND (? IS NULL OR wl.watch_id = ?)
      LEFT JOIN watches w ON w.id = wl.watch_id
      LEFT JOIN listing_actions a ON a.marketplace = l.marketplace AND a.listing_id = l.listing_id
      WHERE l.marketplace = ? AND l.listing_id = ? AND (? IS NULL OR wl.watch_id = ?)
      ORDER BY CASE WHEN wl.id IS NOT NULL THEN 0 ELSE 1 END, wl.last_seen_at DESC LIMIT 1`).get(watchId ?? null, watchId ?? null, marketplace, listingId, watchId ?? null, watchId ?? null) as Record<string, any> | undefined;
    if (!row) throw new ServiceError('Listing detail is not available yet', 404);
    // Only the associated watch's readiness and groups are needed.
    const watch = row.watch_id != null ? this.watchById(String(row.watch_id)) : undefined;
    const listing = this.listingFromRow(row, watch?.readiness === 100, watch?.variantGroups ?? []);
    // Split instead of '(? IS NULL OR watch_id = ?)' so the watch-scoped read
    // seeks observations_watch_listing. The unscoped form is exact because
    // observations.watch_id is an enforced foreign key to watches.
    const historyWatchId = row.watch_id ?? watchId ?? null;
    const historyRows = historyWatchId !== null
      ? this.stmt('SELECT price_pln, observed_at FROM observations WHERE watch_id = ? AND listing_id = ? ORDER BY observed_at DESC, id DESC LIMIT 120').all(historyWatchId, row.id)
      : this.stmt('SELECT price_pln, observed_at FROM observations WHERE watch_id IN (SELECT id FROM watches) AND listing_id = ? ORDER BY observed_at DESC, id DESC LIMIT 120').all(row.id);
    const history = (historyRows as Array<{ price_pln: number; observed_at: string }>).reverse().map((point): PriceHistoryPoint => ({ price: Number(point.price_pln), observedAt: point.observed_at }));
    const snapshotRow = this.stmt(`SELECT title, price_pln, condition, location, url, description, captured_at, verification_status
      FROM listing_detail_snapshots WHERE listing_id = ? ORDER BY captured_at DESC, id DESC LIMIT 1`).get(row.id) as Record<string, any> | undefined;
    const snapshotStatus = snapshotRow?.verification_status === 'pass'
      || snapshotRow?.verification_status === 'reject'
      || snapshotRow?.verification_status === 'unknown'
      || snapshotRow?.verification_status === 'pending'
      || snapshotRow?.verification_status === 'not-configured'
      || snapshotRow?.verification_status === 'fallback'
      ? snapshotRow.verification_status
      : null;
    const descriptionSnapshot: ListingDetailSnapshot | null = snapshotRow ? {
      title: String(snapshotRow.title),
      price: Number(snapshotRow.price_pln),
      condition: snapshotRow.condition ?? null,
      location: snapshotRow.location ?? null,
      url: String(snapshotRow.url),
      description: snapshotRow.description ?? null,
      capturedAt: String(snapshotRow.captured_at),
      verificationStatus: snapshotStatus,
    } : null;
    const verificationInputHash: string | null = typeof row.ai_description_verification_input_hash === 'string' ? row.ai_description_verification_input_hash : null;
    const verificationModel: string | null = typeof row.ai_description_verification_model === 'string' ? row.ai_description_verification_model : null;
    let verificationTrace: VerificationTraceEntry[] | null = null;
    if (verificationInputHash) {
      try {
        const traceRows = this.stmt(`SELECT id, created_at, input_hash, jev_model, jev_answer_json, jev_confidence, jev_unsure, jev_error, deepseek_decision, agreement, vision_verdict, vision_confidence, vision_images_seen, vision_error, note
          FROM jev_shadow_log WHERE task = 'verification' AND input_hash = ? ORDER BY created_at DESC, id DESC LIMIT 5`).all(verificationInputHash) as Array<Record<string, any>>;
        verificationTrace = traceRows.map((trace): VerificationTraceEntry => {
          let jevAnswer: unknown | null = null;
          try {
            jevAnswer = trace.jev_answer_json ? JSON.parse(String(trace.jev_answer_json)) : null;
          } catch {
            jevAnswer = trace.jev_answer_json ?? null;
          }
          return {
            id: Number(trace.id),
            createdAt: String(trace.created_at),
            inputHash: String(trace.input_hash),
            jevModel: String(trace.jev_model),
            jevAnswer,
            jevConfidence: trace.jev_confidence === null || trace.jev_confidence === undefined ? null : Number(trace.jev_confidence),
            jevUnsure: Boolean(trace.jev_unsure),
            jevError: trace.jev_error ?? null,
            deepseekDecision: trace.deepseek_decision ?? null,
            agreement: trace.agreement === null || trace.agreement === undefined ? null : Boolean(trace.agreement),
            visionVerdict: trace.vision_verdict ?? null,
            visionConfidence: trace.vision_confidence === null || trace.vision_confidence === undefined ? null : Number(trace.vision_confidence),
            visionImagesSeen: trace.vision_images_seen === null || trace.vision_images_seen === undefined ? null : Number(trace.vision_images_seen),
            visionError: trace.vision_error ?? null,
            note: trace.note ?? null,
          };
        });
      } catch {
        verificationTrace = null;
      }
    }
    return {
      listing,
      history,
      action: { decision: listing.decision ?? null, note: listing.note ?? '', hidden: listing.hidden ?? false, updatedAt: row.action_updated_at ?? null },
      descriptionSnapshot,
      firstSeenAt: row.watch_first_seen_at ?? row.first_seen_at,
      lastSeenAt: row.watch_last_seen_at ?? row.last_seen_at,
      verificationTrace,
      verificationInputHash,
      verificationModel,
      ...(watch?.variantGroups.length ? { variantGroups: watch.variantGroups } : {}),
    };
  }

  async compareVerificationByKey(key: string): Promise<VerificationComparison> {
    const { marketplace, listingId } = parseListingKey(key);
    const row = this.stmt('SELECT title, condition FROM listings WHERE marketplace = ? AND listing_id = ?').get(marketplace, listingId) as { title?: string; condition?: string | null } | undefined;
    if (!row) throw new ServiceError('Listing detail is not available yet', 404);
    const listingRow = this.stmt('SELECT id FROM listings WHERE marketplace = ? AND listing_id = ?').get(marketplace, listingId) as { id?: number } | undefined;
    const snapshotRow = listingRow?.id ? this.stmt('SELECT description FROM listing_detail_snapshots WHERE listing_id = ? ORDER BY captured_at DESC, id DESC LIMIT 1').get(listingRow.id) as { description?: string | null } | undefined : undefined;
    const description: string | null = typeof snapshotRow?.description === 'string' ? snapshotRow.description : null;
    const context = {
      marketplace,
      title: String(row.title ?? ''),
      condition: row.condition ? String(row.condition) : undefined,
      description,
    };
    const inputHash = listingDescriptionVerificationInputHash(context);
    const deepSeek = this.deepSeekConfig();
    const apiKey = deepSeek.apiKey;
    if (!apiKey) throw new ServiceError('OpenRouter is not configured. Add an API key in Settings or set SCOUT_OPENROUTER_API_KEY.', 409);
    const jevLive = this.jevLiveConfig();
    const jevModel = jevLive?.jevModel ?? process.env.SCOUT_JEV_MODEL?.trim() ?? DEFAULT_JEV_MODEL;
    const llmModel = deepSeek.model;
    let jev: VerificationComparison['jev'];
    try {
      const judgment = await verifyListingDescriptionWithJev(context, { apiKey, model: jevModel });
      jev = { ok: true, judgment: { decision: judgment.decision, confidence: judgment.confidence, unsure: judgment.unsure }, raw: judgment };
    } catch (error) {
      jev = { ok: false, error: (error instanceof Error ? error.message : String(error)).slice(0, 500) };
    }
    let llm: VerificationComparison['llm'];
    try {
      const verification = await verifyListingDescriptionWithDeepSeek(context, { apiKey, model: llmModel });
      llm = { ok: true, verification, raw: verification };
    } catch (error) {
      llm = { ok: false, error: (error instanceof Error ? error.message : String(error)).slice(0, 500) };
    }
    return { key: `${marketplace}:${listingId}`, inputHash, jevModel, llmModel, jev, llm };
  }

  listingAction(key: string): ListingAction {
    const { marketplace, listingId } = parseListingKey(key);
    const row = this.stmt('SELECT decision, note, hidden, updated_at FROM listing_actions WHERE marketplace = ? AND listing_id = ?').get(marketplace, listingId) as { decision?: unknown; note?: string; hidden?: number; updated_at?: string } | undefined;
    return { decision: parseListingDecision(row?.decision), note: row?.note ?? '', hidden: Number(row?.hidden ?? 0) === 1, updatedAt: row?.updated_at ?? null };
  }

  /** Merges `patch` into the stored action; omitted fields keep their current value. */
  updateListingAction(key: string, patch: { decision?: ListingDecision | null; note?: string; hidden?: boolean }): ListingAction {
    const { marketplace, listingId } = parseListingKey(key);
    const current = this.listingAction(key);
    if (patch.decision === undefined && patch.note === undefined && patch.hidden === undefined) return current;
    const decision = patch.decision === undefined ? current.decision : patch.decision;
    const safeNote = (patch.note ?? current.note).trim().slice(0, 2000);
    const hidden = patch.hidden ?? current.hidden;
    const timestamp = nowIso();
    if (decision === null && !safeNote && !hidden) {
      this.stmt('DELETE FROM listing_actions WHERE marketplace = ? AND listing_id = ?').run(marketplace, listingId);
    } else {
      this.stmt(`INSERT INTO listing_actions (marketplace, listing_id, decision, note, hidden, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(marketplace, listing_id) DO UPDATE SET decision = excluded.decision, note = excluded.note, hidden = excluded.hidden, updated_at = excluded.updated_at`).run(marketplace, listingId, decision, safeNote, hidden ? 1 : 0, timestamp);
    }
    this.emit('listing-action', { key, decision, hidden });
    return { decision, note: safeNote, hidden, updatedAt: safeNote || decision || hidden ? timestamp : null };
  }

  /**
   * Searches and scans fetch a single page. Listings arrive newest-first, so
   * fresh offers are always on the first page; one OLX page carries 50 organic
   * offers plus promoted ads.
   */
  private async fetchSearchPages(source: Marketplace, query: string, filters: Parameters<typeof buildMarketplaceSearchUrl>[2], onPath?: ConnectorPathReporter) {
    const adapter = this.createConnectorAdapter(source, onPath);
    const first = await adapter.fetchPublicSearch(this.marketplaceSearchRequestUrl(source, query, filters));
    return [...new Map(first.map((listing) => [`${listing.marketplace}:${listing.listingId}`, listing])).values()];
  }

  /**
   * Stream a finished source to whichever client initiated the search. Only
   * fires when the client supplied a `searchId`; the HTTP response remains the
   * authoritative result set.
   */
  private emitSearchProgress(searchId: string | undefined, page: number, source: Marketplace, status: SearchSourceStatus, listings: Listing[]) {
    const id = searchId?.trim();
    if (!id) return;
    this.emit('search', { searchId: id, page, source, status, listings });
  }

  async manualSearch(input: SearchFilters): Promise<ManualSearchResponse> {
    if (this.activeManualSearches >= 3) throw new ServiceError('Three manual searches are already running. Try again shortly.', 429);
    this.activeManualSearches += 1;
    // The client pages through results; marketplaces cap their own page size.
    const page = Math.min(Math.max(Math.floor(input.page ?? 1), 1), 10);
    try {
      const tasks = input.sources.map(async (source) => {
      const started = Date.now();
      try {
        const fetched = await this.fetchSearchPages(source, input.query, { ...input, olxCategoryId: input.olxCategory?.id ?? null, page });
        const deterministicFilters = { minPrice: input.minPrice, maxPrice: input.maxPrice, condition: input.condition, sellerType: input.ownerType ?? null, shippingOnly: false };
        const comparable = filterListings(fetched, input.query, input.terms ?? '', input.excluded ?? '', deterministicFilters);
        // Cache-first like watch scans: only a few cold listings fetch an item
        // page per search; the rest surface as pending delivery checks.
        if (input.shippingOnly) await this.enrichShipping(comparable, source);
        let filtered = filterListings(comparable, input.query, input.terms ?? '', input.excluded ?? '', { ...deterministicFilters, shippingOnly: input.shippingOnly, relaxTerms: true });
        // P1/P3 near-miss rescue: deterministic substring misses that pass
        // everything else get one bounded Jev judgment each. Fail-closed:
        // any failure keeps the deterministic set.
        try {
          const rescued = await this.fuzzyRescueForSearch(fetched, {
            query: input.query, includedTerms: input.terms ?? '', excludedTerms: input.excluded ?? '', condition: input.condition,
          }, { ...deterministicFilters, shippingOnly: Boolean(input.shippingOnly) }, source);
          if (rescued.length) {
            const seen = new Set(filtered.map((listing) => `${listing.marketplace}:${listing.listingId}`));
            for (const listing of rescued) {
              const key = `${listing.marketplace}:${listing.listingId}`;
              if (!seen.has(key)) {
                seen.add(key);
                filtered.push(listing);
              }
            }
          }
        } catch {
          // Rescue is recall-only; any failure keeps the deterministic set.
        }
        // Same AI relevance gate as watch scans (Jev live, DeepSeek legacy),
        // but the search form can opt out per search (aiRelevance: false) to
        // skip the Jev round trips entirely. Fail-open, so unknown/
        // not-configured keeps the deterministic set. An unexpected throw
        // (e.g. cache/transaction failure) must not turn a good deterministic
        // result into a user-visible search error.
        let relevant = filtered;
        let relevanceNote = '';
        try {
          const relevance = await this.filterListingsByAiRelevance(filtered, {
            query: input.query,
            includedTerms: input.terms ?? '',
            excludedTerms: input.excluded ?? '',
          }, undefined, input.aiRelevance !== false);
          relevant = relevance.listings;
          relevanceNote = relevance.notConfigured
            ? ''
            : relevance.unknown ? ` · ${relevance.unknown} AI checks unknown`
              : relevance.excluded ? ` · ${relevance.excluded} excluded by AI` : '';
        } catch (error) {
          this.log('error', 'watch', `Manual search AI relevance fallback to deterministic: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500));
        }
        let capped = relevant.slice(0, MANUAL_SEARCH_RESULT_CAP);
        const truncated = relevant.length > capped.length;
        // Jev checks run after relevance on the capped page only. Fail-open:
        // an unexpected throw leaves every listing unchecked, never hidden.
        const checks = input.verificationChecks ?? [];
        let checkStatus = new Map<NormalizedListing, { state: 'passed' | 'unconfirmed' | 'unchecked'; note: string }>();
        let checksNote = '';
        let hiddenByChecks = 0;
        if (checks.length) {
          try {
            const checked = await this.applySearchChecks(capped, checks);
            capped = checked.listings;
            checkStatus = checked.status;
            hiddenByChecks = checked.rejected;
            checksNote = checked.inactive ? ' · Jev checks inactive' : checked.rejected ? ` · ${checked.rejected} hidden by Jev checks` : '';
          } catch (error) {
            this.log('error', 'watch', `Manual search Jev checks skipped: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500));
          }
        }
        // One transaction for the whole batch: each upsert would otherwise be
        // its own implicit commit (an fsync per listing before WAL=NORMAL).
        this.transaction(() => {
          for (const listing of capped) this.storeManualListing(listing);
        });
        const pendingShipping = input.shippingOnly ? comparable.filter((listing) => listing.shippingAvailable === null).length : 0;
        const listings = capped.map((listing): Listing => ({
          id: `${listing.marketplace}:${listing.listingId}`, title: listing.title,
          subtitle: [listing.condition, listing.location].filter(Boolean).join(' · '), marketplace: listing.marketplace,
          price: listing.price, typical: null, belowTypical: null, observed: 'just now', observedAt: listing.observedAt,
          dealStrength: 1, dealLabel: 'Watch', image: listing.imageUrl ?? '', url: listing.url, watch: 'Manual search',
          condition: listing.condition, location: listing.location, shippingAvailable: listing.shippingAvailable ?? null, priceNegotiable: listing.priceNegotiable ?? null,
          postedAt: listing.postedAt ?? null, refreshedAt: listing.refreshedAt ?? null, promoted: listing.promoted ?? null, sellerType: listing.sellerType ?? null,
          ...(checkStatus.has(listing) ? { jevCheck: checkStatus.get(listing)!.state, jevCheckNote: checkStatus.get(listing)!.note } : {}),
        }));
        const matches = relevant.length - hiddenByChecks;
        const status: SearchSourceStatus = {
          source, status: 'ok', count: matches, pendingShipping, durationMs: Date.now() - started,
          message: matches
            ? `${matches} matches${relevanceNote}${checksNote}${truncated ? ` · showing the first ${MANUAL_SEARCH_RESULT_CAP}` : ''}`
            : 'No matching listings',
        };
        // Stream this source to the originating client so a fast marketplace is
        // visible while a slow one is still fetching. The HTTP response below
        // stays authoritative and reconciles anything the stream missed.
        this.emitSearchProgress(input.searchId, page, source, status, listings);
        return { listings, status };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Search failed';
        const status: SearchSourceStatus = { source, status: 'error', count: 0, pendingShipping: 0, durationMs: Date.now() - started, message };
        this.emitSearchProgress(input.searchId, page, source, status, []);
        return { listings: [] as Listing[], status };
      }
      });
      const results = await Promise.all(tasks);
      const unique = new Map<string, Listing>();
      for (const listing of results.flatMap((result) => result.listings)) unique.set(listing.id, listing);
      return { listings: [...unique.values()].sort((a, b) => a.price - b.price), sources: results.map((result) => result.status) };
    } finally {
      this.activeManualSearches -= 1;
    }
  }

  private marketWatchVersion(row: WatchRow) {
    const version = row.active_version_id
      ? this.stmt('SELECT * FROM market_watch_versions WHERE id = ?').get(row.active_version_id) as WatchRow | undefined
      : undefined;
    return version ?? {
      id: `${row.id}:legacy`, market_watch_id: row.id, query: row.query, included_terms: row.included_terms ?? '', excluded_terms: row.excluded_terms ?? '', location: row.location ?? 'Polska', condition: row.condition ?? 'Any', sources_json: row.sources_json, min_price_pln: row.min_price_pln, max_price_pln: row.max_price_pln, shipping_only: row.shipping_only, typo_variants: row.typo_variants, olx_category_json: row.olx_category_json ?? null,
    };
  }

  private ensureMarketWatchVersion(row: WatchRow) {
    if (row.active_version_id) return this.marketWatchVersion(row);
    const versionId = `${row.id}:v1`;
    const now = nowIso();
    this.transaction(() => {
      this.stmt('INSERT OR IGNORE INTO market_watch_versions (id, market_watch_id, query, included_terms, excluded_terms, location, condition, sources_json, min_price_pln, max_price_pln, shipping_only, typo_variants, olx_category_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(versionId, row.id, row.query, row.included_terms ?? '', row.excluded_terms ?? '', row.location ?? 'Polska', row.condition ?? 'Any', row.sources_json, row.min_price_pln, row.max_price_pln, row.shipping_only ? 1 : 0, row.typo_variants ? 1 : 0, row.olx_category_json ?? null, now);
      this.stmt("UPDATE market_listings SET version_id = ? WHERE market_watch_id = ? AND version_id IS NULL AND status <> 'superseded'").run(versionId, row.id);
      this.stmt('UPDATE market_price_observations SET version_id = ? WHERE market_listing_id IN (SELECT id FROM market_listings WHERE market_watch_id = ?) AND version_id IS NULL').run(versionId, row.id);
      this.stmt('UPDATE market_watches SET active_version_id = ? WHERE id = ? AND active_version_id IS NULL').run(versionId, row.id);
    });
    const refreshed = this.stmt('SELECT * FROM market_watches WHERE id = ?').get(row.id) as WatchRow;
    return this.marketWatchVersion(refreshed);
  }

  marketResearch(options: { page?: number; pageSize?: number; watchId?: string; status?: 'active' | 'ended' | 'superseded' } = {}): MarketResearchData {
    const watchRows = this.stmt('SELECT * FROM market_watches ORDER BY created_at DESC').all() as WatchRow[];
    const activeVersionIds = watchRows.flatMap((row) => row.active_version_id ? [row.active_version_id] : []);
    const versionRows = activeVersionIds.length
      ? this.stmt(`SELECT * FROM market_watch_versions WHERE id IN (${activeVersionIds.map(() => '?').join(',')})`).all(...activeVersionIds) as WatchRow[]
      : [];
    const versionsById = new Map(versionRows.map((version) => [version.id, version]));
    const versionsByWatch = new Map(watchRows.map((row) => [row.id, versionsById.get(row.active_version_id ?? '') ?? {
      id: `${row.id}:legacy`, market_watch_id: row.id, query: row.query, included_terms: row.included_terms ?? '', excluded_terms: row.excluded_terms ?? '', location: row.location ?? 'Polska', condition: row.condition ?? 'Any', sources_json: row.sources_json, min_price_pln: row.min_price_pln, max_price_pln: row.max_price_pln, shipping_only: row.shipping_only, typo_variants: row.typo_variants,
    }]));
    const versionFilter = '(ml.version_id = mw.active_version_id OR (mw.active_version_id IS NULL AND ml.version_id IS NULL))';
    const watchStats = this.stmt(`SELECT ml.market_watch_id,
        COUNT(*) AS total,
        SUM(CASE WHEN ml.status = 'active' THEN 1 ELSE 0 END) AS active,
        SUM(CASE WHEN ml.status = 'ended' THEN 1 ELSE 0 END) AS ended
      FROM market_listings ml
      JOIN market_watches mw ON mw.id = ml.market_watch_id
      WHERE ml.status IN ('active', 'ended') AND ${versionFilter}
      GROUP BY ml.market_watch_id`).all() as Array<{ market_watch_id: string; total: number; active: number | null; ended: number | null }>;
    const statsByWatch = new Map(watchStats.map((stats) => [stats.market_watch_id, stats]));
    const endedPriceRows = this.stmt(`SELECT ml.market_watch_id, ml.last_price_pln
      FROM market_listings ml
      JOIN market_watches mw ON mw.id = ml.market_watch_id
      WHERE ml.status = 'ended' AND ml.last_price_pln > 0 AND ${versionFilter}`).all() as Array<{ market_watch_id: string; last_price_pln: number }>;
    const endedPricesByWatch = new Map<string, number[]>();
    const aggregatePrices: number[] = [];
    for (const item of endedPriceRows) {
      const price = Number(item.last_price_pln);
      const prices = endedPricesByWatch.get(item.market_watch_id) ?? [];
      prices.push(price);
      endedPricesByWatch.set(item.market_watch_id, prices);
      if (!options.watchId || options.watchId === item.market_watch_id) aggregatePrices.push(price);
    }
    const bandComputedAt = nowIso();
    const endedSampleRows = this.endedSaleBandRows(null);
    const bandSamplesByWatch = new Map<string, MarketBandSample[]>();
    const allBandSamples: MarketBandSample[] = [];
    for (const item of endedSampleRows) {
      const sample: MarketBandSample = { price: Number(item.last_price_pln), lastSeenAt: String(item.last_seen_at), endedAt: String(item.ended_at), endedReason: item.ended_reason };
      const samples = bandSamplesByWatch.get(item.market_watch_id) ?? [];
      samples.push(sample);
      bandSamplesByWatch.set(item.market_watch_id, samples);
      allBandSamples.push(sample);
    }
    const watches = watchRows.map((row): MarketWatch => {
      const version = versionsByWatch.get(row.id)!;
      const counts = statsByWatch.get(row.id) ?? { total: 0, active: null, ended: null };
      const endedPrices = endedPricesByWatch.get(row.id) ?? [];
      return {
        id: row.id, name: row.name, query: version.query, terms: version.included_terms ?? '', excluded: version.excluded_terms ?? '', location: NO_LOCATION_FILTER, condition: version.condition ?? 'Any', sources: parseJson<Marketplace[]>(version.sources_json, []),
        intervalHours: Number(row.interval_hours), minPrice: version.min_price_pln === null || version.min_price_pln === undefined ? null : Number(version.min_price_pln), maxPrice: version.max_price_pln === null || version.max_price_pln === undefined ? null : Number(version.max_price_pln), shippingOnly: Boolean(version.shipping_only), typoVariants: Boolean(version.typo_variants), olxCategory: olxCategoryFromJson(version.olx_category_json), enabled: Boolean(row.enabled), nextScan: Boolean(row.enabled) ? relativeTimeFuture(row.next_scan_at) : 'Paused',
        lastScan: relativeTime(row.last_scan_at), totalListings: Number(counts.total ?? 0), activeListings: Number(counts.active ?? 0), endedListings: Number(counts.ended ?? 0),
        estimatedMedianPrice: endedPrices.length ? median(endedPrices) : null,
        saleBand: computeSaleBand(bandSamplesByWatch.get(row.id) ?? [], SALE_BAND_WINDOW_DAYS, bandComputedAt),
      };
    });
    // The aggregate reuses the per-watch fetch above — the same ended rows,
    // optionally scoped to the requested watch — instead of loading them twice.
    const aggregateCounts = this.stmt(`SELECT SUM(CASE WHEN ml.status = 'active' THEN 1 ELSE 0 END) AS active, SUM(CASE WHEN ml.status = 'ended' THEN 1 ELSE 0 END) AS ended FROM market_listings ml JOIN market_watches mw ON mw.id = ml.market_watch_id WHERE ml.status IN ('active', 'ended') AND ${versionFilter}${options.watchId ? ' AND ml.market_watch_id = ?' : ''}`).get(...(options.watchId ? [options.watchId] : [])) as { active?: number; ended?: number };

    const page = Math.max(1, Math.floor(options.page ?? 1));
    const pageSize = Math.max(1, Math.min(400, Math.floor(options.pageSize ?? 100)));
    const predicates = [versionFilter];
    const params: unknown[] = [];
    if (options.watchId) { predicates.push('ml.market_watch_id = ?'); params.push(options.watchId); }
    if (options.status === 'superseded') {
      predicates[0] = '((mw.active_version_id IS NOT NULL AND ml.version_id IS NOT mw.active_version_id) OR (mw.active_version_id IS NULL AND ml.version_id IS NOT NULL))';
    } else if (options.status) {
      predicates.push('ml.status = ?'); params.push(options.status);
    }
    const total = Number((this.stmt(`SELECT COUNT(*) AS count FROM market_listings ml JOIN market_watches mw ON mw.id = ml.market_watch_id WHERE ${predicates.join(' AND ')}`).get(...params) as { count?: number }).count ?? 0);
    const rows = this.stmt(`SELECT ml.*, mw.name AS watch_name,
      (SELECT COUNT(*) FROM market_price_observations mpo WHERE mpo.market_listing_id = ml.id AND (mpo.version_id = ml.version_id OR (ml.version_id IS NULL AND mpo.version_id IS NULL))) AS observations
      FROM market_listings ml JOIN market_watches mw ON mw.id = ml.market_watch_id
      WHERE ${predicates.join(' AND ')}
      ORDER BY CASE ml.status WHEN 'ended' THEN 0 WHEN 'active' THEN 1 ELSE 2 END, COALESCE(ml.ended_at, ml.last_seen_at) DESC
      LIMIT ? OFFSET ?`).all(...params, pageSize, (page - 1) * pageSize) as Array<Record<string, any>>;
    const listings = rows.map((row): MarketTrackedListing => ({
      id: Number(row.id), marketWatchId: row.market_watch_id, watchName: row.watch_name, marketplace: row.marketplace, listingId: row.listing_id,
      title: row.title, url: row.url, image: row.image_url ?? '', firstPrice: Number(row.first_price_pln), lastPrice: Number(row.last_price_pln), lowestPrice: Number(row.lowest_price_pln),
      priceChangePercent: Number(row.first_price_pln) > 0 ? ((Number(row.last_price_pln) - Number(row.first_price_pln)) / Number(row.first_price_pln)) * 100 : 0,
      firstSeenAt: row.first_seen_at, lastSeenAt: row.last_seen_at, endedAt: row.ended_at, status: row.status, availabilityStatus: row.availability_status ?? null, endedReason: row.ended_reason ?? null, missingScans: Number(row.missing_scans), observations: Number(row.observations),
      snapshotStatus: row.snapshot_status ?? null,
    }));
    return {
      watches,
      listings,
      aggregates: { overallMedianPrice: aggregatePrices.length ? median(aggregatePrices) : null, endedCount: Number(aggregateCounts?.ended ?? 0), activeCount: Number(aggregateCounts?.active ?? 0), saleBand: computeSaleBand(options.watchId ? bandSamplesByWatch.get(options.watchId) ?? [] : allBandSamples, SALE_BAND_WINDOW_DAYS, bandComputedAt) },
      pagination: { page, pageSize, total, hasNext: page * pageSize < total },
    };
  }

  /** Ended research listings (active series only) that may feed probable-sale bands. */
  private endedSaleBandRows(watchId: string | null) {
    const versionFilter = '(ml.version_id = mw.active_version_id OR (mw.active_version_id IS NULL AND ml.version_id IS NULL))';
    return this.stmt(`SELECT ml.market_watch_id, ml.last_price_pln, ml.last_seen_at, ml.ended_at, ml.ended_reason
      FROM market_listings ml
      JOIN market_watches mw ON mw.id = ml.market_watch_id
      WHERE ml.status = 'ended' AND ml.last_price_pln > 0 AND ml.ended_at IS NOT NULL AND ${versionFilter}${watchId ? ' AND ml.market_watch_id = ?' : ''}`)
      .all(...(watchId ? [watchId] : [])) as Array<{ market_watch_id: string; last_price_pln: number; last_seen_at: string; ended_at: string; ended_reason: string | null }>;
  }

  private toBandSample(row: { last_price_pln: number; last_seen_at: string; ended_at: string; ended_reason: string | null }): MarketBandSample {
    return { price: Number(row.last_price_pln), lastSeenAt: String(row.last_seen_at), endedAt: String(row.ended_at), endedReason: row.ended_reason };
  }

  /** Probable-sale median of a reference research series, or null while the band is too thin. */
  private referenceBandMedian(marketWatchId: string): number | null {
    const samples = this.endedSaleBandRows(marketWatchId).map((item) => this.toBandSample(item));
    const band = computeSaleBand(samples, SALE_BAND_WINDOW_DAYS, nowIso());
    return band.eligibleCount >= MIN_BAND_SAMPLES && band.median !== null ? band.median : null;
  }

  /**
   * Daily active-market trend for one research series, with the current
   * probable-sale band median as a reference line.
   */
  marketWatchTrend(id: string, rangeDays = 90): MarketWatchTrend {
    const row = this.stmt('SELECT id, name FROM market_watches WHERE id = ?').get(id) as WatchRow | undefined;
    if (!row) throw new ServiceError('Market watch not found', 404);
    const days = Math.max(7, Math.min(180, Math.floor(rangeDays)));
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60_000).toISOString();
    const rawRows = this.stmt(`SELECT mpo.market_listing_id, mpo.price_pln, mpo.observed_at
      FROM market_price_observations mpo
      JOIN market_listings ml ON ml.id = mpo.market_listing_id
      WHERE ml.market_watch_id = ?
        AND mpo.observed_at >= ?
        AND (ml.version_id = ? OR (? IS NULL AND ml.version_id IS NULL))
      ORDER BY mpo.observed_at ASC`).all(id, cutoff, row.active_version_id ?? null, row.active_version_id ?? null) as Array<{ market_listing_id: number; price_pln: number; observed_at: string }>;
    const observations: MarketTrendObservation[] = rawRows.map((item) => ({
      marketListingId: Number(item.market_listing_id),
      price: Number(item.price_pln),
      observedAt: String(item.observed_at),
    }));
    const points = bucketDailyObservations(observations, days, nowIso());
    const band = computeSaleBand(this.endedSaleBandRows(id).map((item) => this.toBandSample(item)), SALE_BAND_WINDOW_DAYS, nowIso());
    return {
      marketWatchId: id,
      watchName: String(row.name),
      rangeDays: days,
      firstObservedAt: observations[0]?.observedAt ?? null,
      lastObservedAt: observations[observations.length - 1]?.observedAt ?? null,
      totalObservations: observations.length,
      probableSaleMedian: band.median,
      points,
    };
  }

  /** Asking-price history of one preserved research listing (oldest first). */
  marketListingHistory(marketListingId: number): PriceHistoryPoint[] {
    const rows = this.stmt('SELECT price_pln, observed_at FROM market_price_observations WHERE market_listing_id = ? ORDER BY observed_at ASC, id ASC LIMIT 120').all(marketListingId) as Array<{ price_pln: number; observed_at: string }>;
    return rows.map((point) => ({ price: Number(point.price_pln), observedAt: point.observed_at }));
  }

  queueMarketScan(id: string) {
    const row = this.stmt('SELECT * FROM market_watches WHERE id = ? AND enabled = 1').get(id) as WatchRow | undefined;
    if (!row) throw new ServiceError('Enabled market watch not found', 404);
    this.background(`Research scan ${row.name}`, this.runMarketWatch(row));
    return { queued: true, message: `Queued ${row.name}` };
  }

  createMarketWatch(input: {
    id: string;
    name: string;
    query: string;
    terms: string;
    excluded: string;
    condition: string;
    sources: Marketplace[];
    intervalHours: number;
    minPrice: number | null;
    maxPrice: number | null;
    shippingOnly: boolean;
    typoVariants: boolean;
    olxCategory?: OlxCategory | null;
  }) {
    const now = nowIso();
    const versionId = `${input.id}:v1`;
    const olxCategory = olxCategoryToJson(input.olxCategory);
    this.transaction(() => {
      this.stmt('INSERT INTO market_watches (id, name, query, included_terms, excluded_terms, location, condition, sources_json, interval_hours, min_price_pln, max_price_pln, shipping_only, typo_variants, olx_category_json, enabled, active_version_id, next_scan_at, last_scan_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, NULL, ?, ?)').run(input.id, input.name, input.query, input.terms, input.excluded, NO_LOCATION_FILTER, input.condition, JSON.stringify(input.sources), input.intervalHours, input.minPrice, input.maxPrice, input.shippingOnly ? 1 : 0, input.typoVariants ? 1 : 0, olxCategory, versionId, now, now, now);
      this.stmt('INSERT INTO market_watch_versions (id, market_watch_id, query, included_terms, excluded_terms, location, condition, sources_json, min_price_pln, max_price_pln, shipping_only, typo_variants, olx_category_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(versionId, input.id, input.query, input.terms, input.excluded, NO_LOCATION_FILTER, input.condition, JSON.stringify(input.sources), input.minPrice, input.maxPrice, input.shippingOnly ? 1 : 0, input.typoVariants ? 1 : 0, olxCategory, now);
    });
    return this.marketResearch().watches.find((watch) => watch.id === input.id)!;
  }

  updateMarketWatch(id: string, patch: {
    name?: string;
    query?: string;
    enabled?: boolean;
    intervalHours?: number;
    terms?: string;
    excluded?: string;
    condition?: string;
    sources?: Marketplace[];
    minPrice?: number | null;
    maxPrice?: number | null;
    shippingOnly?: boolean;
    typoVariants?: boolean;
    olxCategory?: OlxCategory | null;
  }) {
    const row = this.stmt('SELECT * FROM market_watches WHERE id = ?').get(id) as WatchRow | undefined;
    if (!row) throw new ServiceError('Market watch not found', 404);
    const currentVersion = this.marketWatchVersion(row);
    const criteriaChanged = patch.query !== undefined || patch.terms !== undefined || patch.excluded !== undefined || patch.condition !== undefined || patch.sources !== undefined || patch.minPrice !== undefined || patch.maxPrice !== undefined || patch.shippingOnly !== undefined || patch.typoVariants !== undefined || patch.olxCategory !== undefined;
    const now = nowIso();
    this.transaction(() => {
      const directFields: string[] = [];
      const directValues: unknown[] = [];
      if (patch.name !== undefined) { directFields.push('name = ?'); directValues.push(patch.name); }
      if (patch.enabled !== undefined) { directFields.push('enabled = ?'); directValues.push(patch.enabled ? 1 : 0); }
      if (patch.intervalHours !== undefined) { directFields.push('interval_hours = ?'); directValues.push(patch.intervalHours); }

      if (criteriaChanged) {
        const next = {
          query: patch.query ?? String(currentVersion.query),
          terms: patch.terms ?? String(currentVersion.included_terms ?? ''),
          excluded: patch.excluded ?? String(currentVersion.excluded_terms ?? ''),
          condition: patch.condition ?? String(currentVersion.condition ?? 'Any'),
          sources: patch.sources ?? parseJson<Marketplace[]>(currentVersion.sources_json, []),
          minPrice: patch.minPrice === undefined ? (currentVersion.min_price_pln === null || currentVersion.min_price_pln === undefined ? null : Number(currentVersion.min_price_pln)) : patch.minPrice,
          maxPrice: patch.maxPrice === undefined ? (currentVersion.max_price_pln === null || currentVersion.max_price_pln === undefined ? null : Number(currentVersion.max_price_pln)) : patch.maxPrice,
          shippingOnly: patch.shippingOnly === undefined ? Boolean(currentVersion.shipping_only) : patch.shippingOnly,
          typoVariants: patch.typoVariants === undefined ? Boolean(currentVersion.typo_variants) : patch.typoVariants,
          olxCategory: patch.olxCategory === undefined ? olxCategoryToJson(olxCategoryFromJson(currentVersion.olx_category_json)) : olxCategoryToJson(patch.olxCategory),
        };
        const changed = next.query !== currentVersion.query || next.terms !== (currentVersion.included_terms ?? '') || next.excluded !== (currentVersion.excluded_terms ?? '') || next.condition !== (currentVersion.condition ?? 'Any') || JSON.stringify(next.sources) !== String(currentVersion.sources_json) || next.minPrice !== (currentVersion.min_price_pln ?? null) || next.maxPrice !== (currentVersion.max_price_pln ?? null) || next.shippingOnly !== Boolean(currentVersion.shipping_only) || next.typoVariants !== Boolean(currentVersion.typo_variants) || olxCategoryFromJson(next.olxCategory)?.id !== olxCategoryFromJson(currentVersion.olx_category_json)?.id;
        if (changed) {
          const versionId = `${id}:v${Date.now()}-${randomBytes(3).toString('hex')}`;
          if (row.active_version_id) this.stmt('UPDATE market_watch_versions SET closed_at = ? WHERE id = ? AND closed_at IS NULL').run(now, row.active_version_id);
          this.stmt('INSERT INTO market_watch_versions (id, market_watch_id, query, included_terms, excluded_terms, location, condition, sources_json, min_price_pln, max_price_pln, shipping_only, typo_variants, olx_category_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(versionId, id, next.query, next.terms, next.excluded, NO_LOCATION_FILTER, next.condition, JSON.stringify(next.sources), next.minPrice, next.maxPrice, next.shippingOnly ? 1 : 0, next.typoVariants ? 1 : 0, next.olxCategory, now);
          this.stmt("UPDATE market_listings SET status = 'superseded', ended_at = COALESCE(ended_at, ?), ended_reason = COALESCE(ended_reason, 'Research criteria changed') WHERE market_watch_id = ? AND (version_id = ? OR version_id IS NULL) AND status <> 'superseded'").run(now, id, row.active_version_id ?? currentVersion.id);
          directFields.push('query = ?', 'included_terms = ?', 'excluded_terms = ?', 'location = ?', 'condition = ?', 'sources_json = ?', 'min_price_pln = ?', 'max_price_pln = ?', 'shipping_only = ?', 'typo_variants = ?', 'olx_category_json = ?', 'active_version_id = ?', 'next_scan_at = ?');
          directValues.push(next.query, next.terms, next.excluded, NO_LOCATION_FILTER, next.condition, JSON.stringify(next.sources), next.minPrice, next.maxPrice, next.shippingOnly ? 1 : 0, next.typoVariants ? 1 : 0, next.olxCategory, versionId, now);
        }
      }
      if (!directFields.length) throw new ServiceError('No supported fields', 400);
      directValues.push(now, id);
      this.stmt(`UPDATE market_watches SET ${directFields.join(', ')}, updated_at = ? WHERE id = ?`).run(...(directValues as any[]));
    });
    this.emit('market-watch', { refresh: true, id });
    return { ok: true } as const;
  }

  deleteMarketWatch(id: string) {
    const result = this.stmt('DELETE FROM market_watches WHERE id = ?').run(id);
    if (!result.changes) throw new ServiceError('Market watch not found', 404);
  }

  private async runMarketWatch(row: WatchRow) {
    const runningKey = `market:${row.id}`;
    if (this.running.has(runningKey)) return;
    this.running.add(runningKey);
    try {
      const sources = parseJson<Marketplace[]>(row.sources_json, []);
      const version = this.ensureMarketWatchVersion(row);
      let latestBackoffUntil: string | null = null;
      // Every source's createScan runs before the first await and the running
      // set excludes a concurrent run, so all sources see the same ordinal.
      let ordinal: number | undefined;
      const scanOrdinal = () => ordinal ??= this.scanOrdinal(String(row.id), 'research');
      await Promise.all(sources.map(async (source) => {
        const paths: string[] = [];
        const onPath: ConnectorPathReporter = (path) => { if (!paths.includes(path)) paths.push(path); };
        const started = nowIso();
        const backoffUntil = this.activeConnectorBackoff(source);
        if (backoffUntil && (!latestBackoffUntil || Date.parse(backoffUntil) > Date.parse(latestBackoffUntil))) latestBackoffUntil = backoffUntil;
        const runId = this.recordRun(source, backoffUntil ? 'skipped' : 'running', backoffUntil ? `Skipped research for ${row.name}; connector backoff is active` : `Researching ${row.name}`, started, backoffUntil ? started : null);
        const scanId = this.createScan(String(row.id), 'research', source, started);
        if (backoffUntil) {
          this.stmt("UPDATE scans SET status = 'skipped', completed_at = ?, error = ? WHERE id = ?").run(started, `Connector backoff active until ${backoffUntil}`, scanId);
          this.log('info', 'research', `${row.name} · ${source}: skipped (connector backoff until ${backoffUntil})`);
          return;
        }
        try {
          const adapter = this.createConnectorAdapter(source, onPath);
          const searchFilters = { minPrice: row.min_price_pln, maxPrice: row.max_price_pln, condition: row.condition, shippingOnly: Boolean(row.shipping_only), olxCategoryId: olxCategoryFromJson(row.olx_category_json)?.id ?? null, sort: 'newest' as const };
          const mainListings = await this.fetchSearchPages(source, row.query, searchFilters, onPath);
          // Typo variants come from the immutable criteria version, like every
          // other research criterion, and append one page per variant query.
          const variantQueries = version.typo_variants
            ? pickVariantBatch(typoVariants(String(version.query ?? row.query)), scanOrdinal(), TYPO_VARIANTS_PER_SCAN)
            : [];
          const variantFetches: string[] = [];
          for (const variantQuery of variantQueries) {
            variantFetches.push(`"${variantQuery}"`);
            mainListings.push(...await this.fetchSearchPages(source, variantQuery, searchFilters, onPath));
          }
          const fetched = [...new Map(mainListings.map((listing) => [`${listing.marketplace}:${listing.listingId}`, listing])).values()];
          this.log('info', 'research', `${row.name} · ${source}: query-search${variantFetches.length ? ` + typo-variants (${variantFetches.join(', ')})` : ''} → ${paths.join(' → ') || 'no fetch'} · fetched=${fetched.length}`);
          const filters = { minPrice: row.min_price_pln, maxPrice: row.max_price_pln, condition: row.condition, shippingOnly: false };
          const comparable = filterListings(fetched, row.query, row.included_terms ?? '', row.excluded_terms ?? '', filters);
          if (row.shipping_only) await this.enrichShipping(comparable, source);
          const filtered = filterListings(comparable, row.query, row.included_terms ?? '', row.excluded_terms ?? '', { ...filters, shippingOnly: Boolean(row.shipping_only) });
          const observedAt = nowIso();
          const seen = new Set(filtered.map((listing) => listing.listingId));
          const active = this.stmt("SELECT id, listing_id, url, missing_scans FROM market_listings WHERE market_watch_id = ? AND version_id = ? AND marketplace = ? AND status = 'active'").all(row.id, version.id, source) as Array<{ id: number; listing_id: string; url: string; missing_scans: number }>;
          const missing = active.filter((listing) => !seen.has(listing.listing_id));
          const deferredMissing = Math.max(0, missing.length - MAX_RESEARCH_DETAIL_CHECKS);
          const verifiedMissing: Array<{ listing: typeof missing[number]; availability: ListingAvailability; refreshed?: NormalizedListing }> = [];
          for (let offset = 0; offset < Math.min(missing.length, MAX_RESEARCH_DETAIL_CHECKS); offset += 2) {
            const batch = await Promise.all(missing.slice(offset, Math.min(offset + 2, MAX_RESEARCH_DETAIL_CHECKS)).map(async (candidate) => {
              const detail = await adapter.fetchDetail(candidate.url, { listingId: candidate.listing_id });
              return {
                listing: candidate,
                availability: detail.availability,
                refreshed: detail.listing?.listingId === candidate.listing_id && detail.listing.price > 0 ? detail.listing : undefined,
              };
            }));
            verifiedMissing.push(...batch);
          }
          let discarded = false;
          this.transaction(() => {
            const current = this.stmt('SELECT active_version_id FROM market_watches WHERE id = ?').get(row.id) as { active_version_id?: string | null } | undefined;
            if (!current || current.active_version_id !== version.id) {
              this.stmt("UPDATE scans SET status = 'superseded', completed_at = ?, error = ? WHERE id = ?").run(nowIso(), 'Research criteria changed while this scan was running', scanId);
              discarded = true;
              return;
            }
            const newListingIds: number[] = [];
            for (const listing of filtered) {
              const stored = this.storeMarketListing(row.id, version.id, listing, observedAt, scanId);
              if (stored.created) newListingIds.push(stored.id);
            }
            if (newListingIds.length) {
              this.stmt(`UPDATE market_listings SET snapshot_status = 'pending'
                WHERE id IN (${newListingIds.map(() => '?').join(',')}) AND snapshot_status IS NULL`).run(...newListingIds);
            }
            for (const { listing, availability, refreshed } of verifiedMissing) {
              if (availability.status === 'live') {
                if (refreshed) {
                  this.stmt("UPDATE market_listings SET title = ?, url = ?, image_url = COALESCE(?, image_url), last_price_pln = ?, lowest_price_pln = MIN(lowest_price_pln, ?), missing_scans = 0, status = 'active', availability_status = 'live', ended_reason = NULL, last_verified_at = ?, ended_at = NULL WHERE id = ?").run(refreshed.title, refreshed.url, refreshed.imageUrl ?? null, refreshed.price, refreshed.price, observedAt, listing.id);
                  this.stmt('INSERT INTO market_price_observations (market_listing_id, version_id, scan_id, price_pln, observed_at) VALUES (?, ?, ?, ?, ?)').run(listing.id, version.id, scanId, refreshed.price, observedAt);
                } else {
                  this.stmt("UPDATE market_listings SET missing_scans = 0, status = 'active', availability_status = 'live', ended_reason = NULL, last_verified_at = ?, ended_at = NULL WHERE id = ?").run(observedAt, listing.id);
                }
              } else if (availability.status === 'terminal') {
                const next = marketStatusAfterMiss(Number(listing.missing_scans));
                this.stmt("UPDATE market_listings SET missing_scans = ?, status = ?, ended_at = CASE WHEN ? = 'ended' THEN COALESCE(ended_at, ?) ELSE ended_at END, availability_status = 'terminal', ended_reason = ?, last_verified_at = ? WHERE id = ?").run(next.missingScans, next.status, next.status, observedAt, availability.reason, observedAt, listing.id);
              } else {
                this.stmt("UPDATE market_listings SET availability_status = 'unknown', last_verified_at = ? WHERE id = ?").run(observedAt, listing.id);
              }
            }
            this.completeScan(scanId, `${filtered.length} research listings saved${deferredMissing ? ` · ${deferredMissing} detail checks deferred` : ''}`);
          });
          if (discarded) {
            this.finishRun(runId, 'skipped', 'Discarded results from a superseded research definition');
            return;
          }
          this.finishRun(runId, 'ok', `${filtered.length} research listings saved${deferredMissing ? ` · ${deferredMissing} detail checks deferred` : ''}`);
          await this.capturePendingMarketSnapshots(String(row.id), source);
        } catch (error) {
          this.failScan(scanId, error);
          const message = error instanceof Error ? error.message : 'Research connector failed';
          this.log('error', 'research', `${row.name} · ${source}: failed via ${paths.join(' → ') || 'unstarted path'} — ${message}`);
          this.finishFailedRun(runId, source, error, message);
        }
      }));
      const finished = nowIso();
      const scheduled = new Date(Date.now() + Math.max(6, Number(row.interval_hours)) * 3_600_000).toISOString();
      const next = latestBackoffUntil && Date.parse(latestBackoffUntil) > Date.parse(scheduled) ? latestBackoffUntil : scheduled;
      this.stmt('UPDATE market_watches SET next_scan_at = ?, last_scan_at = ?, updated_at = ? WHERE id = ? AND active_version_id = ?').run(next, finished, finished, row.id, version.id);
      this.emit('market-watch', { refresh: true, id: row.id });
    } finally { this.running.delete(runningKey); }
  }

  private storeMarketListing(watchId: string, versionId: string, listing: NormalizedListing, observedAt: string, scanId: number): { id: number; created: boolean } {
    const existing = this.stmt('SELECT id FROM market_listings WHERE market_watch_id = ? AND version_id = ? AND marketplace = ? AND listing_id = ?').get(watchId, versionId, listing.marketplace, listing.listingId) as { id: number } | undefined;
    this.stmt(`INSERT INTO market_listings (market_watch_id, version_id, marketplace, listing_id, title, url, image_url, first_price_pln, last_price_pln, lowest_price_pln, first_seen_at, last_seen_at, status, missing_scans, availability_status, ended_reason, last_verified_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 0, 'live', NULL, ?)
      ON CONFLICT(market_watch_id, version_id, marketplace, listing_id) DO UPDATE SET title = excluded.title, url = excluded.url, image_url = COALESCE(excluded.image_url, market_listings.image_url), last_price_pln = excluded.last_price_pln, lowest_price_pln = MIN(market_listings.lowest_price_pln, excluded.last_price_pln), last_seen_at = excluded.last_seen_at, status = 'active', missing_scans = 0, ended_at = NULL, availability_status = 'live', ended_reason = NULL, last_verified_at = excluded.last_verified_at`).run(watchId, versionId, listing.marketplace, listing.listingId, listing.title, listing.url, listing.imageUrl ?? null, listing.price, listing.price, listing.price, observedAt, observedAt, observedAt);
    const stored = this.stmt('SELECT id FROM market_listings WHERE market_watch_id = ? AND version_id = ? AND marketplace = ? AND listing_id = ?').get(watchId, versionId, listing.marketplace, listing.listingId) as { id: number };
    this.stmt('INSERT INTO market_price_observations (market_listing_id, version_id, scan_id, price_pln, observed_at) VALUES (?, ?, ?, ?, ?)').run(stored.id, versionId, scanId, listing.price, observedAt);
    return { id: Number(stored.id), created: !existing };
  }

  /**
   * Preserves research listings before their marketplace page disappears:
   * the description plus downloaded gallery images are stored locally so the
   * listing stays reviewable after it is sold or removed.
   */
  private async capturePendingMarketSnapshots(watchId: string, marketplace: Marketplace) {
    try {
      const due = this.stmt(`SELECT * FROM market_listings
        WHERE market_watch_id = ? AND marketplace = ? AND status IN ('active', 'ended')
          AND snapshot_status IN ('pending', 'failed') AND snapshot_attempts < ?
        ORDER BY COALESCE(ended_at, first_seen_at) ASC, id ASC
        LIMIT ?`).all(watchId, marketplace, SNAPSHOT_MAX_ATTEMPTS, SNAPSHOT_CAPTURES_PER_SCAN) as Array<Record<string, any>>;
      for (let offset = 0; offset < due.length; offset += 2) {
        await Promise.all(due.slice(offset, offset + 2).map(async (listing) => {
          const outcome = await this.captureMarketListingSnapshot(listing, 'auto');
          this.log(outcome.ok ? 'info' : 'error', 'research', `${marketplace} · ${listing.title}: ${outcome.message}`);
        }));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Snapshot capture queue failed';
      this.log('error', 'research', `${marketplace}: snapshot capture failed — ${message.slice(0, 240)}`);
    }
  }

  /** Never throws; callers rely on the outcome message for logging and UI feedback. */
  private async captureMarketListingSnapshot(listing: Record<string, any>, source: 'auto' | 'manual'): Promise<{ ok: boolean; message: string; snapshotId?: number }> {
    const marketplace = listing.marketplace as Marketplace;
    try {
      const html = await this.fetchPublicPage(String(listing.url), marketplace);
      const description = parseListingDescription(html, marketplace);
      const imageUrls = parseListingImageUrls(html, marketplace, SNAPSHOT_MAX_IMAGES * 4).slice(0, SNAPSHOT_MAX_IMAGES);
      const images: Array<{ sourceUrl: string; mime: string; data: Buffer }> = [];
      for (let offset = 0; offset < imageUrls.length && images.length < SNAPSHOT_MAX_IMAGES; offset += 3) {
        const batch = await Promise.all(imageUrls.slice(offset, offset + 3).map(async (url) => {
          try {
            const image = await this.fetchSnapshotImage(url, String(listing.url));
            return image ? { sourceUrl: url, mime: image.mime, data: image.data } : null;
          } catch { return null; }
        }));
        for (const item of batch) if (item && images.length < SNAPSHOT_MAX_IMAGES) images.push(item);
      }
      if (!description && !images.length) {
        this.markSnapshotFailure(Number(listing.id), source === 'manual' ? 0 : 1);
        return { ok: false, message: 'detail page exposed no usable description or images' };
      }

      const stateHash = createHash('sha256').update(JSON.stringify({
        title: listing.title,
        price: Number(listing.last_price_pln),
        condition: listing.condition ?? null,
        location: listing.location ?? null,
        url: listing.url,
        description,
        images: images.map((image) => image.sourceUrl),
      })).digest('hex');
      const capturedAt = nowIso();
      let snapshotId: number;
      this.transaction(() => {
        this.stmt(`INSERT INTO market_listing_snapshots (
            market_listing_id, marketplace, external_listing_id, title, price_pln, url,
            condition, location, description, state_hash, image_count, source, captured_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(market_listing_id, state_hash) DO NOTHING`).run(
          Number(listing.id), marketplace, String(listing.listing_id), String(listing.title), Number(listing.last_price_pln),
          String(listing.url), listing.condition ?? null, listing.location ?? null, description, stateHash,
          images.length, source, capturedAt,
        );
        const stored = this.stmt('SELECT id FROM market_listing_snapshots WHERE market_listing_id = ? AND state_hash = ?').get(Number(listing.id), stateHash) as { id: number };
        snapshotId = Number(stored.id);
        const existingImages = this.stmt('SELECT COUNT(*) AS count FROM market_listing_snapshot_images WHERE snapshot_id = ?').get(snapshotId) as { count?: number };
        if (!Number(existingImages.count ?? 0)) {
          const insertImage = this.stmt('INSERT INTO market_listing_snapshot_images (snapshot_id, position, source_url, mime_type, byte_size, data) VALUES (?, ?, ?, ?, ?, ?)');
          images.forEach((image, index) => insertImage.run(snapshotId, index, image.sourceUrl, image.mime, image.data.byteLength, image.data));
        }
      });
      this.stmt("UPDATE market_listings SET snapshot_status = 'saved', snapshot_at = ? WHERE id = ?").run(capturedAt, Number(listing.id));
      return { ok: true, message: `preserved listing copy (description ${description ? 'saved' : 'unavailable'}, ${images.length} image${images.length === 1 ? '' : 's'})`, snapshotId: snapshotId! };
    } catch (error) {
      const message = (error instanceof Error ? error.message : 'Listing preservation failed').slice(0, 240);
      this.markSnapshotFailure(Number(listing.id), source === 'manual' ? 0 : 1);
      return { ok: false, message: `could not preserve listing — ${message}` };
    }
  }

  private markSnapshotFailure(listingId: number, attemptsToAdd: number) {
    this.stmt("UPDATE market_listings SET snapshot_status = 'failed', snapshot_attempts = snapshot_attempts + ? WHERE id = ?").run(attemptsToAdd, listingId);
  }

  private async fetchSnapshotImage(url: string, referer: string): Promise<{ mime: string; data: Buffer } | null> {
    // Follow redirects by hand so every hop stays on a marketplace image CDN;
    // fetch's automatic following would go to any host, including internal ones.
    let current = url;
    let response: Response | undefined;
    for (let hop = 0; hop <= 3; hop += 1) {
      if (!isMarketplaceImageUrl(current)) return null;
      response = await fetch(current, {
        headers: { 'user-agent': MARKETPLACE_API_USER_AGENT, accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8', referer },
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000),
      });
      if (response.status < 300 || response.status >= 400) break;
      const location = response.headers.get('location');
      discardResponse(response, 'snapshot-image');
      response = undefined;
      if (!location) return null;
      try { current = new URL(location, current).toString(); } catch { return null; }
    }
    if (!response) return null;
    if (!response.ok) { discardResponse(response, 'snapshot-image'); return null; }
    const declared = Number(response.headers.get('content-length') ?? 0);
    if (declared > SNAPSHOT_MAX_IMAGE_BYTES) { discardResponse(response, 'snapshot-image'); return null; }
    const contentType = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (!new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']).has(contentType)) { discardResponse(response, 'snapshot-image'); return null; }
    // Count bytes while streaming so a missing or false Content-Length cannot
    // make Scout buffer an arbitrarily large body.
    const chunks: Uint8Array[] = [];
    let total = 0;
    if (!response.body) return null;
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > SNAPSHOT_MAX_IMAGE_BYTES) { await reader.cancel().catch(() => {}); return null; }
      chunks.push(value);
    }
    const data = Buffer.concat(chunks);
    if (!data.byteLength) return null;
    return { mime: contentType, data };
  }

  /** The most recent preserved copy of a research listing, with image metadata (bytes come from the image endpoint). */
  marketListingSnapshot(marketListingId: number): MarketListingSnapshot | null {
    const listing = this.stmt('SELECT id FROM market_listings WHERE id = ?').get(marketListingId) as { id?: number } | undefined;
    if (!listing?.id) throw new ServiceError('Research listing not found', 404);
    const snapshot = this.stmt(`SELECT * FROM market_listing_snapshots WHERE market_listing_id = ?
      ORDER BY captured_at DESC, id DESC LIMIT 1`).get(marketListingId) as Record<string, any> | undefined;
    if (!snapshot) return null;
    const images = this.stmt('SELECT id, position, byte_size FROM market_listing_snapshot_images WHERE snapshot_id = ? ORDER BY position, id').all(Number(snapshot.id)) as Array<Record<string, any>>;
    return {
      id: Number(snapshot.id),
      marketplace: snapshot.marketplace as Marketplace,
      listingId: String(snapshot.external_listing_id),
      title: String(snapshot.title),
      price: Number(snapshot.price_pln),
      condition: snapshot.condition ?? null,
      location: snapshot.location ?? null,
      url: String(snapshot.url),
      description: snapshot.description ?? null,
      capturedAt: String(snapshot.captured_at),
      images: images.map((image) => ({ id: Number(image.id), position: Number(image.position), byteSize: Number(image.byte_size) })),
    };
  }

  marketSnapshotImage(imageId: number): { mime: string; data: Buffer } | null {
    const row = this.stmt('SELECT mime_type, data FROM market_listing_snapshot_images WHERE id = ?').get(imageId) as { mime_type?: string; data?: Uint8Array } | undefined;
    if (!row?.data) return null;
    return { mime: row.mime_type ?? 'image/jpeg', data: Buffer.from(row.data) };
  }

  /** Manual on-demand preservation, also usable for listings that already ended. */
  async captureMarketListingSnapshotNow(marketListingId: number): Promise<MarketListingSnapshot | null> {
    const listing = this.stmt('SELECT * FROM market_listings WHERE id = ?').get(marketListingId) as Record<string, any> | undefined;
    if (!listing) throw new ServiceError('Research listing not found', 404);
    const outcome = await this.captureMarketListingSnapshot(listing, 'manual');
    if (!outcome.ok) throw new ServiceError(outcome.message, 502);
    return this.marketListingSnapshot(marketListingId);
  }

  // Per-source connector_runs counts. Counting walks the whole table (~560k
  // rows at real scan cadence), so the result is kept and maintained in
  // place: recordRun (the only INSERT) adds one, the retention prune (the
  // only DELETE) drops the cache, and a commit from another connection
  // changes PRAGMA data_version, which forces a recount.
  private connectorRunCountCache: { version: number; counts: Map<string, number> } | null = null;

  private connectorRunCounts() {
    const version = Number((this.stmt('PRAGMA data_version').get() as { data_version: number }).data_version);
    if (!this.connectorRunCountCache || this.connectorRunCountCache.version !== version) {
      const counts = new Map((this.stmt('SELECT source, COUNT(*) AS count FROM connector_runs GROUP BY source').all() as Array<{ source: string; count: number }>)
        .map((row) => [String(row.source), Number(row.count)]));
      this.connectorRunCountCache = { version, counts };
    }
    return this.connectorRunCountCache.counts;
  }

  /** `withCounts: false` skips the run counts (every `requests` is 0) for callers that only read status. */
  getConnectors(withCounts = true): Connector[] {
    const webhookConfigured = Boolean(this.getSetting('discord_webhook'));
    const ntfyConfigured = Boolean(this.ntfyConfig());
    // Latest row per source comes from one indexed lookup per connector and
    // the run count from the maintained per-source counts. The previous
    // window-function query materialized every connector_runs row — three
    // full scans on every dashboard refresh and readiness probe.
    const countBySource = withCounts ? this.connectorRunCounts() : new Map<string, number>();
    const latestRun = this.stmt('SELECT * FROM connector_runs WHERE source = ? ORDER BY started_at DESC, id DESC LIMIT 1');
    const latestSuccess = this.stmt("SELECT finished_at FROM connector_runs WHERE source = ? AND status = 'ok' AND finished_at IS NOT NULL ORDER BY started_at DESC, id DESC LIMIT 1");
    const healthBySource = new Map<string, Record<string, any>>();
    for (const definition of connectorDefinitions) {
      const row = latestRun.get(definition.name) as Record<string, any> | undefined;
      if (row) healthBySource.set(definition.name, { ...row, source_count: countBySource.get(definition.name) ?? 0, last_success: (latestSuccess.get(definition.name) as { finished_at?: string } | undefined)?.finished_at ?? null });
    }
    return connectorDefinitions.map((definition) => {
      if (definition.name === 'Discord' && !webhookConfigured) return { ...definition, status: 'Idle', detail: 'Webhook not configured', lastSuccess: 'Never', requests: 0, latency: '—' };
      if (definition.name === 'ntfy' && !ntfyConfigured) return { ...definition, status: 'Idle', detail: 'ntfy not configured', lastSuccess: 'Never', requests: 0, latency: '—' };
      const last = healthBySource.get(definition.name);
      if (!last) return { ...definition, status: 'Idle', detail: definition.name === 'Discord' ? 'Webhook configured; no delivery yet' : definition.name === 'ntfy' ? 'ntfy configured; no delivery yet' : 'No connector run yet', lastSuccess: 'Never', requests: 0, latency: '—' };
      const status: Connector['status'] = last.status === 'ok' ? 'OK'
        : last.status === 'error' ? 'Degraded'
        : last.status === 'running' || last.status === 'warning' ? 'Warning'
        : last.status === 'skipped' && this.activeConnectorBackoff(definition.name) ? 'Degraded'
        : 'Idle';
      return { ...definition, status, detail: last.message || (status === 'OK' ? 'Last run completed' : 'Waiting for a run'), lastSuccess: relativeTime(last.last_success), requests: Number(last.source_count), latency: duration(last.started_at, last.finished_at) };
    });
  }

  /**
   * `top` (an integer from 1 to 50) serves the home screen widget: every
   * scalar is computed over the same 500-row feed, `listings` holds only the
   * strongest `top` rows in WidgetSnapshot.make's order, and `watches` and
   * `connectors` are empty (connector reads are skipped). Any other value
   * returns the full dashboard.
   */
  dashboard(options: { top?: number } = {}): DashboardData {
    const top = typeof options.top === 'number' && Number.isInteger(options.top) && options.top >= 1 && options.top <= 50 ? options.top : null;
    const watches = this.getWatches();
    const listings = this.getListings(watches, true);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayTime = today.getTime();
    let newToday = 0;
    let strongDeals = 0;
    for (const listing of listings) {
      if (listing.aiFiltered || listing.hidden) continue;
      // Posted today, not merely bumped or re-seen today: OLX refreshes keep
      // old offers at the top of "newest". Sources without a posting time
      // fall back to when Scout first saw the listing.
      const arrivedAt = listing.postedAt ?? listing.firstSeenAt ?? listing.observedAt;
      if (Date.parse(arrivedAt) >= todayTime) newToday += 1;
      // Strong and above (>=12% below typical), the same tier as the Strong+ filters.
      if (listing.dealStrength >= 3) strongDeals += 1;
    }
    const lastScan = parseJson<{ at?: string }>(this.getSetting('last_scan'), {});
    return {
      watches: top === null ? watches : [],
      listings: top === null ? listings : widgetDeals(listings, top),
      connectors: top === null ? this.getConnectors() : [],
      stats: {
        watching: watches.reduce((count, watch) => count + (watch.enabled ? 1 : 0), 0),
        newToday,
        strongDeals,
      },
      lastScan: relativeTime(lastScan.at),
      lastScanTime: timeOnly(lastScan.at),
    };
  }

  exportData() {
    const rows = (table: string) => this.stmt(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>;
    const data: Record<string, unknown> = { exportedAt: nowIso(), note: EXPORT_NOTE };
    for (const [key, table] of EXPORT_TABLES) data[key] = rows(table);
    data.settings = rows('settings').map(redactExportSetting);
    return data;
  }

  /**
   * The /api/export JSON as text chunks, byte-identical to
   * JSON.stringify(exportData()). Rows stream from a separate read-only
   * connection inside one read transaction (the same snapshot for every
   * table) in ~64 KB chunks with an event-loop turn between them, so the
   * export never materializes the database or blocks SSE and the scheduler.
   * The reader, BEGIN and the settings read happen synchronously in this
   * call, so a failure to open the snapshot throws here (and becomes a normal
   * error response) rather than from the stream after the route has replied.
   * An in-memory database, or a Node without StatementSync.iterate(), falls
   * back to exportData().
   */
  exportChunks(): AsyncGenerator<string> {
    return this.openExportSnapshot().chunks;
  }

  private openExportSnapshot(): { chunks: AsyncGenerator<string>; release: () => void } {
    const main = (this.db.prepare('PRAGMA database_list').all() as Array<{ name: string; file: string }>).find((row) => row.name === 'main');
    const reader = main?.file ? new DatabaseSync(main.file, { readOnly: true }) : null;
    let iterable = false;
    try {
      iterable = typeof reader?.prepare('SELECT 1').iterate === 'function';
    } catch (error) {
      reader?.close();
      throw error;
    }
    if (!reader || !iterable) {
      reader?.close();
      const text = JSON.stringify(this.exportData());
      return { chunks: (async function* () { yield text; })(), release: () => {} };
    }
    let open = false;
    let released = false;
    // Idempotent: the generator's finally and the stream's close both call it,
    // since a generator that never started skips its finally on return().
    const release = () => {
      if (released) return;
      released = true;
      if (open) { try { reader.exec('ROLLBACK'); } catch { /* the snapshot is released on close */ } }
      try { reader.close(); } catch { /* best-effort */ }
    };
    let settings: Array<Record<string, unknown>>;
    try {
      reader.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 5000;');
      reader.exec('BEGIN');
      open = true;
      // The first SELECT takes the snapshot every table is read from.
      settings = (reader.prepare('SELECT * FROM settings').all() as Array<Record<string, unknown>>).map(redactExportSetting);
    } catch (error) {
      release();
      throw error;
    }
    const chunks = async function* (): AsyncGenerator<string> {
      try {
        let chunk = `{"exportedAt":${JSON.stringify(nowIso())},"note":${JSON.stringify(EXPORT_NOTE)}`;
        for (const [key, table] of EXPORT_TABLES) {
          chunk += `,${JSON.stringify(key)}:[`;
          let first = true;
          for (const row of reader.prepare(`SELECT * FROM ${table}`).iterate()) {
            chunk += first ? JSON.stringify(row) : `,${JSON.stringify(row)}`;
            first = false;
            if (chunk.length >= EXPORT_CHUNK_CHARS) {
              yield chunk;
              chunk = '';
              await new Promise<void>((resolve) => setImmediate(resolve));
            }
          }
          chunk += ']';
        }
        yield `${chunk},"settings":${JSON.stringify(settings)}}`;
      } finally {
        // Also runs when the consumer stops early (client abort or timeout).
        release();
      }
    };
    return { chunks: chunks(), release };
  }

  /**
   * exportChunks() as a byte stream for the /api/export route. Opening the
   * snapshot can throw synchronously (see exportChunks). The stream is
   * destroyed after maxOpenMs, so a stalled client cannot pin the read
   * snapshot (and block WAL checkpoints from resetting) indefinitely.
   */
  exportStream(maxOpenMs = EXPORT_MAX_OPEN_MS) {
    const { chunks, release } = this.openExportSnapshot();
    const stream = Readable.from(chunks, { objectMode: false });
    const timer = setTimeout(() => stream.destroy(new Error(`Export exceeded ${maxOpenMs} ms and was stopped`)), maxOpenMs);
    timer.unref?.();
    stream.once('close', () => { clearTimeout(timer); release(); });
    return stream;
  }

  settings(): SettingsData {
    const webhookConfigured = Boolean(this.getSetting('discord_webhook'));
    const ntfy = this.ntfyConfig();
    return {
      defaultInterval: Number(this.getSetting('default_interval') ?? 5),
      nightInterval: Number(this.getSetting('night_interval') ?? DEFAULT_NIGHT_INTERVAL_MINUTES),
      webhookConfigured,
      webhookMasked: webhookConfigured ? '••••••••••••••••' : null,
      discordMinimumPriority: this.discordMinimumPriority(),
      dailyDigest: this.dailyDigestSettings(),
      ntfy: {
        configured: Boolean(ntfy),
        serverUrl: ntfy?.serverUrl ?? null,
        topicMasked: ntfy ? '••••••••••••••••' : null,
        tokenConfigured: Boolean(ntfy?.token),
        minimumPriority: ntfy?.minimumPriority ?? 'exceptional',
        openInApp: ntfy?.openInApp ?? false,
      },
      ai: (() => {
        // One config read: each call decrypts the stored API key.
        const aiConfig = this.deepSeekConfig();
        return {
          configured: Boolean(aiConfig.apiKey),
          model: aiConfig.model,
          source: aiConfig.source,
        };
      })(),
      publicExposureWarning: this.publicExposureWarning,
      authEnabled: this.authEnabled,
      marketplaceSessions: this.marketplaceSessions(),
    };
  }

  saveSettings(input: {
    interval?: number;
    nightInterval?: number;
    webhook?: string;
    clearWebhook?: boolean;
    discordMinimumPriority?: NotificationPriority;
    dailyDigest?: { enabled?: boolean; time?: string; discord?: boolean; ntfy?: boolean };
    clearNtfy?: boolean;
    ntfy?: { serverUrl?: string; topic?: string; token?: string; minimumPriority?: NotificationPriority; openInApp?: boolean };
    ai?: { apiKey?: string; clearApiKey?: boolean; model?: string };
  }) {
    if (input.interval !== undefined) {
      if (!Number.isInteger(input.interval) || input.interval < 5 || input.interval > 1440) throw new ServiceError('Polling interval must be between 5 and 1440 minutes');
      this.setSetting('default_interval', String(input.interval));
    }
    if (input.nightInterval !== undefined) {
      if (!Number.isInteger(input.nightInterval) || input.nightInterval < 5 || input.nightInterval > 1440) throw new ServiceError('Night polling interval must be between 5 and 1440 minutes');
      this.setSetting('night_interval', String(input.nightInterval));
    }
    if (input.clearWebhook) this.stmt("DELETE FROM settings WHERE key = 'discord_webhook'").run();
    if (input.webhook?.trim()) this.setSetting('discord_webhook', encryptSecret(validateDiscordWebhook(input.webhook.trim())));
    if (input.discordMinimumPriority !== undefined) this.setSetting('discord_minimum_priority', parseNotificationPriority(input.discordMinimumPriority, 'strong'));
    if (input.dailyDigest !== undefined) {
      const current = this.dailyDigestConfig();
      const next = {
        enabled: input.dailyDigest.enabled ?? current.enabled,
        time: input.dailyDigest.time ?? current.time,
        discord: input.dailyDigest.discord ?? current.discord,
        ntfy: input.dailyDigest.ntfy ?? current.ntfy,
      };
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(next.time)) throw new ServiceError('Daily digest time must use 24-hour HH:MM format.');
      if (next.enabled && !next.discord && !next.ntfy) throw new ServiceError('Select Discord, ntfy, or both for daily digests.');
      this.setSetting('daily_digest_config', JSON.stringify(next));
    }
    if (input.clearNtfy) this.stmt("DELETE FROM settings WHERE key = 'ntfy_config'").run();
    if (input.ntfy !== undefined) {
      const current = this.ntfyConfig();
      try {
        const config = validateNtfyConfig({
          serverUrl: input.ntfy.serverUrl?.trim() || current?.serverUrl,
          topic: input.ntfy.topic?.trim() || current?.topic,
          token: input.ntfy.token?.trim() || current?.token,
          minimumPriority: input.ntfy.minimumPriority ?? current?.minimumPriority ?? 'exceptional',
          openInApp: input.ntfy.openInApp ?? current?.openInApp ?? false,
        });
        this.setSetting('ntfy_config', encryptSecret(JSON.stringify(config)));
      } catch (error) {
        throw new ServiceError(error instanceof Error ? error.message : 'Invalid ntfy configuration');
      }
    }
    if (input.ai?.clearApiKey) this.stmt("DELETE FROM settings WHERE key IN ('openrouter_api_key', 'deepseek_api_key')").run();
    if (input.ai?.apiKey?.trim()) {
      this.stmt("DELETE FROM settings WHERE key = 'deepseek_api_key'").run();
      this.setSetting('openrouter_api_key', encryptSecret(input.ai.apiKey.trim()));
    }
    if (input.ai?.model !== undefined) {
      const model = input.ai.model.trim();
      if (!model || model.length > 200 || /\s/.test(model)) throw new ServiceError('OpenRouter model must be a non-empty model slug without spaces');
      this.setSetting('deepseek_model', model);
    }
    return this.settings();
  }

  notifications(): NotificationRecord[] {
    return this.notificationsPage().notifications;
  }

  notificationsPage(options: { page?: number; pageSize?: number } = {}) {
    const page = Math.max(1, Math.floor(options.page ?? 1));
    const pageSize = Math.max(1, Math.min(200, Math.floor(options.pageSize ?? 100)));
    const total = Number((this.stmt('SELECT COUNT(*) AS count FROM notifications').get() as { count?: number }).count ?? 0);
    const rows = this.stmt('SELECT * FROM notifications ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?').all(pageSize, (page - 1) * pageSize) as Array<Record<string, any>>;
    return { notifications: rows.map((row) => {
      const payload = parseJson<Record<string, any>>(row.payload_json, {});
      const embed = payload.embeds?.[0];
      const below = embed?.fields?.find((field: any) => field.name === 'Below typical')?.value;
      const digest = payload._scoutDigest as { channel?: string; count?: number } | undefined;
      return { id: Number(row.id), title: embed?.title ?? payload.title ?? (payload.test ? `${payload.channel === 'ntfy' ? 'ntfy' : 'Discord'} test notification` : row.listing_key), reason: digest ? `${digest.count ?? 0} deals · ${digest.channel ?? 'daily digest'}` : below ? `${below} below typical` : payload.test ? `${payload.channel === 'ntfy' ? 'ntfy' : 'Webhook'} connectivity test` : 'Deal alert', observedAt: row.sent_at ?? row.created_at, status: row.status };
    }), pagination: { page, pageSize, total, hasNext: page * pageSize < total } };
  }

  connectorRuns(): ConnectorRun[] {
    return this.connectorRunsPage().runs;
  }

  connectorRunsPage(options: { page?: number; pageSize?: number } = {}) {
    const page = Math.max(1, Math.floor(options.page ?? 1));
    const pageSize = Math.max(1, Math.min(200, Math.floor(options.pageSize ?? 100)));
    let total = 0;
    for (const count of this.connectorRunCounts().values()) total += count;
    const rows = this.stmt('SELECT * FROM connector_runs ORDER BY started_at DESC, id DESC LIMIT ? OFFSET ?').all(pageSize, (page - 1) * pageSize) as Array<Record<string, any>>;
    return { runs: rows.map((row) => ({ id: Number(row.id), source: row.source, status: row.status, message: row.message, startedAt: row.started_at, finishedAt: row.finished_at, duration: duration(row.started_at, row.finished_at) })), pagination: { page, pageSize, total, hasNext: page * pageSize < total } };
  }

  deleteWatch(id: string) {
    const result = this.stmt('DELETE FROM watches WHERE id = ?').run(id);
    if (!result.changes) throw new ServiceError('Watch not found', 404);
  }

  archiveWatch(id: string, archived: boolean) {
    const now = nowIso();
    const result = archived
      ? this.stmt('UPDATE watches SET archived_at = ?, enabled = 0, updated_at = ? WHERE id = ?').run(now, now, id)
      : this.stmt('UPDATE watches SET archived_at = NULL, enabled = 1, updated_at = ? WHERE id = ?').run(now, id);
    if (!result.changes) throw new ServiceError('Watch not found', 404);
    this.emit('watch', { id, archived });
  }

  async testWebhook() {
    const encrypted = this.getSetting('discord_webhook');
    if (!encrypted) throw new ServiceError('Configure a Discord webhook before sending a test', 409);
    const webhook = validateDiscordWebhook(decryptSecret(encrypted));
    const sentAt = nowIso();
    const payload = { username: 'Scout', embeds: [{ title: 'Scout is connected', description: 'Your deal alerts will be delivered here.', color: 0x1d61e8, footer: { text: 'Scout · webhook test' }, timestamp: sentAt }] };
    const key = `test-${Date.now()}`;
    try {
      const response = await fetch(webhook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(12_000) });
      discardResponse(response, 'discord-webhook');
      if (!response.ok) throw new Error(`Discord returned ${response.status}`);
      this.stmt('INSERT INTO notifications (listing_key, payload_json, status, sent_at, created_at) VALUES (?, ?, ?, ?, ?)').run(key, JSON.stringify({ ...payload, test: true }), 'delivered', sentAt, sentAt);
      this.recordRun('Discord', 'ok', 'Test webhook delivered', sentAt, nowIso());
      this.emit('notification', { refresh: true });
      return { delivered: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Discord delivery failed';
      this.stmt('INSERT INTO notifications (listing_key, payload_json, status, created_at) VALUES (?, ?, ?, ?)').run(key, JSON.stringify({ ...payload, test: true }), 'failed', sentAt);
      this.recordRun('Discord', 'error', message, sentAt, nowIso());
      throw new ServiceError(message, 502);
    }
  }

  async testNtfy() {
    const config = this.ntfyConfig();
    if (!config) throw new ServiceError('Configure ntfy before sending a test', 409);
    const sentAt = nowIso();
    const payload = {
      topic: config.topic,
      title: 'Scout is connected',
      message: config.openInApp ? 'Your important deal alerts will be delivered here. Tap to open the Scout app.' : 'Your important deal alerts will be delivered here.',
      priority: 3,
      tags: ['white_check_mark'],
      click: config.openInApp ? SCOUT_APP_DEALS_LINK : config.serverUrl,
    };
    const key = `test-ntfy-${Date.now()}`;
    try {
      await publishNtfy(config, payload);
      this.stmt('INSERT INTO notifications (listing_key, payload_json, status, sent_at, created_at) VALUES (?, ?, ?, ?, ?)').run(key, JSON.stringify({ ...payload, test: true, channel: 'ntfy' }), 'delivered', sentAt, sentAt);
      this.recordRun('ntfy', 'ok', 'Test ntfy notification delivered', sentAt, nowIso());
      this.emit('notification', { refresh: true });
      return { delivered: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'ntfy delivery failed';
      this.stmt('INSERT INTO notifications (listing_key, payload_json, status, created_at) VALUES (?, ?, ?, ?)').run(key, JSON.stringify({ ...payload, test: true, channel: 'ntfy' }), 'failed', sentAt);
      this.recordRun('ntfy', 'error', message, sentAt, nowIso());
      throw new ServiceError(message, 502);
    }
  }

  queueScan(watchId?: string) {
    const rows = watchId
      ? this.stmt('SELECT * FROM watches WHERE id = ? AND enabled = 1').all(watchId) as WatchRow[]
      : this.stmt('SELECT * FROM watches WHERE enabled = 1').all() as WatchRow[];
    if (!rows.length) throw new ServiceError(watchId ? 'Enabled watch not found' : 'There are no enabled watches to scan', 404);
    // A manual scan ignores the per-marketplace schedule and checks every source.
    for (const row of rows) this.background(`Scan ${row.name}`, this.runWatch(row, { forceAll: true }));
    return { queued: true, message: `Queued ${rows.length} ${rows.length === 1 ? 'watch' : 'watches'}` };
  }

  queueDue() {
    // Retention failing must not block scans, so it is isolated from the rest of the tick.
    try {
      this.pruneRetention();
    } catch (error) {
      this.logBackgroundError('Retention pruning', error);
    }
    this.background('Notification retries', this.processNotificationRetries());
    this.background('Daily digest', this.processDailyDigest());
    const rows = this.stmt('SELECT * FROM watches WHERE enabled = 1 AND next_scan_at <= ?').all(nowIso()) as WatchRow[];
    for (const row of rows) this.background(`Scan ${row.name}`, this.runWatch(row));
    const marketRows = this.stmt('SELECT * FROM market_watches WHERE enabled = 1 AND next_scan_at <= ?').all(nowIso()) as WatchRow[];
    for (const row of marketRows) this.background(`Research scan ${row.name}`, this.runMarketWatch(row));
  }

  private async runWatch(row: WatchRow, options: { forceAll?: boolean } = {}) {
    if (this.running.has(row.id)) return;
    this.running.add(row.id);
    try {
      const sources = parseJson<Marketplace[]>(row.sources_json, []);
      const exactUrls = parseJson<string[]>(row.exact_urls_json, []);
      // Each marketplace keeps its own next-check time so a slow source can be
      // left alone while a fast one is polled. A source with no recorded time
      // (first run, newly added) is always due; "Scan now" forces every source.
      const storedSourceNext = parseJson<Record<string, string>>(row.source_next_scan_json, {});
      const dueSources = options.forceAll ? sources : dueWatchSources(sources, storedSourceNext);
      // Reference-series fallback is computed once per scan, like the baseline.
      const referenceMedian = row.reference_market_watch_id ? this.referenceBandMedian(String(row.reference_market_watch_id)) : null;
      const backoffBySource = new Map<string, string>();
      // Every due source's createScan runs before the first await and the
      // running set excludes a concurrent run, so all sources see the same
      // ordinal; it is counted once, on first use.
      let ordinal: number | undefined;
      const scanOrdinal = () => ordinal ??= this.scanOrdinal(String(row.id), 'watch');
      if (!dueSources.length) {
        const pending = sources.map((source) => storedSourceNext[source]).filter((value): value is string => Boolean(value)).sort();
        if (pending.length) this.stmt('UPDATE watches SET next_scan_at = ?, updated_at = ? WHERE id = ?').run(pending[0], nowIso(), row.id);
        return;
      }
      await Promise.all(dueSources.map(async (source) => {
        const paths: string[] = [];
        const onPath: ConnectorPathReporter = (path) => { if (!paths.includes(path)) paths.push(path); };
        const started = nowIso();
        const backoffUntil = this.activeConnectorBackoff(source);
        if (backoffUntil) backoffBySource.set(source, backoffUntil);
        const runId = this.recordRun(source, backoffUntil ? 'skipped' : 'running', backoffUntil ? `Skipped ${row.name}; connector backoff is active` : `Scanning ${row.name}`, started, backoffUntil ? started : null);
        const scanId = this.createScan(String(row.id), 'watch', source, started);
        if (backoffUntil) {
          this.stmt("UPDATE scans SET status = 'skipped', completed_at = ?, error = ? WHERE id = ?").run(started, `Connector backoff active until ${backoffUntil}`, scanId);
          this.log('info', 'watch', `${row.name} · ${source}: skipped (connector backoff until ${backoffUntil})`);
          return;
        }
        try {
          const matchingExact = exactUrls.filter((url) => validateSearchUrl(url, source).valid);
          const searchFilters = { minPrice: row.min_price_pln, maxPrice: row.max_price_pln, condition: row.condition, shippingOnly: Boolean(row.shipping_only), olxCategoryId: olxCategoryFromJson(row.olx_category_json)?.id ?? null, ownerType: sellerTypeFromRow(row.seller_type), sort: 'newest' as const };
          const urls = matchingExact.length
            ? matchingExact
            : [this.marketplaceSearchRequestUrl(source, row.query, searchFilters)];
          const adapter = this.createConnectorAdapter(source, onPath);
          const mainListings = matchingExact.length
            ? (await Promise.all(urls.map((url) => adapter.fetchPublicSearch(url)))).flat()
            : await this.fetchSearchPages(source, row.query, searchFilters, onPath);
          // Typo variants append at most one page per variant query after the
          // main page; exact-URL watches pin their own searches instead.
          const variantQueries = matchingExact.length || !row.typo_variants
            ? []
            : pickVariantBatch(typoVariants(String(row.query)), scanOrdinal(), TYPO_VARIANTS_PER_SCAN);
          const variantFetches: string[] = [];
          for (const variantQuery of variantQueries) {
            variantFetches.push(`"${variantQuery}"`);
            mainListings.push(...await this.fetchSearchPages(source, variantQuery, searchFilters, onPath));
          }
          const fetched = [...new Map(mainListings.map((listing) => [`${listing.marketplace}:${listing.listingId}`, listing])).values()];
          this.log('info', 'watch', `${row.name} · ${source}: ${matchingExact.length ? `exact-urls (${matchingExact.length})` : 'query-search'}${variantFetches.length ? ` + typo-variants (${variantFetches.join(', ')})` : ''} → ${paths.join(' → ') || 'no fetch'} · fetched=${fetched.length}`);
          const deterministicFilters = { minPrice: row.min_price_pln, maxPrice: row.max_price_pln, condition: row.condition, sellerType: sellerTypeFromRow(row.seller_type), ignorePromoted: Boolean(row.ignore_promoted), shippingOnly: false };
          const comparable = filterListings(fetched, row.query, row.included_terms, row.excluded_terms, deterministicFilters);
          if (row.shipping_only) await this.enrichShipping(comparable, source);
          let filtered = filterListings(comparable, row.query, row.included_terms, row.excluded_terms, { ...deterministicFilters, shippingOnly: Boolean(row.shipping_only) });
          // Per-variant baselines and first-observation queries are computed
          // once per scan, before the AI passes: both the fuzzy rescue and the
          // relevance pass need the same scoring to decide which listings are
          // strong enough to justify an AI call, and storeListing below
          // reuses the result. A listing's bucket comes from its title, so the
          // gate scores it against the model it will actually be stored under.
          const baselines = this.watchBaselines(row);
          const variants = this.scanVariantResolver(row, baselines);
          // Spend rescue + relevance AI only where it can matter: listings
          // that would alert (score.qualifies) or already rank Very strong.
          // Everything else is kept without an AI call.
          const strongEnough = (listing: NormalizedListing) => {
            const { score, dealStrength } = this.variantDealScore(row, listing.price, baselines, variants.get(listing).key, referenceMedian);
            return score.qualifies || (dealStrength ?? 0) >= 4;
          };
          try {
            if (!matchingExact.length) {
              const rescued = await this.fuzzyRescueForSearch(fetched, {
                query: row.query, includedTerms: row.included_terms ?? '', excludedTerms: row.excluded_terms ?? '', condition: row.condition,
              }, { ...deterministicFilters, shippingOnly: Boolean(row.shipping_only) }, source, strongEnough);
              if (rescued.length) {
                const seen = new Set(filtered.map((listing) => `${listing.marketplace}:${listing.listingId}`));
                for (const listing of rescued) {
                  const key = `${listing.marketplace}:${listing.listingId}`;
                  if (!seen.has(key)) {
                    seen.add(key);
                    filtered.push(listing);
                  }
                }
              }
            }
          } catch {
            // Rescue is recall-only; any failure keeps the deterministic set.
          }
          // Jev variant picks land before the relevance pass so a listing it
          // moves out of Other gets the same relevance check as any other
          // potential deal.
          await this.assignVariantsWithJev(filtered, row, baselines, variants);
          // Per-variant baselines are computed once per scan above (shared
          // with the fuzzy rescue gate), before the AI relevance pass: the
          // pass needs the same scoring to decide which listings are strong
          // enough to justify an AI call, and storeListing below reuses the
          // result.
          const relevance = await this.filterListingsByAiRelevance(filtered, {
            query: row.query,
            includedTerms: row.included_terms ?? '',
            excludedTerms: row.excluded_terms ?? '',
          }, row.id, row.ai_relevance === undefined ? true : Boolean(row.ai_relevance), strongEnough);
          const candidates = this.transaction(() => {
            const pendingCandidates: DealNotificationCandidate[] = [];
            for (const listing of relevance.listings) {
              const candidate = this.storeListing(row, listing, scanId, baselines, referenceMedian, variants.get(listing));
              if (candidate) pendingCandidates.push(candidate);
            }
            const pending = row.shipping_only ? comparable.filter((listing) => listing.shippingAvailable === null).length : 0;
            const relevanceNote = this.relevanceNote(relevance, row);
            this.completeScan(scanId, row.shipping_only ? `${relevance.listings.length} shipping matches${pending ? ` · ${pending} pending checks` : ''}${relevanceNote}` : `${relevance.listings.length} listings normalized${relevanceNote}`);
            return pendingCandidates;
          });
          await this.processDealCandidates(candidates, () => this.scanNotifyContext());
          const pending = row.shipping_only ? comparable.filter((listing) => listing.shippingAvailable === null).length : 0;
          const relevanceNote = this.relevanceNote(relevance, row);
          this.finishRun(runId, 'ok', row.shipping_only ? `${relevance.listings.length} shipping matches${pending ? ` · ${pending} pending checks` : ''}${relevanceNote}` : `${relevance.listings.length} listings normalized${relevanceNote}`);
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Connector failed';
          this.failScan(scanId, error);
          this.log('error', 'watch', `${row.name} · ${source}: failed via ${paths.join(' → ') || 'unstarted path'} — ${message}`);
          this.finishFailedRun(runId, source, error, message);
        }
      }));
      const finished = nowIso();
      const nightInterval = Number(this.getSetting('night_interval') ?? DEFAULT_NIGHT_INTERVAL_MINUTES);
      const intervals = watchSourceIntervals(sources, Number(row.interval_minutes), parseJson<Record<string, unknown>>(row.source_intervals_json, {}));
      const { nextBySource, nextScanAt } = nextWatchScanSchedule({
        sources,
        intervals,
        prior: storedSourceNext,
        scanned: dueSources,
        finishedAt: finished,
        nightIntervalMinutes: nightInterval,
        backoff: Object.fromEntries(backoffBySource),
      });
      this.stmt('UPDATE watches SET next_scan_at = ?, source_next_scan_json = ?, updated_at = ? WHERE id = ?').run(nextScanAt, JSON.stringify(nextBySource), finished, row.id);
      this.setSetting('last_scan', JSON.stringify({ at: finished }));
      try {
        await this.autoGenerateVariantGroups(String(row.id));
      } catch (error) {
        this.logBackgroundError(`Variant suggestions for ${row.name}`, error);
      }
      this.emit('scan', { refresh: true, watchId: row.id });
    } finally {
      this.running.delete(row.id);
    }
  }

  /**
   * Every marketplace runs on a dedicated anonymous path: OLX on its verified
   * offers API, Vinted on the SSR catalog page first (pageFetcher owns the
   * Chromium fallback, catalog JSON only opportunistically), then the
   * public-page adapter, and Allegro Lokalnie on plain-HTTP SSR pages
   * enriched through its anonymous batch API. Chromium is only reachable
   * through those explicit fallbacks.
   */
  private createConnectorAdapter(source: Marketplace, onPath?: ConnectorPathReporter): ConnectorAdapter {
    if (source === 'OLX') return createOlxJsonAdapter(source, (url) => this.fetchOlxApi(url), onPath, (segments) => this.resolveOlxSearchPath(segments));
    if (source === 'Vinted') {
      return createVintedJsonAdapter(
        source,
        (url) => this.fetchVintedApi(url),
        (url) => this.fetchVintedItemPage(url),
        createPublicAdapter(source, (url) => this.fetchPublicPage(url, source), onPath),
        onPath,
      );
    }
    if (source === 'Allegro Lokalnie') {
      return createAllegroLokalnieAdapter(source, (url) => this.fetchPublicPage(url, source), (url, body) => this.fetchAllegroLokalnieApi(url, body), onPath);
    }
    return createPublicAdapter(source, (url) => this.fetchPublicPage(url, source), onPath);
  }

  /**
   * OLX category/place paths are stable, so each pasted path is resolved once
   * per process, including "not recognised" answers. Transient lookup
   * failures are evicted so they cannot pin a watch as broken until restart.
   */
  private olxPathCache = new Map<string, Promise<OlxSearchPathParams>>();

  private resolveOlxSearchPath(segments: string[]) {
    const key = segments.join('/');
    let pending = this.olxPathCache.get(key);
    if (!pending) {
      pending = resolveOlxSearchPath(segments, async (path) => {
        const { status, json } = await this.fetchOlxApi(buildOlxFriendlyLinksUrl(path));
        if (status === 404) return null;
        if (status < 200 || status >= 300) throw new Error(`OLX path lookup returned HTTP ${status}`);
        return parseOlxFriendlyLinks(json);
      });
      pending.catch((error) => { if (!(error instanceof SearchConfigError)) this.olxPathCache.delete(key); });
      this.olxPathCache.set(key, pending);
    }
    return pending;
  }

  /**
   * OLX's per-category hit counts for a query, for the watch category picker.
   * One metadata request; no offers are fetched or stored.
   */
  async olxCategories(query: string): Promise<OlxCategoryFacet[]> {
    const { status, json } = await this.fetchOlxApi(buildOlxCategoryFacetsUrl(query));
    if (status < 200 || status >= 300) throw new ServiceError(`OLX category lookup returned HTTP ${status}`, 502);
    return parseOlxCategoryFacets(json);
  }

  /** Watches pass their original query and filters straight into the OLX API instead of round-tripping an HTML URL slug. */
  private marketplaceSearchRequestUrl(source: Marketplace, query: string, filters: Parameters<typeof buildMarketplaceSearchUrl>[2]) {
    return source === 'OLX' ? buildOlxSearchApiUrl(query, filters) : buildMarketplaceSearchUrl(source, query, filters);
  }

  /**
   * Every marketplace request goes through a per-marketplace limiter, and
   * every Chromium render through a shared one. Due watches and research
   * scans all start together, so without a cap one tick bursts every source
   * at once — the pattern that trips anti-bot fences — and each 403/429
   * fallback launches its own browser.
   */
  private readonly marketplaceLimiters = new Map<Marketplace, Limiter>();
  private readonly browserLimiter = new Limiter(BROWSER_RENDER_CONCURRENCY);

  private marketplaceRequest<T>(marketplace: Marketplace, task: () => Promise<T>): Promise<T> {
    let limiter = this.marketplaceLimiters.get(marketplace);
    if (!limiter) {
      limiter = new Limiter(MARKETPLACE_REQUEST_CONCURRENCY);
      this.marketplaceLimiters.set(marketplace, limiter);
    }
    return limiter.run(task);
  }

  private fetchOlxApi(url: string) { return this.marketplaceRequest('OLX', () => this.requestOlxApi(url)); }
  private fetchVintedApi(url: string) { return this.marketplaceRequest('Vinted', () => this.requestVintedApi(url)); }
  private fetchVintedItemPage(url: string) { return this.marketplaceRequest('Vinted', () => this.requestVintedItemPage(url)); }
  private fetchAllegroLokalnieApi(url: string, body: string | null) { return this.marketplaceRequest('Allegro Lokalnie', () => this.requestAllegroLokalnieApi(url, body)); }
  private fetchPublicPage(url: string, marketplace: Marketplace) { return this.marketplaceRequest(marketplace, () => this.requestPublicPage(url, marketplace)); }
  private renderPublicPage(url: string, marketplace: Marketplace, storageState?: MarketplaceStorageState) { return this.browserLimiter.run(() => this.renderInBrowser(url, marketplace, storageState)); }

  private async requestOlxApi(url: string): Promise<OlxApiFetchResult> {
    const validation = validateSearchUrl(url, 'OLX');
    if (!validation.valid) throw new Error(validation.reason);
    let requestUrl = validation.url;
    for (let hop = 0; hop <= 3; hop += 1) {
      const hopValidation = validateSearchUrl(requestUrl, 'OLX');
      if (!hopValidation.valid) throw new Error('Marketplace redirected off the approved domain');
      const { status, json, location } = await fetchOlxApiSingleRequest(hopValidation.url, 12_000);
      if (status >= 300 && status < 400 && hop < 3) {
        if (!location) throw new Error(`Unexpected redirect (${status})`);
        requestUrl = new URL(location, hopValidation.url).toString();
        continue;
      }
      return { status, json };
    }
    throw new Error('Too many redirects');
  }

  private vintedCookieJar: { header: string } | null = null;
  private vintedCookieBootstrap: Promise<string> | null = null;

  /**
   * Vinted's anonymous catalog API requires the `access_token_web` cookie that
   * the homepage hands out to any visitor; no login is involved. The jar lives
   * in memory per process (the token lasts 7 days), is shared across
   * concurrent scans through the memoized bootstrap, and is re-bootstrapped
   * once on 401 per the community-verified refresh pattern. A missing or
   * fenced bootstrap throws so the adapter falls back to the rendered page.
   */
  private async requestVintedApi(url: string): Promise<VintedApiFetchResult> {
    const validation = validateSearchUrl(url, 'Vinted');
    if (!validation.valid) throw new Error(validation.reason);
    let response = await this.fetchVintedWithCookies(validation.url);
    if (response.status === 401) {
      this.vintedCookieJar = null;
      discardResponse(response, 'vinted-api');
      response = await this.fetchVintedWithCookies(validation.url);
    }
    let json: unknown = null;
    try { json = await response.json(); } catch { /* non-JSON bodies (challenge pages) surface through the status */ }
    return { status: response.status, json };
  }

  private async fetchVintedWithCookies(url: string) {
    const cookie = await this.ensureVintedCookies();
    return fetch(url, {
      redirect: 'manual',
      headers: { 'user-agent': MARKETPLACE_API_USER_AGENT, accept: 'application/json', ...(cookie ? { cookie } : {}) },
      signal: AbortSignal.timeout(12_000),
    });
  }

  private async ensureVintedCookies(): Promise<string> {
    if (this.vintedCookieJar) return this.vintedCookieJar.header;
    if (!this.vintedCookieBootstrap) {
      this.vintedCookieBootstrap = this.bootstrapVintedCookies().finally(() => { this.vintedCookieBootstrap = null; });
    }
    return this.vintedCookieBootstrap;
  }

  private async bootstrapVintedCookies(): Promise<string> {
    const validation = validateSearchUrl('https://www.vinted.pl/', 'Vinted');
    if (!validation.valid) throw new Error(validation.reason);
    const headers = { 'user-agent': MARKETPLACE_API_USER_AGENT, accept: 'text/html,application/xhtml+xml', 'accept-language': 'pl-PL,pl;q=0.9' };
    const jar = new Map<string, string>();
    let url = validation.url;
    let response = await fetch(url, { redirect: 'manual', headers, signal: AbortSignal.timeout(12_000) });
    for (let hop = 0; hop < 3; hop += 1) {
      for (const cookie of response.headers.getSetCookie()) {
        const pair = cookie.split(';')[0];
        const separator = pair.indexOf('=');
        if (separator > 0) jar.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim());
      }
      if (response.status < 300 || response.status >= 400) break;
      const location = response.headers.get('location');
      if (!location) throw new Error(`Unexpected redirect (${response.status})`);
      discardResponse(response, 'vinted-bootstrap');
      const redirected = new URL(location, url).toString();
      const redirectValidation = validateSearchUrl(redirected, 'Vinted');
      if (!redirectValidation.valid) throw new Error('Marketplace redirected off the approved domain');
      url = redirectValidation.url;
      response = await fetch(url, { redirect: 'manual', headers, signal: AbortSignal.timeout(12_000) });
    }
    discardResponse(response, 'vinted-bootstrap');
    if (!jar.has('access_token_web')) {
      throw new Error(`Vinted did not issue an anonymous access token (HTTP ${response.status})`);
    }
    this.vintedCookieJar = { header: [...jar].map(([name, value]) => `${name}=${value}`).join('; ') };
    return this.vintedCookieJar.header;
  }

  /**
   * Public Vinted item/catalog pages over plain HTTP with the status
   * preserved: 404s must reach the availability classifier as terminal while
   * 403/429 fall back to the Chromium render. The item JSON routes stay
   * untouched — they are closed to anonymous clients.
   */
  private async requestVintedItemPage(url: string): Promise<VintedPageFetchResult> {
    const validation = validateSearchUrl(url, 'Vinted');
    if (!validation.valid) throw new Error(validation.reason);
    const headers = { 'user-agent': MARKETPLACE_API_USER_AGENT, accept: 'text/html,application/xhtml+xml', 'accept-language': 'pl-PL,pl;q=0.9' };
    let finalUrl = validation.url;
    let response = await fetch(finalUrl, { redirect: 'manual', headers, signal: AbortSignal.timeout(12_000) });
    for (let hop = 0; hop < 3 && response.status >= 300 && response.status < 400; hop += 1) {
      const location = response.headers.get('location');
      const status = response.status;
      discardResponse(response, 'vinted-item');
      if (!location) throw new Error(`Unexpected redirect (${status})`);
      const redirected = new URL(location, finalUrl).toString();
      const redirectValidation = validateSearchUrl(redirected, 'Vinted');
      if (!redirectValidation.valid) throw new Error('Marketplace redirected off the approved domain');
      finalUrl = redirectValidation.url;
      response = await fetch(finalUrl, { redirect: 'manual', headers, signal: AbortSignal.timeout(12_000) });
    }
    if (response.status === 403 || response.status === 429) {
      return { status: 200, body: await this.renderPublicPage(finalUrl, 'Vinted') };
    }
    if (!response.ok) { discardResponse(response, 'vinted-item'); return { status: response.status, body: '' }; }
    return { status: response.status, body: await response.text() };
  }

  /** Anonymous Lokalnie JSON surface (batch condition enrichment); no cookies, no CSRF. */
  private async requestAllegroLokalnieApi(url: string, body: string | null): Promise<AllegroApiFetchResult> {
    const validation = validateSearchUrl(url, 'Allegro Lokalnie');
    if (!validation.valid) throw new Error(validation.reason);
    const headers: Record<string, string> = { 'user-agent': MARKETPLACE_API_USER_AGENT, accept: 'application/json' };
    if (body) headers['content-type'] = 'application/json';
    const response = await fetch(validation.url, { method: body ? 'POST' : 'GET', redirect: 'manual', headers, body: body ?? undefined, signal: AbortSignal.timeout(12_000) });
    let json: unknown = null;
    try { json = await response.json(); } catch { /* non-JSON bodies (e.g. challenge pages) surface through the status */ }
    return { status: response.status, json };
  }

  private async requestPublicPage(url: string, marketplace: Marketplace): Promise<string> {
    const validation = validateSearchUrl(url, marketplace);
    if (!validation.valid) throw new Error(validation.reason);
    const authenticatedState = this.readMarketplaceSession(marketplace);
    if (authenticatedState) {
      try {
        const html = await this.renderPublicPage(validation.url, marketplace, authenticatedState);
        this.touchMarketplaceSession(marketplace);
        return html;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Authenticated browser session failed';
        this.setMarketplaceSessionError(marketplace, message);
        throw new Error(`${marketplace} authenticated session failed: ${message}. Re-import the session after logging in again.`);
      }
    }
    // Vinted fences the self-identifying Scout UA (403 on flagged IPs) while the
    // same page answers 200 to the Chrome UA (verified 2026-09-19: catalog and
    // item pages 200 via Chrome UA, API 404). Other marketplaces keep the
    // polite identifier.
    const publicHeaders: Record<string, string> = marketplace === 'Vinted'
      ? { 'user-agent': MARKETPLACE_API_USER_AGENT, accept: 'text/html,application/xhtml+xml', 'accept-language': 'pl-PL,pl;q=0.9' }
      : { 'user-agent': 'Scout/1.0 (+self-hosted public page monitor)', accept: 'text/html,application/xhtml+xml' };
    let pageUrl = validation.url;
    let response = await fetch(pageUrl, { redirect: 'manual', headers: publicHeaders, signal: AbortSignal.timeout(12_000) });
    for (let hop = 0; hop < 3 && response.status >= 300 && response.status < 400; hop += 1) {
      const location = response.headers.get('location');
      const status = response.status;
      discardResponse(response, 'public-page');
      if (!location) throw new Error(`Unexpected redirect (${status})`);
      const redirected = new URL(location, pageUrl).toString();
      const redirectValidation = validateSearchUrl(redirected, marketplace);
      if (!redirectValidation.valid) throw new Error('Marketplace redirected off the approved domain');
      pageUrl = redirectValidation.url;
      response = await fetch(pageUrl, { redirect: 'manual', headers: publicHeaders, signal: AbortSignal.timeout(12_000) });
    }
    if (!response.ok) {
      discardResponse(response, 'public-page');
      if (response.status === 403 || response.status === 429) return this.renderPublicPage(validation.url, marketplace);
      throw new Error(`Public page returned ${response.status}`);
    }
    return response.text();
  }

  // Locally launched Chromium, shared by renders (each still gets its own
  // context) and closed BROWSER_IDLE_CLOSE_MS after the last render ends.
  // Browserless connections stay per render: its TIMEOUT is a hard session
  // limit, so a cached connection would be killed mid-render.
  private sharedBrowser: Promise<Browser> | null = null;
  private activeBrowserRenders = 0;
  private browserIdleTimer: NodeJS.Timeout | null = null;
  private browserShutDown = false;

  private async launchLocalBrowser(executablePath: string): Promise<Browser> {
    const { chromium } = await loadPlaywright();
    // Pass a minimal environment: the renderer parses third-party pages and
    // must not inherit SCOUT_SECRET, API tokens, or provider keys.
    const browserEnv = Object.fromEntries(['PATH', 'HOME', 'TZ', 'LANG', 'XDG_RUNTIME_DIR', 'FONTCONFIG_PATH'].flatMap((key) => (process.env[key] ? [[key, process.env[key] as string]] : [])));
    return chromium.launch({ executablePath, headless: true, env: browserEnv, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'] });
  }

  /** Callers must pair every call with releaseLocalBrowser, even when the launch fails. */
  private acquireLocalBrowser(executablePath: string): Promise<Browser> {
    this.activeBrowserRenders += 1;
    if (this.browserIdleTimer) {
      clearTimeout(this.browserIdleTimer);
      this.browserIdleTimer = null;
    }
    // After the final close (server shutdown) nothing may launch a new Chromium.
    if (this.browserShutDown) return Promise.reject(new Error('Scout is shutting down; Chromium is closed'));
    if (!this.sharedBrowser) {
      const pending = this.launchLocalBrowser(executablePath).then((browser) => {
        // A crash or external kill drops the cache; the next render relaunches.
        browser.on('disconnected', () => {
          if (this.sharedBrowser === pending) this.sharedBrowser = null;
        });
        return browser;
      });
      pending.catch(() => {
        if (this.sharedBrowser === pending) this.sharedBrowser = null;
      });
      this.sharedBrowser = pending;
    }
    return this.sharedBrowser;
  }

  private releaseLocalBrowser() {
    this.activeBrowserRenders -= 1;
    if (this.activeBrowserRenders > 0 || !this.sharedBrowser || this.browserIdleTimer) return;
    this.browserIdleTimer = setTimeout(() => {
      this.browserIdleTimer = null;
      if (this.activeBrowserRenders === 0) void this.closeBrowser();
    }, BROWSER_IDLE_CLOSE_MS);
    this.browserIdleTimer.unref?.();
  }

  /**
   * Close the shared local Chromium, if any (idle timeout and server shutdown).
   * `final` (shutdown) also refuses later launches. Waits at most
   * BROWSER_CLOSE_TIMEOUT_MS for the launch and close to finish.
   */
  async closeBrowser({ final = false }: { final?: boolean } = {}) {
    if (final) this.browserShutDown = true;
    if (this.browserIdleTimer) {
      clearTimeout(this.browserIdleTimer);
      this.browserIdleTimer = null;
    }
    const pending = this.sharedBrowser;
    this.sharedBrowser = null;
    if (!pending) return;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, BROWSER_CLOSE_TIMEOUT_MS);
      timer.unref?.();
    });
    try {
      await Promise.race([pending.then((browser) => browser.close()).catch(() => undefined), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async renderInBrowser(url: string, marketplace: Marketplace, storageState?: MarketplaceStorageState): Promise<string> {
    let browser: Browser | undefined;
    let context: BrowserContext | undefined;
    let sharedLocal = false;
    try {
      if (process.env.SCOUT_BROWSER_WS) {
        const { chromium } = await loadPlaywright();
        browser = await chromium.connectOverCDP(process.env.SCOUT_BROWSER_WS, { timeout: 8_000 });
      } else {
        const executablePath = process.env.SCOUT_CHROMIUM_PATH ?? ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].find(existsSync);
        if (!executablePath) throw new Error('Chromium is not available; configure SCOUT_BROWSER_WS');
        sharedLocal = true;
        browser = await this.acquireLocalBrowser(executablePath);
      }
      // Always isolate scans in their own context: reusing the shared default
      // context leaks cookies across marketplaces and concurrent scans.
      // A real Chrome UA + viewport hides the headless default (DataDome and
      // Cloudflare Turnstile fence HeadlessChrome on flagged IPs).
      context = await browser.newContext(storageState
        ? { locale: 'pl-PL', storageState: storageState as any, userAgent: MARKETPLACE_API_USER_AGENT, viewport: { width: 1366, height: 768 }, serviceWorkers: 'block' }
        : { locale: 'pl-PL', userAgent: MARKETPLACE_API_USER_AGENT, viewport: { width: 1366, height: 768 }, serviceWorkers: 'block' });
      if (!context) throw new Error('Chromium context could not be created');
      // Marketplace pages run third-party ad and analytics scripts. Keep them
      // off Scout's own network: no requests to loopback, private, or single-label
      // hosts (such as the Browserless container itself), and no WebSockets at all.
      await context.route('**/*', (route) => {
        let hostname = '';
        try { hostname = new URL(route.request().url()).hostname; } catch { /* unparseable URLs are aborted */ }
        const bare = hostname.replace(/^\[|\]$/g, '');
        const reachable = bare && isSafeNetworkHost(bare) && (bare.includes('.') || bare.includes(':'));
        if (!reachable) return route.abort('blockedbyclient');
        // Only the HTML is read: marketplace CDN photos get a 1x1 GIF instead of
        // a download. Other hosts' images (challenge platforms) still load.
        if (route.request().resourceType() === 'image' && isMarketplaceImageUrl(route.request().url())) {
          return route.fulfill({ status: 200, contentType: 'image/gif', body: ONE_PIXEL_GIF });
        }
        return route.continue();
      });
      await context.routeWebSocket(/.*/, (socket) => { socket.close(); });
      const page = await context.newPage();
      try {
        // Vinted-only warm-up: the homepage sets the anonymous session cookies
        // (access_token_web, __cf_bm) and lets JS challenges settle before the
        // target navigation goes out cold. Other marketplaces keep the direct
        // navigation to avoid extra latency and challenge surface.
        if (marketplace === 'Vinted') {
          try {
            const root = new URL(url).origin + '/';
            if (root !== url) await page.goto(root, { waitUntil: 'domcontentloaded', timeout: 15_000 });
          } catch { /* warm-up is opportunistic; the target navigation still runs */ }
        }
        let response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25_000 });
        await page.waitForTimeout(800);
        if (response && (response.status() === 403 || response.status() === 429)) {
          // Cloudflare Turnstile / DataDome challenges can auto-resolve given
          // a moment in a real browser; one reload beats an instant failure.
          await page.waitForTimeout(3_000);
          response = await page.reload({ waitUntil: 'domcontentloaded', timeout: 25_000 });
          await page.waitForTimeout(800);
        }
        const finalValidation = validateSearchUrl(page.url(), marketplace);
        if (!finalValidation.valid) throw new Error('Marketplace redirected off the approved domain');
        if (response && !response.ok()) throw new Error(`Chromium page returned ${response.status()} for ${marketplace} (anonymous browser blocked; import a session in Settings or retry from a residential IP)`);
        return await page.content();
      } finally { await page.close(); }
    } finally {
      try {
        if (context) await context.close();
      } finally {
        if (sharedLocal) this.releaseLocalBrowser();
        else if (browser) await browser.close().catch(() => undefined);
      }
    }
  }

  private pruneRetention() {
    const lastPrune = this.getSetting('last_prune');
    if (lastPrune && Date.now() - Date.parse(lastPrune) < 24 * 60 * 60_000) return;
    const cutoff = new Date(Date.now() - 180 * 24 * 60 * 60_000).toISOString();
    this.stmt('DELETE FROM observations WHERE observed_at < ?').run(cutoff);
    this.stmt('DELETE FROM listing_detail_snapshots WHERE captured_at < ?').run(cutoff);
    this.stmt('DELETE FROM market_price_observations WHERE observed_at < ?').run(cutoff);
    this.stmt('DELETE FROM listing_relevance WHERE checked_at < ?').run(cutoff);
    this.stmt('DELETE FROM manual_relevance_cache WHERE checked_at < ?').run(cutoff);
    this.stmt('DELETE FROM connector_runs WHERE started_at < ?').run(cutoff);
    this.connectorRunCountCache = null;
    this.stmt('DELETE FROM scans WHERE started_at < ?').run(cutoff);
    this.stmt('DELETE FROM notification_deliveries WHERE created_at < ?').run(cutoff);
    this.stmt('DELETE FROM notifications WHERE created_at < ?').run(cutoff);
    this.stmt('DELETE FROM daily_digest_candidates WHERE (digest_date IS NOT NULL AND digest_date < ?) OR (digest_date IS NULL AND observed_at < ?)').run(cutoff.slice(0, 10), cutoff);
    this.stmt("DELETE FROM market_listings WHERE status IN ('ended', 'superseded') AND last_seen_at < ?").run(cutoff);
    this.stmt("DELETE FROM market_watch_versions WHERE closed_at IS NOT NULL AND closed_at < ? AND id NOT IN (SELECT active_version_id FROM market_watches WHERE active_version_id IS NOT NULL)").run(cutoff);
    this.stmt('DELETE FROM listings WHERE last_seen_at < ? AND NOT EXISTS (SELECT 1 FROM observations WHERE observations.listing_id = listings.id)').run(cutoff);
    this.setSetting('last_prune', nowIso());
  }

  /** Testing hook: clear every cached AI result so the next scan re-evaluates. */
  resetAiResults() {
    return this.transaction(() => {
      const relevance = this.stmt('DELETE FROM listing_relevance').run() as { changes?: number };
      const shadow = this.stmt('DELETE FROM jev_shadow_log').run() as { changes?: number };
      const snapshots = this.stmt('DELETE FROM listing_detail_snapshots').run() as { changes?: number };
      const verification = this.stmt(`UPDATE listings SET
        ai_description_verification_json = NULL,
        ai_description_verification_input_hash = NULL,
        ai_description_verification_model = NULL,
        ai_description_verification_at = NULL,
        ai_description_verification_status = NULL,
        ai_description_verification_error = NULL`).run() as { changes?: number };
      return {
        ok: true as const,
        cleared: {
          relevance: relevance.changes ?? 0,
          shadowLog: shadow.changes ?? 0,
          detailSnapshots: snapshots.changes ?? 0,
          verification: verification.changes ?? 0,
        },
      };
    });
  }

  private async enrichShipping(listings: NormalizedListing[], marketplace: Marketplace, options: { limit?: number } = {}) {
    const lookup = this.stmt('SELECT shipping_available FROM listings WHERE marketplace = ? AND listing_id = ?');
    for (const listing of listings) {
      if (listing.shippingAvailable !== null) continue;
      const cached = lookup.get(listing.marketplace, listing.listingId) as { shipping_available: number | null } | undefined;
      if (cached?.shipping_available !== null && cached?.shipping_available !== undefined) listing.shippingAvailable = Boolean(cached.shipping_available);
    }
    // OLX detail pages carry the shipping signal elsewhere; Vinted shipping is
    // assumed available on every listing, so neither marketplace is checked.
    if (marketplace === 'OLX' || marketplace === 'Vinted') return;
    const unknown = listings.filter((listing) => listing.shippingAvailable === null).slice(0, Math.max(0, options.limit ?? 8));
    // Shipping rows found by the parallel page fetches are cached in one
    // commit after the loop instead of one implicit commit per listing.
    const resolved: NormalizedListing[] = [];
    for (let offset = 0; offset < unknown.length; offset += 2) {
      await Promise.all(unknown.slice(offset, offset + 2).map(async (listing) => {
        try {
          const html = await this.fetchPublicPage(listing.url, marketplace);
          const available = parseShippingAvailability(html, marketplace);
          if (available === null) return;
          listing.shippingAvailable = available;
          resolved.push(listing);
        } catch { /* unknown remains excluded and will be retried on a later scan */ }
      }));
    }
    if (resolved.length) {
      this.transaction(() => {
        for (const listing of resolved) this.cacheShipping(listing);
      });
    }
  }

  private cacheShipping(listing: NormalizedListing) {
    if (listing.shippingAvailable === null) return;
    const checked = nowIso();
    this.stmt(`INSERT INTO listings (marketplace, listing_id, title, price_pln, url, image_url, condition, location, shipping_available, price_negotiable, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(marketplace, listing_id) DO UPDATE SET shipping_available = excluded.shipping_available, price_negotiable = COALESCE(excluded.price_negotiable, listings.price_negotiable), last_seen_at = excluded.last_seen_at`).run(listing.marketplace, listing.listingId, listing.title, listing.price, listing.url, listing.imageUrl ?? null, listing.condition ?? null, listing.location ?? null, listing.shippingAvailable ? 1 : 0, listing.priceNegotiable === null || listing.priceNegotiable === undefined ? null : listing.priceNegotiable ? 1 : 0, checked, checked);
  }

  private storeManualListing(listing: NormalizedListing) {
    const observedAt = nowIso();
    this.stmt(`INSERT INTO listings (marketplace, listing_id, title, price_pln, url, image_url, condition, location, shipping_available, price_negotiable, posted_at, refreshed_at, promoted, seller_type, availability_status, last_verified_at, first_seen_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'live', ?, ?, ?)
      ON CONFLICT(marketplace, listing_id) DO UPDATE SET title = excluded.title, price_pln = excluded.price_pln, url = excluded.url, image_url = COALESCE(excluded.image_url, listings.image_url), condition = COALESCE(excluded.condition, listings.condition), location = COALESCE(excluded.location, listings.location), shipping_available = COALESCE(excluded.shipping_available, listings.shipping_available), price_negotiable = COALESCE(excluded.price_negotiable, listings.price_negotiable), posted_at = COALESCE(listings.posted_at, excluded.posted_at), refreshed_at = COALESCE(excluded.refreshed_at, listings.refreshed_at), promoted = COALESCE(excluded.promoted, listings.promoted), seller_type = COALESCE(excluded.seller_type, listings.seller_type), availability_status = 'live', last_verified_at = excluded.last_verified_at, last_seen_at = excluded.last_seen_at`).run(
      listing.marketplace, listing.listingId, listing.title, listing.price, listing.url, listing.imageUrl ?? null, listing.condition ?? null, listing.location ?? null,
      listing.shippingAvailable === null || listing.shippingAvailable === undefined ? null : listing.shippingAvailable ? 1 : 0,
      listing.priceNegotiable === null || listing.priceNegotiable === undefined ? null : listing.priceNegotiable ? 1 : 0,
      ...listingSignalParams(listing),
      observedAt, observedAt, observedAt,
    );
  }

  /**
   * Per-variant inputs every listing in a scan scores against: the latest
   * observed price per listing (the baseline distribution) bucketed by the
   * listing's assigned variant_key, plus each variant's first server-observed
   * timestamp. Computed once per source scan.
   *
   * The query is driven by the watch's associations, so its cost follows the
   * number of listings rather than the length of the observation history: for
   * each association two LIMIT-1 seeks into the (watch_id, listing_id,
   * observed_at, id) index find the newest and the oldest in-bounds
   * observation. INDEXED BY pins that index for both probes. Each association
   * is (watch_id, listing_id), which every observation's watch_listing_id
   * points at, so the rows match the old per-observation window query.
   *
   * With no configured groups every row lands in the single OTHER bucket, so
   * the legacy watch-wide baseline is reproduced unchanged. Each bucket keeps
   * its own newest 400 listings, so one dominant model can no longer crowd out
   * another model's samples.
   */
  private watchBaselines(row: WatchRow): WatchBaselines {
    const groups = parseVariantGroups(row.variant_groups_json);
    const rows = this.stmt(`SELECT o.price_pln, x.variant_key, x.first
      FROM (
        SELECT COALESCE(wl.variant_key, ?) AS variant_key,
          (SELECT o2.id FROM observations o2 INDEXED BY observations_watch_listing
            WHERE o2.watch_id = wl.watch_id AND o2.listing_id = wl.listing_id
              AND (? IS NULL OR o2.price_pln >= ?) AND (? IS NULL OR o2.price_pln <= ?)
            ORDER BY o2.observed_at DESC, o2.id DESC LIMIT 1) AS latest_id,
          (SELECT o3.observed_at FROM observations o3 INDEXED BY observations_watch_listing
            WHERE o3.watch_id = wl.watch_id AND o3.listing_id = wl.listing_id
              AND (? IS NULL OR o3.price_pln >= ?) AND (? IS NULL OR o3.price_pln <= ?)
            ORDER BY o3.observed_at ASC, o3.id ASC LIMIT 1) AS first
        FROM watch_listings wl JOIN listings l ON l.id = wl.listing_id
        WHERE wl.watch_id = ?
          AND (? = 0 OR NOT EXISTS (SELECT 1 FROM listing_relevance r WHERE r.watch_id = wl.watch_id AND r.marketplace = l.marketplace AND r.listing_id = l.listing_id AND (r.relevance_status = 'irrelevant' OR (r.relevance_status IS NULL AND r.relevant = 0))))
          AND (? = 0 OR (l.marketplace = 'Vinted' OR l.shipping_available = 1))
      ) x JOIN observations o ON o.id = x.latest_id
      ORDER BY o.observed_at DESC, o.id DESC`).all(
      OTHER_VARIANT_KEY,
      row.min_price_pln, row.min_price_pln, row.max_price_pln, row.max_price_pln,
      row.min_price_pln, row.min_price_pln, row.max_price_pln, row.max_price_pln,
      row.id,
      row.ai_relevance === false || row.ai_relevance === 0 ? 0 : 1,
      row.shipping_only ? 1 : 0,
    ) as Array<{ price_pln: number; variant_key: string; first: string | null }>;
    const buckets = new Map<string, WatchVariantBucket>();
    const bucketFor = (key: string) => {
      let bucket = buckets.get(key);
      if (!bucket) { bucket = { prices: [], firstObservedAt: null }; buckets.set(key, bucket); }
      return bucket;
    };
    const firstByVariant = new Map<string, string>();
    for (const item of rows) {
      const key = item.variant_key ?? OTHER_VARIANT_KEY;
      const first = item.first;
      if (first !== null && first !== undefined) {
        const known = firstByVariant.get(key);
        if (known === undefined || first < known) firstByVariant.set(key, first);
      }
      const price = Number(item.price_pln);
      if (!Number.isFinite(price) || price <= 0) continue;
      const bucket = bucketFor(key);
      // Rows arrive newest-first; 400 preserves the per-model ceiling the
      // watch-wide query used to apply globally.
      if (bucket.prices.length < 400) bucket.prices.push(price);
    }
    for (const [key, first] of firstByVariant) bucketFor(key).firstObservedAt = first;
    for (const bucket of buckets.values()) bucket.stats = priceStats(bucket.prices);
    // Other / unclassified is a mix by definition, so only named variants
    // feed the pooled spread.
    const pooled = groups.length
      ? pooledVariantSpread(groups.map((group) => buckets.get(group.id)?.prices ?? []))
      : null;
    return { groups, buckets, pooled };
  }

  /**
   * Score a listing against the watch baseline. Shared by `storeListing` and
   * the AI-relevance gate so both make the exact same deal-strength call.
   */
  private dealScore(
    row: WatchRow,
    price: number,
    baseline: WatchVariantBucket,
    referenceMedian: number | null,
    pooled: PooledSpread | null = null,
  ): { score: ScoreResult; useReference: boolean; dealStrength: number | null } {
    const observedHours = baseline.firstObservedAt ? Math.max(0, (Date.now() - Date.parse(baseline.firstObservedAt)) / 3_600_000) : 0;
    // The reference-band fallback seeds ranking/display only: while the watch's
    // own history is below the sample floor, its median stands in for the
    // typical. Once own samples reach the floor, own history always wins.
    const useReference = referenceMedian !== null && baseline.prices.length < (pooled ? VARIANT_MIN_SAMPLES : BASELINE_MIN_SAMPLES);
    const score = scoreDealFromStats(baseline.stats ?? priceStats(baseline.prices), price, { observedHours, sensitivity: Number(row.sensitivity ?? 1), ...(useReference ? { typicalOverride: referenceMedian } : {}), ...(pooled ? { pooled } : {}) });
    return { score, useReference, dealStrength: score.discountPercent === null ? null : dealStrength(price, score.typical) };
  }

  private storeListing(row: WatchRow, listing: NormalizedListing, scanId: number, baselines: WatchBaselines, referenceMedian: number | null = null, assignment?: VariantAssignment): DealNotificationCandidate | null {
    const groups = baselines.groups;
    // The variant is re-resolved on every observation, so a listing can move
    // model buckets if the marketplace retitles it; the new bucket's history
    // is the correct one from that point on. Manual picks are the exception.
    const resolved = assignment ?? this.scanVariantResolver(row, baselines).get(listing);
    const observedAt = nowIso();
    // RETURNING removes the follow-up SELECT for the row id on both the
    // insert and the conflict-update branch of each upsert.
    const stored = this.stmt(`INSERT INTO listings (marketplace, listing_id, title, price_pln, url, image_url, condition, location, shipping_available, price_negotiable, posted_at, refreshed_at, promoted, seller_type, availability_status, last_verified_at, first_seen_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'live', ?, ?, ?)
      ON CONFLICT(marketplace, listing_id) DO UPDATE SET title = excluded.title, price_pln = excluded.price_pln, url = excluded.url, image_url = COALESCE(excluded.image_url, listings.image_url), condition = COALESCE(excluded.condition, listings.condition), location = COALESCE(excluded.location, listings.location), shipping_available = COALESCE(excluded.shipping_available, listings.shipping_available), price_negotiable = COALESCE(excluded.price_negotiable, listings.price_negotiable), posted_at = COALESCE(listings.posted_at, excluded.posted_at), refreshed_at = COALESCE(excluded.refreshed_at, listings.refreshed_at), promoted = COALESCE(excluded.promoted, listings.promoted), seller_type = COALESCE(excluded.seller_type, listings.seller_type), availability_status = 'live', ended_reason = NULL, last_verified_at = excluded.last_verified_at, last_seen_at = excluded.last_seen_at
      RETURNING id`).get(listing.marketplace, listing.listingId, listing.title, listing.price, listing.url, listing.imageUrl ?? null, listing.condition ?? null, listing.location ?? null, listing.shippingAvailable === null ? null : listing.shippingAvailable ? 1 : 0, listing.priceNegotiable === null || listing.priceNegotiable === undefined ? null : listing.priceNegotiable ? 1 : 0, ...listingSignalParams(listing), observedAt, observedAt, observedAt) as { id: number };
    // A manual pick saved while this scan ran still wins over the scan's
    // view, and scoring uses whatever variant the row ends up with.
    const association = this.stmt(`INSERT INTO watch_listings (watch_id, listing_id, variant_key, variant_source, first_seen_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(watch_id, listing_id) DO UPDATE SET last_seen_at = excluded.last_seen_at,
        variant_key = CASE WHEN watch_listings.variant_source = 'manual' THEN watch_listings.variant_key ELSE excluded.variant_key END,
        variant_source = CASE WHEN watch_listings.variant_source = 'manual' THEN 'manual' ELSE excluded.variant_source END
      RETURNING id, variant_key`).get(row.id, stored.id, groups.length ? resolved.key : null, resolved.source, observedAt, observedAt) as { id: number; variant_key: string | null };
    const variantKey = association.variant_key;
    const variantLabel = variantKey ? variantLabelFor(variantKey, groups) : null;
    const { score, useReference, dealStrength: scoredStrength } = this.variantDealScore(row, listing.price, baselines, variantKey ?? OTHER_VARIANT_KEY, referenceMedian);
    // An unchanged price does not add a row per scan. A same-day run of one
    // price keeps its first row untouched (so MIN(observed_at) readiness and
    // first-observed gates never move) plus one trailing row that later scans
    // advance. Daily analytics read each day's latest row, so they see the
    // same price and score as with a row per scan; a price change or a new
    // UTC day always starts a new row.
    const recent = this.stmt('SELECT id, price_pln, observed_at FROM observations WHERE watch_id = ? AND listing_id = ? ORDER BY observed_at DESC, id DESC LIMIT 2').all(row.id, stored.id) as Array<{ id: number; price_pln: number; observed_at: string }>;
    const observedDay = observedAt.slice(0, 10);
    const extendsRun = recent.length === 2 && recent.every((item) => Number(item.price_pln) === listing.price && String(item.observed_at).slice(0, 10) === observedDay);
    let observationId: number;
    if (extendsRun) {
      observationId = Number(recent[0].id);
      this.stmt('UPDATE observations SET watch_listing_id = ?, scan_id = ?, observed_at = ?, baseline_pln = NULL, discount_percent = NULL, deal_strength = NULL, deal_label = NULL WHERE id = ?').run(association.id, scanId, observedAt, observationId);
    } else {
      observationId = Number(this.stmt('INSERT INTO observations (listing_id, watch_id, watch_listing_id, scan_id, price_pln, observed_at) VALUES (?, ?, ?, ?, ?, ?)').run(stored.id, row.id, association.id, scanId, listing.price, observedAt).lastInsertRowid);
    }
    if (score.isReady && score.typical !== null) {
      const discountPercent = score.discountPercent ?? 0;
      const dealStrength = scoredStrength ?? 1;
      const dealLabel = dealLabelFromStrength(dealStrength);
      this.stmt("UPDATE watch_listings SET typical_pln = ?, deal_strength = ?, deal_label = ?, typical_source = 'own-history', last_seen_at = ? WHERE id = ?").run(score.typical, dealStrength, dealLabel, observedAt, association.id);
      this.stmt('UPDATE observations SET baseline_pln = ?, discount_percent = ?, deal_strength = ?, deal_label = ? WHERE id = ?').run(score.typical, discountPercent, dealStrength, dealLabel, observationId);
      if (score.qualifies) return {
        watchId: String(row.id),
        listing,
        typical: score.typical,
        discountPercent,
        confidence: score.confidence,
        requiresDescriptionVerification: dealStrength >= 4,
        query: String(row.query ?? ''),
        includedTerms: String(row.included_terms ?? ''),
        excludedTerms: String(row.excluded_terms ?? ''),
        verificationChecks: parseVerificationChecks(row.verification_checks_json),
        variantKey,
        variantLabel,
      };
    } else if (useReference && score.typical !== null) {
      // Band-seeded display values; the readiness gate is untouched, so no
      // alerts fire earlier than they would without a reference series.
      const discountPercent = score.discountPercent ?? 0;
      const dealStrength = scoredStrength ?? 1;
      const dealLabel = dealLabelFromStrength(dealStrength);
      this.stmt("UPDATE watch_listings SET typical_pln = ?, deal_strength = ?, deal_label = ?, typical_source = 'reference-band', last_seen_at = ? WHERE id = ?").run(score.typical, dealStrength, dealLabel, observedAt, association.id);
    } else {
      this.stmt('UPDATE observations SET baseline_pln = NULL, discount_percent = NULL WHERE id = ?').run(observationId);
    }
    return null;
  }

  private latestDigestCandidate(watchId: string, listing: NormalizedListing) {
    return this.stmt(`SELECT sequence, price_pln AS last_alerted_price_pln, priority AS last_priority
      FROM daily_digest_candidates WHERE watch_id = ? AND marketplace = ? AND listing_id = ?
      ORDER BY sequence DESC LIMIT 1`).get(watchId, listing.marketplace, listing.listingId) as { sequence?: number; last_alerted_price_pln?: number; last_priority?: NotificationPriority } | undefined;
  }

  private queueDailyDigestCandidate(watchId: string, listing: NormalizedListing, typical: number, discountPercent: number, confidence: number, priority: NotificationPriority) {
    const latest = this.latestDigestCandidate(watchId, listing);
    if (!this.shouldAlert(latest, listing.price, priority)) return false;
    const sequence = Number(latest?.sequence ?? 0) + 1;
    this.stmt(`INSERT INTO daily_digest_candidates (
      watch_id, marketplace, listing_id, sequence, title, url, image_url, price_pln,
      typical_pln, discount_percent, confidence, priority, observed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      watchId, listing.marketplace, listing.listingId, sequence, listing.title, listing.url,
      listing.imageUrl ?? null, listing.price, typical, discountPercent, confidence, priority, listing.observedAt || nowIso(),
    );
    return true;
  }

  private digestDiscordPayload(date: string, rows: DigestCandidateRow[]) {
    const shown = rows.slice(0, 8);
    const hidden = rows.length - shown.length;
    return {
      username: 'Scout',
      embeds: [{
        title: `Daily deal digest · ${date}`,
        description: `${rows.length} new or meaningfully improved ${rows.length === 1 ? 'deal' : 'deals'} since the previous digest.${hidden ? ` Showing the strongest ${shown.length}.` : ''}`,
        color: 0x1d61e8,
        fields: shown.map((row) => ({
          name: `${row.discount_percent.toFixed(1)}% below typical · ${row.marketplace} · ${row.watch_name}`.slice(0, 256),
          value: `[${escapeDiscordMarkdown(row.title.replace(/[\r\n]+/g, ' ').slice(0, 180))}](${row.url})\n${Number(row.price_pln).toLocaleString('pl-PL')} zł · typical ${Number(row.typical_pln).toLocaleString('pl-PL')} zł · ${row.confidence}% confidence`.slice(0, 1024),
        })),
        footer: { text: 'Scout · daily digest · asking prices' },
        timestamp: nowIso(),
      }],
    };
  }

  private digestNtfyPayload(config: NtfyConfig, date: string, rows: DigestCandidateRow[]) {
    const shown = rows.slice(0, 5);
    const hidden = rows.length - shown.length;
    return {
      topic: config.topic,
      title: `Scout daily digest · ${date} · ${rows.length} ${rows.length === 1 ? 'deal' : 'deals'}`,
      message: [
        ...shown.map((row) => `${row.discount_percent.toFixed(1)}% · ${row.title} · ${Number(row.price_pln).toLocaleString('pl-PL')} zł\n${row.url}`),
        ...(hidden ? [`+ ${hidden} more deal${hidden === 1 ? '' : 's'} in Scout`] : []),
      ].join('\n\n'),
      priority: 3,
      tags: ['moneybag', 'calendar'],
      click: config.openInApp ? SCOUT_APP_DEALS_LINK : shown[0]?.url ?? config.serverUrl,
      ...(config.openInApp && shown[0] ? { actions: [{ action: 'view' as const, label: 'Open top deal', url: shown[0].url, clear: true }] } : {}),
    };
  }

  private async deliverClaimedDigest(input: { deliveryKey: string; eventKey: string; channel: DigestChannel; payload: Record<string, any>; attemptCount: number }) {
    const started = nowIso();
    const { _scoutDigest: _metadata, ...deliveryPayload } = input.payload;
    try {
      if (input.channel === 'Discord') {
        const encrypted = this.getSetting('discord_webhook');
        if (!encrypted) throw new Error('Discord webhook is not configured');
        const response = await fetch(validateDiscordWebhook(decryptSecret(encrypted)), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(deliveryPayload), signal: AbortSignal.timeout(12_000) });
        discardResponse(response, 'discord-webhook');
        if (!response.ok) throw new Error(`Discord returned ${response.status}`);
      } else {
        const config = this.ntfyConfig();
        if (!config) throw new Error('ntfy is not configured');
        await publishNtfy(config, deliveryPayload as ReturnType<typeof this.digestNtfyPayload>);
      }
      const finished = nowIso();
      this.transaction(() => {
        this.stmt("UPDATE notification_deliveries SET status = 'delivered', sent_at = ?, next_attempt_at = NULL, updated_at = ? WHERE listing_key = ? AND channel = ?").run(finished, finished, input.deliveryKey, input.channel);
        this.stmt("UPDATE notifications SET status = 'delivered', sent_at = ? WHERE listing_key = ?").run(finished, input.eventKey);
        this.setSetting('daily_digest_last_sent_at', finished);
      });
      this.recordRun(input.channel, 'ok', `${input.channel} daily digest delivered`, started, finished);
      this.emit('notification', { refresh: true });
      return 'delivered' as const;
    } catch (error) {
      const message = (error instanceof Error ? error.message : `${input.channel} digest delivery failed`).slice(0, 500);
      const nextAttempt = input.attemptCount < 5 ? new Date(Date.now() + exponentialBackoff(input.attemptCount - 1, 30_000, 6 * 60 * 60_000)).toISOString() : null;
      this.stmt("UPDATE notification_deliveries SET status = 'failed', message = ?, next_attempt_at = ?, updated_at = ? WHERE listing_key = ? AND channel = ?").run(message, nextAttempt, nowIso(), input.deliveryKey, input.channel);
      this.stmt("UPDATE notifications SET status = 'failed' WHERE listing_key = ?").run(input.eventKey);
      this.recordRun(input.channel, 'error', message, started, nowIso());
      return 'failed' as const;
    }
  }

  private async processDailyDigest() {
    if (this.digestRunning) return;
    const config = this.dailyDigestConfig();
    if (!config.enabled) return;
    const local = this.localDateAndTime();
    if (local.time < config.time || this.getSetting('daily_digest_last_date') === local.date) return;
    const encryptedDiscord = this.getSetting('discord_webhook');
    const ntfy = this.ntfyConfig();
    const channels: DigestChannel[] = [];
    if (config.discord && encryptedDiscord) channels.push('Discord');
    if (config.ntfy && ntfy) channels.push('ntfy');
    if (!channels.length) return;
    this.digestRunning = true;
    try {
      const candidates = this.stmt(`SELECT c.*, w.name AS watch_name
        FROM daily_digest_candidates c JOIN watches w ON w.id = c.watch_id
        WHERE c.digest_date IS NULL
          AND NOT EXISTS (SELECT 1 FROM listing_actions a WHERE a.marketplace = c.marketplace AND a.listing_id = c.listing_id AND a.hidden = 1)
        ORDER BY c.discount_percent DESC, c.observed_at ASC, c.id ASC`).all() as DigestCandidateRow[];
      const planned: Array<{ channel: DigestChannel; eventKey: string; payload: Record<string, any> }> = [];
      this.transaction(() => {
        for (const channel of channels) {
          const minimum = channel === 'Discord' ? this.discordMinimumPriority() : ntfy!.minimumPriority;
          const eligible = candidates.filter((row) => meetsMinimumPriority(row.priority, minimum));
          if (!eligible.length) continue;
          const eventKey = `digest:${local.date}:${channel.toLowerCase()}`;
          const payload = channel === 'Discord' ? this.digestDiscordPayload(local.date, eligible) : this.digestNtfyPayload(ntfy!, local.date, eligible);
          const stored = { ...payload, _scoutDigest: { channel, date: local.date, count: eligible.length } };
          this.stmt('INSERT OR IGNORE INTO notifications (listing_key, payload_json, status, created_at) VALUES (?, ?, ?, ?)').run(eventKey, JSON.stringify(stored), 'pending', nowIso());
          planned.push({ channel, eventKey, payload: stored });
        }
        if (planned.length) {
          const eligibleIds = new Set<number>();
          for (const row of candidates) {
            if (channels.some((channel) => meetsMinimumPriority(row.priority, channel === 'Discord' ? this.discordMinimumPriority() : ntfy!.minimumPriority))) eligibleIds.add(Number(row.id));
          }
          const update = this.stmt('UPDATE daily_digest_candidates SET digest_date = ? WHERE id = ?');
          for (const id of eligibleIds) update.run(local.date, id);
        }
        if (planned.length) this.setSetting('daily_digest_last_date', local.date);
      });
      const claimed = planned.map((item) => ({ ...item, claim: this.claimNotificationDelivery(item.eventKey, item.channel) })).filter((item) => item.claim !== null);
      await Promise.all(claimed.map((item) => this.deliverClaimedDigest({ deliveryKey: item.eventKey, eventKey: item.eventKey, channel: item.channel, payload: item.payload, attemptCount: item.claim!.attemptCount })));
    } finally {
      this.digestRunning = false;
    }
  }

  /** A manually hidden listing never alerts, regardless of its deterministic or AI score. */
  private isListingHidden(listing: NormalizedListing) {
    const row = this.stmt('SELECT hidden FROM listing_actions WHERE marketplace = ? AND listing_id = ?').get(listing.marketplace, listing.listingId) as { hidden?: number } | undefined;
    return Number(row?.hidden ?? 0) === 1;
  }

  private notificationEventKey(watchId: string, listing: NormalizedListing, sequence: number, legacy = false) {
    return legacy ? notificationKey(listing) : `${watchId}|${listing.marketplace}|${listing.listingId}|alert:${sequence}`;
  }

  private notificationDeliveryKey(eventKey: string, channel: 'Discord' | 'ntfy', legacy = false) {
    return legacy ? eventKey : `${eventKey}|channel:${channel}`;
  }

  private notificationMeta(payload: Record<string, any>) {
    return payload._scout as {
      watchId: string;
      listing: NormalizedListing;
      typical: number;
      discountPercent: number;
      confidence: number;
      priority: NotificationPriority;
      sequence: number;
      variantLabel?: string | null;
    } | undefined;
  }

  private claimNotificationDelivery(listingKey: string, channel: 'Discord' | 'ntfy', createdAt = nowIso()) {
    const staleBefore = new Date(Date.now() - 15 * 60_000).toISOString();
    const maxAttempts = 5;
    return this.transaction(() => {
      const existing = this.stmt('SELECT id, status, attempt_count, next_attempt_at, updated_at, created_at FROM notification_deliveries WHERE listing_key = ? AND channel = ?').get(listingKey, channel) as Record<string, any> | undefined;
      if (existing) {
        const attempts = Number(existing.attempt_count ?? 0);
        const updatedAt = String(existing.updated_at ?? existing.created_at ?? '');
        if (existing.status === 'delivered' || attempts >= maxAttempts) return null;
        if (existing.status === 'failed' && existing.next_attempt_at && Date.parse(existing.next_attempt_at) > Date.now()) return null;
        if (existing.status === 'pending' && updatedAt && Date.parse(updatedAt) > Date.parse(staleBefore)) return null;
        const nextAttempt = attempts + 1;
        this.stmt("UPDATE notification_deliveries SET status = 'pending', attempt_count = ?, next_attempt_at = NULL, updated_at = ? WHERE id = ?").run(nextAttempt, createdAt, existing.id);
        return { id: Number(existing.id), attemptCount: nextAttempt };
      }
      const result = this.stmt("INSERT INTO notification_deliveries (listing_key, channel, status, attempt_count, next_attempt_at, updated_at, created_at) VALUES (?, ?, 'pending', 1, NULL, ?, ?)").run(listingKey, channel, createdAt, createdAt);
      return { id: Number(result.lastInsertRowid), attemptCount: 1 };
    });
  }

  private latestDeliveryForAlert(watchId: string, listing: NormalizedListing, channel: 'Discord' | 'ntfy') {
    const prefix = `${watchId}|${listing.marketplace}|${listing.listingId}|alert:`;
    return this.stmt("SELECT listing_key, status, attempt_count, next_attempt_at, updated_at, created_at FROM notification_deliveries WHERE channel = ? AND listing_key LIKE ? ESCAPE '\\' ORDER BY id DESC LIMIT 1").get(channel, `${ScoutService.escapeLike(prefix)}%|channel:${channel}`) as Record<string, any> | undefined;
  }

  private alertState(watchId: string, listing: NormalizedListing, channel: 'Discord' | 'ntfy') {
    return this.stmt('SELECT last_alerted_price_pln, last_priority, alert_sequence FROM watch_listing_alert_state WHERE watch_id = ? AND marketplace = ? AND listing_id = ? AND channel = ?').get(watchId, listing.marketplace, listing.listingId, channel) as { last_alerted_price_pln?: number; last_priority?: NotificationPriority; alert_sequence?: number } | undefined;
  }

  private shouldAlert(state: { last_alerted_price_pln?: number; last_priority?: NotificationPriority } | undefined, price: number, priority: NotificationPriority) {
    if (!state) return true;
    const priorityIncreased = state.last_priority && notificationPriorityRank[priority] > notificationPriorityRank[state.last_priority];
    const priceDropped = Number.isFinite(state.last_alerted_price_pln) && price <= Number(state.last_alerted_price_pln) * 0.95;
    return Boolean(priorityIncreased || priceDropped);
  }

  private async deliverClaimedNotification(input: {
    deliveryKey: string;
    eventKey: string;
    channel: 'Discord' | 'ntfy';
    watchId?: string;
    sequence?: number;
    listing: NormalizedListing;
    typical: number;
    discountPercent: number;
    confidence: number;
    priority: NotificationPriority;
    attemptCount: number;
    encryptedDiscord?: string;
    ntfy: NtfyConfig | null;
    variantLabel?: string | null;
    legacy?: boolean;
  }) {
    const started = nowIso();
    try {
      if (input.channel === 'Discord') {
        if (!input.encryptedDiscord) throw new Error('Discord webhook is not configured');
        const response = await fetch(validateDiscordWebhook(decryptSecret(input.encryptedDiscord)), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(buildDiscordEmbed({ listing: input.listing, typical: input.typical, discountPercent: input.discountPercent, confidence: input.confidence, variantLabel: input.variantLabel })), signal: AbortSignal.timeout(12_000) });
        discardResponse(response, 'discord-webhook');
        if (!response.ok) throw new Error(`Discord returned ${response.status}`);
      } else {
        if (!input.ntfy) throw new Error('ntfy is not configured');
        await publishNtfy(input.ntfy, buildNtfyPayload({ listing: input.listing, typical: input.typical, discountPercent: input.discountPercent, confidence: input.confidence, variantLabel: input.variantLabel }, input.ntfy.topic, input.priority, { openInApp: input.ntfy.openInApp, watchId: input.watchId }));
      }
      const finished = nowIso();
      this.transaction(() => {
        this.stmt("UPDATE notification_deliveries SET status = 'delivered', sent_at = ?, next_attempt_at = NULL, updated_at = ? WHERE listing_key = ? AND channel = ?").run(finished, finished, input.deliveryKey, input.channel);
        const canPersistWatchState = !input.legacy && input.watchId !== undefined && input.sequence !== undefined && Boolean(this.stmt('SELECT 1 FROM watches WHERE id = ?').get(input.watchId));
        if (canPersistWatchState) {
          this.stmt(`INSERT INTO watch_listing_alert_state (watch_id, marketplace, listing_id, channel, last_alerted_price_pln, last_priority, alert_sequence, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(watch_id, marketplace, listing_id, channel) DO UPDATE SET last_alerted_price_pln = excluded.last_alerted_price_pln, last_priority = excluded.last_priority, alert_sequence = excluded.alert_sequence, updated_at = excluded.updated_at`).run(input.watchId, input.listing.marketplace, input.listing.listingId, input.channel, input.listing.price, input.priority, input.sequence, finished);
          this.stmt("UPDATE notifications SET status = 'delivered', sent_at = ? WHERE listing_key = ?").run(finished, input.eventKey);
        } else {
          this.stmt("UPDATE notifications SET status = 'delivered', sent_at = ? WHERE listing_key = ?").run(finished, input.eventKey);
        }
      });
      this.recordRun(input.channel, 'ok', `${input.channel} notification delivered`, started, finished);
      this.emit('notification', { refresh: true });
      return 'delivered' as const;
    } catch (error) {
      const message = (error instanceof Error ? error.message : `${input.channel} delivery failed`).slice(0, 500);
      const nextAttempt = input.attemptCount < 5 ? new Date(Date.now() + exponentialBackoff(input.attemptCount - 1, 30_000, 6 * 60 * 60_000)).toISOString() : null;
      this.stmt("UPDATE notification_deliveries SET status = 'failed', message = ?, next_attempt_at = ?, updated_at = ? WHERE listing_key = ? AND channel = ?").run(message, nextAttempt, nowIso(), input.deliveryKey, input.channel);
      this.stmt("UPDATE notifications SET status = 'failed' WHERE listing_key = ? AND status <> 'delivered'").run(input.eventKey);
      this.recordRun(input.channel, 'error', message, started, nowIso());
      return 'failed' as const;
    }
  }

  /**
   * The first four arguments are kept backward-compatible for existing
   * integrations/tests. New scan code always supplies watchId explicitly.
   */
  /**
   * The write-free part of notifyDeal: whether the listing is hidden, whether
   * a digest entry would be queued, and which channels would send, with the
   * alert sequence and keys each would use. A channel reads only its own
   * alert state and deliveries, so planning every channel before any write
   * decides exactly what the interleaved loop used to.
   */
  private planDealNotification(watchId: string, listing: NormalizedListing, discountPercent: number, context?: ScanNotifyContext, legacy = false) {
    const priority = priorityFromDiscount(discountPercent);
    const channels: Array<{ channel: 'Discord' | 'ntfy'; sequence: number; eventKey: string; deliveryKey: string }> = [];
    if (this.isListingHidden(listing)) return { hidden: true, priority, encryptedDiscord: null, ntfy: null, digestQualifies: false, digestDue: false, channels };
    const encryptedDiscord = context?.encryptedDiscord ?? this.getSetting('discord_webhook');
    const ntfy = context?.ntfy ?? this.ntfyConfig();
    const plan = { hidden: false, priority, encryptedDiscord, ntfy, digestQualifies: false, digestDue: false, channels };
    const digest = context?.digest ?? this.dailyDigestConfig();
    const discordMinimum = context?.discordMinimumPriority ?? this.discordMinimumPriority();
    const digestSelected = (channel: DigestChannel) => digest.enabled && (channel === 'Discord' ? digest.discord : digest.ntfy);
    if (!legacy && priority !== 'exceptional') {
      plan.digestQualifies = (digestSelected('Discord') && Boolean(encryptedDiscord) && meetsMinimumPriority(priority, discordMinimum))
        || (digestSelected('ntfy') && Boolean(ntfy) && meetsMinimumPriority(priority, ntfy?.minimumPriority ?? 'exceptional'));
      // queueDailyDigestCandidate's own check: a digest row is added only
      // when the listing is new to the digest or improved enough.
      plan.digestDue = plan.digestQualifies && this.shouldAlert(this.latestDigestCandidate(watchId, listing), listing.price, priority);
    }
    const eligible: Array<'Discord' | 'ntfy'> = [];
    if (encryptedDiscord && meetsMinimumPriority(priority, discordMinimum) && (priority === 'exceptional' || !digestSelected('Discord'))) eligible.push('Discord');
    if (ntfy && meetsMinimumPriority(priority, ntfy.minimumPriority) && (priority === 'exceptional' || !digestSelected('ntfy'))) eligible.push('ntfy');
    for (const channel of eligible) {
      let sequence = 1;
      let eventKey = notificationKey(listing);
      let deliveryKey = eventKey;
      if (!legacy) {
        const state = this.alertState(watchId, listing, channel);
        const latest = this.latestDeliveryForAlert(watchId, listing, channel);
        const latestSequence = latest?.listing_key ? Number(latest.listing_key.match(/\|alert:(\d+)\|channel:/)?.[1] ?? 0) : 0;
        const latestDue = latest && latest.status !== 'delivered' && Number(latest.attempt_count ?? 0) < 5
          && !(latest.status === 'failed' && latest.next_attempt_at && Date.parse(latest.next_attempt_at) > Date.now())
          && !(latest.status === 'pending' && latest.updated_at && Date.parse(latest.updated_at) > Date.now() - 15 * 60_000);
        if (latestDue) sequence = latestSequence || Number(state?.alert_sequence ?? 1);
        else if (latest && latest.status !== 'delivered' && Number(latest.attempt_count ?? 0) < 5) continue;
        else if (!this.shouldAlert(state, listing.price, priority)) continue;
        else sequence = Math.max(Number(state?.alert_sequence ?? 0), latestSequence) + 1;
        eventKey = this.notificationEventKey(watchId, listing, sequence);
        deliveryKey = this.notificationDeliveryKey(eventKey, channel);
      }
      channels.push({ channel, sequence, eventKey, deliveryKey });
    }
    return plan;
  }

  private async notifyDeal(
    watchIdOrListing: string | NormalizedListing,
    listingOrTypical: NormalizedListing | number,
    typicalOrDiscount: number,
    discountOrConfidence: number,
    maybeConfidence?: number,
    context?: ScanNotifyContext,
    variantLabel?: string | null,
  ) {
    const legacy = typeof watchIdOrListing !== 'string';
    const watchId = legacy ? '__legacy__' : watchIdOrListing;
    const listing = (legacy ? watchIdOrListing : listingOrTypical) as NormalizedListing;
    const typical = (legacy ? listingOrTypical : typicalOrDiscount) as number;
    const discountPercent = legacy ? typicalOrDiscount : discountOrConfidence;
    const confidence = legacy ? discountOrConfidence : maybeConfidence!;
    const plan = this.planDealNotification(watchId, listing, discountPercent, context, legacy);
    if (plan.hidden) return;
    const { priority, encryptedDiscord, ntfy } = plan;
    if (plan.digestQualifies) this.queueDailyDigestCandidate(watchId, listing, typical, discountPercent, confidence, priority);
    if (!plan.channels.length) return;

    const planned: Array<{ channel: 'Discord' | 'ntfy'; eventKey: string; deliveryKey: string; sequence?: number; claim: { id: number; attemptCount: number }; legacy: boolean }> = [];
    for (const { channel, sequence, eventKey, deliveryKey } of plan.channels) {
      const payload = { ...buildDiscordEmbed({ listing, typical, discountPercent, confidence, variantLabel }), _scout: { watchId, listing, typical, discountPercent, confidence, priority, sequence, variantLabel } };
      this.stmt('INSERT OR IGNORE INTO notifications (listing_key, payload_json, status, created_at) VALUES (?, ?, ?, ?)').run(eventKey, JSON.stringify(payload), 'pending', nowIso());
      const claim = this.claimNotificationDelivery(deliveryKey, channel);
      if (claim) planned.push({ channel, eventKey, deliveryKey, sequence: legacy ? undefined : sequence, claim, legacy });
    }
    if (!planned.length) return;
    await Promise.all(planned.map((item) => this.deliverClaimedNotification({
      deliveryKey: item.deliveryKey,
      eventKey: item.eventKey,
      channel: item.channel,
      watchId: legacy ? undefined : watchId,
      sequence: item.sequence,
      listing,
      typical,
      discountPercent,
      confidence,
      priority,
      attemptCount: item.claim.attemptCount,
      encryptedDiscord: encryptedDiscord ?? undefined,
      ntfy,
      variantLabel,
      legacy: item.legacy,
    })));
  }

  private async processNotificationRetries() {
    const now = nowIso();
    const stale = new Date(Date.now() - 15 * 60_000).toISOString();
    const rows = this.stmt(`SELECT nd.listing_key, nd.channel, nd.attempt_count, n.listing_key AS event_key, n.payload_json
      FROM notification_deliveries nd
      JOIN notifications n ON n.listing_key = CASE WHEN instr(nd.listing_key, '|channel:') > 0 THEN substr(nd.listing_key, 1, instr(nd.listing_key, '|channel:') - 1) ELSE nd.listing_key END
      WHERE nd.attempt_count < 5 AND ((nd.status = 'failed' AND nd.next_attempt_at IS NOT NULL AND nd.next_attempt_at <= ?) OR (nd.status = 'pending' AND COALESCE(nd.updated_at, nd.created_at) <= ?))
      ORDER BY nd.id ASC LIMIT 50`).all(now, stale) as Array<Record<string, any>>;
    for (const row of rows) {
      const payload = parseJson<Record<string, any>>(row.payload_json, {});
      const digestMeta = payload._scoutDigest as { channel?: DigestChannel } | undefined;
      if (digestMeta?.channel === 'Discord' || digestMeta?.channel === 'ntfy') {
        const claim = this.claimNotificationDelivery(String(row.listing_key), digestMeta.channel);
        if (!claim) continue;
        await this.deliverClaimedDigest({
          deliveryKey: String(row.listing_key),
          eventKey: String(row.event_key),
          channel: digestMeta.channel,
          payload,
          attemptCount: claim.attemptCount,
        });
        continue;
      }
      const meta = this.notificationMeta(payload);
      if (!meta) continue;
      // A listing hidden after it was queued should not deliver on retry.
      if (this.isListingHidden(meta.listing)) continue;
      const claim = this.claimNotificationDelivery(String(row.listing_key), row.channel as 'Discord' | 'ntfy');
      if (!claim) continue;
      await this.deliverClaimedNotification({
        deliveryKey: String(row.listing_key),
        eventKey: String(row.event_key),
        channel: row.channel as 'Discord' | 'ntfy',
        watchId: meta.watchId === '__legacy__' ? undefined : meta.watchId,
        sequence: meta.sequence,
        listing: meta.listing,
        typical: Number(meta.typical),
        discountPercent: Number(meta.discountPercent),
        confidence: Number(meta.confidence),
        priority: meta.priority,
        attemptCount: claim.attemptCount,
        encryptedDiscord: this.getSetting('discord_webhook') ?? undefined,
        ntfy: this.ntfyConfig(),
        variantLabel: meta.variantLabel,
        legacy: meta.watchId === '__legacy__',
      });
    }
  }

  private recordRun(source: string, status: string, message: string, startedAt: string, finishedAt: string | null) {
    const result = this.stmt('INSERT INTO connector_runs (source, status, message, started_at, finished_at) VALUES (?, ?, ?, ?, ?)').run(source, status, message, startedAt, finishedAt);
    // Every caller runs in autocommit, so the row is committed here. Inside an
    // open transaction a rollback could drop it, so recount instead.
    const counts = this.connectorRunCountCache?.counts;
    if ((this.db as { isTransaction?: boolean }).isTransaction) this.connectorRunCountCache = null;
    else if (counts) counts.set(source, (counts.get(source) ?? 0) + 1);
    return Number(result.lastInsertRowid);
  }

  /**
   * Backoff comes from the latest finished outcome (ok/error), never from
   * skipped or in-flight rows: a skip recorded while backoff is active must
   * not clear it, and a concurrent 'running' row must not hide it.
   */
  private activeConnectorBackoff(source: string): string | null {
    const latest = this.stmt("SELECT backoff_until FROM connector_runs WHERE source = ? AND status IN ('ok', 'error') ORDER BY started_at DESC, id DESC LIMIT 1").get(source) as { backoff_until?: string | null } | undefined;
    return latest?.backoff_until && Date.parse(latest.backoff_until) > Date.now() ? latest.backoff_until : null;
  }

  /** Backoff deadline for a failed run; doubles with each consecutive failed outcome, ignoring skips. */
  private connectorBackoffAfterFailure(source: string, runId: number): string {
    const recent = this.stmt("SELECT status FROM connector_runs WHERE source = ? AND id != ? AND status IN ('ok', 'error') ORDER BY started_at DESC, id DESC LIMIT 8").all(source, runId) as Array<{ status: string }>;
    const streak = recent.findIndex((run) => run.status !== 'error');
    return new Date(Date.now() + exponentialBackoff(streak === -1 ? recent.length : streak)).toISOString();
  }

  /**
   * A misconfigured watch fails its own scan but is recorded as a warning
   * without backoff: 'warning' rows are outside the ok/error outcomes that
   * drive backoff, so one bad category cannot stall every watch on the
   * connector or lengthen the next real outage's backoff.
   */
  private finishFailedRun(runId: number, source: string, error: unknown, message: string) {
    if (error instanceof SearchConfigError) this.finishRun(runId, 'warning', message);
    else this.finishRun(runId, 'error', message, this.connectorBackoffAfterFailure(source, runId));
  }

  private finishRun(id: number, status: string, message: string, backoffUntil: string | null = null) {
    this.stmt('UPDATE connector_runs SET status = ?, message = ?, finished_at = ?, backoff_until = ? WHERE id = ?').run(status, message, nowIso(), backoffUntil, id);
  }
}

export function sellerTypeFromRow(value: unknown): SellerType | null {
  return value === 'private' || value === 'business' ? value : null;
}

/** posted_at, refreshed_at, promoted, seller_type for the listings upserts. */
function listingSignalParams(listing: NormalizedListing): [string | null, string | null, number | null, string | null] {
  return [listing.postedAt ?? null, listing.refreshedAt ?? null, listing.promoted === null || listing.promoted === undefined ? null : listing.promoted ? 1 : 0, listing.sellerType ?? null];
}

/**
 * Scout no longer filters by location: shipped listings from anywhere count.
 * The API still reports this value (and the columns keep it) because older
 * iOS builds decode `location` as a required field.
 */
export const NO_LOCATION_FILTER = 'Polska';

/** Read a stored OLX category, dropping anything malformed rather than scanning with a bad id. */
export function olxCategoryFromJson(value: unknown): OlxCategory | null {
  const parsed = typeof value === 'string' && value ? parseJson<unknown>(value, null) : null;
  if (!parsed || typeof parsed !== 'object') return null;
  const { id, label, path } = parsed as Record<string, unknown>;
  if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) return null;
  return { id, label: typeof label === 'string' ? label : String(id), path: typeof path === 'string' ? path : '' };
}

export function olxCategoryToJson(category: OlxCategory | null | undefined): string | null {
  return category ? JSON.stringify({ id: category.id, label: category.label, path: category.path }) : null;
}

function relativeTimeFuture(value?: string | null) {
  if (!value) return 'due now';
  const diff = Date.parse(value) - Date.now();
  if (diff <= 0) return 'due now';
  const minutes = Math.max(1, Math.ceil(diff / 60_000));
  return minutes < 60 ? `in ${minutes}m` : `in ${Math.ceil(minutes / 60)}h`;
}

export type ListingFilters = {
  shippingOnly?: boolean;
  minPrice?: number | null;
  maxPrice?: number | null;
  condition?: string;
  /**
   * Keep only this seller type. Listings whose type the marketplace does not
   * report are kept: an unknown flag is not evidence of a dealer.
   */
  sellerType?: SellerType | null;
  /** Drop paid placements and highlights. */
  ignorePromoted?: boolean;
  /**
   * Manual search only: when the strict all-terms match returns nothing, accept
   * listings that match a majority of the implicit query tokens instead of
   * dropping the whole page. Never relaxes user-typed included/excluded terms.
   */
  relaxTerms?: boolean;
};

/** Query filler that carries no product signal on its own (Polish + English). */
const QUERY_STOPWORDS = new Set([
  'do', 'na', 'w', 'we', 'z', 'ze', 'i', 'oraz', 'dla', 'od', 'po', 'za', 'o', 'a', 'u',
  'the', 'for', 'with', 'and', 'to', 'of', 'in', 'on', 'at', 'by',
]);

/**
 * Implicit query tokens. Single-character digits are kept (so "iphone 5" still
 * constrains the model) while single letters and stopwords are dropped — but
 * only while at least one meaningful token survives, so a query that is all
 * stopwords still filters on what the user typed.
 */
function queryTokens(query: string) {
  const tokens = normalizeFilterText(query).split(/\s+/).filter(Boolean);
  const meaningful = tokens.filter((term) => (term.length > 1 || /\d/.test(term)) && !QUERY_STOPWORDS.has(term));
  return meaningful.length ? meaningful : tokens;
}

function parseIncludedExcluded(query: string, includedRaw: string, excludedRaw: string) {
  const explicitTerms = Boolean(includedRaw.trim());
  const included = explicitTerms
    ? includedRaw.split(',').map(normalizeFilterText).filter(Boolean)
    : queryTokens(query);
  const excluded = excludedRaw.split(',').map(normalizeFilterText).filter(Boolean);
  return { included, excluded, explicitTerms };
}

/**
 * One term against one normalized title. Plain substring matching is preserved,
 * but alphanumeric model tokens ("128gb", "rtx3080", "s23ultra") also match the
 * title with its spaces removed, so "128 GB" and "128gb" describe the same
 * offer. The digit requirement keeps the glued form from colliding across word
 * boundaries on ordinary words ("onpro" inside "iphone13pro"). Pure numeric
 * terms must land on a whole token so "5" cannot match "15".
 */
function termMatches(titleSpaced: string, titleGlued: string, term: string) {
  if (!term) return false;
  // Pure numeric terms must land on a digit run boundaried by letters or the
  // token start, so "5" cannot match "15" but does match "5g" and "rtx3080".
  if (/^\d+$/.test(term)) {
    return titleSpaced.split(' ').some((token) => token.split(/[a-z]+/).includes(term));
  }
  if (titleSpaced.includes(term)) return true;
  const compact = term.replace(/ /g, '');
  return /\d/.test(compact) && compact.length >= 3 && titleGlued.includes(compact);
}

const CONDITION_ALIASES: Record<string, string[]> = {
  'like new': ['like new', 'jak nowy', 'jak nowa', 'idealny', 'idealna'],
  'very good': ['very good', 'bardzo dobry', 'bardzo dobra'],
  good: ['good', 'dobry', 'dobra'],
};

function matchesRequestedCondition(requestedCondition: string, listingCondition: string) {
  if (!requestedCondition || requestedCondition === 'any') return true;
  const isNew = /(^| )(new|nowe|nowy|nowa)( |$)/.test(listingCondition);
  if (requestedCondition === 'new') return isNew;
  if (requestedCondition === 'used') return Boolean(listingCondition) && !isNew;
  return (CONDITION_ALIASES[requestedCondition.replace(/\s+$/, '')] ?? [requestedCondition]).some((alias) => listingCondition.includes(alias));
}

function evaluateDeterministic(
  listing: NormalizedListing,
  title: string,
  condition: string,
  included: string[],
  excluded: string[],
  requestedCondition: string,
  options: ListingFilters,
  relaxed = false,
) {
  const titleGlued = title.replace(/ /g, '');
  const excludedHit = excluded.some((term) => termMatches(title, titleGlued, term));
  const matchedTerms = included.filter((term) => termMatches(title, titleGlued, term)).length;
  let termOk = matchedTerms === included.length && !excludedHit;
  // Relaxed pass (manual search fallback only): keep offers that match a
  // majority of the query tokens rather than returning an empty page.
  if (!termOk && relaxed && !excludedHit && included.length > 1 && matchedTerms >= Math.ceil(included.length / 2)) termOk = true;
  const conditionOk = matchesRequestedCondition(requestedCondition, condition);
  const priceOk = (options.minPrice === null || options.minPrice === undefined || listing.price >= options.minPrice)
    && (options.maxPrice === null || options.maxPrice === undefined || listing.price <= options.maxPrice);
  const shippingOk = !options.shippingOnly || listing.marketplace === 'Vinted' || listing.shippingAvailable === true;
  const sellerOk = (!options.sellerType || !listing.sellerType || listing.sellerType === options.sellerType)
    && (!options.ignorePromoted || listing.promoted !== true);
  return { termOk, conditionOk, priceOk, shippingOk, sellerOk };
}

export function filterListings(listings: NormalizedListing[], query: string, includedRaw: string, excludedRaw: string, filters: ListingFilters | boolean = {}) {
  const options = typeof filters === 'boolean' ? { shippingOnly: filters } : filters;
  const { included, excluded, explicitTerms } = parseIncludedExcluded(query, includedRaw, excludedRaw);
  // Request-level values are identical for every listing: normalize them and
  // the alias table once instead of per filter pass.
  const requestedCondition = normalizeFilterText(options.condition ?? '');
  const evaluate = (relaxed: boolean) => listings.filter((listing) => {
    const title = normalizeFilterText(listing.title);
    const condition = normalizeFilterText(listing.condition ?? '');
    const evaluated = evaluateDeterministic(listing, title, condition, included, excluded, requestedCondition, options, relaxed);
    return evaluated.termOk && evaluated.conditionOk && evaluated.priceOk && evaluated.shippingOk && evaluated.sellerOk;
  });
  const strict = evaluate(false);
  // Only manual search opts into the relaxed retry, and never when the user
  // typed explicit included terms (those are a hard requirement).
  if (strict.length || !options.relaxTerms || explicitTerms) return strict;
  return evaluate(true);
}

/**
 * P1/P3: near-miss rescue candidates. Returns listings that pass every
 * deterministic check except exactly one fuzzy dimension (terms XOR
 * condition). Callers send each subset to the matching Jev question; a
 * confident pass rescues the listing, anything else keeps the drop.
 */
export function findFuzzyRescueCandidates(
  listings: NormalizedListing[],
  query: string,
  includedRaw: string,
  excludedRaw: string,
  filters: ListingFilters | boolean = {},
) {
  const options = typeof filters === 'boolean' ? { shippingOnly: filters } : filters;
  const { included, excluded } = parseIncludedExcluded(query, includedRaw, excludedRaw);
  const requestedCondition = normalizeFilterText(options.condition ?? '');
  const hasTermFilter = included.length > 0 || excluded.length > 0;
  const hasConditionFilter = Boolean(requestedCondition) && requestedCondition !== 'any';
  const termCandidates: NormalizedListing[] = [];
  const conditionCandidates: NormalizedListing[] = [];
  for (const listing of listings) {
    const title = normalizeFilterText(listing.title);
    const condition = normalizeFilterText(listing.condition ?? '');
    const evaluated = evaluateDeterministic(listing, title, condition, included, excluded, requestedCondition, options);
    if (!evaluated.priceOk || !evaluated.shippingOk || !evaluated.sellerOk) continue;
    if (!evaluated.termOk && evaluated.conditionOk && hasTermFilter) termCandidates.push(listing);
    else if (!evaluated.conditionOk && evaluated.termOk && hasConditionFilter) conditionCandidates.push(listing);
  }
  return { termCandidates, conditionCandidates };
}
