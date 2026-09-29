import test from 'node:test';
import assert from 'node:assert/strict';
import { BASELINE_MIN_SAMPLES, VARIANT_MIN_SAMPLES, pooledVariantSpread, scoreDeal } from '../server/scoring';

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

test('a Very strong discount alerts through a wide baseline that fails the robust z-score', () => {
  // 15 listings at 100 and 15 at 300: median 200, MAD 100, robustScale ~148.
  // A heterogeneous watch like this has a spread that keeps deviation low even
  // for a large discount, which used to silence every "Very strong" row.
  const wideBaseline = [...Array.from({ length: 15 }, () => 100), ...Array.from({ length: 15 }, () => 300)];
  const veryStrong = scoreDeal(wideBaseline, 160, { observedHours: 8 });
  assert.equal(veryStrong.isReady, true);
  assert.equal(veryStrong.discountPercent, 20);
  assert.equal(veryStrong.deviation! < 3.1, true, 'the z-score alone would reject this deal');
  assert.equal(veryStrong.qualifies, true);

  // Strong (18-20%) still has to clear the deviation gate.
  const strong = scoreDeal(wideBaseline, 163, { observedHours: 8 });
  assert.equal(strong.discountPercent! >= 18 && strong.discountPercent! < 20, true);
  assert.equal(strong.deviation! < 3.1, true);
  assert.equal(strong.qualifies, false);
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

test('pools within-variant spread only from variants with enough samples', () => {
  const pooled = pooledVariantSpread([...mixedModels, [100, 5000]]);
  assert.equal(pooled.samples, 48, 'the two-sample variant is left out');
  assert.ok(pooled.spreadRatio !== null && Math.abs(pooled.spreadRatio - 0.015) < 1e-9, `spread ${pooled.spreadRatio}`);
  assert.deepEqual(pooledVariantSpread([[1, 2, 3]]), { spreadRatio: null, samples: 0 });
});

test('the pooled spread lets a Strong discount clear the z-score inside a variant', () => {
  const observedHours = 8;
  const price = 2600 * 0.81;
  // The variant's own 12 listings are below the 30-sample floor on their own.
  const alone = scoreDeal(mixedModels[2], price, { observedHours });
  assert.equal(alone.isReady, false);

  const pooled = pooledVariantSpread(mixedModels);
  const grouped = scoreDeal(mixedModels[2], price, { observedHours, pooled });
  assert.equal(grouped.typical, 2600);
  assert.equal(grouped.isReady, true);
  assert.equal(Math.round(grouped.discountPercent ?? 0), 19, 'a Strong (not Very strong) discount must pass the z-score itself');
  assert.equal(grouped.qualifies, true);
});

test('pooled readiness needs 10 samples in the variant and 30 across named variants', () => {
  const pooledSmall = pooledVariantSpread([cluster(1000), cluster(2000)]);
  assert.equal(pooledSmall.samples, 24);
  const notPooled = scoreDeal(cluster(1000), 500, { observedHours: 8, pooled: pooledSmall });
  assert.equal(notPooled.isReady, false, '24 pooled samples stay below the 30 floor');
  assert.equal(notPooled.qualifies, false);
  assert.ok(notPooled.confidence < 100);

  const pooled = pooledVariantSpread(mixedModels);
  const thinVariant = scoreDeal(cluster(1000).slice(0, VARIANT_MIN_SAMPLES - 1), 500, { observedHours: 8, pooled });
  assert.equal(thinVariant.isReady, false, 'the variant itself needs VARIANT_MIN_SAMPLES');
  const ready = scoreDeal(cluster(1000).slice(0, VARIANT_MIN_SAMPLES), 500, { observedHours: 8, pooled });
  assert.equal(ready.isReady, true);
});
