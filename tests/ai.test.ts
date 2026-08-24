import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyListingRelevanceWithDeepSeek, draftNegotiationMessageWithDeepSeek, listingNormalizationInputHash, listingRelevanceInputHash, normalizeListingWithDeepSeek } from '../server/ai';

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
  assert.equal(body.session_id, 'scout:listing-normalization:v2');
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
      return Promise.resolve(Response.json({ choices: [{ message: { content: JSON.stringify({ relevant: false, reason: 'To wentylator do GPU, a nie karta graficzna.' }) } }] }));
    },
  );

  assert.deepEqual(result, { relevant: false, reason: 'To wentylator do GPU, a nie karta graficzna.' });
  const body = JSON.parse(String(requestInit?.body)) as Record<string, any>;
  assert.equal(body.response_format.type, 'json_schema');
  assert.equal(body.response_format.json_schema.name, 'listing_relevance');
  assert.equal(body.response_format.json_schema.strict, true);
  assert.deepEqual(body.response_format.json_schema.schema.required, ['relevant', 'reason']);
  assert.deepEqual(body.provider, { require_parameters: true });
  assert.deepEqual(body.reasoning, { effort: 'none' });
  assert.equal(body.session_id, 'scout:listing-relevance:v3');
  assert.equal(body.thinking, undefined);
  assert.equal(body.stream, false);
  assert.equal(body.messages[1].content.includes('gpu'), true);
  assert.match(body.messages[0].content, /broken, damaged.*non-working.*for repair.*parts only/i);
});
