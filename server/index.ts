import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { listings as seedListings, watches as seedWatches } from '../src/data';
import { validateSearchUrl } from './marketplaces';
import { openDatabase, seedDatabase } from './db';
import { buildDiscordEmbed } from './notifications';
import { ScoutService, ServiceError } from './service';

if (process.env.NODE_ENV === 'production') {
  const configuredSecret = process.env.SCOUT_SECRET?.trim() ?? '';
  if (configuredSecret.length < 32 || configuredSecret === 'change-me-in-production') {
    throw new Error('SCOUT_SECRET must be set to a random value of at least 32 characters in production');
  }
}

const port = Number(process.env.PORT ?? 3001);
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error('PORT must be an integer between 1 and 65535');
}

function configuredCorsOrigin() {
  const origins = (process.env.SCOUT_CORS_ORIGIN ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (!origins.length) return false;
  return origins.length === 1 ? origins[0] : origins;
}

const app = Fastify({ logger: true, bodyLimit: 1_048_576 });
await app.register(cors, { origin: configuredCorsOrigin() });

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
const service = new ScoutService(db, emit);
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

app.get('/api/health', async () => ({ status: 'ok', service: 'scout', version: '1.0.0', now: nowIso() }));
app.get('/api/ready', async (_request, reply) => {
  const readiness = service.readiness();
  return reply.code(readiness.status === 'ready' ? 200 : 503).send(readiness);
});
app.get('/api/dashboard', async () => service.dashboard());
app.get('/api/listings', async (request, reply) => {
  const parsed = z.object({ marketplace: marketplaceParam.optional(), q: z.string().max(240).optional() }).strict().safeParse(request.query);
  if (!parsed.success) return reply.code(400).send({ error: 'Invalid listing filters' });
  const query = parsed.data;
  const payload = service.dashboard();
  return { ...payload, listings: payload.listings.filter((listing) => (!query.marketplace || listing.marketplace === query.marketplace) && (!query.q || `${listing.title} ${listing.subtitle}`.toLowerCase().includes(query.q.toLowerCase()))) };
});
app.get('/api/listing-detail', async (request, reply) => {
  const parsed = z.object({ key: z.string().min(3).max(500), watchId: z.string().trim().min(1).max(160).optional() }).safeParse(request.query);
  if (!parsed.success) return reply.code(400).send({ error: 'A listing key is required' });
  return service.listingDetail(parsed.data.key, parsed.data.watchId);
});
app.post('/api/ai/normalize-listing', async (request, reply) => {
  const parsed = z.object({ key: z.string().min(3).max(500), force: z.boolean().optional().default(false) }).strict().safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: 'A valid listing key is required' });
  return service.normalizeListingByKey(parsed.data.key, parsed.data.force);
});
app.get('/api/messages', async () => ({ messages: service.messages() }));
app.post('/api/negotiation/recommendation', async (request, reply) => {
  const parsed = z.object({
    key: z.string().min(3).max(500),
    maxTotalCost: z.number().positive().nullable().optional().default(null),
    shippingCost: z.number().nonnegative().optional().default(0),
    otherCosts: z.number().nonnegative().optional().default(0),
  }).strict().safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: 'A valid listing key, maximum total cost, and non-negative known costs are required' });
  const { key, maxTotalCost, shippingCost, otherCosts } = parsed.data;
  return service.recommendNegotiationPriceByKey(key, maxTotalCost, shippingCost, otherCosts);
});
app.post('/api/ai/negotiate', async (request, reply) => {
  const parsed = z.object({
    key: z.string().min(3).max(500),
    offerPrice: z.number().positive().nullable().optional().default(null),
    maxTotalCost: z.number().positive().nullable().optional().default(null),
    shippingCost: z.number().nonnegative().optional().default(0),
    otherCosts: z.number().nonnegative().optional().default(0),
  }).strict().safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: 'A valid listing key and optional opening offer are required' });
  const budget = parsed.data.maxTotalCost === null ? undefined : { maxTotalCost: parsed.data.maxTotalCost, shippingCost: parsed.data.shippingCost, otherCosts: parsed.data.otherCosts };
  return reply.code(201).send(await service.negotiateAndSendByKey(parsed.data.key, parsed.data.offerPrice, budget));
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
}).strict();
app.patch('/api/listing-actions', async (request, reply) => {
  const parsed = listingActionInput.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: 'Invalid listing action', details: parsed.error.flatten() });
  return { action: service.updateListingAction(parsed.data.key, parsed.data.decision, parsed.data.note) };
});
app.get('/api/watches', async (request, reply) => {
  const parsed = z.object({ includeArchived: z.coerce.boolean().optional().default(false) }).strict().safeParse(request.query);
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
app.get('/api/connectors', async () => ({ connectors: service.getConnectors() }));
app.get('/api/notifications', async () => ({ notifications: service.notifications() }));
app.get('/api/connector-runs', async () => ({ runs: service.connectorRuns() }));
app.get('/api/settings', async () => service.settings());
app.get('/api/marketplace-sessions', async () => ({ sessions: service.marketplaceSessions() }));

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
  exactUrls: z.array(z.string().url()).max(20).optional().default([]),
  sensitivity: z.number().min(0.6).max(1.6).optional().default(1),
  shippingOnly: z.boolean().optional().default(false),
  aiRelevance: z.boolean().optional().default(true),
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
  const id = value.id ?? `watch-${randomUUID()}`;
  const now = nowIso();
  db.prepare('INSERT INTO watches (id, name, query, included_terms, excluded_terms, location, condition, sources_json, exact_urls_json, interval_minutes, sensitivity, shipping_only, ai_relevance, min_price_pln, max_price_pln, enabled, next_scan_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, value.name, value.query, value.terms, value.excluded, value.location, value.condition, JSON.stringify(value.sources), JSON.stringify(value.exactUrls), value.interval, value.sensitivity, value.shippingOnly ? 1 : 0, value.aiRelevance ? 1 : 0, value.minPrice, value.maxPrice, 1, now, now, now);
  emit('watch', { id, name: value.name });
  const created = service.getWatches().find((watch) => watch.id === id);
  return reply.code(201).send({ watch: created });
});

app.patch('/api/watches/:id', async (request, reply) => {
  const params = resourceIdParams.safeParse(request.params);
  if (!params.success) return reply.code(400).send({ error: 'A valid watch id is required' });
  const patchInput = z.object({
    enabled: z.boolean().optional(), interval: z.number().int().min(5).max(1440).optional(), shippingOnly: z.boolean().optional(),
    aiRelevance: z.boolean().optional(),
    archived: z.boolean().optional(),
    minPrice: z.number().nonnegative().nullable().optional(), maxPrice: z.number().positive().nullable().optional(),
  }).strict().safeParse(request.body);
  if (!patchInput.success) return reply.code(400).send({ error: 'Invalid watch update', details: patchInput.error.flatten() });
  const body = patchInput.data;
  if (body.interval !== undefined && (!Number.isInteger(body.interval) || body.interval < 5 || body.interval > 1440)) return reply.code(400).send({ error: 'Interval must be between 5 and 1440 minutes' });
  const current = db.prepare('SELECT min_price_pln, max_price_pln FROM watches WHERE id = ?').get(params.data.id) as { min_price_pln: number | null; max_price_pln: number | null } | undefined;
  if (!current) return reply.code(404).send({ error: 'Watch not found' });
  const nextMin = body.minPrice === undefined ? current.min_price_pln : body.minPrice;
  const nextMax = body.maxPrice === undefined ? current.max_price_pln : body.maxPrice;
  if (nextMin !== null && nextMax !== null && nextMin > nextMax) return reply.code(400).send({ error: 'Minimum price cannot exceed maximum price' });
  const fields: string[] = [];
  const values: unknown[] = [];
  if (typeof body.enabled === 'boolean') { fields.push('enabled = ?'); values.push(body.enabled ? 1 : 0); }
  if (body.interval !== undefined) { fields.push('interval_minutes = ?'); values.push(body.interval); }
  if (typeof body.shippingOnly === 'boolean') { fields.push('shipping_only = ?'); values.push(body.shippingOnly ? 1 : 0); }
  if (typeof body.aiRelevance === 'boolean') { fields.push('ai_relevance = ?'); values.push(body.aiRelevance ? 1 : 0); }
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
  aiRelevance: z.boolean().optional().default(true),
  condition: z.string().max(80).optional().default('Any'),
  location: z.string().max(120).optional().default(''),
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
  const watch = service.createMarketWatch({ id, name: value.name, query: value.query, terms: value.terms, excluded: value.excluded, location: value.location, condition: value.condition, sources: value.sources, intervalHours: value.intervalHours, minPrice: value.minPrice, maxPrice: value.maxPrice, shippingOnly: value.shippingOnly });
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
  autoNegotiation: z.object({
    enabled: z.boolean().optional(),
    maxTotalCost: z.number().positive().nullable().optional(),
    shippingCost: z.number().nonnegative().optional(),
    otherCosts: z.number().nonnegative().optional(),
    minimumDiscountPercent: z.number().min(18).max(80).optional(),
    openingDiscountPercent: z.number().min(1).max(50).optional(),
    dailyLimit: z.number().int().min(1).max(50).optional(),
  }).strict().optional(),
}).strict();

app.patch('/api/settings', async (request, reply) => {
  const parsed = settingsInput.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: 'Invalid settings', details: parsed.error.flatten() });
  return service.saveSettings(parsed.data);
});

app.post('/api/settings/webhook/test', async () => service.testWebhook());
app.post('/api/settings/ntfy/test', async () => service.testNtfy());

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

app.get('/events', async (request, reply) => {
  reply.hijack();
  const response = reply.raw;
  response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  response.write(`event: ready\ndata: ${JSON.stringify({ now: nowIso() })}\n\n`);
  const client = { write: (chunk: string) => response.write(chunk), end: () => response.end() };
  clients.add(client);
  request.raw.on('close', () => clients.delete(client));
});

const distPath = resolve(process.cwd(), 'dist');
if (existsSync(distPath)) {
  await app.register(fastifyStatic, { root: distPath, wildcard: false });
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api') || request.url === '/events') return reply.code(404).send({ error: 'Not found' });
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

const host = process.env.SCOUT_HOST?.trim() || (process.env.NODE_ENV === 'production' ? '127.0.0.1' : '0.0.0.0');
app.addHook('onClose', async () => { clearInterval(scheduler); clearInterval(sseHeartbeat); for (const client of clients) client.end(); db.close(); });
let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'Shutting down');
  await app.close();
};
process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
process.once('SIGINT', () => { void shutdown('SIGINT'); });
await app.listen({ port, host });
service.schedulerTick();
