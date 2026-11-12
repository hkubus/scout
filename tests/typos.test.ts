import test from 'node:test';
import assert from 'node:assert/strict';
import { legacyTypoVariants, pickVariantBatch, typoVariantPairs, typoVariants } from '../server/typos';

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

test('puts the realistic misspelling first and never touches digits', () => {
  assert.deepEqual(typoVariants('iphone 13', { max: 2 }), ['iphon 13', 'iphoen 13']);
  for (const variant of typoVariants('iphone 13 128gb rtx3080', { max: 10 })) {
    assert.match(variant, / 13 128gb rtx3080$/);
  }
  assert.deepEqual(typoVariants('ps5 slim'), []);
  // Five letters are enough.
  assert.equal(typoVariants('canon r6')[0], 'cano r6');
  assert.deepEqual(typoVariants('macbook', { max: 2 }), ['macboo', 'macbok']);
});

test('joins a short word onto its neighbour', () => {
  assert.ok(typoVariants('play station 5').includes('playstation 5'));
  assert.deepEqual(typoVariants('air pods'), ['airpods']);
  assert.deepEqual(typoVariantPairs('play station 5').find((variant) => variant.query === 'playstation 5'), { query: 'playstation 5', from: 'play station', to: 'playstation' });
});

test('spreads the picks across words and records what each changed', () => {
  const pairs = typoVariantPairs('nintendo switch oled', { max: 2 });
  assert.deepEqual(pairs.map((pair) => pair.from), ['nintendo', 'switch']);
  assert.deepEqual(pairs[0], { query: 'nintend switch oled', from: 'nintendo', to: 'nintend' });
  assert.deepEqual(typoVariantPairs('nintendo switch oled'), typoVariantPairs('nintendo switch oled'));
});

test('keeps the legacy generator for research versions saved before the rewrite', () => {
  assert.deepEqual(legacyTypoVariants('iphone 13'), ['pihone 13', 'ihpone 13', 'ipohne 13']);
  assert.deepEqual(legacyTypoVariants('canon r6'), []);
});
