import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { listings as seedListings, watches as seedWatches } from '../src/data';
import type { Marketplace } from '../src/types';
import { validateSearchUrl } from './marketplaces';
import { createScoutMcpServer } from './mcp';
import { debugApiEnabled, ScoutDebug } from './debug';
import { backupDatabase, openDatabase, seedDatabase } from './db';
import { buildDiscordEmbed } from './notifications';
import { isPubliclyBoundHost, RateLimiter, securityHeaders } from './security';
import { normalizeSourceIntervals, ScoutService, ServiceError } from './service';
import { fetchDiscardSummary } from './fetch-diagnostics';

const port = Number(process.env.PORT ?? 3001);
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error('PORT must be an integer between 1 and 65535');
}

const host = process.env.SCOUT_HOST?.trim() || '127.0.0.1';
const publicExposureWarning = isPubliclyBoundHost(host);
const configuredSecret = process.env.SCOUT_SECRET?.trim() ?? '';
if ((process.env.NODE_ENV === 'production' || publicExposureWarning) && (configuredSecret.length < 32 || configuredSecret === 'change-me-in-production' || configuredSecret === 'local-development-secret')) {
  throw new Error('SCOUT_SECRET must be set to a random value of at least 32 characters before exposing Scout');
}

function configuredCorsOrigin() {
  const origins = (process.env.SCOUT_CORS_ORIGIN ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  for (const origin of origins) {
    let parsed: URL;
    try { parsed = new URL(origin); } catch { throw new Error('SCOUT_CORS_ORIGIN must contain valid HTTP(S) origins'); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
      throw new Error('SCOUT_CORS_ORIGIN must contain explicit HTTP(S) origins without credentials or paths');
    }
  }
  if (!origins.length) return false;
  return origins.length === 1 ? origins[0] : origins;
}

const app = Fastify({ logger: true, bodyLimit: 1_048_576 });
await app.register(cors, { origin: configuredCorsOrigin() });

const rateLimiter = new RateLimiter();
app.addHook('onRequest', async (request, reply) => {
  const url = request.raw.url?.split('?', 1)[0] ?? '';
  const isApi = url.startsWith('/api/');
  const isEvents = url === '/events';
  const isMcp = url === '/mcp';
  if (!isApi && !isEvents && !isMcp) return;

  const expensive = isMcp || /\/search$|\/scan$|\/scans$|\/compare-verification$|\/snapshot$|\/snapshot-images\/|\/trend$|\/analytics$|\/listing-detail$|\/market-watches$|\/export$|\/settings\/(?:webhook|ntfy)\/test$|\/settings\/ai\/reset$|\/backup$|\/system\/update$/.test(url);
  const limit = expensive ? 30 : 240;
  const bucket = rateLimiter.consume(`${request.ip}:${expensive ? 'expensive' : url}`, limit);
  reply.header('X-RateLimit-Limit', String(limit));
  reply.header('X-RateLimit-Remaining', String(bucket.remaining));
  if (!bucket.allowed) {
    reply.header('Retry-After', String(bucket.retryAfterSeconds));
    return reply.code(429).send({ error: 'Too many requests. Try again later.' });
  }
});
app.addHook('onSend', async (request, reply) => {
  const secure = request.protocol === 'https' || request.headers['x-forwarded-proto'] === 'https';
  for (const [name, value] of Object.entries(securityHeaders(secure))) reply.header(name, value);
});

const db = openDatabase();
if (process.env.SCOUT_SEED_DEMO === 'true') seedDatabase(db, { watches: seedWatches, listings: seedListings });

const clients = new Set<{ write: (chunk: string) => void; end: () => void }>();
const nowIso = () => new Date().toISOString();

function emit(event: string, payload: unknown) {
  const message = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of clients) {
    try { client.write(message); } catch { clients.delete(client); }
  }
}
const service = new ScoutService(db, emit, { publicExposureWarning });
const debug = debugApiEnabled() ? new ScoutDebug(db, service) : null;
const marketplaceParam = z.enum(['OLX', 'Allegro Lokalnie', 'Vinted']);
const marketplaceSources = z.array(marketplaceParam).min(1).max(3).refine((sources) => new Set(sources).size === sources.length, { message: 'Marketplace sources must be unique' });
const resourceIdParams = z.object({ id: z.string().trim().min(1).max(160) });

app.setErrorHandler((error, _request, reply) => {
  if (error instanceof ServiceError) return reply.code(error.status).send({ error: error.message });
  if (error && typeof error === 'object' && 'statusCode' in error && typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 500) {
    const message = 'message' in error && typeof error.message === 'string' ? error.message : 'Invalid request';
    return reply.code(error.statusCode).send({ error: message });
  }
  app.log.error(error);
  return reply.code(500).send({ error: 'Internal server error' });
});

app.get('/api/health', async () => ({ status: 'ok', service: 'scout', version: process.env.SCOUT_VERSION ?? '1.0.0', now: nowIso(), memory: process.memoryUsage() }));
app.get('/api/ready', async (_request, reply) => {
  const readiness = service.readiness();
  return reply.code(readiness.status === 'ready' ? 200 : 503).send(readiness);
});
app.get('/api/dashboard', async () => service.dashboard());
app.get('/api/listings', async (request, reply) => {
  const parsed = z.object({
    marketplace: marketplaceParam.optional(),
    q: z.string().max(240).optional(),
    watchId: z.string().trim().min(1).max(160).optional(),
    page: z.coerce.number().int().min(1).optional().default(1),
    pageSize: z.coerce.number().int().min(1).max(500).optional().default(200),
    sort: z.enum(['newest', 'strongest', 'price']).optional().default('newest'),
    decision: z.enum(['buy', 'watch', 'pass']).optional(),
    visibility: z.enum(['visible', 'hidden', 'all']).optional().default('visible'),
  }).strict().safeParse(request.query);
  if (!parsed.success) return reply.code(400).send({ error: 'Invalid listing filters' });
  const query = parsed.data;
  const page = service.listingsPage({
    marketplace: query.marketplace,
    q: query.q,
    watchId: query.watchId,
    page: query.page,
    pageSize: query.pageSize,
    sort: query.sort,
    decision: query.decision,
    visibility: query.visibility,
  });
  return { listings: page.listings, pagination: page.pagination };
});
app.get('/api/listing-detail', async (request, reply) => {
  const parsed = z.object({ key: z.string().min(3).max(500), watchId: z.string().trim().min(1).max(160).optional() }).safeParse(request.query);
  if (!parsed.success) return reply.code(400).send({ error: 'A listing key is required' });
  return service.listingDetail(parsed.data.key, parsed.data.watchId);
});
app.post('/api/ai/compare-verification', async (request, reply) => {
  const parsed = z.object({ key: z.string().min(3).max(500) }).strict().safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: 'A valid listing key is required' });
  return service.compareVerificationByKey(parsed.data.key);
});
app.get('/api/listing-actions', async (request, reply) => {
  const parsed = z.object({ key: z.string().min(3).max(500) }).safeParse(request.query);
  if (!parsed.success) return reply.code(400).send({ error: 'A listing key is required' });
  return service.listingAction(parsed.data.key);
});
const listingActionInput = z.object({
  key: z.string().min(3).max(500),
  decision: z.enum(['buy', 'watch', 'pass']).nullable(),
  note: z.string().max(2000).default(''),
  hidden: z.boolean().optional().default(false),
}).strict();
app.patch('/api/listing-actions', async (request, reply) => {
  const parsed = listingActionInput.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: 'Invalid listing action', details: parsed.error.flatten() });
  return { action: service.updateListingAction(parsed.data.key, parsed.data.decision, parsed.data.note, parsed.data.hidden) };
});
app.put('/api/listing-variant', async (request, reply) => {
  const parsed = z.object({
    key: z.string().min(3).max(500),
    watchId: z.string().trim().min(1).max(160),
    variantId: z.string().trim().min(1).max(64).nullable(),
  }).strict().safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: 'Invalid listing variant', details: parsed.error.flatten() });
  return service.setListingVariant(parsed.data.watchId, parsed.data.key, parsed.data.variantId);
});
app.get('/api/watches', async (request, reply) => {
  const strictBoolean = z.union([z.boolean(), z.string().regex(/^(?:true|false)$/i).transform((value) => value.toLowerCase() === 'true')]);
  const parsed = z.object({ includeArchived: strictBoolean.optional().default(false) }).strict().safeParse(request.query);
  if (!parsed.success) return reply.code(400).send({ error: 'Invalid watch filters' });
  return { watches: parsed.data.includeArchived ? service.allWatches() : service.getWatches() };
});
app.get('/api/watches/:id/analytics', async (request, reply) => {
  const params = resourceIdParams.safeParse(request.params);
  if (!params.success) return reply.code(400).send({ error: 'A valid watch id is required' });
  const parsed = z.object({ days: z.coerce.number().int().min(7).max(180).default(30) }).safeParse(request.query);
  if (!parsed.success) return reply.code(400).send({ error: 'Analytics range must be between 7 and 180 days' });
  return service.watchAnalytics(params.data.id, parsed.data.days);
});
app.get('/api/analytics', async (request, reply) => {
  const parsed = z.object({
    days: z.coerce.number().int().min(7).max(180).default(30),
    watchId: z.string().trim().min(1).max(160).optional(),
    marketplace: marketplaceParam.optional(),
  }).strict().safeParse(request.query);
  if (!parsed.success) return reply.code(400).send({ error: 'Invalid analytics filters' });
  return service.analytics(parsed.data);
});
app.get('/api/connectors', async () => ({ connectors: service.getConnectors() }));
app.get('/api/notifications', async (request, reply) => {
  const parsed = z.object({ page: z.coerce.number().int().min(1).optional().default(1), pageSize: z.coerce.number().int().min(1).max(200).optional().default(100) }).strict().safeParse(request.query);
  if (!parsed.success) return reply.code(400).send({ error: 'Invalid notification history pagination' });
  return service.notificationsPage(parsed.data);
});
app.get('/api/connector-runs', async (request, reply) => {
  const parsed = z.object({ page: z.coerce.number().int().min(1).optional().default(1), pageSize: z.coerce.number().int().min(1).max(200).optional().default(100) }).strict().safeParse(request.query);
  if (!parsed.success) return reply.code(400).send({ error: 'Invalid connector history pagination' });
  return service.connectorRunsPage(parsed.data);
});
app.get('/api/logs', async () => ({ logs: service.logs() }));
app.get('/api/settings', async () => service.settings());
app.get('/api/marketplace-sessions', async () => ({ sessions: service.marketplaceSessions() }));
app.get('/api/export', async (_request, reply) => reply.header('Content-Disposition', `attachment; filename="scout-export-${new Date().toISOString().slice(0, 10)}.json"`).type('application/json').send(service.exportData()));
app.post('/api/backup', async (_request, reply) => reply.code(201).send({ backup: basename(backupDatabase(db)), message: 'SQLite backup created beside the configured database file.' }));

app.put('/api/marketplace-sessions/:marketplace', async (request, reply) => {
  const params = z.object({ marketplace: marketplaceParam }).safeParse(request.params);
  if (!params.success) return reply.code(400).send({ error: 'Unsupported marketplace' });
  const body = z.object({ label: z.string().trim().max(80).optional(), storageState: z.unknown() }).strict().safeParse(request.body);
  if (!body.success || body.data.storageState === undefined) return reply.code(400).send({ error: 'A Playwright storage state is required' });
  return reply.code(201).send(service.saveMarketplaceSession(params.data.marketplace, body.data.label, body.data.storageState));
});

app.delete('/api/marketplace-sessions/:marketplace', async (request) => {
  const params = z.object({ marketplace: marketplaceParam }).safeParse(request.params);
  if (!params.success) throw new ServiceError('Unsupported marketplace', 400);
  return service.deleteMarketplaceSession(params.data.marketplace);
});

const variantGroupInput = z.object({
  id: z.string().trim().min(1).max(64).regex(/^[a-z0-9][a-z0-9_-]*$/i),
  label: z.string().trim().min(1).max(80),
  terms: z.string().trim().min(1).max(240),
  exclude: z.string().trim().max(240).optional(),
}).strict();
const variantGroupsInput = z.array(variantGroupInput).max(12);

const watchInput = z.object({
  id: z.string().trim().min(1).max(160).optional(),
  name: z.string().trim().min(1).max(120),
  query: z.string().trim().min(1).max(240),
  terms: z.string().max(240).optional().default(''),
  excluded: z.string().max(240).optional().default(''),
  sources: marketplaceSources,
  location: z.string().max(120).optional().default('Polska'),
  condition: z.string().max(80).optional().default('Any'),
  interval: z.number().int().min(5).max(24 * 60).optional().default(5),
  sourceIntervals: z.record(z.string(), z.number().int().min(5).max(1440)).optional().default({}),
  exactUrls: z.array(z.string().url()).max(20).optional().default([]),
  sensitivity: z.number().min(0.6).max(1.6).optional().default(1),
  shippingOnly: z.boolean().optional().default(false),
  typoVariants: z.boolean().optional().default(false),
  aiRelevance: z.boolean().optional().default(true),
  variantGroups: variantGroupsInput.optional().default([]),
  referenceMarketWatchId: z.string().trim().max(160).nullable().optional().default(null),
  minPrice: z.number().nonnegative().nullable().optional().default(null),
  maxPrice: z.number().positive().nullable().optional().default(null),
}).refine((value) => value.minPrice === null || value.maxPrice === null || value.minPrice <= value.maxPrice, { message: 'Minimum price cannot exceed maximum price', path: ['maxPrice'] });

app.post('/api/watches', async (request, reply) => {
  const parsed = watchInput.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: 'Invalid watch', details: parsed.error.flatten() });
  const value = parsed.data;
  for (const url of value.exactUrls) {
    const valid = validateSearchUrl(url);
    if (!valid.valid || !value.sources.includes(valid.marketplace)) return reply.code(400).send({ error: valid.valid ? 'Exact URL source is not selected' : valid.reason });
  }
  if (value.referenceMarketWatchId && !db.prepare('SELECT 1 FROM market_watches WHERE id = ?').get(value.referenceMarketWatchId)) {
    return reply.code(400).send({ error: 'Reference research watch not found' });
  }
  const id = value.id ?? `watch-${randomUUID()}`;
  const now = nowIso();
  const sourceIntervals = normalizeSourceIntervals(value.sources, value.sourceIntervals);
  try {
    db.prepare('INSERT INTO watches (id, name, query, included_terms, excluded_terms, location, condition, sources_json, exact_urls_json, interval_minutes, source_intervals_json, sensitivity, shipping_only, typo_variants, ai_relevance, variant_groups_json, reference_market_watch_id, min_price_pln, max_price_pln, enabled, next_scan_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, value.name, value.query, value.terms, value.excluded, value.location, value.condition, JSON.stringify(value.sources), JSON.stringify(value.exactUrls), value.interval, JSON.stringify(sourceIntervals), value.sensitivity, value.shippingOnly ? 1 : 0, value.typoVariants ? 1 : 0, value.aiRelevance ? 1 : 0, JSON.stringify(value.variantGroups), value.referenceMarketWatchId, value.minPrice, value.maxPrice, 1, now, now, now);
  } catch (error) {
    if (error instanceof Error && /UNIQUE|PRIMARY KEY|constraint/i.test(error.message)) {
      return reply.code(409).send({ error: 'A watch with this id already exists' });
    }
    throw error;
  }
  emit('watch', { id, name: value.name });
  const created = service.getWatches().find((watch) => watch.id === id);
  return reply.code(201).send({ watch: created });
});

app.patch('/api/watches/:id', async (request, reply) => {
  const params = resourceIdParams.safeParse(request.params);
  if (!params.success) return reply.code(400).send({ error: 'A valid watch id is required' });
  const patchInput = z.object({
    name: z.string().trim().min(1).max(120).optional(), query: z.string().trim().min(1).max(240).optional(),
    terms: z.string().max(240).optional(), excluded: z.string().max(240).optional(), sources: marketplaceSources.optional(),
    location: z.string().max(120).optional(), condition: z.string().max(80).optional(), exactUrls: z.array(z.string().url()).max(20).optional(),
    sensitivity: z.number().min(0.6).max(1.6).optional(),
    enabled: z.boolean().optional(), interval: z.number().int().min(5).max(1440).optional(),
    sourceIntervals: z.record(z.string(), z.number().int().min(5).max(1440)).optional(), shippingOnly: z.boolean().optional(),
    aiRelevance: z.boolean().optional(),
    typoVariants: z.boolean().optional(),
    variantGroups: variantGroupsInput.optional(),
    referenceMarketWatchId: z.string().trim().max(160).nullable().optional(),
    archived: z.boolean().optional(),
    minPrice: z.number().nonnegative().nullable().optional(), maxPrice: z.number().positive().nullable().optional(),
  }).strict().safeParse(request.body);
  if (!patchInput.success) return reply.code(400).send({ error: 'Invalid watch update', details: patchInput.error.flatten() });
  const body = patchInput.data;
  if (body.interval !== undefined && (!Number.isInteger(body.interval) || body.interval < 5 || body.interval > 1440)) return reply.code(400).send({ error: 'Interval must be between 5 and 1440 minutes' });
  const current = db.prepare('SELECT min_price_pln, max_price_pln, sources_json, exact_urls_json FROM watches WHERE id = ?').get(params.data.id) as { min_price_pln: number | null; max_price_pln: number | null; sources_json: string; exact_urls_json: string } | undefined;
  if (!current) return reply.code(404).send({ error: 'Watch not found' });
  const sources = body.sources ?? JSON.parse(current.sources_json || '[]') as Marketplace[];
  const exactUrls = body.exactUrls ?? JSON.parse(current.exact_urls_json || '[]') as string[];
  for (const url of exactUrls) {
    const valid = validateSearchUrl(url);
    if (!valid.valid || !sources.includes(valid.marketplace)) return reply.code(400).send({ error: valid.valid ? 'Exact URL source is not selected' : valid.reason });
  }
  const nextMin = body.minPrice === undefined ? current.min_price_pln : body.minPrice;
  const nextMax = body.maxPrice === undefined ? current.max_price_pln : body.maxPrice;
  if (nextMin !== null && nextMax !== null && nextMin > nextMax) return reply.code(400).send({ error: 'Minimum price cannot exceed maximum price' });
  const fields: string[] = [];
  const values: unknown[] = [];
  if (body.name !== undefined) { fields.push('name = ?'); values.push(body.name); }
  if (body.query !== undefined) { fields.push('query = ?'); values.push(body.query); }
  if (body.terms !== undefined) { fields.push('included_terms = ?'); values.push(body.terms); }
  if (body.excluded !== undefined) { fields.push('excluded_terms = ?'); values.push(body.excluded); }
  if (body.sources !== undefined) { fields.push('sources_json = ?'); values.push(JSON.stringify(body.sources)); }
  if (body.location !== undefined) { fields.push('location = ?'); values.push(body.location); }
  if (body.condition !== undefined) { fields.push('condition = ?'); values.push(body.condition); }
  if (body.exactUrls !== undefined) { fields.push('exact_urls_json = ?'); values.push(JSON.stringify(body.exactUrls)); }
  if (body.sensitivity !== undefined) { fields.push('sensitivity = ?'); values.push(body.sensitivity); }
  if (typeof body.enabled === 'boolean') { fields.push('enabled = ?'); values.push(body.enabled ? 1 : 0); }
  if (body.interval !== undefined) { fields.push('interval_minutes = ?'); values.push(body.interval); }
  if (body.sourceIntervals !== undefined) { fields.push('source_intervals_json = ?'); values.push(JSON.stringify(normalizeSourceIntervals(sources, body.sourceIntervals))); }
  if (typeof body.shippingOnly === 'boolean') { fields.push('shipping_only = ?'); values.push(body.shippingOnly ? 1 : 0); }
  if (typeof body.aiRelevance === 'boolean') { fields.push('ai_relevance = ?'); values.push(body.aiRelevance ? 1 : 0); }
  if (typeof body.typoVariants === 'boolean') { fields.push('typo_variants = ?'); values.push(body.typoVariants ? 1 : 0); }
  if (body.variantGroups !== undefined) { fields.push('variant_groups_json = ?'); values.push(JSON.stringify(body.variantGroups)); }
  if (body.referenceMarketWatchId !== undefined) {
    if (body.referenceMarketWatchId && !db.prepare('SELECT 1 FROM market_watches WHERE id = ?').get(body.referenceMarketWatchId)) {
      return reply.code(400).send({ error: 'Reference research watch not found' });
    }
    fields.push('reference_market_watch_id = ?');
    values.push(body.referenceMarketWatchId);
  }
  if (body.minPrice !== undefined) { fields.push('min_price_pln = ?'); values.push(body.minPrice); }
  if (body.maxPrice !== undefined) { fields.push('max_price_pln = ?'); values.push(body.maxPrice); }
  if (body.archived !== undefined) {
    fields.push('archived_at = ?');
    values.push(body.archived ? nowIso() : null);
    if (body.enabled === undefined) {
      fields.push('enabled = ?');
      values.push(body.archived ? 0 : 1);
    }
  }
  if (!fields.length) return reply.code(400).send({ error: 'No supported fields' });
  values.push(nowIso(), params.data.id);
  const result = db.prepare(`UPDATE watches SET ${fields.join(', ')}, updated_at = ? WHERE id = ?`).run(...(values as any[]));
  if (!result.changes) return reply.code(404).send({ error: 'Watch not found' });
  // Repartition the watch's saved listings immediately when the model groups
  // change; otherwise the new keys would only converge one scan at a time.
  if (body.variantGroups !== undefined) service.retagWatchVariants(params.data.id);
  emit('watch', { id: params.data.id, archived: body.archived });
  return { ok: true };
});

const searchInput = z.object({
  query: z.string().trim().min(1).max(240),
  terms: z.string().max(240).optional().default(''),
  excluded: z.string().max(240).optional().default(''),
  sources: marketplaceSources,
  minPrice: z.number().nonnegative().nullable().optional().default(null),
  maxPrice: z.number().positive().nullable().optional().default(null),
  shippingOnly: z.boolean().optional().default(false),
  condition: z.string().max(80).optional().default('Any'),
  location: z.string().max(120).optional().default(''),
  ownerType: z.enum(['private', 'business']).nullable().optional().default(null),
  page: z.number().int().min(1).max(10).optional().default(1),
  searchId: z.string().trim().min(1).max(80).optional(),
  aiRelevance: z.boolean().optional().default(true),
}).refine((value) => value.minPrice === null || value.maxPrice === null || value.minPrice <= value.maxPrice, { message: 'Minimum price cannot exceed maximum price', path: ['maxPrice'] });

app.post('/api/search', async (request, reply) => {
  const parsed = searchInput.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: 'Invalid search', details: parsed.error.flatten() });
  return service.manualSearch(parsed.data);
});

const marketWatchInput = z.object({
  name: z.string().trim().min(1).max(120),
  query: z.string().trim().min(1).max(240),
  terms: z.string().max(240).optional().default(''),
  excluded: z.string().max(240).optional().default(''),
  location: z.string().max(120).optional().default('Polska'),
  condition: z.string().max(80).optional().default('Any'),
  sources: marketplaceSources,
  intervalHours: z.number().int().min(6).max(168).optional().default(24),
  minPrice: z.number().nonnegative().nullable().optional().default(null),
  maxPrice: z.number().positive().nullable().optional().default(null),
  shippingOnly: z.boolean().optional().default(false),
  typoVariants: z.boolean().optional().default(false),
}).refine((value) => value.minPrice === null || value.maxPrice === null || value.minPrice <= value.maxPrice, { message: 'Minimum price cannot exceed maximum price', path: ['maxPrice'] });

app.get('/api/market-watches', async (request, reply) => {
  const parsed = z.object({ page: z.coerce.number().int().min(1).optional(), pageSize: z.coerce.number().int().min(1).max(400).optional(), watchId: z.string().trim().min(1).max(160).optional(), status: z.enum(['active', 'ended', 'superseded']).optional() }).strict().safeParse(request.query);
  if (!parsed.success) return reply.code(400).send({ error: 'Invalid research history pagination' });
  return service.marketResearch(parsed.data);
});

app.post('/api/market-watches', async (request, reply) => {
  const parsed = marketWatchInput.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: 'Invalid market watch', details: parsed.error.flatten() });
  const value = parsed.data;
  const id = `market-watch-${randomUUID()}`;
  const now = nowIso();
  const watch = service.createMarketWatch({ id, name: value.name, query: value.query, terms: value.terms, excluded: value.excluded, location: value.location, condition: value.condition, sources: value.sources, intervalHours: value.intervalHours, minPrice: value.minPrice, maxPrice: value.maxPrice, shippingOnly: value.shippingOnly, typoVariants: value.typoVariants });
  service.queueMarketScan(id);
  emit('market-watch', { refresh: true, id });
  return reply.code(201).send({ watch });
});

app.patch('/api/market-watches/:id', async (request, reply) => {
  const params = resourceIdParams.safeParse(request.params);
  if (!params.success) return reply.code(400).send({ error: 'A valid market watch id is required' });
  const parsed = z.object({
    name: z.string().trim().min(1).max(120).optional(),
    query: z.string().trim().min(1).max(240).optional(),
    enabled: z.boolean().optional(),
    intervalHours: z.number().int().min(6).max(168).optional(),
    terms: z.string().max(240).optional(),
    excluded: z.string().max(240).optional(),
    location: z.string().max(120).optional(),
    condition: z.string().max(80).optional(),
    sources: marketplaceSources.optional(),
    minPrice: z.number().nonnegative().nullable().optional(),
    maxPrice: z.number().positive().nullable().optional(),
    shippingOnly: z.boolean().optional(),
    typoVariants: z.boolean().optional(),
  }).strict().safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: 'Invalid market watch update', details: parsed.error.flatten() });
  const current = db.prepare('SELECT min_price_pln, max_price_pln FROM market_watches WHERE id = ?').get(params.data.id) as { min_price_pln: number | null; max_price_pln: number | null } | undefined;
  if (!current) return reply.code(404).send({ error: 'Market watch not found' });
  const nextMin = parsed.data.minPrice === undefined ? current.min_price_pln : parsed.data.minPrice;
  const nextMax = parsed.data.maxPrice === undefined ? current.max_price_pln : parsed.data.maxPrice;
  if (nextMin !== null && nextMax !== null && nextMin > nextMax) return reply.code(400).send({ error: 'Minimum price cannot exceed maximum price' });
  return service.updateMarketWatch(params.data.id, parsed.data);
});

app.post('/api/market-watches/:id/scan', async (request, reply) => {
  const params = resourceIdParams.safeParse(request.params);
  if (!params.success) return reply.code(400).send({ error: 'A valid market watch id is required' });
  return reply.code(202).send(service.queueMarketScan(params.data.id));
});

app.get('/api/market-watches/:id/trend', async (request, reply) => {
  const params = resourceIdParams.safeParse(request.params);
  if (!params.success) return reply.code(400).send({ error: 'A valid market watch id is required' });
  const parsed = z.object({ days: z.coerce.number().int().min(7).max(180).default(90) }).safeParse(request.query);
  if (!parsed.success) return reply.code(400).send({ error: 'Trend range must be between 7 and 180 days' });
  return service.marketWatchTrend(params.data.id, parsed.data.days);
});

app.get('/api/market-listings/:id/history', async (request, reply) => {
  const params = z.object({ id: z.coerce.number().int().min(1) }).safeParse(request.params);
  if (!params.success) return reply.code(400).send({ error: 'A valid research listing id is required' });
  return { points: service.marketListingHistory(params.data.id) };
});

app.get('/api/market-listings/:id/snapshot', async (request, reply) => {
  const params = z.object({ id: z.coerce.number().int().min(1) }).safeParse(request.params);
  if (!params.success) return reply.code(400).send({ error: 'A valid research listing id is required' });
  return { snapshot: service.marketListingSnapshot(params.data.id) };
});

app.post('/api/market-listings/:id/snapshot', async (request, reply) => {
  const params = z.object({ id: z.coerce.number().int().min(1) }).safeParse(request.params);
  if (!params.success) return reply.code(400).send({ error: 'A valid research listing id is required' });
  const snapshot = await service.captureMarketListingSnapshotNow(params.data.id);
  emit('market-watch', { refresh: true });
  return reply.code(201).send({ snapshot });
});

app.get('/api/market-snapshot-images/:imageId', async (request, reply) => {
  const params = z.object({ imageId: z.coerce.number().int().min(1) }).safeParse(request.params);
  if (!params.success) return reply.code(400).send({ error: 'A valid snapshot image id is required' });
  const image = service.marketSnapshotImage(params.data.imageId);
  if (!image) return reply.code(404).send({ error: 'Snapshot image not found' });
  const allowedImages = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']);
  const mime = allowedImages.has(image.mime) ? image.mime : 'application/octet-stream';
  reply.header('cache-control', 'private, max-age=31536000, immutable');
  reply.header('content-disposition', 'inline');
  reply.header('content-security-policy', "default-src 'none'; sandbox");
  return reply.type(mime).send(image.data);
});

app.delete('/api/market-watches/:id', async (request, reply) => {
  const params = resourceIdParams.safeParse(request.params);
  if (!params.success) return reply.code(400).send({ error: 'A valid market watch id is required' });
  service.deleteMarketWatch(params.data.id);
  emit('market-watch', { refresh: true });
  return { ok: true };
});

app.delete('/api/watches/:id', async (request, reply) => {
  const params = resourceIdParams.safeParse(request.params);
  if (!params.success) return reply.code(400).send({ error: 'A valid watch id is required' });
  service.deleteWatch(params.data.id);
  emit('watch', { refresh: true });
  return { ok: true };
});

app.post('/api/scans', async (request, reply) => {
  const parsed = z.object({ watchId: z.string().trim().min(1).max(160).optional() }).strict().safeParse(request.body ?? {});
  if (!parsed.success) return reply.code(400).send({ error: 'Invalid scan request' });
  return reply.code(202).send(service.queueScan(parsed.data.watchId));
});

const notificationPriority = z.enum(['strong', 'very-strong', 'exceptional']);
const settingsInput = z.object({
  interval: z.number().int().min(5).max(1440).optional(),
  nightInterval: z.number().int().min(5).max(1440).optional(),
  webhook: z.string().max(512).optional(),
  clearWebhook: z.boolean().optional(),
  discordMinimumPriority: notificationPriority.optional(),
  dailyDigest: z.object({
    enabled: z.boolean().optional(),
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
    discord: z.boolean().optional(),
    ntfy: z.boolean().optional(),
  }).strict().optional(),
  clearNtfy: z.boolean().optional(),
  ntfy: z.object({
    serverUrl: z.string().max(512).optional(),
    topic: z.string().max(64).optional(),
    token: z.string().max(512).optional(),
    minimumPriority: notificationPriority.optional(),
  }).strict().optional(),
  ai: z.object({
    apiKey: z.string().max(512).optional(),
    clearApiKey: z.boolean().optional(),
    model: z.string().trim().max(200).optional(),
  }).strict().optional(),
}).strict();

app.patch('/api/settings', async (request, reply) => {
  const parsed = settingsInput.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: 'Invalid settings', details: parsed.error.flatten() });
  return service.saveSettings(parsed.data);
});

app.post('/api/settings/webhook/test', async () => service.testWebhook());
app.post('/api/settings/ntfy/test', async () => service.testNtfy());
app.post('/api/settings/ai/reset', async () => service.resetAiResults());

const execFileAsync = promisify(execFile);

async function runUpdateStep(command: string, args: string[]) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd: process.cwd(),
      timeout: 5 * 60_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { command: `${command} ${args.join(' ')}`, success: true as const, output: `${stdout}${stderr}`.trim().slice(-4000) };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string };
    const output = `${err.stdout ?? ''}${err.stderr ?? ''}${err.message ?? ''}`.trim().slice(-4000);
    return { command: `${command} ${args.join(' ')}`, success: false as const, output };
  }
}

app.post('/api/system/update', async (_request, reply) => {
  const steps = [];
  const gitPull = await runUpdateStep('git', ['pull']);
  steps.push(gitPull);
  if (!gitPull.success) return reply.code(500).send({ error: 'git pull failed', details: gitPull.output, steps });
  const build = await runUpdateStep('npm', ['run', 'build']);
  steps.push(build);
  if (!build.success) return reply.code(500).send({ error: 'npm run build failed', details: build.output, steps });
  // Restart after the response is flushed so the client sees the result.
  setTimeout(() => {
    execFile('systemctl', ['restart', 'scout'], { cwd: process.cwd() }, () => {});
  }, 1000).unref?.();
  return { ok: true, message: 'Updated. Restarting Scout…', steps };
});

app.post('/api/notifications/preview', async (request, reply) => {
  const parsed = z.object({
    marketplace: marketplaceParam,
    listingId: z.string().trim().min(1).max(500),
    title: z.string().trim().min(1).max(500),
    price: z.number().positive(),
    typical: z.number().positive(),
    url: z.string().url(),
  }).strict().safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: 'Valid listing fields are required' });
  const body = parsed.data;
  const validatedUrl = validateSearchUrl(body.url, body.marketplace);
  if (!validatedUrl.valid) return reply.code(400).send({ error: validatedUrl.reason });
  const discount = ((body.typical - body.price) / body.typical) * 100;
  return buildDiscordEmbed({ listing: { marketplace: body.marketplace, listingId: body.listingId, title: body.title, price: body.price, currency: 'PLN', url: validatedUrl.url, observedAt: nowIso() }, typical: body.typical, discountPercent: discount, confidence: 92 });
});

// Read-only debug access to the live database for development and agent
// troubleshooting (see README "Debug API"). Queries use a separate read-only
// connection and encrypted credentials are redacted. Disable with
// SCOUT_DEBUG_API=false.
if (debug) {
  app.get('/api/debug/schema', async () => debug.schema());
  app.get('/api/debug/runtime', async () => debug.runtime());
  app.get('/api/debug/tables/:table', async (request, reply) => {
    const params = z.object({ table: z.string().trim().min(1).max(120) }).safeParse(request.params);
    const query = z.object({
      limit: z.coerce.number().int().min(1).max(1000).optional(),
      offset: z.coerce.number().int().min(0).optional(),
      orderBy: z.string().trim().min(1).max(120).optional(),
      direction: z.enum(['asc', 'desc']).optional(),
    }).safeParse(request.query);
    if (!params.success || !query.success) return reply.code(400).send({ error: 'Invalid table request' });
    return debug.tableRows(params.data.table, query.data);
  });
  app.post('/api/debug/query', async (request, reply) => {
    const body = z.object({
      sql: z.string().trim().min(1).max(20_000),
      params: z.union([z.array(z.union([z.string(), z.number(), z.null()])).max(100), z.record(z.union([z.string(), z.number(), z.null()]))]).optional(),
      maxRows: z.number().int().min(1).max(5000).optional(),
    }).safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues[0]?.message ?? 'Invalid query request' });
    return debug.query(body.data.sql, body.data.params ?? [], body.data.maxRows);
  });
  app.get('/api/debug/snapshot', async (_request, reply) => {
    const snapshot = debug.snapshot();
    const stream = createReadStream(snapshot.path);
    stream.on('close', snapshot.cleanup);
    return reply
      .header('Content-Disposition', `attachment; filename="${snapshot.filename}"`)
      .header('Content-Length', String(snapshot.bytes))
      .type('application/vnd.sqlite3')
      .send(stream);
  });
}

app.get('/events', async (request, reply) => {
  if (clients.size >= 50) return reply.code(429).send({ error: 'Too many live connections. Try again later.' });
  reply.hijack();
  const response = reply.raw;
  response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  response.write(`event: ready\ndata: ${JSON.stringify({ now: nowIso() })}\n\n`);
  const client = { write: (chunk: string) => response.write(chunk), end: () => response.end() };
  clients.add(client);
  request.raw.on('close', () => clients.delete(client));
});

// Scout's MCP server speaks Streamable HTTP (JSON-RPC over POST /mcp) so
// MCP clients connect over HTTP instead of stdio. Stateless per-request
// servers keep every request independent: no session ids, no resumability,
// any replica can serve any call. Like the REST API, the endpoint is
// unauthenticated by design — keep it on a trusted LAN/VPN.
app.post('/mcp', async (request, reply) => {
  reply.hijack();
  const mcpServer = createScoutMcpServer(service, debug);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  reply.raw.on('close', () => {
    transport.close().catch(() => {});
    mcpServer.close().catch(() => {});
  });
  try {
    await mcpServer.connect(transport);
    await transport.handleRequest(request.raw, reply.raw, request.body);
  } catch (error) {
    app.log.error(error);
    if (!reply.raw.headersSent) {
      reply.raw.writeHead(500, { 'content-type': 'application/json' });
      reply.raw.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null }));
    }
  }
});

// Stateless mode has no GET stream or DELETE session to serve.
app.get('/mcp', async (_request, reply) => reply.code(405).send({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed: use POST /mcp with an MCP JSON-RPC request.' }, id: null }));
app.delete('/mcp', async (_request, reply) => reply.code(405).send({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed: this server is stateless.' }, id: null }));

const distPath = process.env.SCOUT_DIST_PATH?.trim() || resolve(process.cwd(), 'dist');
if (existsSync(distPath)) {
  await app.register(fastifyStatic, { root: distPath, wildcard: false });
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api') || request.url === '/events' || request.url === '/mcp') return reply.code(404).send({ error: 'Not found' });
    if (request.method !== 'GET' && request.method !== 'HEAD') return reply.code(404).send({ error: 'Not found' });
    return reply.sendFile('index.html');
  });
}

const scheduler = setInterval(() => {
  service.schedulerTick();
}, 30_000);
const sseHeartbeat = setInterval(() => {
  emit('ping', { now: nowIso() });
}, 25_000);

// Periodic runtime diagnostics: RSS vs heapUsed distinguishes file-backed
// growth (mmap/page cache) from real heap retention, and the discard counts
// confirm every fetched response body is being released.
const formatMemoryLine = () => {
  const memory = process.memoryUsage();
  const mb = (bytes: number) => (bytes / 1_048_576).toFixed(1);
  return `rss=${mb(memory.rss)}MB heapUsed=${mb(memory.heapUsed)}MB heapTotal=${mb(memory.heapTotal)}MB external=${mb(memory.external)}MB arrayBuffers=${mb(memory.arrayBuffers)}MB bodyDiscards: ${fetchDiscardSummary()}`;
};
const diagnosticsInterval = setInterval(() => {
  service.logDiagnostic(formatMemoryLine());
}, 30 * 60_000);

app.addHook('onClose', async () => { debug?.close(); clearInterval(scheduler); clearInterval(sseHeartbeat); clearInterval(diagnosticsInterval); for (const client of clients) client.end(); try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* best-effort */ } db.close(); });
let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'Shutting down');
  await app.close();
};
// Background work is caught in the service; this is the last line of defence
// so one stray rejection is logged rather than ending the monitor.
process.on('unhandledRejection', (reason) => { app.log.error({ err: reason }, 'Unhandled promise rejection'); });
process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
process.once('SIGINT', () => { void shutdown('SIGINT'); });
await app.listen({ port, host });
service.logDiagnostic(`started · ${formatMemoryLine()}`);
service.schedulerTick();
