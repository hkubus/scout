import test from 'node:test';
import assert from 'node:assert/strict';
import { pickVariantBatch, typoVariants } from '../server/typos';

test('produces deterministic, capped variants that never repeat the original or each other', () => {
  const first = typoVariants('playstation 5 console');
  const second = typoVariants('playstation 5 console');
  assert.deepEqual(first, second);
  assert.ok(first.length > 0 && first.length <= 3);
  assert.equal(new Set(first).size, first.length);
  for (const variant of first) {
    assert.notEqual(variant, 'playstation 5 console');
    // Exactly one character differs from the original (one token is mutated).
    assert.equal(variant.split(/\s+/).length, 3);
  }
  assert.deepEqual(typoVariants('playstation 5 console', { max: 0 }), []);
  assert.deepEqual(typoVariants('playstation 5 console', { max: 10 }).length <= 10, true);
});

test('skips short tokens and queries without eligible tokens', () => {
  assert.deepEqual(typoVariants('rtx 4070'), []);
  assert.deepEqual(typoVariants(''), []);
  assert.deepEqual(typoVariants('   '), []);
  assert.deepEqual(typoVariants('amd cpu am5'), []);
});

test('preserves Polish diacritics verbatim in mutated tokens', () => {
  const variants = typoVariants('żółwik żmijka żółć', { max: 5 });
  assert.ok(variants.length > 0);
  for (const variant of variants) {
    assert.notEqual(variant, 'żółwik żmijka żółć');
    assert.match(variant, /[żąęółśńćź]/);
  }
});

test('rotation covers the whole variant set over consecutive scans without exceeding the batch size', () => {
  const variants = typoVariants('zabawka education blocks', { max: 5 });
  assert.equal(variants.length, 5);
  const seen = new Set<string>();
  for (let scan = 0; scan < 7; scan += 1) {
    const batch = pickVariantBatch(variants, scan, 2);
    assert.ok(batch.length > 0 && batch.length <= 2);
    for (const variant of batch) seen.add(variant);
  }
  assert.deepEqual([...seen].sort(), [...variants].sort());
  assert.deepEqual(pickVariantBatch([], 0, 2), []);
  assert.deepEqual(pickVariantBatch(variants, 0, 0), []);
  // Negative or fractional ordinals still resolve deterministically.
  assert.deepEqual(pickVariantBatch(variants, -5, 2), pickVariantBatch(variants, 0, 2));
});
