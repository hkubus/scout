import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { openDatabase } from '../server/db';
import { CODE_TTL_MS, CONNECTED_APP_TOKEN_PREFIX, MAX_CLIENTS, OAuthError, OAuthStore, registerOAuthRoutes } from '../server/oauth';

const REDIRECT = 'https://hatbot.example/settings/plugins/scout';
const registration = (overrides: Record<string, unknown> = {}) => ({
  client_name: 'Hatbot',
  redirect_uris: [REDIRECT],
  grant_types: ['authorization_code'],
  response_types: ['code'],
  token_endpoint_auth_method: 'none',
  ...overrides,
});
const pkce = () => {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};
const authorizeParams = (clientId: string, challenge: string, overrides: Record<string, string> = {}) => ({
  response_type: 'code',
  client_id: clientId,
  redirect_uri: REDIRECT,
  state: 'state-123',
  code_challenge: challenge,
  code_challenge_method: 'S256',
  ...overrides,
});

function storeFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'scout-oauth-store-'));
  const db = openDatabase(join(directory, 'scout.sqlite'));
  const store = new OAuthStore(db);
  return { db, store, cleanup: () => { db.close(); rmSync(directory, { recursive: true, force: true }); } };
}

async function appFixture() {
  const context = storeFixture();
  const app = Fastify();
  await registerOAuthRoutes(app, { store: context.store, sendPage: (reply) => reply.type('text/html').send('<!doctype html>'), canConsent: () => true });
  await app.ready();
  return { ...context, app, cleanup: async () => { await app.close(); context.cleanup(); } };
}

/** Register, press Allow, and return the code from the redirect. */
async function allow(app: Awaited<ReturnType<typeof appFixture>>['app'], clientId: string, challenge: string) {
  const response = await app.inject({ method: 'POST', url: '/oauth/authorize', payload: new URLSearchParams({ ...authorizeParams(clientId, challenge), decision: 'allow' }).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.equal(response.statusCode, 302);
  const location = new URL(String(response.headers.location));
  return location.searchParams.get('code')!;
}

const tokenForm = (clientId: string, code: string, verifier: string, overrides: Record<string, string> = {}) => ({
  method: 'POST' as const,
  url: '/oauth/token',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  payload: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier, ...overrides }).toString(),
});

test('serves metadata for the origin the request came in on', async () => {
  const { app, cleanup } = await appFixture();
  try {
    const server = await app.inject({ url: '/.well-known/oauth-authorization-server', headers: { host: 'scout.lan:3001' } });
    assert.deepEqual(server.json(), {
      issuer: 'http://scout.lan:3001',
      authorization_endpoint: 'http://scout.lan:3001/oauth/authorize',
      token_endpoint: 'http://scout.lan:3001/oauth/token',
      registration_endpoint: 'http://scout.lan:3001/oauth/register',
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
    });
    const resource = await app.inject({ url: '/.well-known/oauth-protected-resource', headers: { host: '192.168.1.5:3001' } });
    assert.deepEqual(resource.json(), { resource: 'http://192.168.1.5:3001/mcp', authorization_servers: ['http://192.168.1.5:3001'] });
  } finally {
    await cleanup();
  }
});

test('registers public clients with http(s) redirect URIs and refuses the rest', async () => {
  const { app, cleanup } = await appFixture();
  try {
    const created = await app.inject({ method: 'POST', url: '/oauth/register', payload: registration() });
    assert.equal(created.statusCode, 201);
    const body = created.json();
    assert.deepEqual(Object.keys(body).sort(), ['client_id', 'client_name', 'redirect_uris']);
    assert.equal(body.client_name, 'Hatbot');
    assert.deepEqual(body.redirect_uris, [REDIRECT]);
    assert.match(body.client_id, /^[A-Za-z0-9_-]{20,}$/);
    for (const [uris, error] of [
      [['https://hatbot.example/back#frag'], 'invalid_redirect_uri'],
      [['javascript:alert(1)'], 'invalid_redirect_uri'],
      [['hatbot://settings'], 'invalid_redirect_uri'],
      [['https://user:pw@hatbot.example/'], 'invalid_redirect_uri'],
      [[], 'invalid_redirect_uri'],
    ] as const) {
      const refused = await app.inject({ method: 'POST', url: '/oauth/register', payload: registration({ redirect_uris: uris }) });
      assert.equal(refused.statusCode, 400, JSON.stringify(uris));
      assert.equal(refused.json().error, error);
      assert.equal(typeof refused.json().error_description, 'string');
    }
    const confidential = await app.inject({ method: 'POST', url: '/oauth/register', payload: registration({ token_endpoint_auth_method: 'client_secret_basic' }) });
    assert.equal(confidential.json().error, 'invalid_client_metadata');
  } finally {
    await cleanup();
  }
});

test('caps registered apps, dropping ones that hold no token', () => {
  const { store, cleanup } = storeFixture();
  try {
    const t0 = Date.parse('2026-10-25T08:00:00Z');
    const stale = store.register(registration(), t0);
    const fresh = store.register(registration(), t0 + 25 * 60 * 60_000);
    assert.equal(store.client(stale.id), null, 'a day without a token drops it');
    assert.ok(store.client(fresh.id));
    // Fill the cap with apps that hold tokens; a tokenless one makes way for a newcomer.
    const later = t0 + 26 * 60 * 60_000;
    const connected: string[] = [];
    for (let index = 0; index < MAX_CLIENTS - 1; index += 1) {
      const client = store.register(registration(), later);
      const { verifier, challenge } = pkce();
      const code = store.createCode(store.authorization(authorizeParams(client.id, challenge)), later);
      store.exchange({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: client.id, code_verifier: verifier }, later);
      connected.push(client.id);
    }
    const newcomer = store.register(registration(), later);
    assert.equal(store.client(fresh.id), null, 'the oldest tokenless app made room');
    assert.ok(store.client(newcomer.id));
    const { verifier, challenge } = pkce();
    const code = store.createCode(store.authorization(authorizeParams(newcomer.id, challenge)), later);
    store.exchange({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: newcomer.id, code_verifier: verifier }, later);
    assert.throws(() => store.register(registration(), later), (error: unknown) => error instanceof OAuthError && error.code === 'invalid_client_metadata');
    assert.ok(connected.every((id) => store.client(id)), 'apps with tokens are never dropped');
  } finally {
    cleanup();
  }
});

test('the consent page and Allow accept only a redirect_uri registered for that client', async () => {
  const { app, cleanup } = await appFixture();
  try {
    const client = (await app.inject({ method: 'POST', url: '/oauth/register', payload: registration() })).json();
    const other = (await app.inject({ method: 'POST', url: '/oauth/register', payload: registration({ redirect_uris: ['https://other.example/cb'] }) })).json();
    const { challenge } = pkce();
    const good = new URLSearchParams(authorizeParams(client.client_id, challenge));

    // Allow: the page names the app and where it goes back to, and its CSP lets the form follow the 302.
    const page = await app.inject({ url: `/oauth/authorize?${good}` });
    assert.equal(page.statusCode, 200);
    assert.match(String(page.headers['content-security-policy']), /form-action 'self' https:\/\/hatbot\.example;/);
    const details = await app.inject({ url: `/api/oauth/authorize?${good}` });
    assert.deepEqual(details.json(), { clientName: 'Hatbot', redirectOrigin: 'https://hatbot.example' });
    const allowed = await app.inject({ method: 'POST', url: '/oauth/authorize', payload: `${good}&decision=allow`, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    assert.equal(allowed.statusCode, 302);
    const location = new URL(String(allowed.headers.location));
    assert.equal(`${location.origin}${location.pathname}`, REDIRECT);
    assert.match(location.searchParams.get('code') ?? '', /^[A-Za-z0-9_-]{43}$/);
    assert.equal(location.searchParams.get('state'), 'state-123');
    const cancelled = await app.inject({ method: 'POST', url: '/oauth/authorize', payload: `${good}&decision=deny`, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    assert.equal(cancelled.statusCode, 302);
    assert.equal(cancelled.headers.location, `${REDIRECT}?error=access_denied&state=state-123`);

    // Refuse: a redirect_uri the client didn't register, even another client's, redirects nowhere.
    for (const redirect of ['https://evil.example/steal', `${REDIRECT}/`, `${REDIRECT}?x=1`, 'https://other.example/cb']) {
      const bad = new URLSearchParams(authorizeParams(client.client_id, challenge, { redirect_uri: redirect }));
      const badPage = await app.inject({ url: `/oauth/authorize?${bad}` });
      assert.equal(badPage.statusCode, 200, 'the page still renders, to show the error');
      assert.equal(badPage.headers['content-security-policy'], undefined, 'no extra form target');
      const badDetails = await app.inject({ url: `/api/oauth/authorize?${bad}` });
      assert.equal(badDetails.statusCode, 400);
      assert.match(badDetails.json().error, /didn't register/);
      for (const decision of ['allow', 'deny']) {
        const posted = await app.inject({ method: 'POST', url: '/oauth/authorize', payload: `${bad}&decision=${decision}`, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
        assert.equal(posted.statusCode, 400, redirect);
        assert.equal(posted.headers.location, undefined);
      }
    }
    const unknown = await app.inject({ url: `/api/oauth/authorize?${new URLSearchParams(authorizeParams('nope', challenge))}` });
    assert.equal(unknown.statusCode, 400);
    assert.ok(other.client_id);
  } finally {
    await cleanup();
  }
});

test('a code works once; replaying it revokes the token it gave', async () => {
  const { app, store, cleanup } = await appFixture();
  try {
    const client = (await app.inject({ method: 'POST', url: '/oauth/register', payload: registration() })).json();
    const { verifier, challenge } = pkce();
    const code = await allow(app, client.client_id, challenge);
    const first = await app.inject(tokenForm(client.client_id, code, verifier));
    assert.equal(first.statusCode, 200);
    assert.deepEqual(Object.keys(first.json()).sort(), ['access_token', 'token_type'], 'no expires_in: it lasts until revoked');
    assert.equal(first.json().token_type, 'Bearer');
    assert.equal(first.headers['cache-control'], 'no-store');
    const token = first.json().access_token as string;
    assert.ok(token.startsWith(CONNECTED_APP_TOKEN_PREFIX));
    assert.ok(Buffer.from(token.slice(CONNECTED_APP_TOKEN_PREFIX.length), 'base64url').length >= 32);
    assert.equal(store.verify(token)?.name, 'Hatbot');

    const replay = await app.inject(tokenForm(client.client_id, code, verifier));
    assert.equal(replay.statusCode, 400);
    assert.equal(replay.json().error, 'invalid_grant');
    assert.match(replay.json().error_description, /already used/);
    assert.equal(store.verify(token), null, 'a replayed code may be stolen, so its token stops working');
  } finally {
    await cleanup();
  }
});

test('the token endpoint wants the verifier that matches the challenge', async () => {
  const { app, store, cleanup } = await appFixture();
  try {
    const client = (await app.inject({ method: 'POST', url: '/oauth/register', payload: registration() })).json();
    const { verifier, challenge } = pkce();
    const code = await allow(app, client.client_id, challenge);
    for (const wrong of [pkce().verifier, verifier.slice(0, -1) + (verifier.endsWith('A') ? 'B' : 'A'), 'short']) {
      const refused = await app.inject(tokenForm(client.client_id, code, wrong));
      assert.equal(refused.statusCode, 400);
      assert.deepEqual(Object.keys(refused.json()).sort(), ['error', 'error_description']);
      assert.equal(refused.json().error, 'invalid_grant');
    }
    const otherClient = (await app.inject({ method: 'POST', url: '/oauth/register', payload: registration() })).json();
    assert.equal((await app.inject(tokenForm(otherClient.client_id, code, verifier))).json().error, 'invalid_grant', 'bound to its client');
    assert.equal((await app.inject(tokenForm(client.client_id, code, verifier, { redirect_uri: 'https://hatbot.example/other' }))).json().error, 'invalid_grant', 'bound to its redirect_uri');
    assert.equal((await app.inject(tokenForm(client.client_id, code, verifier, { grant_type: 'refresh_token' }))).json().error, 'unsupported_grant_type');

    const allowed = await app.inject(tokenForm(client.client_id, code, verifier));
    assert.equal(allowed.statusCode, 200, 'the right verifier still works after wrong guesses');
    assert.ok(store.verify(allowed.json().access_token));
  } finally {
    await cleanup();
  }
});

test('a code lasts five minutes', () => {
  const { store, cleanup } = storeFixture();
  try {
    const t0 = Date.parse('2026-10-25T08:00:00Z');
    const client = store.register(registration(), t0);
    const exchange = (code: string, verifier: string, now: number) => store.exchange({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: client.id, code_verifier: verifier }, now);

    const late = pkce();
    const lateCode = store.createCode(store.authorization(authorizeParams(client.id, late.challenge)), t0);
    assert.throws(() => exchange(lateCode, late.verifier, t0 + CODE_TTL_MS), (error: unknown) => error instanceof OAuthError && error.code === 'invalid_grant' && /expired/.test(error.message));

    const onTime = pkce();
    const onTimeCode = store.createCode(store.authorization(authorizeParams(client.id, onTime.challenge)), t0);
    const token = exchange(onTimeCode, onTime.verifier, t0 + CODE_TTL_MS - 1_000);
    assert.equal(store.verify(token, t0 + CODE_TTL_MS)?.name, 'Hatbot');
  } finally {
    cleanup();
  }
});

test('stores only digests and notes when a token was made and last used', () => {
  const { db, store, cleanup } = storeFixture();
  try {
    const t0 = Date.parse('2026-10-25T08:00:00Z');
    const client = store.register(registration(), t0);
    const { verifier, challenge } = pkce();
    const code = store.createCode(store.authorization(authorizeParams(client.id, challenge)), t0);
    const token = store.exchange({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: client.id, code_verifier: verifier }, t0);
    const dump = JSON.stringify([db.prepare('SELECT * FROM connected_app_tokens').all(), db.prepare('SELECT * FROM oauth_codes').all()]);
    assert.equal(dump.includes(token), false);
    assert.equal(dump.includes(code), false);
    assert.ok(dump.includes(createHash('sha256').update(token).digest('hex')));
    assert.deepEqual(store.list(), [{ id: 1, name: 'Hatbot', connectedAt: '2026-10-25T08:00:00.000Z', lastUsedAt: null }]);
    store.verify(token, t0 + 60_000);
    assert.equal(store.list()[0].lastUsedAt, '2026-10-25T08:01:00.000Z');
    store.verify(token, t0 + 70_000);
    assert.equal(store.list()[0].lastUsedAt, '2026-10-25T08:01:00.000Z', 'touched at most once a minute');
  } finally {
    cleanup();
  }
});

// The rules that depend on server/index.ts's wiring run against a real Scout.

async function freePort() {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

async function startScout(env: Record<string, string>) {
  const directory = mkdtempSync(join(tmpdir(), 'scout-oauth-server-'));
  const dist = join(directory, 'dist');
  mkdirSync(dist);
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>Scout</title>');
  const port = await freePort();
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('SCOUT_')));
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    env: { ...inherited, PORT: String(port), SCOUT_HOST: '127.0.0.1', SCOUT_DB_PATH: join(directory, 'scout.sqlite'), SCOUT_DIST_PATH: dist, SCOUT_SECRET: randomBytes(32).toString('hex'), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Scout did not start:\n${output}`)), 90_000);
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes('Server listening')) { clearTimeout(timer); resolve(); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Scout exited (${code}):\n${output}`)); });
  });
  const origin = `http://127.0.0.1:${port}`;
  return {
    origin,
    stop: async () => {
      if (child.exitCode === null) {
        const exited = new Promise((resolve) => child.once('exit', resolve));
        child.kill('SIGTERM');
        await exited;
      }
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

const PASSWORD = 'correct horse battery staple';
const STATIC_TOKEN = randomBytes(24).toString('hex');

async function signIn(origin: string) {
  const response = await fetch(`${origin}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ password: PASSWORD }) });
  assert.equal(response.status, 200);
  const cookie = /scout_session=[^;]+/.exec(response.headers.get('set-cookie') ?? '')?.[0];
  assert.ok(cookie);
  return cookie;
}

/** Hatbot's side of the flow, with the owner pressing Allow in a signed-in browser (`cookie`). */
async function connect(origin: string, cookie: string | null) {
  const metadata = await (await fetch(`${origin}/.well-known/oauth-authorization-server`)).json() as Record<string, string>;
  const registered = await fetch(metadata.registration_endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(registration()) });
  assert.equal(registered.status, 201);
  const { client_id: clientId } = await registered.json() as { client_id: string };
  const { verifier, challenge } = pkce();
  const query = new URLSearchParams(authorizeParams(clientId, challenge));
  const browser = { ...(cookie ? { cookie } : {}), origin, 'sec-fetch-site': 'same-origin' };
  const page = await fetch(`${metadata.authorization_endpoint}?${query}`, { headers: browser });
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy') ?? '', /form-action 'self' https:\/\/hatbot\.example;/);
  assert.match(await page.text(), /<title>Scout<\/title>/);
  const details = await fetch(`${origin}/api/oauth/authorize?${query}`, { headers: browser });
  assert.deepEqual(await details.json(), { clientName: 'Hatbot', redirectOrigin: 'https://hatbot.example' });
  const allowed = await fetch(metadata.authorization_endpoint, { method: 'POST', redirect: 'manual', headers: { ...browser, 'content-type': 'application/x-www-form-urlencoded' }, body: `${query}&decision=allow` });
  assert.equal(allowed.status, 302);
  const back = new URL(allowed.headers.get('location')!);
  assert.equal(back.searchParams.get('state'), 'state-123');
  const exchanged = await fetch(metadata.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: back.searchParams.get('code')!, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier }),
  });
  assert.equal(exchanged.status, 200);
  return (await exchanged.json() as { access_token: string }).access_token;
}

async function mcpTools(origin: string, token: string) {
  const client = new Client({ name: 'oauth-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  try {
    return (await client.listTools()).tools.map((tool) => tool.name);
  } finally {
    await client.close();
  }
}

const mcpPost = (origin: string, token: string, call: { method: string; params: unknown } = { method: 'tools/list', params: {} }) => fetch(`${origin}/mcp`, {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, ...call }),
});

test('end to end: register, Allow, token, then tools/list on /mcp without the debug tools', { timeout: 180_000 }, async () => {
  const scout = await startScout({ SCOUT_PASSWORD: PASSWORD, SCOUT_API_TOKENS: STATIC_TOKEN, SCOUT_DEBUG_API: 'true' });
  try {
    const { origin } = scout;
    const unauthenticated = await mcpPost(origin, 'not-a-token');
    assert.equal(unauthenticated.status, 401);
    assert.equal(unauthenticated.headers.get('www-authenticate'), `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`);
    const resource = await (await fetch(`${origin}/.well-known/oauth-protected-resource`)).json();
    assert.deepEqual(resource, { resource: `${origin}/mcp`, authorization_servers: [origin] });

    const cookie = await signIn(origin);
    // Allow needs the owner's signed-in, same-origin browser.
    const metadata = await (await fetch(`${origin}/.well-known/oauth-authorization-server`)).json() as Record<string, string>;
    const anonymous = await fetch(metadata.authorization_endpoint, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', origin }, body: 'decision=allow' });
    assert.equal(anonymous.status, 401);
    const crossSite = await fetch(metadata.authorization_endpoint, { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded', origin: 'https://evil.example' }, body: 'decision=allow' });
    assert.equal(crossSite.status, 403);

    const token = await connect(origin, cookie);
    const tools = await mcpTools(origin, token);
    assert.ok(tools.includes('scout_flips_to_list') && tools.includes('scout_watches') && tools.includes('scout_listing_detail'));
    assert.equal(tools.filter((name) => name.startsWith('scout_debug_')).length, 0, 'connected apps never get the debug tools');
    assert.ok((await mcpTools(origin, STATIC_TOKEN)).some((name) => name.startsWith('scout_debug_')), 'an API token still does');
    assert.ok(tools.includes('scout_shared_session'), 'connected apps get the shared sessions');
    assert.ok(!(await mcpTools(origin, STATIC_TOKEN)).includes('scout_shared_session'), 'an API token never does');

    const apps = await (await fetch(`${origin}/api/connected-apps`, { headers: { cookie } })).json() as { apps: Array<{ name: string; lastUsedAt: string | null }> };
    assert.equal(apps.apps.length, 1);
    assert.equal(apps.apps[0].name, 'Hatbot');
    assert.ok(apps.apps[0].lastUsedAt, 'the /mcp call was noted');
  } finally {
    await scout.stop();
  }
});

test('a connected-app token works on /mcp only, and a disconnected one not at all', { timeout: 180_000 }, async () => {
  const scout = await startScout({ SCOUT_PASSWORD: PASSWORD });
  try {
    const { origin } = scout;
    const cookie = await signIn(origin);
    const token = await connect(origin, cookie);

    // Refused on /api, /events and for dashboard sign-in; the session itself is fine.
    assert.equal((await fetch(`${origin}/api/watches`, { headers: { cookie } })).status, 200);
    const api = await fetch(`${origin}/api/watches`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(api.status, 401);
    assert.equal(api.headers.get('www-authenticate'), 'Bearer realm="scout"');
    assert.equal((await fetch(`${origin}/api/connected-apps`, { headers: { authorization: `Bearer ${token}` } })).status, 401, "it can't disconnect apps either");
    assert.equal((await fetch(`${origin}/events`, { headers: { authorization: `Bearer ${token}` } })).status, 401);
    assert.equal((await fetch(`${origin}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ password: token }) })).status, 401);
    assert.equal((await mcpPost(origin, token)).status, 200);
    // Its own rate limit, past the 30/min the dashboard's MCP and search share: a flip's photos fit.
    for (let call = 0; call < 40; call += 1) assert.equal((await mcpPost(origin, token)).status, 200);
    // Live marketplace tools keep the shared 30/min cap; the rest carry on.
    const scan = { method: 'tools/call', params: { name: 'scout_queue_scan', arguments: { watchId: 'no-such-watch' } } };
    for (let call = 0; call < 30; call += 1) assert.equal((await mcpPost(origin, token, scan)).status, 200);
    assert.equal((await mcpPost(origin, token, scan)).status, 429);
    assert.equal((await mcpPost(origin, token)).status, 200);

    // Disconnect revokes it at once.
    const { apps } = await (await fetch(`${origin}/api/connected-apps`, { headers: { cookie } })).json() as { apps: Array<{ id: number }> };
    const revoked = await fetch(`${origin}/api/connected-apps/${apps[0].id}`, { method: 'DELETE', headers: { cookie, origin } });
    assert.equal(revoked.status, 200);
    const after = await mcpPost(origin, token);
    assert.equal(after.status, 401);
    assert.match(after.headers.get('www-authenticate') ?? '', /resource_metadata=/);
    assert.equal((await fetch(`${origin}/api/connected-apps/${apps[0].id}`, { method: 'DELETE', headers: { cookie, origin } })).status, 404);
  } finally {
    await scout.stop();
  }
});

test('works the same with sign-in off, and still honours Disconnect', { timeout: 180_000 }, async () => {
  const scout = await startScout({ SCOUT_AUTH: 'off' });
  try {
    const { origin } = scout;
    const token = await connect(origin, null);
    assert.ok((await mcpTools(origin, token)).includes('scout_flip'));
    assert.equal((await fetch(`${origin}/api/watches`, { headers: { authorization: `Bearer ${token}` } })).status, 401, 'its token is for /mcp only');
    const { apps } = await (await fetch(`${origin}/api/connected-apps`)).json() as { apps: Array<{ id: number }> };
    assert.equal((await fetch(`${origin}/api/connected-apps/${apps[0].id}`, { method: 'DELETE', headers: { origin } })).status, 200);
    assert.equal((await mcpPost(origin, token)).status, 401);
    // Host pinning and cross-site checks cover the OAuth endpoints too.
    // fetch() won't send a forged Host, so ask with node:http.
    const rebound = await new Promise<number>((resolve, reject) => {
      httpRequest(`${origin}/.well-known/oauth-authorization-server`, { headers: { host: 'evil.example' } }, (response) => { response.resume(); resolve(response.statusCode ?? 0); }).on('error', reject).end();
    });
    assert.equal(rebound, 403);
    const crossSite = await fetch(`${origin}/oauth/authorize`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://evil.example' }, body: 'decision=allow' });
    assert.equal(crossSite.status, 403);
  } finally {
    await scout.stop();
  }
});

test('behind a proxy, the metadata and the /mcp challenge say SCOUT_PUBLIC_ORIGIN, whatever Host and scheme reach Scout', { timeout: 180_000 }, async () => {
  const scout = await startScout({ SCOUT_PASSWORD: PASSWORD, SCOUT_PUBLIC_ORIGIN: 'https://scout.example' });
  try {
    const { origin } = scout;
    const proxied = { 'x-forwarded-for': '203.0.113.7' };
    const metadata = await (await fetch(`${origin}/.well-known/oauth-authorization-server`, { headers: proxied })).json() as Record<string, string>;
    assert.equal(metadata.issuer, 'https://scout.example');
    assert.equal(metadata.authorization_endpoint, 'https://scout.example/oauth/authorize');
    assert.equal(metadata.token_endpoint, 'https://scout.example/oauth/token');
    assert.equal(metadata.registration_endpoint, 'https://scout.example/oauth/register');
    const resource = await (await fetch(`${origin}/.well-known/oauth-protected-resource`, { headers: proxied })).json();
    assert.deepEqual(resource, { resource: 'https://scout.example/mcp', authorization_servers: ['https://scout.example'] });
    const refused = await fetch(`${origin}/mcp`, { method: 'POST', headers: { ...proxied, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(refused.status, 401);
    assert.equal(refused.headers.get('www-authenticate'), 'Bearer resource_metadata="https://scout.example/.well-known/oauth-protected-resource"');
    // Reached directly, it's still the address that was used.
    const direct = await (await fetch(`${origin}/.well-known/oauth-authorization-server`)).json() as Record<string, string>;
    assert.equal(direct.issuer, origin);
  } finally {
    await scout.stop();
  }
});
