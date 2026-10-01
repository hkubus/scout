import test from 'node:test';
import assert from 'node:assert/strict';
import { applyListingActionToPage, isListingActionEvent, matchesTriageFilters, patchListingRows } from '../src/listingActions';
import type { Listing, ListingDecision } from '../src/types';

const row = (id: string, extra: Partial<Listing> = {}) => ({ id: `${id}#w`, marketplaceListingKey: id, decision: null, hidden: false, ...extra }) as unknown as Listing;

test('patches every row of the listing and keeps identity when nothing changed', () => {
  const rows = [row('OLX:1', { associationId: 'a' } as Partial<Listing>), row('OLX:2'), row('OLX:1', { associationId: 'b' } as Partial<Listing>)];
  const patched = patchListingRows(rows, { key: 'OLX:1', decision: 'buy', hidden: true });
  assert.deepEqual(patched.map((listing) => [listing.decision, listing.hidden]), [['buy', true], [null, false], ['buy', true]]);
  assert.equal(patched[1], rows[1]);
  assert.equal(patchListingRows(patched, { key: 'OLX:1', decision: 'buy', hidden: true }), patched);
  assert.equal(patchListingRows(rows, { key: 'OLX:9', decision: 'buy', hidden: true }), rows);
});

test('falls back to the id when a row has no marketplace key', () => {
  const rows = [{ id: 'Vinted:7', decision: null, hidden: false } as unknown as Listing];
  assert.equal(patchListingRows(rows, { key: 'Vinted:7', decision: null, hidden: true })[0].hidden, true);
});

test('page filter matches the server filters (oracle: the old in-memory offline filter)', () => {
  const decisions: Array<ListingDecision | null> = [null, 'buy', 'watch', 'pass'];
  for (const decision of [...decisions, 'All'] as Array<ListingDecision | 'All'>) {
    if (decision === null) continue;
    for (const [visibilityKey, visibility] of [['visible', 'Visible'], ['hidden', 'Hidden'], ['all', 'All']] as const) {
      for (const listingDecision of decisions) {
        for (const hidden of [false, true]) {
          const listing = row('OLX:1', { decision: listingDecision, hidden });
          // The pre-change offline fallback in ListingsPage, used as the oracle.
          const oracle = !(decision !== 'All' && listing.decision !== decision) && !(visibility === 'Visible' && listing.hidden) && !(visibility === 'Hidden' && !listing.hidden);
          assert.equal(matchesTriageFilters(listing, decision, visibilityKey), oracle, `${decision} ${visibility} ${listingDecision} ${hidden}`);
        }
      }
    }
  }
});

test('drops rows that leave the page filter and reports how many', () => {
  const rows = [row('OLX:1', { associationId: 'a' } as Partial<Listing>), row('OLX:2'), row('OLX:1', { associationId: 'b' } as Partial<Listing>)];
  const hide = { key: 'OLX:1', decision: null, hidden: true };
  const visible = applyListingActionToPage(rows, hide, 'All', 'visible');
  assert.deepEqual(visible.rows.map((listing) => listing.marketplaceListingKey), ['OLX:2']);
  assert.equal(visible.removed, 2);
  // Replaying the same event (own toggle result, then the SSE echo) removes nothing more.
  assert.deepEqual(applyListingActionToPage(visible.rows, hide, 'All', 'visible'), { rows: visible.rows, removed: 0 });
  const all = applyListingActionToPage(rows, hide, 'All', 'all');
  assert.equal(all.removed, 0);
  assert.equal(all.rows.length, 3);
  const decided = applyListingActionToPage(rows, { key: 'OLX:2', decision: 'pass', hidden: false }, 'buy', 'all');
  assert.equal(decided.removed, 1);
});

test('rejects malformed payloads', () => {
  assert.equal(isListingActionEvent(null), false);
  assert.equal(isListingActionEvent({ refresh: true }), false);
  assert.equal(isListingActionEvent({ key: 'OLX:1', decision: null, hidden: false }), true);
});
