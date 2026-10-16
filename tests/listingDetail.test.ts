import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase } from '../server/db';
import { ScoutService } from '../server/service';
import type { CompactListingDetail, ListingDetail, ListingLiveCheck, ListingNegotiation } from '../src/types';

if (process.env.SCOUT_JEV_MODE === undefined) process.env.SCOUT_JEV_MODE = 'legacy';

type Full = ListingDetail & { negotiation: ListingNegotiation; liveCheck: ListingLiveCheck | null };

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'scout-listing-detail-'));
  const db = openDatabase(join(directory, 'scout.sqlite'));
  const service = new ScoutService(db, () => {}, { suggestVariantGroups: async () => [] });
  return { db, service, close: () => { db.close(); rmSync(directory, { recursive: true, force: true }); } };
}

const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

function seedWatch(db: any, id: string, query: string) {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO watches (id, name, query, sources_json, enabled, next_scan_at, created_at, updated_at) VALUES (?, ?, ?, '["OLX","Allegro Lokalnie"]', 1, ?, ?, ?)`).run(id, `${id} name`, query, now, now, now);
}

function insertListing(db: any, values: { marketplace?: string; id: string; title: string; price: number; url?: string; postedAt?: string | null; firstSeen: string; lastSeen: string; negotiable?: number | null; sellerId?: string | null; sellerType?: string | null }) {
  const marketplace = values.marketplace ?? 'OLX';
  const url = values.url ?? `https://www.olx.pl/d/oferta/test-CID99-ID${values.id}.html`;
  return db.prepare(`INSERT INTO listings (marketplace, listing_id, title, price_pln, url, condition, posted_at, first_seen_at, last_seen_at, price_negotiable, seller_id, seller_type, availability_status)
    VALUES (?, ?, ?, ?, ?, 'Używane', ?, ?, ?, ?, ?, ?, 'live')`).run(marketplace, values.id, values.title, values.price, url, values.postedAt ?? null, values.firstSeen, values.lastSeen,
    values.negotiable ?? null, values.sellerId ?? null, values.sellerType ?? null).lastInsertRowid;
}

/** An OLX listing in a watch with four observed prices, plus three more listings by the same seller. */
function seedSellerScenario(db: any) {
  seedWatch(db, 'gpus', 'rtx 3080');
  const rowId = insertListing(db, { id: '11', title: 'RTX 3080 Gaming OC', price: 1800, postedAt: daysAgo(10), firstSeen: daysAgo(5), lastSeen: daysAgo(0.1), negotiable: 1, sellerId: '1001', sellerType: 'private' });
  const observe = db.prepare('INSERT INTO observations (listing_id, watch_id, price_pln, observed_at) VALUES (?, ?, ?, ?)');
  [[2000, 5], [1900, 3], [1950, 2], [1800, 1]].forEach(([price, days]) => observe.run(rowId, 'gpus', price, daysAgo(days)));
  insertListing(db, { id: '12', title: 'GTX 1080', price: 600, firstSeen: daysAgo(2), lastSeen: daysAgo(1), sellerId: '1001' });
  insertListing(db, { id: '13', title: 'RTX 3080 Gaming', price: 2200, firstSeen: daysAgo(30), lastSeen: daysAgo(6), sellerId: '1001' });
  insertListing(db, { id: '14', title: 'Monitor 27', price: 400, firstSeen: daysAgo(40), lastSeen: daysAgo(20), sellerId: '1001' });
  insertListing(db, { id: '15', title: 'RTX 3080 Gaming', price: 1700, firstSeen: daysAgo(3), lastSeen: daysAgo(0.2), sellerId: '9999' });
}

function olxOffer(id: number, price: number, overrides: Record<string, unknown> = {}) {
  return {
    id, url: `https://www.olx.pl/d/oferta/test-CID99-ID${id}.html`, title: `RTX 3080 offer ${id}`, status: 'active', business: false, description: '<p>Opis.</p>',
    params: [{ key: 'price', value: { value: price, currency: 'PLN', negotiable: false } }], user: { id: 1001, name: 'Seller A' }, ...overrides,
  };
}

test('the negotiation block comes from stored rows: days listed, price cuts, flag, seller and relists', async () => {
  const context = fixture();
  try {
    seedSellerScenario(context.db);
    const compact = await context.service.listingDetailForAgent('OLX:11', { format: 'compact' }) as CompactListingDetail;
    assert.deepEqual(compact.negotiation, {
      daysListed: 10,
      listedSince: 'posted',
      priceDrops: { count: 2, total: 250, lastAt: compact.negotiation.priceDrops.lastAt, firstPrice: 2000 },
      priceNegotiable: true,
      seller: {
        id: '1001', name: null, type: 'private', source: 'scan',
        otherListings: { source: 'scout', total: 1, items: [{ key: 'OLX:12', title: 'GTX 1080', price: 600, condition: 'Używane', url: 'https://www.olx.pl/d/oferta/test-CID99-ID12.html', lastSeenAt: compact.negotiation.seller!.otherListings.items[0].lastSeenAt }] },
      },
      relists: [{ key: 'OLX:13', price: 2200, firstSeenAt: compact.negotiation.relists![0].firstSeenAt, lastSeenAt: compact.negotiation.relists![0].lastSeenAt }],
    });
    assert.ok(compact.negotiation.priceDrops.lastAt! > daysAgo(1.5));
    assert.deepEqual(Object.keys(compact).sort(), ['listing', 'liveCheck', 'negotiation']);
    assert.equal(compact.liveCheck, null);
    assert.deepEqual([compact.listing.key, compact.listing.marketplace, compact.listing.price, compact.listing.watchId, compact.listing.shipping, compact.listing.priceNegotiable], ['OLX:11', 'OLX', 1800, 'gpus', null, true]);
    assert.ok(compact.listing.postedAt! < daysAgo(9.9));

    const withHistory = await context.service.listingDetailForAgent('OLX:11', { format: 'compact', include: ['history', 'description'] }) as CompactListingDetail;
    assert.deepEqual([withHistory.history?.map((point) => point.price), withHistory.description], [[2000, 1900, 1950, 1800], null]);

    // The default stays the full shape, now with the negotiation block.
    const full = await context.service.listingDetailForAgent('OLX:11') as Full;
    assert.equal(full.history.length, 4);
    assert.ok('descriptionSnapshot' in full && 'verificationTrace' in full && 'action' in full);
    assert.deepEqual([full.negotiation.priceDrops.count, full.liveCheck], [2, null]);
  } finally { context.close(); }
});

test('live checks the page and the seller\'s listings in two requests and writes nothing', async () => {
  const context = fixture();
  try {
    seedSellerScenario(context.db);
    const requests: string[] = [];
    (context.service as any).fetchOlxApi = async (url: string) => {
      requests.push(url);
      if (url.includes('user_id=1001')) return { status: 200, json: { data: [olxOffer(11, 1700), olxOffer(21, 300), olxOffer(22, 350)], metadata: { total_elements: 3, visible_total_count: 3 } } };
      return { status: 200, json: { data: olxOffer(11, 1700) } };
    };
    const before = JSON.stringify(context.db.prepare('SELECT * FROM listings ORDER BY id').all());
    const result = await context.service.listingDetailForAgent('OLX:11', { format: 'compact', include: ['description'], live: true, sellerListings: true }) as CompactListingDetail;
    assert.deepEqual(requests, ['https://www.olx.pl/api/v1/offers/11/', 'https://www.olx.pl/api/v1/offers/?offset=0&limit=11&user_id=1001']);
    assert.deepEqual({ ...result.liveCheck, checkedAt: 'x' }, { checkedAt: 'x', availability: { status: 'live' }, price: 1700, priceChanged: true, description: 'Opis.' });
    assert.equal(result.description, 'Opis.');
    assert.equal(result.negotiation.priceNegotiable, false, 'the live page wins over the stored flag');
    assert.deepEqual([result.negotiation.seller?.name, result.negotiation.seller?.source], ['Seller A', 'scan']);
    assert.deepEqual(result.negotiation.seller?.otherListings, {
      source: 'marketplace', total: 2,
      items: [
        { key: 'OLX:21', title: 'RTX 3080 offer 21', price: 300, condition: null, url: 'https://www.olx.pl/d/oferta/test-CID99-ID21.html' },
        { key: 'OLX:22', title: 'RTX 3080 offer 22', price: 350, condition: null, url: 'https://www.olx.pl/d/oferta/test-CID99-ID22.html' },
      ],
    });
    assert.equal(JSON.stringify(context.db.prepare('SELECT * FROM listings ORDER BY id').all()), before);

    // Compact output leaves the live description out unless included.
    const plain = await context.service.listingDetailForAgent('OLX:11', { format: 'compact', live: true }) as CompactListingDetail;
    assert.equal('description' in plain.liveCheck!, false);
  } finally { context.close(); }
});

test('a gone listing is terminal; a failed seller lookup is reported in place', async () => {
  const context = fixture();
  try {
    seedSellerScenario(context.db);
    (context.service as any).fetchOlxApi = async (url: string) => (url.includes('user_id=')
      ? { status: 503, json: null }
      : { status: 404, json: { error: { detail: 'Not found' } } });
    const result = await context.service.listingDetailForAgent('OLX:11', { live: true, sellerListings: true }) as Full;
    assert.deepEqual([result.liveCheck?.availability.status, result.liveCheck?.price, result.liveCheck?.priceChanged], ['terminal', null, false]);
    assert.deepEqual(result.negotiation.seller?.otherListings, { source: 'marketplace', total: null, items: [], error: 'OLX offers API returned HTTP 503' });
  } finally { context.close(); }
});

test('Allegro Lokalnie learns the seller from the offer page, then reads the profile', async () => {
  const context = fixture();
  try {
    seedWatch(context.db, 'decks', 'steam deck');
    insertListing(context.db, { marketplace: 'Allegro Lokalnie', id: 'deck-1', title: 'Steam Deck 512', price: 1500, url: 'https://allegrolokalnie.pl/oferta/deck-1', firstSeen: daysAgo(3), lastSeen: daysAgo(0.1) });
    const product = `<script type="application/ld+json">${JSON.stringify({ '@type': 'Product', name: 'Steam Deck 512', description: 'Sprzedam.', url: 'https://allegrolokalnie.pl/oferta/deck-1', offers: { price: '1450' } })}</script>`;
    const seller = '<script>{&quot;seller&quot;:{&quot;id&quot;:&quot;0000-uuid&quot;,&quot;name&quot;:&quot;Ala (Client:42)&quot;,&quot;type&quot;:&quot;individual&quot;}}</script>';
    const profile = `<script type="application/ld+json">${JSON.stringify({ '@type': 'ItemList', itemListElement: [
      { position: 1, item: { name: 'Steam Deck 512', url: 'https://allegrolokalnie.pl/oferta/deck-1', offers: { price: '1450' } } },
      { position: 2, item: { name: 'Etui', url: 'https://allegrolokalnie.pl/oferta/etui-2', offers: { price: '50' } } },
    ] })}</script>`;
    const pages: string[] = [];
    (context.service as any).fetchPublicPage = async (url: string) => {
      pages.push(url);
      return url.includes('/uzytkownik/') ? profile : `<html><body>${product}${seller}<button>Kup teraz</button></body></html>`;
    };
    const none = await context.service.listingDetailForAgent('Allegro Lokalnie:deck-1', { format: 'compact' }) as CompactListingDetail;
    assert.deepEqual([none.negotiation.seller, none.negotiation.relists, none.negotiation.listedSince, pages.length], [null, null, 'first-seen', 0]);

    const result = await context.service.listingDetailForAgent('Allegro Lokalnie:deck-1', { format: 'compact', sellerListings: true }) as CompactListingDetail;
    assert.deepEqual(pages, ['https://allegrolokalnie.pl/oferta/deck-1', 'https://allegrolokalnie.pl/uzytkownik/Client%3A42']);
    assert.deepEqual([result.liveCheck?.availability.status, result.liveCheck?.price], ['live', 1450]);
    assert.deepEqual(result.negotiation.seller, {
      id: 'Client:42', name: 'Ala', type: 'private', source: 'live',
      otherListings: { source: 'marketplace', total: null, items: [{ key: 'Allegro Lokalnie:etui-2', title: 'Etui', price: 50, condition: null, url: 'https://allegrolokalnie.pl/oferta/etui-2' }] },
    });
  } finally { context.close(); }
});

test('scans store the seller id and keep it when a later payload omits it', async () => {
  const context = fixture();
  try {
    seedWatch(context.db, 'gpus', 'rtx 3080');
    const row = context.db.prepare('SELECT * FROM watches WHERE id = ?').get('gpus');
    const respond = (offer: Record<string, unknown>) => async () => ({ status: 200, json: { data: [{ ...offer, created_time: new Date().toISOString() }], metadata: { visible_total_count: 1 } } });
    (context.service as any).fetchOlxApi = respond(olxOffer(31, 1500));
    await (context.service as any).runWatch(row);
    (context.service as any).fetchOlxApi = respond(olxOffer(31, 1450, { user: undefined }));
    await (context.service as any).runWatch(row);
    assert.deepEqual({ ...context.db.prepare("SELECT seller_id, price_pln FROM listings WHERE listing_id = '31'").get() as object }, { seller_id: '1001', price_pln: 1450 });
  } finally { context.close(); }
});
