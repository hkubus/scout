import test from 'node:test';
import assert from 'node:assert/strict';
import { compareStrongest, pageForFilters, reuseUnchangedListings, sameListingFields } from '../src/listingRows';
import type { Listing } from '../src/types';

const row = (id: string, extra: Partial<Listing> = {}) => ({ id, title: `Item ${id}`, price: 100, typical: null, observed: '1 min ago', hidden: false, ...extra }) as unknown as Listing;

test('compares listings field by field', () => {
  assert.equal(sameListingFields(row('a'), row('a')), true);
  assert.equal(sameListingFields(row('a'), row('a', { observed: '2 min ago' })), false);
  assert.equal(sameListingFields(row('a'), row('a', { decision: null })), false);
  assert.equal(sameListingFields(row('a', { note: undefined }), row('a', { decision: undefined })), false);
  // Nested values compare by reference: a fresh object counts as a change.
  assert.equal(sameListingFields(row('a', { aiDescriptionVerification: {} } as Partial<Listing>), row('a', { aiDescriptionVerification: {} } as Partial<Listing>)), false);
});

test('returns the previous array when a refetch changed nothing', () => {
  const previous = [row('a'), row('b', { associationId: 'b#1' })];
  const next = [row('a'), row('b', { associationId: 'b#1' })];
  assert.equal(reuseUnchangedListings(previous, next), previous);
});

test('keeps unchanged objects and takes changed, new and reordered rows from the refetch', () => {
  const previous = [row('a'), row('b'), row('c')];
  const next = [row('c'), row('a', { observed: '5 min ago' }), row('d'), row('b')];
  const merged = reuseUnchangedListings(previous, next);
  assert.notEqual(merged, previous);
  assert.deepEqual(merged, next);
  assert.equal(merged[0], previous[2]);
  assert.equal(merged[1], next[1]);
  assert.equal(merged[2], next[2]);
  assert.equal(merged[3], previous[1]);
  // A dropped row or a new order is a different list even when every kept object is reused.
  assert.notEqual(reuseUnchangedListings(previous, [row('a'), row('b')]), previous);
  assert.notEqual(reuseUnchangedListings(previous, [row('b'), row('a'), row('c')]), previous);
});

test('keys rows by association so the same listing under two watches stays distinct', () => {
  const previous = [row('a', { associationId: 'a#1', watch: 'One' }), row('a', { associationId: 'a#2', watch: 'Two' })];
  const next = [row('a', { associationId: 'a#2', watch: 'Two' }), row('a', { associationId: 'a#1', watch: 'One' })];
  const merged = reuseUnchangedListings(previous, next);
  assert.equal(merged[0], previous[1]);
  assert.equal(merged[1], previous[0]);
  assert.equal(reuseUnchangedListings([], next), next);
});

test('a filter change restarts paging, and earlier filters do not bring their page back', () => {
  let state = { key: 'all', page: 1 };
  state = { key: state.key, page: 3 }; // Next, Next
  assert.equal(pageForFilters(state, 'all'), state, 'unchanged filters keep the stored state');
  state = pageForFilters(state, 'olx');
  assert.deepEqual(state, { key: 'olx', page: 1 });
  state = pageForFilters(state, 'all');
  assert.deepEqual(state, { key: 'all', page: 1 });
});

test('orders the strongest by tier, then the deepest discount, then the newest', () => {
  const deal = (id: string, dealStrength: number, belowTypical: number | null, observedAt: string) => row(id, { dealStrength, belowTypical, observedAt });
  const rows = [
    deal('no-typical', 4, null, '2026-11-11T10:00:00.000Z'),
    deal('shallow', 4, -15, '2026-11-11T12:00:00.000Z'),
    deal('weaker-tier', 3, -40, '2026-11-11T13:00:00.000Z'),
    deal('deep-old', 4, -30, '2026-11-11T09:00:00.000Z'),
    deal('deep-new', 4, -30, '2026-11-11T11:00:00.000Z'),
    deal('at-typical', 4, 0, '2026-11-11T11:30:00.000Z'),
  ];
  assert.deepEqual(rows.sort(compareStrongest).map((listing) => listing.id), ['deep-new', 'deep-old', 'shallow', 'at-typical', 'no-typical', 'weaker-tier']);
});
