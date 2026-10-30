import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase } from '../server/db';
import {
  InboxError, cookieHeader, isSessionRenewalRequest, jwtExpiry, mergeSetCookies, parseAllegroInbox, parseAllegroMessages,
  parseAllegroSubject, parseConversationKey, parseOlxConversations, parseVintedConversation, parseVintedInbox, withoutRefreshTokens,
} from '../server/inbox';
import type { MarketplaceStorageState } from '../server/marketplace-sessions';
import { ScoutService } from '../server/service';
import type { Marketplace } from '../src/types';

if (process.env.SCOUT_JEV_MODE === undefined) process.env.SCOUT_JEV_MODE = 'legacy';

const fixtures = JSON.parse(readFileSync(resolve(import.meta.dirname, 'fixtures-inbox.json'), 'utf8'));
const T = Date.parse('2026-10-17T12:00:00.000Z');
const TS = T / 1000;
const OLX_A = '0a1b2c3d-0000-4000-8000-000000000001';
const OLX_B = '0a1b2c3d-0000-4000-8000-000000000002';
const OLX_C = '0a1b2c3d-0000-4000-8000-000000000003';
const AL_A = '5e6f7a8b-0000-4000-8000-000000000001';
const AL_B = '5e6f7a8b-0000-4000-8000-000000000002';
const AL_C = '5e6f7a8b-0000-4000-8000-000000000003';
const AL_BUYER = '5e6f7a8b-0000-4000-8000-0000000000cc';
const OLX_KEY = '@@auth0spajs@@::olx-client::default::openid profile email offline_access';

const jwt = (exp: number) => `e30.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.signature`;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Call { method: string; url: string; headers: Record<string, string>; body: string }

/** A stand-in for the marketplaces that records every request Scout makes. */
function marketplace(route: (call: Call, url: URL) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    const call = { method: String(init.method ?? 'GET'), url, headers: { ...(init.headers as Record<string, string>) }, body: typeof init.body === 'string' ? init.body : '' };
    calls.push(call);
    return route(call, new URL(url));
  };
  const paths = (from = 0) => calls.slice(from).map((call) => `${call.method} ${new URL(call.url).pathname}${new URL(call.url).search}`);
  return { calls, fetch, paths };
}

function fixture(inboxFetch: (url: string, init: RequestInit) => Promise<Response>, authEnabled = false) {
  const directory = mkdtempSync(join(tmpdir(), 'scout-inbox-'));
  const db = openDatabase(join(directory, 'scout.sqlite'));
  const service = new ScoutService(db, () => {}, { suggestVariantGroups: async () => [], inboxFetch, authEnabled });
  return { db, service, close: () => { db.close(); rmSync(directory, { recursive: true, force: true }); } };
}

const sessionRow = (service: ScoutService, name: Marketplace) => service.marketplaceSessions().find((row) => row.marketplace === name)!;
const createRevision = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 16);
const ciphertext = (db: ReturnType<typeof openDatabase>, name: Marketplace) => (db.prepare('SELECT storage_state_encrypted AS value FROM marketplace_sessions WHERE marketplace = ?').get(name) as { value: string }).value;

function vintedState(accessExpiry: number, refresh = 'refresh-1'): MarketplaceStorageState {
  return {
    cookies: [
      { name: 'access_token_web', value: jwt(accessExpiry), domain: '.vinted.pl', path: '/', expires: accessExpiry, httpOnly: true, secure: true, sameSite: 'Lax' },
      { name: 'refresh_token_web', value: refresh, domain: '.vinted.pl', path: '/', expires: TS + 7 * 86_400, httpOnly: true, secure: true, sameSite: 'Lax' },
      { name: 'anon_id', value: 'anon-1', domain: '.vinted.pl', path: '/', expires: -1 },
    ],
    origins: [],
  };
}

function vintedRenewal(token: string, refresh: string) {
  const headers = new Headers({ 'content-type': 'application/json' });
  headers.append('set-cookie', `access_token_web=${token}; Domain=.vinted.pl; Path=/; Max-Age=3600; Secure; HttpOnly; SameSite=Lax`);
  headers.append('set-cookie', `refresh_token_web=${refresh}; Domain=.vinted.pl; Path=/; Max-Age=604800; Secure; HttpOnly; SameSite=Lax`);
  return new Response('{}', { status: 200, headers });
}

function olxState(accessExpiry: number, refresh = 'olx-refresh-1'): MarketplaceStorageState {
  const token = jwt(accessExpiry);
  return {
    cookies: [
      { name: 'access_token', value: token, domain: '.olx.pl', path: '/', expires: TS + 86_400 },
      { name: 'olx_session', value: 'www-only', domain: 'www.olx.pl', path: '/' },
    ],
    origins: [{
      origin: 'https://www.olx.pl',
      localStorage: [
        { name: OLX_KEY, value: JSON.stringify({ body: { client_id: 'olx-client', access_token: token, refresh_token: refresh, expires_in: 900, scope: 'openid offline_access' }, expiresAt: accessExpiry }) },
        { name: 'unrelated', value: 'kept' },
      ],
    }],
  };
}

const allegroState: MarketplaceStorageState = { cookies: [{ name: '_ui_key', value: 'al-session', domain: 'allegrolokalnie.pl', path: '/', expires: TS + 30 * 86_400 }], origins: [] };

// ---- Parsers -------------------------------------------------------------------

test('OLX conversations parse with roles, directions and price proposals', () => {
  const [unread] = parseOlxConversations(fixtures.olx.unread).conversations;
  const { messages, ...conversation } = unread;
  assert.deepEqual(conversation, {
    id: `OLX:${OLX_A}`, rawId: OLX_A, listingKey: 'OLX:900000001', url: `https://www.olx.pl/myaccount/answer/${OLX_A}/`, role: 'buy',
    other: { id: '200', name: 'Sprzedawca A' }, title: 'Karta graficzna RTX 3070 8GB', unread: true, updatedAt: '2026-10-10T12:30:00.000Z',
    lastMessage: { id: '0a1b2c3d-0000-4000-8000-00000000a004', direction: 'in', type: 'text', text: 'Mogę zejść do 1400, odbiór w Krakowie.', time: '2026-10-10T12:30:00.000Z', offer: null },
  });
  assert.deepEqual(messages!.map((message) => [message.direction, message.type, message.offer]), [
    ['out', 'text', null], ['out', 'offer', { amount: 1300, status: 'proposed' }], ['in', 'offer', { amount: 1400, status: 'proposed' }], ['in', 'text', null],
  ], 'oldest first, the counter-offer before the message sent a minute after it');

  const read = parseOlxConversations(fixtures.olx.read);
  assert.equal(read.total, 2);
  assert.deepEqual([read.conversations[0].role, read.conversations[0].other], ['sell', { id: '201', name: 'Kupujący B' }]);
  assert.deepEqual(read.conversations[0].messages!.map((message) => [message.direction, message.type, message.offer]), [
    ['in', 'offer', { amount: 1900, status: 'proposed' }], ['out', 'offer', { amount: 1900, status: 'accepted' }], ['system', 'event', null],
  ]);
});

test('Vinted inbox and conversations parse; bundles have no single listing', () => {
  assert.deepEqual(parseVintedInbox(fixtures.vinted.inbox)[0], {
    id: 'Vinted:7001', rawId: '7001', listingKey: null, url: 'https://www.vinted.pl/inbox/7001', role: null, other: { id: '501', name: 'sprzedawca_d' }, title: null,
    unread: true, updatedAt: '2026-10-12T09:00:00.000Z', lastMessage: { id: null, direction: null, type: 'text', text: 'Mogę zejść do 900 zł', time: '2026-10-12T09:00:00.000Z', offer: null },
  });
  const thread = parseVintedConversation(fixtures.vinted.conversations['7001'])!;
  assert.deepEqual([thread.lookup, thread.other, thread.read], [{ listingKey: 'Vinted:4001', role: 'buy', title: 'Nintendo Switch OLED' }, { id: '501', name: 'sprzedawca_d' }, false]);
  assert.deepEqual(thread.messages, [
    { id: '9101', direction: 'out', type: 'offer', text: '800,00 zł', time: '2026-10-12T07:00:00.000Z', offer: { amount: 800, status: 'rejected' } },
    { id: '9102', direction: 'in', type: 'offer', text: '900,00 zł', time: '2026-10-12T08:59:00.000Z', offer: { amount: 900, status: 'proposed' } },
    { id: 'status_message:2026-10-12T08:59:30.000Z', direction: 'system', type: 'event', text: 'Sprzedający zaproponował nową cenę', time: '2026-10-12T08:59:30.000Z', offer: null },
    { id: '9103', direction: 'in', type: 'text', text: 'Mogę zejść do 900 zł', time: '2026-10-12T09:00:00.000Z', offer: null },
  ]);
  assert.deepEqual(parseVintedConversation(fixtures.vinted.conversations['7002'])!.lookup, { listingKey: 'Vinted:4002', role: 'sell', title: 'Kurtka zimowa M' });
  assert.equal(parseVintedConversation(fixtures.vinted.conversations['7003'])!.lookup.listingKey, null, 'a two-item bundle');
  assert.equal(parseVintedConversation({ code: 0 }), null);
});

test('Allegro Lokalnie inbox, messages and subjects parse', () => {
  const [enquiry, purchase, empty] = parseAllegroInbox(fixtures.allegroLokalnie.inbox);
  assert.deepEqual(enquiry, {
    id: `Allegro Lokalnie:${AL_A}`, rawId: AL_A, listingKey: null, url: `https://allegrolokalnie.pl/wiadomosci/${AL_A}`, role: 'sell',
    other: { id: AL_BUYER, name: 'Kupujący G' }, title: 'Aparat Fujifilm X100', unread: true, updatedAt: '2026-10-13T15:00:00.000Z',
    lastMessage: { id: '5e6f7a8b-0000-4000-8000-00000000d003', direction: 'in', type: 'offer', text: '', time: '2026-10-13T15:00:00.000Z', offer: { amount: 315, status: 'proposed' } },
    subject: { type: 'buying_intent', id: '5e6f7a8b-0000-4000-8000-0000000000e1' },
  });
  assert.deepEqual([purchase.role, purchase.lastMessage?.text, purchase.subject?.type], ['buy', 'Dziękuję za zakup', 'transaction']);
  assert.deepEqual([empty.lastMessage, empty.updatedAt], [null, null]);
  assert.deepEqual(parseAllegroInbox({ conversation: fixtures.allegroLokalnie.inbox.entries[1] }).map((entry) => entry.rawId), [AL_B]);

  assert.deepEqual(parseAllegroMessages(fixtures.allegroLokalnie.messages[AL_A], AL_BUYER).map((message) => [message.direction, message.type, message.text, message.offer]), [
    ['in', 'text', 'Czy aparat ma rysy?', null],
    ['system', 'event', 'Listing price changed from 369 zł to 349 zł', null],
    ['in', 'offer', '', { amount: 315, status: 'proposed' }],
  ]);
  const subjects = fixtures.allegroLokalnie.subjects;
  assert.equal(parseAllegroSubject(subjects['5e6f7a8b-0000-4000-8000-0000000000e1']), 'Allegro Lokalnie:5e6f7a8b-0000-4000-8000-00000000f001');
  assert.equal(parseAllegroSubject(subjects['5e6f7a8b-0000-4000-8000-0000000000e2']), 'Allegro Lokalnie:5e6f7a8b-0000-4000-8000-00000000f002', 'a purchase lists its items');
  assert.equal(parseAllegroSubject({ items: [{ id: 'a' }, { id: 'b' }] }), null);
});

test('conversation keys, cookies and renewal requests', () => {
  assert.deepEqual(parseConversationKey(`Allegro Lokalnie:${AL_A}`), { marketplace: 'Allegro Lokalnie', id: AL_A });
  for (const key of ['OLX', 'eBay:1', 'OLX:', 'OLX:../1', 'Vinted:1 2', 'Vinted:1?mark_as_read']) {
    assert.throws(() => parseConversationKey(key), (error: unknown) => error instanceof InboxError && error.status === 400, key);
  }

  const state: MarketplaceStorageState = {
    cookies: [
      { name: 'a', value: '1', domain: '.vinted.pl', path: '/' },
      { name: 'b', value: '2', domain: 'www.vinted.pl', path: '/api' },
      { name: 'c', value: '3', domain: '.vinted.pl', path: '/', expires: 100 },
      { name: 'd', value: '4', domain: 'vinted.pl', path: '/' },
    ],
    origins: [],
  };
  assert.equal(cookieHeader(state, new URL('https://www.vinted.pl/api/v2/inbox'), 200), 'a=1; b=2');
  assert.equal(cookieHeader(state, new URL('https://www.vinted.pl/web'), 50), 'a=1; c=3');
  assert.equal(cookieHeader(state, new URL('https://vinted.pl/'), 200), 'a=1; d=4');

  const merged = mergeSetCookies(state, [
    'a=9; Domain=vinted.pl; Path=/; Max-Age=60; HttpOnly; Secure; SameSite=None',
    'b=; Path=/api; Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    'c=; Domain=.vinted.pl; Path=/; Max-Age=0',
    'e=5; Path=/',
    'not a cookie',
  ], new URL('https://www.vinted.pl/web/api/auth/refresh'), 200);
  assert.deepEqual(merged.cookies, [
    { name: 'a', value: '9', domain: '.vinted.pl', path: '/', expires: 260, httpOnly: true, secure: true, sameSite: 'None' },
    { name: 'd', value: '4', domain: 'vinted.pl', path: '/' },
    { name: 'e', value: '5', domain: 'www.vinted.pl', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' },
  ]);
  assert.equal(state.cookies.length, 4, 'the input is left alone');

  assert.equal(jwtExpiry(jwt(123)), 123);
  assert.equal(jwtExpiry('not-a-token'), null);
  assert.equal(isSessionRenewalRequest('POST', 'https://login.olx.pl/oauth2/token'), true);
  assert.equal(isSessionRenewalRequest('post', 'https://www.vinted.pl/web/api/auth/refresh?x=1'), true);
  assert.equal(isSessionRenewalRequest('GET', 'https://www.vinted.pl/web/api/auth/refresh'), false);
  assert.equal(isSessionRenewalRequest('POST', 'https://www.vinted.pl/api/v2/conversations/1/mark_as_read'), false);
});

// ---- Service, against a temp database ------------------------------------------------

test('scout_inbox and scout_conversation need a stored session and a valid id', async () => {
  const fake = marketplace(() => json({}, 500));
  const context = fixture(fake.fetch);
  try {
    await assert.rejects(context.service.inboxForAgent({ marketplace: 'Vinted' }), { status: 409, message: /No Vinted session is stored/ });
    await assert.rejects(context.service.conversationForAgent({ id: 'Vinted:7001' }), { status: 409, message: /No Vinted session is stored/ });
    await assert.rejects(context.service.conversationForAgent({ id: 'vinted:7001' }), { status: 400, message: /Invalid conversation id/ });
    context.service.saveMarketplaceSession('Vinted', 'test', vintedState(TS + 3_600));
    await assert.rejects(context.service.inboxForAgent({ marketplace: 'Vinted', since: 'yesterday' }), { status: 400, message: /since must be an ISO 8601/ });
    assert.equal(fake.calls.length, 0);
  } finally { context.close(); }
});

test('Vinted: renews the token, saves the rotated session, caches, and looks up listings with GETs only', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: T });
  const renewed = jwt(TS + 3_600);
  const fake = marketplace((call, url) => {
    if (call.method === 'POST' && url.pathname === '/web/api/auth/refresh') return vintedRenewal(renewed, 'refresh-2');
    if (url.pathname === '/api/v2/inbox') return json(fixtures.vinted.inbox);
    const thread = /^\/api\/v2\/conversations\/(\d+)$/.exec(url.pathname)?.[1];
    if (thread && fixtures.vinted.conversations[thread]) return json(fixtures.vinted.conversations[thread]);
    return json({ code: 404 }, 404);
  });
  const context = fixture(fake.fetch);
  try {
    context.service.saveMarketplaceSession('Vinted', 'test', vintedState(TS + 60));
    const imported = ciphertext(context.db, 'Vinted');

    const inbox = await context.service.inboxForAgent({ marketplace: 'Vinted' });
    assert.deepEqual(fake.paths(), [
      'POST /web/api/auth/refresh', 'GET /api/v2/inbox?page=1&per_page=20',
      'GET /api/v2/conversations/7001', 'GET /api/v2/conversations/7002', 'GET /api/v2/conversations/7003',
    ]);
    assert.match(fake.calls[0].headers.cookie, /refresh_token_web=refresh-1/);
    assert.ok(fake.calls.slice(1).every((call) => call.method === 'GET' && call.headers.cookie.includes(`access_token_web=${renewed}`)), 'every read is a GET with the renewed token');
    assert.deepEqual([inbox.marketplace, inbox.fetchedAt, inbox.cached, inbox.count, inbox.unread], ['Vinted', new Date(T).toISOString(), false, 3, 1]);
    assert.deepEqual(inbox.conversations[0], {
      id: 'Vinted:7001', listingKey: 'Vinted:4001', url: 'https://www.vinted.pl/inbox/7001', role: 'buy', other: { id: '501', name: 'sprzedawca_d' },
      title: 'Nintendo Switch OLED', unread: true, updatedAt: '2026-10-12T09:00:00.000Z',
      lastMessage: { id: '9103', direction: 'in', type: 'text', text: 'Mogę zejść do 900 zł', time: '2026-10-12T09:00:00.000Z', offer: null },
    });
    assert.deepEqual(inbox.conversations.map((entry) => [entry.listingKey, entry.role, entry.lastMessage?.direction]), [['Vinted:4001', 'buy', 'in'], ['Vinted:4002', 'sell', 'out'], [null, 'sell', 'in']]);

    assert.notEqual(ciphertext(context.db, 'Vinted'), imported, 'the rotated session is saved');
    assert.deepEqual([sessionRow(context.service, 'Vinted').connected, typeof sessionRow(context.service, 'Vinted').lastUsedAt], [true, 'string']);

    const again = await context.service.inboxForAgent({ marketplace: 'Vinted', since: '2026-10-11T12:00:00Z' });
    assert.deepEqual([again.cached, again.conversations.map((entry) => entry.id)], [true, ['Vinted:7001']]);
    assert.equal((await context.service.inboxForAgent({ marketplace: 'Vinted', limit: 2 })).count, 2);
    assert.equal(fake.calls.length, 5, 'the minute-long cache answers');

    const thread = await context.service.conversationForAgent({ id: 'Vinted:7001' });
    assert.equal(fake.calls.length, 5, 'scout_inbox already fetched the thread');
    assert.deepEqual([thread.cached, thread.listingKey, thread.role, thread.unread, thread.truncated, thread.messages.length], [true, 'Vinted:4001', 'buy', true, false, 4]);
    assert.deepEqual(thread.messages.map((message) => message.offer), [{ amount: 800, status: 'rejected' }, { amount: 900, status: 'proposed' }, null, null]);
    const short = await context.service.conversationForAgent({ id: 'Vinted:7001', limit: 2 });
    assert.deepEqual([short.truncated, short.messages.map((message) => message.id)], [true, ['status_message:2026-10-12T08:59:30.000Z', '9103']]);

    t.mock.timers.tick(61_000);
    const fresh = await context.service.conversationForAgent({ id: 'Vinted:7002' });
    assert.deepEqual(fake.paths(5), ['GET /api/v2/inbox?page=1&per_page=20', 'GET /api/v2/conversations/7002']);
    assert.deepEqual([fresh.cached, fresh.fetchedAt, fresh.messages[0].direction], [false, new Date(T + 61_000).toISOString(), 'out']);
    await assert.rejects(context.service.conversationForAgent({ id: 'Vinted:999' }), { status: 404, message: 'Conversation not found' });

    // A second instance on the same database reads the saved session: no renewal, the new token.
    const second = marketplace((_call, url) => (url.pathname === '/api/v2/inbox' ? json({ conversations: [] }) : json({}, 500)));
    const restarted = new ScoutService(context.db, () => {}, { suggestVariantGroups: async () => [], inboxFetch: second.fetch });
    assert.equal((await restarted.inboxForAgent({ marketplace: 'Vinted' })).count, 0);
    assert.deepEqual(second.paths(), ['GET /api/v2/inbox?page=1&per_page=20']);
    assert.ok(second.calls[0].headers.cookie.includes(`access_token_web=${renewed}`));
    assert.ok(fake.calls.concat(second.calls).every((call) => call.method === 'GET' || isSessionRenewalRequest(call.method, call.url)), 'nothing but GETs and the renewal');
  } finally { context.close(); }
});

test('Vinted: listing lookups are capped per call, unread first, and redone only when a conversation moves', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: T });
  const conversations = Array.from({ length: 8 }, (_, index) => ({
    id: 8001 + index, description: `Wiadomość ${index}`, unread: index >= 6, updated_at: new Date(T - (index + 1) * 3_600_000).toISOString(), opposite_user: { id: 600 + index, login: `user_${index}` },
  }));
  const fake = marketplace((_call, url) => {
    if (url.pathname === '/api/v2/inbox') return json({ conversations });
    const id = Number(/^\/api\/v2\/conversations\/(\d+)$/.exec(url.pathname)?.[1]);
    const listed = conversations.find((entry) => entry.id === id);
    if (!listed) return json({}, 404);
    return json({ conversation: {
      id, read_by_current_user: !listed.unread, opposite_user: listed.opposite_user,
      messages: [{ entity_type: 'message', entity: { id: id * 10, body: listed.description, user_id: listed.opposite_user.id }, created_at_ts: listed.updated_at }],
      transaction: { item_ids: [id + 1_000], current_user_side: 'seller', item_title: `Przedmiot ${id}` },
    } });
  });
  const context = fixture(fake.fetch);
  try {
    context.service.saveMarketplaceSession('Vinted', 'test', vintedState(TS + 3_600));
    const looked = (from: number) => fake.paths(from).filter((path) => path.includes('/conversations/')).map((path) => path.split('/').at(-1));

    const first = await context.service.inboxForAgent({ marketplace: 'Vinted' });
    assert.deepEqual(looked(0), ['8007', '8008', '8001', '8002', '8003']);
    assert.deepEqual(first.conversations.map((entry) => entry.listingKey), ['Vinted:9001', 'Vinted:9002', 'Vinted:9003', null, null, null, 'Vinted:9007', 'Vinted:9008']);

    t.mock.timers.tick(61_000);
    let from = fake.calls.length;
    const second = await context.service.inboxForAgent({ marketplace: 'Vinted' });
    assert.deepEqual(looked(from), ['8004', '8005', '8006']);
    assert.ok(second.conversations.every((entry) => entry.listingKey && entry.role === 'sell'));

    t.mock.timers.tick(61_000);
    from = fake.calls.length;
    await context.service.inboxForAgent({ marketplace: 'Vinted' });
    assert.deepEqual(fake.paths(from), ['GET /api/v2/inbox?page=1&per_page=20'], 'nothing left to look up');

    conversations[2] = { ...conversations[2], description: 'Nowa wiadomość', updated_at: new Date(T + 100_000).toISOString() };
    t.mock.timers.tick(61_000);
    from = fake.calls.length;
    const moved = await context.service.inboxForAgent({ marketplace: 'Vinted' });
    assert.deepEqual(looked(from), ['8003']);
    assert.deepEqual([moved.conversations.find((entry) => entry.id === 'Vinted:8003')?.lastMessage?.id, moved.conversations.find((entry) => entry.id === 'Vinted:8003')?.lastMessage?.direction], ['80030', 'in']);
  } finally { context.close(); }
});

test('Vinted: a 401 renews once and retries; a refused renewal asks to re-import the session', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: T });
  let inboxCalls = 0;
  let renewal: () => Response = () => vintedRenewal(jwt(TS + 3_000), 'refresh-2');
  const fake = marketplace((call, url) => {
    if (call.method === 'POST') return renewal();
    if (url.pathname === '/api/v2/inbox') return (inboxCalls += 1) === 1 ? json({ code: 100 }, 401) : json({ conversations: [] });
    return json({}, 500);
  });
  const context = fixture(fake.fetch);
  try {
    context.service.saveMarketplaceSession('Vinted', 'test', vintedState(TS + 3_600));
    assert.equal((await context.service.inboxForAgent({ marketplace: 'Vinted' })).count, 0);
    assert.deepEqual(fake.paths(), ['GET /api/v2/inbox?page=1&per_page=20', 'POST /web/api/auth/refresh', 'GET /api/v2/inbox?page=1&per_page=20']);
    assert.ok(fake.calls[2].headers.cookie.includes(`access_token_web=${jwt(TS + 3_000)}`), 'the retry carries the renewed token');

    context.service.saveMarketplaceSession('Vinted', 'test', vintedState(TS - 60));
    renewal = () => json({ code: 100, message: 'invalid refresh token' }, 401);
    const from = fake.calls.length;
    await assert.rejects(context.service.inboxForAgent({ marketplace: 'Vinted' }), { status: 401, message: /Vinted session has expired or was signed out: re-import the session/ });
    assert.deepEqual(fake.paths(from), ['POST /web/api/auth/refresh'], 'no read is tried on an expired session');
    assert.deepEqual([sessionRow(context.service, 'Vinted').connected, sessionRow(context.service, 'Vinted').detail], [false, 'Vinted session has expired or was signed out: re-import the session (npm run marketplace:login, then Settings → Marketplace accounts)']);

    context.service.saveMarketplaceSession('Vinted', 'test', vintedState(TS + 3_600));
    assert.equal(sessionRow(context.service, 'Vinted').connected, true, 're-importing clears it');
  } finally { context.close(); }
});

test('OLX: renews through the OAuth grant, reads with the bearer token, and serves threads from the list', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: T });
  const renewed = jwt(TS + 900);
  const fake = marketplace((call, url) => {
    if (call.method === 'POST' && url.href === 'https://login.olx.pl/oauth2/token') return json({ access_token: renewed, refresh_token: 'olx-refresh-2', expires_in: 900, token_type: 'Bearer' });
    if (url.hostname === 'api.chat.olx.pl' && url.pathname === '/api/conversations') {
      if (url.searchParams.get('offset')) return json(fixtures.olx.older);
      return json(url.searchParams.get('unread') === '1' ? fixtures.olx.unread : fixtures.olx.read);
    }
    return json({}, 500);
  });
  const context = fixture(fake.fetch);
  try {
    context.service.saveMarketplaceSession('OLX', 'test', olxState(TS - 10));
    const inbox = await context.service.inboxForAgent({ marketplace: 'OLX' });
    assert.deepEqual(fake.paths(), [
      'POST /oauth2/token',
      'GET /api/conversations?archived=0&unread=1&limit=40',
      'GET /api/conversations?archived=0&unread=0&limit=40',
    ]);
    assert.deepEqual(Object.fromEntries(new URLSearchParams(fake.calls[0].body)), { client_id: 'olx-client', redirect_uri: 'https://www.olx.pl/d/callback/', grant_type: 'refresh_token', refresh_token: 'olx-refresh-1' });
    for (const call of fake.calls.slice(1)) {
      assert.equal(call.headers.authorization, `Bearer ${renewed}`);
      assert.equal(call.headers.cookie, `access_token=${renewed}`, 'the www-only cookie stays on www.olx.pl');
    }
    assert.deepEqual([inbox.count, inbox.unread, inbox.conversations.map((entry) => [entry.id, entry.role, entry.unread])], [2, 1, [[`OLX:${OLX_A}`, 'buy', true], [`OLX:${OLX_B}`, 'sell', false]]]);
    assert.equal(inbox.conversations[0].lastMessage?.text, 'Mogę zejść do 1400, odbiór w Krakowie.', 'an unread conversation listed in both lists keeps its messages');

    const thread = await context.service.conversationForAgent({ id: `OLX:${OLX_A}` });
    assert.equal(fake.calls.length, 3, 'the list already holds the messages');
    assert.deepEqual([thread.cached, thread.fetchedAt, thread.listingKey, thread.messages.map((message) => message.offer?.amount ?? null)], [true, new Date(T).toISOString(), 'OLX:900000001', [null, 1300, 1400, null]]);
    assert.equal('rawId' in thread || 'subject' in thread, false);

    const older = await context.service.conversationForAgent({ id: `OLX:${OLX_C}` });
    assert.deepEqual(fake.paths(3), ['GET /api/conversations?archived=0&unread=0&limit=40&offset=40']);
    assert.deepEqual([older.cached, older.role, older.messages[0].text], [false, 'buy', 'Sprzedane, przepraszam.']);
    await assert.rejects(context.service.conversationForAgent({ id: 'OLX:0a1b2c3d-0000-4000-8000-000000000999' }), { status: 404, message: 'Conversation not found among the newest 120 OLX conversations' });
    assert.equal(fake.calls.length, 5, 'a short page ends the search');
    assert.ok(fake.calls.every((call) => call.method === 'GET' || isSessionRenewalRequest(call.method, call.url)));

    // The rotated refresh token was saved: a restart spends it, not the first one.
    let first = true;
    const second = marketplace((call, url) => {
      if (call.method === 'POST') return json({ access_token: jwt(TS + 1_800), refresh_token: 'olx-refresh-3', expires_in: 900 });
      if (url.pathname === '/api/conversations') {
        if (first) { first = false; return json({ error: 'invalid_token' }, 401); }
        return json({ data: [], metadata: { total_elements: 0 } });
      }
      return json({}, 500);
    });
    const restarted = new ScoutService(context.db, () => {}, { suggestVariantGroups: async () => [], inboxFetch: second.fetch });
    assert.equal((await restarted.inboxForAgent({ marketplace: 'OLX' })).count, 0);
    assert.deepEqual(second.paths().slice(0, 3), ['GET /api/conversations?archived=0&unread=1&limit=40', 'POST /oauth2/token', 'GET /api/conversations?archived=0&unread=1&limit=40']);
    assert.equal(second.calls[0].headers.authorization, `Bearer ${renewed}`);
    assert.equal(new URLSearchParams(second.calls[1].body).get('refresh_token'), 'olx-refresh-2');
    assert.equal(second.calls[2].headers.authorization, `Bearer ${jwt(TS + 1_800)}`);
  } finally { context.close(); }
});

test('Allegro Lokalnie: finds listings through the subject, and stops reading if opening a conversation marked it read', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: T });
  let seen = false;
  let markReadOnOpen = false;
  const fake = marketplace((_call, url) => {
    if (url.pathname === '/api/chat/inbox') {
      return json({ ...fixtures.allegroLokalnie.inbox, entries: fixtures.allegroLokalnie.inbox.entries.map((entry: { id: string }) => (entry.id === AL_A ? { ...entry, is_unseen: !seen } : entry)) });
    }
    if (url.pathname === '/api/chat/subject') return json(fixtures.allegroLokalnie.subjects[url.searchParams.get('subject_id')!] ?? {});
    if (url.pathname === '/api/chat/messages') {
      if (markReadOnOpen) seen = true;
      return json(fixtures.allegroLokalnie.messages[url.searchParams.get('conversation_id')!] ?? { messages: [] });
    }
    if (url.pathname.startsWith('/api/chat/inbox/')) return json({}, 404);
    return json({}, 500);
  });
  const context = fixture(fake.fetch);
  try {
    context.service.saveMarketplaceSession('Allegro Lokalnie', 'test', allegroState);
    const inbox = await context.service.inboxForAgent({ marketplace: 'Allegro Lokalnie' });
    assert.deepEqual(fake.paths(), [
      'GET /api/chat/inbox?page_size=20&page=1',
      'GET /api/chat/subject?subject_type=buying_intent&subject_id=5e6f7a8b-0000-4000-8000-0000000000e1',
      'GET /api/chat/subject?subject_type=transaction&subject_id=5e6f7a8b-0000-4000-8000-0000000000e2',
      'GET /api/chat/subject?subject_type=buying_intent&subject_id=5e6f7a8b-0000-4000-8000-0000000000e3',
    ]);
    assert.ok(fake.calls.every((call) => call.headers.cookie === '_ui_key=al-session' && !call.headers.authorization));
    assert.deepEqual(inbox.conversations.map((entry) => [entry.listingKey, entry.role, entry.unread]), [
      ['Allegro Lokalnie:5e6f7a8b-0000-4000-8000-00000000f001', 'sell', true],
      ['Allegro Lokalnie:5e6f7a8b-0000-4000-8000-00000000f002', 'buy', false],
      ['Allegro Lokalnie:5e6f7a8b-0000-4000-8000-00000000f003', 'sell', false],
    ]);

    // Opening an unread conversation that stays unread: no warning.
    let from = fake.calls.length;
    const open = await context.service.conversationForAgent({ id: `Allegro Lokalnie:${AL_A}` });
    assert.deepEqual(fake.paths(from), [
      'GET /api/chat/inbox?page_size=20&page=1',
      `GET /api/chat/messages?conversation_id=${AL_A}`,
      'GET /api/chat/inbox?page_size=20&page=1',
    ], 'an unread conversation is checked against a fresh list before and after');
    assert.deepEqual([open.warning, open.unread, open.listingKey, open.messages.map((message) => message.type)], [undefined, true, 'Allegro Lokalnie:5e6f7a8b-0000-4000-8000-00000000f001', ['text', 'event', 'offer']]);
    assert.equal((await context.service.conversationForAgent({ id: `Allegro Lokalnie:${AL_A}` })).cached, true);
    await assert.rejects(context.service.conversationForAgent({ id: 'Allegro Lokalnie:5e6f7a8b-0000-4000-8000-000000000009' }), { status: 404, message: 'Conversation not found' });

    // Opening it marks it read: Scout says so once, then refuses until the session is re-imported.
    t.mock.timers.tick(61_000);
    markReadOnOpen = true;
    const flipped = await context.service.conversationForAgent({ id: `Allegro Lokalnie:${AL_A}` });
    assert.match(flipped.warning ?? '', /^Scout stopped reading Allegro Lokalnie conversations: opening Allegro Lokalnie:5e6f7a8b-0000-4000-8000-000000000001 marked it read/);
    await assert.rejects(context.service.conversationForAgent({ id: `Allegro Lokalnie:${AL_B}` }), { status: 409, message: flipped.warning });
    from = fake.calls.length;
    const stillListed = await context.service.inboxForAgent({ marketplace: 'Allegro Lokalnie' });
    assert.deepEqual([stillListed.cached, stillListed.unread, fake.calls.length - from], [true, 0, 0], 'scout_inbox still works');

    context.service.saveMarketplaceSession('Allegro Lokalnie', 'test', allegroState);
    from = fake.calls.length;
    const reopened = await context.service.conversationForAgent({ id: `Allegro Lokalnie:${AL_C}` });
    assert.deepEqual([reopened.warning, reopened.messages, reopened.listingKey], [undefined, [], 'Allegro Lokalnie:5e6f7a8b-0000-4000-8000-00000000f003']);
    assert.deepEqual(fake.paths(from), [
      'GET /api/chat/inbox?page_size=20&page=1',
      `GET /api/chat/messages?conversation_id=${AL_C}`,
      'GET /api/chat/subject?subject_type=buying_intent&subject_id=5e6f7a8b-0000-4000-8000-0000000000e3',
    ], 're-importing starts afresh');
    assert.ok(fake.calls.every((call) => call.method === 'GET'));
  } finally { context.close(); }
});

test('Allegro Lokalnie: unreachable, blocked, HTML and signed-out responses are plain errors', async () => {
  let respond: () => Response | Promise<Response> = () => Promise.reject(new TypeError('fetch failed'));
  const fake = marketplace(() => respond());
  const context = fixture(fake.fetch);
  try {
    context.service.saveMarketplaceSession('Allegro Lokalnie', 'test', allegroState);
    const inbox = () => context.service.inboxForAgent({ marketplace: 'Allegro Lokalnie' });
    await assert.rejects(inbox(), { status: 502, message: 'Allegro Lokalnie could not be reached; try again later' });
    respond = () => json({ error: 'blocked' }, 403);
    await assert.rejects(inbox(), { status: 502, message: /refused the request \(HTTP 403\)/ });
    respond = () => new Response('<html>Zaloguj się</html>', { status: 200, headers: { 'content-type': 'text/html' } });
    await assert.rejects(inbox(), { status: 502, message: 'Allegro Lokalnie returned a page instead of data' });
    assert.equal(sessionRow(context.service, 'Allegro Lokalnie').connected, true);
    respond = () => new Response(null, { status: 302, headers: { location: 'https://allegrolokalnie.pl/logowanie' } });
    await assert.rejects(inbox(), { status: 401, message: /Allegro Lokalnie session has expired or was signed out: re-import the session/ });
    assert.equal(sessionRow(context.service, 'Allegro Lokalnie').connected, false);
    assert.equal(fake.calls.length, 4, 'errors are not cached and nothing is retried');
  } finally { context.close(); }
});

// ---- Shared sessions and session checks ------------------------------------------------

test('a shared session has no refresh tokens, so the app\'s browser cannot rotate Scout\'s', () => {
  const vinted = withoutRefreshTokens(vintedState(TS + 3_600));
  assert.deepEqual(vinted.cookies.map((cookie) => cookie.name), ['access_token_web', 'anon_id']);
  const olx = olxState(TS + 900);
  const stripped = withoutRefreshTokens(olx);
  const cache = JSON.parse(stripped.origins[0].localStorage!.find((item) => item.name === OLX_KEY)!.value);
  assert.equal(cache.body.refresh_token, undefined);
  assert.equal(cache.body.access_token, jwt(TS + 900), 'the access token stays');
  assert.deepEqual(stripped.cookies, olx.cookies);
  assert.match(JSON.stringify(olx), /olx-refresh-1/, 'the input is left alone');
});

test('sharing a Vinted session renews an expiring token first and moves the revision', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: T });
  const fake = marketplace((call) => (call.method === 'POST' ? vintedRenewal(jwt(TS + 7_200), 'refresh-2') : json({}, 500)));
  const context = fixture(fake.fetch, true);
  try {
    context.service.saveMarketplaceSession('Vinted', 'test', vintedState(TS - 60));
    context.service.shareMarketplaceSession('Vinted', true);
    const before = createRevision(ciphertext(context.db, 'Vinted'));
    const [listed] = await context.service.sharedMarketplaceSessions();
    assert.deepEqual(fake.paths(), ['POST /web/api/auth/refresh']);
    assert.notEqual(listed.revision, before, 'the renewal shows as a new revision');
    const shared = await context.service.sharedMarketplaceSession('Vinted');
    assert.equal(shared.revision, listed.revision);
    assert.equal(fake.calls.length, 1, 'a fresh token is not renewed again');
    assert.deepEqual(shared.storageState.cookies.map((cookie) => [cookie.name, cookie.value]), [['access_token_web', jwt(TS + 7_200)], ['anon_id', 'anon-1']]);
    assert.match(JSON.stringify((context.service as any).readMarketplaceSession('Vinted')), /refresh-2/, 'Scout keeps the rotated refresh token');
  } finally { context.close(); }
});

test('a session check after a refused renewal reads signed out, and one after a renewal is recorded', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: T });
  let renewal = () => json({ code: 100 }, 401);
  const fake = marketplace(() => renewal());
  const context = fixture(fake.fetch);
  const probed: string[] = [];
  (context.service as any).probeMarketplaceSession = async (_: string, state: MarketplaceStorageState) => {
    probed.push(cookieHeader(state, new URL('https://www.vinted.pl/'), TS));
    return renewal === refused
      ? { signedIn: null, detail: 'The account page went to renew an expired access token (www.vinted.pl/session-refresh)' }
      : { signedIn: true, detail: 'Signed in: the account page opened' };
  };
  const refused = renewal;
  try {
    context.service.saveMarketplaceSession('Vinted', 'test', vintedState(TS - 60));
    const out = await context.service.checkMarketplaceSession('Vinted');
    assert.equal(out.signedIn, false);
    assert.match(out.detail, /^Signed out: Vinted refused to renew the session's token; The account page went to renew/);
    assert.equal(sessionRow(context.service, 'Vinted').signedIn, false);

    renewal = () => vintedRenewal(jwt(TS + 7_200), 'refresh-2');
    context.service.saveMarketplaceSession('Vinted', 'test', vintedState(TS - 60));
    const renewed = await context.service.checkMarketplaceSession('Vinted');
    assert.equal(renewed.signedIn, true);
    assert.match(probed[1], new RegExp(`access_token_web=${jwt(TS + 7_200)}`), 'the probe used the renewed token');
    assert.equal(sessionRow(context.service, 'Vinted').signedIn, true, 'the renewal rewrote the row, and the check still landed');
  } finally { context.close(); }
});
