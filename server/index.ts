import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { listings as seedListings, watches as seedWatches } from '../src/data';
import { validateSearchUrl, type Marketplace } from './marketplaces';
import { openDatabase, seedDatabase } from './db';
import { buildDiscordEmbed } from './notifications';
import { ScoutService, ServiceError } from './service';

const app = Fastify({ logger: true });
await app.register(cors, { origin: true });

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

app.setErrorHandler((error, _request, reply) => {
  if (error instanceof ServiceError) return reply.code(error.status).send({ error: error.message });
  if (error && typeof error === 'object' && 'statusCode' in error && typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 500) {
    const message = 'message' in error && typeof error.message === 'string' ? error.message : 'Invalid request';
    return reply.code(error.statusCode).send({ error: message });
  }
  app.log.error(error);
  return reply.code(500).send({ error: 'Internal server error' });
});

app.get('/api/health', async () => ({ status: 'ok', service: 'scout', version: '1.0.0', database: 'ok', scheduler: 'running', now: nowIso() }));
app.get('/api/dashboard', async () => service.dashboard());
app.get('/api/listings', async (request) => {
  const query = request.query as { marketplace?: Marketplace; q?: string };
  const payload = service.dashboard();
  return { ...payload, listings: payload.listings.filter((listing) => (!query.marketplace || listing.marketplace === query.marketplace) && (!query.q || `${listing.title} ${listing.subtitle}`.toLowerCase().includes(query.q.toLowerCase()))) };
});
app.get('/api/watches', async () => ({ watches: service.getWatches() }));
app.get('/api/connectors', async () => ({ connectors: service.getConnectors() }));
app.get('/api/notifications', async () => ({ notifications: service.notifications() }));
app.get('/api/connector-runs', async () => ({ runs: service.connectorRuns() }));
app.get('/api/settings', async () => service.settings());
const marketplaceParam = z.enum(['OLX', 'Allegro Lokalnie', 'Vinted']);
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
  id: z.string().min(1).optional(),
  name: z.string().min(1).max(120),
  query: z.string().min(1).max(240),
  terms: z.string().max(240).optional().default(''),
  excluded: z.string().max(240).optional().default(''),
  sources: z.array(z.enum(['OLX', 'Allegro Lokalnie', 'Vinted'])).min(1),
  location: z.string().max(120).optional().default('Polska'),
  condition: z.string().max(80).optional().default('Any'),
  interval: z.number().int().min(5).max(24 * 60).optional().default(5),
  exactUrls: z.array(z.string().url()).optional().default([]),
  sensitivity: z.number().min(0.6).max(1.6).optional().default(1),
  shippingOnly: z.boolean().optional().default(false),
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
  const id = value.id ?? `watch-${Date.now()}`;
  const now = nowIso();
  db.prepare('INSERT INTO watches (id, name, query, included_terms, excluded_terms, location, condition, sources_json, exact_urls_json, interval_minutes, sensitivity, shipping_only, min_price_pln, max_price_pln, enabled, next_scan_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, value.name, value.query, value.terms, value.excluded, value.location, value.condition, JSON.stringify(value.sources), JSON.stringify(value.exactUrls), value.interval, value.sensitivity, value.shippingOnly ? 1 : 0, value.minPrice, value.maxPrice, 1, now, now, now);
  emit('watch', { id, name: value.name });
  const created = service.getWatches().find((watch) => watch.id === id);
  return reply.code(201).send({ watch: created });
});

app.patch('/api/watches/:id', async (request, reply) => {
  const params = request.params as { id: string };
  const patchInput = z.object({
    enabled: z.boolean().optional(), interval: z.number().int().min(5).max(1440).optional(), shippingOnly: z.boolean().optional(),
    minPrice: z.number().nonnegative().nullable().optional(), maxPrice: z.number().positive().nullable().optional(),
  }).strict().safeParse(request.body);
  if (!patchInput.success) return reply.code(400).send({ error: 'Invalid watch update', details: patchInput.error.flatten() });
  const body = patchInput.data;
  if (body.interval !== undefined && (!Number.isInteger(body.interval) || body.interval < 5 || body.interval > 1440)) return reply.code(400).send({ error: 'Interval must be between 5 and 1440 minutes' });
  const current = db.prepare('SELECT min_price_pln, max_price_pln FROM watches WHERE id = ?').get(params.id) as { min_price_pln: number | null; max_price_pln: number | null } | undefined;
  if (!current) return reply.code(404).send({ error: 'Watch not found' });
  const nextMin = body.minPrice === undefined ? current.min_price_pln : body.minPrice;
  const nextMax = body.maxPrice === undefined ? current.max_price_pln : body.maxPrice;
  if (nextMin !== null && nextMax !== null && nextMin > nextMax) return reply.code(400).send({ error: 'Minimum price cannot exceed maximum price' });
  const fields: string[] = [];
  const values: unknown[] = [];
  if (typeof body.enabled === 'boolean') { fields.push('enabled = ?'); values.push(body.enabled ? 1 : 0); }
  if (body.interval !== undefined) { fields.push('interval_minutes = ?'); values.push(body.interval); }
  if (typeof body.shippingOnly === 'boolean') { fields.push('shipping_only = ?'); values.push(body.shippingOnly ? 1 : 0); }
  if (body.minPrice !== undefined) { fields.push('min_price_pln = ?'); values.push(body.minPrice); }
  if (body.maxPrice !== undefined) { fields.push('max_price_pln = ?'); values.push(body.maxPrice); }
  if (!fields.length) return reply.code(400).send({ error: 'No supported fields' });
  values.push(nowIso(), params.id);
  const result = db.prepare(`UPDATE watches SET ${fields.join(', ')}, updated_at = ? WHERE id = ?`).run(...(values as any[]));
  if (!result.changes) return reply.code(404).send({ error: 'Watch not found' });
  return { ok: true };
});

const searchInput = z.object({
  query: z.string().trim().min(1).max(240),
  terms: z.string().max(240).optional().default(''),
  excluded: z.string().max(240).optional().default(''),
  sources: z.array(z.enum(['OLX', 'Allegro Lokalnie', 'Vinted'])).min(1),
  minPrice: z.number().nonnegative().nullable().optional().default(null),
  maxPrice: z.number().positive().nullable().optional().default(null),
  shippingOnly: z.boolean().optional().default(false),
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
  sources: z.array(z.enum(['OLX', 'Allegro Lokalnie', 'Vinted'])).min(1),
  intervalHours: z.number().int().min(6).max(168).optional().default(24),
  minPrice: z.number().nonnegative().nullable().optional().default(null),
  maxPrice: z.number().positive().nullable().optional().default(null),
  shippingOnly: z.boolean().optional().default(false),
}).refine((value) => value.minPrice === null || value.maxPrice === null || value.minPrice <= value.maxPrice, { message: 'Minimum price cannot exceed maximum price', path: ['maxPrice'] });

app.get('/api/market-watches', async () => service.marketResearch());

app.post('/api/market-watches', async (request, reply) => {
  const parsed = marketWatchInput.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: 'Invalid market watch', details: parsed.error.flatten() });
  const value = parsed.data;
  const id = `market-watch-${Date.now()}`;
  const now = nowIso();
  db.prepare('INSERT INTO market_watches (id, name, query, included_terms, excluded_terms, location, condition, sources_json, interval_hours, min_price_pln, max_price_pln, shipping_only, enabled, next_scan_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)').run(id, value.name, value.query, value.terms, value.excluded, value.location, value.condition, JSON.stringify(value.sources), value.intervalHours, value.minPrice, value.maxPrice, value.shippingOnly ? 1 : 0, now, now, now);
  const watch = service.marketResearch().watches.find((item) => item.id === id)!;
  service.queueMarketScan(id);
  emit('market-watch', { refresh: true, id });
  return reply.code(201).send({ watch });
});

app.patch('/api/market-watches/:id', async (request, reply) => {
  const params = request.params as { id: string };
  const parsed = z.object({
    name: z.string().trim().min(1).max(120).optional(),
    query: z.string().trim().min(1).max(240).optional(),
    enabled: z.boolean().optional(),
    intervalHours: z.number().int().min(6).max(168).optional(),
    terms: z.string().max(240).optional(),
    excluded: z.string().max(240).optional(),
    location: z.string().max(120).optional(),
    condition: z.string().max(80).optional(),
    sources: z.array(z.enum(['OLX', 'Allegro Lokalnie', 'Vinted'])).min(1).optional(),
    minPrice: z.number().nonnegative().nullable().optional(),
    maxPrice: z.number().positive().nullable().optional(),
    shippingOnly: z.boolean().optional(),
  }).strict().safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: 'Invalid market watch update', details: parsed.error.flatten() });
  const current = db.prepare('SELECT min_price_pln, max_price_pln FROM market_watches WHERE id = ?').get(params.id) as { min_price_pln: number | null; max_price_pln: number | null } | undefined;
  if (!current) return reply.code(404).send({ error: 'Market watch not found' });
  const nextMin = parsed.data.minPrice === undefined ? current.min_price_pln : parsed.data.minPrice;
  const nextMax = parsed.data.maxPrice === undefined ? current.max_price_pln : parsed.data.maxPrice;
  if (nextMin !== null && nextMax !== null && nextMin > nextMax) return reply.code(400).send({ error: 'Minimum price cannot exceed maximum price' });
  const fields: string[] = [];
  const values: unknown[] = [];
  if (parsed.data.name !== undefined) { fields.push('name = ?'); values.push(parsed.data.name); }
  if (parsed.data.query !== undefined) { fields.push('query = ?'); values.push(parsed.data.query); }
  if (parsed.data.enabled !== undefined) { fields.push('enabled = ?'); values.push(parsed.data.enabled ? 1 : 0); }
  if (parsed.data.intervalHours !== undefined) { fields.push('interval_hours = ?'); values.push(parsed.data.intervalHours); }
  if (parsed.data.terms !== undefined) { fields.push('included_terms = ?'); values.push(parsed.data.terms); }
  if (parsed.data.excluded !== undefined) { fields.push('excluded_terms = ?'); values.push(parsed.data.excluded); }
  if (parsed.data.location !== undefined) { fields.push('location = ?'); values.push(parsed.data.location); }
  if (parsed.data.condition !== undefined) { fields.push('condition = ?'); values.push(parsed.data.condition); }
  if (parsed.data.sources !== undefined) { fields.push('sources_json = ?'); values.push(JSON.stringify(parsed.data.sources)); }
  if (parsed.data.minPrice !== undefined) { fields.push('min_price_pln = ?'); values.push(parsed.data.minPrice); }
  if (parsed.data.maxPrice !== undefined) { fields.push('max_price_pln = ?'); values.push(parsed.data.maxPrice); }
  if (parsed.data.shippingOnly !== undefined) { fields.push('shipping_only = ?'); values.push(parsed.data.shippingOnly ? 1 : 0); }
  if (!fields.length) return reply.code(400).send({ error: 'No supported fields' });
  values.push(nowIso(), params.id);
  const result = db.prepare(`UPDATE market_watches SET ${fields.join(', ')}, updated_at = ? WHERE id = ?`).run(...(values as any[]));
  if (!result.changes) return reply.code(404).send({ error: 'Market watch not found' });
  emit('market-watch', { refresh: true, id: params.id });
  return { ok: true };
});

app.post('/api/market-watches/:id/scan', async (request, reply) => reply.code(202).send(service.queueMarketScan((request.params as { id: string }).id)));

app.delete('/api/market-watches/:id', async (request) => {
  service.deleteMarketWatch((request.params as { id: string }).id);
  emit('market-watch', { refresh: true });
  return { ok: true };
});

app.delete('/api/watches/:id', async (request) => {
  service.deleteWatch((request.params as { id: string }).id);
  emit('watch', { refresh: true });
  return { ok: true };
});

app.post('/api/scans', async (request, reply) => {
  const body = (request.body ?? {}) as { watchId?: string };
  return reply.code(202).send(service.queueScan(body.watchId));
});

app.patch('/api/settings', async (request) => service.saveSettings(request.body as { interval?: number; webhook?: string; clearWebhook?: boolean }));

app.post('/api/settings/webhook/test', async () => service.testWebhook());

app.post('/api/notifications/preview', async (request, reply) => {
  const body = request.body as { marketplace?: Marketplace; listingId?: string; title?: string; price?: number; typical?: number; url?: string };
  if (!body.marketplace || !body.listingId || !body.title || !body.url || !body.price || !body.typical) return reply.code(400).send({ error: 'Listing fields are required' });
  const discount = ((body.typical - body.price) / body.typical) * 100;
  return buildDiscordEmbed({ listing: { marketplace: body.marketplace, listingId: body.listingId, title: body.title, price: body.price, currency: 'PLN', url: body.url, observedAt: nowIso() }, typical: body.typical, discountPercent: discount, confidence: 92 });
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
    return reply.sendFile('index.html');
  });
}

const scheduler = setInterval(() => {
  service.queueDue();
}, 30_000);

const port = Number(process.env.PORT ?? 3001);
app.addHook('onClose', async () => { clearInterval(scheduler); for (const client of clients) client.end(); db.close(); });
await app.listen({ port, host: '0.0.0.0' });
