import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyListingRelevanceWithDeepSeek, listingDescriptionVerificationInputHash, listingRelevanceInputHash, verifyListingDescriptionWithDeepSeek } from '../server/ai';

test('canonicalizes harmless listing and search formatting in AI cache keys', () => {
  assert.equal(
    listingRelevanceInputHash({ marketplace: 'OLX', title: 'RTX 2060', condition: 'used', location: 'Łódź', query: 'gpu', includedTerms: '', excludedTerms: '' }),
    listingRelevanceInputHash({ marketplace: 'Vinted', title: 'RTX 2060', condition: 'used', location: 'Warszawa', query: 'gpu', includedTerms: '', excludedTerms: '' }),
  );
  assert.equal(
    listingRelevanceInputHash({ marketplace: 'OLX', title: ' RTX 2060 ', query: 'GPU', includedTerms: 'Nvidia, RTX', excludedTerms: 'fan, cooler' }),
    listingRelevanceInputHash({ marketplace: 'OLX', title: 'rtx 2060', query: 'gpu', includedTerms: 'rtx,nvidia', excludedTerms: ' cooler , FAN ' }),
  );
});

test('classifies accessories and broken items as irrelevant through DeepSeek JSON output via OpenRouter', async () => {
  let requestInit: RequestInit | undefined;
  const result = await classifyListingRelevanceWithDeepSeek(
    { marketplace: 'OLX', title: 'Wentylator do karty RTX 4070', query: 'gpu', includedTerms: '', excludedTerms: '' },
    { apiKey: 'sk-or-v1-test', model: 'deepseek/deepseek-v4-flash' },
    (_input, init) => {
      requestInit = init;
      return Promise.resolve(Response.json({ choices: [{ message: { content: JSON.stringify({ relevant: false }) } }] }));
    },
  );

  assert.deepEqual(result, { relevant: false });
  const body = JSON.parse(String(requestInit?.body)) as Record<string, any>;
  assert.equal(body.response_format.type, 'json_schema');
  assert.equal(body.response_format.json_schema.name, 'listing_relevance');
  assert.equal(body.response_format.json_schema.strict, true);
  assert.deepEqual(body.response_format.json_schema.schema.required, ['relevant']);
  assert.deepEqual(body.provider, { require_parameters: true });
  assert.deepEqual(body.reasoning, { effort: 'none' });
  assert.equal(body.session_id, 'scout:listing-relevance:v6');
  assert.equal(body.max_tokens, 32);
  assert.equal(body.thinking, undefined);
  assert.equal(body.stream, false);
  assert.equal(body.messages[1].content.includes('gpu'), true);
  assert.match(body.messages[0].content, /broken, damaged.*non-working.*for repair.*parts only/i);
  assert.match(body.messages[0].content, /different component or device that merely mentions/i);
  assert.match(body.messages[0].content, /title or condition stating the item is broken/i);
  assert.match(body.messages[0].content, /merely include, hold, or feature it/i);
  assert.match(body.messages[0].content, /centerpiece is the item itself/i);
});

test('conservatively verifies an exceptional listing description through DeepSeek JSON output', async () => {
  let requestInit: RequestInit | undefined;
  const context = {
    marketplace: 'OLX' as const,
    title: 'Steam Deck OLED 512GB',
    condition: 'Używany',
    description: 'W pełni sprawny, wszystkie przyciski działają. W zestawie oryginalna ładowarka.',
  };
  const result = await verifyListingDescriptionWithDeepSeek(
    context,
    { apiKey: 'sk-or-v1-test', model: 'deepseek-v4-flash' },
    (_input, init) => {
      requestInit = init;
      return Promise.resolve(Response.json({ choices: [{ message: { content: JSON.stringify({
        decision: 'pass', confidence: 0.94, summary: 'The description explicitly says the item works.', issues: [], evidence: ['W pełni sprawny', 'wszystkie przyciski działają'],
      }) } }] }));
    },
  );

  assert.deepEqual(result.decision, 'pass');
  const body = JSON.parse(String(requestInit?.body)) as Record<string, any>;
  assert.equal(body.session_id, 'scout:listing-description-verification:v2');
  assert.equal(body.max_tokens, 360);
  assert.deepEqual(body.plugins, [{ id: 'response-healing' }]);
  assert.equal(body.response_format.json_schema.name, 'listing_description_verification');
  assert.deepEqual(body.response_format.json_schema.schema.required, ['decision', 'confidence', 'summary', 'issues', 'evidence']);
  assert.equal(body.messages[1].content.includes(context.description), true);
  assert.equal(listingDescriptionVerificationInputHash(context), listingDescriptionVerificationInputHash({ ...context, description: '  W PEŁNI   SPRAWNY, wszystkie przyciski działają. W zestawie oryginalna ładowarka. ' }));
});

test('accepts a valid verification object wrapped in markdown or explanatory text', async () => {
  const result = await verifyListingDescriptionWithDeepSeek(
    { marketplace: 'OLX', title: 'Functional console', condition: 'Used', description: 'Fully working and complete.' },
    { apiKey: 'sk-or-v1-test', model: 'deepseek-v4-flash' },
    () => Promise.resolve(Response.json({ choices: [{ message: { content: [
      { type: 'output_text', text: 'Result:\n```json\n' },
      { type: 'output_text', text: JSON.stringify({ decision: 'pass', confidence: 0.9, summary: 'The item is explicitly described as functional.', issues: [], evidence: ['Fully working'] }) },
      { type: 'output_text', text: '\n```' },
    ] } }] })),
  );

  assert.equal(result.decision, 'pass');
});

test('retries once when verification output is malformed JSON', async () => {
  let requests = 0;
  const result = await verifyListingDescriptionWithDeepSeek(
    { marketplace: 'OLX', title: 'Functional console', condition: 'Used', description: 'Fully working and complete.' },
    { apiKey: 'sk-or-v1-test', model: 'deepseek-v4-flash' },
    (_input, init) => {
      requests += 1;
      const body = JSON.parse(String(init?.body)) as Record<string, any>;
      assert.deepEqual(body.plugins, [{ id: 'response-healing' }]);
      const content = requests === 1
        ? '{"decision":"pass","confidence":0.9,"summary":"The item is explicitly described as functional."'
        : JSON.stringify({ decision: 'pass', confidence: 0.9, summary: 'The item is explicitly described as functional.', issues: [], evidence: ['Fully working'] });
      return Promise.resolve(Response.json({ choices: [{ finish_reason: requests === 1 ? 'length' : 'stop', message: { content } }] }));
    },
  );

  assert.equal(result.decision, 'pass');
  assert.equal(requests, 2);
});
