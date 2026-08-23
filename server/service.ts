import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chromium, type Browser } from 'playwright-core';
import { buildDiscordEmbed, buildNtfyPayload, meetsMinimumPriority, notificationKey, parseNotificationPriority, priorityFromDiscount, publishNtfy, validateNtfyConfig, type NtfyConfig } from './notifications';
import { createPublicAdapter, exponentialBackoff, validateSearchUrl, type Marketplace, type NormalizedListing } from './marketplaces';
import { MarketplaceSessionValidationError, parseMarketplaceStorageState, type MarketplaceStorageState } from './marketplace-sessions';
import { median, scoreDeal } from './scoring';
import type { Connector, ConnectorRun, DashboardData, DealLabel, Listing, ManualSearchResponse, MarketResearchData, MarketTrackedListing, MarketWatch, NotificationPriority, NotificationRecord, SearchFilters, SettingsData, Watch } from '../src/types';

type Database = any;
type WatchRow = Record<string, any>;

const connectorDefinitions: Array<Pick<Connector, 'name' | 'kind' | 'color'>> = [
  { name: 'OLX', kind: 'marketplace', color: '#159b96' },
  { name: 'Allegro Lokalnie', kind: 'marketplace', color: '#f27526' },
  { name: 'Vinted', kind: 'marketplace', color: '#55a9b0' },
  { name: 'Discord', kind: 'discord', color: '#32a85b' },
  { name: 'ntfy', kind: 'ntfy', color: '#4f9da6' },
];
const marketplaces: Marketplace[] = ['OLX', 'Allegro Lokalnie', 'Vinted'];

export class ServiceError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export function marketStatusAfterMiss(currentMissingScans: number, threshold = 3) {
  const missingScans = Math.max(0, Math.floor(currentMissingScans)) + 1;
  return { missingScans, status: missingScans >= threshold ? 'ended' as const : 'active' as const };
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

function duration(started?: string | null, finished?: string | null) {
  if (!started || !finished) return '—';
  const milliseconds = Math.max(0, Date.parse(finished) - Date.parse(started));
  return milliseconds < 1000 ? `${milliseconds} ms` : `${(milliseconds / 1000).toFixed(1)} s`;
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  try { return value ? JSON.parse(value) as T : fallback; } catch { return fallback; }
}

function secretKey() {
  return createHash('sha256').update(process.env.SCOUT_SECRET ?? 'local-development-secret').digest();
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
  if (url.protocol !== 'https:' || !allowedHosts.has(url.hostname) || !url.pathname.startsWith('/api/webhooks/')) {
    throw new ServiceError('Webhook must be an HTTPS Discord webhook URL');
  }
  return url.toString();
}

function searchUrl(marketplace: Marketplace, query: string) {
  const encoded = encodeURIComponent(query.trim());
  if (marketplace === 'OLX') return `https://www.olx.pl/d/oferty/q-${query.trim().toLowerCase().replace(/[^a-z0-9ąćęłńóśźż]+/gi, '-')}/`;
  if (marketplace === 'Allegro Lokalnie') return `https://allegrolokalnie.pl/oferty/q/${encoded}`;
  return `https://www.vinted.pl/catalog?search_text=${encoded}`;
}

export class ScoutService {
  private db: Database;
  private emit: (event: string, payload: unknown) => void;
  private running = new Set<string>();

  constructor(db: Database, emit: (event: string, payload: unknown) => void) {
    this.db = db;
    this.emit = emit;
  }

  private getSetting(key: string) {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value?: string } | undefined;
    return row?.value ?? null;
  }

  private setSetting(key: string, value: string) {
    this.db.prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run(key, value, nowIso());
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

  private watchFromRow(row: WatchRow): Watch {
    const stats = this.db.prepare('SELECT COUNT(DISTINCT o.listing_id) AS samples, MIN(o.observed_at) AS first_observed FROM observations o JOIN listings l ON l.id = o.listing_id WHERE o.watch_id = ? AND (? = 0 OR l.shipping_available = 1) AND (? IS NULL OR l.price_pln >= ?) AND (? IS NULL OR l.price_pln <= ?)').get(row.id, row.shipping_only ? 1 : 0, row.min_price_pln, row.min_price_pln, row.max_price_pln, row.max_price_pln) as { samples: number; first_observed: string | null };
    const samples = Number(stats?.samples ?? 0);
    const observationHours = stats?.first_observed ? Math.max(0, Math.floor((Date.now() - Date.parse(stats.first_observed)) / 3_600_000)) : 0;
    const readiness = Math.round(Math.min(1, samples / 30, observationHours / 24) * 100);
    const enabled = Boolean(row.enabled);
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
      targetSamples: 30,
      observationHours,
      readiness,
      status: enabled ? (readiness >= 100 ? 'Ready' : 'Learning') : 'Paused',
      interval: Number(row.interval_minutes),
      nextScan: enabled ? relativeTimeFuture(row.next_scan_at) : 'Paused',
      enabled,
      exactUrls: parseJson<string[]>(row.exact_urls_json, []),
      sensitivity: Number(row.sensitivity ?? 1),
      shippingOnly: Boolean(row.shipping_only),
      minPrice: row.min_price_pln === null ? null : Number(row.min_price_pln),
      maxPrice: row.max_price_pln === null ? null : Number(row.max_price_pln),
    };
  }

  private listingFromRow(row: Record<string, any>, baselineReady: boolean): Listing {
    const typical = baselineReady && row.typical_pln !== null ? Number(row.typical_pln) : null;
    const price = Number(row.price_pln);
    const belowTypical = typical && typical > 0 ? -Math.max(0, ((typical - price) / typical) * 100) : null;
    const discount = belowTypical === null ? 0 : Math.abs(belowTypical);
    const dealStrength = discount >= 30 ? 5 : discount >= 20 ? 4 : discount >= 12 ? 3 : discount > 0 ? 2 : 1;
    const dealLabel: DealLabel = dealStrength >= 5 ? 'Exceptional' : dealStrength === 4 ? 'Very strong' : dealStrength === 3 ? 'Strong' : 'Watch';
    return {
      id: `${row.marketplace}:${row.listing_id}`,
      title: row.title,
      subtitle: row.subtitle || row.condition || row.location || '',
      marketplace: row.marketplace,
      price,
      typical,
      belowTypical,
      observed: relativeTime(row.last_seen_at),
      observedAt: row.last_seen_at,
      dealStrength,
      dealLabel,
      image: row.image_url || '',
      url: row.url,
      watch: row.watch_name || 'Unassigned',
      condition: row.condition || undefined,
      location: row.location || undefined,
      shippingAvailable: row.shipping_available === null ? null : Boolean(row.shipping_available),
    };
  }

  getWatches() {
    return (this.db.prepare('SELECT * FROM watches ORDER BY created_at DESC').all() as WatchRow[]).map((row) => this.watchFromRow(row));
  }

  getListings() {
    const rows = this.db.prepare(`SELECT l.*, (SELECT o.watch_id FROM observations o WHERE o.listing_id = l.id ORDER BY o.observed_at DESC LIMIT 1) AS watch_id, (SELECT w.name FROM observations o JOIN watches w ON w.id = o.watch_id WHERE o.listing_id = l.id ORDER BY o.observed_at DESC LIMIT 1) AS watch_name FROM listings l WHERE EXISTS (SELECT 1 FROM observations o WHERE o.listing_id = l.id) ORDER BY l.last_seen_at DESC LIMIT 200`).all() as Array<Record<string, any>>;
    const watches = new Map(this.getWatches().map((watch) => [watch.id, watch]));
    return rows.filter((row) => {
      const watch = watches.get(row.watch_id);
      return (!watch?.shippingOnly || row.shipping_available === 1)
        && (watch?.minPrice === null || watch?.minPrice === undefined || Number(row.price_pln) >= watch.minPrice)
        && (watch?.maxPrice === null || watch?.maxPrice === undefined || Number(row.price_pln) <= watch.maxPrice);
    }).map((row) => this.listingFromRow(row, watches.get(row.watch_id)?.readiness === 100));
  }

  async manualSearch(input: SearchFilters): Promise<ManualSearchResponse> {
    const tasks = input.sources.map(async (source) => {
      const started = Date.now();
      try {
        const adapter = createPublicAdapter(source, (url) => this.fetchPublicPage(url, source));
        const fetched = await adapter.fetchPublicSearch(searchUrl(source, input.query));
        const comparable = filterListings(fetched, input.query, input.terms ?? '', input.excluded ?? '', {
          minPrice: input.minPrice, maxPrice: input.maxPrice, condition: input.condition, location: input.location,
        });
        if (input.shippingOnly) await this.enrichShipping(comparable, source);
        const filtered = filterListings(comparable, input.query, input.terms ?? '', input.excluded ?? '', { shippingOnly: input.shippingOnly });
        const pendingShipping = input.shippingOnly ? comparable.filter((listing) => listing.shippingAvailable === null).length : 0;
        return {
          listings: filtered.slice(0, 100).map((listing): Listing => ({
            id: `${listing.marketplace}:${listing.listingId}`, title: listing.title,
            subtitle: [listing.condition, listing.location].filter(Boolean).join(' · '), marketplace: listing.marketplace,
            price: listing.price, typical: null, belowTypical: null, observed: 'just now', observedAt: listing.observedAt,
            dealStrength: 1, dealLabel: 'Watch', image: listing.imageUrl ?? '', url: listing.url, watch: 'Manual search',
            condition: listing.condition, location: listing.location, shippingAvailable: listing.shippingAvailable ?? null,
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
  }

  marketResearch(): MarketResearchData {
    const watchRows = this.db.prepare('SELECT * FROM market_watches ORDER BY created_at DESC').all() as WatchRow[];
    const watches = watchRows.map((row): MarketWatch => {
      const counts = this.db.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active, SUM(CASE WHEN status = 'ended' THEN 1 ELSE 0 END) AS ended FROM market_listings WHERE market_watch_id = ?").get(row.id) as { total: number; active: number | null; ended: number | null };
      const endedPrices = (this.db.prepare("SELECT last_price_pln FROM market_listings WHERE market_watch_id = ? AND status = 'ended'").all(row.id) as Array<{ last_price_pln: number }>).map((item) => Number(item.last_price_pln));
      return {
        id: row.id, name: row.name, query: row.query, terms: row.included_terms ?? '', excluded: row.excluded_terms ?? '', location: row.location ?? 'Polska', condition: row.condition ?? 'Any', sources: parseJson<Marketplace[]>(row.sources_json, []),
        intervalHours: Number(row.interval_hours), minPrice: row.min_price_pln === null || row.min_price_pln === undefined ? null : Number(row.min_price_pln), maxPrice: row.max_price_pln === null || row.max_price_pln === undefined ? null : Number(row.max_price_pln), shippingOnly: Boolean(row.shipping_only), enabled: Boolean(row.enabled), nextScan: Boolean(row.enabled) ? relativeTimeFuture(row.next_scan_at) : 'Paused',
        lastScan: relativeTime(row.last_scan_at), totalListings: Number(counts.total ?? 0), activeListings: Number(counts.active ?? 0), endedListings: Number(counts.ended ?? 0),
        estimatedMedianPrice: endedPrices.length ? median(endedPrices) : null,
      };
    });
    const listings = (this.db.prepare(`SELECT ml.*, mw.name AS watch_name, (SELECT COUNT(*) FROM market_price_observations mpo WHERE mpo.market_listing_id = ml.id) AS observations FROM market_listings ml JOIN market_watches mw ON mw.id = ml.market_watch_id ORDER BY CASE ml.status WHEN 'ended' THEN 0 ELSE 1 END, COALESCE(ml.ended_at, ml.last_seen_at) DESC LIMIT 400`).all() as Array<Record<string, any>>).map((row): MarketTrackedListing => ({
      id: Number(row.id), marketWatchId: row.market_watch_id, watchName: row.watch_name, marketplace: row.marketplace, listingId: row.listing_id,
      title: row.title, url: row.url, image: row.image_url ?? '', firstPrice: Number(row.first_price_pln), lastPrice: Number(row.last_price_pln), lowestPrice: Number(row.lowest_price_pln),
      priceChangePercent: Number(row.first_price_pln) > 0 ? ((Number(row.last_price_pln) - Number(row.first_price_pln)) / Number(row.first_price_pln)) * 100 : 0,
      firstSeenAt: row.first_seen_at, lastSeenAt: row.last_seen_at, endedAt: row.ended_at, status: row.status, missingScans: Number(row.missing_scans), observations: Number(row.observations),
    }));
    return { watches, listings };
  }

  queueMarketScan(id: string) {
    const row = this.db.prepare('SELECT * FROM market_watches WHERE id = ? AND enabled = 1').get(id) as WatchRow | undefined;
    if (!row) throw new ServiceError('Enabled market watch not found', 404);
    void this.runMarketWatch(row);
    return { queued: true, message: `Queued ${row.name}` };
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
    try {
      await Promise.all(sources.map(async (source) => {
        const started = nowIso();
        const runId = this.recordRun(source, 'running', `Researching ${row.name}`, started, null);
        try {
          const adapter = createPublicAdapter(source, (url) => this.fetchPublicPage(url, source));
          const fetched = await adapter.fetchPublicSearch(searchUrl(source, row.query));
          const filters = { minPrice: row.min_price_pln, maxPrice: row.max_price_pln, condition: row.condition, location: row.location };
          const comparable = filterListings(fetched, row.query, row.included_terms ?? '', row.excluded_terms ?? '', filters);
          if (row.shipping_only) await this.enrichShipping(comparable, source);
          const filtered = filterListings(comparable, row.query, row.included_terms ?? '', row.excluded_terms ?? '', { ...filters, shippingOnly: Boolean(row.shipping_only) });
          const observedAt = nowIso();
          const seen = new Set<string>();
          for (const listing of filtered) {
            seen.add(listing.listingId);
            this.storeMarketListing(row.id, listing, observedAt);
          }
          const active = this.db.prepare("SELECT id, listing_id, missing_scans FROM market_listings WHERE market_watch_id = ? AND marketplace = ? AND status = 'active'").all(row.id, source) as Array<{ id: number; listing_id: string; missing_scans: number }>;
          for (const listing of active) {
            if (seen.has(listing.listing_id)) continue;
            const next = marketStatusAfterMiss(Number(listing.missing_scans));
            if (next.status === 'ended') this.db.prepare("UPDATE market_listings SET missing_scans = ?, status = 'ended', ended_at = ? WHERE id = ?").run(next.missingScans, observedAt, listing.id);
            else this.db.prepare('UPDATE market_listings SET missing_scans = ? WHERE id = ?').run(next.missingScans, listing.id);
          }
          this.finishRun(runId, 'ok', `${filtered.length} research listings saved`);
        } catch (error) {
          this.finishRun(runId, 'error', error instanceof Error ? error.message : 'Research connector failed');
        }
      }));
      const finished = nowIso();
      const next = new Date(Date.now() + Math.max(6, Number(row.interval_hours)) * 3_600_000).toISOString();
      this.db.prepare('UPDATE market_watches SET next_scan_at = ?, last_scan_at = ?, updated_at = ? WHERE id = ?').run(next, finished, finished, row.id);
      this.emit('market-watch', { refresh: true, id: row.id });
    } finally { this.running.delete(runningKey); }
  }

  private storeMarketListing(watchId: string, listing: NormalizedListing, observedAt: string) {
    this.db.prepare(`INSERT INTO market_listings (market_watch_id, marketplace, listing_id, title, url, image_url, first_price_pln, last_price_pln, lowest_price_pln, first_seen_at, last_seen_at, status, missing_scans) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 0) ON CONFLICT(market_watch_id, marketplace, listing_id) DO UPDATE SET title = excluded.title, url = excluded.url, image_url = COALESCE(excluded.image_url, market_listings.image_url), last_price_pln = excluded.last_price_pln, lowest_price_pln = MIN(market_listings.lowest_price_pln, excluded.last_price_pln), last_seen_at = excluded.last_seen_at, status = 'active', missing_scans = 0, ended_at = NULL`).run(watchId, listing.marketplace, listing.listingId, listing.title, listing.url, listing.imageUrl ?? null, listing.price, listing.price, listing.price, observedAt, observedAt);
    const stored = this.db.prepare('SELECT id FROM market_listings WHERE market_watch_id = ? AND marketplace = ? AND listing_id = ?').get(watchId, listing.marketplace, listing.listingId) as { id: number };
    this.db.prepare('INSERT INTO market_price_observations (market_listing_id, price_pln, observed_at) VALUES (?, ?, ?)').run(stored.id, listing.price, observedAt);
  }

  getConnectors(): Connector[] {
    const webhookConfigured = Boolean(this.getSetting('discord_webhook'));
    const ntfyConfigured = Boolean(this.ntfyConfig());
    return connectorDefinitions.map((definition) => {
      if (definition.name === 'Discord' && !webhookConfigured) return { ...definition, status: 'Idle', detail: 'Webhook not configured', lastSuccess: 'Never', requests: 0, latency: '—' };
      if (definition.name === 'ntfy' && !ntfyConfigured) return { ...definition, status: 'Idle', detail: 'ntfy not configured', lastSuccess: 'Never', requests: 0, latency: '—' };
      const last = this.db.prepare('SELECT * FROM connector_runs WHERE source = ? ORDER BY started_at DESC LIMIT 1').get(definition.name) as Record<string, any> | undefined;
      const count = this.db.prepare('SELECT COUNT(*) AS count FROM connector_runs WHERE source = ?').get(definition.name) as { count: number };
      const lastSuccess = this.db.prepare("SELECT finished_at FROM connector_runs WHERE source = ? AND status = 'ok' ORDER BY finished_at DESC LIMIT 1").get(definition.name) as { finished_at?: string } | undefined;
      if (!last) return { ...definition, status: 'Idle', detail: definition.name === 'Discord' ? 'Webhook configured; no delivery yet' : definition.name === 'ntfy' ? 'ntfy configured; no delivery yet' : 'No connector run yet', lastSuccess: 'Never', requests: Number(count?.count ?? 0), latency: '—' };
      const status: Connector['status'] = last.status === 'ok' ? 'OK' : last.status === 'error' ? 'Degraded' : last.status === 'running' ? 'Warning' : 'Idle';
      return { ...definition, status, detail: last.message || (status === 'OK' ? 'Last run completed' : 'Waiting for a run'), lastSuccess: relativeTime(lastSuccess?.finished_at), requests: Number(count?.count ?? 0), latency: duration(last.started_at, last.finished_at) };
    });
  }

  dashboard(): DashboardData {
    const watches = this.getWatches();
    const listings = this.getListings();
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const lastScan = parseJson<{ at?: string }>(this.getSetting('last_scan'), {});
    return {
      watches,
      listings,
      connectors: this.getConnectors(),
      stats: {
        watching: watches.filter((watch) => watch.enabled).length,
        newToday: listings.filter((listing) => Date.parse(listing.observedAt) >= today.getTime()).length,
        strongDeals: listings.filter((listing) => listing.dealStrength >= 4).length,
      },
      lastScan: relativeTime(lastScan.at),
      lastScanTime: timeOnly(lastScan.at),
    };
  }

  settings(): SettingsData {
    const webhookConfigured = Boolean(this.getSetting('discord_webhook'));
    const ntfy = this.ntfyConfig();
    return {
      defaultInterval: Number(this.getSetting('default_interval') ?? 5),
      webhookConfigured,
      webhookMasked: webhookConfigured ? '••••••••••••••••' : null,
      discordMinimumPriority: this.discordMinimumPriority(),
      ntfy: {
        configured: Boolean(ntfy),
        serverUrl: ntfy?.serverUrl ?? null,
        topicMasked: ntfy ? '••••••••••••••••' : null,
        tokenConfigured: Boolean(ntfy?.token),
        minimumPriority: ntfy?.minimumPriority ?? 'exceptional',
      },
      publicExposureWarning: process.env.SCOUT_PUBLIC === 'true',
      marketplaceSessions: this.marketplaceSessions(),
    };
  }

  saveSettings(input: {
    interval?: number;
    webhook?: string;
    clearWebhook?: boolean;
    discordMinimumPriority?: NotificationPriority;
    clearNtfy?: boolean;
    ntfy?: { serverUrl?: string; topic?: string; token?: string; minimumPriority?: NotificationPriority };
  }) {
    if (input.interval !== undefined) {
      if (!Number.isInteger(input.interval) || input.interval < 5 || input.interval > 1440) throw new ServiceError('Polling interval must be between 5 and 1440 minutes');
      this.setSetting('default_interval', String(input.interval));
    }
    if (input.clearWebhook) this.db.prepare("DELETE FROM settings WHERE key = 'discord_webhook'").run();
    if (input.webhook?.trim()) this.setSetting('discord_webhook', encryptSecret(validateDiscordWebhook(input.webhook.trim())));
    if (input.discordMinimumPriority !== undefined) this.setSetting('discord_minimum_priority', parseNotificationPriority(input.discordMinimumPriority, 'strong'));
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
    return this.settings();
  }

  notifications(): NotificationRecord[] {
    const rows = this.db.prepare('SELECT * FROM notifications ORDER BY created_at DESC LIMIT 100').all() as Array<Record<string, any>>;
    return rows.map((row) => {
      const payload = parseJson<Record<string, any>>(row.payload_json, {});
      const embed = payload.embeds?.[0];
      const below = embed?.fields?.find((field: any) => field.name === 'Below typical')?.value;
      return { id: Number(row.id), title: embed?.title ?? payload.title ?? (payload.test ? `${payload.channel === 'ntfy' ? 'ntfy' : 'Discord'} test notification` : row.listing_key), reason: below ? `${below} below typical` : payload.test ? `${payload.channel === 'ntfy' ? 'ntfy' : 'Webhook'} connectivity test` : 'Deal alert', observedAt: row.sent_at ?? row.created_at, status: row.status };
    });
  }

  connectorRuns(): ConnectorRun[] {
    const rows = this.db.prepare('SELECT * FROM connector_runs ORDER BY started_at DESC LIMIT 100').all() as Array<Record<string, any>>;
    return rows.map((row) => ({ id: Number(row.id), source: row.source, status: row.status, message: row.message, startedAt: row.started_at, finishedAt: row.finished_at, duration: duration(row.started_at, row.finished_at) }));
  }

  deleteWatch(id: string) {
    const result = this.db.prepare('DELETE FROM watches WHERE id = ?').run(id);
    if (!result.changes) throw new ServiceError('Watch not found', 404);
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
    try {
      await Promise.all(sources.map(async (source) => {
        const latest = this.db.prepare('SELECT backoff_until FROM connector_runs WHERE source = ? ORDER BY started_at DESC LIMIT 1').get(source) as { backoff_until?: string } | undefined;
        if (latest?.backoff_until && Date.parse(latest.backoff_until) > Date.now()) return;
        const started = nowIso();
        const runId = this.recordRun(source, 'running', `Scanning ${row.name}`, started, null);
        try {
          const matchingExact = exactUrls.filter((url) => validateSearchUrl(url, source).valid);
          const urls = matchingExact.length ? matchingExact : [searchUrl(source, row.query)];
          const adapter = createPublicAdapter(source, (url) => this.fetchPublicPage(url, source));
          const fetched = (await Promise.all(urls.map((url) => adapter.fetchPublicSearch(url)))).flat();
          const comparable = filterListings(fetched, row.query, row.included_terms, row.excluded_terms, { minPrice: row.min_price_pln, maxPrice: row.max_price_pln, condition: row.condition, location: row.location });
          if (row.shipping_only) await this.enrichShipping(comparable, source);
          const filtered = filterListings(comparable, row.query, row.included_terms, row.excluded_terms, { shippingOnly: Boolean(row.shipping_only) });
          for (const listing of filtered) await this.storeListing(row, listing);
          const pending = row.shipping_only ? comparable.filter((listing) => listing.shippingAvailable === null).length : 0;
          this.finishRun(runId, 'ok', row.shipping_only ? `${filtered.length} shipping matches${pending ? ` · ${pending} pending checks` : ''}` : `${filtered.length} listings normalized`);
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Connector failed';
          const recent = this.db.prepare('SELECT status FROM connector_runs WHERE source = ? AND id != ? ORDER BY started_at DESC LIMIT 8').all(source, runId) as Array<{ status: string }>;
          const consecutiveFailures = recent.findIndex((run) => run.status !== 'error');
          const failureCount = consecutiveFailures === -1 ? recent.length : consecutiveFailures;
          this.finishRun(runId, 'error', message, new Date(Date.now() + exponentialBackoff(failureCount)).toISOString());
        }
      }));
      const finished = nowIso();
      const next = new Date(Date.now() + Math.max(5, Number(row.interval_minutes)) * 60_000).toISOString();
      this.db.prepare('UPDATE watches SET next_scan_at = ?, updated_at = ? WHERE id = ?').run(next, finished, row.id);
      this.setSetting('last_scan', JSON.stringify({ at: finished }));
      this.emit('scan', { refresh: true, watchId: row.id });
    } finally {
      this.running.delete(row.id);
    }
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

  private async renderPublicPage(url: string, marketplace: Marketplace, storageState?: MarketplaceStorageState) {
    let browser: Browser | undefined;
    try {
      if (process.env.SCOUT_BROWSER_WS) {
        browser = await chromium.connectOverCDP(process.env.SCOUT_BROWSER_WS, { timeout: 8_000 });
      } else {
        const executablePath = process.env.SCOUT_CHROMIUM_PATH ?? ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].find(existsSync);
        if (!executablePath) throw new Error('Chromium is not available; configure SCOUT_BROWSER_WS');
        browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--disable-gpu'] });
      }
      const context = storageState
        ? await browser.newContext({ locale: 'pl-PL', storageState: storageState as any })
        : browser.contexts()[0] ?? await browser.newContext({ locale: 'pl-PL' });
      const page = await context.newPage();
      try {
        const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25_000 });
        await page.waitForTimeout(800);
        const finalValidation = validateSearchUrl(page.url(), marketplace);
        if (!finalValidation.valid) throw new Error('Marketplace redirected off the approved domain');
        if (response && !response.ok()) throw new Error(`Chromium page returned ${response.status()}`);
        return await page.content();
      } finally { await page.close(); }
    } finally { if (browser) await browser.close(); }
  }

  private pruneRetention() {
    const lastPrune = this.getSetting('last_prune');
    if (lastPrune && Date.now() - Date.parse(lastPrune) < 24 * 60 * 60_000) return;
    const cutoff = new Date(Date.now() - 180 * 24 * 60 * 60_000).toISOString();
    this.db.prepare('DELETE FROM observations WHERE observed_at < ?').run(cutoff);
    this.db.prepare('DELETE FROM listings WHERE last_seen_at < ? AND NOT EXISTS (SELECT 1 FROM observations WHERE observations.listing_id = listings.id)').run(cutoff);
    this.setSetting('last_prune', nowIso());
  }

  private async enrichShipping(listings: NormalizedListing[], marketplace: Marketplace) {
    const lookup = this.db.prepare('SELECT shipping_available FROM listings WHERE marketplace = ? AND listing_id = ?');
    for (const listing of listings) {
      if (listing.shippingAvailable !== null) continue;
      const cached = lookup.get(listing.marketplace, listing.listingId) as { shipping_available: number | null } | undefined;
      if (cached?.shipping_available !== null && cached?.shipping_available !== undefined) listing.shippingAvailable = Boolean(cached.shipping_available);
    }
    if (marketplace === 'OLX') return;
    const unknown = listings.filter((listing) => listing.shippingAvailable === null).slice(0, 8);
    for (let offset = 0; offset < unknown.length; offset += 2) {
      await Promise.all(unknown.slice(offset, offset + 2).map(async (listing) => {
        try {
          const html = await this.fetchPublicPage(listing.url, marketplace);
          const available = marketplace === 'Vinted'
            ? /transaction_permitted\\?["']:\s*true/i.test(html)
            : [...html.matchAll(/<div[^>]*class=["'][^"']*mlc-delivery-options__name[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi)].some((match) => !/odbi[oó]r osobisty/i.test(match[1].replace(/<[^>]*>/g, ' ')));
          listing.shippingAvailable = available;
          this.cacheShipping(listing);
        } catch { /* unknown remains excluded and will be retried on a later scan */ }
      }));
    }
  }

  private cacheShipping(listing: NormalizedListing) {
    const checked = nowIso();
    this.db.prepare(`INSERT INTO listings (marketplace, listing_id, title, price_pln, url, image_url, condition, location, shipping_available, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(marketplace, listing_id) DO UPDATE SET shipping_available = excluded.shipping_available, last_seen_at = excluded.last_seen_at`).run(listing.marketplace, listing.listingId, listing.title, listing.price, listing.url, listing.imageUrl ?? null, listing.condition ?? null, listing.location ?? null, listing.shippingAvailable ? 1 : 0, checked, checked);
  }

  private async storeListing(row: WatchRow, listing: NormalizedListing) {
    const existingPrices = (this.db.prepare('SELECT l.price_pln FROM listings l WHERE EXISTS (SELECT 1 FROM observations o WHERE o.listing_id = l.id AND o.watch_id = ?) AND (? = 0 OR l.shipping_available = 1) AND (? IS NULL OR l.price_pln >= ?) AND (? IS NULL OR l.price_pln <= ?) ORDER BY l.last_seen_at DESC LIMIT 250').all(row.id, row.shipping_only ? 1 : 0, row.min_price_pln, row.min_price_pln, row.max_price_pln, row.max_price_pln) as Array<{ price_pln: number }>).map((item) => Number(item.price_pln));
    const firstSeen = nowIso();
    this.db.prepare(`INSERT INTO listings (marketplace, listing_id, title, price_pln, url, image_url, condition, location, shipping_available, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(marketplace, listing_id) DO UPDATE SET title = excluded.title, price_pln = excluded.price_pln, url = excluded.url, image_url = COALESCE(excluded.image_url, listings.image_url), condition = COALESCE(excluded.condition, listings.condition), location = COALESCE(excluded.location, listings.location), shipping_available = COALESCE(excluded.shipping_available, listings.shipping_available), last_seen_at = excluded.last_seen_at`).run(listing.marketplace, listing.listingId, listing.title, listing.price, listing.url, listing.imageUrl ?? null, listing.condition ?? null, listing.location ?? null, listing.shippingAvailable === null ? null : listing.shippingAvailable ? 1 : 0, firstSeen, firstSeen);
    const stored = this.db.prepare('SELECT id FROM listings WHERE marketplace = ? AND listing_id = ?').get(listing.marketplace, listing.listingId) as { id: number };
    this.db.prepare('INSERT INTO observations (listing_id, watch_id, price_pln, observed_at) VALUES (?, ?, ?, ?)').run(stored.id, row.id, listing.price, firstSeen);
    const firstObservation = this.db.prepare('SELECT MIN(o.observed_at) AS first FROM observations o JOIN listings l ON l.id = o.listing_id WHERE o.watch_id = ? AND (? = 0 OR l.shipping_available = 1) AND (? IS NULL OR l.price_pln >= ?) AND (? IS NULL OR l.price_pln <= ?)').get(row.id, row.shipping_only ? 1 : 0, row.min_price_pln, row.min_price_pln, row.max_price_pln, row.max_price_pln) as { first: string | null };
    const observedHours = firstObservation.first ? Math.max(0, (Date.now() - Date.parse(firstObservation.first)) / 3_600_000) : 0;
    const score = scoreDeal(existingPrices, listing.price, { observedHours, sensitivity: Number(row.sensitivity ?? 1) });
    if (score.isReady && score.typical !== null) this.db.prepare('UPDATE listings SET typical_pln = ? WHERE id = ?').run(score.typical, stored.id);
    if (score.qualifies) await this.notifyDeal(listing, score.typical!, score.discountPercent!, score.confidence);
  }

  private async notifyDeal(listing: NormalizedListing, typical: number, discountPercent: number, confidence: number) {
    const priority = priorityFromDiscount(discountPercent);
    const encryptedDiscord = this.getSetting('discord_webhook');
    const ntfy = this.ntfyConfig();
    const channels: Array<'Discord' | 'ntfy'> = [];
    if (encryptedDiscord && meetsMinimumPriority(priority, this.discordMinimumPriority())) channels.push('Discord');
    if (ntfy && meetsMinimumPriority(priority, ntfy.minimumPriority)) channels.push('ntfy');
    if (!channels.length) return;
    const key = notificationKey(listing);
    const payload = buildDiscordEmbed({ listing, typical, discountPercent, confidence });
    const created = nowIso();
    const existing = this.db.prepare('SELECT id, status, payload_json, sent_at, created_at FROM notifications WHERE listing_key = ?').get(key) as { id?: number; status?: string; payload_json?: string; sent_at?: string; created_at?: string } | undefined;
    if (!existing) {
      this.db.prepare('INSERT INTO notifications (listing_key, payload_json, status, created_at) VALUES (?, ?, ?, ?)').run(key, JSON.stringify(payload), 'pending', created);
    } else if (channels.includes('Discord')) {
      const oldPayload = parseJson<Record<string, any>>(existing.payload_json, {});
      if (oldPayload.embeds?.length) {
        this.db.prepare(`INSERT OR IGNORE INTO notification_deliveries (listing_key, channel, status, message, sent_at, created_at) VALUES (?, 'Discord', ?, ?, ?, ?)`).run(key, existing.status === 'failed' ? 'failed' : 'delivered', existing.status === 'failed' ? 'Previous delivery failed' : null, existing.sent_at ?? existing.created_at ?? created, existing.created_at ?? created);
      }
    }

    const results = await Promise.all(channels.map(async (channel) => {
      const claimed = this.db.prepare('INSERT OR IGNORE INTO notification_deliveries (listing_key, channel, status, created_at) VALUES (?, ?, ?, ?)').run(key, channel, 'pending', created);
      if (!claimed.changes) return null;
      const started = nowIso();
      try {
        if (channel === 'Discord') {
          if (!encryptedDiscord) throw new Error('Discord webhook is not configured');
          const response = await fetch(validateDiscordWebhook(decryptSecret(encryptedDiscord)), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(12_000) });
          if (!response.ok) throw new Error(`Discord returned ${response.status}`);
        } else {
          if (!ntfy) throw new Error('ntfy is not configured');
          await publishNtfy(ntfy, buildNtfyPayload({ listing, typical, discountPercent, confidence }, ntfy.topic, priority));
        }
        const finished = nowIso();
        this.db.prepare("UPDATE notification_deliveries SET status = 'delivered', message = NULL, sent_at = ? WHERE listing_key = ? AND channel = ?").run(finished, key, channel);
        this.recordRun(channel, 'ok', `${channel} notification delivered`, started, finished);
        return 'delivered' as const;
      } catch (error) {
        const message = error instanceof Error ? error.message : `${channel} delivery failed`;
        this.db.prepare("UPDATE notification_deliveries SET status = 'failed', message = ? WHERE listing_key = ? AND channel = ?").run(message, key, channel);
        this.recordRun(channel, 'error', message, started, nowIso());
        return 'failed' as const;
      }
    }));
    const attempted = results.filter((result): result is 'delivered' | 'failed' => result !== null);
    if (attempted.length) {
      const delivered = attempted.includes('delivered');
      this.db.prepare(`UPDATE notifications SET status = ?, sent_at = ? WHERE listing_key = ?`).run(delivered ? 'delivered' : 'failed', delivered ? nowIso() : null, key);
      this.emit('notification', { refresh: true });
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
