import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chromium, type Browser, type BrowserContext } from 'playwright-core';
import { buildDiscordEmbed, buildNtfyPayload, meetsMinimumPriority, notificationKey, notificationPriorityRank, parseNotificationPriority, priorityFromDiscount, publishNtfy, validateNtfyConfig, type NtfyConfig } from './notifications';
import { buildMarketplaceSearchUrl, buildOlxSearchApiUrl, createAllegroLokalnieAdapter, createOlxJsonAdapter, createPublicAdapter, createVintedJsonAdapter, exponentialBackoff, parseListingDescription, parseListingImageUrls, parseShippingAvailability, validateSearchUrl, type AllegroApiFetchResult, type ConnectorAdapter, type ConnectorPathReporter, type ListingAvailability, type Marketplace, type NormalizedListing, type OlxApiFetchResult, type VintedApiFetchResult, type VintedPageFetchResult } from './marketplaces';
import { MarketplaceSessionValidationError, parseMarketplaceStorageState, type MarketplaceStorageState } from './marketplace-sessions';
import { DEFAULT_DEEPSEEK_MODEL, classifyListingRelevanceWithDeepSeek, draftNegotiationMessageWithDeepSeek, legacyListingNormalizationInputHash, legacyListingRelevanceInputHash, listingDescriptionVerificationInputHash, listingNormalizationInputHash, listingRelevanceInputHash, normalizeListingWithDeepSeek, normalizeOpenRouterModel, DeepSeekError, parseStoredListingDescriptionVerification, parseStoredListingNormalization, verifyListingDescriptionWithDeepSeek, type ListingDescriptionVerificationContext, type ListingRelevanceContext, type NegotiationListingContext } from './ai';
import { OlxMessagingError, sendOlxMessageOnPage } from './olx-messaging';
import { AllegroMessagingError, sendAllegroMessageOnPage } from './allegro-messaging';
import { offerCeiling, recommendNegotiationPrice, type NegotiationRecommendation } from './negotiation';
import { BASELINE_MIN_HOURS, BASELINE_MIN_SAMPLES, median, scoreDeal } from './scoring';
import { pickVariantBatch, typoVariants } from './typos';
import { computeSaleBand, type MarketBandSample } from './marketBand';
import { bucketDailyObservations, type MarketTrendObservation } from './marketTrend';
import type { AutoNegotiationSettings, Connector, ConnectorRun, DailyDigestSettings, DashboardData, DealLabel, Listing, ListingAction, ListingDecision, ListingDescriptionVerification, ListingDetail, ListingDetailSnapshot, ListingDescriptionVerificationStatus, LogEntry, ManualSearchResponse, MarketListingSnapshot, MarketResearchData, MarketTrackedListing, MarketWatch, MarketWatchTrend, NotificationPriority, NotificationRecord, PriceHistoryPoint, SearchFilters, SellerMessage, SellerMessageSource, SettingsData, Watch, WatchAnalytics, WatchAnalyticsPoint, WatchAnalyticsSource } from '../src/types';

type Database = any;
type WatchRow = Record<string, any>;
type ListingRelevanceSearch = Pick<ListingRelevanceContext, 'query' | 'includedTerms' | 'excludedTerms'>;
type RelevanceFilterResult = {
  listings: NormalizedListing[];
  excluded: number;
  failed: number;
  unknown: number;
  notConfigured: boolean;
};

type DealNotificationCandidate = {
  watchId: string;
  listing: NormalizedListing;
  typical: number;
  discountPercent: number;
  confidence: number;
  requiresDescriptionVerification: boolean;
};

type AutoNegotiationConfig = Omit<AutoNegotiationSettings, 'sentToday' | 'attemptedToday'>;
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

const DEFAULT_AUTO_NEGOTIATION_CONFIG: AutoNegotiationConfig = {
  enabled: false,
  maxTotalCost: null,
  shippingCost: 0,
  otherCosts: 0,
  minimumDiscountPercent: 18,
  openingDiscountPercent: 12,
  dailyLimit: 3,
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
const NIGHT_START_HOUR = 22;
const NIGHT_END_HOUR = 8;
const MAX_RESEARCH_DETAIL_CHECKS = 100;
/** Extra per-source searches a typo-variant scan may fetch (each still one page). */
const TYPO_VARIANTS_PER_SCAN = 2;
/** Rolling window of ended listings that feed probable-sale bands. */
const SALE_BAND_WINDOW_DAYS = 90;
/** Bounded per-scan capture of preserved listing copies (description + downloaded images). */
const SNAPSHOT_CAPTURES_PER_SCAN = 8;
const SNAPSHOT_MAX_IMAGES = 12;
const SNAPSHOT_MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const SNAPSHOT_MAX_ATTEMPTS = 3;
/**
 * The anonymous marketplace APIs (OLX offers, Vinted catalog, Lokalnie
 * additional-data) reject Scout's plain identifier UA; a modern Chrome UA plus
 * `Accept: application/json` is the verified anonymous access contract.
 */
const MARKETPLACE_API_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
/** Scan-path log entries kept in memory for the Logs tab; pure diagnostics, never persisted. */
const LOG_BUFFER_LIMIT = 500;

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
  draftNegotiation?: typeof draftNegotiationMessageWithDeepSeek;
  sendOlxMessage?: (listingUrl: string, message: string) => Promise<void>;
  sendAllegroMessage?: (listingUrl: string, message: string) => Promise<void>;
  publicExposureWarning?: boolean;
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

const nowIso = () => new Date().toISOString();

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
  const strongDealCount = baselinedRows.filter((row) => ((row.typical! - row.price) / row.typical!) * 100 >= 18).length;
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

function safePromptText(value: unknown, limit = 240) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
}

export function validateNegotiationMessage(message: string, offerPrice: number | null = null) {
  const safeMessage = message.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  if (!safeMessage) throw new ServiceError('The negotiation message is empty.', 400);
  if (safeMessage.length > 450) throw new ServiceError('Negotiation messages must be 450 characters or fewer.', 400);
  if (/(?:https?:\/\/|www\.|\b(?:email|e-mail|adres\s+e-mail|telefon|tel\.?|whatsapp|telegram|signal|przelew|poza\s+platforma)\b|@[a-z0-9._%+-]+\.[a-z]{2,})/i.test(safeMessage)) {
    throw new ServiceError('Negotiation messages cannot include links, contact details, or off-platform payment instructions.', 400);
  }
  if (/\b(?:idiot|kretyn|debil|frajer|oszust|złodziej|kurwa|chuj|fuck|scam)\b/i.test(safeMessage)) {
    throw new ServiceError('Negotiation messages must remain polite and non-abusive.', 400);
  }
  if (offerPrice !== null) {
    const amount = Math.round(offerPrice * 100) / 100;
    const digits = String(amount).replace(/\.0+$/, '').replace('.', '');
    const messageDigits = safeMessage.replace(/[^0-9]/g, '');
    if (!messageDigits.includes(digits)) throw new ServiceError('The message must state the approved opening offer.', 400);
  } else if (/\d{2,}/.test(safeMessage.replace(/\s/g, ''))) {
    throw new ServiceError('A message without an approved opening offer cannot introduce a new numeric amount.', 400);
  }
  return safeMessage;
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

export class ScoutService {
  private db: Database;
  private emit: (event: string, payload: unknown) => void;
  private running = new Set<string>();
  private descriptionVerificationInFlight = new Map<string, Promise<boolean>>();
  private lastSchedulerTickAt: string | null = null;
  private digestRunning = false;
  private readonly classifyListingRelevance: typeof classifyListingRelevanceWithDeepSeek;
  private readonly verifyListingDescription: typeof verifyListingDescriptionWithDeepSeek;
  private readonly draftNegotiation: typeof draftNegotiationMessageWithDeepSeek;
  private readonly sendOlxMessageOverride?: (listingUrl: string, message: string) => Promise<void>;
  private readonly sendAllegroMessageOverride?: (listingUrl: string, message: string) => Promise<void>;
  private readonly publicExposureWarning: boolean;
  private readonly schedulerOwner = `scheduler-${process.pid}-${randomBytes(8).toString('hex')}`;
  private activeManualSearches = 0;
  private readonly messagingInFlight = new Set<string>();
  private logSequence = 0;
  private readonly logBuffer: LogEntry[] = [];

  constructor(db: Database, emit: (event: string, payload: unknown) => void, dependencies: ScoutServiceDependencies = {}) {
    this.db = db;
    this.emit = emit;
    this.classifyListingRelevance = dependencies.classifyListingRelevance ?? classifyListingRelevanceWithDeepSeek;
    this.verifyListingDescription = dependencies.verifyListingDescription ?? verifyListingDescriptionWithDeepSeek;
    this.draftNegotiation = dependencies.draftNegotiation ?? draftNegotiationMessageWithDeepSeek;
    this.sendOlxMessageOverride = dependencies.sendOlxMessage;
    this.sendAllegroMessageOverride = dependencies.sendAllegroMessage;
    this.publicExposureWarning = dependencies.publicExposureWarning ?? false;
  }

  private transaction<T>(callback: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = callback();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* preserve the original database error */ }
      throw error;
    }
  }

  private createScan(watchId: string, watchKind: 'watch' | 'research', marketplace: Marketplace, startedAt = nowIso()) {
    const result = this.db.prepare('INSERT INTO scans (watch_id, watch_kind, marketplace, status, started_at) VALUES (?, ?, ?, ?, ?)').run(watchId, watchKind, marketplace, 'running', startedAt);
    return Number(result.lastInsertRowid);
  }

  /**
   * Stable ordinal for rotating typo-variant batches: the number of scan
   * attempts recorded for this watch (including the running one). Deterministic
   * per attempt, needs no extra state, and never depends on wall-clock time.
   */
  private scanOrdinal(watchId: string, watchKind: 'watch' | 'research') {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM scans WHERE watch_id = ? AND watch_kind = ?').get(watchId, watchKind) as { count?: number };
    return Number(row?.count ?? 0);
  }

  private completeScan(scanId: number, message?: string) {
    this.db.prepare("UPDATE scans SET status = 'completed', completed_at = ?, error = ? WHERE id = ?").run(nowIso(), message ?? null, scanId);
  }

  private failScan(scanId: number, error: unknown) {
    const message = (error instanceof Error ? error.message : String(error || 'Scan failed')).slice(0, 500);
    this.db.prepare("UPDATE scans SET status = 'failed', completed_at = ?, error = ? WHERE id = ?").run(nowIso(), message, scanId);
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

  schedulerTick() {
    this.lastSchedulerTickAt = nowIso();
    if (!this.tryAcquireSchedulerLease()) return;
    this.queueDue();
  }

  private tryAcquireSchedulerLease() {
    const now = nowIso();
    const expiresAt = new Date(Date.now() + 45_000).toISOString();
    try {
      const update = this.db.prepare('UPDATE scheduler_leases SET owner_id = ?, expires_at = ? WHERE id = 1 AND (owner_id = ? OR expires_at <= ?)').run(this.schedulerOwner, expiresAt, this.schedulerOwner, now);
      if (Number(update.changes) > 0) return true;
      const insert = this.db.prepare('INSERT OR IGNORE INTO scheduler_leases (id, owner_id, expires_at) VALUES (1, ?, ?)').run(this.schedulerOwner, expiresAt);
      return Number(insert.changes) > 0;
    } catch {
      return false;
    }
  }

  readiness() {
    let database = false;
    let databaseError: string | null = null;
    try {
      const result = this.db.prepare('SELECT 1 AS ok').get() as { ok?: number } | undefined;
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
        staleScans = Number((this.db.prepare("SELECT COUNT(*) AS count FROM scans WHERE status = 'running' OR status = 'interrupted'").get() as { count?: number } | undefined)?.count ?? 0);
        migration = this.db.prepare('SELECT COUNT(*) AS count, MAX(id) AS latest FROM migrations').get() as { count?: number; latest?: string | null };
        degradedConnectors = this.getConnectors().filter((connector) => connector.status === 'Degraded').map((connector) => connector.name);
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
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value?: string } | undefined;
    return row?.value ?? null;
  }

  private setSetting(key: string, value: string) {
    this.db.prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run(key, value, nowIso());
  }

  private autoNegotiationConfig(): AutoNegotiationConfig {
    const stored = parseJson<Partial<AutoNegotiationConfig>>(this.getSetting('auto_negotiation_config'), {});
    const finite = (value: unknown, fallback: number, minimum: number, maximum?: number) => {
      const parsed = typeof value === 'number' ? value : Number(value);
      return Number.isFinite(parsed) && parsed >= minimum && (maximum === undefined || parsed <= maximum) ? parsed : fallback;
    };
    const maxTotalCost = stored.maxTotalCost === null ? null : finite(stored.maxTotalCost, 0, 0.01);
    return {
      enabled: stored.enabled === true,
      maxTotalCost: maxTotalCost === 0 ? null : maxTotalCost,
      shippingCost: finite(stored.shippingCost, DEFAULT_AUTO_NEGOTIATION_CONFIG.shippingCost, 0),
      otherCosts: finite(stored.otherCosts, DEFAULT_AUTO_NEGOTIATION_CONFIG.otherCosts, 0),
      minimumDiscountPercent: finite(stored.minimumDiscountPercent, DEFAULT_AUTO_NEGOTIATION_CONFIG.minimumDiscountPercent, 18, 80),
      openingDiscountPercent: finite(stored.openingDiscountPercent, DEFAULT_AUTO_NEGOTIATION_CONFIG.openingDiscountPercent, 1, 50),
      dailyLimit: Math.floor(finite(stored.dailyLimit, DEFAULT_AUTO_NEGOTIATION_CONFIG.dailyLimit, 1, 50)),
    };
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

  private currentDayStart() {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    return start.toISOString();
  }

  private autoNegotiationSettings(): AutoNegotiationSettings {
    const config = this.autoNegotiationConfig();
    const counts = this.db.prepare(`SELECT COUNT(*) AS attempted, SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS sent
      FROM automatic_negotiations WHERE created_at >= ?`).get(this.currentDayStart()) as { attempted?: number; sent?: number } | undefined;
    return {
      ...config,
      sentToday: Number(counts?.sent ?? 0),
      attemptedToday: Number(counts?.attempted ?? 0),
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
    this.db.prepare(`INSERT INTO listing_relevance (watch_id, marketplace, listing_id, input_hash, model, relevant, reason, error, checked_at, relevance_status)
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

  private async filterListingsByAiRelevance(
    listings: NormalizedListing[],
    search: ListingRelevanceSearch,
    watchId: string | undefined,
    enabled: boolean,
  ): Promise<RelevanceFilterResult> {
    if (!enabled || !listings.length) return { listings, excluded: 0, failed: 0, unknown: 0, notConfigured: false };
    const config = this.deepSeekConfig();
    if (!config.apiKey) return { listings, excluded: 0, failed: 0, unknown: 0, notConfigured: true };
    const apiKey = config.apiKey;
    const pendingClassifications = new Map<string, Promise<{ relevant: boolean }>>();

    const classified: Array<{ listing: NormalizedListing; status: 'relevant' | 'irrelevant' | 'unknown' }> = [];
    for (let offset = 0; offset < listings.length; offset += 4) {
      const batch = await Promise.all(listings.slice(offset, offset + 4).map(async (listing): Promise<{ listing: NormalizedListing; status: 'relevant' | 'irrelevant' | 'unknown' }> => {
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
        if (watchId) {
          const cached = this.db.prepare('SELECT input_hash, model, relevant, reason, error, relevance_status FROM listing_relevance WHERE watch_id = ? AND marketplace = ? AND listing_id = ?').get(watchId, listing.marketplace, listing.listingId) as { input_hash?: string; model?: string; relevant?: number; reason?: string; error?: string | null; relevance_status?: string } | undefined;
          const cachedStatus: 'relevant' | 'irrelevant' | 'unknown' = cached?.relevance_status === 'irrelevant' || cached?.relevance_status === 'unknown' || cached?.relevance_status === 'relevant'
            ? cached.relevance_status
            : cached?.error ? 'unknown' : cached?.relevant === 0 ? 'irrelevant' : 'relevant';
          if ((cached?.input_hash === inputHash || cached?.input_hash === legacyInputHash) && cached.model === config.model && cachedStatus !== 'unknown' && !cached.error) {
            if (cached.input_hash === legacyInputHash) this.saveListingRelevance({ watchId, listing, inputHash, model: config.model, relevant: cachedStatus === 'relevant', status: cachedStatus, reason: cached.reason ?? 'Reused cached relevance decision' });
            return { listing, status: cachedStatus };
          }
        }

        const reusable = this.db.prepare(`SELECT relevant, reason, relevance_status FROM listing_relevance
          WHERE input_hash = ? AND model = ? AND relevance_status IN ('relevant', 'irrelevant') AND error IS NULL
          ORDER BY checked_at DESC LIMIT 1`).get(inputHash, config.model) as { relevant?: number; reason?: string; relevance_status?: string } | undefined;
        if (reusable) {
          const status: 'relevant' | 'irrelevant' = reusable.relevance_status === 'irrelevant' || reusable.relevant === 0 ? 'irrelevant' : 'relevant';
          if (watchId) this.saveListingRelevance({ watchId, listing, inputHash, model: config.model, relevant: status === 'relevant', status, reason: reusable.reason ?? 'Reused cached relevance decision' });
          return { listing, status };
        }

        try {
          let classification = pendingClassifications.get(inputHash);
          if (!classification) {
            classification = this.classifyListingRelevance(context, { apiKey, model: config.model });
            pendingClassifications.set(inputHash, classification);
          }
          const result = await classification;
          const status: 'relevant' | 'irrelevant' = result.relevant ? 'relevant' : 'irrelevant';
          if (watchId) this.saveListingRelevance({ watchId, listing, inputHash, model: config.model, relevant: result.relevant, status, reason: result.relevant ? 'AI classified listing as relevant' : 'AI classified listing as irrelevant' });
          return { listing, status };
        } catch (error) {
          const message = (error instanceof Error ? error.message : 'OpenRouter could not classify listing relevance').slice(0, 500);
          if (watchId) this.saveListingRelevance({ watchId, listing, inputHash, model: config.model, relevant: true, status: 'unknown', reason: 'AI relevance check failed', error: message });
          return { listing, status: 'unknown' };
        }
      }));
      classified.push(...batch);
    }

    return {
      listings: classified.filter((item) => item.status !== 'irrelevant').map((item) => item.listing),
      excluded: classified.filter((item) => item.status === 'irrelevant').length,
      failed: classified.filter((item) => item.status === 'unknown').length,
      unknown: classified.filter((item) => item.status === 'unknown').length,
      notConfigured: false,
    };
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
      this.db.prepare(`UPDATE listings SET
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
    this.db.prepare(`UPDATE listings SET
      ai_description_verification_json = ?,
      ai_description_verification_input_hash = ?,
      ai_description_verification_model = ?,
      ai_description_verification_at = ?,
      ai_description_verification_status = ?,
      ai_description_verification_error = ?
      WHERE marketplace = ? AND listing_id = ?`).run(
      input.verification ? JSON.stringify(input.verification) : null,
      input.inputHash ?? null,
      input.model ?? null,
      nowIso(),
      input.status,
      input.error?.slice(0, 500) ?? null,
      input.marketplace,
      input.listingId,
    );
  }

  private captureListingDetailSnapshot(candidate: DealNotificationCandidate, description: string | null) {
    const stored = this.db.prepare('SELECT id FROM listings WHERE marketplace = ? AND listing_id = ?').get(candidate.listing.marketplace, candidate.listing.listingId) as { id?: number } | undefined;
    if (!stored?.id) return null;
    const stateHash = createHash('sha256').update(JSON.stringify({
      title: candidate.listing.title,
      price: candidate.listing.price,
      condition: candidate.listing.condition ?? null,
      location: candidate.listing.location ?? null,
      url: candidate.listing.url,
      description,
    })).digest('hex');
    const capturedAt = nowIso();
    this.db.prepare(`INSERT INTO listing_detail_snapshots (
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
    const snapshot = this.db.prepare('SELECT id FROM listing_detail_snapshots WHERE listing_id = ? AND state_hash = ?').get(stored.id, stateHash) as { id?: number } | undefined;
    return snapshot?.id ? { id: Number(snapshot.id), stateHash } : null;
  }

  private updateListingDetailSnapshot(snapshotId: number | null, status: ListingDescriptionVerificationStatus, inputHash: string | null) {
    if (!snapshotId) return;
    this.db.prepare('UPDATE listing_detail_snapshots SET verification_status = ?, verification_input_hash = ? WHERE id = ?').run(status, inputHash, snapshotId);
  }

  private async verifyHighPriorityDealOnce(candidate: DealNotificationCandidate): Promise<boolean> {
    const marketplace = candidate.listing.marketplace;
    const listingId = candidate.listing.listingId;
    const config = this.deepSeekConfig();
    if (!config.apiKey) {
      const snapshot = this.captureListingDetailSnapshot(candidate, null);
      this.updateListingDetailSnapshot(snapshot?.id ?? null, 'not-configured', null);
      this.saveDescriptionVerification({ marketplace, listingId, status: 'not-configured' });
      return true;
    }

    let description: string | null;
    try {
      const html = await this.fetchPublicPage(candidate.listing.url, marketplace);
      description = parseListingDescription(html, marketplace);
    } catch (error) {
      const message = (error instanceof Error ? error.message : 'Could not fetch the high-priority listing detail page').slice(0, 500);
      const snapshot = this.captureListingDetailSnapshot(candidate, null);
      this.updateListingDetailSnapshot(snapshot?.id ?? null, 'unknown', null);
      this.saveDescriptionVerification({ marketplace, listingId, status: 'unknown', model: config.model, error: message });
      this.emit('ai-description-verification', { key: `${marketplace}:${listingId}`, status: 'unknown' });
      return false;
    }

    const context: ListingDescriptionVerificationContext = {
      marketplace,
      title: candidate.listing.title,
      condition: candidate.listing.condition,
      description,
    };
    const inputHash = listingDescriptionVerificationInputHash(context);
    const snapshot = this.captureListingDetailSnapshot(candidate, description);
    const row = this.db.prepare(`SELECT ai_description_verification_json, ai_description_verification_input_hash,
      ai_description_verification_model, ai_description_verification_at, ai_description_verification_error,
      ai_description_verification_status
      FROM listings WHERE marketplace = ? AND listing_id = ?`).get(marketplace, listingId) as Record<string, any> | undefined;
    const cached = parseStoredListingDescriptionVerification(row?.ai_description_verification_json);
    if (cached && row?.ai_description_verification_input_hash === inputHash && row.ai_description_verification_model === config.model) {
      this.updateListingDetailSnapshot(snapshot?.id ?? null, cached.decision, inputHash);
      this.saveDescriptionVerification({ marketplace, listingId, status: cached.decision, verification: cached, inputHash, model: config.model });
      return cached.decision === 'pass';
    }
    if (row?.ai_description_verification_error && row.ai_description_verification_input_hash === inputHash
      && row.ai_description_verification_model === config.model && row.ai_description_verification_at
      && Date.now() - Date.parse(row.ai_description_verification_at) < 6 * 60 * 60_000) {
      const status: ListingDescriptionVerificationStatus = row.ai_description_verification_status === 'fallback' ? 'fallback' : 'unknown';
      this.updateListingDetailSnapshot(snapshot?.id ?? null, status, inputHash);
      this.saveDescriptionVerification({ marketplace, listingId, status, inputHash, model: config.model, error: row.ai_description_verification_error });
      return status === 'fallback';
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
      this.saveDescriptionVerification({ marketplace, listingId, status: unknown.decision, verification: unknown, inputHash, model: config.model });
      this.emit('ai-description-verification', { key: `${marketplace}:${listingId}`, status: unknown.decision });
      return false;
    }

    const reusable = this.db.prepare(`SELECT ai_description_verification_json
      FROM listings
      WHERE ai_description_verification_input_hash = ?
        AND ai_description_verification_model = ?
        AND ai_description_verification_json IS NOT NULL
      ORDER BY ai_description_verification_at DESC LIMIT 1`).get(inputHash, config.model) as { ai_description_verification_json?: string } | undefined;
    const shared = parseStoredListingDescriptionVerification(reusable?.ai_description_verification_json);
    if (shared) {
      this.updateListingDetailSnapshot(snapshot?.id ?? null, shared.decision, inputHash);
      this.saveDescriptionVerification({ marketplace, listingId, status: shared.decision, verification: shared, inputHash, model: config.model });
      return shared.decision === 'pass';
    }

    try {
      this.saveDescriptionVerification({ marketplace, listingId, status: 'pending', model: config.model });
      const verification = await this.verifyListingDescription(context, { apiKey: config.apiKey, model: config.model });
      this.updateListingDetailSnapshot(snapshot?.id ?? null, verification.decision, inputHash);
      this.saveDescriptionVerification({ marketplace, listingId, status: verification.decision, verification, inputHash, model: config.model });
      this.emit('ai-description-verification', { key: `${marketplace}:${listingId}`, status: verification.decision });
      return verification.decision === 'pass';
    } catch (error) {
      const message = (error instanceof Error ? error.message : 'OpenRouter could not verify the listing description').slice(0, 500);
      const status: ListingDescriptionVerificationStatus = error instanceof DeepSeekError ? 'fallback' : 'unknown';
      this.updateListingDetailSnapshot(snapshot?.id ?? null, status, inputHash);
      this.saveDescriptionVerification({ marketplace, listingId, status, inputHash, model: config.model, error: message });
      this.emit('ai-description-verification', { key: `${marketplace}:${listingId}`, status });
      return status === 'fallback';
    }
  }

  private verifyHighPriorityDeal(candidate: DealNotificationCandidate) {
    const key = `${candidate.listing.marketplace}:${candidate.listing.listingId}`;
    const existing = this.descriptionVerificationInFlight.get(key);
    if (existing) return existing;
    const verification = this.verifyHighPriorityDealOnce(candidate).finally(() => {
      if (this.descriptionVerificationInFlight.get(key) === verification) this.descriptionVerificationInFlight.delete(key);
    });
    this.descriptionVerificationInFlight.set(key, verification);
    return verification;
  }

  private discordMinimumPriority(): NotificationPriority {
    return parseNotificationPriority(this.getSetting('discord_minimum_priority'), 'strong');
  }

  private ntfyConfig(): NtfyConfig | null {
    const encrypted = this.getSetting('ntfy_config');
    if (!encrypted) return null;
    try {
      const parsed = JSON.parse(decryptSecret(encrypted)) as { serverUrl?: string; topic?: string; token?: string; minimumPriority?: unknown };
      return validateNtfyConfig(parsed);
    } catch {
      return null;
    }
  }

  private marketplaceSessionRow(marketplace: Marketplace) {
    return this.db.prepare('SELECT * FROM marketplace_sessions WHERE marketplace = ?').get(marketplace) as Record<string, any> | undefined;
  }

  private setMarketplaceSessionError(marketplace: Marketplace, message: string | null) {
    this.db.prepare('UPDATE marketplace_sessions SET last_error = ?, updated_at = ? WHERE marketplace = ?').run(message ? message.slice(0, 500) : null, nowIso(), marketplace);
  }

  private readMarketplaceSession(marketplace: Marketplace): MarketplaceStorageState | null {
    const row = this.marketplaceSessionRow(marketplace);
    if (!row) return null;
    try {
      return parseMarketplaceStorageState(decryptSecret(String(row.storage_state_encrypted)), marketplace);
    } catch {
      this.setMarketplaceSessionError(marketplace, 'Stored session could not be read; import it again');
      throw new Error(`${marketplace} authenticated session could not be read; import it again`);
    }
  }

  private touchMarketplaceSession(marketplace: Marketplace) {
    this.db.prepare('UPDATE marketplace_sessions SET last_used_at = ?, last_error = NULL, updated_at = ? WHERE marketplace = ?').run(nowIso(), nowIso(), marketplace);
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
    this.db.prepare(`INSERT INTO marketplace_sessions (marketplace, label, storage_state_encrypted, created_at, updated_at, last_used_at, last_error)
      VALUES (?, ?, ?, ?, ?, NULL, NULL)
      ON CONFLICT(marketplace) DO UPDATE SET label = excluded.label, storage_state_encrypted = excluded.storage_state_encrypted, updated_at = excluded.updated_at, last_used_at = NULL, last_error = NULL`)
      .run(marketplace, safeLabel, encryptSecret(JSON.stringify(state)), timestamp, timestamp);
    return this.settings();
  }

  deleteMarketplaceSession(marketplace: Marketplace) {
    const result = this.db.prepare('DELETE FROM marketplace_sessions WHERE marketplace = ?').run(marketplace);
    if (!result.changes) throw new ServiceError('Marketplace session not found', 404);
    return this.settings();
  }

  private watchFromRow(row: WatchRow, stats: { samples: number; first_observed: string | null } = { samples: 0, first_observed: null }): Watch {
    const samples = Number(stats?.samples ?? 0);
    const observationHours = stats?.first_observed ? Math.max(0, Math.floor((Date.now() - Date.parse(stats.first_observed)) / 3_600_000)) : 0;
    const readiness = Math.round(Math.min(1, samples / BASELINE_MIN_SAMPLES, observationHours / BASELINE_MIN_HOURS) * 100);
    const archived = Boolean(row.archived_at);
    const enabled = Boolean(row.enabled) && !archived;
    return {
      id: row.id,
      name: row.name,
      query: row.query,
      terms: row.included_terms,
      excluded: row.excluded_terms,
      sources: parseJson<Marketplace[]>(row.sources_json, []),
      location: row.location,
      condition: row.condition,
      samples,
      targetSamples: BASELINE_MIN_SAMPLES,
      observationHours,
      readiness,
      status: archived ? 'Archived' : enabled ? (readiness >= 100 ? 'Ready' : 'Learning') : 'Paused',
      interval: Number(row.interval_minutes),
      nextScan: enabled ? relativeTimeFuture(row.next_scan_at) : 'Paused',
      enabled,
      exactUrls: parseJson<string[]>(row.exact_urls_json, []),
      sensitivity: Number(row.sensitivity ?? 1),
      shippingOnly: Boolean(row.shipping_only),
      typoVariants: Boolean(row.typo_variants),
      aiRelevance: row.ai_relevance === undefined ? true : Boolean(row.ai_relevance),
      minPrice: row.min_price_pln === null ? null : Number(row.min_price_pln),
      maxPrice: row.max_price_pln === null ? null : Number(row.max_price_pln),
      archivedAt: row.archived_at ?? null,
    };
  }

  private listingFromRow(row: Record<string, any>, baselineReady: boolean): Listing {
    const associationTypical = row.watch_typical_pln ?? row.typical_pln;
    const typical = baselineReady && associationTypical !== null && associationTypical !== undefined ? Number(associationTypical) : null;
    const price = Number(row.price_pln);
    const belowTypical = typical && typical > 0 ? -Math.max(0, ((typical - price) / typical) * 100) : null;
    const discount = belowTypical === null ? 0 : Math.abs(belowTypical);
    const dealStrength = row.watch_deal_strength === null || row.watch_deal_strength === undefined
      ? discount >= 30 ? 5 : discount >= 20 ? 4 : discount >= 12 ? 3 : discount > 0 ? 2 : 1
      : Number(row.watch_deal_strength);
    const dealLabel: DealLabel = row.watch_deal_label === 'Exceptional' || row.watch_deal_label === 'Very strong' || row.watch_deal_label === 'Strong' || row.watch_deal_label === 'Watch'
      ? row.watch_deal_label
      : dealStrength >= 5 ? 'Exceptional' : dealStrength === 4 ? 'Very strong' : dealStrength === 3 ? 'Strong' : 'Watch';
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
      belowTypical,
      observed: relativeTime(row.watch_last_seen_at ?? row.last_seen_at),
      observedAt: row.watch_last_seen_at ?? row.last_seen_at,
      dealStrength,
      dealLabel,
      image: row.image_url || '',
      url: row.url,
      watch: row.watch_name || 'Unassigned',
      condition: row.condition || undefined,
      location: row.location || undefined,
      shippingAvailable: row.shipping_available === null ? null : Boolean(row.shipping_available),
      priceNegotiable: row.price_negotiable === null || row.price_negotiable === undefined ? null : Boolean(row.price_negotiable),
      listingId: String(row.listing_id),
      decision: parseListingDecision(row.listing_decision),
      note: typeof row.listing_note === 'string' ? row.listing_note : '',
      ...(row.ai_normalization_json !== undefined ? {
        aiNormalization: parseStoredListingNormalization(row.ai_normalization_json),
        aiNormalizationAt: row.ai_normalization_at ?? null,
        aiNormalizationError: row.ai_normalization_error ?? null,
      } : {}),
      ...(row.ai_description_verification_json !== undefined ? {
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

  private watches(includeArchived: boolean) {
    const rows = this.db.prepare(`SELECT * FROM watches ${includeArchived ? '' : 'WHERE archived_at IS NULL '}ORDER BY created_at DESC`).all() as WatchRow[];
    if (!rows.length) return [];
    const statsRows = this.db.prepare(`SELECT o.watch_id, COUNT(DISTINCT o.listing_id) AS samples, MIN(o.observed_at) AS first_observed
      FROM observations o
      JOIN listings l ON l.id = o.listing_id
      JOIN watches w ON w.id = o.watch_id
      WHERE (? = 1 OR w.archived_at IS NULL)
        AND NOT EXISTS (SELECT 1 FROM listing_relevance r WHERE r.watch_id = o.watch_id AND r.marketplace = l.marketplace AND r.listing_id = l.listing_id AND (r.relevance_status = 'irrelevant' OR (r.relevance_status IS NULL AND r.relevant = 0)) AND w.ai_relevance = 1)
        AND (w.shipping_only = 0 OR l.shipping_available = 1)
        AND (w.min_price_pln IS NULL OR o.price_pln >= w.min_price_pln)
        AND (w.max_price_pln IS NULL OR o.price_pln <= w.max_price_pln)
      GROUP BY o.watch_id`).all(includeArchived ? 1 : 0) as Array<{ watch_id: string; samples: number; first_observed: string | null }>;
    const statsByWatch = new Map(statsRows.map((stats) => [stats.watch_id, stats]));
    return rows.map((row) => this.watchFromRow(row, statsByWatch.get(row.id)));
  }

  getWatches() {
    return this.watches(false);
  }

  allWatches() {
    return this.watches(true);
  }

  watchAnalytics(id: string, rangeDays = 30): WatchAnalytics {
    const row = this.db.prepare('SELECT id, name, shipping_only, min_price_pln, max_price_pln FROM watches WHERE id = ?').get(id) as WatchRow | undefined;
    if (!row) throw new ServiceError('Watch not found', 404);
    const days = Math.max(7, Math.min(180, Math.floor(rangeDays)));
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60_000).toISOString();
    const rawRows = this.db.prepare(`SELECT o.listing_id, l.marketplace, o.price_pln, COALESCE(o.baseline_pln, CASE WHEN o.scan_id IS NULL THEN l.typical_pln END) AS typical_pln, o.observed_at
      FROM observations o
      JOIN listings l ON l.id = o.listing_id
      WHERE o.watch_id = ?
        AND o.observed_at >= ?
        AND NOT EXISTS (SELECT 1 FROM listing_relevance r WHERE r.watch_id = o.watch_id AND r.marketplace = l.marketplace AND r.listing_id = l.listing_id AND (r.relevance_status = 'irrelevant' OR (r.relevance_status IS NULL AND r.relevant = 0)) AND EXISTS (SELECT 1 FROM watches rw WHERE rw.id = r.watch_id AND rw.ai_relevance = 1))
        AND (? = 0 OR l.shipping_available = 1)
        AND (? IS NULL OR o.price_pln >= ?)
        AND (? IS NULL OR o.price_pln <= ?)
      ORDER BY o.observed_at ASC`).all(id, cutoff, row.shipping_only ? 1 : 0, row.min_price_pln, row.min_price_pln, row.max_price_pln, row.max_price_pln) as Array<Record<string, any>>;
    const observations = rawRows.map((item): WatchAnalyticsObservation => ({
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
      firstObservedAt: observations[0]?.observedAt ?? null,
      lastObservedAt: observations[observations.length - 1]?.observedAt ?? null,
      totalObservations: observations.length,
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

  listingsPage(options: { page?: number; pageSize?: number; marketplace?: Marketplace; q?: string; watchId?: string } = {}, knownWatches?: Watch[]) {
    const freshnessCutoff = new Date(Date.now() - MATCH_VISIBILITY_MS).toISOString();
    const predicates = [
      'w.archived_at IS NULL',
      'wl.last_seen_at > ?',
      'NOT EXISTS (SELECT 1 FROM listing_relevance r WHERE r.watch_id = wl.watch_id AND r.marketplace = l.marketplace AND r.listing_id = l.listing_id AND (r.relevance_status = \'irrelevant\' OR (r.relevance_status IS NULL AND r.relevant = 0)) AND w.ai_relevance = 1)',
      '(w.shipping_only = 0 OR l.shipping_available = 1)',
      '(w.min_price_pln IS NULL OR l.price_pln >= w.min_price_pln)',
      '(w.max_price_pln IS NULL OR l.price_pln <= w.max_price_pln)',
    ];
    const params: unknown[] = [freshnessCutoff];
    if (options.marketplace) { predicates.push('l.marketplace = ?'); params.push(options.marketplace); }
    if (options.watchId) { predicates.push('w.id = ?'); params.push(options.watchId); }
    const query = options.q?.trim().toLowerCase() ?? '';
    if (query) { predicates.push("lower(COALESCE(l.title, '') || ' ' || COALESCE(l.subtitle, '')) LIKE ?"); params.push(`%${query}%`); }
    const where = predicates.join(' AND ');
    const total = Number((this.db.prepare(`SELECT COUNT(*) AS count FROM listings l JOIN watch_listings wl ON wl.listing_id = l.id JOIN watches w ON w.id = wl.watch_id WHERE ${where}`).get(...params) as { count?: number }).count ?? 0);
    const page = Math.max(1, Math.floor(options.page ?? 1));
    const pageSize = Math.max(1, Math.min(500, Math.floor(options.pageSize ?? 200)));
    const rows = this.db.prepare(`SELECT l.marketplace, l.listing_id, l.title, l.subtitle, l.price_pln, l.typical_pln, l.url, l.image_url, l.condition, l.location, l.shipping_available, l.price_negotiable, l.last_seen_at, wl.id AS watch_listing_id, wl.watch_id, wl.first_seen_at AS watch_first_seen_at, wl.last_seen_at AS watch_last_seen_at, wl.typical_pln AS watch_typical_pln, wl.deal_strength AS watch_deal_strength, wl.deal_label AS watch_deal_label, w.name AS watch_name, w.enabled AS watch_enabled, w.archived_at AS watch_archived_at, w.shipping_only AS watch_shipping_only, w.min_price_pln AS watch_min_price_pln, w.max_price_pln AS watch_max_price_pln, a.decision AS listing_decision, a.note AS listing_note
      FROM listings l
      JOIN watch_listings wl ON wl.listing_id = l.id
      JOIN watches w ON w.id = wl.watch_id
      LEFT JOIN listing_actions a ON a.marketplace = l.marketplace AND a.listing_id = l.listing_id
      WHERE ${where}
      ORDER BY wl.last_seen_at DESC, wl.id DESC LIMIT ? OFFSET ?`).all(...params, pageSize, (page - 1) * pageSize) as Array<Record<string, any>>;
    const watches = new Map((knownWatches ?? this.getWatches()).map((watch) => [watch.id, watch]));
    const listings = rows.map((row) => this.listingFromRow(row, watches.get(row.watch_id)?.readiness === 100));
    return { listings, pagination: { page, pageSize, total, hasNext: page * pageSize < total } };
  }

  getListings(knownWatches?: Watch[]) {
    return this.listingsPage({ page: 1, pageSize: 500 }, knownWatches).listings;
  }

  listingDetail(key: string, watchId?: string | null): ListingDetail {
    const { marketplace, listingId } = parseListingKey(key);
    const row = this.db.prepare(`SELECT l.*, wl.id AS watch_listing_id, wl.watch_id, wl.first_seen_at AS watch_first_seen_at, wl.last_seen_at AS watch_last_seen_at, wl.typical_pln AS watch_typical_pln, wl.deal_strength AS watch_deal_strength, wl.deal_label AS watch_deal_label, w.name AS watch_name, a.decision AS listing_decision, a.note AS listing_note, a.updated_at AS action_updated_at
      FROM listings l
      LEFT JOIN watch_listings wl ON wl.listing_id = l.id AND (? IS NULL OR wl.watch_id = ?)
      LEFT JOIN watches w ON w.id = wl.watch_id
      LEFT JOIN listing_actions a ON a.marketplace = l.marketplace AND a.listing_id = l.listing_id
      WHERE l.marketplace = ? AND l.listing_id = ? AND (? IS NULL OR wl.watch_id = ?)
      ORDER BY CASE WHEN wl.id IS NOT NULL THEN 0 ELSE 1 END, wl.last_seen_at DESC LIMIT 1`).get(watchId ?? null, watchId ?? null, marketplace, listingId, watchId ?? null, watchId ?? null) as Record<string, any> | undefined;
    if (!row) throw new ServiceError('Listing detail is not available yet', 404);
    const watches = new Map(this.allWatches().map((watch) => [watch.id, watch]));
    const listing = this.listingFromRow(row, watches.get(row.watch_id)?.readiness === 100);
    const history = (this.db.prepare('SELECT price_pln, observed_at FROM observations WHERE listing_id = ? AND (? IS NULL OR watch_id = ?) ORDER BY observed_at DESC, id DESC LIMIT 120').all(row.id, row.watch_id ?? watchId ?? null, row.watch_id ?? watchId ?? null) as Array<{ price_pln: number; observed_at: string }>).reverse().map((point): PriceHistoryPoint => ({ price: Number(point.price_pln), observedAt: point.observed_at }));
    const snapshotRow = this.db.prepare(`SELECT title, price_pln, condition, location, url, description, captured_at, verification_status
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
    return {
      listing,
      history,
      action: { decision: listing.decision ?? null, note: listing.note ?? '', updatedAt: row.action_updated_at ?? null },
      descriptionSnapshot,
      firstSeenAt: row.watch_first_seen_at ?? row.first_seen_at,
      lastSeenAt: row.watch_last_seen_at ?? row.last_seen_at,
    };
  }

  private async normalizeStoredListing(marketplace: Marketplace, listingId: string, force = false) {
    const config = this.deepSeekConfig();
    if (!config.apiKey) throw new ServiceError('OpenRouter is not configured. Add an API key in Settings or set SCOUT_OPENROUTER_API_KEY.', 409);
    const row = this.db.prepare('SELECT marketplace, listing_id, title, condition, location, ai_normalization_json, ai_normalization_input_hash, ai_normalization_model, ai_normalization_at, ai_normalization_error FROM listings WHERE marketplace = ? AND listing_id = ?').get(marketplace, listingId) as Record<string, any> | undefined;
    if (!row) throw new ServiceError('Listing detail is not available yet', 404);

    const source = {
      marketplace,
      title: String(row.title ?? ''),
      condition: row.condition ? String(row.condition) : undefined,
      location: row.location ? String(row.location) : undefined,
    };
    const inputHash = listingNormalizationInputHash(source);
    const legacyInputHash = legacyListingNormalizationInputHash(source);
    const cached = parseStoredListingNormalization(row.ai_normalization_json);
    const sameInput = row.ai_normalization_input_hash === inputHash && row.ai_normalization_model === config.model;
    if (!force && sameInput && cached) return cached;
    if (!force && row.ai_normalization_input_hash === legacyInputHash && row.ai_normalization_model === config.model && cached) {
      this.db.prepare('UPDATE listings SET ai_normalization_input_hash = ? WHERE marketplace = ? AND listing_id = ?').run(inputHash, marketplace, listingId);
      return cached;
    }
    if (!force && sameInput && row.ai_normalization_error && row.ai_normalization_at && Date.now() - Date.parse(row.ai_normalization_at) < 6 * 60 * 60_000) {
      throw new ServiceError(String(row.ai_normalization_error), 502);
    }
    if (!force) {
      const reusable = this.db.prepare(`SELECT ai_normalization_json FROM listings
        WHERE ai_normalization_input_hash = ? AND ai_normalization_model = ? AND ai_normalization_json IS NOT NULL
        ORDER BY ai_normalization_at DESC LIMIT 1`).get(inputHash, config.model) as { ai_normalization_json?: string } | undefined;
      const shared = parseStoredListingNormalization(reusable?.ai_normalization_json);
      if (shared) {
        const normalizedAt = nowIso();
        this.db.prepare('UPDATE listings SET ai_normalization_json = ?, ai_normalization_input_hash = ?, ai_normalization_model = ?, ai_normalization_at = ?, ai_normalization_error = NULL WHERE marketplace = ? AND listing_id = ?').run(JSON.stringify(shared), inputHash, config.model, normalizedAt, marketplace, listingId);
        this.emit('ai-normalization', { key: `${marketplace}:${listingId}`, status: 'ready' });
        return shared;
      }
    }

    try {
      const normalization = await normalizeListingWithDeepSeek(source, { apiKey: config.apiKey, model: config.model });
      const normalizedAt = nowIso();
      this.db.prepare('UPDATE listings SET ai_normalization_json = ?, ai_normalization_input_hash = ?, ai_normalization_model = ?, ai_normalization_at = ?, ai_normalization_error = NULL WHERE marketplace = ? AND listing_id = ?').run(JSON.stringify(normalization), inputHash, config.model, normalizedAt, marketplace, listingId);
      this.emit('ai-normalization', { key: `${marketplace}:${listingId}`, status: 'ready' });
      return normalization;
    } catch (error) {
      const message = (error instanceof ServiceError ? error.message : error instanceof Error ? error.message : 'Listing normalization failed').slice(0, 500);
      const attemptedAt = nowIso();
      this.db.prepare('UPDATE listings SET ai_normalization_json = NULL, ai_normalization_input_hash = ?, ai_normalization_model = ?, ai_normalization_at = ?, ai_normalization_error = ? WHERE marketplace = ? AND listing_id = ?').run(inputHash, config.model, attemptedAt, message, marketplace, listingId);
      this.emit('ai-normalization', { key: `${marketplace}:${listingId}`, status: 'error' });
      if (error instanceof ServiceError) throw error;
      throw new ServiceError(message, error instanceof DeepSeekError ? 502 : 500);
    }
  }

  async normalizeListingByKey(key: string, force = false) {
    const { marketplace, listingId } = parseListingKey(key);
    await this.normalizeStoredListing(marketplace, listingId, force);
    return this.listingDetail(key);
  }

  listingAction(key: string): ListingAction {
    const { marketplace, listingId } = parseListingKey(key);
    const row = this.db.prepare('SELECT decision, note, updated_at FROM listing_actions WHERE marketplace = ? AND listing_id = ?').get(marketplace, listingId) as { decision?: unknown; note?: string; updated_at?: string } | undefined;
    return { decision: parseListingDecision(row?.decision), note: row?.note ?? '', updatedAt: row?.updated_at ?? null };
  }

  updateListingAction(key: string, decision: ListingDecision | null, note: string): ListingAction {
    const { marketplace, listingId } = parseListingKey(key);
    const safeNote = note.trim().slice(0, 2000);
    const timestamp = nowIso();
    if (decision === null && !safeNote) {
      this.db.prepare('DELETE FROM listing_actions WHERE marketplace = ? AND listing_id = ?').run(marketplace, listingId);
    } else {
      this.db.prepare(`INSERT INTO listing_actions (marketplace, listing_id, decision, note, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(marketplace, listing_id) DO UPDATE SET decision = excluded.decision, note = excluded.note, updated_at = excluded.updated_at`).run(marketplace, listingId, decision, safeNote, timestamp);
    }
    this.emit('listing-action', { key, decision });
    return { decision, note: safeNote, updatedAt: safeNote || decision ? timestamp : null };
  }

  private sellerMessageFromRow(row: Record<string, any>): SellerMessage {
    return {
      id: Number(row.id),
      marketplace: row.marketplace as Marketplace,
      listingId: String(row.listing_id),
      listingTitle: String(row.listing_title),
      listingUrl: String(row.listing_url),
      message: String(row.message),
      offerPrice: row.offer_price_pln === null || row.offer_price_pln === undefined ? null : Number(row.offer_price_pln),
      model: String(row.model),
      source: row.source === 'automatic' ? 'automatic' : 'manual',
      status: row.status === 'failed' ? 'failed' : 'sent',
      error: row.error ? String(row.error) : null,
      createdAt: String(row.created_at),
      sentAt: row.sent_at ? String(row.sent_at) : null,
    };
  }

  messages(): SellerMessage[] {
    return this.messagesPage().messages;
  }

  messagesPage(options: { page?: number; pageSize?: number } = {}) {
    const page = Math.max(1, Math.floor(options.page ?? 1));
    const pageSize = Math.max(1, Math.min(200, Math.floor(options.pageSize ?? 100)));
    const total = Number((this.db.prepare('SELECT COUNT(*) AS count FROM seller_messages').get() as { count?: number }).count ?? 0);
    const rows = this.db.prepare('SELECT * FROM seller_messages ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?').all(pageSize, (page - 1) * pageSize) as Array<Record<string, any>>;
    return { messages: rows.map((row) => this.sellerMessageFromRow(row)), pagination: { page, pageSize, total, hasNext: page * pageSize < total } };
  }

  private saveSellerMessage(input: {
    marketplace: Marketplace;
    listingId: string;
    listingTitle: string;
    listingUrl: string;
    message: string;
    offerPrice: number | null;
    model: string;
    source?: SellerMessageSource;
    status: 'sent' | 'failed';
    error?: string | null;
    createdAt: string;
    sentAt?: string | null;
  }) {
    const result = this.db.prepare(`INSERT INTO seller_messages (marketplace, listing_id, listing_title, listing_url, message, offer_price_pln, model, source, status, error, created_at, sent_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      input.marketplace,
      input.listingId,
      input.listingTitle,
      input.listingUrl,
      input.message,
      input.offerPrice,
      input.model,
      input.source ?? 'manual',
      input.status,
      input.error ? input.error.slice(0, 500) : null,
      input.createdAt,
      input.sentAt ?? null,
    );
    return this.sellerMessageFromRow(this.db.prepare('SELECT * FROM seller_messages WHERE id = ?').get(Number(result.lastInsertRowid)) as Record<string, any>);
  }

  recommendNegotiationPriceByKey(key: string, maxTotalCost: number | null = null, shippingCost = 0, otherCosts = 0, openingDiscountPercent?: number): NegotiationRecommendation {
    const { marketplace } = parseListingKey(key);
    if (marketplace !== 'OLX' && marketplace !== 'Allegro Lokalnie') throw new ServiceError('AI seller negotiation is currently available for OLX and Allegro Lokalnie only.', 409);
    const detail = this.listingDetail(key);
    try {
      return recommendNegotiationPrice({
        askingPrice: detail.listing.price,
        priceNegotiable: detail.listing.priceNegotiable ?? null,
        maxTotalCost,
        shippingCost,
        otherCosts,
        openingDiscountPercent,
      });
    } catch (error) {
      throw new ServiceError(error instanceof Error ? error.message : 'Could not calculate a negotiation price.', 400);
    }
  }

  private prepareNegotiation(key: string, offerPrice: number | null, budget: { maxTotalCost: number; shippingCost?: number; otherCosts?: number } | undefined, source: SellerMessageSource) {
    const { marketplace, listingId } = parseListingKey(key);
    if (marketplace !== 'OLX' && marketplace !== 'Allegro Lokalnie') throw new ServiceError('AI seller negotiation is currently available for OLX and Allegro Lokalnie only.', 409);
    const row = this.db.prepare('SELECT marketplace, listing_id, title, price_pln, url, condition, location, price_negotiable FROM listings WHERE marketplace = ? AND listing_id = ?').get(marketplace, listingId) as Record<string, any> | undefined;
    if (!row) throw new ServiceError('Listing detail is not available yet', 404);

    const config = this.deepSeekConfig();
    if (!config.apiKey) throw new ServiceError('OpenRouter is not configured. Add an API key in Settings or set SCOUT_OPENROUTER_API_KEY.', 409);

    const askingPrice = Number(row.price_pln);
    if (!Number.isFinite(askingPrice) || askingPrice <= 0) throw new ServiceError('The listing does not have a valid positive asking price.', 409);
    if (source === 'automatic' && row.price_negotiable !== 1) {
      throw new ServiceError('Automatic negotiation requires an explicit negotiable-price signal.', 409);
    }
    const normalizedOffer = offerPrice === null || offerPrice === undefined ? null : Math.round(Number(offerPrice) * 100) / 100;
    if (normalizedOffer !== null && (!Number.isFinite(normalizedOffer) || normalizedOffer <= 0 || normalizedOffer >= askingPrice)) {
      throw new ServiceError('Opening offer must be positive and lower than the listing price.', 400);
    }
    if (normalizedOffer !== null && budget) {
      let ceiling: number;
      try {
        ceiling = offerCeiling(budget.maxTotalCost, askingPrice, budget.shippingCost ?? 0, budget.otherCosts ?? 0);
      } catch (error) {
        throw new ServiceError(error instanceof Error ? error.message : 'Invalid negotiation budget.', 400);
      }
      if (normalizedOffer > ceiling) {
        throw new ServiceError(`Opening offer cannot exceed your ${ceiling.toLocaleString('pl-PL')} zł total-cost ceiling after known costs.`, 400);
      }
    }

    const context: NegotiationListingContext = {
      marketplace,
      title: safePromptText(row.title, 180),
      price: askingPrice,
      condition: row.condition ? safePromptText(row.condition, 80) : undefined,
      location: row.location ? safePromptText(row.location, 100) : undefined,
      priceNegotiable: row.price_negotiable === null || row.price_negotiable === undefined ? null : Boolean(row.price_negotiable),
      offerPrice: normalizedOffer,
    };
    return { marketplace, listingId, row, config, askingPrice, normalizedOffer, context };
  }

  async draftNegotiationByKey(key: string, offerPrice: number | null = null, budget?: { maxTotalCost: number; shippingCost?: number; otherCosts?: number }) {
    const prepared = this.prepareNegotiation(key, offerPrice, budget, 'manual');
    let draft: { message: string };
    try {
      draft = await this.draftNegotiation(prepared.context, { apiKey: prepared.config.apiKey!, model: prepared.config.model });
    } catch (error) {
      const message = (error instanceof Error ? error.message : 'OpenRouter could not write a negotiation message').slice(0, 500);
      throw new ServiceError(message, error instanceof DeepSeekError ? error.status : 502);
    }
    const message = validateNegotiationMessage(draft.message, prepared.normalizedOffer);
    return { message, model: prepared.config.model, askingPrice: prepared.askingPrice, offerPrice: prepared.normalizedOffer, marketplace: prepared.marketplace, listingId: prepared.listingId, title: safePromptText(prepared.row.title, 240) };
  }

  async negotiateAndSendByKey(key: string, offerPrice: number | null = null, budget?: { maxTotalCost: number; shippingCost?: number; otherCosts?: number }, source: SellerMessageSource = 'manual', messageOverride?: string) {
    const prepared = this.prepareNegotiation(key, offerPrice, budget, source);
    const messageKey = `${prepared.marketplace}:${prepared.listingId}`;
    if (this.messagingInFlight.has(messageKey)) throw new ServiceError('A message for this listing is already being delivered.', 409);
    if (this.messagingInFlight.size >= 2) throw new ServiceError('Two marketplace messages are already being delivered. Try again shortly.', 429);
    this.messagingInFlight.add(messageKey);
    try {
      const draft = messageOverride === undefined
        ? await this.draftNegotiationByKey(key, offerPrice, budget)
        : { message: validateNegotiationMessage(messageOverride, prepared.normalizedOffer), model: prepared.config.model };

      try {
        if (!this.readMarketplaceSession(prepared.marketplace)) throw new ServiceError(`Connect your ${prepared.marketplace} account in Settings before sending seller messages.`, 409);
      } catch (error) {
        if (error instanceof ServiceError) throw error;
        throw new ServiceError(error instanceof Error ? error.message : `The ${prepared.marketplace} session could not be read. Re-import it in Settings.`, 409);
      }

      const createdAt = nowIso();
      try {
        await this.sendMarketplaceMessage(prepared.marketplace, String(prepared.row.url), draft.message);
      } catch (error) {
        const message = (error instanceof Error ? error.message : `${prepared.marketplace} could not send the negotiation message`).slice(0, 500);
        const failed = this.saveSellerMessage({ marketplace: prepared.marketplace, listingId: prepared.listingId, listingTitle: String(prepared.row.title), listingUrl: String(prepared.row.url), message: draft.message, offerPrice: prepared.normalizedOffer, model: prepared.config.model, source, status: 'failed', error: message, createdAt });
        this.emit('seller-message', { id: failed.id, key, status: failed.status });
        const status = ((error instanceof OlxMessagingError || error instanceof AllegroMessagingError) && error.code === 'session') ? 409 : 502;
        throw new ServiceError(message, status);
      }

      const sentAt = nowIso();
      const sent = this.saveSellerMessage({ marketplace: prepared.marketplace, listingId: prepared.listingId, listingTitle: String(prepared.row.title), listingUrl: String(prepared.row.url), message: draft.message, offerPrice: prepared.normalizedOffer, model: prepared.config.model, source, status: 'sent', createdAt, sentAt });
      this.emit('seller-message', { id: sent.id, key, status: sent.status });
      return { message: sent };
    } finally {
      this.messagingInFlight.delete(messageKey);
    }
  }

  private claimAutomaticNegotiation(candidate: DealNotificationCandidate, recommendation: NegotiationRecommendation, config: AutoNegotiationConfig) {
    if (config.maxTotalCost === null || recommendation.openingOffer === null) return false;
    const now = nowIso();
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT status, attempt_count, updated_at FROM automatic_negotiations WHERE marketplace = ? AND listing_id = ?').get(candidate.listing.marketplace, candidate.listing.listingId) as { status?: string; attempt_count?: number; updated_at?: string } | undefined;
      if (existing?.status === 'sent') return false;
      if (existing?.status === 'processing' && existing.updated_at && Date.parse(existing.updated_at) > Date.now() - 15 * 60_000) return false;
      if (existing && Number(existing.attempt_count ?? 0) >= 5) return false;
      const attemptedToday = this.db.prepare('SELECT COUNT(*) AS count FROM automatic_negotiations WHERE created_at >= ?').get(this.currentDayStart()) as { count?: number } | undefined;
      if (Number(attemptedToday?.count ?? 0) >= config.dailyLimit) return false;
      if (existing) {
        this.db.prepare(`UPDATE automatic_negotiations SET watch_id = ?, status = 'processing', asking_price_pln = ?, offer_price_pln = ?, max_total_cost_pln = ?, known_costs_pln = ?, discount_percent = ?, attempt_count = attempt_count + 1, error = NULL, updated_at = ?
          WHERE marketplace = ? AND listing_id = ?`).run(candidate.watchId, recommendation.askingPrice, recommendation.openingOffer, config.maxTotalCost, recommendation.knownCosts, candidate.discountPercent, now, candidate.listing.marketplace, candidate.listing.listingId);
      } else {
        this.db.prepare(`INSERT INTO automatic_negotiations (marketplace, listing_id, watch_id, status, asking_price_pln, offer_price_pln, max_total_cost_pln, known_costs_pln, discount_percent, attempt_count, created_at, updated_at)
          VALUES (?, ?, ?, 'processing', ?, ?, ?, ?, ?, 1, ?, ?)`).run(candidate.listing.marketplace, candidate.listing.listingId, candidate.watchId, recommendation.askingPrice, recommendation.openingOffer, config.maxTotalCost, recommendation.knownCosts, candidate.discountPercent, now, now);
      }
      return true;
    });
  }

  private finishAutomaticNegotiation(key: string, status: 'sent' | 'failed', messageId: number | null, error?: unknown) {
    const { marketplace, listingId } = parseListingKey(key);
    const safeError = error === undefined || error === null ? null : (error instanceof Error ? error.message : String(error)).slice(0, 500);
    this.db.prepare('UPDATE automatic_negotiations SET status = ?, message_id = ?, error = ?, updated_at = ? WHERE marketplace = ? AND listing_id = ?').run(status, messageId, safeError, nowIso(), marketplace, listingId);
  }

  private async automaticallyNegotiate(candidate: DealNotificationCandidate) {
    const config = this.autoNegotiationConfig();
    if (!config.enabled || (candidate.listing.marketplace !== 'OLX' && candidate.listing.marketplace !== 'Allegro Lokalnie') || config.maxTotalCost === null) return;
    if (candidate.discountPercent < config.minimumDiscountPercent || candidate.listing.priceNegotiable !== true) return;
    if (!this.deepSeekConfig().apiKey) return;
    try {
      if (!this.readMarketplaceSession(candidate.listing.marketplace)) return;
    } catch {
      return;
    }

    const key = `${candidate.listing.marketplace}:${candidate.listing.listingId}`;
    let recommendation: NegotiationRecommendation;
    try {
      recommendation = this.recommendNegotiationPriceByKey(key, config.maxTotalCost, config.shippingCost, config.otherCosts, config.openingDiscountPercent);
    } catch {
      return;
    }
    if (recommendation.status !== 'ready' || recommendation.openingOffer === null) return;
    if (!this.claimAutomaticNegotiation(candidate, recommendation, config)) return;

    try {
      const result = await this.negotiateAndSendByKey(key, recommendation.openingOffer, {
        maxTotalCost: config.maxTotalCost,
        shippingCost: config.shippingCost,
        otherCosts: config.otherCosts,
      }, 'automatic');
      this.finishAutomaticNegotiation(key, 'sent', result.message.id);
    } catch (error) {
      this.finishAutomaticNegotiation(key, 'failed', null, error);
    }
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

  async manualSearch(input: SearchFilters): Promise<ManualSearchResponse> {
    if (this.activeManualSearches >= 3) throw new ServiceError('Three manual searches are already running. Try again shortly.', 429);
    this.activeManualSearches += 1;
    try {
      const tasks = input.sources.map(async (source) => {
      const started = Date.now();
      try {
        const fetched = await this.fetchSearchPages(source, input.query, input);
        const deterministicFilters = { minPrice: input.minPrice, maxPrice: input.maxPrice, condition: input.condition, location: input.location, shippingOnly: false };
        const comparable = filterListings(fetched, input.query, input.terms ?? '', input.excluded ?? '', deterministicFilters);
        // Cache-first like watch scans: only a few cold listings fetch an item
        // page per search; the rest surface as pending delivery checks.
        if (input.shippingOnly) await this.enrichShipping(comparable, source);
        const filtered = filterListings(comparable, input.query, input.terms ?? '', input.excluded ?? '', { ...deterministicFilters, shippingOnly: input.shippingOnly });
        // One-off search stays deterministic: AI relevance is a watch-scan gate.
        for (const listing of filtered.slice(0, 100)) this.storeManualListing(listing);
        const pendingShipping = input.shippingOnly ? comparable.filter((listing) => listing.shippingAvailable === null).length : 0;
        return {
          listings: filtered.slice(0, 100).map((listing): Listing => ({
            id: `${listing.marketplace}:${listing.listingId}`, title: listing.title,
            subtitle: [listing.condition, listing.location].filter(Boolean).join(' · '), marketplace: listing.marketplace,
            price: listing.price, typical: null, belowTypical: null, observed: 'just now', observedAt: listing.observedAt,
            dealStrength: 1, dealLabel: 'Watch', image: listing.imageUrl ?? '', url: listing.url, watch: 'Manual search',
            condition: listing.condition, location: listing.location, shippingAvailable: listing.shippingAvailable ?? null, priceNegotiable: listing.priceNegotiable ?? null,
          })),
          status: { source, status: 'ok' as const, count: filtered.length, pendingShipping, durationMs: Date.now() - started, message: filtered.length ? `${filtered.length} matches` : 'No matching listings' },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Search failed';
        return { listings: [] as Listing[], status: { source, status: 'error' as const, count: 0, pendingShipping: 0, durationMs: Date.now() - started, message } };
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
      ? this.db.prepare('SELECT * FROM market_watch_versions WHERE id = ?').get(row.active_version_id) as WatchRow | undefined
      : undefined;
    return version ?? {
      id: `${row.id}:legacy`, market_watch_id: row.id, query: row.query, included_terms: row.included_terms ?? '', excluded_terms: row.excluded_terms ?? '', location: row.location ?? 'Polska', condition: row.condition ?? 'Any', sources_json: row.sources_json, min_price_pln: row.min_price_pln, max_price_pln: row.max_price_pln, shipping_only: row.shipping_only, typo_variants: row.typo_variants,
    };
  }

  private ensureMarketWatchVersion(row: WatchRow) {
    if (row.active_version_id) return this.marketWatchVersion(row);
    const versionId = `${row.id}:v1`;
    const now = nowIso();
    this.transaction(() => {
      this.db.prepare('INSERT OR IGNORE INTO market_watch_versions (id, market_watch_id, query, included_terms, excluded_terms, location, condition, sources_json, min_price_pln, max_price_pln, shipping_only, typo_variants, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(versionId, row.id, row.query, row.included_terms ?? '', row.excluded_terms ?? '', row.location ?? 'Polska', row.condition ?? 'Any', row.sources_json, row.min_price_pln, row.max_price_pln, row.shipping_only ? 1 : 0, row.typo_variants ? 1 : 0, now);
      this.db.prepare("UPDATE market_listings SET version_id = ? WHERE market_watch_id = ? AND version_id IS NULL AND status <> 'superseded'").run(versionId, row.id);
      this.db.prepare('UPDATE market_price_observations SET version_id = ? WHERE market_listing_id IN (SELECT id FROM market_listings WHERE market_watch_id = ?) AND version_id IS NULL').run(versionId, row.id);
      this.db.prepare('UPDATE market_watches SET active_version_id = ? WHERE id = ? AND active_version_id IS NULL').run(versionId, row.id);
    });
    const refreshed = this.db.prepare('SELECT * FROM market_watches WHERE id = ?').get(row.id) as WatchRow;
    return this.marketWatchVersion(refreshed);
  }

  marketResearch(options: { page?: number; pageSize?: number; watchId?: string; status?: 'active' | 'ended' | 'superseded' } = {}): MarketResearchData {
    const watchRows = this.db.prepare('SELECT * FROM market_watches ORDER BY created_at DESC').all() as WatchRow[];
    const activeVersionIds = watchRows.flatMap((row) => row.active_version_id ? [row.active_version_id] : []);
    const versionRows = activeVersionIds.length
      ? this.db.prepare(`SELECT * FROM market_watch_versions WHERE id IN (${activeVersionIds.map(() => '?').join(',')})`).all(...activeVersionIds) as WatchRow[]
      : [];
    const versionsById = new Map(versionRows.map((version) => [version.id, version]));
    const versionsByWatch = new Map(watchRows.map((row) => [row.id, versionsById.get(row.active_version_id ?? '') ?? {
      id: `${row.id}:legacy`, market_watch_id: row.id, query: row.query, included_terms: row.included_terms ?? '', excluded_terms: row.excluded_terms ?? '', location: row.location ?? 'Polska', condition: row.condition ?? 'Any', sources_json: row.sources_json, min_price_pln: row.min_price_pln, max_price_pln: row.max_price_pln, shipping_only: row.shipping_only, typo_variants: row.typo_variants,
    }]));
    const versionFilter = '(ml.version_id = mw.active_version_id OR (mw.active_version_id IS NULL AND ml.version_id IS NULL))';
    const watchStats = this.db.prepare(`SELECT ml.market_watch_id,
        COUNT(*) AS total,
        SUM(CASE WHEN ml.status = 'active' THEN 1 ELSE 0 END) AS active,
        SUM(CASE WHEN ml.status = 'ended' THEN 1 ELSE 0 END) AS ended
      FROM market_listings ml
      JOIN market_watches mw ON mw.id = ml.market_watch_id
      WHERE ml.status IN ('active', 'ended') AND ${versionFilter}
      GROUP BY ml.market_watch_id`).all() as Array<{ market_watch_id: string; total: number; active: number | null; ended: number | null }>;
    const statsByWatch = new Map(watchStats.map((stats) => [stats.market_watch_id, stats]));
    const endedPriceRows = this.db.prepare(`SELECT ml.market_watch_id, ml.last_price_pln
      FROM market_listings ml
      JOIN market_watches mw ON mw.id = ml.market_watch_id
      WHERE ml.status = 'ended' AND ml.last_price_pln > 0 AND ${versionFilter}`).all() as Array<{ market_watch_id: string; last_price_pln: number }>;
    const endedPricesByWatch = new Map<string, number[]>();
    for (const item of endedPriceRows) {
      const prices = endedPricesByWatch.get(item.market_watch_id) ?? [];
      prices.push(Number(item.last_price_pln));
      endedPricesByWatch.set(item.market_watch_id, prices);
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
        id: row.id, name: row.name, query: version.query, terms: version.included_terms ?? '', excluded: version.excluded_terms ?? '', location: version.location ?? 'Polska', condition: version.condition ?? 'Any', sources: parseJson<Marketplace[]>(version.sources_json, []),
        intervalHours: Number(row.interval_hours), minPrice: version.min_price_pln === null || version.min_price_pln === undefined ? null : Number(version.min_price_pln), maxPrice: version.max_price_pln === null || version.max_price_pln === undefined ? null : Number(version.max_price_pln), shippingOnly: Boolean(version.shipping_only), typoVariants: Boolean(version.typo_variants), enabled: Boolean(row.enabled), nextScan: Boolean(row.enabled) ? relativeTimeFuture(row.next_scan_at) : 'Paused',
        lastScan: relativeTime(row.last_scan_at), totalListings: Number(counts.total ?? 0), activeListings: Number(counts.active ?? 0), endedListings: Number(counts.ended ?? 0),
        estimatedMedianPrice: endedPrices.length ? median(endedPrices) : null,
        saleBand: computeSaleBand(bandSamplesByWatch.get(row.id) ?? [], SALE_BAND_WINDOW_DAYS, bandComputedAt),
      };
    });
    const applicable = [
      `SELECT ml.last_price_pln FROM market_listings ml JOIN market_watches mw ON mw.id = ml.market_watch_id WHERE ml.status = 'ended' AND ml.last_price_pln > 0 AND ${versionFilter}`,
      ...(options.watchId ? ['AND ml.market_watch_id = ?'] : []),
    ].join(' ');
    const aggregateParams = options.watchId ? [options.watchId] : [];
    const aggregatePrices = (this.db.prepare(applicable).all(...aggregateParams) as Array<{ last_price_pln: number }>).map((item) => Number(item.last_price_pln));
    const aggregateCounts = this.db.prepare(`SELECT SUM(CASE WHEN ml.status = 'active' THEN 1 ELSE 0 END) AS active, SUM(CASE WHEN ml.status = 'ended' THEN 1 ELSE 0 END) AS ended FROM market_listings ml JOIN market_watches mw ON mw.id = ml.market_watch_id WHERE ml.status IN ('active', 'ended') AND ${versionFilter}${options.watchId ? ' AND ml.market_watch_id = ?' : ''}`).get(...aggregateParams) as { active?: number; ended?: number };

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
    const total = Number((this.db.prepare(`SELECT COUNT(*) AS count FROM market_listings ml JOIN market_watches mw ON mw.id = ml.market_watch_id WHERE ${predicates.join(' AND ')}`).get(...params) as { count?: number }).count ?? 0);
    const rows = this.db.prepare(`SELECT ml.*, mw.name AS watch_name,
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
    return this.db.prepare(`SELECT ml.market_watch_id, ml.last_price_pln, ml.last_seen_at, ml.ended_at, ml.ended_reason
      FROM market_listings ml
      JOIN market_watches mw ON mw.id = ml.market_watch_id
      WHERE ml.status = 'ended' AND ml.last_price_pln > 0 AND ml.ended_at IS NOT NULL AND ${versionFilter}${watchId ? ' AND ml.market_watch_id = ?' : ''}`)
      .all(...(watchId ? [watchId] : [])) as Array<{ market_watch_id: string; last_price_pln: number; last_seen_at: string; ended_at: string; ended_reason: string | null }>;
  }

  private toBandSample(row: { last_price_pln: number; last_seen_at: string; ended_at: string; ended_reason: string | null }): MarketBandSample {
    return { price: Number(row.last_price_pln), lastSeenAt: String(row.last_seen_at), endedAt: String(row.ended_at), endedReason: row.ended_reason };
  }

  /**
   * Daily active-market trend for one research series, with the current
   * probable-sale band median as a reference line.
   */
  marketWatchTrend(id: string, rangeDays = 90): MarketWatchTrend {
    const row = this.db.prepare('SELECT id, name FROM market_watches WHERE id = ?').get(id) as WatchRow | undefined;
    if (!row) throw new ServiceError('Market watch not found', 404);
    const days = Math.max(7, Math.min(180, Math.floor(rangeDays)));
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60_000).toISOString();
    const rawRows = this.db.prepare(`SELECT mpo.market_listing_id, mpo.price_pln, mpo.observed_at
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
    const rows = this.db.prepare('SELECT price_pln, observed_at FROM market_price_observations WHERE market_listing_id = ? ORDER BY observed_at ASC, id ASC LIMIT 120').all(marketListingId) as Array<{ price_pln: number; observed_at: string }>;
    return rows.map((point) => ({ price: Number(point.price_pln), observedAt: point.observed_at }));
  }

  queueMarketScan(id: string) {
    const row = this.db.prepare('SELECT * FROM market_watches WHERE id = ? AND enabled = 1').get(id) as WatchRow | undefined;
    if (!row) throw new ServiceError('Enabled market watch not found', 404);
    void this.runMarketWatch(row);
    return { queued: true, message: `Queued ${row.name}` };
  }

  createMarketWatch(input: {
    id: string;
    name: string;
    query: string;
    terms: string;
    excluded: string;
    location: string;
    condition: string;
    sources: Marketplace[];
    intervalHours: number;
    minPrice: number | null;
    maxPrice: number | null;
    shippingOnly: boolean;
    typoVariants: boolean;
  }) {
    const now = nowIso();
    const versionId = `${input.id}:v1`;
    this.transaction(() => {
      this.db.prepare('INSERT INTO market_watches (id, name, query, included_terms, excluded_terms, location, condition, sources_json, interval_hours, min_price_pln, max_price_pln, shipping_only, typo_variants, enabled, active_version_id, next_scan_at, last_scan_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, NULL, ?, ?)').run(input.id, input.name, input.query, input.terms, input.excluded, input.location, input.condition, JSON.stringify(input.sources), input.intervalHours, input.minPrice, input.maxPrice, input.shippingOnly ? 1 : 0, input.typoVariants ? 1 : 0, versionId, now, now, now);
      this.db.prepare('INSERT INTO market_watch_versions (id, market_watch_id, query, included_terms, excluded_terms, location, condition, sources_json, min_price_pln, max_price_pln, shipping_only, typo_variants, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(versionId, input.id, input.query, input.terms, input.excluded, input.location, input.condition, JSON.stringify(input.sources), input.minPrice, input.maxPrice, input.shippingOnly ? 1 : 0, input.typoVariants ? 1 : 0, now);
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
    location?: string;
    condition?: string;
    sources?: Marketplace[];
    minPrice?: number | null;
    maxPrice?: number | null;
    shippingOnly?: boolean;
    typoVariants?: boolean;
  }) {
    const row = this.db.prepare('SELECT * FROM market_watches WHERE id = ?').get(id) as WatchRow | undefined;
    if (!row) throw new ServiceError('Market watch not found', 404);
    const currentVersion = this.marketWatchVersion(row);
    const criteriaChanged = patch.query !== undefined || patch.terms !== undefined || patch.excluded !== undefined || patch.location !== undefined || patch.condition !== undefined || patch.sources !== undefined || patch.minPrice !== undefined || patch.maxPrice !== undefined || patch.shippingOnly !== undefined || patch.typoVariants !== undefined;
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
          location: patch.location ?? String(currentVersion.location ?? 'Polska'),
          condition: patch.condition ?? String(currentVersion.condition ?? 'Any'),
          sources: patch.sources ?? parseJson<Marketplace[]>(currentVersion.sources_json, []),
          minPrice: patch.minPrice === undefined ? (currentVersion.min_price_pln === null || currentVersion.min_price_pln === undefined ? null : Number(currentVersion.min_price_pln)) : patch.minPrice,
          maxPrice: patch.maxPrice === undefined ? (currentVersion.max_price_pln === null || currentVersion.max_price_pln === undefined ? null : Number(currentVersion.max_price_pln)) : patch.maxPrice,
          shippingOnly: patch.shippingOnly === undefined ? Boolean(currentVersion.shipping_only) : patch.shippingOnly,
          typoVariants: patch.typoVariants === undefined ? Boolean(currentVersion.typo_variants) : patch.typoVariants,
        };
        const changed = next.query !== currentVersion.query || next.terms !== (currentVersion.included_terms ?? '') || next.excluded !== (currentVersion.excluded_terms ?? '') || next.location !== (currentVersion.location ?? 'Polska') || next.condition !== (currentVersion.condition ?? 'Any') || JSON.stringify(next.sources) !== String(currentVersion.sources_json) || next.minPrice !== (currentVersion.min_price_pln ?? null) || next.maxPrice !== (currentVersion.max_price_pln ?? null) || next.shippingOnly !== Boolean(currentVersion.shipping_only) || next.typoVariants !== Boolean(currentVersion.typo_variants);
        if (changed) {
          const versionId = `${id}:v${Date.now()}-${randomBytes(3).toString('hex')}`;
          if (row.active_version_id) this.db.prepare('UPDATE market_watch_versions SET closed_at = ? WHERE id = ? AND closed_at IS NULL').run(now, row.active_version_id);
          this.db.prepare('INSERT INTO market_watch_versions (id, market_watch_id, query, included_terms, excluded_terms, location, condition, sources_json, min_price_pln, max_price_pln, shipping_only, typo_variants, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(versionId, id, next.query, next.terms, next.excluded, next.location, next.condition, JSON.stringify(next.sources), next.minPrice, next.maxPrice, next.shippingOnly ? 1 : 0, next.typoVariants ? 1 : 0, now);
          this.db.prepare("UPDATE market_listings SET status = 'superseded', ended_at = COALESCE(ended_at, ?), ended_reason = COALESCE(ended_reason, 'Research criteria changed') WHERE market_watch_id = ? AND (version_id = ? OR version_id IS NULL) AND status <> 'superseded'").run(now, id, row.active_version_id ?? currentVersion.id);
          directFields.push('query = ?', 'included_terms = ?', 'excluded_terms = ?', 'location = ?', 'condition = ?', 'sources_json = ?', 'min_price_pln = ?', 'max_price_pln = ?', 'shipping_only = ?', 'typo_variants = ?', 'active_version_id = ?', 'next_scan_at = ?');
          directValues.push(next.query, next.terms, next.excluded, next.location, next.condition, JSON.stringify(next.sources), next.minPrice, next.maxPrice, next.shippingOnly ? 1 : 0, next.typoVariants ? 1 : 0, versionId, now);
        }
      }
      if (!directFields.length) throw new ServiceError('No supported fields', 400);
      directValues.push(now, id);
      this.db.prepare(`UPDATE market_watches SET ${directFields.join(', ')}, updated_at = ? WHERE id = ?`).run(...(directValues as any[]));
    });
    this.emit('market-watch', { refresh: true, id });
    return { ok: true } as const;
  }

  deleteMarketWatch(id: string) {
    const result = this.db.prepare('DELETE FROM market_watches WHERE id = ?').run(id);
    if (!result.changes) throw new ServiceError('Market watch not found', 404);
  }

  private async runMarketWatch(row: WatchRow) {
    const runningKey = `market:${row.id}`;
    if (this.running.has(runningKey)) return;
    this.running.add(runningKey);
    const sources = parseJson<Marketplace[]>(row.sources_json, []);
    const version = this.ensureMarketWatchVersion(row);
    let latestBackoffUntil: string | null = null;
    try {
      await Promise.all(sources.map(async (source) => {
        const paths: string[] = [];
        const onPath: ConnectorPathReporter = (path) => { if (!paths.includes(path)) paths.push(path); };
        const started = nowIso();
        const latest = this.db.prepare('SELECT backoff_until FROM connector_runs WHERE source = ? ORDER BY started_at DESC LIMIT 1').get(source) as { backoff_until?: string } | undefined;
        const backoffUntil = latest?.backoff_until && Date.parse(latest.backoff_until) > Date.now() ? latest.backoff_until : null;
        if (backoffUntil && (!latestBackoffUntil || Date.parse(backoffUntil) > Date.parse(latestBackoffUntil))) latestBackoffUntil = backoffUntil;
        const runId = this.recordRun(source, backoffUntil ? 'skipped' : 'running', backoffUntil ? `Skipped research for ${row.name}; connector backoff is active` : `Researching ${row.name}`, started, backoffUntil ? started : null);
        const scanId = this.createScan(String(row.id), 'research', source, started);
        if (backoffUntil) {
          this.db.prepare("UPDATE scans SET status = 'skipped', completed_at = ?, error = ? WHERE id = ?").run(started, `Connector backoff active until ${backoffUntil}`, scanId);
          this.log('info', 'research', `${row.name} · ${source}: skipped (connector backoff until ${backoffUntil})`);
          return;
        }
        try {
          const adapter = this.createConnectorAdapter(source, onPath);
          const searchFilters = { minPrice: row.min_price_pln, maxPrice: row.max_price_pln, condition: row.condition, shippingOnly: Boolean(row.shipping_only), location: row.location, sort: 'newest' as const };
          const mainListings = await this.fetchSearchPages(source, row.query, searchFilters, onPath);
          // Typo variants come from the immutable criteria version, like every
          // other research criterion, and append one page per variant query.
          const variantQueries = version.typo_variants
            ? pickVariantBatch(typoVariants(String(version.query ?? row.query)), this.scanOrdinal(String(row.id), 'research'), TYPO_VARIANTS_PER_SCAN)
            : [];
          const variantFetches: string[] = [];
          for (const variantQuery of variantQueries) {
            variantFetches.push(`"${variantQuery}"`);
            mainListings.push(...await this.fetchSearchPages(source, variantQuery, searchFilters, onPath));
          }
          const fetched = [...new Map(mainListings.map((listing) => [`${listing.marketplace}:${listing.listingId}`, listing])).values()];
          this.log('info', 'research', `${row.name} · ${source}: query-search${variantFetches.length ? ` + typo-variants (${variantFetches.join(', ')})` : ''} → ${paths.join(' → ') || 'no fetch'} · fetched=${fetched.length}`);
          const filters = { minPrice: row.min_price_pln, maxPrice: row.max_price_pln, condition: row.condition, location: row.location, shippingOnly: false };
          const comparable = filterListings(fetched, row.query, row.included_terms ?? '', row.excluded_terms ?? '', filters);
          if (row.shipping_only) await this.enrichShipping(comparable, source);
          const filtered = filterListings(comparable, row.query, row.included_terms ?? '', row.excluded_terms ?? '', { ...filters, shippingOnly: Boolean(row.shipping_only) });
          const observedAt = nowIso();
          const seen = new Set(filtered.map((listing) => listing.listingId));
          const active = this.db.prepare("SELECT id, listing_id, url, missing_scans FROM market_listings WHERE market_watch_id = ? AND version_id = ? AND marketplace = ? AND status = 'active'").all(row.id, version.id, source) as Array<{ id: number; listing_id: string; url: string; missing_scans: number }>;
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
            const current = this.db.prepare('SELECT active_version_id FROM market_watches WHERE id = ?').get(row.id) as { active_version_id?: string | null } | undefined;
            if (!current || current.active_version_id !== version.id) {
              this.db.prepare("UPDATE scans SET status = 'superseded', completed_at = ?, error = ? WHERE id = ?").run(nowIso(), 'Research criteria changed while this scan was running', scanId);
              discarded = true;
              return;
            }
            const newListingIds: number[] = [];
            for (const listing of filtered) {
              const stored = this.storeMarketListing(row.id, version.id, listing, observedAt, scanId);
              if (stored.created) newListingIds.push(stored.id);
            }
            if (newListingIds.length) {
              this.db.prepare(`UPDATE market_listings SET snapshot_status = 'pending'
                WHERE id IN (${newListingIds.map(() => '?').join(',')}) AND snapshot_status IS NULL`).run(...newListingIds);
            }
            for (const { listing, availability, refreshed } of verifiedMissing) {
              if (availability.status === 'live') {
                if (refreshed) {
                  this.db.prepare("UPDATE market_listings SET title = ?, url = ?, image_url = COALESCE(?, image_url), last_price_pln = ?, lowest_price_pln = MIN(lowest_price_pln, ?), missing_scans = 0, status = 'active', availability_status = 'live', ended_reason = NULL, last_verified_at = ?, ended_at = NULL WHERE id = ?").run(refreshed.title, refreshed.url, refreshed.imageUrl ?? null, refreshed.price, refreshed.price, observedAt, listing.id);
                  this.db.prepare('INSERT INTO market_price_observations (market_listing_id, version_id, scan_id, price_pln, observed_at) VALUES (?, ?, ?, ?, ?)').run(listing.id, version.id, scanId, refreshed.price, observedAt);
                } else {
                  this.db.prepare("UPDATE market_listings SET missing_scans = 0, status = 'active', availability_status = 'live', ended_reason = NULL, last_verified_at = ?, ended_at = NULL WHERE id = ?").run(observedAt, listing.id);
                }
              } else if (availability.status === 'terminal') {
                const next = marketStatusAfterMiss(Number(listing.missing_scans));
                this.db.prepare("UPDATE market_listings SET missing_scans = ?, status = ?, ended_at = CASE WHEN ? = 'ended' THEN COALESCE(ended_at, ?) ELSE ended_at END, availability_status = 'terminal', ended_reason = ?, last_verified_at = ? WHERE id = ?").run(next.missingScans, next.status, next.status, observedAt, availability.reason, observedAt, listing.id);
              } else {
                this.db.prepare("UPDATE market_listings SET availability_status = 'unknown', last_verified_at = ? WHERE id = ?").run(observedAt, listing.id);
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
          this.finishRun(runId, 'error', message);
        }
      }));
      const finished = nowIso();
      const scheduled = new Date(Date.now() + Math.max(6, Number(row.interval_hours)) * 3_600_000).toISOString();
      const next = latestBackoffUntil && Date.parse(latestBackoffUntil) > Date.parse(scheduled) ? latestBackoffUntil : scheduled;
      this.db.prepare('UPDATE market_watches SET next_scan_at = ?, last_scan_at = ?, updated_at = ? WHERE id = ? AND active_version_id = ?').run(next, finished, finished, row.id, version.id);
      this.emit('market-watch', { refresh: true, id: row.id });
    } finally { this.running.delete(runningKey); }
  }

  private storeMarketListing(watchId: string, versionId: string, listing: NormalizedListing, observedAt: string, scanId: number): { id: number; created: boolean } {
    const existing = this.db.prepare('SELECT id FROM market_listings WHERE market_watch_id = ? AND version_id = ? AND marketplace = ? AND listing_id = ?').get(watchId, versionId, listing.marketplace, listing.listingId) as { id: number } | undefined;
    this.db.prepare(`INSERT INTO market_listings (market_watch_id, version_id, marketplace, listing_id, title, url, image_url, first_price_pln, last_price_pln, lowest_price_pln, first_seen_at, last_seen_at, status, missing_scans, availability_status, ended_reason, last_verified_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 0, 'live', NULL, ?)
      ON CONFLICT(market_watch_id, version_id, marketplace, listing_id) DO UPDATE SET title = excluded.title, url = excluded.url, image_url = COALESCE(excluded.image_url, market_listings.image_url), last_price_pln = excluded.last_price_pln, lowest_price_pln = MIN(market_listings.lowest_price_pln, excluded.last_price_pln), last_seen_at = excluded.last_seen_at, status = 'active', missing_scans = 0, ended_at = NULL, availability_status = 'live', ended_reason = NULL, last_verified_at = excluded.last_verified_at`).run(watchId, versionId, listing.marketplace, listing.listingId, listing.title, listing.url, listing.imageUrl ?? null, listing.price, listing.price, listing.price, observedAt, observedAt, observedAt);
    const stored = this.db.prepare('SELECT id FROM market_listings WHERE market_watch_id = ? AND version_id = ? AND marketplace = ? AND listing_id = ?').get(watchId, versionId, listing.marketplace, listing.listingId) as { id: number };
    this.db.prepare('INSERT INTO market_price_observations (market_listing_id, version_id, scan_id, price_pln, observed_at) VALUES (?, ?, ?, ?, ?)').run(stored.id, versionId, scanId, listing.price, observedAt);
    return { id: Number(stored.id), created: !existing };
  }

  /**
   * Preserves research listings before their marketplace page disappears:
   * the description plus downloaded gallery images are stored locally so the
   * listing stays reviewable after it is sold or removed.
   */
  private async capturePendingMarketSnapshots(watchId: string, marketplace: Marketplace) {
    try {
      const due = this.db.prepare(`SELECT * FROM market_listings
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
        this.db.prepare(`INSERT INTO market_listing_snapshots (
            market_listing_id, marketplace, external_listing_id, title, price_pln, url,
            condition, location, description, state_hash, image_count, source, captured_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(market_listing_id, state_hash) DO NOTHING`).run(
          Number(listing.id), marketplace, String(listing.listing_id), String(listing.title), Number(listing.last_price_pln),
          String(listing.url), listing.condition ?? null, listing.location ?? null, description, stateHash,
          images.length, source, capturedAt,
        );
        const stored = this.db.prepare('SELECT id FROM market_listing_snapshots WHERE market_listing_id = ? AND state_hash = ?').get(Number(listing.id), stateHash) as { id: number };
        snapshotId = Number(stored.id);
        const existingImages = this.db.prepare('SELECT COUNT(*) AS count FROM market_listing_snapshot_images WHERE snapshot_id = ?').get(snapshotId) as { count?: number };
        if (!Number(existingImages.count ?? 0)) {
          const insertImage = this.db.prepare('INSERT INTO market_listing_snapshot_images (snapshot_id, position, source_url, mime_type, byte_size, data) VALUES (?, ?, ?, ?, ?, ?)');
          images.forEach((image, index) => insertImage.run(snapshotId, index, image.sourceUrl, image.mime, image.data.byteLength, image.data));
        }
      });
      this.db.prepare("UPDATE market_listings SET snapshot_status = 'saved', snapshot_at = ? WHERE id = ?").run(capturedAt, Number(listing.id));
      return { ok: true, message: `preserved listing copy (description ${description ? 'saved' : 'unavailable'}, ${images.length} image${images.length === 1 ? '' : 's'})`, snapshotId: snapshotId! };
    } catch (error) {
      const message = (error instanceof Error ? error.message : 'Listing preservation failed').slice(0, 240);
      this.markSnapshotFailure(Number(listing.id), source === 'manual' ? 0 : 1);
      return { ok: false, message: `could not preserve listing — ${message}` };
    }
  }

  private markSnapshotFailure(listingId: number, attemptsToAdd: number) {
    this.db.prepare("UPDATE market_listings SET snapshot_status = 'failed', snapshot_attempts = snapshot_attempts + ? WHERE id = ?").run(attemptsToAdd, listingId);
  }

  private async fetchSnapshotImage(url: string, referer: string): Promise<{ mime: string; data: Buffer } | null> {
    let parsed: URL;
    try { parsed = new URL(url); } catch { return null; }
    if (parsed.protocol !== 'https:') return null;
    const response = await fetch(parsed.toString(), {
      headers: { 'user-agent': MARKETPLACE_API_USER_AGENT, accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8', referer },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    const declared = Number(response.headers.get('content-length') ?? 0);
    if (declared > SNAPSHOT_MAX_IMAGE_BYTES) return null;
    const contentType = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (!contentType.startsWith('image/')) return null;
    const data = Buffer.from(await response.arrayBuffer());
    if (!data.byteLength || data.byteLength > SNAPSHOT_MAX_IMAGE_BYTES) return null;
    return { mime: contentType, data };
  }

  /** The most recent preserved copy of a research listing, with image metadata (bytes come from the image endpoint). */
  marketListingSnapshot(marketListingId: number): MarketListingSnapshot | null {
    const listing = this.db.prepare('SELECT id FROM market_listings WHERE id = ?').get(marketListingId) as { id?: number } | undefined;
    if (!listing?.id) throw new ServiceError('Research listing not found', 404);
    const snapshot = this.db.prepare(`SELECT * FROM market_listing_snapshots WHERE market_listing_id = ?
      ORDER BY captured_at DESC, id DESC LIMIT 1`).get(marketListingId) as Record<string, any> | undefined;
    if (!snapshot) return null;
    const images = this.db.prepare('SELECT id, position, byte_size FROM market_listing_snapshot_images WHERE snapshot_id = ? ORDER BY position, id').all(Number(snapshot.id)) as Array<Record<string, any>>;
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
    const row = this.db.prepare('SELECT mime_type, data FROM market_listing_snapshot_images WHERE id = ?').get(imageId) as { mime_type?: string; data?: Uint8Array } | undefined;
    if (!row?.data) return null;
    return { mime: row.mime_type ?? 'image/jpeg', data: Buffer.from(row.data) };
  }

  /** Manual on-demand preservation, also usable for listings that already ended. */
  async captureMarketListingSnapshotNow(marketListingId: number): Promise<MarketListingSnapshot | null> {
    const listing = this.db.prepare('SELECT * FROM market_listings WHERE id = ?').get(marketListingId) as Record<string, any> | undefined;
    if (!listing) throw new ServiceError('Research listing not found', 404);
    const outcome = await this.captureMarketListingSnapshot(listing, 'manual');
    if (!outcome.ok) throw new ServiceError(outcome.message, 502);
    return this.marketListingSnapshot(marketListingId);
  }

  getConnectors(): Connector[] {
    const webhookConfigured = Boolean(this.getSetting('discord_webhook'));
    const ntfyConfigured = Boolean(this.ntfyConfig());
    const healthRows = this.db.prepare(`SELECT * FROM (
      SELECT connector_runs.*,
        COUNT(*) OVER (PARTITION BY source) AS source_count,
        MAX(CASE WHEN status = 'ok' THEN finished_at END) OVER (PARTITION BY source) AS last_success,
        ROW_NUMBER() OVER (PARTITION BY source ORDER BY started_at DESC, id DESC) AS source_rank
      FROM connector_runs
    ) WHERE source_rank = 1`).all() as Array<Record<string, any>>;
    const healthBySource = new Map(healthRows.map((row) => [String(row.source), row]));
    return connectorDefinitions.map((definition) => {
      if (definition.name === 'Discord' && !webhookConfigured) return { ...definition, status: 'Idle', detail: 'Webhook not configured', lastSuccess: 'Never', requests: 0, latency: '—' };
      if (definition.name === 'ntfy' && !ntfyConfigured) return { ...definition, status: 'Idle', detail: 'ntfy not configured', lastSuccess: 'Never', requests: 0, latency: '—' };
      const last = healthBySource.get(definition.name);
      if (!last) return { ...definition, status: 'Idle', detail: definition.name === 'Discord' ? 'Webhook configured; no delivery yet' : definition.name === 'ntfy' ? 'ntfy configured; no delivery yet' : 'No connector run yet', lastSuccess: 'Never', requests: 0, latency: '—' };
      const status: Connector['status'] = last.status === 'ok' ? 'OK' : last.status === 'error' ? 'Degraded' : last.status === 'running' ? 'Warning' : 'Idle';
      return { ...definition, status, detail: last.message || (status === 'OK' ? 'Last run completed' : 'Waiting for a run'), lastSuccess: relativeTime(last.last_success), requests: Number(last.source_count), latency: duration(last.started_at, last.finished_at) };
    });
  }

  dashboard(): DashboardData {
    const watches = this.getWatches();
    const listings = this.getListings(watches);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayTime = today.getTime();
    let newToday = 0;
    let strongDeals = 0;
    for (const listing of listings) {
      if (Date.parse(listing.observedAt) >= todayTime) newToday += 1;
      if (listing.dealStrength >= 4) strongDeals += 1;
    }
    const lastScan = parseJson<{ at?: string }>(this.getSetting('last_scan'), {});
    return {
      watches,
      listings,
      connectors: this.getConnectors(),
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
    const rows = (table: string) => this.db.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>;
    const settings = rows('settings').map((row) => {
      const key = String(row.key);
      return { key, configured: Boolean(row.value), value: /(?:webhook|ntfy_config|api_key)/i.test(key) ? null : row.value };
    });
    return {
      exportedAt: nowIso(),
      note: 'Encrypted credentials, browser sessions, and raw secret values are intentionally omitted. Use the authenticated database backup command for a complete restore point.',
      watches: rows('watches'),
      listings: rows('listings'),
      observations: rows('observations'),
      listingRelevance: rows('listing_relevance'),
      scans: rows('scans'),
      notificationDeliveries: rows('notification_deliveries'),
      automaticNegotiations: rows('automatic_negotiations'),
      marketWatches: rows('market_watches'),
      marketWatchVersions: rows('market_watch_versions'),
      marketListings: rows('market_listings'),
      marketPriceObservations: rows('market_price_observations'),
      listingActions: rows('listing_actions'),
      sellerMessages: rows('seller_messages'),
      notifications: rows('notifications'),
      connectorRuns: rows('connector_runs'),
      settings,
    };
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
      },
      ai: {
        configured: Boolean(this.deepSeekConfig().apiKey),
        model: this.deepSeekModel(),
        source: this.deepSeekConfig().source,
      },
      autoNegotiation: this.autoNegotiationSettings(),
      publicExposureWarning: this.publicExposureWarning,
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
    ntfy?: { serverUrl?: string; topic?: string; token?: string; minimumPriority?: NotificationPriority };
    ai?: { apiKey?: string; clearApiKey?: boolean; model?: string };
    autoNegotiation?: {
      enabled?: boolean;
      maxTotalCost?: number | null;
      shippingCost?: number;
      otherCosts?: number;
      minimumDiscountPercent?: number;
      openingDiscountPercent?: number;
      dailyLimit?: number;
    };
  }) {
    if (input.interval !== undefined) {
      if (!Number.isInteger(input.interval) || input.interval < 5 || input.interval > 1440) throw new ServiceError('Polling interval must be between 5 and 1440 minutes');
      this.setSetting('default_interval', String(input.interval));
    }
    if (input.nightInterval !== undefined) {
      if (!Number.isInteger(input.nightInterval) || input.nightInterval < 5 || input.nightInterval > 1440) throw new ServiceError('Night polling interval must be between 5 and 1440 minutes');
      this.setSetting('night_interval', String(input.nightInterval));
    }
    if (input.clearWebhook) this.db.prepare("DELETE FROM settings WHERE key = 'discord_webhook'").run();
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
    if (input.clearNtfy) this.db.prepare("DELETE FROM settings WHERE key = 'ntfy_config'").run();
    if (input.ntfy !== undefined) {
      const current = this.ntfyConfig();
      try {
        const config = validateNtfyConfig({
          serverUrl: input.ntfy.serverUrl?.trim() || current?.serverUrl,
          topic: input.ntfy.topic?.trim() || current?.topic,
          token: input.ntfy.token?.trim() || current?.token,
          minimumPriority: input.ntfy.minimumPriority ?? current?.minimumPriority ?? 'exceptional',
        });
        this.setSetting('ntfy_config', encryptSecret(JSON.stringify(config)));
      } catch (error) {
        throw new ServiceError(error instanceof Error ? error.message : 'Invalid ntfy configuration');
      }
    }
    if (input.ai?.clearApiKey) this.db.prepare("DELETE FROM settings WHERE key IN ('openrouter_api_key', 'deepseek_api_key')").run();
    if (input.ai?.apiKey?.trim()) {
      this.db.prepare("DELETE FROM settings WHERE key = 'deepseek_api_key'").run();
      this.setSetting('openrouter_api_key', encryptSecret(input.ai.apiKey.trim()));
    }
    if (input.ai?.model !== undefined) {
      const model = input.ai.model.trim();
      if (!model || model.length > 200 || /\s/.test(model)) throw new ServiceError('OpenRouter model must be a non-empty model slug without spaces');
      this.setSetting('deepseek_model', model);
    }
    if (input.autoNegotiation !== undefined) {
      const current = this.autoNegotiationConfig();
      const next = {
        enabled: input.autoNegotiation.enabled ?? current.enabled,
        maxTotalCost: input.autoNegotiation.maxTotalCost === undefined ? current.maxTotalCost : input.autoNegotiation.maxTotalCost,
        shippingCost: input.autoNegotiation.shippingCost ?? current.shippingCost,
        otherCosts: input.autoNegotiation.otherCosts ?? current.otherCosts,
        minimumDiscountPercent: input.autoNegotiation.minimumDiscountPercent ?? current.minimumDiscountPercent,
        openingDiscountPercent: input.autoNegotiation.openingDiscountPercent ?? current.openingDiscountPercent,
        dailyLimit: input.autoNegotiation.dailyLimit ?? current.dailyLimit,
      };
      if (next.maxTotalCost !== null && (!Number.isFinite(next.maxTotalCost) || next.maxTotalCost <= 0)) throw new ServiceError('Automatic negotiation maximum total cost must be positive when provided.');
      if (![next.shippingCost, next.otherCosts].every((value) => Number.isFinite(value) && value >= 0)) throw new ServiceError('Automatic negotiation known costs must be zero or positive.');
      if (!Number.isInteger(next.dailyLimit) || next.dailyLimit < 1 || next.dailyLimit > 50) throw new ServiceError('Automatic negotiation daily limit must be between 1 and 50 attempts.');
      if (!Number.isFinite(next.minimumDiscountPercent) || next.minimumDiscountPercent < 18 || next.minimumDiscountPercent > 80) throw new ServiceError('Automatic negotiation minimum discount must be between 18% and 80%.');
      if (!Number.isFinite(next.openingDiscountPercent) || next.openingDiscountPercent < 1 || next.openingDiscountPercent > 50) throw new ServiceError('Automatic negotiation opening discount must be between 1% and 50%.');
      if (next.enabled && next.maxTotalCost === null) throw new ServiceError('Set a maximum total cost before enabling automatic negotiation.');
      this.setSetting('auto_negotiation_config', JSON.stringify(next));
    }
    return this.settings();
  }

  notifications(): NotificationRecord[] {
    return this.notificationsPage().notifications;
  }

  notificationsPage(options: { page?: number; pageSize?: number } = {}) {
    const page = Math.max(1, Math.floor(options.page ?? 1));
    const pageSize = Math.max(1, Math.min(200, Math.floor(options.pageSize ?? 100)));
    const total = Number((this.db.prepare('SELECT COUNT(*) AS count FROM notifications').get() as { count?: number }).count ?? 0);
    const rows = this.db.prepare('SELECT * FROM notifications ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?').all(pageSize, (page - 1) * pageSize) as Array<Record<string, any>>;
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
    const total = Number((this.db.prepare('SELECT COUNT(*) AS count FROM connector_runs').get() as { count?: number }).count ?? 0);
    const rows = this.db.prepare('SELECT * FROM connector_runs ORDER BY started_at DESC, id DESC LIMIT ? OFFSET ?').all(pageSize, (page - 1) * pageSize) as Array<Record<string, any>>;
    return { runs: rows.map((row) => ({ id: Number(row.id), source: row.source, status: row.status, message: row.message, startedAt: row.started_at, finishedAt: row.finished_at, duration: duration(row.started_at, row.finished_at) })), pagination: { page, pageSize, total, hasNext: page * pageSize < total } };
  }

  deleteWatch(id: string) {
    const result = this.db.prepare('DELETE FROM watches WHERE id = ?').run(id);
    if (!result.changes) throw new ServiceError('Watch not found', 404);
  }

  archiveWatch(id: string, archived: boolean) {
    const now = nowIso();
    const result = archived
      ? this.db.prepare('UPDATE watches SET archived_at = ?, enabled = 0, updated_at = ? WHERE id = ?').run(now, now, id)
      : this.db.prepare('UPDATE watches SET archived_at = NULL, enabled = 1, updated_at = ? WHERE id = ?').run(now, id);
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
      if (!response.ok) throw new Error(`Discord returned ${response.status}`);
      this.db.prepare('INSERT INTO notifications (listing_key, payload_json, status, sent_at, created_at) VALUES (?, ?, ?, ?, ?)').run(key, JSON.stringify({ ...payload, test: true }), 'delivered', sentAt, sentAt);
      this.recordRun('Discord', 'ok', 'Test webhook delivered', sentAt, nowIso());
      this.emit('notification', { refresh: true });
      return { delivered: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Discord delivery failed';
      this.db.prepare('INSERT INTO notifications (listing_key, payload_json, status, created_at) VALUES (?, ?, ?, ?)').run(key, JSON.stringify({ ...payload, test: true }), 'failed', sentAt);
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
      message: 'Your important deal alerts will be delivered here.',
      priority: 3,
      tags: ['white_check_mark'],
      click: config.serverUrl,
    };
    const key = `test-ntfy-${Date.now()}`;
    try {
      await publishNtfy(config, payload);
      this.db.prepare('INSERT INTO notifications (listing_key, payload_json, status, sent_at, created_at) VALUES (?, ?, ?, ?, ?)').run(key, JSON.stringify({ ...payload, test: true, channel: 'ntfy' }), 'delivered', sentAt, sentAt);
      this.recordRun('ntfy', 'ok', 'Test ntfy notification delivered', sentAt, nowIso());
      this.emit('notification', { refresh: true });
      return { delivered: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'ntfy delivery failed';
      this.db.prepare('INSERT INTO notifications (listing_key, payload_json, status, created_at) VALUES (?, ?, ?, ?)').run(key, JSON.stringify({ ...payload, test: true, channel: 'ntfy' }), 'failed', sentAt);
      this.recordRun('ntfy', 'error', message, sentAt, nowIso());
      throw new ServiceError(message, 502);
    }
  }

  queueScan(watchId?: string) {
    const rows = watchId
      ? this.db.prepare('SELECT * FROM watches WHERE id = ? AND enabled = 1').all(watchId) as WatchRow[]
      : this.db.prepare('SELECT * FROM watches WHERE enabled = 1').all() as WatchRow[];
    if (!rows.length) throw new ServiceError(watchId ? 'Enabled watch not found' : 'There are no enabled watches to scan', 404);
    for (const row of rows) void this.runWatch(row);
    return { queued: true, message: `Queued ${rows.length} ${rows.length === 1 ? 'watch' : 'watches'}` };
  }

  queueDue() {
    this.pruneRetention();
    void this.processNotificationRetries();
    void this.processDailyDigest();
    const rows = this.db.prepare('SELECT * FROM watches WHERE enabled = 1 AND next_scan_at <= ?').all(nowIso()) as WatchRow[];
    for (const row of rows) void this.runWatch(row);
    const marketRows = this.db.prepare('SELECT * FROM market_watches WHERE enabled = 1 AND next_scan_at <= ?').all(nowIso()) as WatchRow[];
    for (const row of marketRows) void this.runMarketWatch(row);
  }

  private async runWatch(row: WatchRow) {
    if (this.running.has(row.id)) return;
    this.running.add(row.id);
    const sources = parseJson<Marketplace[]>(row.sources_json, []);
    const exactUrls = parseJson<string[]>(row.exact_urls_json, []);
    let latestBackoffUntil: string | null = null;
    try {
      await Promise.all(sources.map(async (source) => {
        const paths: string[] = [];
        const onPath: ConnectorPathReporter = (path) => { if (!paths.includes(path)) paths.push(path); };
        const latest = this.db.prepare('SELECT backoff_until FROM connector_runs WHERE source = ? ORDER BY started_at DESC LIMIT 1').get(source) as { backoff_until?: string } | undefined;
        const started = nowIso();
        const backoffUntil = latest?.backoff_until && Date.parse(latest.backoff_until) > Date.now() ? latest.backoff_until : null;
        if (backoffUntil && (!latestBackoffUntil || Date.parse(backoffUntil) > Date.parse(latestBackoffUntil))) latestBackoffUntil = backoffUntil;
        const runId = this.recordRun(source, backoffUntil ? 'skipped' : 'running', backoffUntil ? `Skipped ${row.name}; connector backoff is active` : `Scanning ${row.name}`, started, backoffUntil ? started : null);
        const scanId = this.createScan(String(row.id), 'watch', source, started);
        if (backoffUntil) {
          this.db.prepare("UPDATE scans SET status = 'skipped', completed_at = ?, error = ? WHERE id = ?").run(started, `Connector backoff active until ${backoffUntil}`, scanId);
          this.log('info', 'watch', `${row.name} · ${source}: skipped (connector backoff until ${backoffUntil})`);
          return;
        }
        try {
          const matchingExact = exactUrls.filter((url) => validateSearchUrl(url, source).valid);
          const searchFilters = { minPrice: row.min_price_pln, maxPrice: row.max_price_pln, condition: row.condition, shippingOnly: Boolean(row.shipping_only), location: row.location, sort: 'newest' as const };
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
            : pickVariantBatch(typoVariants(String(row.query)), this.scanOrdinal(String(row.id), 'watch'), TYPO_VARIANTS_PER_SCAN);
          const variantFetches: string[] = [];
          for (const variantQuery of variantQueries) {
            variantFetches.push(`"${variantQuery}"`);
            mainListings.push(...await this.fetchSearchPages(source, variantQuery, searchFilters, onPath));
          }
          const fetched = [...new Map(mainListings.map((listing) => [`${listing.marketplace}:${listing.listingId}`, listing])).values()];
          this.log('info', 'watch', `${row.name} · ${source}: ${matchingExact.length ? `exact-urls (${matchingExact.length})` : 'query-search'}${variantFetches.length ? ` + typo-variants (${variantFetches.join(', ')})` : ''} → ${paths.join(' → ') || 'no fetch'} · fetched=${fetched.length}`);
          const deterministicFilters = { minPrice: row.min_price_pln, maxPrice: row.max_price_pln, condition: row.condition, location: row.location, shippingOnly: false };
          const comparable = filterListings(fetched, row.query, row.included_terms, row.excluded_terms, deterministicFilters);
          if (row.shipping_only) await this.enrichShipping(comparable, source);
          const filtered = filterListings(comparable, row.query, row.included_terms, row.excluded_terms, { ...deterministicFilters, shippingOnly: Boolean(row.shipping_only) });
          const relevance = await this.filterListingsByAiRelevance(filtered, {
            query: row.query,
            includedTerms: row.included_terms ?? '',
            excludedTerms: row.excluded_terms ?? '',
          }, row.id, row.ai_relevance === undefined ? true : Boolean(row.ai_relevance));
          const candidates = this.transaction(() => {
            // The baseline and first-observation queries are watch-wide: running
            // them once per scan instead of per stored listing keeps the
            // synchronous SQLite work flat as observation history grows.
            const baseline = this.watchBaseline(row);
            const pendingCandidates: DealNotificationCandidate[] = [];
            for (const listing of relevance.listings) {
              const candidate = this.storeListing(row, listing, scanId, baseline);
              if (candidate) pendingCandidates.push(candidate);
            }
            const pending = row.shipping_only ? comparable.filter((listing) => listing.shippingAvailable === null).length : 0;
            const relevanceNote = relevance.notConfigured && (row.ai_relevance === undefined || Boolean(row.ai_relevance))
              ? ' · AI relevance inactive'
              : relevance.unknown ? ` · ${relevance.unknown} AI checks unknown`
                : relevance.excluded ? ` · ${relevance.excluded} excluded by AI` : '';
            this.completeScan(scanId, row.shipping_only ? `${relevance.listings.length} shipping matches${pending ? ` · ${pending} pending checks` : ''}${relevanceNote}` : `${relevance.listings.length} listings normalized${relevanceNote}`);
            return pendingCandidates;
          });
          for (const candidate of candidates) {
            if (candidate.requiresDescriptionVerification && !await this.verifyHighPriorityDeal(candidate)) continue;
            await this.notifyDeal(candidate.watchId, candidate.listing, candidate.typical, candidate.discountPercent, candidate.confidence);
            await this.automaticallyNegotiate(candidate);
          }
          const pending = row.shipping_only ? comparable.filter((listing) => listing.shippingAvailable === null).length : 0;
          const relevanceNote = relevance.notConfigured && (row.ai_relevance === undefined || Boolean(row.ai_relevance))
            ? ' · AI relevance inactive'
            : relevance.unknown ? ` · ${relevance.unknown} AI checks unknown`
              : relevance.excluded ? ` · ${relevance.excluded} excluded by AI` : '';
          this.finishRun(runId, 'ok', row.shipping_only ? `${relevance.listings.length} shipping matches${pending ? ` · ${pending} pending checks` : ''}${relevanceNote}` : `${relevance.listings.length} listings normalized${relevanceNote}`);
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Connector failed';
          this.failScan(scanId, error);
          const recent = this.db.prepare('SELECT status FROM connector_runs WHERE source = ? AND id != ? ORDER BY started_at DESC LIMIT 8').all(source, runId) as Array<{ status: string }>;
          const consecutiveFailures = recent.findIndex((run) => run.status !== 'error');
          const failureCount = consecutiveFailures === -1 ? recent.length : consecutiveFailures;
          this.log('error', 'watch', `${row.name} · ${source}: failed via ${paths.join(' → ') || 'unstarted path'} — ${message}`);
          this.finishRun(runId, 'error', message, new Date(Date.now() + exponentialBackoff(failureCount)).toISOString());
        }
      }));
      const finished = nowIso();
      const scheduled = nextWatchScanAt(finished, Number(row.interval_minutes), Number(this.getSetting('night_interval') ?? DEFAULT_NIGHT_INTERVAL_MINUTES));
      const next = latestBackoffUntil && Date.parse(latestBackoffUntil) > Date.parse(scheduled) ? latestBackoffUntil : scheduled;
      this.db.prepare('UPDATE watches SET next_scan_at = ?, updated_at = ? WHERE id = ?').run(next, finished, row.id);
      this.setSetting('last_scan', JSON.stringify({ at: finished }));
      this.emit('scan', { refresh: true, watchId: row.id });
    } finally {
      this.running.delete(row.id);
    }
  }

  /**
   * Every marketplace runs on a dedicated anonymous path: OLX on its verified
   * offers API, Vinted on its cookie-bootstrapped catalog API (falling back to
   * the public-page adapter, which owns the Chromium render), and Allegro
   * Lokalnie on plain-HTTP SSR pages enriched through its anonymous batch API.
   * Chromium is only reachable through those explicit fallbacks.
   */
  private createConnectorAdapter(source: Marketplace, onPath?: ConnectorPathReporter): ConnectorAdapter {
    if (source === 'OLX') return createOlxJsonAdapter(source, (url) => this.fetchOlxApi(url), onPath);
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

  /** Watches pass their original query and filters straight into the OLX API instead of round-tripping an HTML URL slug. */
  private marketplaceSearchRequestUrl(source: Marketplace, query: string, filters: Parameters<typeof buildMarketplaceSearchUrl>[2]) {
    return source === 'OLX' ? buildOlxSearchApiUrl(query, filters) : buildMarketplaceSearchUrl(source, query, filters);
  }

  private async fetchOlxApi(url: string): Promise<OlxApiFetchResult> {
    const validation = validateSearchUrl(url, 'OLX');
    if (!validation.valid) throw new Error(validation.reason);
    const headers = { 'user-agent': MARKETPLACE_API_USER_AGENT, accept: 'application/json' };
    let response = await fetch(validation.url, { redirect: 'manual', headers, signal: AbortSignal.timeout(12_000) });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw new Error(`Unexpected redirect (${response.status})`);
      const redirected = new URL(location, validation.url).toString();
      const redirectValidation = validateSearchUrl(redirected, 'OLX');
      if (!redirectValidation.valid) throw new Error('Marketplace redirected off the approved domain');
      response = await fetch(redirectValidation.url, { redirect: 'manual', headers, signal: AbortSignal.timeout(12_000) });
    }
    let json: unknown = null;
    try { json = await response.json(); } catch { /* non-JSON bodies (e.g. challenge pages) surface through the status */ }
    return { status: response.status, json };
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
  private async fetchVintedApi(url: string): Promise<VintedApiFetchResult> {
    const validation = validateSearchUrl(url, 'Vinted');
    if (!validation.valid) throw new Error(validation.reason);
    let response = await this.fetchVintedWithCookies(validation.url);
    if (response.status === 401) {
      this.vintedCookieJar = null;
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
      const redirected = new URL(location, url).toString();
      const redirectValidation = validateSearchUrl(redirected, 'Vinted');
      if (!redirectValidation.valid) throw new Error('Marketplace redirected off the approved domain');
      url = redirectValidation.url;
      response = await fetch(url, { redirect: 'manual', headers, signal: AbortSignal.timeout(12_000) });
    }
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
  private async fetchVintedItemPage(url: string): Promise<VintedPageFetchResult> {
    const validation = validateSearchUrl(url, 'Vinted');
    if (!validation.valid) throw new Error(validation.reason);
    const headers = { 'user-agent': MARKETPLACE_API_USER_AGENT, accept: 'text/html,application/xhtml+xml', 'accept-language': 'pl-PL,pl;q=0.9' };
    let finalUrl = validation.url;
    let response = await fetch(finalUrl, { redirect: 'manual', headers, signal: AbortSignal.timeout(12_000) });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw new Error(`Unexpected redirect (${response.status})`);
      const redirected = new URL(location, finalUrl).toString();
      const redirectValidation = validateSearchUrl(redirected, 'Vinted');
      if (!redirectValidation.valid) throw new Error('Marketplace redirected off the approved domain');
      finalUrl = redirectValidation.url;
      response = await fetch(finalUrl, { redirect: 'manual', headers, signal: AbortSignal.timeout(12_000) });
    }
    if (response.status === 403 || response.status === 429) {
      return { status: 200, body: await this.renderPublicPage(finalUrl, 'Vinted') };
    }
    return { status: response.status, body: response.ok ? await response.text() : '' };
  }

  /** Anonymous Lokalnie JSON surface (batch condition enrichment); no cookies, no CSRF. */
  private async fetchAllegroLokalnieApi(url: string, body: string | null): Promise<AllegroApiFetchResult> {
    const validation = validateSearchUrl(url, 'Allegro Lokalnie');
    if (!validation.valid) throw new Error(validation.reason);
    const headers: Record<string, string> = { 'user-agent': MARKETPLACE_API_USER_AGENT, accept: 'application/json' };
    if (body) headers['content-type'] = 'application/json';
    const response = await fetch(validation.url, { method: body ? 'POST' : 'GET', redirect: 'manual', headers, body: body ?? undefined, signal: AbortSignal.timeout(12_000) });
    let json: unknown = null;
    try { json = await response.json(); } catch { /* non-JSON bodies (e.g. challenge pages) surface through the status */ }
    return { status: response.status, json };
  }

  private async fetchPublicPage(url: string, marketplace: Marketplace) {
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
    let response = await fetch(validation.url, { redirect: 'manual', headers: { 'user-agent': 'Scout/1.0 (+self-hosted public page monitor)', accept: 'text/html,application/xhtml+xml' }, signal: AbortSignal.timeout(12_000) });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw new Error(`Unexpected redirect (${response.status})`);
      const redirected = new URL(location, validation.url).toString();
      const redirectValidation = validateSearchUrl(redirected, marketplace);
      if (!redirectValidation.valid) throw new Error('Marketplace redirected off the approved domain');
      response = await fetch(redirectValidation.url, { redirect: 'manual', headers: { 'user-agent': 'Scout/1.0 (+self-hosted public page monitor)', accept: 'text/html,application/xhtml+xml' }, signal: AbortSignal.timeout(12_000) });
    }
    if (!response.ok) {
      if (response.status === 403 || response.status === 429) return this.renderPublicPage(validation.url, marketplace);
      throw new Error(`Public page returned ${response.status}`);
    }
    return response.text();
  }

  private async sendMarketplaceMessage(marketplace: 'OLX' | 'Allegro Lokalnie', listingUrl: string, message: string) {
    if (marketplace === 'OLX' && this.sendOlxMessageOverride) return this.sendOlxMessageOverride(listingUrl, message);
    if (marketplace === 'Allegro Lokalnie' && this.sendAllegroMessageOverride) return this.sendAllegroMessageOverride(listingUrl, message);
    const storageState = this.readMarketplaceSession(marketplace);
    if (!storageState) throw new ServiceError(`Connect your ${marketplace} account in Settings before sending seller messages.`, 409);

    let browser: Browser | undefined;
    let context: BrowserContext | undefined;
    let ownsBrowser = false;
    try {
      if (process.env.SCOUT_BROWSER_WS) {
        browser = await chromium.connectOverCDP(process.env.SCOUT_BROWSER_WS, { timeout: 8_000 });
      } else {
        const executablePath = process.env.SCOUT_CHROMIUM_PATH ?? ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].find(existsSync);
        if (!executablePath) {
          const ErrorType = marketplace === 'OLX' ? OlxMessagingError : AllegroMessagingError;
          throw new ErrorType('Chromium is not available; configure SCOUT_BROWSER_WS.', 'delivery');
        }
        browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--disable-gpu'] });
        ownsBrowser = true;
      }
      context = await browser.newContext({ locale: 'pl-PL', storageState: storageState as any });
      const page = await context.newPage();
      if (marketplace === 'OLX') await sendOlxMessageOnPage(page, listingUrl, message);
      else await sendAllegroMessageOnPage(page, listingUrl, message);
      this.touchMarketplaceSession(marketplace);
    } catch (error) {
      if ((error instanceof OlxMessagingError || error instanceof AllegroMessagingError) && error.code === 'session') {
        this.setMarketplaceSessionError(marketplace, error.message);
      }
      throw error;
    } finally {
      try {
        if (context) await context.close();
      } finally {
        if (ownsBrowser && browser) await browser.close();
      }
    }
  }

  private async renderPublicPage(url: string, marketplace: Marketplace, storageState?: MarketplaceStorageState) {
    let browser: Browser | undefined;
    let context: BrowserContext | undefined;
    let ownsContext = false;
    try {
      if (process.env.SCOUT_BROWSER_WS) {
        browser = await chromium.connectOverCDP(process.env.SCOUT_BROWSER_WS, { timeout: 8_000 });
      } else {
        const executablePath = process.env.SCOUT_CHROMIUM_PATH ?? ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].find(existsSync);
        if (!executablePath) throw new Error('Chromium is not available; configure SCOUT_BROWSER_WS');
        browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--disable-gpu'] });
      }
      const existingContext = browser.contexts()[0];
      if (storageState) {
        context = await browser.newContext({ locale: 'pl-PL', storageState: storageState as any });
        ownsContext = true;
      } else if (existingContext) {
        context = existingContext;
      } else {
        context = await browser.newContext({ locale: 'pl-PL' });
        ownsContext = true;
      }
      if (!context) throw new Error('Chromium context could not be created');
      const page = await context.newPage();
      try {
        const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25_000 });
        await page.waitForTimeout(800);
        const finalValidation = validateSearchUrl(page.url(), marketplace);
        if (!finalValidation.valid) throw new Error('Marketplace redirected off the approved domain');
        if (response && !response.ok()) throw new Error(`Chromium page returned ${response.status()}`);
        return await page.content();
      } finally { await page.close(); }
    } finally {
      try {
        if (ownsContext && context) await context.close();
      } finally {
        if (browser) await browser.close();
      }
    }
  }

  private pruneRetention() {
    const lastPrune = this.getSetting('last_prune');
    if (lastPrune && Date.now() - Date.parse(lastPrune) < 24 * 60 * 60_000) return;
    const cutoff = new Date(Date.now() - 180 * 24 * 60 * 60_000).toISOString();
    this.db.prepare('DELETE FROM observations WHERE observed_at < ?').run(cutoff);
    this.db.prepare('DELETE FROM listing_detail_snapshots WHERE captured_at < ?').run(cutoff);
    this.db.prepare('DELETE FROM market_price_observations WHERE observed_at < ?').run(cutoff);
    this.db.prepare('DELETE FROM listing_relevance WHERE checked_at < ?').run(cutoff);
    this.db.prepare('DELETE FROM connector_runs WHERE started_at < ?').run(cutoff);
    this.db.prepare('DELETE FROM scans WHERE started_at < ?').run(cutoff);
    this.db.prepare('DELETE FROM seller_messages WHERE created_at < ?').run(cutoff);
    this.db.prepare('DELETE FROM automatic_negotiations WHERE created_at < ?').run(cutoff);
    this.db.prepare('DELETE FROM notification_deliveries WHERE created_at < ?').run(cutoff);
    this.db.prepare('DELETE FROM notifications WHERE created_at < ?').run(cutoff);
    this.db.prepare('DELETE FROM daily_digest_candidates WHERE (digest_date IS NOT NULL AND digest_date < ?) OR (digest_date IS NULL AND observed_at < ?)').run(cutoff.slice(0, 10), cutoff);
    this.db.prepare("DELETE FROM market_listings WHERE status IN ('ended', 'superseded') AND last_seen_at < ?").run(cutoff);
    this.db.prepare("DELETE FROM market_watch_versions WHERE closed_at IS NOT NULL AND closed_at < ? AND id NOT IN (SELECT active_version_id FROM market_watches WHERE active_version_id IS NOT NULL)").run(cutoff);
    this.db.prepare('DELETE FROM listings WHERE last_seen_at < ? AND NOT EXISTS (SELECT 1 FROM observations WHERE observations.listing_id = listings.id)').run(cutoff);
    this.setSetting('last_prune', nowIso());
  }

  private async enrichShipping(listings: NormalizedListing[], marketplace: Marketplace, options: { limit?: number } = {}) {
    const lookup = this.db.prepare('SELECT shipping_available FROM listings WHERE marketplace = ? AND listing_id = ?');
    for (const listing of listings) {
      if (listing.shippingAvailable !== null) continue;
      const cached = lookup.get(listing.marketplace, listing.listingId) as { shipping_available: number | null } | undefined;
      if (cached?.shipping_available !== null && cached?.shipping_available !== undefined) listing.shippingAvailable = Boolean(cached.shipping_available);
    }
    if (marketplace === 'OLX') return;
    const unknown = listings.filter((listing) => listing.shippingAvailable === null).slice(0, Math.max(0, options.limit ?? 8));
    for (let offset = 0; offset < unknown.length; offset += 2) {
      await Promise.all(unknown.slice(offset, offset + 2).map(async (listing) => {
        try {
          const html = await this.fetchPublicPage(listing.url, marketplace);
          const available = parseShippingAvailability(html, marketplace);
          if (available === null) return;
          listing.shippingAvailable = available;
          this.cacheShipping(listing);
        } catch { /* unknown remains excluded and will be retried on a later scan */ }
      }));
    }
  }

  private cacheShipping(listing: NormalizedListing) {
    if (listing.shippingAvailable === null) return;
    const checked = nowIso();
    this.db.prepare(`INSERT INTO listings (marketplace, listing_id, title, price_pln, url, image_url, condition, location, shipping_available, price_negotiable, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(marketplace, listing_id) DO UPDATE SET shipping_available = excluded.shipping_available, price_negotiable = COALESCE(excluded.price_negotiable, listings.price_negotiable), last_seen_at = excluded.last_seen_at`).run(listing.marketplace, listing.listingId, listing.title, listing.price, listing.url, listing.imageUrl ?? null, listing.condition ?? null, listing.location ?? null, listing.shippingAvailable ? 1 : 0, listing.priceNegotiable === null || listing.priceNegotiable === undefined ? null : listing.priceNegotiable ? 1 : 0, checked, checked);
  }

  private storeManualListing(listing: NormalizedListing) {
    const observedAt = nowIso();
    this.db.prepare(`INSERT INTO listings (marketplace, listing_id, title, price_pln, url, image_url, condition, location, shipping_available, price_negotiable, availability_status, last_verified_at, first_seen_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'live', ?, ?, ?)
      ON CONFLICT(marketplace, listing_id) DO UPDATE SET title = excluded.title, price_pln = excluded.price_pln, url = excluded.url, image_url = COALESCE(excluded.image_url, listings.image_url), condition = COALESCE(excluded.condition, listings.condition), location = COALESCE(excluded.location, listings.location), shipping_available = COALESCE(excluded.shipping_available, listings.shipping_available), price_negotiable = COALESCE(excluded.price_negotiable, listings.price_negotiable), availability_status = 'live', last_verified_at = excluded.last_verified_at, last_seen_at = excluded.last_seen_at`).run(
      listing.marketplace, listing.listingId, listing.title, listing.price, listing.url, listing.imageUrl ?? null, listing.condition ?? null, listing.location ?? null,
      listing.shippingAvailable === null || listing.shippingAvailable === undefined ? null : listing.shippingAvailable ? 1 : 0,
      listing.priceNegotiable === null || listing.priceNegotiable === undefined ? null : listing.priceNegotiable ? 1 : 0,
      observedAt, observedAt, observedAt,
    );
  }

  /**
   * Watch-wide inputs every listing in a scan scores against: the latest
   * observed price per listing (the baseline distribution) and the watch's
   * first qualifying observation. Both depend only on watch-level filters, so
   * they are computed once per scan. The baseline uses a window function over
   * the (watch_id, listing_id, observed_at, id) index — one linear pass —
   * instead of a newest-first anti-join that degrades on recurring listings.
   */
  private watchBaseline(row: WatchRow): { prices: number[]; firstObservedAt: string | null } {
    const baselineFilters = `
      JOIN listings l ON l.id = o.listing_id
      WHERE o.watch_id = ?
        AND (? = 0 OR NOT EXISTS (SELECT 1 FROM listing_relevance r WHERE r.watch_id = o.watch_id AND r.marketplace = l.marketplace AND r.listing_id = l.listing_id AND (r.relevance_status = 'irrelevant' OR (r.relevance_status IS NULL AND r.relevant = 0))))
        AND (? = 0 OR l.shipping_available = 1)
        AND (? IS NULL OR o.price_pln >= ?)
        AND (? IS NULL OR o.price_pln <= ?)`;
    const baselineParams = [
      row.id,
      row.ai_relevance === false || row.ai_relevance === 0 ? 0 : 1,
      row.shipping_only ? 1 : 0,
      row.min_price_pln, row.min_price_pln, row.max_price_pln, row.max_price_pln,
    ] as unknown[];
    const prices = (this.db.prepare(`SELECT price_pln FROM (
        SELECT o.price_pln, o.observed_at, o.id, ROW_NUMBER() OVER (PARTITION BY o.listing_id ORDER BY o.observed_at DESC, o.id DESC) AS rank
        FROM observations o ${baselineFilters}
      ) WHERE rank <= 1 ORDER BY observed_at DESC, id DESC LIMIT 400`).all(...baselineParams) as Array<{ price_pln: number }>)
      .map((item) => Number(item.price_pln))
      .filter((price) => Number.isFinite(price) && price > 0);
    const first = this.db.prepare(`SELECT MIN(o.observed_at) AS first FROM observations o ${baselineFilters}`).get(...baselineParams) as { first: string | null };
    return { prices, firstObservedAt: first?.first ?? null };
  }

  private storeListing(row: WatchRow, listing: NormalizedListing, scanId: number, baseline: { prices: number[]; firstObservedAt: string | null }): DealNotificationCandidate | null {
    const existingPrices = baseline.prices;
    const observedAt = nowIso();
    this.db.prepare(`INSERT INTO listings (marketplace, listing_id, title, price_pln, url, image_url, condition, location, shipping_available, price_negotiable, availability_status, last_verified_at, first_seen_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'live', ?, ?, ?)
      ON CONFLICT(marketplace, listing_id) DO UPDATE SET title = excluded.title, price_pln = excluded.price_pln, url = excluded.url, image_url = COALESCE(excluded.image_url, listings.image_url), condition = COALESCE(excluded.condition, listings.condition), location = COALESCE(excluded.location, listings.location), shipping_available = COALESCE(excluded.shipping_available, listings.shipping_available), price_negotiable = COALESCE(excluded.price_negotiable, listings.price_negotiable), availability_status = 'live', ended_reason = NULL, last_verified_at = excluded.last_verified_at, last_seen_at = excluded.last_seen_at`).run(listing.marketplace, listing.listingId, listing.title, listing.price, listing.url, listing.imageUrl ?? null, listing.condition ?? null, listing.location ?? null, listing.shippingAvailable === null ? null : listing.shippingAvailable ? 1 : 0, listing.priceNegotiable === null || listing.priceNegotiable === undefined ? null : listing.priceNegotiable ? 1 : 0, observedAt, observedAt, observedAt);
    const inputHash = listingNormalizationInputHash(listing);
    this.db.prepare('UPDATE listings SET ai_normalization_json = NULL, ai_normalization_input_hash = NULL, ai_normalization_model = NULL, ai_normalization_at = NULL, ai_normalization_error = NULL WHERE marketplace = ? AND listing_id = ? AND ai_normalization_input_hash IS NOT NULL AND ai_normalization_input_hash <> ?').run(listing.marketplace, listing.listingId, inputHash);
    const stored = this.db.prepare('SELECT id FROM listings WHERE marketplace = ? AND listing_id = ?').get(listing.marketplace, listing.listingId) as { id: number };
    this.db.prepare(`INSERT INTO watch_listings (watch_id, listing_id, first_seen_at, last_seen_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(watch_id, listing_id) DO UPDATE SET last_seen_at = excluded.last_seen_at`).run(row.id, stored.id, observedAt, observedAt);
    const association = this.db.prepare('SELECT id FROM watch_listings WHERE watch_id = ? AND listing_id = ?').get(row.id, stored.id) as { id: number };
    const observedHours = baseline.firstObservedAt ? Math.max(0, (Date.now() - Date.parse(baseline.firstObservedAt)) / 3_600_000) : 0;
    const score = scoreDeal(existingPrices, listing.price, { observedHours, sensitivity: Number(row.sensitivity ?? 1) });
    const observation = this.db.prepare('INSERT INTO observations (listing_id, watch_id, watch_listing_id, scan_id, price_pln, observed_at) VALUES (?, ?, ?, ?, ?, ?)').run(stored.id, row.id, association.id, scanId, listing.price, observedAt);
    const observationId = Number(observation.lastInsertRowid);
    if (score.isReady && score.typical !== null) {
      const discountPercent = score.discountPercent ?? 0;
      const dealStrength = discountPercent >= 30 ? 5 : discountPercent >= 20 ? 4 : discountPercent >= 12 ? 3 : discountPercent > 0 ? 2 : 1;
      const dealLabel: DealLabel = dealStrength >= 5 ? 'Exceptional' : dealStrength === 4 ? 'Very strong' : dealStrength === 3 ? 'Strong' : 'Watch';
      this.db.prepare('UPDATE watch_listings SET typical_pln = ?, deal_strength = ?, deal_label = ?, last_seen_at = ? WHERE id = ?').run(score.typical, dealStrength, dealLabel, observedAt, association.id);
      this.db.prepare('UPDATE observations SET baseline_pln = ?, discount_percent = ?, deal_strength = ?, deal_label = ? WHERE id = ?').run(score.typical, discountPercent, dealStrength, dealLabel, observationId);
      if (score.qualifies) return {
        watchId: String(row.id),
        listing,
        typical: score.typical,
        discountPercent,
        confidence: score.confidence,
        requiresDescriptionVerification: dealStrength >= 4,
      };
    } else {
      this.db.prepare('UPDATE observations SET baseline_pln = NULL, discount_percent = NULL WHERE id = ?').run(observationId);
    }
    return null;
  }

  private queueDailyDigestCandidate(watchId: string, listing: NormalizedListing, typical: number, discountPercent: number, confidence: number, priority: NotificationPriority) {
    const latest = this.db.prepare(`SELECT sequence, price_pln AS last_alerted_price_pln, priority AS last_priority
      FROM daily_digest_candidates WHERE watch_id = ? AND marketplace = ? AND listing_id = ?
      ORDER BY sequence DESC LIMIT 1`).get(watchId, listing.marketplace, listing.listingId) as { sequence?: number; last_alerted_price_pln?: number; last_priority?: NotificationPriority } | undefined;
    if (!this.shouldAlert(latest, listing.price, priority)) return false;
    const sequence = Number(latest?.sequence ?? 0) + 1;
    this.db.prepare(`INSERT INTO daily_digest_candidates (
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
          value: `[${row.title.slice(0, 180)}](${row.url})\n${Number(row.price_pln).toLocaleString('pl-PL')} zł · typical ${Number(row.typical_pln).toLocaleString('pl-PL')} zł · ${row.confidence}% confidence`.slice(0, 1024),
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
      click: shown[0]?.url ?? config.serverUrl,
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
        if (!response.ok) throw new Error(`Discord returned ${response.status}`);
      } else {
        const config = this.ntfyConfig();
        if (!config) throw new Error('ntfy is not configured');
        await publishNtfy(config, deliveryPayload as ReturnType<typeof this.digestNtfyPayload>);
      }
      const finished = nowIso();
      this.transaction(() => {
        this.db.prepare("UPDATE notification_deliveries SET status = 'delivered', sent_at = ?, next_attempt_at = NULL, updated_at = ? WHERE listing_key = ? AND channel = ?").run(finished, finished, input.deliveryKey, input.channel);
        this.db.prepare("UPDATE notifications SET status = 'delivered', sent_at = ? WHERE listing_key = ?").run(finished, input.eventKey);
        this.setSetting('daily_digest_last_sent_at', finished);
      });
      this.recordRun(input.channel, 'ok', `${input.channel} daily digest delivered`, started, finished);
      this.emit('notification', { refresh: true });
      return 'delivered' as const;
    } catch (error) {
      const message = (error instanceof Error ? error.message : `${input.channel} digest delivery failed`).slice(0, 500);
      const nextAttempt = input.attemptCount < 5 ? new Date(Date.now() + exponentialBackoff(input.attemptCount - 1, 30_000, 6 * 60 * 60_000)).toISOString() : null;
      this.db.prepare("UPDATE notification_deliveries SET status = 'failed', message = ?, next_attempt_at = ?, updated_at = ? WHERE listing_key = ? AND channel = ?").run(message, nextAttempt, nowIso(), input.deliveryKey, input.channel);
      this.db.prepare("UPDATE notifications SET status = 'failed' WHERE listing_key = ?").run(input.eventKey);
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
      const candidates = this.db.prepare(`SELECT c.*, w.name AS watch_name
        FROM daily_digest_candidates c JOIN watches w ON w.id = c.watch_id
        WHERE c.digest_date IS NULL ORDER BY c.discount_percent DESC, c.observed_at ASC, c.id ASC`).all() as DigestCandidateRow[];
      const planned: Array<{ channel: DigestChannel; eventKey: string; payload: Record<string, any> }> = [];
      this.transaction(() => {
        for (const channel of channels) {
          const minimum = channel === 'Discord' ? this.discordMinimumPriority() : ntfy!.minimumPriority;
          const eligible = candidates.filter((row) => meetsMinimumPriority(row.priority, minimum));
          if (!eligible.length) continue;
          const eventKey = `digest:${local.date}:${channel.toLowerCase()}`;
          const payload = channel === 'Discord' ? this.digestDiscordPayload(local.date, eligible) : this.digestNtfyPayload(ntfy!, local.date, eligible);
          const stored = { ...payload, _scoutDigest: { channel, date: local.date, count: eligible.length } };
          this.db.prepare('INSERT OR IGNORE INTO notifications (listing_key, payload_json, status, created_at) VALUES (?, ?, ?, ?)').run(eventKey, JSON.stringify(stored), 'pending', nowIso());
          planned.push({ channel, eventKey, payload: stored });
        }
        if (planned.length) {
          const eligibleIds = new Set<number>();
          for (const row of candidates) {
            if (channels.some((channel) => meetsMinimumPriority(row.priority, channel === 'Discord' ? this.discordMinimumPriority() : ntfy!.minimumPriority))) eligibleIds.add(Number(row.id));
          }
          const update = this.db.prepare('UPDATE daily_digest_candidates SET digest_date = ? WHERE id = ?');
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
    } | undefined;
  }

  private claimNotificationDelivery(listingKey: string, channel: 'Discord' | 'ntfy', createdAt = nowIso()) {
    const staleBefore = new Date(Date.now() - 15 * 60_000).toISOString();
    const maxAttempts = 5;
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT id, status, attempt_count, next_attempt_at, updated_at, created_at FROM notification_deliveries WHERE listing_key = ? AND channel = ?').get(listingKey, channel) as Record<string, any> | undefined;
      if (existing) {
        const attempts = Number(existing.attempt_count ?? 0);
        const updatedAt = String(existing.updated_at ?? existing.created_at ?? '');
        if (existing.status === 'delivered' || attempts >= maxAttempts) return null;
        if (existing.status === 'failed' && existing.next_attempt_at && Date.parse(existing.next_attempt_at) > Date.now()) return null;
        if (existing.status === 'pending' && updatedAt && Date.parse(updatedAt) > Date.parse(staleBefore)) return null;
        const nextAttempt = attempts + 1;
        this.db.prepare("UPDATE notification_deliveries SET status = 'pending', attempt_count = ?, next_attempt_at = NULL, updated_at = ? WHERE id = ?").run(nextAttempt, createdAt, existing.id);
        return { id: Number(existing.id), attemptCount: nextAttempt };
      }
      const result = this.db.prepare("INSERT INTO notification_deliveries (listing_key, channel, status, attempt_count, next_attempt_at, updated_at, created_at) VALUES (?, ?, 'pending', 1, NULL, ?, ?)").run(listingKey, channel, createdAt, createdAt);
      return { id: Number(result.lastInsertRowid), attemptCount: 1 };
    });
  }

  private latestDeliveryForAlert(watchId: string, listing: NormalizedListing, channel: 'Discord' | 'ntfy') {
    const prefix = `${watchId}|${listing.marketplace}|${listing.listingId}|alert:`;
    return this.db.prepare("SELECT listing_key, status, attempt_count, next_attempt_at, updated_at, created_at FROM notification_deliveries WHERE channel = ? AND listing_key LIKE ? ORDER BY id DESC LIMIT 1").get(channel, `${prefix}%|channel:${channel}`) as Record<string, any> | undefined;
  }

  private alertState(watchId: string, listing: NormalizedListing, channel: 'Discord' | 'ntfy') {
    return this.db.prepare('SELECT last_alerted_price_pln, last_priority, alert_sequence FROM watch_listing_alert_state WHERE watch_id = ? AND marketplace = ? AND listing_id = ? AND channel = ?').get(watchId, listing.marketplace, listing.listingId, channel) as { last_alerted_price_pln?: number; last_priority?: NotificationPriority; alert_sequence?: number } | undefined;
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
    legacy?: boolean;
  }) {
    const started = nowIso();
    try {
      if (input.channel === 'Discord') {
        if (!input.encryptedDiscord) throw new Error('Discord webhook is not configured');
        const response = await fetch(validateDiscordWebhook(decryptSecret(input.encryptedDiscord)), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(buildDiscordEmbed({ listing: input.listing, typical: input.typical, discountPercent: input.discountPercent, confidence: input.confidence })), signal: AbortSignal.timeout(12_000) });
        if (!response.ok) throw new Error(`Discord returned ${response.status}`);
      } else {
        if (!input.ntfy) throw new Error('ntfy is not configured');
        await publishNtfy(input.ntfy, buildNtfyPayload({ listing: input.listing, typical: input.typical, discountPercent: input.discountPercent, confidence: input.confidence }, input.ntfy.topic, input.priority));
      }
      const finished = nowIso();
      this.transaction(() => {
        this.db.prepare("UPDATE notification_deliveries SET status = 'delivered', sent_at = ?, next_attempt_at = NULL, updated_at = ? WHERE listing_key = ? AND channel = ?").run(finished, finished, input.deliveryKey, input.channel);
        const canPersistWatchState = !input.legacy && input.watchId !== undefined && input.sequence !== undefined && Boolean(this.db.prepare('SELECT 1 FROM watches WHERE id = ?').get(input.watchId));
        if (canPersistWatchState) {
          this.db.prepare(`INSERT INTO watch_listing_alert_state (watch_id, marketplace, listing_id, channel, last_alerted_price_pln, last_priority, alert_sequence, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(watch_id, marketplace, listing_id, channel) DO UPDATE SET last_alerted_price_pln = excluded.last_alerted_price_pln, last_priority = excluded.last_priority, alert_sequence = excluded.alert_sequence, updated_at = excluded.updated_at`).run(input.watchId, input.listing.marketplace, input.listing.listingId, input.channel, input.listing.price, input.priority, input.sequence, finished);
          this.db.prepare("UPDATE notifications SET status = 'delivered', sent_at = ? WHERE listing_key = ?").run(finished, input.eventKey);
        } else {
          this.db.prepare("UPDATE notifications SET status = 'delivered', sent_at = ? WHERE listing_key = ?").run(finished, input.eventKey);
        }
      });
      this.recordRun(input.channel, 'ok', `${input.channel} notification delivered`, started, finished);
      this.emit('notification', { refresh: true });
      return 'delivered' as const;
    } catch (error) {
      const message = (error instanceof Error ? error.message : `${input.channel} delivery failed`).slice(0, 500);
      const nextAttempt = input.attemptCount < 5 ? new Date(Date.now() + exponentialBackoff(input.attemptCount - 1, 30_000, 6 * 60 * 60_000)).toISOString() : null;
      this.db.prepare("UPDATE notification_deliveries SET status = 'failed', message = ?, next_attempt_at = ?, updated_at = ? WHERE listing_key = ? AND channel = ?").run(message, nextAttempt, nowIso(), input.deliveryKey, input.channel);
      this.db.prepare("UPDATE notifications SET status = 'failed' WHERE listing_key = ? AND status <> 'delivered'").run(input.eventKey);
      this.recordRun(input.channel, 'error', message, started, nowIso());
      return 'failed' as const;
    }
  }

  /**
   * The first four arguments are kept backward-compatible for existing
   * integrations/tests. New scan code always supplies watchId explicitly.
   */
  private async notifyDeal(
    watchIdOrListing: string | NormalizedListing,
    listingOrTypical: NormalizedListing | number,
    typicalOrDiscount: number,
    discountOrConfidence: number,
    maybeConfidence?: number,
  ) {
    const legacy = typeof watchIdOrListing !== 'string';
    const watchId = legacy ? '__legacy__' : watchIdOrListing;
    const listing = (legacy ? watchIdOrListing : listingOrTypical) as NormalizedListing;
    const typical = (legacy ? listingOrTypical : typicalOrDiscount) as number;
    const discountPercent = legacy ? typicalOrDiscount : discountOrConfidence;
    const confidence = legacy ? discountOrConfidence : maybeConfidence!;
    const priority = priorityFromDiscount(discountPercent);
    const encryptedDiscord = this.getSetting('discord_webhook');
    const ntfy = this.ntfyConfig();
    const digest = this.dailyDigestConfig();
    const digestSelected = (channel: DigestChannel) => digest.enabled && (channel === 'Discord' ? digest.discord : digest.ntfy);
    if (!legacy && priority !== 'exceptional') {
      const qualifiesForDigest = (digestSelected('Discord') && Boolean(encryptedDiscord) && meetsMinimumPriority(priority, this.discordMinimumPriority()))
        || (digestSelected('ntfy') && Boolean(ntfy) && meetsMinimumPriority(priority, ntfy?.minimumPriority ?? 'exceptional'));
      if (qualifiesForDigest) this.queueDailyDigestCandidate(watchId, listing, typical, discountPercent, confidence, priority);
    }
    const channels: Array<'Discord' | 'ntfy'> = [];
    if (encryptedDiscord && meetsMinimumPriority(priority, this.discordMinimumPriority()) && (priority === 'exceptional' || !digestSelected('Discord'))) channels.push('Discord');
    if (ntfy && meetsMinimumPriority(priority, ntfy.minimumPriority) && (priority === 'exceptional' || !digestSelected('ntfy'))) channels.push('ntfy');
    if (!channels.length) return;

    const planned: Array<{ channel: 'Discord' | 'ntfy'; eventKey: string; deliveryKey: string; sequence?: number; claim: { id: number; attemptCount: number }; legacy: boolean }> = [];
    for (const channel of channels) {
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
      const payload = { ...buildDiscordEmbed({ listing, typical, discountPercent, confidence }), _scout: { watchId, listing, typical, discountPercent, confidence, priority, sequence } };
      this.db.prepare('INSERT OR IGNORE INTO notifications (listing_key, payload_json, status, created_at) VALUES (?, ?, ?, ?)').run(eventKey, JSON.stringify(payload), 'pending', nowIso());
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
      legacy: item.legacy,
    })));
  }

  private async processNotificationRetries() {
    const now = nowIso();
    const stale = new Date(Date.now() - 15 * 60_000).toISOString();
    const rows = this.db.prepare(`SELECT nd.listing_key, nd.channel, nd.attempt_count, n.listing_key AS event_key, n.payload_json
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
        legacy: meta.watchId === '__legacy__',
      });
    }
  }

  private recordRun(source: string, status: string, message: string, startedAt: string, finishedAt: string | null) {
    const result = this.db.prepare('INSERT INTO connector_runs (source, status, message, started_at, finished_at) VALUES (?, ?, ?, ?, ?)').run(source, status, message, startedAt, finishedAt);
    return Number(result.lastInsertRowid);
  }

  private finishRun(id: number, status: string, message: string, backoffUntil: string | null = null) {
    this.db.prepare('UPDATE connector_runs SET status = ?, message = ?, finished_at = ?, backoff_until = ? WHERE id = ?').run(status, message, nowIso(), backoffUntil, id);
  }
}

function relativeTimeFuture(value?: string | null) {
  if (!value) return 'due now';
  const diff = Date.parse(value) - Date.now();
  if (diff <= 0) return 'due now';
  const minutes = Math.max(1, Math.ceil(diff / 60_000));
  return minutes < 60 ? `in ${minutes}m` : `in ${Math.ceil(minutes / 60)}h`;
}

export type ListingFilters = { shippingOnly?: boolean; minPrice?: number | null; maxPrice?: number | null; condition?: string; location?: string };

export function filterListings(listings: NormalizedListing[], query: string, includedRaw: string, excludedRaw: string, filters: ListingFilters | boolean = {}) {
  const options = typeof filters === 'boolean' ? { shippingOnly: filters } : filters;
  const normalize = (value: string) => value.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  const included = includedRaw.trim()
    ? includedRaw.split(',').map(normalize).filter(Boolean)
    : normalize(query).split(/\s+/).filter((term) => term.length > 1);
  const excluded = excludedRaw.split(',').map(normalize).filter(Boolean);
  return listings.filter((listing) => {
    const title = normalize(listing.title);
    const requestedLocation = normalize(options.location ?? '');
    const requestedCondition = normalize(options.condition ?? '');
    const condition = normalize(listing.condition ?? '');
    const location = normalize(listing.location ?? '');
    const isNew = /(^| )(new|nowe|nowy|nowa)( |$)/.test(condition);
    const conditionAliases: Record<string, string[]> = {
      'like new': ['like new', 'jak nowy', 'jak nowa', 'idealny', 'idealna'],
      'very good': ['very good', 'bardzo dobry', 'bardzo dobra'],
      good: ['good', 'dobry', 'dobra'],
    };
    const conditionMatches = !requestedCondition || requestedCondition === 'any'
      || (requestedCondition === 'new' ? isNew
        : requestedCondition === 'used' ? Boolean(condition) && !isNew
          : (conditionAliases[requestedCondition.replace(/\s+$/, '')] ?? [requestedCondition]).some((alias) => condition.includes(alias)));
    const locationMatches = !requestedLocation || requestedLocation === 'polska' || location.includes(requestedLocation);
    return included.every((term) => title.includes(term))
      && !excluded.some((term) => title.includes(term))
      && (!options.shippingOnly || listing.shippingAvailable === true)
      && (options.minPrice === null || options.minPrice === undefined || listing.price >= options.minPrice)
      && (options.maxPrice === null || options.maxPrice === undefined || listing.price <= options.maxPrice)
      && conditionMatches && locationMatches;
  });
}
