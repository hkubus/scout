import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import sharp from 'sharp';
import { openDatabase } from '../server/db';
import { FlipStore, sniffImageMime } from '../server/flips';
import { ScoutService } from '../server/service';
import { MCP_DASHBOARD_LISTINGS, SCOUT_MCP_LISTING_TOOL_NAMES, SCOUT_MCP_SESSION_TOOL_NAMES, SCOUT_MCP_TOOL_NAMES, createScoutMcpServer } from '../server/mcp';

if (process.env.SCOUT_JEV_MODE === undefined) process.env.SCOUT_JEV_MODE = 'legacy';

function fixture(authEnabled = false) {
  const directory = mkdtempSync(join(tmpdir(), 'scout-mcp-'));
  const db = openDatabase(join(directory, 'scout.sqlite'));
  const service = new ScoutService(db, () => {}, { authEnabled });
  const flips = new FlipStore(db);
  return { db, service, flips, close: () => { db.close(); rmSync(directory, { recursive: true, force: true }); } };
}

async function connectedClient(service: ScoutService, flips: FlipStore | null = null, sessions = false) {
  const server = createScoutMcpServer(service, null, flips, sessions);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'scout-mcp-test', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { server, client };
}

function toolText(result: { content: Array<{ type: string; text?: string }> }) {
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, 'text');
  return String(result.content[0].text);
}

test('exposes the documented Scout tool surface', async () => {
  const context = fixture();
  try {
    const { server, client } = await connectedClient(context.service);
    try {
      const listed = await client.listTools();
      assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), [...SCOUT_MCP_TOOL_NAMES].sort());
    } finally {
      await client.close();
      await server.close();
    }
  } finally { context.close(); }
});

test('scout_readiness and scout_dashboard report the empty database truthfully', async () => {
  const context = fixture();
  try {
    const { server, client } = await connectedClient(context.service);
    try {
      const readinessText = toolText(await client.callTool({ name: 'scout_readiness', arguments: {} }) as never);
      const readiness = JSON.parse(readinessText);
      assert.equal(readinessText, JSON.stringify(readiness), 'tool text is compact JSON');
      assert.equal(readiness.database.ok, true);
      assert.ok(readiness.status === 'ready' || readiness.status === 'not-ready');

      const dashboard = JSON.parse(toolText(await client.callTool({ name: 'scout_dashboard', arguments: {} }) as never));
      assert.deepEqual(dashboard.stats, { watching: 0, newToday: 0, strongDeals: 0 });
    } finally {
      await client.close();
      await server.close();
    }
  } finally { context.close(); }
});

test('scout_dashboard returns the head of the feed and flags truncation', async () => {
  const context = fixture();
  try {
    const now = new Date().toISOString();
    context.db.prepare(`INSERT INTO watches (id, name, query, sources_json, enabled, next_scan_at, created_at, updated_at)
      VALUES ('mcp-watch', 'MCP watch', 'cpu', '["OLX"]', 1, ?, ?, ?)`).run(now, now, now);
    const insertRow = context.db.prepare('INSERT INTO listings (marketplace, listing_id, title, price_pln, url, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const insertObservation = context.db.prepare('INSERT INTO observations (listing_id, watch_id, price_pln, observed_at) VALUES (?, ?, ?, ?)');
    const insertListing = (...values: [string, string, string, number, string, string, string]) => {
      const { lastInsertRowid } = insertRow.run(...values);
      insertObservation.run(lastInsertRowid, 'mcp-watch', values[3], now);
    };
    const { server, client } = await connectedClient(context.service);
    try {
      const call = async () => JSON.parse(toolText(await client.callTool({ name: 'scout_dashboard', arguments: {} }) as never));
      for (let index = 0; index < MCP_DASHBOARD_LISTINGS; index += 1) insertListing('OLX', `mcp-${index}`, `Listing ${index}`, 100 + index, `https://www.olx.pl/d/oferta/mcp-${index}`, now, now);
      const full = context.service.dashboard();
      assert.equal(full.listings.length, MCP_DASHBOARD_LISTINGS);
      const exact = await call();
      assert.equal(exact.listingsTruncated, false);
      assert.deepEqual(exact, JSON.parse(JSON.stringify({ ...full, listingsTruncated: false })));

      for (let index = MCP_DASHBOARD_LISTINGS; index < MCP_DASHBOARD_LISTINGS + 7; index += 1) insertListing('OLX', `mcp-${index}`, `Listing ${index}`, 100 + index, `https://www.olx.pl/d/oferta/mcp-${index}`, now, now);
      const dashboard = context.service.dashboard();
      assert.equal(dashboard.listings.length, MCP_DASHBOARD_LISTINGS + 7);
      const truncated = await call();
      assert.equal(truncated.listingsTruncated, true);
      assert.deepEqual(truncated.listings, JSON.parse(JSON.stringify(dashboard.listings.slice(0, MCP_DASHBOARD_LISTINGS))));
      const { listings: _listings, listingsTruncated: _flag, ...rest } = truncated;
      const { listings: _all, ...expectedRest } = dashboard;
      assert.deepEqual(rest, JSON.parse(JSON.stringify(expectedRest)), 'stats, watches and connectors are unchanged');
      const listed = await client.listTools();
      assert.match(String(listed.tools.find((tool) => tool.name === 'scout_dashboard')?.description), /scout_listings/);
    } finally {
      await client.close();
      await server.close();
    }
  } finally { context.close(); }
});

test('scout_listings defaults to a compact page and scout_queue_scan surfaces service errors', async () => {
  const context = fixture();
  try {
    const { server, client } = await connectedClient(context.service);
    try {
      const listings = JSON.parse(toolText(await client.callTool({ name: 'scout_listings', arguments: {} }) as never));
      assert.deepEqual(listings.pagination, { page: 1, pageSize: 20, total: 0, hasNext: false });

      const queued = await client.callTool({ name: 'scout_queue_scan', arguments: {} }) as never as { isError?: boolean; content: Array<{ text?: string }> };
      assert.equal(queued.isError, true);
      assert.match(String(queued.content[0].text), /no enabled watches/i);
    } finally {
      await client.close();
      await server.close();
    }
  } finally { context.close(); }
});

test('the listing tools are offered alongside the others when flips are available', async () => {
  const context = fixture();
  try {
    const { server, client } = await connectedClient(context.service, context.flips);
    try {
      const { tools } = await client.listTools();
      assert.deepEqual(tools.map((tool) => tool.name).sort(), [...SCOUT_MCP_TOOL_NAMES, ...SCOUT_MCP_LISTING_TOOL_NAMES].sort());
      const annotations = Object.fromEntries(tools.map((tool) => [tool.name, tool.annotations]));
      for (const name of ['scout_flips_to_list', 'scout_flip', 'scout_flip_photo']) assert.equal(annotations[name]?.readOnlyHint, true, name);
      assert.deepEqual(annotations.scout_flip_listed, { readOnlyHint: false, destructiveHint: false, idempotentHint: true });
    } finally {
      await client.close();
      await server.close();
    }
  } finally { context.close(); }
});

test('scout_session_status reports each stored session without its cookies', async () => {
  const context = fixture();
  try {
    context.service.saveMarketplaceSession('OLX', 'Personal', { cookies: [{ name: 'session', value: 'private-token', domain: '.olx.pl', path: '/' }], origins: [] });
    const { server, client } = await connectedClient(context.service);
    try {
      const result = await client.callTool({ name: 'scout_session_status', arguments: {} }) as { content: Array<{ type: string; text?: string }> };
      const text = toolText(result);
      assert.doesNotMatch(text, /private-token|cookies/);
      assert.deepEqual(JSON.parse(text), { sessions: [{ marketplace: 'OLX', signedIn: null, checkedAt: null, detail: 'Not checked yet' }] });
    } finally {
      await client.close();
      await server.close();
    }
  } finally { context.close(); }
});

// Hatbot's MCP plugin (apps/brain/src/plugins/mcp/index.ts, moneyKind) makes
// a tool whose name or description reads as a payment or a purchase always
// ask the owner. A copy of its patterns, so the listing tools never trip them.
const PAYS = /\b(pay|pays|paid|paying|payments?|payouts?|checkout|check out|transfers?|transferring|refunds?|withdraw|withdrawals?|money|funds|charges?|spend|spends|spending|donate|donates|donating|donations?|tip|invoices?|wire|deposits?|swap|swaps|swapping|trade|trades|trading|(credit|debit|saved|gift|payment) cards?)\b/i;
const BUYS = /\b(buy|buys|buying|purchase|purchases|purchasing|orders?|ordering|bid|bids|bidding|subscribe|subscriptions?|book|books|booking|reserve|reserves|reserving|reservations?|sell|sells|selling|(make|makes|send|submit|accept)s? offers?)\b/i;
// Stricter than the plugin, which would let some of these through: the handoff keeps them out entirely.
const HANDOFF_WORDS = /\b(pay\w*|checkout|transfer\w*|refund\w*|money|funds|charg\w*|spend\w*|invoic\w*|deposit\w*|trad\w*|buy\w*|purchas\w*|order\w*|bid\w*|subscri\w*|book\w*|reserv\w*|sell\w*|sold|offer\w*)\b/i;

test('the listing tools use no money or selling words in their names and descriptions', async () => {
  const context = fixture();
  try {
    const { server, client } = await connectedClient(context.service, context.flips, true);
    try {
      const { tools } = await client.listTools();
      assert.ok(SCOUT_MCP_SESSION_TOOL_NAMES.every((name) => tools.some((tool) => tool.name === name)));
      for (const tool of tools.filter((item) => ([...SCOUT_MCP_LISTING_TOOL_NAMES, ...SCOUT_MCP_SESSION_TOOL_NAMES] as readonly string[]).includes(item.name))) {
        const words = tool.name.replace(/[_.-]+/g, ' ');
        const parameters = Object.values((tool.inputSchema.properties ?? {}) as Record<string, { description?: string }>).map((property) => property.description ?? '').join(' ');
        for (const text of [`${words} ${tool.description}`, parameters]) {
          assert.doesNotMatch(text, PAYS, tool.name);
          assert.doesNotMatch(text, BUYS, tool.name);
          assert.doesNotMatch(text, HANDOFF_WORDS, tool.name);
        }
      }
      assert.match('Sell it in the posting order', BUYS, 'the copied patterns still catch the words');
    } finally {
      await client.close();
      await server.close();
    }
  } finally { context.close(); }
});

test('Hatbot reads a ready flip, its draft and photos, and records each channel', async () => {
  const context = fixture();
  try {
    const flip = context.flips.create({ title: 'RTX 3070', buyChannel: 'OLX', boughtOn: '2026-10-01', buyPrice: 900 });
    context.flips.setListing(flip.id, {
      title: 'RTX 3070 Gaming OC', description: 'Sprawna.', condition: 'like-new', prices: { OLX: 1199 }, basePrice: 1149,
      delivery: { shipping: true, pickup: false, parcelSize: 'medium' },
    });
    const photo = await context.flips.addPhoto(flip.id, await sharp({ create: { width: 2400, height: 1800, channels: 3, background: '#3a6' } }).png().toBuffer());
    const { server, client } = await connectedClient(context.service, context.flips);
    try {
      const call = async (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args }) as Promise<{ isError?: boolean; content: Array<{ type: string; text?: string }> }>;
      const json = async (name: string, args: Record<string, unknown> = {}) => {
        const result = await call(name, args);
        assert.equal(result.isError, undefined, `${name}: ${result.content[0]?.text}`);
        return JSON.parse(toolText(result));
      };
      assert.deepEqual(await json('scout_flips_to_list'), { flips: [] });
      const unready = await call('scout_flip', { id: flip.id });
      assert.equal(unready.isError, true);
      assert.match(String(unready.content[0].text), /not marked ready to list/);
      assert.equal((await call('scout_flip_photo', { id: photo.id })).isError, true, 'photos of a flip that is not ready stay private');

      const revision = context.flips.markReady(flip.id, ['OLX', 'Vinted']).listingRevisedAt;
      assert.deepEqual(await json('scout_flips_to_list'), { flips: [{ id: flip.id, updatedAt: revision, channels: [{ channel: 'OLX', status: 'ready' }, { channel: 'Vinted', status: 'ready' }] }] });
      assert.deepEqual(await json('scout_flip', { id: flip.id }), {
        id: flip.id, updatedAt: revision, title: 'RTX 3070 Gaming OC', description: 'Sprawna.', condition: 'like-new', category: null,
        delivery: { shipping: true, pickup: false, parcelSize: 'medium' }, prices: { OLX: 1199, Vinted: 1149 }, currency: 'PLN',
        photos: [{ id: photo.id, mime: 'image/jpeg' }],
      });

      const sent = await json('scout_flip_photo', { id: photo.id });
      assert.deepEqual([sent.id, sent.mime], [photo.id, 'image/jpeg']);
      const bytes = Buffer.from(sent.base64, 'base64');
      assert.equal(sniffImageMime(bytes), 'image/jpeg');
      assert.deepEqual(await sharp(bytes).metadata().then(({ width, height }) => [width, height]), [2000, 1500]);

      const refused = await call('scout_flip_listed', { flipId: flip.id, channel: 'OLX', status: 'listed', url: 'https://www.vinted.pl/items/1' });
      assert.equal(refused.isError, true);
      assert.match(String(refused.content[0].text), /not an https:\/\/ address on olx\.pl/);
      assert.equal((await call('scout_flip_listed', { flipId: flip.id, channel: 'OLX', status: 'listed' })).isError, true, 'listed needs a URL');
      assert.equal((await call('scout_flip_listed', { flipId: flip.id, channel: 'Other', status: 'declined' })).isError, true);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        assert.deepEqual(await json('scout_flip_listed', { flipId: flip.id, channel: 'OLX', status: 'listed', url: 'https://www.olx.pl/d/oferta/rtx-3070-CID99-ID1.html' }), { ok: true });
      }
      assert.deepEqual(await json('scout_flip_listed', { flipId: flip.id, channel: 'Vinted', status: 'declined' }), { ok: true });
      assert.deepEqual(await json('scout_flips_to_list'), { flips: [{ id: flip.id, updatedAt: revision, channels: [
        { channel: 'OLX', status: 'listed', url: 'https://www.olx.pl/d/oferta/rtx-3070-CID99-ID1.html' },
        { channel: 'Vinted', status: 'declined' },
      ] }] }, 'recording outcomes never moves updatedAt');
      assert.deepEqual(context.flips.get(flip.id).listedOn, ['OLX']);

      context.flips.cancelReady(flip.id);
      assert.deepEqual(await json('scout_flips_to_list'), { flips: [] });
    } finally {
      await client.close();
      await server.close();
    }
  } finally { context.close(); }
});

const olxState = (value: string) => ({ cookies: [{ name: 'access_token', value, domain: '.olx.pl', path: '/', httpOnly: true, secure: true }], origins: [] });

test('connected apps get only the marketplace sessions the owner shared', async () => {
  const context = fixture(true);
  try {
    context.service.saveMarketplaceSession('OLX', 'Haggler', olxState('first'));
    context.service.saveMarketplaceSession('Vinted', '', { cookies: [{ name: 'v', value: 'x', domain: 'www.vinted.pl', path: '/' }], origins: [] });
    const { server, client } = await connectedClient(context.service, null, true);
    try {
      const list = async () => JSON.parse(toolText(await client.callTool({ name: 'scout_shared_sessions', arguments: {} }) as never)).sessions;
      assert.deepEqual(await list(), []);
      const refused = await client.callTool({ name: 'scout_shared_session', arguments: { marketplace: 'OLX' } }) as never as { isError?: boolean; content: Array<{ type: string; text?: string }> };
      assert.equal(refused.isError, true);
      assert.doesNotMatch(toolText(refused), /first/);

      context.service.shareMarketplaceSession('OLX', true);
      const [shared] = await list();
      assert.deepEqual(Object.keys(shared).sort(), ['label', 'marketplace', 'revision']);
      assert.equal(shared.marketplace, 'OLX');
      const session = JSON.parse(toolText(await client.callTool({ name: 'scout_shared_session', arguments: { marketplace: 'OLX' } }) as never));
      assert.equal(session.revision, shared.revision);
      assert.equal(session.storageState.cookies[0].value, 'first');

      context.service.shareMarketplaceSession('OLX', false);
      context.service.shareMarketplaceSession('OLX', true);
      assert.equal((await list())[0].revision, shared.revision, 'the revision holds until the session is imported again');
      context.service.saveMarketplaceSession('OLX', 'Haggler', olxState('second'));
      assert.notEqual((await list())[0].revision, shared.revision);
      assert.equal(context.service.marketplaceSessions().find((item) => item.marketplace === 'OLX')?.sharedWithApps, true, 're-importing keeps the choice');
    } finally {
      await client.close();
      await server.close();
    }
  } finally { context.close(); }
});

test('the session tools are only offered to connected apps', async () => {
  const context = fixture();
  try {
    const { server, client } = await connectedClient(context.service, context.flips);
    try {
      const { tools } = await client.listTools();
      assert.ok(!tools.some((tool) => (SCOUT_MCP_SESSION_TOOL_NAMES as readonly string[]).includes(tool.name)));
    } finally {
      await client.close();
      await server.close();
    }
  } finally { context.close(); }
});

test('without sign-in, nothing is shared: anyone on the network could connect an app', async () => {
  const context = fixture();
  try {
    context.service.saveMarketplaceSession('OLX', '', olxState('first'));
    assert.throws(() => context.service.shareMarketplaceSession('OLX', true), /sign-in/);
    context.db.prepare('UPDATE marketplace_sessions SET shared_with_apps = 1').run();
    assert.deepEqual(context.service.sharedMarketplaceSessions(), []);
    assert.throws(() => context.service.sharedMarketplaceSession('OLX'), /isn't shared/);
  } finally { context.close(); }
});
