import test from 'node:test';
import assert from 'node:assert/strict';
import { matchQuery, type MatchCandidate } from '../server/queryMatch';

const iphoneVariants = [
  { id: 'mini', label: '13 mini', terms: '13, mini' },
  { id: 'base', label: '13', terms: '13' },
  { id: 'pro', label: '13 Pro', terms: '13, pro' },
];

function candidate(query: string, overrides: Partial<MatchCandidate> = {}): MatchCandidate {
  return { kind: 'watch', id: query, name: query, query, includedTerms: '', excludedTerms: '', groups: [], ...overrides };
}

function only(query: string, target: MatchCandidate, options = {}) {
  const matches = matchQuery(query, [target], options);
  assert.ok(matches.length <= 1);
  return matches[0];
}

test('a model variant of a grouped watch matches as that variant; the plain query lands in its own bucket', () => {
  const grouped = candidate('iphone 13', { groups: iphoneVariants });
  const pro = only('iphone 13 pro', grouped);
  assert.deepEqual([pro.match, pro.variantKey, pro.matchedTokens, pro.unmatchedTokens], ['variant', 'pro', ['iphone', '13', 'pro'], []]);
  const base = only('iphone 13', grouped);
  assert.deepEqual([base.match, base.variantKey], ['exact', 'base']);
  assert.equal(only('iphone 13 mini', grouped).variantKey, 'mini');
});

test('an ungrouped watch is broader than a query naming another model', () => {
  const match = only('iphone 13 pro', candidate('iphone 13'));
  assert.deepEqual([match.match, match.variantKey, match.unmatchedTokens, match.modelTokenUnmatched], ['broader', null, ['pro'], true]);
});

test('a watch for a more specific product is narrower than the query', () => {
  assert.equal(only('iphone 13', candidate('iphone 13 pro')).match, 'narrower');
});

test('a leftover word that is not a model keeps the match usable', () => {
  const match = only('iphone 13 czarny', candidate('iphone 13'));
  assert.deepEqual([match.match, match.modelTokenUnmatched], ['broader', false]);
});

test('excluded terms veto, on either side', () => {
  assert.equal(only('iphone 13 mini', candidate('iphone 13', { excludedTerms: 'mini' })), undefined);
  assert.equal(only('iphone 13', candidate('iphone 13 mini'), { excluded: 'mini' }), undefined);
  assert.equal(only('iphone 13', candidate('iphone 13 mini'))?.match, 'narrower');
});

test('glued and spaced model numbers match both ways', () => {
  assert.equal(only('rtx3080', candidate('rtx 3080'))?.match, 'exact');
  assert.equal(only('rtx 3080', candidate('rtx3080'))?.match, 'exact');
});

test('a single-digit model never matches a longer number', () => {
  assert.equal(only('iphone 5', candidate('iphone 15')), undefined);
  assert.equal(only('iphone 15', candidate('iphone 5')), undefined);
});

test('stopwords are ignored', () => {
  const match = only('karta do gtx 1660', candidate('gtx 1660'));
  assert.deepEqual([match.match, match.unmatchedTokens, match.modelTokenUnmatched], ['broader', ['karta'], false]);
});

test('explicit included terms decide whether the candidate is required', () => {
  const watch = candidate('iphone 13 pro max', { includedTerms: 'iphone 13' });
  assert.equal(only('iphone 13', watch)?.match, 'exact');
  assert.equal(only('iphone 12', watch), undefined);
});

test('extra terms count like query tokens', () => {
  const match = only('iphone 13', candidate('iphone 13'), { terms: '128gb' });
  assert.deepEqual([match.match, match.unmatchedTokens, match.modelTokenUnmatched], ['broader', ['128gb'], true]);
});
