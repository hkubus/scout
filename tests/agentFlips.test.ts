import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase } from '../server/db';
import { FlipStore } from '../server/flips';
import { ScoutService } from '../server/service';
import { DEFAULT_FEE_PRESETS } from '../src/profit';

if (process.env.SCOUT_JEV_MODE === undefined) process.env.SCOUT_JEV_MODE = 'legacy';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'scout-agent-flips-'));
  const db = openDatabase(join(directory, 'scout.sqlite'));
  const service = new ScoutService(db, () => {}, { suggestVariantGroups: async () => [] });
  const store = new FlipStore(db);
  return { db, service, store, close: () => { db.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test('scout_flips lists open flips with break-even prices and sold flips with their net', () => {
  const context = fixture();
  try {
    assert.deepEqual(context.service.flipsForAgent(), { feePresets: DEFAULT_FEE_PRESETS, open: { count: 0, items: [] }, sold: { count: 0, items: [] } });

    context.store.setFeePresets({ ...DEFAULT_FEE_PRESETS, OLX: { percent: 8, fixed: 2 } });
    const gpu = context.store.create({ title: 'RTX 3070', listingKey: 'OLX:11', watchId: 'gpus', buyChannel: 'OLX', boughtOn: '2026-10-01', buyPrice: 1000, buyCosts: 20, listedOn: ['OLX', 'Vinted'], note: 'private note' });
    context.store.setListing(gpu.id, { title: 'RTX 3070', description: 'Long description', condition: 'good', prices: { Vinted: 1300 }, basePrice: 1250 });
    context.store.create({ title: 'Steam Deck', buyChannel: 'Vinted', boughtOn: '2026-10-05', buyPrice: 1500 });
    const sold = context.store.create({ title: 'iPhone 13', buyChannel: 'Allegro Lokalnie', boughtOn: '2026-09-01', buyPrice: 1800, buyCosts: 15 });
    context.store.update(sold.id, { soldOn: '2026-09-20', saleChannel: 'Allegro Lokalnie', salePrice: 2300, saleCosts: 10 });

    const all = context.service.flipsForAgent();
    assert.equal(all.feePresets.OLX.percent, 8);
    assert.deepEqual(all.open?.items.map((flip) => flip.title), ['Steam Deck', 'RTX 3070']);
    assert.deepEqual(all.open?.items[1], {
      id: gpu.id, title: 'RTX 3070', listingKey: 'OLX:11', watchId: 'gpus', buyChannel: 'OLX', boughtOn: '2026-10-01', buyPrice: 1000, buyCosts: 20, cost: 1020,
      listedOn: ['OLX', 'Vinted'],
      // Vinted has its own price; the rest fall back to the base price.
      askingPrices: { OLX: 1250, 'Allegro Lokalnie': 1250, Vinted: 1300 },
      // (1020 + 2) / 0.92 on OLX, 1020 / 0.951 on Allegro Lokalnie, the cost itself on Vinted.
      breakEven: { OLX: 1111, 'Allegro Lokalnie': 1073, Vinted: 1020 },
    });
    assert.deepEqual(all.open?.items[0].askingPrices, {}, 'no listing, no asking prices');
    assert.deepEqual(all.sold, {
      count: 1,
      items: [{
        id: sold.id, title: 'iPhone 13', listingKey: null, watchId: null, buyChannel: 'Allegro Lokalnie', boughtOn: '2026-09-01', buyPrice: 1800, buyCosts: 15, cost: 1815,
        soldOn: '2026-09-20', saleChannel: 'Allegro Lokalnie', salePrice: 2300, saleFee: 112.7, saleCosts: 10, net: 362.3,
      }],
    });
    const text = JSON.stringify(all);
    assert.ok(!text.includes('private note') && !text.includes('Long description'), 'notes and listing drafts stay out');

    const open = context.service.flipsForAgent({ status: 'open', limit: 1 });
    assert.deepEqual([Object.keys(open).sort(), open.open?.count, open.open?.items.length], [['feePresets', 'open'], 2, 1]);
    assert.deepEqual(Object.keys(context.service.flipsForAgent({ status: 'sold' })).sort(), ['feePresets', 'sold']);
  } finally { context.close(); }
});
