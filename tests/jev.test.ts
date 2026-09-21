import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_JEV_MODEL, FUZZY_MATCH_MIN_CONFIDENCE, JEV_DECISIONS_URL, NEGOTIABILITY_MIN_CONFIDENCE, RELEVANCE_UNSURE_HIGH, RELEVANCE_UNSURE_LOW, VERIFICATION_MIN_CONFIDENCE, classifyConditionMatchWithJev, classifyListingRelevanceWithJev, classifyNegotiabilityWithJev, classifyTermMatchWithJev, isFuzzyMatchUnsure, isNegotiabilityUnsure, isRelevanceUnsure, isVerificationUnsure, resolveJevModel, verifyListingDescriptionWithJev } from '../server/jev';
import { DEFAULT_VISION_MODEL, VISION_MAX_IMAGES, classifyListingRelevanceWithVision, resolveVisionModel, verifyListingDescriptionWithVision } from '../server/vision';

const relevanceContext = {
  marketplace: 'OLX' as const,
  title: 'LEGO Technic 42115 Lamborghini Sian',
  condition: 'very-good',
  location: 'Warszawa',
  pricePln: 1899,
  query: 'LEGO Technic 42115',
  includedTerms: '',
  excludedTerms: '',
};

const verificationContext = {
  marketplace: 'OLX' as const,
  title: 'LEGO Technic 42115 Lamborghini Sian',
  condition: 'very-good',
  description: 'Kompletny zestaw, zbudowany raz, wszystkie klocki.',
};

test('resolves Jev and vision models with env fallback to defaults', () => {
  assert.equal(DEFAULT_JEV_MODEL, '~typesafe/jev-latest');
  assert.equal(DEFAULT_VISION_MODEL, 'deepseek/deepseek-v4.1-flash');
  assert.equal(resolveJevModel('typesafe/jev-1.13'), 'typesafe/jev-1.13');
  assert.equal(resolveJevModel('jev-1.13'), 'typesafe/jev-1.13');
  assert.equal(resolveJevModel('~typesafe/jev-latest'), '~typesafe/jev-latest');
  assert.equal(resolveVisionModel('  '), 'deepseek/deepseek-v4.1-flash');
});

test('classifies relevance through Jev Decisions via OpenRouter', async () => {
  let requestUrl = '';
  let requestInit: RequestInit | undefined;
  const result = await classifyListingRelevanceWithJev(
    relevanceContext,
    { apiKey: 'sk-or-v1-test', model: '~typesafe/jev-latest' },
    (input, init) => {
      requestUrl = String(input);
      requestInit = init;
      return Promise.resolve(Response.json({
        model: '~typesafe/jev-latest',
        answers: { relevant: { type: 'noul', noul: 0.91 } },
        usage: { input_tokens: 100, output_tokens: 5 },
      }));
    },
  );

  assert.deepEqual(result, { relevant: true, p: 0.91, unsure: false });
  assert.equal(requestUrl, JEV_DECISIONS_URL);
  assert.equal(new Headers(requestInit?.headers).get('authorization'), 'Bearer sk-or-v1-test');
  const body = JSON.parse(String(requestInit?.body)) as Record<string, any>;
  assert.equal(body.model, '~typesafe/jev-latest');
  assert.equal(body.session_id, 'scout:jev-relevance:v1');
  assert.deepEqual(body.state.listing, {
    marketplace: 'OLX',
    title: 'LEGO Technic 42115 Lamborghini Sian',
    condition: 'very-good',
    location: 'Warszawa',
    pricePln: 1899,
    description: null,
  });
  assert.equal(body.questions.relevant.type, 'noul');
  assert.ok(body.questions.relevant.criteria.true);
  assert.ok(body.questions.relevant.criteria.false);
});

test('marks mid-band relevance probabilities as unsure', () => {
  assert.equal(isRelevanceUnsure(0.1), false);
  assert.equal(isRelevanceUnsure(RELEVANCE_UNSURE_LOW), false);
  assert.equal(isRelevanceUnsure(0.5), true);
  assert.equal(isRelevanceUnsure(RELEVANCE_UNSURE_HIGH), false);
  assert.equal(isRelevanceUnsure(0.9), false);
});

test('verifies a description through a Jev Choice with confidence', async () => {
  let requestInit: RequestInit | undefined;
  const result = await verifyListingDescriptionWithJev(
    verificationContext,
    { apiKey: 'sk-or-v1-test', model: null },
    (input, init) => {
      requestInit = init;
      assert.equal(String(input), JEV_DECISIONS_URL);
      return Promise.resolve(Response.json({
        model: 'typesafe/jev-1.13',
        answers: {
          verification: {
            type: 'choice', choice: 'pass', confidence: 0.82,
            probabilities: { pass: 0.8, reject: 0.05, unknown: 0.15 },
          },
        },
        usage: { input_tokens: 200, output_tokens: 8 },
      }));
    },
  );

  assert.deepEqual(result, { decision: 'pass', confidence: 0.82, unsure: false });
  const body = JSON.parse(String(requestInit?.body)) as Record<string, any>;
  assert.equal(body.model, '~typesafe/jev-latest');
  assert.equal(body.session_id, 'scout:jev-verification:v1');
  assert.deepEqual(Object.keys(body.questions.verification.criteria).sort(), ['pass', 'reject', 'unknown']);
});

test('treats unknown verdicts and low confidence as unsure', () => {
  assert.equal(isVerificationUnsure('unknown', 0.99), true);
  assert.equal(isVerificationUnsure('pass', 0.9), false);
  assert.equal(isVerificationUnsure('pass', VERIFICATION_MIN_CONFIDENCE), false);
  assert.equal(isVerificationUnsure('reject', 0.2), true);
  assert.equal(isVerificationUnsure('pass', null), true);
});

test('maps unexpected Choice values to unknown instead of trusting them', async () => {
  const result = await verifyListingDescriptionWithJev(
    verificationContext,
    { apiKey: 'sk-or-v1-test' },
    () => Promise.resolve(Response.json({
      model: 'm', answers: { verification: { type: 'choice', choice: 'maybe', confidence: 0.9 } },
      usage: { input_tokens: 1, output_tokens: 1 },
    })),
  );
  assert.deepEqual(result, { decision: 'unknown', confidence: 0.9, unsure: true });
});

test('retries a transient 520 from Decisions then succeeds', async () => {
  let calls = 0;
  const result = await classifyListingRelevanceWithJev(
    relevanceContext,
    { apiKey: 'sk-or-v1-test' },
    () => {
      calls += 1;
      if (calls === 1) return Promise.resolve(new Response(JSON.stringify({ error: { message: 'Upstream error' } }), { status: 520 }));
      return Promise.resolve(Response.json({
        model: '~typesafe/jev-latest',
        answers: { relevant: { type: 'noul', noul: 0.2 } },
        usage: { input_tokens: 1, output_tokens: 1 },
      }));
    },
  );
  assert.deepEqual(result, { relevant: false, p: 0.2, unsure: false });
  assert.equal(calls, 2);
});

test('does not retry a 400 from Decisions', async () => {
  let calls = 0;
  await assert.rejects(
    () => classifyListingRelevanceWithJev(
      relevanceContext,
      { apiKey: 'sk-or-v1-test' },
      () => {
        calls += 1;
        return Promise.resolve(new Response(JSON.stringify({ error: { message: 'Bad request' } }), { status: 400 }));
      },
    ),
    /Bad request/,
  );
  assert.equal(calls, 1);
});

test('retries a transient 502 from vision then succeeds', async () => {
  let calls = 0;
  const result = await verifyListingDescriptionWithVision(
    { marketplace: 'OLX', title: 't', condition: null, description: null, imageUrls: [] },
    { apiKey: 'sk-or-v1-test' },
    () => {
      calls += 1;
      if (calls === 1) return Promise.resolve(new Response(JSON.stringify({ error: 'Provider error' }), { status: 502 }));
      return Promise.resolve(Response.json({
        choices: [{ message: { content: JSON.stringify({ verdict: 'unknown', confidence: 0.5, issues: [] }) } }],
      }));
    },
  );
  assert.deepEqual(result, { decision: 'unknown', confidence: 0.5, issues: [], imagesSeen: 0 });
  assert.equal(calls, 2);
});

test('rejects malformed Decisions answers instead of deciding', async () => {
  await assert.rejects(
    () => classifyListingRelevanceWithJev(
      relevanceContext,
      { apiKey: 'sk-or-v1-test' },
      () => Promise.resolve(Response.json({ model: 'm', answers: { relevant: { type: 'noul' } }, usage: { input_tokens: 1, output_tokens: 1 } })),
    ),
    /invalid shape/,
  );
  await assert.rejects(
    () => classifyListingRelevanceWithJev(
      relevanceContext,
      { apiKey: 'sk-or-v1-test' },
      () => Promise.resolve(Response.json(null)),
    ),
    /without answers/,
  );
  await assert.rejects(
    () => verifyListingDescriptionWithVision(
      { marketplace: 'OLX', title: 't', condition: null, description: null, imageUrls: [] },
      { apiKey: 'sk-or-v1-test' },
      () => Promise.resolve(Response.json(null)),
    ),
    /without answers/,
  );
});

test('escalates verification to vision with gallery photos as image parts', async () => {
  let requestInit: RequestInit | undefined;
  const result = await verifyListingDescriptionWithVision(
    { marketplace: 'OLX', title: 'Rower', condition: 'good', description: 'Sprawny.', imageUrls: ['https://img.example/a.jpg', 'http://insecure.example/b.jpg', 'https://img.example/a.jpg', 'https://img.example/c.jpg', 'https://img.example/d.jpg'] },
    { apiKey: 'sk-or-v1-test', model: 'openai/gpt-4o-mini' },
    (input, init) => {
      requestInit = init;
      assert.equal(String(input), 'https://openrouter.ai/api/v1/chat/completions');
      return Promise.resolve(Response.json({
        choices: [{ message: { content: JSON.stringify({ verdict: 'pass', confidence: 0.77, issues: [] }) } }],
      }));
    },
  );

  assert.deepEqual(result, { decision: 'pass', confidence: 0.77, issues: [], imagesSeen: VISION_MAX_IMAGES });
  const body = JSON.parse(String(requestInit?.body)) as Record<string, any>;
  assert.equal(body.model, 'openai/gpt-4o-mini');
  assert.equal(body.session_id, 'scout:vision-verification:v1');
  assert.equal(body.response_format.json_schema.strict, true);
  assert.deepEqual(body.provider, { require_parameters: true });
  const parts = body.messages[1].content as Array<Record<string, any>>;
  assert.equal(parts[0].type, 'text');
  const images = parts.filter((part) => part.type === 'image_url');
  // http:// dropped, duplicate collapsed, capped at VISION_MAX_IMAGES.
  assert.deepEqual(images.map((part) => part.image_url.url), ['https://img.example/a.jpg', 'https://img.example/c.jpg', 'https://img.example/d.jpg']);
});

test('tiebreaks unsure relevance through vision with the thumbnail', async () => {
  const result = await classifyListingRelevanceWithVision(
    { query: 'q', title: 't', condition: null, imageUrl: 'https://img.example/thumb.jpg' },
    { apiKey: 'sk-or-v1-test' },
    () => Promise.resolve(Response.json({
      choices: [{ message: { content: JSON.stringify({ relevant: false, confidence: 0.62 }) } }],
    })),
  );
  assert.deepEqual(result, { relevant: false, confidence: 0.62, imagesSeen: 1 });
});

test('rescues term near-misses only on confident pass', async () => {
  const pass = await classifyTermMatchWithJev(
    { query: 'ladowarka', includedTerms: '', excludedTerms: '', title: 'Ładowarki do laptopa', condition: null },
    { apiKey: 'sk-or-v1-test' },
    (input, init) => {
      assert.equal(String(input), JEV_DECISIONS_URL);
      const body = JSON.parse(String((init as RequestInit)?.body)) as Record<string, any>;
      assert.equal(body.session_id, 'scout:jev-term-match:v1');
      assert.equal(body.questions.termMatch.type, 'choice');
      return Promise.resolve(Response.json({
        model: 'm', answers: { termMatch: { type: 'choice', choice: 'pass', confidence: 0.85 } },
        usage: { input_tokens: 1, output_tokens: 1 },
      }));
    },
  );
  assert.deepEqual(pass, { decision: 'pass', confidence: 0.85, unsure: false });

  const weak = await classifyTermMatchWithJev(
    { query: 'ps5', includedTerms: '', excludedTerms: '', title: 'PS5', condition: null },
    { apiKey: 'sk-or-v1-test' },
    () => Promise.resolve(Response.json({
      model: 'm', answers: { termMatch: { type: 'choice', choice: 'pass', confidence: 0.5 } },
      usage: { input_tokens: 1, output_tokens: 1 },
    })),
  );
  assert.equal(weak.unsure, true);
  assert.equal(isFuzzyMatchUnsure('pass', 0.5), true);
  assert.equal(isFuzzyMatchUnsure('pass', FUZZY_MATCH_MIN_CONFIDENCE), false);
  assert.equal(isFuzzyMatchUnsure('unknown', 0.99), true);
});

test('upgrades negotiability only on confident negotiable', async () => {
  const result = await classifyNegotiabilityWithJev(
    { marketplace: 'OLX', title: 'Rower', condition: null, description: 'Cena do uzgodnienia, zapraszam.' },
    { apiKey: 'sk-or-v1-test' },
    (input, init) => {
      const body = JSON.parse(String((init as RequestInit)?.body)) as Record<string, any>;
      assert.equal(body.session_id, 'scout:jev-negotiability:v1');
      return Promise.resolve(Response.json({
        model: 'm', answers: { negotiability: { type: 'choice', choice: 'negotiable', confidence: 0.9 } },
        usage: { input_tokens: 1, output_tokens: 1 },
      }));
    },
  );
  assert.deepEqual(result, { decision: 'negotiable', confidence: 0.9, unsure: false });
  assert.equal(isNegotiabilityUnsure('negotiable', 0.5), true);
  assert.equal(isNegotiabilityUnsure('negotiable', NEGOTIABILITY_MIN_CONFIDENCE), false);
  assert.equal(isNegotiabilityUnsure('unknown', 0.99), true);
});

test('matches condition labels only on confident match', async () => {
  const result = await classifyConditionMatchWithJev(
    { requestedCondition: 'New', listingCondition: 'Jak nowy', title: 'Telefon jak nowy' },
    { apiKey: 'sk-or-v1-test' },
    (input, init) => {
      const body = JSON.parse(String((init as RequestInit)?.body)) as Record<string, any>;
      assert.equal(body.session_id, 'scout:jev-condition:v1');
      return Promise.resolve(Response.json({
        model: 'm', answers: { conditionMatch: { type: 'choice', choice: 'match', confidence: 0.8 } },
        usage: { input_tokens: 1, output_tokens: 1 },
      }));
    },
  );
  assert.deepEqual(result, { decision: 'match', confidence: 0.8, unsure: false });
});

test('tolerates Decisions shape drift in verification answers', async () => {
  const run = (answer: unknown) => verifyListingDescriptionWithJev(
    verificationContext,
    { apiKey: 'sk-or-v1-test' },
    () => Promise.resolve(Response.json({ model: 'm', answers: { verification: answer } })),
  );

  assert.deepEqual(await run({ type: 'choice', choice: 'pass', confidence: '0.82' }), { decision: 'pass', confidence: 0.82, unsure: false });
  assert.deepEqual(await run({ type: 'choice', choice: 'pass', confidence: 82 }), { decision: 'pass', confidence: 0.82, unsure: false });
  assert.deepEqual(await run({ type: 'choice', choice: 'Pass', confidence: 0.9 }), { decision: 'pass', confidence: 0.9, unsure: false });
  // Missing type/confidence degrades to a usable judgment or escalation, not an invalid shape.
  assert.deepEqual(await run({ choice: 'pass', confidence: 0.9 }), { decision: 'pass', confidence: 0.9, unsure: false });
  const noConfidence = await run({ type: 'choice', choice: 'reject' });
  assert.equal(noConfidence.decision, 'reject');
  assert.equal(noConfidence.unsure, true);
  // Out-of-range confidence escalates instead of failing: decision kept, unsure set.
  const outOfRange = await run({ type: 'choice', choice: 'pass', confidence: 150 });
  assert.equal(outOfRange.decision, 'pass');
  assert.equal(outOfRange.confidence, null);
  assert.equal(outOfRange.unsure, true);
  // A wrong answer kind still throws instead of being trusted.
  await assert.rejects(() => run({ type: 'noul', noul: 0.5 }), /invalid shape/);
  await assert.rejects(() => run({ foo: 1 }), /invalid shape/);
});

test('sends the watch query and accessory criteria with verification', async () => {
  let requestInit: RequestInit | undefined;
  await verifyListingDescriptionWithJev(
    { ...verificationContext, query: 'LEGO Technic 42115', includedTerms: '', excludedTerms: '' },
    { apiKey: 'sk-or-v1-test' },
    (_input, init) => {
      requestInit = init;
      return Promise.resolve(Response.json({ model: 'm', answers: { verification: { type: 'choice', choice: 'pass', confidence: 0.9 } } }));
    },
  );

  const body = JSON.parse(String(requestInit?.body)) as Record<string, any>;
  assert.equal(body.state.watch.query, 'LEGO Technic 42115');
  assert.match(body.questions.verification.criteria.reject, /accessory/i);
});

test('tolerates provider schema drift in vision verification', async () => {
  const run = (payload: unknown) => verifyListingDescriptionWithVision(
    { marketplace: 'OLX', title: 't', condition: null, description: 'd', imageUrls: [] },
    { apiKey: 'sk-or-v1-test' },
    () => Promise.resolve(Response.json({ choices: [{ message: { content: JSON.stringify(payload) } }] })),
  );

  const drifted = await run({ verdict: 'Pass', confidence: 82, issues: ['', 'scratch'], extra: 1 });
  assert.deepEqual(drifted, { decision: 'pass', confidence: 0.82, issues: ['scratch'], imagesSeen: 0 });
  const garbage = await run({ foo: 1 });
  assert.equal(garbage.decision, 'unknown');
  const badConf = await run({ verdict: 'pass', confidence: 1.5, issues: [] });
  assert.equal(badConf.decision, 'pass');
  assert.equal(badConf.confidence, 0.5);
});
