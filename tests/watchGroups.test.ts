import test from 'node:test';
import assert from 'node:assert/strict';
import { assignWatchGroup, normalizeWatchGroups, parseWatchGroups } from '../server/watchGroups';

const iphones = normalizeWatchGroups([
  { name: '13 mini', terms: '13, mini' },
  { name: '13', terms: '13' },
  { name: '13 Pro', terms: '13 pro' },
  { name: '13 Pro Max', terms: '13, pro max|promax' },
]);

test('assigns the most specific matching group without base-model exclusions', () => {
  assert.equal(assignWatchGroup('Apple iPhone 13 128GB', iphones), '13');
  assert.equal(assignWatchGroup('iPhone 13 mini 256 GB zielony', iphones), '13-mini');
  assert.equal(assignWatchGroup('iPhone 13 Pro, bateria 89%', iphones), '13-pro');
  assert.equal(assignWatchGroup('IPHONE 13 PRO MAX 1TB', iphones), '13-pro-max');
  assert.equal(assignWatchGroup('iPhone 13 ProMax', iphones), '13-pro-max', '`|` alternatives match');
});

test('matches whole words only and leaves unmatched titles unassigned', () => {
  assert.equal(assignWatchGroup('iPhone 130 (not a real model)', iphones), null);
  assert.equal(assignWatchGroup('iPhone 12 Pro', iphones), null);
  assert.equal(assignWatchGroup('anything', []), null);
});

test('treats equally specific matches as ambiguous and honors excluded terms', () => {
  const consoles = normalizeWatchGroups([
    { name: 'PS5 disc', terms: 'ps5, disc|napedem' },
    { name: 'PS5 digital', terms: 'ps5, digital', excluded: 'uszkodzona' },
  ]);
  assert.equal(assignWatchGroup('PS5 digital + disc drive', consoles), null);
  assert.equal(assignWatchGroup('PS5 z napędem', consoles), 'ps5-disc', 'diacritics normalize');
  assert.equal(assignWatchGroup('PS5 digital uszkodzona', consoles), null);
});

test('normalizes group definitions with stable, unique keys', () => {
  const groups = normalizeWatchGroups([
    { key: 'kept', name: 'Renamed group', terms: ' a ' },
    { name: 'Pro Max', terms: 'b' },
    { key: 'kept', name: 'Collides', terms: 'c' },
  ]);
  assert.deepEqual(groups.map((group) => group.key), ['kept', 'pro-max', 'collides']);
  assert.equal(groups[0].terms, 'a');
  assert.equal(groups[0].excluded, '');
  assert.throws(() => normalizeWatchGroups([{ name: 'A', terms: 'x' }, { name: 'a', terms: 'y' }]), /Duplicate group name/);
  assert.throws(() => normalizeWatchGroups([{ name: 'A', terms: ' , | ' }]), /needs at least one term/);
});

test('parses stored groups defensively', () => {
  assert.deepEqual(parseWatchGroups(null), []);
  assert.deepEqual(parseWatchGroups('not json'), []);
  assert.deepEqual(parseWatchGroups('[{"key":"a","name":"A","terms":"x"},{"name":"broken"}]'), [{ key: 'a', name: 'A', terms: 'x', excluded: '' }]);
});
