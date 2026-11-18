/**
 * Deterministic decisions that stand in for an AI call where the title
 * alone settles the answer. Each rule is narrow by design: it decides only
 * the cases measured to agree with the AI on the owner's data, and
 * everything else still goes to the model.
 */
import { listingFlags } from './flags';
import { normalizeFilterText, parseIncludedExcluded, termMatches } from './text';
import { OTHER_VARIANT_KEY, assignVariant, variantLabelFor, type VariantGroup } from './variants';

/**
 * `listing_relevance.model` for rows the plain-variant rule decided. It is
 * never the live AI model, so AI cache reads skip these rows and a rule
 * change (bump the suffix) can never be mistaken for an AI verdict.
 */
export const PLAIN_VARIANT_RULE_MODEL = 'scout-rule:plain-variant-v1';

/** A size, memory or rating token: "128gb", "6gb", "gddr6", "85pct", "9" of "9/10". */
const SPEC_TOKEN = /^(?:\d+(?:gb|tb|mb|g|mhz|ghz|hz|w|mah|bit|pct)|gddr\d+x?|ddr\d|pcie?\d*|\d|10)$/;

/**
 * Words that say nothing about which product it is: category nouns,
 * manufacturers and board brands, GPU board lines, colours, and condition
 * or sale words. Anything outside this list (another model, "pro", "max",
 * "super", "ti", "pudełko", "gratisy", "bateria") sends the title to the AI.
 */
const PLAIN_WORDS = new Set([
  'karta', 'graficzna', 'graficzne', 'grafikkort', 'procesor', 'telefon', 'smartfon', 'smartphone',
  'apple', 'nvidia', 'geforce', 'amd', 'radeon', 'intel', 'core',
  'msi', 'gigabyte', 'asus', 'palit', 'zotac', 'gainward', 'evga', 'inno3d', 'pny', 'kfa2', 'galax', 'sapphire', 'powercolor', 'xfx', 'asrock',
  'gaming', 'oc', 'ventus', 'tuf', 'rog', 'strix', 'dual', 'eagle', 'windforce', 'aorus', 'phoenix', 'ghost', 'twin', 'armor', 'pulse', 'nitro', 'mech', 'amp',
  'black', 'white', 'blue', 'green', 'red', 'gold', 'silver', 'graphite', 'pacific', 'purple', 'yellow', 'pink', 'gray', 'grey', 'midnight', 'starlight',
  'stan', 'stanie', 'bardzo', 'dobry', 'dobrym', 'dobra', 'dobre', 'bdb', 'idealny', 'idealnym', 'idealna', 'idealne',
  'uzywany', 'uzywana', 'uzywane', 'nowy', 'nowa', 'nowe', 'sprawny', 'sprawna', 'sprawne', 'w', 'pelni', 'z', 'i',
  'okazja', 'sprzedam', 'zadbany', 'zadbana',
]);
/** Polish colour stems, which inflect ("czarny", "czarna", "białe"). */
const PLAIN_PREFIXES = ['czarn', 'bial', 'niebiesk', 'granatow', 'zielon', 'czerwon', 'zlot', 'srebrn', 'grafit', 'fiolet', 'zolt', 'rozow', 'szar'];

const isPlainWord = (token: string) => PLAIN_WORDS.has(token) || PLAIN_PREFIXES.some((prefix) => token.startsWith(prefix));

/**
 * Title tokens for the plain check: "ł" kept as "l" (normalizeFilterText
 * would split "biały" into "bia y"), a percentage glued to "pct", and a
 * number glued to its unit ("128 GB" -> "128gb").
 */
function plainTokens(title: string) {
  const prepared = title.replace(/ł/g, 'l').replace(/Ł/g, 'L')
    .replace(/(\d)\s*%/g, '$1pct')
    .replace(/(\d)\s+(gb|tb|mb|mhz|ghz|hz|w|mah)\b/gi, '$1$2');
  return normalizeFilterText(prepared).split(' ').filter(Boolean);
}

export interface PlainVariantInput {
  title: string;
  condition?: string | null;
  query: string;
  includedTerms: string;
  excludedTerms: string;
  groups: VariantGroup[];
}

/**
 * The title plainly names one of the watch's variants: every include term
 * is there and no exclude term, the title's own wording picks a named
 * variant (not Other), no quick flag fires (parts, wanted ad, accessory,
 * damage, lock, replica, swap), and every other word is a spec, brand,
 * colour or condition word. "iPhone 12 Pro Max 128GB stan 9/10 Graphite"
 * is plain; "iPhone 12 Pro Max + gratisy" and "RTX 3060 12GB" on a
 * 2060 watch are not. Returns the variant or null (ask the AI).
 */
export function plainVariantMatch(input: PlainVariantInput): { variant: string; label: string } | null {
  if (!input.groups.length) return null;
  const text = normalizeFilterText(input.title);
  const glued = text.replace(/ /g, '');
  const { included, excluded } = parseIncludedExcluded(input.query, input.includedTerms, input.excludedTerms);
  if (!included.length || !included.every((term) => termMatches(text, glued, term))) return null;
  if (excluded.some((term) => termMatches(text, glued, term))) return null;
  const variant = assignVariant(input.title, input.groups);
  if (variant === OTHER_VARIANT_KEY) return null;
  if (listingFlags({ title: input.title, condition: input.condition, query: input.query }).length) return null;
  const group = input.groups.find((candidate) => candidate.id === variant);
  const known = new Set(normalizeFilterText(`${input.query} ${included.join(' ')} ${group?.terms ?? ''}`).split(' '));
  const plain = plainTokens(input.title).every((token) => known.has(token) || SPEC_TOKEN.test(token) || isPlainWord(token));
  return plain ? { variant, label: variantLabelFor(variant, input.groups) } : null;
}

/**
 * A term-match near-miss whose title carries none of the query's
 * number-bearing terms in any spaced or glued form ("GTX 1660 Super" for
 * "rtx 2060", "Laptop Lenovo" for "rtx 3050") cannot be the searched
 * model, so it is rejected without a Jev call. Queries with no number
 * ("iphone pro") are never decided here.
 */
export function lacksQueryModelNumber(title: string, query: string, includedTerms: string, excludedTerms: string) {
  const { included } = parseIncludedExcluded(query, includedTerms, excludedTerms);
  const numeric = included.filter((term) => /\d/.test(term));
  if (!numeric.length) return false;
  const text = normalizeFilterText(title);
  const glued = text.replace(/ /g, '');
  return numeric.every((term) => !termMatches(text, glued, term));
}
