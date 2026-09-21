/**
 * Jev via OpenRouter — standalone proof-of-concept (does not touch server/ai.ts).
 *
 * Uses the OpenRouter Decisions endpoint (verified: POST
 * https://openrouter.ai/api/alpha/decisions -> 401 without key, correct path;
 * the /api/v1/api/alpha/decisions variant 404s) with TypeSafe's System One
 * model Jev. One request fans out two independent judgments over the same
 * state — the two Scout tasks that fit Jev (judgments, not text generation):
 *   1. relevance  (noul)   — mirrors classifyListingRelevanceWithDeepSeek
 *   2. verification (choice) — mirrors verifyListingDescriptionWithDeepSeek
 *
 * Model is configurable: --model flag or SCOUT_JEV_MODEL env, defaulting to
 * the `~typesafe/jev-latest` alias. Key reuses existing precedence:
 * SCOUT_OPENROUTER_API_KEY, then OPENROUTER_API_KEY.
 *
 * Usage:
 *   npx tsx scripts/jev-openrouter-demo.ts --dry-run
 *   SCOUT_OPENROUTER_API_KEY=sk-or-... npx tsx scripts/jev-openrouter-demo.ts \
 *     --query "LEGO Technic 42115" --title "LEGO Technic Lamborghini Sian 42115"
 */

export {};

const DECISIONS_URL = 'https://openrouter.ai/api/alpha/decisions';
const DEFAULT_JEV_MODEL = '~typesafe/jev-latest';

interface DemoOptions {
  model: string;
  query: string;
  title: string;
  condition: string;
  description: string;
  dryRun: boolean;
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return value && !value.startsWith('--') ? value : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function resolveOptions(): DemoOptions {
  return {
    model: argument('--model') || process.env.SCOUT_JEV_MODEL?.trim() || DEFAULT_JEV_MODEL,
    query: argument('--query') ?? 'LEGO Technic 42115 Lamborghini',
    title: argument('--title') ?? 'LEGO Technic Lamborghini Sian FKP 37 42115, komplet, stan bardzo dobry',
    condition: argument('--condition') ?? 'very-good',
    description: argument('--description') ?? 'Sprzedam kompletny zestaw LEGO Technic 42115. Zbudowany raz, stoi na półce. Wszystkie klocki kompletne, instrukcja w zestawie. Odbiór osobisty lub wysyłka.',
    dryRun: hasFlag('--dry-run'),
  };
}

function resolveApiKey(): string | null {
  return process.env.SCOUT_OPENROUTER_API_KEY?.trim()
    || process.env.OPENROUTER_API_KEY?.trim()
    || null;
}

interface JevRequest {
  model: string;
  state: Record<string, unknown>;
  questions: Record<string, unknown>;
  session_id: string;
}

function buildRequest(options: DemoOptions): JevRequest {
  return {
    model: options.model,
    state: {
      query: options.query,
      listing: {
        marketplace: 'OLX',
        title: options.title,
        condition: options.condition,
        location: 'Warszawa',
        description: options.description,
      },
    },
    // Independent questions over the same state run in parallel (fan-out).
    // IDs are for code; full meaning lives in instructions/criteria, and
    // nested state is referenced with backticked paths per the TypeSafe skill.
    questions: {
      relevant: {
        type: 'noul',
        instructions: 'Is the listing for the sought item itself (`listing.title`), rather than an accessory, part, or unrelated good merely compatible with the sought item (`query`)? Answer yes only when the sought item is the primary subject of the listing.',
        criteria: {
          true: 'The sought item itself is the primary subject of the listing (legitimate variants or bundles centered on it count).',
          false: 'Accessories/parts for it, other goods that merely include or feature it, services, wanted ads, unrelated items, compatibility-only mentions, or items explicitly broken/for-parts.',
        },
      },
      verification: {
        type: 'choice',
        instructions: 'Given `listing.title`, `listing.condition`, and `listing.description`, is this second-hand listing safe to surface as a very strong or exceptional deal?',
        criteria: {
          // No-match/unknown outcome included so Jev never has to force a verdict.
          pass: 'The description clearly says the sought item is functional and discloses no material problem.',
          reject: 'Explicit broken, defective, non-working, repair/for-parts, missing essential component, fake/replica, or another material issue.',
          unknown: 'Description missing, ambiguous, contradictory, too short to establish condition, or otherwise not enough evidence. Do not infer safety from price, title, or general product knowledge.',
        },
      },
    },
    session_id: 'scout:jev-demo:v1',
  };
}

interface NoulAnswer { type: 'noul'; noul: number }
interface ChoiceAnswer {
  type: 'choice';
  choice: string;
  probabilities?: Record<string, number>;
  confidence?: number;
}
interface DecisionsResponse {
  model: string;
  answers: Record<string, NoulAnswer | ChoiceAnswer>;
  usage?: { input_tokens: number; output_tokens: number; cost?: number };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseDecisionsResponse(body: unknown): DecisionsResponse {
  if (!isRecord(body) || typeof body.model !== 'string' || !isRecord(body.answers)) {
    throw new Error('Unexpected Decisions response shape (missing model/answers).');
  }
  return body as unknown as DecisionsResponse;
}

/** Code owns the workflow: Jev supplies judgments, thresholds live here. */
function decideOutcome(answers: DecisionsResponse['answers']): { action: string; reason: string } {
  const relevant = answers.relevant;
  const verification = answers.verification;
  if (
    relevant?.type !== 'noul' || typeof relevant.noul !== 'number' || !Number.isFinite(relevant.noul)
    || verification?.type !== 'choice' || typeof verification.choice !== 'string'
  ) {
    return { action: 'hold', reason: 'Unexpected answer types; holding for safety.' };
  }
  if (relevant.noul < 0.5) {
    return { action: 'filter-out', reason: `relevant.noul=${relevant.noul.toFixed(2)} < 0.50 — not the sought item.` };
  }
  if (verification.choice === 'pass') {
    const conf = typeof verification.confidence === 'number' && Number.isFinite(verification.confidence)
      ? ` (confidence ${verification.confidence.toFixed(2)})`
      : '';
    return { action: 'surface', reason: `verification=pass${conf}; relevance p=${relevant.noul.toFixed(2)}.` };
  }
  if (verification.choice === 'reject') {
    return { action: 'hold', reason: `verification=reject — material issue disclosed (relevance p=${relevant.noul.toFixed(2)}).` };
  }
  if (verification.choice === 'unknown') {
    return { action: 'hold', reason: `verification=unknown — not enough evidence (relevance p=${relevant.noul.toFixed(2)}).` };
  }
  return { action: 'hold', reason: `verification=${JSON.stringify(verification.choice)} — unexpected value; holding for safety (relevance p=${relevant.noul.toFixed(2)}).` };
}

const options = resolveOptions();
const request = buildRequest(options);

console.log(`Model: ${request.model} (override: --model or SCOUT_JEV_MODEL)`);
console.log(`Endpoint: POST ${DECISIONS_URL}`);
console.log(JSON.stringify(request, null, 2));

if (options.dryRun) {
  console.log('\n--dry-run: request printed, no network call made.');
  process.exit(0);
}

const apiKey = resolveApiKey();
if (!apiKey) {
  console.error('\nMissing API key. Set SCOUT_OPENROUTER_API_KEY (or OPENROUTER_API_KEY), or re-run with --dry-run.');
  process.exit(1);
}

const response = await fetch(DECISIONS_URL, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify(request),
  signal: AbortSignal.timeout(60_000),
});

const rawBody = await response.text();
let body: unknown;
try {
  body = JSON.parse(rawBody) as unknown;
} catch {
  throw new Error(`Decisions endpoint returned non-JSON (${response.status}).`);
}
if (!response.ok) {
  const message = isRecord(body) && isRecord(body.error) && typeof body.error.message === 'string'
    ? body.error.message
    : `Decisions endpoint returned ${response.status}`;
  throw new Error(message.replace(/\s+/g, ' ').trim().slice(0, 500));
}

const decisions = parseDecisionsResponse(body);
console.log('\nAnswers:');
console.log(JSON.stringify(decisions.answers, null, 2));
if (decisions.usage) console.log(`Usage: ${JSON.stringify(decisions.usage)}`);

const outcome = decideOutcome(decisions.answers);
console.log(`\nDecision (in code, from probabilities): ${outcome.action} — ${outcome.reason}`);
