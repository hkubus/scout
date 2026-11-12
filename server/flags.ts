import type { ListingFlag, ListingFlagName, ListingFlagSource } from '../src/types';

/**
 * Quick flags: deterministic junk signals on a listing's own words, with
 * stable names agents and filters can rely on. Flags never drop a listing by
 * themselves; callers opt in with `excludeFlags`.
 *
 * - `for_parts`: broken, for parts or repair, not working (title or description).
 * - `damaged`: the marketplace condition label says damaged (OLX Uszkodzone,
 *   Allegro Lokalnie Uszkodzony).
 * - `locked`: iCloud/activation, FRP/Google account or MDM lock. A carrier
 *   lock is not flagged.
 * - `wanted_ad`: a buying ad (kupię, szukam, skup, WTB) in the title.
 * - `swap`: a swap offer, unless the swap is optional next to a sale.
 * - `replica`: a replica, fake or 1:1 copy.
 * - `accessory`: the title leads with an accessory (or names the product only
 *   as "do <product>") the query did not ask for. It depends on the query, so
 *   it is computed at read time and never stored.
 */
export const LISTING_FLAGS = ['for_parts', 'wanted_ad', 'swap', 'replica', 'accessory', 'damaged', 'locked'] as const;
/** The query-independent flags Scout stores on each listing; the feed can filter on these. */
export const STORED_LISTING_FLAGS = ['for_parts', 'wanted_ad', 'swap', 'replica', 'damaged', 'locked'] as const;
export type StoredListingFlagName = typeof STORED_LISTING_FLAGS[number];

/** Bump when a rule changes; stored rows with another version are recomputed in the background. */
export const FLAGS_VERSION = 1;

/** Descriptions are matched on their first 2000 characters. */
export const FLAG_DESCRIPTION_CHARS = 2_000;

const FLAG_ORDER = new Map<ListingFlagName, number>(LISTING_FLAGS.map((flag, index) => [flag, index]));
const SOURCE_ORDER: Record<ListingFlagSource, number> = { title: 0, condition: 1, description: 2 };

/**
 * Lowercase, `ł` → `l`, accents stripped, letters split from digits, and
 * anything else collapsed to single spaces. Unlike normalizeFilterText it
 * keeps `ł` readable (`działa` → `dziala`, not `dzia a`).
 */
export function normalizeFlagText(value: string) {
  return tokens(value).filter((token) => !isBoundary(token)).join(' ');
}

/**
 * Flag tokens. Punctuation becomes boundary tokens so phrases and negations
 * do not run across it: `.` ends a sentence, `,` separates list items, and
 * `:` (also a spaced dash) separates a label from its value, so
 * "uszkodzeń: brak" reads as label and value.
 */
function tokens(value: string) {
  return value.toLowerCase().replace(/ł/g, 'l').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/([a-z])(?=\d)/g, '$1 ').replace(/(\d)(?=[a-z])/g, '$1 ')
    .replace(/\s[-–—]+\s|[:=]/g, ' : ')
    .replace(/[.;!?\n\r]+/g, ' . ')
    .replace(/[,()[\]{}|]+/g, ' , ')
    .replace(/[^a-z0-9:.,]+/g, ' ')
    .trim().split(' ').filter(Boolean);
}

const isBoundary = (token: string | undefined) => token === '.' || token === ',' || token === ':';

/** `a|b*`: one of the alternatives, `*` a prefix. */
function termMatches(term: string, token: string) {
  return term.split('|').some((alternative) => alternative.endsWith('*') ? token.startsWith(alternative.slice(0, -1)) : token === alternative);
}

const anyOf = (terms: string) => (token: string | undefined) => token !== undefined && termMatches(terms, token);

type Guard = (words: string[], start: number, end: number) => boolean;

const isNegator = anyOf('bez|nie|brak|zero|0|nigdy|zadn*|no|not|never|without|non');
const isGlue = anyOf('jest|sa|byl|byla|bylo|byly|zostal*|ma|mial|miala|is|was|are|were|been|be|has|have|had|ever');
const isConjunction = anyOf('i|ani|oraz|ni|and|or|nor');
const isConditional = anyOf('jesli|jezeli|gdyby|gdy|czy|if|when|whether');
const isLabelDenial = anyOf('brak|nie|none|no|0|zero|nic|zadn*');
const isNotTheDevice = anyOf('pudelk*|opakowan*|karton*|box|etui|folia|folie|folii|plomb*|naklejk*|seal|packaging');
const isSoftener = anyOf('lekko|minimalnie|delikatnie|troche|nieznacznie|kosmetycznie|slightly');

/**
 * A negator just before the match, past up to two glue words ("bez", "nie
 * jest", "nigdy nie był"), or one governing a list the match ends ("bez
 * simlocka i blokady", "żadna podróbka ani replika").
 */
const negatedBefore: Guard = (words, start) => {
  let index = start - 1;
  for (let glue = 0; glue < 2 && isGlue(words[index]); glue += 1) index -= 1;
  if (isNegator(words[index])) return true;
  if (!isConjunction(words[index])) return false;
  for (let back = index - 1; back >= Math.max(0, index - 4); back -= 1) {
    if (words[back] === '.' || words[back] === ':') return false;
    if (isNegator(words[back])) return true;
  }
  return false;
};

/**
 * A negator anywhere earlier in the sentence, up to `reach` words back:
 * lock words are mostly listed as absent ("Brak blokad: iCloud, FRP"), so
 * they need the wider scope.
 */
const negatedInSentence = (reach: number): Guard => (words, start) => {
  let seen = 0;
  for (let index = start - 1; index >= 0 && seen < reach; index -= 1) {
    if (words[index] === '.') return false;
    if (isBoundary(words[index])) continue;
    if (isNegator(words[index])) return true;
    seen += 1;
  }
  return false;
};

/** "jeśli coś nie działa": a condition within three words before. */
const conditionalBefore: Guard = (words, start) => {
  for (let index = start - 1; index >= Math.max(0, start - 3); index -= 1) {
    if (words[index] === '.' || words[index] === ':') return false;
    if (isConditional(words[index])) return true;
  }
  return false;
};

/** "uszkodzony: nie", "blokada iCloud: brak". */
const labelDenied: Guard = (words, _start, end) => words[end] === ':' && isLabelDenial(words[end + 1]);

/** The damage or copy is the box, case or seal, not the item: "uszkodzone pudełko", "pudełko lekko uszkodzone". */
const notTheDevice: Guard = (words, start, end) => isNotTheDevice(words[end]) || isNotTheDevice(words[start - 1])
  || (isSoftener(words[start - 1]) && isNotTheDevice(words[start - 2]));

/** "lekko uszkodzony": cosmetic, not for parts. */
const softened: Guard = (words, start) => isSoftener(words[start - 1]);

/** The word just before the match is one of `terms`. */
const after = (terms: string): Guard => {
  const matches = anyOf(terms);
  return (words, start) => matches(words[start - 1]);
};

/** The next word (past a colon and one glue word) denies the match: "blokada iCloud zdjęta", "zamiany mnie nie interesują". */
const deniedAfter = (terms: string): Guard => {
  const matches = anyOf(terms);
  return (words, _start, end) => {
    let index = end;
    if (words[index] === ':') index += 1;
    if (isGlue(words[index]) || words[index] === 'mnie') index += 1;
    return matches(words[index]);
  };
};

interface Rule {
  flag: Exclude<StoredListingFlagName, 'damaged'>;
  phrase: string[];
  fields: ReadonlyArray<'title' | 'description'>;
  guards: Guard[];
}

const TEXT = ['title', 'description'] as const;
const TITLE = ['title'] as const;
const DESCRIPTION = ['description'] as const;
const STANDARD = [negatedBefore, labelDenied];
/** Phrases that already start with "nie" can only be cancelled by a condition. */
const NIE_PHRASE = [conditionalBefore, labelDenied];
const LOCKED = [negatedInSentence(6), labelDenied, deniedAfter('zdjet*|usunie*|wylaczon*|wylogowan*|odblokowan*|nieaktywn*|removed|off|disabled|unlocked')];
const SWAP_DENIED = deniedAfter('nie|mozliw*|ewentualnie|tez|rowniez|possible|optional');
const SWAP_OPTIONAL: Guard = (words, start) => {
  const optional = anyOf('lub|albo|ewentualnie|ew|ewent|mozliw*|rozwaz*|tez|rowniez|or|opcjonalnie|optional|possible|chetnie');
  return optional(words[start - 1]) || optional(words[start - 2]);
};
/** A swap word in a title that also sells is an optional swap ("Sprzedam/zamienię"). */
const SELLS: Guard = (words) => words.some(anyOf('sprzedam|sprzedaz|sprzedaje|sprzedajemy|sprzedawany|sprzedawana|sell|selling|sale|fs'));

const RULES: Rule[] = [
  // for_parts
  ...[
    ['dawca|dawce'], ['zlom|zlomu'], ['bootloop'], ['boot', 'loop'], ['niesprawn*'], ['niedzialajac*'],
    ['for', 'parts'], ['parts', 'only'], ['spares', 'or', 'repair'], ['not', 'work*'], ['doesn', 't', 'work*'], ['faulty'],
    ['zbit*|pekniet*|spalon*|uszkodzon*', 'plyt*', 'glown*'],
  ].map((phrase): Rule => ({ flag: 'for_parts', phrase, fields: TEXT, guards: STANDARD })),
  // "gwarancja na części" is a warranty on parts.
  { flag: 'for_parts', phrase: ['na', 'czesci'], fields: TEXT, guards: [...STANDARD, after('gwarancj*|rabat*|znizk*')] },
  { flag: 'for_parts', phrase: ['uszkodzon*'], fields: TEXT, guards: [...STANDARD, notTheDevice, softened] },
  { flag: 'for_parts', phrase: ['broken'], fields: TEXT, guards: [...STANDARD, notTheDevice] },
  // "nie do naprawy" is for parts too; "nic do naprawy" and "zestaw do naprawy" are not.
  { flag: 'for_parts', phrase: ['do', 'naprawy'], fields: TEXT, guards: [after('nic|zestaw*|narzedzi*|kit'), labelDenied] },
  ...[
    ['nie', 'dziala*'], ['nie', 'wlacza*'], ['nie', 'uruchamia', 'sie'], ['nie', 'odpala'], ['nie', 'w', 'pelni', 'sprawn*'],
  ].map((phrase): Rule => ({ flag: 'for_parts', phrase, fields: TEXT, guards: NIE_PHRASE })),
  // locked: an iCloud/activation, Google account (FRP) or MDM lock; a carrier lock is not one
  ...[
    ['blokad*', 'icloud'], ['blokad*', 'aktywacji'], ['zablokowan*', 'icloud'], ['zablokowan*', 'na', 'icloud'], ['icloud', 'zablokowan*'],
    ['icloud', ':', 'zablokowan*|tak|yes|locked|aktywn*'], ['icloud', 'lock*'], ['locked', 'icloud'], ['activation', 'lock*'],
    ['blokad*|zablokowan*', 'kont*', 'google'], ['blokad*|zablokowan*', 'na', 'kont*', 'google'], ['blokad*', 'google'], ['google', 'lock*'],
    ['frp'], ['mdm'],
  ].map((phrase): Rule => ({ flag: 'locked', phrase, fields: TEXT, guards: LOCKED })),
  // wanted_ad: the title only
  ...[
    ['kupie|kupimy|kupuje|kupujemy|skupuje|skupujemy|skup|poszukuje|wtb'], ['want', 'to', 'buy'],
  ].map((phrase): Rule => ({ flag: 'wanted_ad', phrase, fields: TITLE, guards: [negatedBefore] })),
  { flag: 'wanted_ad', phrase: ['szukam'], fields: TITLE, guards: [negatedBefore, deniedAfter('nowego|nowej|nowych|kupca|kupcow|chetnego|chetnych|nabywcy|domu|wlasciciela')] },
  // swap: a swap word in the title, or a swap-only line in the description
  { flag: 'swap', phrase: ['zamienie|zamiana|zamiany|zamienimy|zamieni|swap'], fields: TITLE, guards: [...STANDARD, SWAP_DENIED, SWAP_OPTIONAL, SELLS, after('hot')] },
  // "Wymienię iPhone 12 na Samsunga"; a bare "wymienię" can be a repair ("wymienię ekran").
  { flag: 'swap', phrase: ['wymienie|wymienimy'], fields: TITLE, guards: [...STANDARD, SWAP_OPTIONAL, SELLS, (words, _start, end) => !words.slice(end, end + 4).includes('na')] },
  ...[
    ['tylko|wylacznie|jedynie', 'zamian*'], ['tylko|wylacznie|jedynie', 'na', 'zamian*'], ['swap', 'only'], ['only', 'swap'],
  ].map((phrase): Rule => ({ flag: 'swap', phrase, fields: DESCRIPTION, guards: [negatedBefore] })),
  // replica
  ...[
    ['replik*|replica|podrobk*|fake|falsyfikat'], ['1', ':', '1'],
  ].map((phrase): Rule => ({ flag: 'replica', phrase, fields: TEXT, guards: STANDARD })),
  { flag: 'replica', phrase: ['kopia|kopie'], fields: TEXT, guards: [...STANDARD, deniedAfter('faktury|paragonu|dowodu|zapasow*|gwarancji|rachunku|umowy|dokument*|zakupu')] },
  {
    flag: 'replica', phrase: ['nie', 'oryginal*|oryginaln*'], fields: TEXT,
    guards: [conditionalBefore, (words, _start, end) => anyOf('pudelk*|opakowan*|karton*|box|etui|ladowark*|kabel|kabl*|bateri*|ekran*|wyswietlacz*|szybk*|czesci|zasilacz*|pasek|paski|folia|szklo|obudow*|sluchawki|plomb*')(words[end])],
  },
];

/** Every start index of `phrase` in `words`. */
function* occurrences(words: string[], phrase: string[]) {
  for (let start = 0; start + phrase.length <= words.length; start += 1) {
    if (phrase.every((term, offset) => termMatches(term, words[start + offset]))) yield start;
  }
}

/** The rule's first unguarded occurrence: where it starts and the normalized text. */
function firstMatch(words: string[], rule: Rule) {
  for (const start of occurrences(words, rule.phrase)) {
    const end = start + rule.phrase.length;
    if (!rule.guards.some((guard) => guard(words, start, end))) return { start, text: words.slice(start, end).join(' ').replace(/ : /g, ':') };
  }
  return null;
}

/** The marketplace condition label says damaged: OLX Uszkodzone, Allegro Lokalnie Uszkodzony, JSON-LD DamagedCondition. */
function damagedCondition(words: string[]) {
  const label = words.find(anyOf('uszkodzon*|damaged|damagedcondition'));
  return label && !negatedBefore(words, words.indexOf(label), words.indexOf(label) + 1) ? label : null;
}

const ACCESSORY_GROUPS = [
  'etui', 'case', 'futeral*', 'pokrowi*|pokrowc*', 'szklo|szkla|szkielko|szkielka', 'folia|folie|folii', 'ladowark*', 'kabel|kabl*',
  'zasilacz*', 'pudelk*|box|karton|kartonik', 'opakowanie|opakowania', 'obudow*', 'bateri*', 'pasek|paski|paska', 'uchwyt*', 'rysik*|stylus',
  'cover', 'charger*', 'cable|cables', 'strap|straps', 'holder', 'adapter*',
];
/** Leading words skipped before the accessory noun: "2x", "Oryginalne", "Nowe". */
const isLeadingFiller = anyOf('x|szt|oryginal*|original*|nowe|nowy|nowa|new|silikon*|skorzan*|magnetyczn*|pancern*|ochronn*|premium');
const isFor = anyOf('do|for|pod|dla');
const isQueryStopword = anyOf('do|na|w|we|z|ze|i|oraz|dla|od|po|za|o|a|u|the|for|with|and|to|of|in|on');

/** An accessory the query did not ask for: the title leads with one, or names the product only after "do". */
function accessory(titleWords: string[], query: string) {
  const queryWords = tokens(query).filter((word) => !isBoundary(word));
  if (!queryWords.length) return null;
  const queryGroups = new Set(ACCESSORY_GROUPS.filter((group) => queryWords.some((word) => termMatches(group, word))));
  let index = 0;
  while (index < 3 && index < titleWords.length && (isLeadingFiller(titleWords[index]) || isBoundary(titleWords[index]) || /^\d+$/.test(titleWords[index]))) index += 1;
  const lead = titleWords[index];
  const group = lead === undefined ? undefined : ACCESSORY_GROUPS.find((candidate) => termMatches(candidate, lead));
  if (group && !queryGroups.has(group)) return lead!;
  // "Futerał skórzany do iPhone 13": the product only appears as what the item is for.
  if (queryGroups.size) return null;
  const product = queryWords.find((word) => !isQueryStopword(word) && !/^\d+$/.test(word)) ?? queryWords[0];
  const at = titleWords.indexOf(product);
  return at >= 1 && isFor(titleWords[at - 1]) ? `${titleWords[at - 1]} ${product}` : null;
}

/** The accessory flag alone, for rows whose other flags are already stored. */
export function accessoryFlag(title: string, query: string | null | undefined): ListingFlag | null {
  const match = query ? accessory(tokens(title), query) : null;
  return match ? { flag: 'accessory', match, in: 'title' } : null;
}

export interface ListingFlagInput {
  title: string;
  condition?: string | null;
  description?: string | null;
  /** The search or watch query; without it `accessory` is not computed. */
  query?: string | null;
}

/**
 * The listing's flags: at most one per flag, in LISTING_FLAGS order, each
 * from the first field that shows it (title, then condition, then
 * description). Deterministic and free.
 */
export function listingFlags(input: ListingFlagInput): ListingFlag[] {
  const fields: Array<[ListingFlagSource, string[]]> = [
    ['title', tokens(input.title ?? '')],
    ['condition', tokens(input.condition ?? '')],
    ['description', tokens((input.description ?? '').slice(0, FLAG_DESCRIPTION_CHARS))],
  ];
  const found = new Map<ListingFlagName, ListingFlag>();
  const add = (flag: ListingFlagName, match: string, source: ListingFlagSource) => {
    const current = found.get(flag);
    if (!current || SOURCE_ORDER[source] < SOURCE_ORDER[current.in]) found.set(flag, { flag, match, in: source });
  };
  for (const [source, words] of fields) {
    if (!words.length) continue;
    if (source === 'condition') {
      const label = damagedCondition(words);
      if (label) add('damaged', label, 'condition');
      continue;
    }
    // Within a field, each flag reports its earliest match in the text.
    const earliest = new Map<ListingFlagName, { start: number; text: string }>();
    for (const rule of RULES) {
      if (found.has(rule.flag) || !(rule.fields as readonly string[]).includes(source)) continue;
      const match = firstMatch(words, rule);
      const current = earliest.get(rule.flag);
      if (match && (!current || match.start < current.start)) earliest.set(rule.flag, match);
    }
    for (const [flag, match] of earliest) add(flag, match.text, source);
  }
  if (input.query) {
    const match = accessory(fields[0][1], input.query);
    if (match) add('accessory', match, 'title');
  }
  return sortFlags([...found.values()]);
}

export function sortFlags(flags: ListingFlag[]) {
  return flags.sort((a, b) => (FLAG_ORDER.get(a.flag) ?? 99) - (FLAG_ORDER.get(b.flag) ?? 99));
}

/** The stored (query-independent) part of a listing's flags. */
export function storedListingFlags(input: Omit<ListingFlagInput, 'query'>) {
  return listingFlags({ ...input, query: null });
}

/** `flags_json` as written: the stored flags in order, `[]` when there are none. */
export function flagsJson(flags: ListingFlag[]) {
  return JSON.stringify(flags.filter((flag) => flag.flag !== 'accessory').map(({ flag, match, in: source }) => ({ flag, match, in: source })));
}

/** Stored flags from `flags_json`, or null when the column is empty or unreadable. */
export function parseFlagsJson(value: unknown): ListingFlag[] | null {
  if (typeof value !== 'string' || !value) return null;
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((item): item is ListingFlag => Boolean(item) && typeof item === 'object'
      && FLAG_ORDER.has(item.flag) && typeof item.match === 'string' && (item.in === 'title' || item.in === 'condition' || item.in === 'description'));
  } catch {
    return null;
  }
}

/** One entry per flag across several lists, keeping the earliest field (title, condition, description). */
export function mergeFlags(...lists: ListingFlag[][]) {
  const merged = new Map<ListingFlagName, ListingFlag>();
  for (const flag of lists.flat()) {
    const current = merged.get(flag.flag);
    if (!current || SOURCE_ORDER[flag.in] < SOURCE_ORDER[current.in]) merged.set(flag.flag, flag);
  }
  return sortFlags([...merged.values()]);
}
