import { z } from 'zod';
import type { WatchGroup } from '../src/types';
import { normalizeFilterText } from './text';

export const MAX_WATCH_GROUPS = 20;

/** Request shape for a watch's groups, shared by the HTTP API and the MCP tools. */
export const watchGroupsInputSchema = z.array(z.object({
  key: z.string().trim().max(60).optional(),
  name: z.string().trim().min(1).max(80),
  terms: z.string().trim().min(1).max(240),
  excluded: z.string().max(240).optional().default(''),
})).max(MAX_WATCH_GROUPS);

export type WatchGroupInput = z.input<typeof watchGroupsInputSchema>[number];

/** Comma-separated terms, each a list of `|`-separated normalized alternatives. */
function compileTerms(raw: string): string[][] {
  return raw.split(',')
    .map((term) => term.split('|').map(normalizeFilterText).filter(Boolean))
    .filter((alternatives) => alternatives.length > 0);
}

/** Words of the longest alternative present in the padded title, or 0 when none matches. */
function matchedWords(paddedTitle: string, alternatives: string[]) {
  let best = 0;
  for (const alternative of alternatives) {
    if (paddedTitle.includes(` ${alternative} `)) best = Math.max(best, alternative.split(' ').length);
  }
  return best;
}

/**
 * Assign a listing title to the most specific matching group. A group matches
 * when every term appears as whole words and no excluded term does;
 * specificity is the number of matched words, so `13 pro max` beats `13 pro`
 * beats `13` without the base group having to exclude the others. Equal
 * specificity across groups is ambiguous and yields null, as does no match.
 */
export function assignWatchGroup(title: string, groups: WatchGroup[]): string | null {
  if (!groups.length) return null;
  const padded = ` ${normalizeFilterText(title)} `;
  let best: { key: string; specificity: number } | null = null;
  let tied = false;
  for (const group of groups) {
    const terms = compileTerms(group.terms);
    if (!terms.length) continue;
    let specificity = 0;
    for (const alternatives of terms) {
      const words = matchedWords(padded, alternatives);
      if (!words) { specificity = 0; break; }
      specificity += words;
    }
    if (!specificity) continue;
    if (compileTerms(group.excluded).some((alternatives) => matchedWords(padded, alternatives) > 0)) continue;
    if (!best || specificity > best.specificity) {
      best = { key: group.key, specificity };
      tied = false;
    } else if (specificity === best.specificity) {
      tied = true;
    }
  }
  return best && !tied ? best.key : null;
}

function slugKey(name: string) {
  return normalizeFilterText(name).replace(/ /g, '-').slice(0, 48) || 'group';
}

/**
 * Validate and normalize user-supplied groups. Supplied keys are kept so
 * assignments survive renames; missing keys are derived from the name and
 * de-duplicated. Throws on duplicate names or groups without usable terms.
 */
export function normalizeWatchGroups(input: WatchGroupInput[]): WatchGroup[] {
  if (input.length > MAX_WATCH_GROUPS) throw new Error(`A watch can have at most ${MAX_WATCH_GROUPS} groups`);
  const names = new Set<string>();
  const keys = new Set<string>();
  const groups: WatchGroup[] = [];
  for (const raw of input) {
    const name = raw.name.trim();
    const terms = raw.terms.trim();
    const excluded = (raw.excluded ?? '').trim();
    if (!name) throw new Error('Every group needs a name');
    const normalizedName = normalizeFilterText(name);
    if (names.has(normalizedName)) throw new Error(`Duplicate group name: ${name}`);
    names.add(normalizedName);
    if (!compileTerms(terms).length) throw new Error(`Group ${name} needs at least one term`);
    const requested = raw.key?.trim();
    let key = requested && !keys.has(requested) ? requested : slugKey(name);
    for (let suffix = 2; keys.has(key); suffix += 1) key = `${slugKey(name)}-${suffix}`;
    keys.add(key);
    groups.push({ key, name, terms, excluded });
  }
  return groups;
}

/** Read stored groups, tolerating malformed JSON as "no groups". */
export function parseWatchGroups(value: string | null | undefined): WatchGroup[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((group): group is WatchGroup => Boolean(group) && typeof group.key === 'string' && typeof group.name === 'string' && typeof group.terms === 'string')
      .map((group) => ({ key: group.key, name: group.name, terms: group.terms, excluded: typeof group.excluded === 'string' ? group.excluded : '' }));
  } catch {
    return [];
  }
}
