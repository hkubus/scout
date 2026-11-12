import test from 'node:test';
import assert from 'node:assert/strict';
import { isDamagedLabel, normalizeRequestedCondition } from '../server/searchCondition';
import { normalizeFilterText } from '../server/text';

test('maps English and Polish conditions onto the ones Scout filters by', () => {
  const cases: Array<[string | undefined, string, boolean]> = [
    [undefined, 'Any', true],
    ['', 'Any', true],
    ['Any', 'Any', true],
    ['wszystkie', 'Any', true],
    ['Dowolny', 'Any', true],
    ['New', 'New', true],
    ['brand new', 'New', true],
    ['nowy', 'New', true],
    ['Nowe', 'New', true],
    ['nówka', 'New', true],
    ['used', 'Used', true],
    ['Używany', 'Used', true],
    ['używane', 'Used', true],
    ['Damaged', 'Damaged', true],
    ['uszkodzony', 'Damaged', true],
    ['na części', 'Damaged', true],
    ['for parts', 'Damaged', true],
    ['niesprawny', 'Damaged', true],
    ['like new', 'Like new', true],
    ['jak nowy', 'Like new', true],
    ['Idealny', 'Like new', true],
    ['Very good+', 'Very good', true],
    ['bardzo dobry', 'Very good', true],
    ['Good+', 'Good', true],
    ['dobry', 'Good', true],
    ['mint', 'Any', false],
    ['refurbished', 'Any', false],
  ];
  for (const [raw, condition, recognized] of cases) {
    assert.deepEqual(normalizeRequestedCondition(raw), { condition, recognized }, String(raw));
  }
});

test('tells damaged condition labels from worn but working ones', () => {
  for (const label of ['Uszkodzone', 'Uszkodzony', 'Na części', 'Niesprawny', 'Nie w pełni sprawny', 'Damaged', 'For parts', 'Broken screen']) {
    assert.equal(isDamagedLabel(normalizeFilterText(label)), true, label);
  }
  for (const label of ['Używane', 'Nowe', 'Zadowalający', 'Dobry', 'Bardzo dobry', '', 'Nieuszkodzony']) {
    assert.equal(isDamagedLabel(normalizeFilterText(label)), false, label);
  }
});
