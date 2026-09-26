import test from 'node:test';
import assert from 'node:assert/strict';
import { BASELINE_MIN_SAMPLES, scoreDeal } from '../server/scoring';

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
