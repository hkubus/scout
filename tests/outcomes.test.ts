import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase } from '../server/db';
import { outcomeShare, shareOfAsking } from '../server/negotiation';
import { ScoutService } from '../server/service';

if (process.env.SCOUT_JEV_MODE === undefined) process.env.SCOUT_JEV_MODE = 'legacy';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'scout-outcomes-'));
  const db = openDatabase(join(directory, 'scout.sqlite'));
  const service = new ScoutService(db, () => {}, { suggestVariantGroups: async () => [] });
  return { db, service, close: () => { db.close(); rmSync(directory, { recursive: true, force: true }); } };
}

/** A watch with six observed listings, `<id>-0` to `<id>-5`. */
function seedWatch(db: any, id: string, query: string, titles: string, prices: number[]) {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO watches (id, name, query, sources_json, enabled, next_scan_at, created_at, updated_at)
    VALUES (?, ?, ?, '["OLX"]', 1, ?, ?, ?)`).run(id, `${id} name`, query, now, now, now);
  const insertListing = db.prepare('INSERT INTO listings (marketplace, listing_id, title, price_pln, url, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const insertObservation = db.prepare('INSERT INTO observations (listing_id, watch_id, price_pln, observed_at) VALUES (?, ?, ?, ?)');
  prices.forEach((price, index) => {
    const listingId = `${id}-${index}`;
    const { lastInsertRowid } = insertListing.run('OLX', listingId, titles, price, `https://www.olx.pl/d/oferta/${listingId}`, now, now);
    insertObservation.run(lastInsertRowid, id, price, now);
  });
}

const gpuPrices = [1900, 1950, 2000, 2000, 2050, 2100];
const outcomeRows = (db: any) => db.prepare('SELECT * FROM negotiation_outcomes ORDER BY id').all() as Array<Record<string, any>>;

test('outcome shares are the median final price over asking among agreed negotiations', () => {
  assert.deepEqual([shareOfAsking(1700, 2000), shareOfAsking(null, 2000), shareOfAsking(1700, 0)], [0.85, null, null]);
  assert.deepEqual(outcomeShare([
    { outcome: 'agreed', asking: 1000, price: 800 },
    { outcome: 'agreed', asking: 2000, price: 1700 },
    { outcome: 'agreed', asking: 1000, price: 900 },
    { outcome: 'lost', asking: 1000, price: 500 },
  ]), { negotiations: 4, agreed: 3, shareOfAsking: 0.85 });
  assert.deepEqual(outcomeShare([{ outcome: 'expired', asking: 1000, price: null }]), { negotiations: 1, agreed: 0, shareOfAsking: null });
});

test('records an outcome once per negotiation id, filed under the listing\'s watch', () => {
  const context = fixture();
  try {
    seedWatch(context.db, 'gpus', 'rtx 3080', 'RTX 3080', gpuPrices);
    const first = context.service.recordOutcome({ negotiationId: 'n1', listingKey: 'OLX:gpus-0', outcome: 'agreed', asking: 2000, price: 1700, currency: 'PLN', rounds: 3, note: 'Picked up in person' });
    assert.match(first.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.deepEqual(first, { negotiationId: 'n1', listingKey: 'OLX:gpus-0', role: 'buy', outcome: 'agreed', asking: 2000, price: 1700, shareOfAsking: 0.85, rounds: 3, date: first.date, watchId: 'gpus', created: true });

    // The same call again changes nothing; a later one updates the same row
    // and keeps the optional fields it leaves out.
    assert.deepEqual(context.service.recordOutcome({ negotiationId: 'n1', listingKey: 'OLX:gpus-0', outcome: 'agreed', asking: 2000, price: 1700, currency: 'PLN', rounds: 3, note: 'Picked up in person' }), { ...first, created: false });
    const updated = context.service.recordOutcome({ negotiationId: 'n1', listingKey: 'OLX:gpus-0', outcome: 'agreed', asking: 2000, price: 1600 });
    assert.deepEqual([updated.price, updated.shareOfAsking, updated.rounds, updated.date, updated.created], [1600, 0.8, 3, first.date, false]);
    const rows = outcomeRows(context.db);
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0].final_price_pln, rows[0].note, rows[0].watch_id, rows[0].marketplace, rows[0].listing_id], [1600, 'Picked up in person', 'gpus', 'OLX', 'gpus-0']);

    // A listing Scout never saw has no watch; a lost one has no share.
    const unknown = context.service.recordOutcome({ negotiationId: 'n2', listingKey: 'Vinted:999', outcome: 'lost', asking: 500, price: null, date: '2026-10-01' });
    assert.deepEqual([unknown.watchId, unknown.price, unknown.shareOfAsking, unknown.date], [null, null, null, '2026-10-01']);
    // A stored listing with no association is placed by its title.
    context.db.prepare("INSERT INTO listings (marketplace, listing_id, title, price_pln, url, first_seen_at, last_seen_at) VALUES ('OLX', 'manual', 'Karta RTX 3080 10GB', 1800, 'https://www.olx.pl/d/oferta/manual', 'now', 'now')").run();
    assert.equal(context.service.recordOutcome({ negotiationId: 'n3', listingKey: 'OLX:manual', outcome: 'abandoned', asking: 1800 }).watchId, 'gpus');
    assert.equal(context.service.recordOutcome({ negotiationId: 'n4', listingKey: 'Vinted:1000', outcome: 'expired', asking: 900, watchId: 'gpus', role: 'sell' }).watchId, 'gpus');

    assert.throws(() => context.service.recordOutcome({ negotiationId: 'n5', listingKey: 'OLX:gpus-1', outcome: 'agreed', asking: 2000 }), /needs its final price/);
    assert.throws(() => context.service.recordOutcome({ negotiationId: 'n5', listingKey: 'OLX:gpus-1', outcome: 'agreed', asking: 2000, price: 400, currency: 'EUR' }), /PLN only/);
    assert.throws(() => context.service.recordOutcome({ negotiationId: 'n5', listingKey: 'Allegro:1', outcome: 'lost', asking: 2000 }), /Invalid listing key/);
    assert.throws(() => context.service.recordOutcome({ negotiationId: 'n5', listingKey: 'OLX:gpus-1', outcome: 'lost', asking: 2000, watchId: 'nope' }), /Watch not found/);
    assert.equal(outcomeRows(context.db).length, 4);

    // The operator's own data: exported like the flip ledger.
    assert.equal((context.service.exportData() as Record<string, unknown[]>).negotiationOutcomes.length, 4);
  } finally { context.close(); }
});

test('scout_price_reference reports outcomes by marketplace and watch, apart from the typical price', () => {
  const context = fixture();
  try {
    seedWatch(context.db, 'gpus', 'rtx 3080', 'RTX 3080', gpuPrices);
    seedWatch(context.db, 'phones', 'iphone 13', 'iPhone 13', [2000, 2000, 2000, 2000]);
    const before = context.service.priceReference({ query: 'rtx 3080' });
    assert.equal(before.outcomes, null);
    assert.ok(before.best && before.best.typicalPrice);

    const record = (negotiationId: string, listingKey: string, asking: number, price: number | null, extra: Record<string, unknown> = {}) =>
      context.service.recordOutcome({ negotiationId, listingKey, outcome: price === null ? 'lost' : 'agreed', asking, price, ...extra });
    record('o1', 'OLX:gpus-0', 1000, 800);
    record('o2', 'OLX:gpus-1', 2000, 1700);
    record('o3', 'OLX:gpus-2', 1000, 900);
    record('o4', 'OLX:gpus-3', 1000, null);
    record('v1', 'Vinted:501', 1000, 700, { watchId: 'gpus' });
    record('a1', 'Allegro Lokalnie:offer-one', 1000, 950, { watchId: 'gpus' });
    record('s1', 'OLX:phones-0', 2000, 1900, { role: 'sell' });

    const after = context.service.priceReference({ query: 'rtx 3080' });
    assert.deepEqual(after.best, before.best, 'outcomes never move the typical price');
    assert.deepEqual(after.outcomes, {
      buy: {
        negotiations: 6, agreed: 5, shareOfAsking: 0.85,
        marketplaces: {
          OLX: { negotiations: 4, agreed: 3, shareOfAsking: 0.85 },
          'Allegro Lokalnie': { negotiations: 1, agreed: 1, shareOfAsking: 0.95 },
          Vinted: { negotiations: 1, agreed: 1, shareOfAsking: 0.7 },
        },
        watches: [{
          id: 'gpus', name: 'gpus name', negotiations: 6, agreed: 5, shareOfAsking: 0.85,
          marketplaces: {
            OLX: { negotiations: 4, agreed: 3, shareOfAsking: 0.85 },
            'Allegro Lokalnie': { negotiations: 1, agreed: 1, shareOfAsking: 0.95 },
            Vinted: { negotiations: 1, agreed: 1, shareOfAsking: 0.7 },
          },
        }],
      },
      // The phones watch is not among this query's matches.
      sell: { negotiations: 1, agreed: 1, shareOfAsking: 0.95, marketplaces: { OLX: { negotiations: 1, agreed: 1, shareOfAsking: 0.95 } }, watches: [] },
    });
    assert.ok(after.notes.some((note) => note.startsWith('outcomes are the final prices')));
    assert.deepEqual(context.service.priceReference({ query: 'iphone 13' }).outcomes?.sell?.watches.map((watch) => watch.id), ['phones']);
  } finally { context.close(); }
});
