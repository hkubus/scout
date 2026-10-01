import Fastify, { type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { listings as seedListings, watches as seedWatches } from '../src/data';
import type { Marketplace } from '../src/types';
import { validateSearchUrl } from './marketplaces';
import { debugApiEnabled, ScoutDebug } from './debug';
import { backupDatabase, openDatabase, seedDatabase, startWalCheckpointer } from './db';
import { buildDiscordEmbed } from './notifications';
import { compressApiResponse } from './compression';
import { apiTokenCredentialId, bearerToken, clearedSessionCookie, isProtectedRoute, isSameOriginRequest, loadAuthConfig, matchesApiToken, parseCookies, SESSION_COOKIE, sessionCookie, SessionStore, trustProxySetting, verifyPassword } from './auth';
import { isAllowedHost, isCrossSiteBrowserRequest, isPubliclyBoundHost, RateLimiter, rateLimitKey, secretProblem, securityHeaders } from './security';
import { dashboardTopParam, NO_LOCATION_FILTER, normalizeSourceIntervals, olxCategoryToJson, ScoutService, ServiceError } from './service';
import { fetchDiscardSummary } from './fetch-diagnostics';
import { parseVariantGroups } from './variants';

const port = Number(process.env.PORT ?? 3001);
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error('PORT must be an integer between 1 and 65535');
}

const host = process.env.SCOUT_HOST?.trim() || '127.0.0.1';
const publicExposureWarning = isPubliclyBoundHost(host);
// A trusted proxy or a public origin means a reverse proxy publishes Scout even
// though it listens on loopback, so it must fail closed like a public bind.
const trustProxyRaw = process.env.SCOUT_TRUST_PROXY?.trim() ?? '';
const proxied = (trustProxyRaw !== '' && trustProxyRaw.toLowerCase() !== 'false') || Boolean(process.env.SCOUT_PUBLIC_ORIGIN?.trim());
const auth = await loadAuthConfig(process.env, { publiclyBound: publicExposureWarning, proxied });
const configuredSecret = process.env.SCOUT_SECRET?.trim() ?? '';
if (process.env.NODE_ENV === 'production' || publicExposureWarning || proxied || auth.enabled) {
  const problem = secretProblem(configuredSecret);
  if (problem) throw new Error(`SCOUT_SECRET ${problem}; generate one with \`openssl rand -hex 32\` before exposing Scout`);
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
  return origins;
}

function configuredPublicOrigin() {
  const raw = process.env.SCOUT_PUBLIC_ORIGIN?.trim();
  if (!raw) return [];
  let parsed: URL;
  try { parsed = new URL(raw); } catch { throw new Error('SCOUT_PUBLIC_ORIGIN must be a valid HTTP(S) origin'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.username || parsed.password) {
    throw new Error('SCOUT_PUBLIC_ORIGIN must be an HTTP(S) origin without credentials or paths');
  }
  return [parsed.origin];
}

const corsOrigins = configuredCorsOrigin();
const publicOrigins = configuredPublicOrigin();
// Origins, besides the request's own origin, allowed to make cookie-authenticated
// state changes. SCOUT_CORS_ORIGIN is deliberately excluded: SameSite=Strict
// cookies never reach a cross-site frontend, which must use a bearer token.
const trustedOrigins = publicOrigins;
// An https public origin means TLS terminates in front of Scout, so mark
// cookies Secure and send HSTS even if the proxy hop is not trusted.
const publicOriginIsHttps = publicOrigins.some((origin) => origin.startsWith('https:'));
const isSecureRequest = (request: FastifyRequest) => request.protocol === 'https' || publicOriginIsHttps;
const sameOrigin = (request: FastifyRequest) => isSameOriginRequest(request.headers, `${request.protocol}://${request.host}`, trustedOrigins);
// Named hosts accepted in the Host header while auth is off (IP literals and
// localhost always are); anything else is a DNS-rebinding attempt.
const allowedHostNames = [
  ...publicOrigins.map((origin) => new URL(origin).hostname),
  ...(process.env.SCOUT_ALLOWED_HOSTS ?? '').split(',').map((name) => name.trim()).filter(Boolean),
];
const forwardedHeaders = ['x-forwarded-for', 'forwarded', 'x-forwarded-host', 'x-real-ip', 'cf-connecting-ip'] as const;

declare module 'fastify' {
  interface FastifyRequest {
    scoutAuth: 'disabled' | 'session' | 'token' | 'none';
  }
}

const trustProxy = trustProxySetting(process.env.SCOUT_TRUST_PROXY);
// requestTimeout bounds how long a client may take to send a request, so
// trickled bodies cannot hold sockets open forever (handlers are unaffected).
const app = Fastify({ logger: true, bodyLimit: 1_048_576, trustProxy, requestTimeout: 60_000 });
if (trustProxy === true) app.log.warn('SCOUT_TRUST_PROXY=true trusts X-Forwarded-For from any client, so per-IP limits can be spoofed; prefer a hop count or the proxy address');
await app.register(cors, { origin: corsOrigins.length === 0 ? false : corsOrigins.length === 1 ? corsOrigins[0] : corsOrigins });
app.decorateRequest('scoutAuth', 'none');

const rateLimiter = new RateLimiter();
let untrustedForwardWarned = false;
app.addHook('onRequest', async (request, reply) => {
  // request.ip equals the socket peer only when the forwarding hop was not
  // trusted, which also catches a SCOUT_TRUST_PROXY value that does not match
  // the proxy (e.g. 127.0.0.1 under Docker, where the proxy is a bridge IP).
  if (!untrustedForwardWarned && request.headers['x-forwarded-for'] && request.ip === request.socket.remoteAddress) {
    untrustedForwardWarned = true;
    app.log.warn({ peer: request.socket.remoteAddress }, trustProxy === false
      ? 'Received X-Forwarded-For but SCOUT_TRUST_PROXY is unset: every client shares the proxy address for rate limits and HTTPS is not detected'
      : 'Received X-Forwarded-For from a peer SCOUT_TRUST_PROXY does not trust: every client shares that address for rate limits. Under Docker Compose use SCOUT_TRUST_PROXY=uniquelocal');
  }
  const route = request.routeOptions.url;
  if (!isProtectedRoute(route)) return;

  const expensive = route === '/mcp' || /\/search$|\/categories$|\/scan$|\/scans$|\/compare-verification$|\/snapshot$|\/trend$|\/analytics$|\/listing-detail$|\/market-watches$|\/export$|\/settings\/(?:webhook|ntfy)\/test$|\/settings\/ai\/reset$|\/backup$|\/system\/update$/.test(route);
  const limit = expensive ? 30 : 240;
  // Snapshot images use the general limit so a screen of saved photos loads.
  // Key on the route template, not the raw URL, so ids cannot mint new buckets.
  const bucket = rateLimiter.consume(`${rateLimitKey(request.ip)}:${expensive ? 'expensive' : `${request.method} ${route}`}`, limit);
  reply.header('X-RateLimit-Limit', String(limit));
  reply.header('X-RateLimit-Remaining', String(bucket.remaining));
  if (!bucket.allowed) {
    reply.header('Retry-After', String(bucket.retryAfterSeconds));
    return reply.code(429).send({ error: 'Too many requests. Try again later.' });
  }
});
// Compress large /api/* JSON bodies for clients that accept br or gzip.
app.addHook('onSend', compressApiResponse);
app.addHook('onSend', async (request, reply) => {
  // request.protocol honours X-Forwarded-Proto only from SCOUT_TRUST_PROXY hops.
  // Keep a stricter per-route policy (e.g. the sandboxed snapshot-image CSP).
  for (const [name, value] of Object.entries(securityHeaders(isSecureRequest(request)))) if (!reply.hasHeader(name)) reply.header(name, value);
  if (request.routeOptions.url?.startsWith('/api/') && !reply.hasHeader('cache-control')) reply.header('cache-control', 'no-store');
});

const db = openDatabase();
// WAL checkpoints run on a worker thread instead of inside scan commits.
const checkpointer = startWalCheckpointer(db, { onError: (message) => app.log.warn(message) });
if (process.env.SCOUT_SEED_DEMO === 'true') seedDatabase(db, { watches: seedWatches, listings: seedListings });
const sessions = new SessionStore(db, [auth.credentialId, ...auth.tokenCredentialIds]);
if (auth.enabled) sessions.purgeExpired();

// Health/readiness stay public for container probes (details only when
// authenticated); the auth endpoints must be reachable before login.
const publicApiPaths = new Set(['/api/health', '/api/ready', '/api/auth/session', '/api/auth/login', '/api/auth/logout']);
const safeMethods = new Set(['GET', 'HEAD', 'OPTIONS']);

function resolveAuth(request: FastifyRequest): FastifyRequest['scoutAuth'] {
  const token = bearerToken(request.headers.authorization);
  if (token !== null) return matchesApiToken(auth, token) ? 'token' : 'none';
  const cookie = parseCookies(request.headers.cookie).get(SESSION_COOKIE);
  return cookie && sessions.validate(cookie) ? 'session' : 'none';
}

app.addHook('onRequest', async (request, reply) => {
  // Decide on the matched route template, never the raw URL: the router
  // percent-decodes paths, so `/%61pi/...` still reaches `/api/...` handlers.
  // The static SPA shell is public; it holds no data and renders the login form.
  const route = request.routeOptions.url;
  if (!auth.enabled) {
    request.scoutAuth = 'disabled';
    if (!isProtectedRoute(route)) return;
    // Unauthenticated mode is only for direct loopback/LAN access. A request
    // relayed by a reverse proxy means Scout is being published without a
    // password, so refuse it unless SCOUT_AUTH=off accepted that explicitly.
    if (!auth.explicitlyOff && forwardedHeaders.some((name) => request.headers[name] !== undefined)) {
      return reply.code(403).send({ error: 'Scout has no credentials configured and refuses proxied requests. Set SCOUT_PASSWORD_HASH and/or SCOUT_API_TOKENS (or SCOUT_AUTH=off for a trusted network).' });
    }
    // Without credentials any website could reach Scout through DNS rebinding
    // or cross-site form posts, so pin the Host and reject browser cross-site writes.
    if (!isAllowedHost(request.headers.host, allowedHostNames)) {
      return reply.code(403).send({ error: 'Unrecognized Host header. Add this hostname to SCOUT_ALLOWED_HOSTS.' });
    }
    if (!safeMethods.has(request.method) && isCrossSiteBrowserRequest(request.headers, `${request.protocol}://${request.host}`)) {
      return reply.code(403).send({ error: 'Cross-origin request rejected' });
    }
    return;
  }
  if (!isProtectedRoute(route)) return;
  request.scoutAuth = resolveAuth(request);
  if (publicApiPaths.has(route)) return;
  if (request.scoutAuth === 'none') {
    reply.header('WWW-Authenticate', 'Bearer realm="scout"');
    return reply.code(401).send({ error: 'Authentication required' });
  }
  if (request.scoutAuth === 'session' && !safeMethods.has(request.method) && !sameOrigin(request)) {
    return reply.code(403).send({ error: 'Cross-origin request rejected' });
  }
});
const authenticated = (request: FastifyRequest) => request.scoutAuth !== 'none';

// `session` is the cookie token a browser stream was opened with, so revoking
// that session also closes its live stream.
const clients = new Set<{ write: (chunk: string) => void; end: () => void; session?: string }>();
function closeSessionStreams(matches: (session: string) => boolean) {
  for (const client of clients) {
    if (client.session !== undefined && matches(client.session)) {
      clients.delete(client);
      client.end();
    }
  }
}
const nowIso = () => new Date().toISOString();

function emit(event: string, payload: unknown) {
  const message = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of clients) {
    try { client.write(message); } catch { clients.delete(client); }
  }
}
const service = new ScoutService(db, emit, { publicExposureWarning: publicExposureWarning && !auth.enabled, authEnabled: auth.enabled });
const debug = debugApiEnabled(auth.enabled) ? new ScoutDebug(db, service) : null;
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

app.get('/api/health', async (request) => (authenticated(request)
  ? { status: 'ok', service: 'scout', version: process.env.SCOUT_VERSION ?? '1.0.0', now: nowIso(), memory: process.memoryUsage() }
  : { status: 'ok' }));
app.get('/api/ready', async (request, reply) => {
  const readiness = service.readiness();
  return reply.code(readiness.status === 'ready' ? 200 : 503).send(authenticated(request) ? readiness : { status: readiness.status });
});

// Once full of live buckets the login limiter refuses new addresses rather
// than evicting (and so resetting) an attacker's active counter.
const loginLimiter = new RateLimiter(15 * 60_000, 50_000, 'reject');
// Bound concurrent scrypt work instead of a global attempt cap, which would
// let anyone lock the operator out by spending it. Stay below libuv's default
// four-thread pool so password checks cannot stall fs, dns, and zlib work.
const MAX_CONCURRENT_LOGINS = 2;
let loginsInFlight = 0;
app.get('/api/auth/session', async (request) => ({
  authEnabled: auth.enabled,
  authenticated: authenticated(request),
  passwordLogin: Boolean(auth.passwordHash),
  tokenLogin: auth.tokenDigests.length > 0,
}));
// The browser can sign in with the password or with any configured API token;
// either way it gets a cookie session bound to that credential.
app.post('/api/auth/login', async (request, reply) => {
  if (!auth.passwordHash && auth.tokenDigests.length === 0) return reply.code(404).send({ error: 'Sign-in is not configured' });
  if (!sameOrigin(request)) return reply.code(403).send({ error: 'Cross-origin request rejected' });
  const perIp = loginLimiter.consume(`ip:${rateLimitKey(request.ip)}`, 10);
  if (!perIp.allowed) {
    reply.header('Retry-After', String(perIp.retryAfterSeconds));
    return reply.code(429).send({ error: 'Too many sign-in attempts. Try again later.' });
  }
  const parsed = z.object({ password: z.string().min(1).max(1024) }).strict().safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: 'A password is required' });
  let credentialId = apiTokenCredentialId(auth, parsed.data.password);
  const method = credentialId ? 'token' : 'password';
  if (!credentialId && auth.passwordHash) {
    if (loginsInFlight >= MAX_CONCURRENT_LOGINS) {
      reply.header('Retry-After', '1');
      return reply.code(429).send({ error: 'Sign-in is busy. Try again in a moment.' });
    }
    loginsInFlight += 1;
    try {
      if (await verifyPassword(parsed.data.password, auth.passwordHash)) credentialId = auth.credentialId;
    } finally { loginsInFlight -= 1; }
  }
  if (!credentialId) {
    request.log.warn({ ip: request.ip }, 'Failed sign-in attempt');
    const expected = auth.passwordHash && auth.tokenDigests.length > 0 ? 'password or API token' : auth.passwordHash ? 'password' : 'API token';
    return reply.code(401).send({ error: `Incorrect ${expected}` });
  }
  const token = sessions.create({ ip: request.ip, userAgent: request.headers['user-agent'] }, credentialId);
  request.log.info({ ip: request.ip, method }, 'Signed in');
  return reply.header('set-cookie', sessionCookie(token, isSecureRequest(request))).send({ ok: true });
});
app.post('/api/auth/logout', async (request, reply) => {
  const token = parseCookies(request.headers.cookie).get(SESSION_COOKIE);
  if (token) {
    if (!sameOrigin(request)) return reply.code(403).send({ error: 'Cross-origin request rejected' });
    sessions.revoke(token);
    closeSessionStreams((session) => session === token);
  }
  return reply.header('set-cookie', clearedSessionCookie(isSecureRequest(request))).send({ ok: true });
});
app.post('/api/auth/logout-all', async (request, reply) => {
  sessions.revokeAll();
  closeSessionStreams(() => true);
  return reply.header('set-cookie', clearedSessionCookie(isSecureRequest(request))).send({ ok: true });
});
app.get('/api/dashboard', async (request) => {
  // ?top=N (1-50) is the widget's compact form; anything else is ignored and
  // the full dashboard is returned unchanged.
  return service.dashboard({ top: dashboardTopParam((request.query as Record<string, unknown> | undefined)?.top) });
});
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
// Every field is optional: omitted fields keep their stored value, so a
// decision-only swipe cannot wipe the note or unhide the listing.
const listingActionInput = z.object({
  key: z.string().min(3).max(500),
  decision: z.enum(['buy', 'watch', 'pass']).nullable().optional(),
  note: z.string().max(2000).optional(),
  hidden: z.boolean().optional(),
}).strict();
app.patch('/api/listing-actions', async (request, reply) => {
  const parsed = listingActionInput.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: 'Invalid listing action', details: parsed.error.flatten() });
  const { key, ...patch } = parsed.data;
  return { action: service.updateListingAction(key, patch) };
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
app.post('/api/watches/:id/variant-suggestions', async (request, reply) => {
  const params = resourceIdParams.safeParse(request.params);
  if (!params.success) return reply.code(400).send({ error: 'A valid watch id is required' });
  return service.suggestWatchVariantGroups(params.data.id);
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
// Streamed from a read-only snapshot so the export never buffers the database.
// The snapshot opens before any header is set, so an open failure is a plain 500.
app.get('/api/export', async (_request, reply) => {
  const stream = service.exportStream();
  return reply.header('Content-Disposition', `attachment; filename="scout-export-${new Date().toISOString().slice(0, 10)}.json"`).type('application/json').send(stream);
});
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

// Picked from OLX's own facets; the label and path are display-only, so the
// schema only has to keep them bounded and slug-shaped.
const olxCategoryInput = z.object({
  id: z.number().int().positive().max(1_000_000_000),
  label: z.string().trim().min(1).max(120),
  path: z.string().trim().max(240).regex(/^(?:[a-z0-9-]+(?:\/[a-z0-9-]+)*)?$/),
}).strict();

const watchInput = z.object({
  id: z.string().trim().min(1).max(160).optional(),
  name: z.string().trim().min(1).max(120),
  query: z.string().trim().min(1).max(240),
  terms: z.string().max(240).optional().default(''),
  excluded: z.string().max(240).optional().default(''),
  sources: marketplaceSources,
  // Ignored: Scout no longer filters by location. Still accepted so older
  // iOS builds that send it keep working.
  location: z.string().max(120).optional(),
  condition: z.string().max(80).optional().default('Any'),
  interval: z.number().int().min(5).max(24 * 60).optional().default(5),
  sourceIntervals: z.record(z.string(), z.number().int().min(5).max(1440)).optional().default({}),
  exactUrls: z.array(z.string().url()).max(20).optional().default([]),
  sensitivity: z.number().min(0.6).max(1.6).optional().default(1),
  shippingOnly: z.boolean().optional().default(false),
  typoVariants: z.boolean().optional().default(false),
  aiRelevance: z.boolean().optional().default(true),
  variantGroups: variantGroupsInput.optional().default([]),
  variantGroupsAuto: z.boolean().optional().default(true),
  referenceMarketWatchId: z.string().trim().max(160).nullable().optional().default(null),
  minPrice: z.number().nonnegative().nullable().optional().default(null),
  maxPrice: z.number().positive().nullable().optional().default(null),
  olxCategory: olxCategoryInput.nullable().optional().default(null),
  sellerType: z.enum(['private', 'business']).nullable().optional().default(null),
  ignorePromoted: z.boolean().optional().default(false),
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
    db.prepare('INSERT INTO watches (id, name, query, included_terms, excluded_terms, location, condition, sources_json, exact_urls_json, interval_minutes, source_intervals_json, sensitivity, shipping_only, typo_variants, ai_relevance, variant_groups_json, variant_groups_auto, reference_market_watch_id, min_price_pln, max_price_pln, olx_category_json, seller_type, ignore_promoted, enabled, next_scan_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, value.name, value.query, value.terms, value.excluded, NO_LOCATION_FILTER, value.condition, JSON.stringify(value.sources), JSON.stringify(value.exactUrls), value.interval, JSON.stringify(sourceIntervals), value.sensitivity, value.shippingOnly ? 1 : 0, value.typoVariants ? 1 : 0, value.aiRelevance ? 1 : 0, JSON.stringify(value.variantGroups), value.variantGroupsAuto && !value.variantGroups.length ? 1 : 0, value.referenceMarketWatchId, value.minPrice, value.maxPrice, olxCategoryToJson(value.olxCategory), value.sellerType, value.ignorePromoted ? 1 : 0, 1, now, now, now);
  } catch (error) {
    if (error instanceof Error && /UNIQUE|PRIMARY KEY|constraint/i.test(error.message)) {
      return reply.code(409).send({ error: 'A watch with this id already exists' });
    }
    throw error;
  }
  emit('watch', { id, name: value.name });
  const created = service.watchById(id);
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
    variantGroupsAuto: z.boolean().optional(),
    referenceMarketWatchId: z.string().trim().max(160).nullable().optional(),
    archived: z.boolean().optional(),
    minPrice: z.number().nonnegative().nullable().optional(), maxPrice: z.number().positive().nullable().optional(),
    olxCategory: olxCategoryInput.nullable().optional(),
    sellerType: z.enum(['private', 'business']).nullable().optional(),
    ignorePromoted: z.boolean().optional(),
  }).strict().safeParse(request.body);
  if (!patchInput.success) return reply.code(400).send({ error: 'Invalid watch update', details: patchInput.error.flatten() });
  const body = patchInput.data;
  if (body.interval !== undefined && (!Number.isInteger(body.interval) || body.interval < 5 || body.interval > 1440)) return reply.code(400).send({ error: 'Interval must be between 5 and 1440 minutes' });
  const current = db.prepare('SELECT min_price_pln, max_price_pln, sources_json, exact_urls_json, variant_groups_json FROM watches WHERE id = ?').get(params.data.id) as { min_price_pln: number | null; max_price_pln: number | null; sources_json: string; exact_urls_json: string; variant_groups_json: string } | undefined;
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
  if (body.condition !== undefined) { fields.push('condition = ?'); values.push(body.condition); }
  if (body.exactUrls !== undefined) { fields.push('exact_urls_json = ?'); values.push(JSON.stringify(body.exactUrls)); }
  if (body.sensitivity !== undefined) { fields.push('sensitivity = ?'); values.push(body.sensitivity); }
  if (typeof body.enabled === 'boolean') { fields.push('enabled = ?'); values.push(body.enabled ? 1 : 0); }
  if (body.interval !== undefined) { fields.push('interval_minutes = ?'); values.push(body.interval); }
  if (body.sourceIntervals !== undefined) { fields.push('source_intervals_json = ?'); values.push(JSON.stringify(normalizeSourceIntervals(sources, body.sourceIntervals))); }
  if (typeof body.shippingOnly === 'boolean') { fields.push('shipping_only = ?'); values.push(body.shippingOnly ? 1 : 0); }
  if (typeof body.aiRelevance === 'boolean') { fields.push('ai_relevance = ?'); values.push(body.aiRelevance ? 1 : 0); }
  if (typeof body.typoVariants === 'boolean') { fields.push('typo_variants = ?'); values.push(body.typoVariants ? 1 : 0); }
  // The edit dialog always resends the groups, so only a real change counts
  // as the user taking over from automatic generation.
  const groupsChanged = body.variantGroups !== undefined && JSON.stringify(body.variantGroups) !== JSON.stringify(parseVariantGroups(current.variant_groups_json));
  if (groupsChanged) { fields.push('variant_groups_json = ?'); values.push(JSON.stringify(body.variantGroups)); }
  if (body.variantGroupsAuto !== undefined || groupsChanged) {
    const groupsAfter = groupsChanged ? body.variantGroups! : parseVariantGroups(current.variant_groups_json);
    fields.push('variant_groups_auto = ?');
    values.push(body.variantGroupsAuto && !groupsAfter.length ? 1 : 0);
    // A fresh opt-in starts over rather than waiting for the watch to grow.
    if (body.variantGroupsAuto) fields.push('variant_groups_auto_checked = 0');
  }
  if (body.referenceMarketWatchId !== undefined) {
    if (body.referenceMarketWatchId && !db.prepare('SELECT 1 FROM market_watches WHERE id = ?').get(body.referenceMarketWatchId)) {
      return reply.code(400).send({ error: 'Reference research watch not found' });
    }
    fields.push('reference_market_watch_id = ?');
    values.push(body.referenceMarketWatchId);
  }
  if (body.minPrice !== undefined) { fields.push('min_price_pln = ?'); values.push(body.minPrice); }
  if (body.maxPrice !== undefined) { fields.push('max_price_pln = ?'); values.push(body.maxPrice); }
  if (body.olxCategory !== undefined) { fields.push('olx_category_json = ?'); values.push(olxCategoryToJson(body.olxCategory)); }
  if (body.sellerType !== undefined) { fields.push('seller_type = ?'); values.push(body.sellerType); }
  if (typeof body.ignorePromoted === 'boolean') { fields.push('ignore_promoted = ?'); values.push(body.ignorePromoted ? 1 : 0); }
  if (body.archived !== undefined) {
    fields.push('archived_at = ?');
    values.push(body.archived ? nowIso() : null);
    if (body.enabled === undefined) {
      fields.push('enabled = ?');
      values.push(body.archived ? 0 : 1);
    }
  }
  if (!fields.length) {
    // Resending the current groups unchanged is a valid no-op.
    if (body.variantGroups !== undefined) return { ok: true };
    return reply.code(400).send({ error: 'No supported fields' });
  }
  values.push(nowIso(), params.data.id);
  const result = db.prepare(`UPDATE watches SET ${fields.join(', ')}, updated_at = ? WHERE id = ?`).run(...(values as any[]));
  if (!result.changes) return reply.code(404).send({ error: 'Watch not found' });
  // Repartition the watch's saved listings immediately when the model groups
  // change; otherwise the new keys would only converge one scan at a time.
  if (groupsChanged) service.retagWatchVariants(params.data.id);
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
  // Ignored, see watchInput.
  location: z.string().max(120).optional(),
  ownerType: z.enum(['private', 'business']).nullable().optional().default(null),
  olxCategory: olxCategoryInput.nullable().optional().default(null),
  page: z.number().int().min(1).max(10).optional().default(1),
  searchId: z.string().trim().min(1).max(80).optional(),
  aiRelevance: z.boolean().optional().default(true),
}).refine((value) => value.minPrice === null || value.maxPrice === null || value.minPrice <= value.maxPrice, { message: 'Minimum price cannot exceed maximum price', path: ['maxPrice'] });

app.get('/api/marketplaces/olx/categories', async (request, reply) => {
  const parsed = z.object({ query: z.string().trim().min(1).max(240) }).strict().safeParse(request.query);
  if (!parsed.success) return reply.code(400).send({ error: 'A search query is required' });
  return { categories: await service.olxCategories(parsed.data.query) };
});

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
  // Ignored: Scout no longer filters by location. Still accepted so older
  // iOS builds that send it keep working.
  location: z.string().max(120).optional(),
  condition: z.string().max(80).optional().default('Any'),
  sources: marketplaceSources,
  intervalHours: z.number().int().min(6).max(168).optional().default(24),
  minPrice: z.number().nonnegative().nullable().optional().default(null),
  maxPrice: z.number().positive().nullable().optional().default(null),
  shippingOnly: z.boolean().optional().default(false),
  typoVariants: z.boolean().optional().default(false),
  olxCategory: olxCategoryInput.nullable().optional().default(null),
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
  const watch = service.createMarketWatch({ id, name: value.name, query: value.query, terms: value.terms, excluded: value.excluded, condition: value.condition, sources: value.sources, intervalHours: value.intervalHours, minPrice: value.minPrice, maxPrice: value.maxPrice, shippingOnly: value.shippingOnly, typoVariants: value.typoVariants, olxCategory: value.olxCategory });
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
    olxCategory: olxCategoryInput.nullable().optional(),
  }).strict().safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: 'Invalid market watch update', details: parsed.error.flatten() });
  const current = db.prepare('SELECT min_price_pln, max_price_pln FROM market_watches WHERE id = ?').get(params.data.id) as { min_price_pln: number | null; max_price_pln: number | null } | undefined;
  if (!current) return reply.code(404).send({ error: 'Market watch not found' });
  const nextMin = parsed.data.minPrice === undefined ? current.min_price_pln : parsed.data.minPrice;
  const nextMax = parsed.data.maxPrice === undefined ? current.max_price_pln : parsed.data.maxPrice;
  if (nextMin !== null && nextMax !== null && nextMin > nextMax) return reply.code(400).send({ error: 'Minimum price cannot exceed maximum price' });
  const { location: _ignoredLocation, ...patch } = parsed.data;
  return service.updateMarketWatch(params.data.id, patch);
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
    openInApp: z.boolean().optional(),
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
  const session = request.scoutAuth === 'session' ? parseCookies(request.headers.cookie).get(SESSION_COOKIE) : undefined;
  const client = { write: (chunk: string) => response.write(chunk), end: () => response.end(), session };
  clients.add(client);
  request.raw.on('close', () => clients.delete(client));
});

// Scout's MCP server speaks Streamable HTTP (JSON-RPC over POST /mcp) so
// MCP clients connect over HTTP instead of stdio. Stateless per-request
// servers keep every request independent: no session ids, no resumability,
// any replica can serve any call. When auth is enabled, clients send an
// `Authorization: Bearer` token from SCOUT_API_TOKENS.
// The MCP SDK (~40 MB RSS) loads on the first /mcp request, not at startup.
let mcpModules: Promise<[typeof import('./mcp'), typeof import('@modelcontextprotocol/sdk/server/streamableHttp.js')]> | undefined;
app.post('/mcp', async (request, reply) => {
  reply.hijack();
  let modules: Awaited<NonNullable<typeof mcpModules>>;
  try {
    modules = await (mcpModules ??= Promise.all([import('./mcp'), import('@modelcontextprotocol/sdk/server/streamableHttp.js')]));
  } catch (error) {
    mcpModules = undefined;
    app.log.error(error);
    reply.raw.writeHead(500, { 'content-type': 'application/json' });
    reply.raw.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null }));
    return;
  }
  const [{ createScoutMcpServer }, { StreamableHTTPServerTransport }] = modules;
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
  // Vite's content-hashed /assets files are safe to cache for a year; index.html,
  // favicon.svg and the SPA fallback keep revalidating. Build-time .br/.gz
  // siblings (scripts/precompress.mjs) are served in place of the originals and
  // are not exposed as routes of their own.
  const assetsDir = join(resolve(distPath), 'assets') + sep;
  await app.register(fastifyStatic, {
    root: distPath,
    wildcard: false,
    preCompressed: true,
    globIgnore: ['**/*.br', '**/*.gz'],
    setHeaders: (reply, filePath) => {
      if (filePath.startsWith(assetsDir)) reply.header('cache-control', 'public, max-age=31536000, immutable');
    },
  });
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
  // Streams authenticate once at connect, so drop any whose session has since
  // expired or been revoked. isActive() does not extend the idle window.
  if (auth.enabled) closeSessionStreams((session) => !sessions.isActive(session));
  emit('ping', { now: nowIso() });
}, 25_000);
const sessionPurge = setInterval(() => {
  if (auth.enabled) sessions.purgeExpired();
}, 60 * 60_000);

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

// Stop the timers first so no scheduler tick starts a scan (or a Chromium) while
// shutting down; the final closeBrowser refuses relaunches and is time-bounded,
// so the checkpoint and db.close() always run.
app.addHook('onClose', async () => { clearInterval(scheduler); clearInterval(sseHeartbeat); clearInterval(diagnosticsInterval); clearInterval(sessionPurge); debug?.close(); for (const client of clients) client.end(); await service.closeBrowser({ final: true }); await checkpointer?.stop(); try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* best-effort */ } db.close(); });
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
