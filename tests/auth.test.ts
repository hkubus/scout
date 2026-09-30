import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
// @ts-ignore node:sqlite is present in the supported Node 22+ runtime.
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import {
  bearerToken,
  hashPassword,
  isProtectedRoute,
  isSameOriginRequest,
  loadAuthConfig,
  matchesApiToken,
  parseCookies,
  SESSION_ABSOLUTE_MS,
  SESSION_IDLE_MS,
  sessionCookie,
  SessionStore,
  trustProxySetting,
  verifyPassword,
} from '../server/auth';

const token = 'a'.repeat(40);

test('hashes and verifies passwords, rejecting malformed hashes', async () => {
  const hash = await hashPassword('correct horse battery');
  assert.match(hash, /^scrypt\$32768\$8\$1\$/);
  assert.equal(await verifyPassword('correct horse battery', hash), true);
  assert.equal(await verifyPassword('wrong password', hash), false);
  assert.equal(await verifyPassword('correct horse battery', 'scrypt$1$1$1$x$y'), false);
});

test('the standalone hash script produces hashes the server accepts', async () => {
  const hash = execFileSync(process.execPath, ['scripts/hash-password.mjs'], { input: 'standalone-password\n' }).toString().trim();
  assert.equal(await verifyPassword('standalone-password', hash), true);
});

test('refuses to listen publicly without credentials unless explicitly opted out', async () => {
  await assert.rejects(loadAuthConfig({}, { publiclyBound: true }), /without authentication/);
  assert.equal((await loadAuthConfig({}, { publiclyBound: false })).enabled, false);
  assert.equal((await loadAuthConfig({ SCOUT_AUTH: 'off' }, { publiclyBound: true })).enabled, false);
  await assert.rejects(loadAuthConfig({ SCOUT_AUTH: 'on' }, { publiclyBound: false }), /without authentication/);
  await assert.rejects(loadAuthConfig({ SCOUT_AUTH: 'off', SCOUT_API_TOKENS: token }, { publiclyBound: true }), /conflicts/);
  await assert.rejects(loadAuthConfig({ SCOUT_PASSWORD: 'short' }, { publiclyBound: true }), /at least 12/);
  await assert.rejects(loadAuthConfig({ SCOUT_API_TOKENS: 'short' }, { publiclyBound: true }), /at least 32/);
  await assert.rejects(loadAuthConfig({ SCOUT_PASSWORD_HASH: 'plain' }, { publiclyBound: true }), /not a valid scrypt hash/);
});

test('fingerprints credentials so password changes revoke sessions but restarts do not', async () => {
  const first = await loadAuthConfig({ SCOUT_PASSWORD: 'first-password', SCOUT_SECRET: 's'.repeat(32) }, { publiclyBound: true });
  const restarted = await loadAuthConfig({ SCOUT_PASSWORD: 'first-password', SCOUT_SECRET: 's'.repeat(32) }, { publiclyBound: true });
  const rotated = await loadAuthConfig({ SCOUT_PASSWORD: 'second-password', SCOUT_SECRET: 's'.repeat(32) }, { publiclyBound: true });
  assert.equal(first.enabled, true);
  assert.equal(first.credentialId, restarted.credentialId);
  assert.notEqual(first.credentialId, rotated.credentialId);
  assert.equal(await verifyPassword('first-password', first.passwordHash!), true);
});

test('matches bearer tokens and parses cookies', async () => {
  const config = await loadAuthConfig({ SCOUT_API_TOKENS: `${token}, ${'b'.repeat(32)}` }, { publiclyBound: true });
  assert.equal(bearerToken(`Bearer ${token}`), token);
  assert.equal(bearerToken('Basic abc'), null);
  assert.equal(matchesApiToken(config, token), true);
  assert.equal(matchesApiToken(config, 'b'.repeat(32)), true);
  assert.equal(matchesApiToken(config, 'c'.repeat(40)), false);
  assert.equal(parseCookies('a=1; scout_session=abc%2D; b').get('scout_session'), 'abc-');
  assert.match(sessionCookie('x', true), /HttpOnly; SameSite=Strict; Max-Age=\d+; Secure$/);
  assert.doesNotMatch(sessionCookie('x', false), /Secure/);
});

test('accepts only same-origin cookie-authenticated state changes', () => {
  assert.equal(isSameOriginRequest({ origin: 'https://scout.example', 'sec-fetch-site': 'same-origin' }, 'https://scout.example'), true);
  assert.equal(isSameOriginRequest({ origin: 'https://scout.example:443' }, 'https://scout.example'), true);
  assert.equal(isSameOriginRequest({ origin: 'https://evil.example' }, 'https://scout.example'), false);
  assert.equal(isSameOriginRequest({ origin: 'https://scout.example', 'sec-fetch-site': 'cross-site' }, 'https://scout.example'), false);
  assert.equal(isSameOriginRequest({ 'sec-fetch-site': 'same-origin' }, 'https://scout.example'), true);
  assert.equal(isSameOriginRequest({}, 'https://scout.example'), false);
  assert.equal(isSameOriginRequest({ origin: 'null' }, 'https://scout.example'), false);
  assert.equal(isSameOriginRequest({ origin: 'http://scout.example' }, 'https://scout.example'), false, 'scheme must match');
  assert.equal(isSameOriginRequest({ origin: 'https://scout.example:8443' }, 'https://scout.example'), false, 'port must match');
  assert.equal(isSameOriginRequest({ referer: 'http://scout.example/settings' }, 'https://scout.example'), false);
  assert.equal(isSameOriginRequest({ origin: 'https://app.example' }, 'http://internal:3001', ['https://app.example']), true);
  assert.equal(isSameOriginRequest({ origin: 'https://app.example' }, 'http://[bad', []), false);
});

test('validates SCOUT_TRUST_PROXY at startup', () => {
  assert.equal(trustProxySetting(undefined), false);
  assert.equal(trustProxySetting('false'), false);
  assert.equal(trustProxySetting('TRUE'), true);
  const hops = trustProxySetting('1');
  assert.equal(typeof hops, 'function');
  assert.equal((hops as (address: string, hop: number) => boolean)('10.0.0.1', 0), true);
  assert.equal((hops as (address: string, hop: number) => boolean)('10.0.0.1', 1), false);
  assert.equal(trustProxySetting('127.0.0.1'), '127.0.0.1');
  assert.equal(trustProxySetting('10.0.0.0/8, ::1, fd00::/8, loopback'), '10.0.0.0/8,::1,fd00::/8,loopback');
  for (const invalid of ['yes', '10.0.0.0/33', '::1/129', '1.2.3', 'proxy.example', '127.0.0.1,', '10.0.0.1/8/1']) {
    assert.throws(() => trustProxySetting(invalid), /SCOUT_TRUST_PROXY must be/, invalid);
  }
});

test('session store enforces idle, absolute, and credential expiry', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync('migrations/026_auth_sessions.sql', 'utf8'));
  const store = new SessionStore(db, 'cred-1');
  const start = Date.UTC(2026, 0, 1);

  const session = store.create({ ip: '203.0.113.1' }, start);
  assert.equal(store.validate(session, start + 1000), true);
  assert.equal(store.validate('not-a-token', start), false);
  assert.equal(new SessionStore(db, 'cred-2').validate(session, start + 1000), false, 'rotated password revokes');

  const idle = store.create({}, start);
  assert.equal(store.validate(idle, start + SESSION_IDLE_MS + 1), false);

  const active = store.create({}, start);
  for (let at = start; at < start + SESSION_ABSOLUTE_MS; at += SESSION_IDLE_MS / 2) assert.equal(store.validate(active, at), true);
  assert.equal(store.validate(active, start + SESSION_ABSOLUTE_MS + 1), false);

  const watched = store.create({}, start);
  assert.equal(store.isActive(watched, start + SESSION_IDLE_MS - 1), true);
  assert.equal(store.validate(watched, start + SESSION_IDLE_MS + 1), false, 'isActive() never extends the idle window');
  assert.equal(store.isActive(active, start + SESSION_ABSOLUTE_MS + 1), false);

  const revoked = store.create({}, start);
  store.revoke(revoked);
  assert.equal(store.validate(revoked, start), false);

  const stored = db.prepare('SELECT token_hash FROM auth_sessions').all() as Array<{ token_hash: string }>;
  assert.ok(stored.every((row) => !row.token_hash.includes(active)), 'raw tokens are never stored');
});

test('protects routes by their matched template, so percent-encoded paths cannot skip auth', async () => {
  const app = Fastify();
  app.addHook('onRequest', async (request, reply) => {
    const route = request.routeOptions.url;
    if (isProtectedRoute(route) && route !== '/api/health') return reply.code(401).send({ error: 'Authentication required' });
  });
  app.get('/api/health', async () => ({ status: 'ok' }));
  app.get('/api/debug/schema', async () => ({ secret: true }));
  app.get('/events', async () => 'stream');
  app.post('/mcp', async () => 'mcp');
  app.get('/index.html', async () => 'shell');
  try {
    for (const [method, url] of [['GET', '/api/debug/schema'], ['GET', '/%61pi/debug/schema'], ['GET', '/api/de%62ug/schema?x=1'], ['GET', '/%65vents'], ['POST', '/%6Dcp'], ['POST', '/mcp']] as const) {
      assert.equal((await app.inject({ method, url })).statusCode, 401, `${method} ${url}`);
    }
    assert.equal((await app.inject({ method: 'GET', url: '/api/health' })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: '/index.html' })).statusCode, 200);
    assert.equal(isProtectedRoute(undefined), false);
  } finally {
    await app.close();
  }
});

test('restoring a backup drops its sign-in sessions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scout-restore-'));
  try {
    const backupPath = join(dir, 'backup.sqlite');
    const backup = new DatabaseSync(backupPath);
    backup.exec('CREATE TABLE migrations (id TEXT); CREATE TABLE settings (key TEXT); CREATE TABLE watches (id TEXT);');
    backup.exec(readFileSync('migrations/026_auth_sessions.sql', 'utf8'));
    new SessionStore(backup, 'cred').create({});
    backup.close();
    const databasePath = join(dir, 'scout.sqlite');
    execFileSync(process.execPath, ['--import', 'tsx', 'scripts/restore.ts', '--backup', backupPath, '--database', databasePath, '--confirm'], { stdio: 'pipe' });
    const restored = new DatabaseSync(databasePath);
    try {
      assert.deepEqual((restored.prepare('SELECT COUNT(*) AS count FROM auth_sessions').get() as { count: number }).count, 0);
    } finally {
      restored.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
