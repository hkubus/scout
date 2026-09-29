import test from 'node:test';
import assert from 'node:assert/strict';
import { BASELINE_MIN_SAMPLES, GROUP_MIN_SAMPLES, pooledGroupSpread, scoreDeal } from '../server/scoring';

test('typicalOverride seeds the typical for display while the own baseline is empty', () => {
  const result = scoreDeal([], 1000, { typicalOverride: 2000, observedHours: 1 });
  assert.equal(result.typical, 2000);
  assert.equal(result.discountPercent, 50);
  // Readiness gate is untouched: no own samples means never ready/qualifying.
  assert.equal(result.isReady, false);
  assert.equal(result.qualifies, false);
  assert.equal(result.confidence < 100, true);
});

test('typicalOverride mixes with partial own history without unlocking alerts', () => {
  const ownPrices = Array.from({ length: 10 }, (_, index) => 2000 + index * 10);
  const result = scoreDeal(ownPrices, 1500, { typicalOverride: 2000, observedHours: 8 });
  assert.equal(result.typical, 2000);
  assert.equal(result.isReady, false, 'own samples below the floor keep the gate closed');
  assert.equal(result.qualifies, false);
});

test('ignores invalid overrides; valid overrides apply whenever provided (call sites gate own-history priority)', () => {
  const ownPrices = Array.from({ length: BASELINE_MIN_SAMPLES }, () => 2000);
  const withOverride = scoreDeal(ownPrices, 1500, { observedHours: 8, typicalOverride: 1000 });
  assert.equal(withOverride.typical, 1000);
  assert.equal(scoreDeal([], 1000, { typicalOverride: -5 }).typical, null);
  assert.equal(scoreDeal([], 1000, { typicalOverride: 0 }).typical, null);
  assert.equal(scoreDeal([], 1000, { typicalOverride: Number.NaN }).typical, null);
});

// Mixed-model watch: four models whose prices cluster tightly around very
// different medians (within ±5%), 12 listings each, median exactly the center.
const clusterShape = [0.95, 0.97, 0.98, 0.99, 1, 1, 1, 1, 1.01, 1.02, 1.03, 1.05];
const cluster = (center: number) => clusterShape.map((ratio) => center * ratio);
const mixedModels = [cluster(1500), cluster(2000), cluster(2600), cluster(3200)];

test('pools within-group spread only from groups with enough samples', () => {
  const pooled = pooledGroupSpread([...mixedModels, [100, 5000]]);
  assert.equal(pooled.samples, 48, 'the two-sample group is left out');
  assert.ok(pooled.spreadRatio !== null && Math.abs(pooled.spreadRatio - 0.015) < 1e-9, `spread ${pooled.spreadRatio}`);
  assert.deepEqual(pooledGroupSpread([[1, 2, 3]]), { spreadRatio: null, samples: 0 });
});

test('a grouped baseline flags a 25% discount that the mixed watch-wide baseline cannot', () => {
  const observedHours = 8;
  const price = 2600 * 0.75;
  const watchWide = scoreDeal(mixedModels.flat(), price, { observedHours });
  assert.equal(watchWide.isReady, true);
  assert.equal(watchWide.qualifies, false, 'model mix inflates the MAD past the discount');

  const pooled = pooledGroupSpread(mixedModels);
  const grouped = scoreDeal(mixedModels[2], price, { observedHours, pooled });
  assert.equal(grouped.typical, 2600);
  assert.equal(grouped.isReady, true);
  assert.equal(grouped.qualifies, true);
  assert.equal(Math.round(grouped.discountPercent ?? 0), 25);
});

test('grouped readiness needs 10 samples in the group and 30 pooled', () => {
  const pooledSmall = pooledGroupSpread([cluster(1000), cluster(2000)]);
  assert.equal(pooledSmall.samples, 24);
  const notPooled = scoreDeal(cluster(1000), 500, { observedHours: 8, pooled: pooledSmall });
  assert.equal(notPooled.isReady, false, '24 pooled samples stay below the 30 floor');
  assert.equal(notPooled.qualifies, false);
  assert.ok(notPooled.confidence < 100);

  const pooled = pooledGroupSpread(mixedModels);
  const thinGroup = scoreDeal(cluster(1000).slice(0, GROUP_MIN_SAMPLES - 1), 500, { observedHours: 8, pooled });
  assert.equal(thinGroup.isReady, false, 'the group itself needs GROUP_MIN_SAMPLES');
  const ready = scoreDeal(cluster(1000).slice(0, GROUP_MIN_SAMPLES), 500, { observedHours: 8, pooled });
  assert.equal(ready.isReady, true);
});
