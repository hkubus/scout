import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase } from '../server/db';
import { FlipStore } from '../server/flips';
import { ServiceError } from '../server/service';
import { DEFAULT_FEE_PRESETS, estimateFlipNet, flipNet, normalizeFeePresets, quarterOf, saleFee, salesRecord, salesRecordCsv } from '../src/profit';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'scout-flips-'));
  const db = openDatabase(join(directory, 'scout.sqlite'));
  const events: unknown[] = [];
  const store = new FlipStore(db, (payload) => events.push(payload));
  return { db, store, events, close: () => { db.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test('profit maths: fees, realised net and forward estimates', () => {
  assert.equal(saleFee(1000, DEFAULT_FEE_PRESETS['Allegro Lokalnie']), 49);
  assert.equal(saleFee(300, { percent: 0, fixed: 0 }), 0);
  assert.equal(saleFee(299.99, { percent: 4.9, fixed: 1 }), 15.7);
  assert.equal(flipNet({ buyPrice: 1000, buyCosts: 25, salePrice: null, saleFee: null, saleCosts: null }), null);
  // 1 000 zł Vinted buy resold for 1 300 zł on Lokalnie Elektronika.
  assert.equal(flipNet({ buyPrice: 1000, buyCosts: 0, salePrice: 1300, saleFee: 63.7, saleCosts: 0 }), 236.3);
  assert.deepEqual(estimateFlipNet({ buyPrice: 220, buyCosts: 12, resalePrice: 300, preset: DEFAULT_FEE_PRESETS['Allegro Lokalnie'] }), { fee: 14.7, net: 53.3 });
  assert.deepEqual(quarterOf('2026-09-30'), { year: 2026, quarter: 3 });
  assert.deepEqual(quarterOf('2026-10-01'), { year: 2026, quarter: 4 });
  const presets = normalizeFeePresets({ OLX: { percent: 8, fixed: 0 }, Vinted: { percent: -1, fixed: 'x' }, Bogus: { percent: 1 } });
  assert.deepEqual(presets.OLX, { percent: 8, fixed: 0 });
  assert.deepEqual(presets.Vinted, DEFAULT_FEE_PRESETS.Vinted);
  assert.equal('Bogus' in presets, false);
});

test('the sales record has one row per day and a running total that restarts each quarter', () => {
  const sales = [
    { soldOn: '2026-06-30', salePrice: 999 },
    { soldOn: '2026-07-02', salePrice: 300 },
    { soldOn: '2026-07-02', salePrice: 250.5 },
    { soldOn: '2026-08-15', salePrice: 400 },
    { soldOn: null, salePrice: null },
    { soldOn: '2026-10-01', salePrice: 100 },
  ];
  const rows = salesRecord(sales, 2026, 3);
  assert.deepEqual(rows, [
    { index: 1, date: '2026-07-02', daySales: 550.5, quarterToDate: 550.5 },
    { index: 2, date: '2026-08-15', daySales: 400, quarterToDate: 950.5 },
  ]);
  assert.equal(salesRecordCsv(rows).split('\r\n')[1], '1;2026-07-02;550,50;550,50');
  assert.deepEqual(salesRecord(sales, 2026, 4).map((row) => row.quarterToDate), [100]);
});

test('recording a sale fixes the fee from the preset at that moment', () => {
  const context = fixture();
  try {
    const flip = context.store.create({ title: 'RTX 3070', buyChannel: 'OLX', boughtOn: '2026-09-01', buyPrice: 1000, buyCosts: 20, listedOn: ['OLX', 'Allegro Lokalnie', 'Vinted'] });
    assert.deepEqual([flip.soldOn, flip.salePrice, flip.listedOn], [null, null, ['OLX', 'Allegro Lokalnie', 'Vinted']]);
    const sold = context.store.update(flip.id, { soldOn: '2026-09-20', saleChannel: 'Allegro Lokalnie', salePrice: 1300, saleCosts: 0, delisted: ['OLX'] });
    assert.equal(sold.saleFee, 63.7);
    assert.equal(flipNet(sold), 216.3);
    assert.deepEqual(sold.delisted, ['OLX']);
    // Later preset edits do not rewrite recorded sales.
    context.store.setFeePresets({ ...DEFAULT_FEE_PRESETS, 'Allegro Lokalnie': { percent: 7.9, fixed: 0 } });
    assert.equal(context.store.get(flip.id).saleFee, 63.7);
    // Editing only the costs keeps the fee; changing the price re-derives it.
    assert.equal(context.store.update(flip.id, { saleCosts: 15 }).saleFee, 63.7);
    assert.equal(context.store.update(flip.id, { salePrice: 1000 }).saleFee, 79);
    // An entered fee wins over the preset.
    assert.equal(context.store.update(flip.id, { saleFee: 50 }).saleFee, 50);
    const unsold = context.store.update(flip.id, { soldOn: null });
    assert.deepEqual([unsold.soldOn, unsold.saleChannel, unsold.salePrice, unsold.saleFee, unsold.delisted], [null, null, null, null, []]);
    assert.ok(context.events.length >= 5);
  } finally { context.close(); }
});

test('flip updates reject incomplete or impossible sales and unknown ids', () => {
  const context = fixture();
  try {
    const flip = context.store.create({ title: 'CPU', buyChannel: 'Vinted', boughtOn: '2026-09-10', buyPrice: 300 });
    const rejects = (patch: Parameters<FlipStore['update']>[1], pattern: RegExp) => assert.throws(() => context.store.update(flip.id, patch), (error: unknown) => error instanceof ServiceError && error.status === 400 && pattern.test(error.message));
    rejects({ soldOn: '2026-09-12' }, /date, a channel and a price/);
    rejects({ salePrice: 400 }, /Set the sale date/);
    rejects({ soldOn: '2026-09-01', saleChannel: 'OLX', salePrice: 400 }, /before the purchase date/);
    assert.throws(() => context.store.update(9999, { title: 'x' }), (error: unknown) => error instanceof ServiceError && error.status === 404);
    assert.throws(() => context.store.delete(9999), (error: unknown) => error instanceof ServiceError && error.status === 404);
    context.store.delete(flip.id);
    assert.equal(context.store.list().flips.length, 0);
    assert.deepEqual(context.store.list().feePresets, DEFAULT_FEE_PRESETS);
  } finally { context.close(); }
});
