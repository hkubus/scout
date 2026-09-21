import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyListingRelevanceWithDeepSeek, draftNegotiationMessageWithDeepSeek, listingDescriptionVerificationInputHash, listingNormalizationInputHash, listingRelevanceInputHash, normalizeListingWithDeepSeek, verifyListingDescriptionWithDeepSeek } from '../server/ai';

const normalized = {
  canonicalTitle: 'Steam Deck OLED',
  category: 'handheld game console',
  brand: 'Valve',
  model: 'Steam Deck OLED',
  variant: '512 GB',
  attributes: [{ name: 'storage', value: '512 GB' }],
  condition: 'like-new',
  conditionNotes: ['The title says “jak nowy”.'],
  flags: [],
  confidence: 0.96,
  evidence: ['Steam Deck OLED 512GB', 'jak nowy'],
};

test('canonicalizes harmless listing and search formatting in AI cache keys', () => {
  assert.equal(
    listingNormalizationInputHash({ marketplace: 'OLX', title: '  RTX  2060  ', condition: 'USED', location: 'ŁÓDŹ' }),
    listingNormalizationInputHash({ marketplace: 'OLX', title: 'rtx 2060', condition: 'used', location: 'łódź' }),
  );
  assert.equal(
    listingNormalizationInputHash({ marketplace: 'OLX', title: 'RTX 2060', condition: 'used', location: 'Łódź' }),
    listingNormalizationInputHash({ marketplace: 'Vinted', title: 'RTX 2060', condition: 'used', location: 'Warszawa' }),
  );
  assert.equal(
    listingRelevanceInputHash({ marketplace: 'OLX', title: 'RTX 2060', condition: 'used', location: 'Łódź', query: 'gpu', includedTerms: '', excludedTerms: '' }),
    listingRelevanceInputHash({ marketplace: 'Vinted', title: 'RTX 2060', condition: 'used', location: 'Warszawa', query: 'gpu', includedTerms: '', excludedTerms: '' }),
  );
  assert.equal(
    listingRelevanceInputHash({ marketplace: 'OLX', title: ' RTX 2060 ', query: 'GPU', includedTerms: 'Nvidia, RTX', excludedTerms: 'fan, cooler' }),
    listingRelevanceInputHash({ marketplace: 'OLX', title: 'rtx 2060', query: 'gpu', includedTerms: 'rtx,nvidia', excludedTerms: ' cooler , FAN ' }),
  );
});

test('normalizes a listing through DeepSeek JSON output via OpenRouter', async () => {
  let requestUrl = '';
  let requestInit: RequestInit | undefined;
  const result = await normalizeListingWithDeepSeek(
    { marketplace: 'OLX', title: 'Steam Deck OLED 512GB · jak nowy', condition: 'Like new', location: 'Warszawa' },
    { apiKey: 'sk-or-v1-test', model: 'deepseek-v4-flash' },
    (input, init) => {
      requestUrl = String(input);
      requestInit = init;
      return Promise.resolve(Response.json({ choices: [{ message: { content: JSON.stringify(normalized) } }] }));
    },
  );

  assert.deepEqual(result, normalized);
  assert.equal(requestUrl, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(new Headers(requestInit?.headers).get('authorization'), 'Bearer sk-or-v1-test');
  const body = JSON.parse(String(requestInit?.body)) as Record<string, any>;
  assert.equal(body.model, 'deepseek/deepseek-v4-flash');
  assert.equal(body.session_id, 'scout:listing-normalization:v3');
  assert.equal(body.max_tokens, 450);
  assert.equal(body.response_format.type, 'json_schema');
  assert.equal(body.response_format.json_schema.name, 'listing_normalization');
  assert.equal(body.response_format.json_schema.strict, true);
  assert.deepEqual(body.response_format.json_schema.schema.required, ['canonicalTitle', 'category', 'brand', 'model', 'variant', 'attributes', 'condition', 'conditionNotes', 'flags', 'confidence', 'evidence']);
  assert.deepEqual(body.provider, { require_parameters: true });
  assert.deepEqual(body.reasoning, { effort: 'none' });
  assert.equal(body.thinking, undefined);
  assert.equal(body.stream, false);
});

test('rejects malformed structured output instead of storing an unsafe shape', async () => {
  await assert.rejects(
    () => normalizeListingWithDeepSeek(
      { marketplace: 'Vinted', title: 'Unknown item' },
      { apiKey: 'sk-or-v1-test', model: 'deepseek/deepseek-v4-flash' },
      () => Promise.resolve(Response.json({ choices: [{ message: { content: '{"canonicalTitle":"Unknown item"}' } }] })),
    ),
    /invalid shape/,
  );
});

test('writes a bounded Polish OLX negotiation message through DeepSeek JSON output via OpenRouter', async () => {
  let requestInit: RequestInit | undefined;
  const result = await draftNegotiationMessageWithDeepSeek(
    { marketplace: 'OLX', title: 'Steam Deck OLED 512GB', price: 1899, condition: 'Like new', location: 'Warszawa', offerPrice: 1700 },
    { apiKey: 'sk-or-v1-test', model: 'deepseek/deepseek-v4-flash' },
    (_input, init) => {
      requestInit = init;
      return Promise.resolve(Response.json({ choices: [{ message: { content: JSON.stringify({ message: 'Dzień dobry, czy rozważy Pan/Pani 1700 zł za Steam Deck OLED 512GB?' }) } }] }));
    },
  );

  assert.equal(result.message, 'Dzień dobry, czy rozważy Pan/Pani 1700 zł za Steam Deck OLED 512GB?');
  const body = JSON.parse(String(requestInit?.body)) as Record<string, any>;
  assert.equal(body.response_format.type, 'json_schema');
  assert.equal(body.response_format.json_schema.name, 'negotiation_message');
  assert.equal(body.response_format.json_schema.strict, true);
  assert.deepEqual(body.response_format.json_schema.schema.required, ['message']);
  assert.deepEqual(body.provider, { require_parameters: true });
  assert.deepEqual(body.reasoning, { effort: 'none' });
  assert.equal(body.session_id, 'scout:negotiation-message:v1');
  assert.equal(body.max_tokens, 160);
  assert.equal(body.thinking, undefined);
  assert.equal(body.stream, false);
  assert.equal(body.messages[1].content.includes('1700'), true);
});

test('keeps Allegro Lokalnie in the marketplace negotiation prompt', async () => {
  let requestInit: RequestInit | undefined;
  await draftNegotiationMessageWithDeepSeek(
    { marketplace: 'Allegro Lokalnie', title: 'Steam Deck OLED 512GB', price: 1899, offerPrice: 1700 },
    { apiKey: 'sk-or-v1-test', model: 'deepseek/deepseek-v4-flash' },
    (_input, init) => {
      requestInit = init;
      return Promise.resolve(Response.json({ choices: [{ message: { content: JSON.stringify({ message: 'Dzień dobry, czy rozważy Pan/Pani 1700 zł?' }) } }] }));
    },
  );

  const body = JSON.parse(String(requestInit?.body)) as Record<string, any>;
  assert.match(body.messages[0].content, /Allegro Lokalnie/);
  assert.equal(body.messages[1].content.includes('Allegro Lokalnie'), true);
});

test('rejects malformed negotiation output instead of sending an unsafe shape', async () => {
  await assert.rejects(
    () => draftNegotiationMessageWithDeepSeek(
      { marketplace: 'OLX', title: 'Unknown item', price: 100 },
      { apiKey: 'sk-or-v1-test', model: 'deepseek/deepseek-v4-flash' },
      () => Promise.resolve(Response.json({ choices: [{ message: { content: '{"message":""}' } }] })),
    ),
    /invalid shape/,
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
  assert.equal(body.session_id, 'scout:listing-relevance:v5');
  assert.equal(body.max_tokens, 32);
  assert.equal(body.thinking, undefined);
  assert.equal(body.stream, false);
  assert.equal(body.messages[1].content.includes('gpu'), true);
  assert.match(body.messages[0].content, /broken, damaged.*non-working.*for repair.*parts only/i);
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
  assert.equal(body.session_id, 'scout:listing-description-verification:v3');
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

test('tolerates provider schema drift in verification output instead of failing with invalid shape', async () => {
  const context = { marketplace: 'OLX' as const, title: 'Steam Deck OLED 512GB', condition: 'Używany', description: 'W pełni sprawny.' };
  const config = { apiKey: 'sk-or-v1-test', model: 'deepseek-v4-flash' };
  const fetcherFor = (payload: unknown) => () => Promise.resolve(Response.json({ choices: [{ message: { content: JSON.stringify(payload) } }] }));
  const base = { decision: 'pass', confidence: 0.9, summary: 'The item works.', issues: [], evidence: ['Works'] };

  // Extra keys are stripped instead of rejected by strict mode.
  assert.equal((await verifyListingDescriptionWithDeepSeek(context, config, fetcherFor({ ...base, reasoning: 'looks fine' }))).decision, 'pass');
  // 0–100 and string confidences are scaled/coerced.
  assert.equal((await verifyListingDescriptionWithDeepSeek(context, config, fetcherFor({ ...base, confidence: 94 }))).confidence, 0.94);
  assert.equal((await verifyListingDescriptionWithDeepSeek(context, config, fetcherFor({ ...base, confidence: '0.82' }))).confidence, 0.82);
  // Over-long and empty strings are truncated/dropped, casing normalized.
  const messy = await verifyListingDescriptionWithDeepSeek(context, config, fetcherFor({
    decision: 'Pass', confidence: 0.9, summary: `  ${'x'.repeat(300)}  `, issues: ['', 'noisy fan'], evidence: [],
  }));
  assert.equal(messy.decision, 'pass');
  assert.equal(messy.summary.length, 240);
  assert.deepEqual(messy.issues, ['noisy fan']);
  // An unrecognizable object degrades to a safe unknown hold instead of throwing.
  assert.equal((await verifyListingDescriptionWithDeepSeek(context, config, fetcherFor({ foo: 1 }))).decision, 'unknown');
  // Out-of-range confidence keeps the decision but falls back to 0.5.
  const badConf = await verifyListingDescriptionWithDeepSeek(context, config, fetcherFor({ ...base, confidence: 1.5 }));
  assert.equal(badConf.decision, 'pass');
  assert.equal(badConf.confidence, 0.5);
});

test('sends the watch query with verification and rejects accessories in the prompt', async () => {
  let requestInit: RequestInit | undefined;
  const result = await verifyListingDescriptionWithDeepSeek(
    { marketplace: 'OLX', title: 'Wentylator Zotac RTX 1660/2060/2070/3050/3060 chłodzenie', condition: 'Używany', description: 'Sprawny wentylator.', query: 'RTX 3060', includedTerms: '', excludedTerms: '' },
    { apiKey: 'sk-or-v1-test', model: 'deepseek-v4-flash' },
    (_input, init) => {
      requestInit = init;
      return Promise.resolve(Response.json({ choices: [{ message: { content: JSON.stringify({ decision: 'reject', confidence: 0.9, summary: 'Accessory, not the GPU.', issues: ['Accessory listing'], evidence: ['Wentylator'] }) } }] }));
    },
  );

  assert.equal(result.decision, 'reject');
  const body = JSON.parse(String(requestInit?.body)) as Record<string, any>;
  assert.equal(JSON.parse(body.messages[1].content).query, 'RTX 3060');
  assert.match(body.messages[0].content, /accessory/i);
});
