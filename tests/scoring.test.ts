import test from 'node:test';
import assert from 'node:assert/strict';
import { BASELINE_MIN_HOURS, BASELINE_MIN_SAMPLES, VARIANT_MIN_SAMPLES, dealStrength, median, pooledVariantSpread, priceStats, scoreDeal, scoreDealFromStats, type PooledSpread } from '../server/scoring';

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

// The pre-stats scoreDeal, kept verbatim as the oracle for scoreDealFromStats.
function legacyScoreDeal(prices: number[], price: number, options: { minSamples?: number; minHours?: number; observedHours?: number; sensitivity?: number; typicalOverride?: number; pooled?: PooledSpread } = {}) {
  const pooled = options.pooled;
  const minSamples = options.minSamples ?? (pooled ? VARIANT_MIN_SAMPLES : BASELINE_MIN_SAMPLES);
  const minHours = options.minHours ?? BASELINE_MIN_HOURS;
  const usablePrices = prices.filter((value) => Number.isFinite(value) && value > 0);
  const override = options.typicalOverride !== undefined && Number.isFinite(options.typicalOverride) && options.typicalOverride > 0
    ? options.typicalOverride
    : null;
  const typical = override ?? median(usablePrices);
  if (typical === null || price <= 0) return { typical, mad: null, deviation: null, discountPercent: null, confidence: 0, isReady: false, qualifies: false };
  const deviations = usablePrices.map((value) => Math.abs(value - typical));
  const mad = pooled?.spreadRatio != null ? pooled.spreadRatio * typical : median(deviations) ?? 0;
  const robustScale = Math.max(mad * 1.4826, typical * 0.035, 1);
  const deviation = (typical - price) / robustScale;
  const discountPercent = ((typical - price) / typical) * 100;
  const sampleReadiness = Math.min(1, usablePrices.length / minSamples, pooled ? pooled.samples / BASELINE_MIN_SAMPLES : 1);
  const timeReadiness = Math.min(1, (options.observedHours ?? 0) / minHours);
  const confidence = Math.round(Math.min(1, sampleReadiness * 0.62 + timeReadiness * 0.38) * 100);
  const rawSensitivity = options.sensitivity ?? 1;
  const sensitivity = Number.isFinite(rawSensitivity) && rawSensitivity >= 0.6 && rawSensitivity <= 1.6 ? rawSensitivity : 1;
  const isReady = usablePrices.length >= minSamples && (!pooled || pooled.samples >= BASELINE_MIN_SAMPLES) && (options.observedHours ?? 0) >= minHours;
  const veryStrong = discountPercent >= 20;
  const qualifies = isReady && discountPercent >= 18 && (veryStrong || deviation >= 3.1 / sensitivity);
  return { typical, mad, deviation, discountPercent, confidence, isReady, qualifies };
}

test('scoreDealFromStats with shared bucket stats equals the legacy scoreDeal for random inputs', () => {
  let seed = 20261001;
  const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const pick = <T>(values: T[]) => values[Math.floor(random() * values.length)];
  let compared = 0;
  for (let round = 0; round < 300; round += 1) {
    const size = pick([0, 1, 2, 5, 9, 10, 29, 30, 31, 100, 400]);
    const base = 50 + random() * 5000;
    const prices = Array.from({ length: size }, () => {
      const roll = random();
      if (roll < 0.02) return pick([0, -5, Number.NaN, Number.POSITIVE_INFINITY]);
      // Rounded prices produce the duplicate values real buckets have.
      return roll < 0.5 ? Math.round(base * (0.5 + random())) : base * (0.4 + random() * 1.4);
    });
    // One stats object serves every listing of the round, as in a scan, so the
    // MAD memo is exercised across typicals.
    const stats = priceStats(prices);
    for (let probe = 0; probe < 25; probe += 1) {
      const price = pick([0, -1, Math.round(base * random() * 1.5), base * (0.3 + random())]);
      const options: Parameters<typeof scoreDeal>[2] = { observedHours: pick([0, 1, 5.9, 6, 12, 400]) };
      if (random() < 0.3) options.typicalOverride = pick([base, Math.round(base * 1.1), 0, -3, Number.NaN, Number.POSITIVE_INFINITY]);
      if (random() < 0.3) options.pooled = { spreadRatio: pick([null, 0, 0.05, random() * 0.4]), samples: pick([0, 10, 29, 30, 200]) };
      if (random() < 0.3) options.sensitivity = pick([0.5, 0.6, 1, 1.25, 1.6, 2, Number.NaN]);
      if (random() < 0.1) options.minSamples = pick([1, 5, 50]);
      if (random() < 0.1) options.minHours = pick([1, 24]);
      const expected = legacyScoreDeal(prices, price, options);
      assert.deepEqual(scoreDealFromStats(stats, price, options), expected);
      assert.deepEqual(scoreDeal(prices, price, options), expected);
      compared += 1;
    }
  }
  assert.equal(compared, 7500);
});

test('deal strength weighs złoty saved as well as the discount percentage', () => {
  // 100 zł off 600 zł (16.7%) beats 50 zł off 200 zł (25%).
  assert.equal(dealStrength(500, 600), 4);
  assert.equal(dealStrength(150, 200), 3);
  // At the 400 zł reference typical the plain percentage tiers apply.
  assert.equal(dealStrength(280, 400), 5);
  assert.equal(dealStrength(320, 400), 4);
  assert.equal(dealStrength(352, 400), 3);
  assert.equal(dealStrength(360, 400), 2);
  // Big percentages on cheap items saving little are demoted.
  assert.equal(dealStrength(30, 50), 3);
  // A small relative dip on an expensive item cannot ride the PLN amount alone.
  assert.equal(dealStrength(1800, 2000), 3);
  assert.equal(dealStrength(2640, 3000), 3);
  assert.equal(dealStrength(2550, 3000), 4);
  assert.equal(dealStrength(2850, 3000), 2);
  assert.equal(dealStrength(400, 400), 1);
  assert.equal(dealStrength(450, 400), 1);
  assert.equal(dealStrength(100, null), null);
  assert.equal(dealStrength(100, 0), null);
});
