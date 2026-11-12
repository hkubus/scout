/**
 * Cross-marketplace duplicate detection (docs/market-intelligence-plan.md,
 * Milestone 6): the same physical item cross-posted on OLX, Allegro Lokalnie
 * and Vinted, so the cheapest copy can be shown next to the others.
 *
 * Pure and deterministic; ScoutService.refreshDuplicatePairs() stores the
 * pairs. Each marketplace rehosts photos on its own CDN, so photo URLs never
 * match across marketplaces and matching rests on the title, price,
 * condition and location. A match is a likely copy, not a certainty: two
 * sellers with the same plain title, price and city look the same here.
 */
import { conditionClass, type ConditionClass } from './negotiation';
import { QUERY_STOPWORDS } from './text';

/** Pairs scoring at least this (0–1) are stored as duplicates. */
export const DUPLICATE_SIMILARITY = 0.75;
/** Only listings a scan saw within this many days are compared. */
export const DUPLICATE_WINDOW_DAYS = 14;
/** Copies further apart in price than this share of the cheaper one never match. */
export const DUPLICATE_MAX_PRICE_GAP = 0.25;
/** Titles must share at least this many words; "iPhone 13" alone says too little. */
export const DUPLICATE_MIN_SHARED_TOKENS = 3;
/**
 * A title matching more listings than this on one other marketplace is too
 * plain to tell copies apart (several sellers with "iPhone 13 128GB"), so
 * none of those matches count. Two allows a seller who posted twice.
 */
export const DUPLICATE_MAX_MATCHES_PER_MARKETPLACE = 2;

const TITLE_WEIGHT = 0.7;
const PRICE_WEIGHT = 0.2;
const CONDITION_WEIGHT = 0.1;

/**
 * Words that say nothing about which item it is: sales filler and condition
 * words (condition is compared from the marketplace's own field). Compared
 * after folding, so "używany" is "uzywany".
 */
const LISTING_STOPWORDS = new Set([
  ...QUERY_STOPWORDS,
  'sprzedam', 'sprzedaz', 'sprzedaje', 'okazja', 'okazyjnie', 'tanio', 'tanie', 'tani', 'pilne', 'pilnie',
  'polecam', 'hit', 'mega', 'wyprzedaz', 'promocja', 'cena', 'negocjacji', 'negocjacja', 'zamiana', 'zamienie',
  'nowy', 'nowa', 'nowe', 'nowka', 'uzywany', 'uzywana', 'uzywane', 'stan', 'idealny', 'idealna', 'idealne', 'idealnym',
  'bardzo', 'dobry', 'dobra', 'dobre', 'dobrym', 'igla', 'jak', 'sztuka', 'szt', 'gratis', 'wysylka', 'wysylam',
  'olx', 'vinted', 'allegro', 'lokalnie', 'zl', 'pln',
  'new', 'used', 'sale', 'sell',
]);

/**
 * Words that name a different model of the same line ("iPhone 13" against
 * "iPhone 13 Pro", "GTX 1660" against "GTX 1660 Super"). Titles must agree on
 * every one of them.
 */
const MODEL_MODIFIERS = new Set(['pro', 'max', 'mini', 'plus', 'ultra', 'lite', 'slim', 'air', 'se', 'fe', 'ti', 'super', 'xl']);

/** Units glued to a number inside one word: "65w", "1tb", "4k". */
const GLUED_UNITS = new Set(['gb', 'tb', 'mb', 'mah', 'mm', 'cm', 'ml', 'kg', 'hz', 'mhz', 'ghz', 'mp', 'cal', 'kw', 'w', 'l', 'm', 'g', 'k', 'v']);
/** Units joined to the number before them across a space: "128 GB". Polish "w" and "z" are words, so short units stay out. */
const SPACED_UNITS = new Set(['gb', 'tb', 'mb', 'mah', 'mm', 'cm', 'ml', 'kg', 'hz', 'mhz', 'ghz', 'mp', 'cal', 'kw']);

/**
 * Polish inflection endings, longest first. Titles inflect the same word
 * ("napęd", "z napędem"; "czarny", "czarna"), so words are compared by stem.
 */
const INFLECTION_ENDINGS = ['owego', 'owych', 'owymi', 'owej', 'owym', 'ego', 'emu', 'ych', 'ich', 'ymi', 'imi', 'ach', 'ami', 'owa', 'owe', 'owy', 'em', 'om', 'ej', 'ym', 'im', 'ow', 'a', 'e', 'i', 'o', 'u', 'y'];
/** A stem keeps at least this many letters, so short words are left alone. */
const MIN_STEM = 4;

/** A folded word without its inflection ending; numbers and model words are kept whole. */
function stem(token: string) {
  if (!/^[a-z]+$/.test(token) || MODEL_MODIFIERS.has(token)) return token;
  for (const ending of INFLECTION_ENDINGS) {
    if (token.endsWith(ending) && token.length - ending.length >= MIN_STEM) return token.slice(0, -ending.length);
  }
  return token;
}

/** Region names and the country carry no place information for one item. */
const REGIONS = new Set([
  'dolnoslaskie', 'kujawsko pomorskie', 'lubelskie', 'lubuskie', 'lodzkie', 'malopolskie', 'mazowieckie', 'opolskie',
  'podkarpackie', 'podlaskie', 'pomorskie', 'slaskie', 'swietokrzyskie', 'warminsko mazurskie', 'wielkopolskie',
  'zachodniopomorskie', 'polska', 'poland',
]);

/**
 * Lowercase, strip diacritics (including ł, which has no decomposition) and
 * collapse everything else to single spaces. A "+" ending a word is "plus"
 * first, so "S23+" keeps its model word; "PS5 + pad" is left as it is.
 */
function foldText(value: string) {
  return value.replace(/(?<=[\p{L}\p{N}])\+(?![\p{L}\p{N}])/gu, ' plus').toLowerCase().replace(/ł/g, 'l').normalize('NFKD').replace(/\p{M}/gu, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * A title as the set of words that identify the item: folded, split between
 * letters and digits ("iphone13pro" is "iphone 13 pro"), with capacities kept
 * as one word ("128 GB" and "128gb" are both "128gb"), filler dropped and
 * Polish endings stripped ("napędem" is "naped").
 */
export function normalizeTitleForMatch(title: string): string[] {
  const tokens: string[] = [];
  for (const word of foldText(title).split(' ')) {
    if (!word) continue;
    const runs = word.match(/[a-z]+|[0-9]+/g) ?? [];
    for (let index = 0; index < runs.length; index += 1) {
      const run = runs[index];
      const next = runs[index + 1];
      // A letter after a model number is part of it ("Pixel 7a", "Legion 5i"),
      // not a separate word that may be filler; "120x60" stays three words.
      if (/^\d/.test(run) && next !== undefined && (GLUED_UNITS.has(next) || (next.length === 1 && next !== 'x'))) {
        tokens.push(run + next);
        index += 1;
      } else {
        tokens.push(run);
      }
    }
  }
  const joined: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const next = tokens[index + 1];
    if (/^\d+$/.test(token) && next !== undefined && SPACED_UNITS.has(next)) {
      joined.push(token + next);
      index += 1;
    } else {
      joined.push(token);
    }
  }
  return [...new Set(joined.filter((token) => !LISTING_STOPWORDS.has(token)).map(stem))];
}

/** Named places in a location ("Mazowieckie, Warszawa, Mokotów" is warszawa and mokotow). */
function places(location: string | null | undefined) {
  const found = new Set<string>();
  for (const part of (location ?? '').split(/,|;|\s-\s|\//)) {
    const place = foldText(part);
    if (place && !REGIONS.has(place)) found.add(place);
  }
  return found;
}

export interface DuplicateCandidate {
  id: number;
  marketplace: string;
  title: string;
  price: number;
  condition?: string | null;
  location?: string | null;
}

/** One stored pair, in canonical order (a < b). */
export interface DuplicatePair {
  a: number;
  b: number;
  similarity: number;
}

interface PreparedCandidate {
  id: number;
  marketplace: string;
  price: number;
  tokens: string[];
  tokenSet: Set<string>;
  modifiers: Set<string>;
  condition: ConditionClass | null;
  places: Set<string>;
}

function prepare(candidate: DuplicateCandidate): PreparedCandidate {
  const tokens = normalizeTitleForMatch(candidate.title);
  return {
    id: candidate.id,
    marketplace: candidate.marketplace,
    price: candidate.price,
    tokens,
    tokenSet: new Set(tokens),
    modifiers: new Set(tokens.filter((token) => MODEL_MODIFIERS.has(token))),
    condition: conditionClass(candidate.condition),
    places: places(candidate.location),
  };
}

/** Clothing letter sizes: "M" and "L" are different items, like two capacities. */
const LETTER_SIZES = new Set(['xxs', 'xs', 's', 'm', 'l', 'xl', 'xxl', 'xxxl']);
/** Colours, compared by stem as titles are ("czarny", "czarna"): a black one and a white one are two items. */
const COLOURS = new Set([
  'czarny', 'biały', 'szary', 'srebrny', 'złoty', 'niebieski', 'granatowy', 'czerwony', 'zielony', 'żółty', 'różowy',
  'fioletowy', 'grafitowy', 'beżowy', 'brązowy', 'black', 'white', 'grey', 'gray', 'silver', 'gold', 'blue', 'red',
  'green', 'pink', 'purple', 'midnight', 'starlight', 'graphite', 'beige', 'brown',
].map((word) => stem(foldText(word))));

/**
 * A word that pins down which item it is: a number, a letter size or a
 * colour. Vinted and Allegro rows often carry no location, so the place
 * check can't tell two sizes or colours of one product apart.
 */
const isSpec = (token: string) => /\d/.test(token) || LETTER_SIZES.has(token) || COLOURS.has(token);

function score(x: PreparedCandidate, y: PreparedCandidate) {
  if (x.marketplace === y.marketplace) return 0;
  if (!(x.price > 0) || !(y.price > 0)) return 0;
  const gap = Math.abs(x.price - y.price) / Math.min(x.price, y.price);
  if (gap > DUPLICATE_MAX_PRICE_GAP) return 0;
  // One item has one condition and is in one place; an unknown on either side proves nothing.
  if (x.condition !== null && y.condition !== null && x.condition !== y.condition) return 0;
  if (x.places.size && y.places.size && ![...x.places].some((place) => y.places.has(place))) return 0;
  if (x.modifiers.size !== y.modifiers.size || [...x.modifiers].some((modifier) => !y.modifiers.has(modifier))) return 0;
  let shared = 0;
  let xOnlySpec = false;
  for (const token of x.tokens) {
    if (y.tokenSet.has(token)) shared += 1;
    else if (isSpec(token)) xOnlySpec = true;
  }
  if (shared < DUPLICATE_MIN_SHARED_TOKENS) return 0;
  // A number, size or colour only one side names may just be left out
  // ("iPhone 13" next to "iPhone 13 128GB"); a different one on each side is a
  // different item.
  if (xOnlySpec && y.tokens.some((token) => isSpec(token) && !x.tokenSet.has(token))) return 0;
  const jaccard = shared / (x.tokens.length + y.tokens.length - shared);
  const priceScore = 1 - gap / DUPLICATE_MAX_PRICE_GAP;
  const conditionScore = x.condition !== null && y.condition !== null ? 1 : 0.5;
  // Rounded so float noise cannot move a pair across the threshold.
  return Math.round((TITLE_WEIGHT * jaccard + PRICE_WEIGHT * priceScore + CONDITION_WEIGHT * conditionScore) * 10_000) / 10_000;
}

/**
 * How likely two listings are the same item listed on two marketplaces, 0–1.
 * Zero for the same marketplace, prices more than 25% apart, different
 * conditions or places, a different model word or number, or fewer than
 * three shared title words; otherwise mostly title-word overlap, then price
 * closeness, then whether both conditions are known.
 */
export function duplicateSimilarity(a: DuplicateCandidate, b: DuplicateCandidate) {
  return score(prepare(a), prepare(b));
}

/**
 * Every pair of candidates scoring at least `threshold`, in canonical order.
 * Candidate pairs come from a prefix filter on the title words (rarest
 * first) inside a sliding price window: a pair that can reach the threshold
 * is at most 25% apart in price and has a title overlap of at least
 * (threshold − 0.3) / 0.7, so the two titles must share one of their few
 * rarest words, and only those pairs are scored. Matches from titles too
 * plain to tell apart are then dropped (DUPLICATE_MAX_MATCHES_PER_MARKETPLACE).
 */
export function findDuplicatePairs(candidates: DuplicateCandidate[], threshold = DUPLICATE_SIMILARITY): DuplicatePair[] {
  // Cheapest first, so every listing is scored only against cheaper ones
  // still inside the price gap; older index entries are skipped for good.
  const prepared = candidates.map(prepare)
    .filter((candidate) => candidate.tokens.length >= DUPLICATE_MIN_SHARED_TOKENS && candidate.price > 0)
    .sort((a, b) => a.price - b.price || a.id - b.id);
  const frequency = new Map<string, number>();
  for (const candidate of prepared) for (const token of candidate.tokens) frequency.set(token, (frequency.get(token) ?? 0) + 1);
  const rarestFirst = (a: string, b: string) => (frequency.get(a)! - frequency.get(b)!) || (a < b ? -1 : a > b ? 1 : 0);
  const minOverlap = Math.max(0, (threshold - PRICE_WEIGHT - CONDITION_WEIGHT) / TITLE_WEIGHT);
  // Postings per prefix word, in price order: the listing and the word's
  // place in its rarest-first list, with the first entry still in range.
  const index = new Map<string, { positions: number[]; places: number[]; start: number }>();
  const matches: Array<{ x: PreparedCandidate; y: PreparedCandidate; similarity: number }> = [];
  // Shared prefix words found so far per earlier listing; negative once it can no longer qualify.
  const overlap = new Int32Array(prepared.length);
  const stamp = new Int32Array(prepared.length).fill(-1);
  const overlapShare = minOverlap / (1 + minOverlap);
  prepared.forEach((x, position) => {
    const ordered = [...x.tokens].sort(rarestFirst);
    const size = ordered.length;
    // Rounded down a hair so float error (0.6428…·7) cannot shorten the prefix.
    const prefix = ordered.slice(0, size - Math.ceil(minOverlap * size - 1e-9) + 1);
    // A hair under the bound, so a pair exactly 25% apart is still scored.
    const cheapest = (x.price / (1 + DUPLICATE_MAX_PRICE_GAP)) * (1 - 1e-12);
    const touched: number[] = [];
    prefix.forEach((token, place) => {
      const postings = index.get(token);
      if (!postings) return;
      const { positions, places } = postings;
      while (postings.start < positions.length && prepared[positions[postings.start]].price < cheapest) postings.start += 1;
      for (let cursor = postings.start; cursor < positions.length; cursor += 1) {
        const other = positions[cursor];
        if (stamp[other] !== position) {
          stamp[other] = position;
          overlap[other] = 0;
          touched.push(other);
        }
        if (overlap[other] < 0) continue;
        const y = prepared[other];
        // Both lists share one word order, so the words still to come bound
        // the overlap; drop the pair once it cannot reach what the threshold needs.
        const needed = Math.max(DUPLICATE_MIN_SHARED_TOKENS, Math.ceil(overlapShare * (size + y.tokens.length) - 1e-9));
        if (overlap[other] + 1 + Math.min(size - place - 1, y.tokens.length - places[cursor] - 1) >= needed) overlap[other] += 1;
        else overlap[other] = -1;
      }
    });
    for (const other of touched) {
      if (overlap[other] <= 0) continue;
      const y = prepared[other];
      if (y.marketplace === x.marketplace) continue;
      const similarity = score(x, y);
      if (similarity >= threshold) matches.push({ x, y, similarity });
    }
    prefix.forEach((token, place) => {
      const postings = index.get(token);
      if (postings) {
        postings.positions.push(position);
        postings.places.push(place);
      } else {
        index.set(token, { positions: [position], places: [place], start: 0 });
      }
    });
  });
  const perMarketplace = new Map<string, number>();
  const countKey = (candidate: PreparedCandidate, other: PreparedCandidate) => `${candidate.id}\u0000${other.marketplace}`;
  for (const { x, y } of matches) {
    perMarketplace.set(countKey(x, y), (perMarketplace.get(countKey(x, y)) ?? 0) + 1);
    perMarketplace.set(countKey(y, x), (perMarketplace.get(countKey(y, x)) ?? 0) + 1);
  }
  return matches
    .filter(({ x, y }) => perMarketplace.get(countKey(x, y))! <= DUPLICATE_MAX_MATCHES_PER_MARKETPLACE
      && perMarketplace.get(countKey(y, x))! <= DUPLICATE_MAX_MATCHES_PER_MARKETPLACE)
    .map(({ x, y, similarity }) => (x.id < y.id ? { a: x.id, b: y.id, similarity } : { a: y.id, b: x.id, similarity }))
    .sort((left, right) => left.a - right.a || left.b - right.b);
}
