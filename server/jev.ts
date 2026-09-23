import { z } from 'zod';
import type { ListingDescriptionVerificationContext, ListingRelevanceContext } from './ai';
import { normalizeModelConfidence, normalizeModelDecision } from './ai';
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

const JEV_RELEVANCE_SESSION_ID = 'scout:jev-relevance:v2';
const JEV_VERIFICATION_SESSION_ID = 'scout:jev-verification:v1';
const JEV_TERM_MATCH_SESSION_ID = 'scout:jev-term-match:v1';
const JEV_NEGOTIABILITY_SESSION_ID = 'scout:jev-negotiability:v1';
const JEV_CONDITION_SESSION_ID = 'scout:jev-condition:v1';

/** Model is configurable: explicit config wins, then env, then the alias. */
export function resolveJevModel(configured?: string | null): string {
  const value = configured?.trim() || process.env.SCOUT_JEV_MODEL?.trim() || DEFAULT_JEV_MODEL;
  if (value.startsWith('~') || value.includes('/')) return value;
  return `typesafe/${value}`;
}

/**
 * Unsure band for the relevance noul judgment. Narrow by design: filter-only
 * relevance follows the Jev lean without vision escalation, so only genuinely
 * borderline probabilities stay unsure. Calibrated against local shadow data
 * (see jev_shadow_log). Noul carries no separate confidence — the
 * probability itself is the uncertainty signal.
 */
export const RELEVANCE_UNSURE_LOW = 0.4;
export const RELEVANCE_UNSURE_HIGH = 0.6;

/** Minimum Choice confidence for a verification verdict to stand without escalation. */
export const VERIFICATION_MIN_CONFIDENCE = 0.6;

/** Minimum Choice confidence to rescue a deterministic term/condition miss. Conservative: only a confident pass widens results. */
export const FUZZY_MATCH_MIN_CONFIDENCE = 0.75;

/** Minimum Choice confidence to upgrade unknown negotiability to negotiable. Never flips an explicit fixed signal. */
export const NEGOTIABILITY_MIN_CONFIDENCE = 0.8;

export function isRelevanceUnsure(p: number): boolean {
  return p > RELEVANCE_UNSURE_LOW && p < RELEVANCE_UNSURE_HIGH;
}

export function isVerificationUnsure(decision: string, confidence: number | null): boolean {
  if (decision === 'unknown') return true;
  return confidence === null || !Number.isFinite(confidence) || confidence < VERIFICATION_MIN_CONFIDENCE;
}

export function isFuzzyMatchUnsure(decision: string, confidence: number | null): boolean {
  if (decision === 'unknown') return true;
  return confidence === null || !Number.isFinite(confidence) || confidence < FUZZY_MATCH_MIN_CONFIDENCE;
}

export function isNegotiabilityUnsure(decision: string, confidence: number | null): boolean {
  if (decision === 'unknown') return true;
  return confidence === null || !Number.isFinite(confidence) || confidence < NEGOTIABILITY_MIN_CONFIDENCE;
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

const choiceAnswerSchema = z.preprocess(
  (raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
    const record = raw as Record<string, unknown>;
    const hasChoice = 'choice' in record;
    return {
      ...record,
      // A missing `type` is treated as the keyed choice answer only when a
      // `choice` is present (answers are already namespaced per question); a
      // present but different type, or an object with neither, still fails
      // validation so a wrong answer kind is never trusted.
      type: normalizeModelDecision(record.type) ?? (hasChoice ? 'choice' : undefined),
      // An unrecognized choice maps to `unknown` downstream (safe hold),
      // never to a trusted pass/reject.
      choice: normalizeModelDecision(record.choice) ?? '',
      // Unparseable or out-of-range confidence becomes null, which the
      // `unsure` thresholds treat as "escalate", instead of failing the
      // whole judgment with an invalid shape.
      confidence: normalizeModelConfidence(record.confidence) ?? null,
    };
  },
  z.object({
    type: z.literal('choice'),
    choice: z.string(),
    confidence: z.number().min(0).max(1).nullish(),
    // Unused downstream; accept anything so stray provider metadata never
    // fails validation.
    probabilities: z.unknown().nullish(),
  }),
);

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

export interface JevTermMatchContext {
  query: string;
  includedTerms: string;
  excludedTerms: string;
  title: string;
  condition?: string | null;
}

export interface JevTermMatchJudgment {
  decision: 'pass' | 'reject' | 'unknown';
  confidence: number | null;
  unsure: boolean;
}

export interface JevNegotiabilityContext {
  marketplace: string;
  title: string;
  condition?: string | null;
  description: string | null;
}

export interface JevNegotiabilityJudgment {
  decision: 'negotiable' | 'fixed' | 'unknown';
  confidence: number | null;
  unsure: boolean;
}

export interface JevConditionMatchContext {
  requestedCondition: string;
  listingCondition?: string | null;
  title: string;
}

export interface JevConditionMatchJudgment {
  decision: 'match' | 'mismatch' | 'unknown';
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
        description: context.description ?? null,
      },
    },
    questions: {
      relevant: {
        type: 'noul',
        instructions: 'Is the listing for the sought item itself, rather than an accessory, part, or unrelated good merely mentioning or compatible with the sought item (`query`)? Answer yes only when the sought item is the primary subject of the listing (`listing.title`). A different component or device that merely mentions the sought item as a specification, included chip, or compatibility (e.g. a motherboard from a laptop that has the sought GPU, a laptop containing it, a cooler or case for it) is not the sought item, even when the model numbers look close. Use `listing.title` and `listing.condition` as evidence: a title or condition stating the item is broken, damaged, non-working, defective, incomplete, for repair, or for parts — in any language (e.g. Polish `uszkodzony`, `uszkodzona`, `niesprawny`, `na czesci`, `dawca czesci`, `do naprawy`) — means no, even without a description.',
        criteria: {
          // OpenRouter requires both keys when criteria is present on a noul.
          true: 'The sought item itself is the primary subject of the listing (legitimate variants or bundles centered on it count), with no indication it is broken or for parts.',
          false: 'Accessories/parts for it, other goods that merely include, mention, or feature it (including a different component or device that only cites it as a spec, chip, or compatibility), services, wanted ads, unrelated items, compatibility-only mentions, or items explicitly broken, damaged, non-working, defective, incomplete, for repair, or for parts in any language.',
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
      watch: {
        query: context.query?.trim() || null,
        includedTerms: context.includedTerms?.trim() || null,
        excludedTerms: context.excludedTerms?.trim() || null,
      },
    },
    questions: {
      verification: {
        type: 'choice',
        instructions: 'Given `listing.title`, `listing.condition`, `listing.description`, and the sought item named by `watch.query`, is this second-hand listing safe to surface as a very strong or exceptional deal?',
        criteria: {
          pass: 'The description clearly says the sought item is functional and discloses no material problem.',
          reject: 'Explicit broken, defective, non-working, repair/for-parts, missing essential component, fake/replica, or another material issue — or the title shows the listing is for an accessory, part, or replacement component (fan, cooler, cooling, case, cable, adapter, battery) rather than the sought item itself, even when that accessory is functional.',
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

/** P1: near-miss rescue for deterministic term filtering. Only a confident pass widens results; unknown/reject keeps the drop. */
export async function classifyTermMatchWithJev(
  context: JevTermMatchContext,
  config: { apiKey: string; model?: string | null },
  fetcher: typeof fetch = fetch,
): Promise<JevTermMatchJudgment> {
  const answers = await postDecisions({
    model: resolveJevModel(config.model),
    session_id: JEV_TERM_MATCH_SESSION_ID,
    state: {
      query: context.query,
      includedTerms: context.includedTerms || null,
      excludedTerms: context.excludedTerms || null,
      listing: {
        title: context.title,
        condition: context.condition ?? null,
      },
    },
    questions: {
      termMatch: {
        type: 'choice',
        instructions: 'Given `query`, `includedTerms`, `excludedTerms`, and `listing.title`, does the listing title denote the sought item honoring the include/exclude intent? Accept inflections, synonyms, abbreviations, and word-order variants (e.g. Polish declensions, `PS5` vs `Playstation 5`). Reject only when the title is a different item or clearly hits an excluded meaning.',
        criteria: {
          pass: 'The title denotes the sought item and honors include/exclude intent despite wording differences.',
          reject: 'The title is a different item, an accessory/part, or clearly matches an excluded meaning.',
          unknown: 'Title too short, ambiguous, or not enough evidence to decide. Do not guess from price or general product knowledge.',
        },
      },
    },
  }, config.apiKey, 'listing term match', fetcher);

  const parsed = choiceAnswerSchema.safeParse(answers.termMatch);
  if (!parsed.success) throw new JevError('OpenRouter Decisions returned listing term match with an invalid shape', 502, 'format');
  const decision = parsed.data.choice === 'pass' || parsed.data.choice === 'reject' ? parsed.data.choice : 'unknown';
  const confidence = typeof parsed.data.confidence === 'number' && Number.isFinite(parsed.data.confidence)
    ? parsed.data.confidence
    : null;
  return { decision, confidence, unsure: isFuzzyMatchUnsure(decision, confidence) };
}

/** P2: negotiability judgment over already-fetched description text. Only upgrades unknown; never overrides explicit fixed. */
export async function classifyNegotiabilityWithJev(
  context: JevNegotiabilityContext,
  config: { apiKey: string; model?: string | null },
  fetcher: typeof fetch = fetch,
): Promise<JevNegotiabilityJudgment> {
  const answers = await postDecisions({
    model: resolveJevModel(config.model),
    session_id: JEV_NEGOTIABILITY_SESSION_ID,
    state: {
      listing: {
        marketplace: context.marketplace,
        title: context.title,
        condition: context.condition ?? null,
        description: context.description,
      },
    },
    questions: {
      negotiability: {
        type: 'choice',
        instructions: 'Given `listing.title` and `listing.description`, does the seller invite price negotiation or an offer? Accept explicit and clearly implied invitations in any language (e.g. `do negocjacji`, `cena do uzgodnienia`, `mozna sie dogadac`, `negotiable`, `open to offers`). Fixed means an explicit firm-price or no-negotiation statement.',
        criteria: {
          negotiable: 'Explicit or clearly implied invitation to negotiate, make an offer, or agree on price.',
          fixed: 'Explicit fixed, firm, non-negotiable price, or refusal to negotiate.',
          unknown: 'No negotiation signal either way, ambiguous, or not enough evidence. Do not infer from a low price or title alone.',
        },
      },
    },
  }, config.apiKey, 'listing negotiability', fetcher);

  const parsed = choiceAnswerSchema.safeParse(answers.negotiability);
  if (!parsed.success) throw new JevError('OpenRouter Decisions returned listing negotiability with an invalid shape', 502, 'format');
  const decision = parsed.data.choice === 'negotiable' || parsed.data.choice === 'fixed' ? parsed.data.choice : 'unknown';
  const confidence = typeof parsed.data.confidence === 'number' && Number.isFinite(parsed.data.confidence)
    ? parsed.data.confidence
    : null;
  return { decision, confidence, unsure: isNegotiabilityUnsure(decision, confidence) };
}

/** P3: condition-filter judgment for Polish marketplace labels. Only a confident match rescues a deterministic miss. */
export async function classifyConditionMatchWithJev(
  context: JevConditionMatchContext,
  config: { apiKey: string; model?: string | null },
  fetcher: typeof fetch = fetch,
): Promise<JevConditionMatchJudgment> {
  const answers = await postDecisions({
    model: resolveJevModel(config.model),
    session_id: JEV_CONDITION_SESSION_ID,
    state: {
      requestedCondition: context.requestedCondition,
      listing: {
        condition: context.listingCondition ?? null,
        title: context.title,
      },
    },
    questions: {
      conditionMatch: {
        type: 'choice',
        instructions: 'Given `requestedCondition` and `listing.condition` (with `listing.title` as fallback), does the listing satisfy the requested condition? `new` means factory-new only (`Nowe`, `new`); `used` means any stated non-new condition. Accept Polish labels and synonyms (`Jak nowy`, `Idealny`, `Bardzo dobry`, `Uzywane`). Missing condition cannot satisfy a specific request.',
        criteria: {
          match: 'The listing condition clearly satisfies the requested condition.',
          mismatch: 'The listing condition clearly does not satisfy the requested condition.',
          unknown: 'Condition missing, ambiguous, or not enough evidence. Do not guess from price or title alone.',
        },
      },
    },
  }, config.apiKey, 'listing condition match', fetcher);

  const parsed = choiceAnswerSchema.safeParse(answers.conditionMatch);
  if (!parsed.success) throw new JevError('OpenRouter Decisions returned listing condition match with an invalid shape', 502, 'format');
  const decision = parsed.data.choice === 'match' || parsed.data.choice === 'mismatch' ? parsed.data.choice : 'unknown';
  const confidence = typeof parsed.data.confidence === 'number' && Number.isFinite(parsed.data.confidence)
    ? parsed.data.confidence
    : null;
  return { decision, confidence, unsure: isFuzzyMatchUnsure(decision, confidence) };
}
