/**
 * Cross-source duplicate detection: heuristics for the same physical item
 * cross-posted on OLX / Allegro Lokalnie / Vinted. Purely deterministic —
 * the service layer only materializes pairs whose similarity clears the
 * threshold.
 */

import { imageIdentityKey } from './marketplaces';

/** Pairs at or above this similarity are considered the same physical item. */
export const DUPLICATE_SIMILARITY = 0.75;
/** Only listings observed within this window participate in matching. */
export const DUPLICATE_WINDOW_DAYS = 14;
/** Price ratio below this floor is a hard cut (prices differ beyond ±25%). */
export const PRICE_RATIO_FLOOR = 0.75;

/** Polish marketplace boilerplate that carries no product identity. */
const TITLE_STOPWORDS = new Set([
  'sprzedam', 'okazja', 'nowe', 'nowy', 'nowa', 'uzywany', 'uzywana', 'uzywane',
  'tanio', 'tania', 'tani', 'promocja', 'cena', 'negocjacji', 'wysylka',
  'odbior', 'osobisty', 'gratis', 'stan', 'idealny', 'idealna', 'bardzo',
  'dobry', 'dobra', 'super', 'extra', 'zł', 'pln',
]);

export interface DuplicateCandidate {
  title: string;
  price: number;
  condition?: string | null;
  imageUrl?: string | null;
}

export function normalizeTitleForMatch(title: string): string[] {
  return title
    .toLowerCase()
    // 'ł' has no canonical decomposition, so map it before NFD stripping.
    .replace(/ł/g, 'l')
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .filter((token) => !TITLE_STOPWORDS.has(token));
}

function jaccard(left: string[], right: string[]): number {
  if (!left.length || !right.length) return 0;
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  let intersection = 0;
  for (const token of leftSet) if (rightSet.has(token)) intersection += 1;
  const union = leftSet.size + rightSet.size - intersection;
  return intersection / union;
}

function priceScore(leftPrice: number, rightPrice: number): number {
  if (!Number.isFinite(leftPrice) || !Number.isFinite(rightPrice) || leftPrice <= 0 || rightPrice <= 0) return 0;
  const ratio = Math.min(leftPrice, rightPrice) / Math.max(leftPrice, rightPrice);
  // Hard cut beyond ±25%: same-item cross-posts are almost never repriced wider.
  if (ratio < PRICE_RATIO_FLOOR) return 0;
  return ratio;
}

function conditionScore(left: string | null | undefined, right: string | null | undefined): number {
  if (left && right) return left.toLowerCase() === right.toLowerCase() ? 1 : 0.3;
  // One side unknown: neutral, no reward and no punishment.
  return 0.6;
}

/**
 * Weighted similarity in 0..1: title token Jaccard dominates, price ratio and
 * condition equality support it, and a matching image CDN identity (resize and
 * signature agnostic) adds a strong boost. Image identity is a boost, not a
 * requirement — different marketplaces host photos on different CDNs.
 */
export function duplicateSimilarity(left: DuplicateCandidate, right: DuplicateCandidate): number {
  const title = jaccard(normalizeTitleForMatch(left.title), normalizeTitleForMatch(right.title));
  const price = priceScore(left.price, right.price);
  if (price === 0) return 0;
  const condition = conditionScore(left.condition, right.condition);
  let score = 0.55 * title + 0.35 * price + 0.1 * condition;
  const leftImage = left.imageUrl ? imageIdentityKey(left.imageUrl) : '';
  const rightImage = right.imageUrl ? imageIdentityKey(right.imageUrl) : '';
  if (leftImage && rightImage && leftImage === rightImage && title > 0.25) {
    score = Math.min(1, score + 0.2);
  }
  return Math.min(1, score);
}
