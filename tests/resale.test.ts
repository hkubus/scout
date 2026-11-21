import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase } from '../server/db';
import { FlipStore } from '../server/flips';
import { ResaleContext, ownSalesFor, type ResaleWatchRow, type SoldFlip } from '../server/resale';
import { DEFAULT_FEE_PRESETS, buyCost, estimateResaleNet, normalizeFeePresets, resaleBasis } from '../src/profit';

const NOW = Date.parse('2026-11-18T12:00:00Z');

test('the resale basis prefers own sales, then the sale band, then 88% of the typical, never above it', () => {
  assert.deepEqual(resaleBasis(1000), { source: 'typical-haircut', resalePrice: 880, samples: null, label: '88% of typical' });
  assert.deepEqual(resaleBasis(1000, { bandP25: 910, bandSamples: 14 }), { source: 'sale-band', resalePrice: 910, samples: 14, label: 'probable-sale p25' });
  // Own sales win over the band; the median of an even count is the midpoint.
  assert.deepEqual(resaleBasis(1000, { ownSales: [700, 900, 820, 760], bandP25: 910 }), { source: 'own-sales', resalePrice: 790, samples: 4, label: 'your 4 recent sales' });
  assert.equal(resaleBasis(1000, { ownSales: [950] })?.label, 'your recent sale');
  // A lucky sale or a thin band never promises more than the market asks.
  assert.equal(resaleBasis(1000, { ownSales: [1400] })?.resalePrice, 1000);
  assert.equal(resaleBasis(1000, { bandP25: 1200 })?.resalePrice, 1000);
  // Unusable evidence falls through to the haircut.
  assert.equal(resaleBasis(1000, { ownSales: [0, Number.NaN], bandP25: null })?.source, 'typical-haircut');
  assert.equal(resaleBasis(null), null);
  assert.equal(resaleBasis(0), null);
});

test('the estimated net takes buying costs on the buy marketplace and the seller fee off the basis', () => {
  // Vinted: 5% buyer protection + 16 zł shipping on a 200 zł buy, no seller fee.
  assert.equal(buyCost(200, DEFAULT_FEE_PRESETS.Vinted), 26);
  assert.equal(buyCost(0, DEFAULT_FEE_PRESETS.Vinted), 0);
  // A preset saved before buy costs existed costs nothing to buy on.
  assert.equal(buyCost(200, { percent: 0, fixed: 0 }), 0);
  assert.deepEqual(estimateResaleNet(200, 300, DEFAULT_FEE_PRESETS.Vinted), {
    net: 38, // 264 − 26 − 200
    basis: { source: 'typical-haircut', resalePrice: 264, samples: null, buyCosts: 26, label: '88% of typical' },
  });
  // Allegro Lokalnie: 4,9% of a 900 zł own-sale basis, nothing to buy there.
  assert.equal(estimateResaleNet(700, 1000, DEFAULT_FEE_PRESETS['Allegro Lokalnie'], { ownSales: [900] })?.net, 156);
  assert.equal(estimateResaleNet(700, null, DEFAULT_FEE_PRESETS.OLX), null);
});

test("OLX's buying cost matches what OLX's checkout charged, capped at 70 zł", () => {
  // SERVICE_FEE from OLX's checkout on 2026-11-21 for computer parts, phones and laptops.
  for (const [price, fee] of [[295, 17.56], [350, 20.09], [500, 26.99], [998, 49.9], [1299, 63.74], [1500, 70], [4000, 70]]) {
    assert.equal(buyCost(price, DEFAULT_FEE_PRESETS.OLX), fee, `${price} zł`);
  }
  // A saved "no cap" (null) stays through saves that leave the cap out; a bad cap falls back.
  const uncapped = normalizeFeePresets({ OLX: { percent: 0, fixed: 0, buyPercent: 4.6, buyFixed: 3.99, buyMax: null } });
  assert.equal(uncapped.OLX.buyMax, null);
  assert.equal(buyCost(2000, uncapped.OLX), 95.99);
  assert.equal(normalizeFeePresets({ OLX: { percent: 8, fixed: 0 } }, uncapped).OLX.buyMax, null);
  assert.equal(normalizeFeePresets({}, uncapped).OLX.buyMax, null);
  assert.equal(normalizeFeePresets({ OLX: { percent: 0, fixed: 0, buyMax: -5 } }).OLX.buyMax, 70);
});

test('fee presets keep saved buying costs when a client sends only seller fees', () => {
  const saved = normalizeFeePresets({ Vinted: { percent: 0, fixed: 0, buyPercent: 3, buyFixed: 20 } });
  assert.deepEqual(saved.Vinted, { percent: 0, fixed: 0, buyPercent: 3, buyFixed: 20, buyMax: null });
  // An older client (or the iOS app) sends seller fees only, or no entry at all.
  const merged = normalizeFeePresets({ Vinted: { percent: 2, fixed: 1 } }, saved);
  assert.deepEqual(merged.Vinted, { percent: 2, fixed: 1, buyPercent: 3, buyFixed: 20, buyMax: null });
  assert.deepEqual(normalizeFeePresets({}, saved).Vinted, { ...DEFAULT_FEE_PRESETS.Vinted, buyPercent: 3, buyFixed: 20 });
  // Out-of-range buy costs fall back too.
  assert.deepEqual(normalizeFeePresets({ OLX: { percent: 0, fixed: 0, buyPercent: 80, buyFixed: -1 } }).OLX, DEFAULT_FEE_PRESETS.OLX);

  const directory = mkdtempSync(join(tmpdir(), 'scout-resale-'));
  const db = openDatabase(join(directory, 'scout.sqlite'));
  try {
    const store = new FlipStore(db);
    store.setFeePresets({ ...DEFAULT_FEE_PRESETS, OLX: { percent: 0, fixed: 0, buyPercent: 0, buyFixed: 25 } });
    store.setFeePresets({ ...DEFAULT_FEE_PRESETS, OLX: { percent: 8, fixed: 0 } } as typeof DEFAULT_FEE_PRESETS);
    assert.deepEqual(store.feePresets().OLX, { percent: 8, fixed: 0, buyPercent: 0, buyFixed: 25, buyMax: 70 });
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

const gpus: ResaleWatchRow = {
  id: 'gpus', query: 'rtx 3070', includedTerms: '', excludedTerms: 'uszkodzona', referenceId: null,
  groups: [{ id: 'ti', label: '3070 Ti', terms: 'ti', exclude: '' }, { id: 'base', label: '3070', terms: '3070', exclude: 'ti' }],
};
const sold = (title: string, soldOn: string, salePrice: number, watchId: string | null = null): SoldFlip => ({ title, watchId, soldOn, salePrice });

test('own sales are recent flips of the same model: by watch or filter, in the same named variant', () => {
  const flips = [
    sold('Gigabyte RTX 3070 Gaming OC', '2026-11-01', 1150),
    sold('MSI RTX 3070 Ti Suprim', '2026-10-20', 1500),
    sold('RTX 3070 uszkodzona', '2026-11-10', 400), // fails the exclusion
    sold('Zotac RTX 3070', '2026-06-01', 1300), // older than 120 days
    sold('Karta graficzna', '2026-11-05', 1100, 'gpus'), // bought from the watch, title says nothing
    sold('Ryzen 5 5600', '2026-11-05', 400),
  ];
  assert.deepEqual(ownSalesFor(flips, gpus, 'ti', NOW), [1500]);
  // The untitled flip from this watch has no 3070 in its title, so no named variant takes it.
  assert.deepEqual(ownSalesFor(flips, gpus, 'base', NOW), [1150]);
  // The Other bucket mixes models and takes none.
  assert.deepEqual(ownSalesFor(flips, gpus, '__other__', NOW), []);
  assert.deepEqual(ownSalesFor(flips, gpus, null, NOW), []);
  const ungrouped = { ...gpus, groups: [] };
  assert.deepEqual(ownSalesFor(flips, ungrouped, null, NOW), [1150, 1500, 1100]);
  // A sale after the moment asked about does not count (the bench replays the past).
  assert.deepEqual(ownSalesFor(flips, ungrouped, null, Date.parse('2026-10-25T00:00:00Z')), [1500]);
});

test('the resale context loads flips, watches and bands once and only for flip channels', () => {
  const calls = { flips: 0, watches: 0, band: 0 };
  const context = new ResaleContext(DEFAULT_FEE_PRESETS, {
    flips: () => { calls.flips += 1; return [sold('RTX 3070', '2026-11-01', 1150)]; },
    watches: () => { calls.watches += 1; return [{ ...gpus, groups: [] }, { id: 'cpus', query: 'ryzen 5600', includedTerms: '', excludedTerms: '', groups: [], referenceId: 'research-cpus' }]; },
    band: () => { calls.band += 1; return { p25: 380, samples: 12 }; },
  }, NOW);
  // OLX's buyer fee: 3,99 zł + 4,6% of 900 = 45,39 zł.
  assert.deepEqual(context.estimate('OLX', 'gpus', null, 900, 1300), { net: 205, basis: { source: 'own-sales', resalePrice: 1150, samples: 1, buyCosts: 45, label: 'your recent sale' } });
  assert.equal(context.estimate('OLX', 'gpus', null, 950, 1300)?.net, 152); // 1150 − 47,69 − 950
  assert.deepEqual(context.estimate('Vinted', 'cpus', null, 300, 450)?.basis, { source: 'sale-band', resalePrice: 380, samples: 12, buyCosts: 31, label: 'probable-sale p25' });
  assert.equal(context.estimate('Vinted', 'cpus', null, 320, 450)?.basis.source, 'sale-band');
  assert.equal(context.estimate('OLX', 'missing', null, 900, 1000)?.basis.source, 'typical-haircut');
  assert.equal(context.estimate('OLX', null, null, 900, 1000)?.basis.source, 'typical-haircut');
  assert.equal(context.estimate('eBay', 'gpus', null, 900, 1300), null);
  assert.equal(context.estimate('OLX', 'gpus', null, 900, null), null);
  assert.deepEqual(calls, { flips: 1, watches: 1, band: 1 });
});
