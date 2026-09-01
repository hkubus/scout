import test from 'node:test';
import assert from 'node:assert/strict';
import { DUPLICATE_SIMILARITY, DUPLICATE_WINDOW_DAYS, duplicateSimilarity, normalizeTitleForMatch } from '../server/duplicates';

test('normalizes Polish titles: lowercase, diacritics stripped, stopwords dropped', () => {
  assert.deepEqual(normalizeTitleForMatch('Sprzedam iPhone 13 czarny — okazja!'), ['iphone', '13', 'czarny']);
  assert.deepEqual(normalizeTitleForMatch('Żółwik zabawka'), ['zolwik', 'zabawka']);
  assert.deepEqual(normalizeTitleForMatch('NOWE kurtka zimowa'), ['kurtka', 'zimowa']);
  assert.deepEqual(normalizeTitleForMatch('!!!'), []);
});

test('identical and paraphrased Polish titles clear the threshold at equal prices', () => {
  const identical = duplicateSimilarity(
    { title: 'iPhone 13 128GB czarny', price: 2200, condition: 'Used', imageUrl: null },
    { title: 'iPhone 13 128GB czarny', price: 2200, condition: 'Used', imageUrl: null },
  );
  assert.ok(identical >= DUPLICATE_SIMILARITY, `expected identical items to match, received ${identical}`);

  const paraphrased = duplicateSimilarity(
    { title: 'Honda Jazz filtry oleju oryginalne', price: 120, condition: 'New' },
    { title: 'Oryginalne filtry oleju do Honda Jazz', price: 125, condition: 'New' },
  );
  assert.ok(paraphrased >= DUPLICATE_SIMILARITY, `expected paraphrased PL titles to match, received ${paraphrased}`);
});

test('price differences beyond ±25% are a hard cut regardless of the title', () => {
  const score = duplicateSimilarity(
    { title: 'iPhone 13 128GB czarny', price: 2000, condition: 'Used' },
    { title: 'iPhone 13 128GB czarny', price: 4000, condition: 'Used' },
  );
  assert.equal(score, 0);
});

test('condition mismatch lowers the score and different titles stay below the threshold', () => {
  const matched = duplicateSimilarity(
    { title: 'Rower górski Kross 29', price: 1500, condition: 'New' },
    { title: 'Rower górski Kross 29', price: 1500, condition: 'New' },
  );
  const mismatched = duplicateSimilarity(
    { title: 'Rower górski Kross 29', price: 1500, condition: 'New' },
    { title: 'Rower górski Kross 29', price: 1500, condition: 'For parts' },
  );
  assert.ok(mismatched < matched, 'expected a condition mismatch to lower the similarity');

  const unrelated = duplicateSimilarity(
    { title: 'Silnik krokowy Nema 17', price: 60 },
    { title: 'Pralka Bosch 8kg', price: 62 },
  );
  assert.ok(unrelated < DUPLICATE_SIMILARITY);
});

test('a matching image CDN identity boosts borderline pairs', () => {
  const withoutImage = duplicateSimilarity(
    { title: 'nike buty rozmiar 42 air max', price: 300, condition: 'Used', imageUrl: null },
    { title: 'nike air max buty 42', price: 310, condition: 'Used', imageUrl: null },
  );
  const withImage = duplicateSimilarity(
    { title: 'nike buty rozmiar 42 air max', price: 300, condition: 'Used', imageUrl: 'https://img.olxcdn.com/photos/abc-1000x750.jpg' },
    { title: 'nike air max buty 42', price: 310, condition: 'Used', imageUrl: 'https://img.olxcdn.com/photos/abc-600x450.jpg' },
  );
  assert.ok(withImage > withoutImage);
  assert.equal(withImage >= DUPLICATE_SIMILARITY, true);
  assert.equal(DUPLICATE_WINDOW_DAYS, 14);
});
