import { z } from 'zod';
import type { ListingDescriptionVerificationContext, ListingRelevanceContext } from './ai';
import { PROVIDER_MAX_ATTEMPTS, isRetryableProviderStatus, isTransientFetchError, providerBackoffMs, sleep } from './openrouter';

/**
 * Jev (TypeSafe System One) through OpenRouter's Decisions endpoint.
 *
 * Unlike the chat-completions calls in ai.ts, Jev does not generate text: it
 * returns typed judgments (probabilities + confidence) over caller-supplied
 * state. Code owns the workflow and thresholds; Jev supplies the semantic
 * judgment. See skills/typesafe-ai/SKILL.md and https://docs.typesafe.ai.
 *
 * Verified endpoint: POST https://openrouter.ai/api/alpha/decisions
 * (unauthenticated probes return 401 there; the /api/v1/api/alpha/decisions
 * variant 404s — the OpenAPI `servers` field double-counts `/api`).
 */

export const JEV_DECISIONS_URL = 'https://openrouter.ai/api/alpha/decisions';
export const DEFAULT_JEV_MODEL = '~typesafe/jev-latest';

const JEV_RELEVANCE_SESSION_ID = 'scout:jev-relevance:v1';
const JEV_VERIFICATION_SESSION_ID = 'scout:jev-verification:v1';

/** Model is configurable: explicit config wins, then env, then the alias. */
export function resolveJevModel(configured?: string | null): string {
  const value = configured?.trim() || process.env.SCOUT_JEV_MODEL?.trim() || DEFAULT_JEV_MODEL;
  if (value.startsWith('~') || value.includes('/')) return value;
  return `typesafe/${value}`;
}

/**
 * Initial unsure-band for the relevance noul judgment, to be calibrated against local
 * shadow data (see jev_shadow_log). Noul carries no separate confidence — the
 * probability itself is the uncertainty signal.
 */
export const RELEVANCE_UNSURE_LOW = 0.3;
export const RELEVANCE_UNSURE_HIGH = 0.7;

/** Minimum Choice confidence for a verification verdict to stand without escalation. */
export const VERIFICATION_MIN_CONFIDENCE = 0.6;

export function isRelevanceUnsure(p: number): boolean {
  return p > RELEVANCE_UNSURE_LOW && p < RELEVANCE_UNSURE_HIGH;
}

export function isVerificationUnsure(decision: string, confidence: number | null): boolean {
  if (decision === 'unknown') return true;
  return confidence === null || !Number.isFinite(confidence) || confidence < VERIFICATION_MIN_CONFIDENCE;
}

export class JevError extends Error {
  status: number;
  kind: 'provider' | 'format';

  constructor(message: string, status = 502, kind: 'provider' | 'format' = 'provider') {
    super(message);
    this.name = 'JevError';
    this.status = status;
    this.kind = kind;
  }
}

function safeProviderMessage(value: string) {
  return value.replace(/\s+/g, ' ').trim().slice(0, 500) || 'OpenRouter Decisions request failed';
}

const noulAnswerSchema = z.object({
  type: z.literal('noul'),
  noul: z.number().min(0).max(1),
}).strict().catchall(z.unknown());

const choiceAnswerSchema = z.object({
  type: z.literal('choice'),
  choice: z.string(),
  confidence: z.number().min(0).max(1).nullish(),
  probabilities: z.record(z.string(), z.number()).nullish(),
}).strict().catchall(z.unknown());

export interface JevRelevanceJudgment {
  relevant: boolean;
  p: number;
  unsure: boolean;
}

export interface JevVerificationJudgment {
  decision: 'pass' | 'reject' | 'unknown';
  confidence: number | null;
  unsure: boolean;
}

async function postDecisions(body: Record<string, unknown>, apiKey: string, label: string, fetcher: typeof fetch) {
  for (let attempt = 0; attempt < PROVIDER_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await attemptDecisions(body, apiKey, label, fetcher);
    } catch (error) {
      const retryable = error instanceof JevError
        ? error.kind === 'provider' && isRetryableProviderStatus(error.status)
        : isTransientFetchError(error);
      if (!retryable || attempt === PROVIDER_MAX_ATTEMPTS - 1) throw error;
      await sleep(providerBackoffMs(attempt));
    }
  }
  throw new JevError(`OpenRouter Decisions returned ${label} without answers`, 502, 'format');
}

async function attemptDecisions(body: Record<string, unknown>, apiKey: string, label: string, fetcher: typeof fetch) {
  const response = await fetcher(JEV_DECISIONS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });

  const rawBody = await response.text();
  let parsed: { error?: { message?: unknown } | string; answers?: unknown } | null;
  try {
    parsed = JSON.parse(rawBody) as typeof parsed;
  } catch {
    throw new JevError(`OpenRouter Decisions returned an invalid response (${response.status})`, response.status >= 400 ? response.status : 502);
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new JevError(`OpenRouter Decisions returned ${label} without answers`, 502, 'format');
  }
  if (!response.ok) {
    const providerError = typeof parsed.error === 'string' ? parsed.error : parsed.error?.message;
    throw new JevError(safeProviderMessage(typeof providerError === 'string' ? providerError : `OpenRouter Decisions returned ${response.status}`), response.status);
  }
  if (!parsed.answers || typeof parsed.answers !== 'object') {
    throw new JevError(`OpenRouter Decisions returned ${label} without answers`, 502, 'format');
  }
  return parsed.answers as Record<string, unknown>;
}

/** Shadow-capable Jev relevance judgment. Mirrors classifyListingRelevanceWithDeepSeek's policy. */
export async function classifyListingRelevanceWithJev(
  context: ListingRelevanceContext,
  config: { apiKey: string; model?: string | null },
  fetcher: typeof fetch = fetch,
): Promise<JevRelevanceJudgment> {
  const answers = await postDecisions({
    model: resolveJevModel(config.model),
    session_id: JEV_RELEVANCE_SESSION_ID,
    state: {
      query: context.query,
      includedTerms: context.includedTerms || null,
      excludedTerms: context.excludedTerms || null,
      listing: {
        marketplace: context.marketplace,
        title: context.title,
        condition: context.condition ?? null,
        location: context.location ?? null,
        pricePln: context.pricePln ?? null,
        description: context.description ?? null,
      },
    },
    questions: {
      relevant: {
        type: 'noul',
        instructions: 'Is the listing for the sought item itself (`listing.title`), rather than an accessory, part, or unrelated good merely compatible with the sought item (`query`)? Answer yes only when the sought item is the primary subject of the listing. Use `listing.pricePln` only as a supporting signal (e.g. a bundle priced far above a single unit); never infer condition, authenticity, or specifications from price.',
        criteria: {
          // OpenRouter requires both keys when criteria is present on a noul.
          true: 'The sought item itself is the primary subject of the listing (legitimate variants or bundles centered on it count).',
          false: 'Accessories/parts for it, other goods that merely include or feature it, services, wanted ads, unrelated items, compatibility-only mentions, or items explicitly broken/for-parts.',
        },
      },
    },
  }, config.apiKey, 'listing relevance', fetcher);

  const parsed = noulAnswerSchema.safeParse(answers.relevant);
  if (!parsed.success) throw new JevError('OpenRouter Decisions returned listing relevance with an invalid shape', 502, 'format');
  const p = parsed.data.noul;
  return { relevant: p >= 0.5, p, unsure: isRelevanceUnsure(p) };
}

/** Shadow-capable Jev verification judgment. Mirrors verifyListingDescriptionWithDeepSeek's policy. */
export async function verifyListingDescriptionWithJev(
  context: ListingDescriptionVerificationContext,
  config: { apiKey: string; model?: string | null },
  fetcher: typeof fetch = fetch,
): Promise<JevVerificationJudgment> {
  const answers = await postDecisions({
    model: resolveJevModel(config.model),
    session_id: JEV_VERIFICATION_SESSION_ID,
    state: {
      listing: {
        marketplace: context.marketplace,
        title: context.title,
        condition: context.condition ?? null,
        description: context.description,
      },
    },
    questions: {
      verification: {
        type: 'choice',
        instructions: 'Given `listing.title`, `listing.condition`, and `listing.description`, is this second-hand listing safe to surface as a very strong or exceptional deal?',
        criteria: {
          pass: 'The description clearly says the sought item is functional and discloses no material problem.',
          reject: 'Explicit broken, defective, non-working, repair/for-parts, missing essential component, fake/replica, or another material issue.',
          unknown: 'Description missing, ambiguous, contradictory, too short to establish condition, or otherwise not enough evidence. Do not infer safety from a low price, title, or general product knowledge.',
        },
      },
    },
  }, config.apiKey, 'listing description verification', fetcher);

  const parsed = choiceAnswerSchema.safeParse(answers.verification);
  if (!parsed.success) throw new JevError('OpenRouter Decisions returned listing description verification with an invalid shape', 502, 'format');
  const decision = parsed.data.choice === 'pass' || parsed.data.choice === 'reject' ? parsed.data.choice : 'unknown';
  const confidence = typeof parsed.data.confidence === 'number' && Number.isFinite(parsed.data.confidence)
    ? parsed.data.confidence
    : null;
  return { decision, confidence, unsure: isVerificationUnsure(decision, confidence) };
}
