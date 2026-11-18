/**
 * AI pipeline benchmark: what Scout's Jev, vision and relevance checks cost,
 * how often they repeat themselves, how sure they are, and where a
 * deterministic rule already knows the answer.
 *
 *   node --import tsx scripts/bench/ai.ts <scout-improvement-*.sqlite> [--json=out.json] [--now=ISO] [--examples=8]
 *
 * Offline only: it reads the export and runs the repo's pure functions (input
 * hashes, quick flags, term matching, variant assignment). It never calls a
 * model. Every AI call Scout makes in Jev live mode is one `jev_shadow_log`
 * row (note = 'live'), except manual-search checks, which only leave a
 * `jev_fuzzy_cache` row when they had a description.
 *
 * Sections: volume, relevance, manual cache, fuzzy rescue (term-match,
 * condition, variant, checks), negotiability, description verification,
 * accuracy proxies (user triage, flips, quick flags, title rules).
 */

import { listingRelevanceInputHash, listingTermMatchInputHash, LISTING_DESCRIPTION_MAX_CHARS } from '../../server/ai';
import { listingFlags } from '../../server/flags';
import { lacksQueryModelNumber, plainVariantMatch } from '../../server/aiRules';
import { listingDescriptionText, type Marketplace } from '../../server/marketplaces';
import { isModelToken } from '../../server/queryMatch';
import { normalizeFilterText, parseIncludedExcluded, termMatches } from '../../server/text';
import { OTHER_VARIANT_KEY, assignVariant, parseVariantGroups, type VariantGroup } from '../../server/variants';
import { Bench, all, distribution, one, ratio, scalar, tableExists } from './lib';

const bench = new Bench('ai');
const { db } = bench;
const examples = Number(bench.args.flags.get('examples') ?? 8);
bench.param('examples', examples);

for (const table of ['jev_shadow_log', 'listing_relevance', 'manual_relevance_cache', 'jev_fuzzy_cache', 'listing_detail_snapshots', 'listings', 'watches']) {
  if (!tableExists(db, table)) throw new Error(`export has no ${table} table`);
}

// Vinted serves this marketing blurb as the page's meta description when the
// item description is not in the HTML; parseListingDescription keeps it.
const VINTED_BOILERPLATE = 'Jedna społeczność, tysiące marek%';

type ShadowRow = {
  id: number;
  created_at: string;
  task: string;
  input_hash: string;
  jev_answer_json: string | null;
  jev_confidence: number | null;
  jev_unsure: number;
  jev_error: string | null;
  deepseek_decision: string | null;
  agreement: number | null;
  vision_verdict: string | null;
  vision_confidence: number | null;
  vision_images_seen: number | null;
  vision_error: string | null;
  note: string | null;
};

const shadow = all<ShadowRow>(db, 'SELECT * FROM jev_shadow_log ORDER BY created_at, id');
const parseAnswer = (row: ShadowRow): Record<string, unknown> => {
  try {
    return row.jev_answer_json ? JSON.parse(row.jev_answer_json) as Record<string, unknown> : {};
  } catch {
    return {};
  }
};
const byTask = new Map<string, ShadowRow[]>();
for (const row of shadow) {
  const list = byTask.get(row.task) ?? [];
  list.push(row);
  byTask.set(row.task, list);
}
const taskRows = (task: string) => byTask.get(task) ?? [];
const hasVision = (row: ShadowRow) => row.vision_verdict !== null || row.vision_error !== null;
const pct = (value: number | null) => (value === null ? null : value * 100);

// ===================================================================== volume

const firstCall = shadow[0]?.created_at ?? null;
const lastCall = shadow.at(-1)?.created_at ?? null;
const spanDays = firstCall && lastCall ? Math.max(1, (Date.parse(lastCall) - Date.parse(firstCall)) / 86_400_000) : null;
const recentFrom = bench.daysAgo(14);
const recent = shadow.filter((row) => row.created_at >= recentFrom);
const visionCalls = shadow.filter(hasVision).length;

bench.param('aiLogSpan', { from: firstCall, to: lastCall, days: spanDays });
bench.metric('ai.calls.total', 'Jev calls logged (all tasks)', shadow.length, 'calls', 'info', `${firstCall?.slice(0, 10)} → ${lastCall?.slice(0, 10)}`);
bench.metric('ai.calls.vision', 'Vision calls (escalations)', visionCalls, 'calls', 'info');
bench.metric('ai.calls.per_day', 'Jev + vision calls per day, whole log', spanDays ? (shadow.length + visionCalls) / spanDays : null, 'calls/d', 'info');
bench.metric('ai.calls.per_day_14d', 'Jev + vision calls per day, last 14 days', (recent.length + recent.filter(hasVision).length) / 14, 'calls/d', 'info');
bench.metric('ai.calls.live_share', 'Share of logged calls made in Jev live mode', pct(ratio(shadow.filter((row) => row.note === 'live').length, shadow.length)), '%', 'info');
bench.metric('ai.shadow.deepseek_rows', 'Rows with a DeepSeek decision to compare against (shadow mode)', shadow.filter((row) => row.deepseek_decision !== null).length, 'rows', 'info',
  'zero means Jev-vs-DeepSeek agreement cannot be measured from this export');
bench.metric('ai.calls.unlogged_checks_cached', 'Manual-search check verdicts cached but never logged as calls', scalar(db, "SELECT COUNT(*) FROM jev_fuzzy_cache WHERE task = 'checks'"), 'rows', 'info',
  'applySearchChecks (server/service.ts) calls Jev without logJevLive; title-only calls leave no row at all');

const taskSummary = [...byTask.entries()].map(([task, rows]) => ({
  task,
  calls: rows.length,
  perDay: spanDays ? Number((rows.length / spanDays).toFixed(1)) : null,
  last14d: rows.filter((row) => row.created_at >= recentFrom).length,
  unsurePct: Number((100 * rows.filter((row) => row.jev_unsure === 1).length / rows.length).toFixed(1)),
  errors: rows.filter((row) => row.jev_error !== null).length,
  vision: rows.filter(hasVision).length,
  distinctInputs: new Set(rows.map((row) => row.input_hash)).size,
}));
bench.table('calls by task', taskSummary);
for (const row of taskSummary) {
  const id = row.task.replace(/-/g, '_');
  bench.metric(`ai.${id}.calls`, `${row.task} calls`, row.calls, 'calls', 'info');
  bench.metric(`ai.${id}.error_rate`, `${row.task} provider/format error rate`, ratio(row.errors, row.calls) === null ? null : 100 * row.errors / row.calls, '%', 'lower');
}

const perDay = new Map<string, Record<string, number>>();
for (const row of shadow) {
  const day = row.created_at.slice(0, 10);
  const entry = perDay.get(day) ?? {};
  entry[row.task] = (entry[row.task] ?? 0) + 1;
  if (hasVision(row)) entry.vision = (entry.vision ?? 0) + 1;
  perDay.set(day, entry);
}
bench.table('calls per day (last 30 days)', [...perDay.entries()].filter(([day]) => day >= bench.daysAgo(30).slice(0, 10)).map(([day, counts]) => ({ day, ...counts })));

// ================================================================== relevance

type WatchRow = { id: string; name: string; query: string; included_terms: string; excluded_terms: string; variant_groups_json: string | null; enabled: number };
const watches = all<WatchRow>(db, 'SELECT id, name, query, included_terms, excluded_terms, variant_groups_json, enabled FROM watches');
const watchById = new Map(watches.map((watch) => [watch.id, watch]));
const groupsByWatch = new Map<string, VariantGroup[]>(watches.map((watch) => [watch.id, safeGroups(watch.variant_groups_json)]));
function safeGroups(raw: string | null): VariantGroup[] {
  try {
    return raw ? parseVariantGroups(JSON.parse(raw)) : [];
  } catch {
    return [];
  }
}

const relevanceCalls = taskRows('relevance');
// Repeat calls: a call whose exact input was already answered (no error) by an
// earlier call. Live mode skips the cross-listing reuse the legacy path has
// (server/service.ts filterListingsByAiRelevance), so identical titles on
// different listings each cost a call.
function repeats(rows: ShadowRow[]) {
  const decided = new Map<string, unknown[]>();
  let repeat = 0;
  for (const row of rows) {
    const verdicts = decided.get(row.input_hash);
    if (verdicts) repeat += 1;
    if (row.jev_error !== null) continue;
    const answer = parseAnswer(row);
    const verdict = row.task === 'relevance' ? answer.relevant : answer.decision ?? answer.variantId;
    if (verdicts) verdicts.push(verdict);
    else decided.set(row.input_hash, [verdict]);
  }
  const multi = [...decided.values()].filter((verdicts) => verdicts.length > 1);
  const unstable = multi.filter((verdicts) => new Set(verdicts.map(String)).size > 1);
  return { repeat, multi: multi.length, unstable: unstable.length };
}
const relRepeats = repeats(relevanceCalls);
bench.metric('ai.relevance.repeat_calls', 'Relevance calls on an input already answered', relRepeats.repeat, 'calls', 'lower',
  `${(100 * relRepeats.repeat / Math.max(1, relevanceCalls.length)).toFixed(1)}% of relevance calls; reusing by input hash would skip them`);
bench.metric('ai.relevance.repeat_share', 'Share of relevance calls that repeat an answered input', pct(ratio(relRepeats.repeat, relevanceCalls.length)), '%', 'lower');
bench.metric('ai.relevance.unstable_inputs', 'Inputs asked twice or more that got different verdicts', pct(ratio(relRepeats.unstable, relRepeats.multi)), '%', 'lower',
  `${relRepeats.unstable} of ${relRepeats.multi} repeated inputs flipped relevant/irrelevant`);

const relP = relevanceCalls.filter((row) => row.jev_error === null).map((row) => Number(parseAnswer(row).p)).filter(Number.isFinite);
const bands: Array<[string, number, number]> = [['<0.10', 0, 0.1], ['0.10–0.40', 0.1, 0.4], ['0.40–0.50 (unsure, leans no)', 0.4, 0.5], ['0.50–0.60 (unsure, leans yes)', 0.5, 0.6], ['0.60–0.70', 0.6, 0.7], ['0.70–0.90', 0.7, 0.9], ['≥0.90', 0.9, 1.01]];
bench.table('relevance p distribution (all calls)', bands.map(([band, lo, hi]) => {
  const n = relP.filter((p) => p >= lo && p < hi).length;
  return { band, calls: n, pct: Number((100 * n / Math.max(1, relP.length)).toFixed(1)) };
}));
bench.metric('ai.relevance.unsure_rate', 'Relevance calls in the unsure band (0.4–0.6), decided by lean', pct(ratio(relevanceCalls.filter((row) => row.jev_unsure === 1).length, relevanceCalls.length)), '%', 'lower');
bench.metric('ai.relevance.lowconf_relevant_rate', 'Relevance calls with 0.6 ≤ p < 0.7 (relevant, weakly)', pct(ratio(relP.filter((p) => p >= 0.6 && p < 0.7).length, relP.length)), '%', 'lower');

// Who asks: a hash in manual_relevance_cache came from a manual search (MCP /
// Hatbot / UI search); a hash in listing_relevance from a watch scan.
const manualHashes = new Set(all<{ input_hash: string }>(db, 'SELECT input_hash FROM manual_relevance_cache').map((row) => row.input_hash));
const watchHashes = new Set(all<{ input_hash: string }>(db, 'SELECT input_hash FROM listing_relevance').map((row) => row.input_hash));
const origin = { watch: 0, manual: 0, both: 0, unknown: 0 };
for (const row of relevanceCalls) {
  const m = manualHashes.has(row.input_hash);
  const w = watchHashes.has(row.input_hash);
  if (m && w) origin.both += 1;
  else if (m) origin.manual += 1;
  else if (w) origin.watch += 1;
  else origin.unknown += 1;
}
bench.table('relevance calls by origin', Object.entries(origin).map(([source, calls]) => ({ source, calls, pct: Number((100 * calls / Math.max(1, relevanceCalls.length)).toFixed(1)) })));
bench.metric('ai.relevance.manual_share', 'Share of relevance calls from manual searches', pct(ratio(origin.manual + origin.both, relevanceCalls.length)), '%', 'info');
const crossPath = [...manualHashes].filter((hash) => watchHashes.has(hash)).length;
bench.metric('ai.relevance.cross_path_inputs', 'Inputs judged by both the watch path and the manual cache', crossPath, 'inputs', 'lower',
  'the two caches never read each other, so each pays once');

type RelRow = { watch_id: string; marketplace: string; listing_id: string; input_hash: string; relevant: number; relevance_status: string | null; reason: string | null; error: string | null; checked_at: string; title: string | null; condition: string | null; location: string | null; listing_row: number | null };
const relRows = all<RelRow>(db, `SELECT r.watch_id, r.marketplace, r.listing_id, r.input_hash, r.relevant, r.relevance_status, r.reason, r.error, r.checked_at,
  l.title, l.condition, l.location, l.id AS listing_row
  FROM listing_relevance r LEFT JOIN listings l ON l.marketplace = r.marketplace AND l.listing_id = r.listing_id`);
const relStatus = (row: RelRow) => row.error ? 'error' : row.relevance_status === 'unknown'
  ? (row.reason?.includes('skipped') ? 'gate-skipped' : row.reason?.includes('budget') ? 'budget' : 'unknown')
  : row.relevance_status ?? (row.relevant ? 'relevant' : 'irrelevant');
const statusCounts = new Map<string, number>();
for (const row of relRows) statusCounts.set(relStatus(row), (statusCounts.get(relStatus(row)) ?? 0) + 1);
bench.table('watch relevance rows by status', [...statusCounts.entries()].map(([status, rows]) => ({ status, rows, pct: Number((100 * rows / relRows.length).toFixed(1)) })));
bench.metric('ai.relevance.watch_rows', 'Watch relevance rows (latest per watch × listing)', relRows.length, 'rows', 'info');
bench.metric('ai.relevance.gate_skipped_share', 'Watch rows kept unjudged by the deal-strength gate', pct(ratio(statusCounts.get('gate-skipped') ?? 0, relRows.length)), '%', 'info');
bench.metric('ai.relevance.irrelevant_share', 'Judged watch rows the AI excluded', pct(ratio(statusCounts.get('irrelevant') ?? 0, (statusCounts.get('irrelevant') ?? 0) + (statusCounts.get('relevant') ?? 0))), '%', 'info');
bench.metric('ai.relevance.rows_without_listing', 'Watch relevance rows whose listing row is gone', relRows.filter((row) => row.listing_row === null).length, 'rows', 'info');

// Recompute hashes to confirm the export's watch settings still produce them
// (they do unless the watch's query/terms or the listing title changed).
let hashMatches = 0;
let hashChecked = 0;
for (const row of relRows) {
  const watch = watchById.get(row.watch_id);
  if (!watch || row.title === null) continue;
  hashChecked += 1;
  const hash = listingRelevanceInputHash({ marketplace: row.marketplace, title: row.title, condition: row.condition, location: row.location, query: watch.query, includedTerms: watch.included_terms, excludedTerms: watch.excluded_terms } as Parameters<typeof listingRelevanceInputHash>[0]);
  if (hash === row.input_hash) hashMatches += 1;
}
bench.metric('ai.relevance.hash_recompute_match', 'Stored relevance hashes reproduced from listing + watch', pct(ratio(hashMatches, hashChecked)), '%', 'info', 'sanity check for the offline analysis below');

bench.table('watch relevance by watch × marketplace', (() => {
  const map = new Map<string, { watch: string; marketplace: string; relevant: number; irrelevant: number; gateSkipped: number; other: number }>();
  for (const row of relRows) {
    const key = `${row.watch_id}|${row.marketplace}`;
    const entry = map.get(key) ?? { watch: watchById.get(row.watch_id)?.name ?? row.watch_id, marketplace: row.marketplace, relevant: 0, irrelevant: 0, gateSkipped: 0, other: 0 };
    const status = relStatus(row);
    if (status === 'relevant') entry.relevant += 1;
    else if (status === 'irrelevant') entry.irrelevant += 1;
    else if (status === 'gate-skipped') entry.gateSkipped += 1;
    else entry.other += 1;
    map.set(key, entry);
  }
  return [...map.values()].map((entry) => ({ ...entry, irrelevantPct: Number((100 * entry.irrelevant / Math.max(1, entry.relevant + entry.irrelevant)).toFixed(1)) }))
    .sort((a, b) => (b.relevant + b.irrelevant) - (a.relevant + a.irrelevant));
})());

// ============================================================== manual cache

const manualRows = scalar(db, 'SELECT COUNT(*) FROM manual_relevance_cache') ?? 0;
bench.metric('ai.manual_cache.rows', 'Manual relevance cache rows', manualRows, 'rows', 'info');
bench.table('manual cache by status', all(db, `SELECT relevance_status AS status, (error IS NOT NULL) AS hasError, model, COUNT(*) AS rows FROM manual_relevance_cache GROUP BY 1, 2, 3 ORDER BY rows DESC`));
const manualAges = all<{ checked_at: string }>(db, 'SELECT checked_at FROM manual_relevance_cache').map((row) => (Date.parse(bench.now) - Date.parse(row.checked_at)) / 86_400_000);
bench.distributionMetrics('ai.manual_cache.age_days', 'Manual cache entry age', distribution(manualAges), 'days', 'info', ['p50', 'p90', 'max']);
const manualRepeat = repeats(relevanceCalls.filter((row) => manualHashes.has(row.input_hash) && !watchHashes.has(row.input_hash)));
bench.metric('ai.manual_cache.repeat_calls', 'Manual-only relevance calls on an input already answered', manualRepeat.repeat, 'calls', 'lower');
// Gap since the previous call with the same input: under 10 s is the same
// search pass (in-flight dedup is per listing URL, and the cache is written
// only after the pass), longer gaps are later searches or scans.
function repeatGaps(rows: ShadowRow[]) {
  const last = new Map<string, number>();
  const gaps = { sameSearchUnder10s: 0, under1h: 0, under1d: 0, later: 0 };
  for (const row of rows) {
    const at = Date.parse(row.created_at);
    const previous = last.get(row.input_hash);
    if (previous !== undefined) {
      const seconds = (at - previous) / 1000;
      if (seconds < 10) gaps.sameSearchUnder10s += 1;
      else if (seconds < 3600) gaps.under1h += 1;
      else if (seconds < 86_400) gaps.under1d += 1;
      else gaps.later += 1;
    }
    last.set(row.input_hash, at);
  }
  return gaps;
}
const manualGaps = repeatGaps(relevanceCalls.filter((row) => manualHashes.has(row.input_hash) && !watchHashes.has(row.input_hash)));
const watchGaps = repeatGaps(relevanceCalls.filter((row) => !(manualHashes.has(row.input_hash) && !watchHashes.has(row.input_hash))));
bench.metric('ai.manual_cache.same_pass_repeats', 'Manual relevance calls repeating an input within 10 s (same search pass)', manualGaps.sameSearchUnder10s, 'calls', 'lower',
  'pendingLive dedups by input hash + listing URL + thumbnail, so identical titles in one search each cost a call');
bench.table('relevance repeat calls by gap since the same input was last asked', [
  { origin: 'manual only', ...manualGaps },
  { origin: 'watch / both / unknown', ...watchGaps },
]);

// ============================================================== fuzzy rescue

type FuzzyRow = { input_hash: string; model: string; task: string; decision: string; confidence: number | null; rescued: number; checked_at: string };
// Rows with decision 'error' are the rescue's retry backoff, not verdicts.
const fuzzy = all<FuzzyRow>(db, "SELECT * FROM jev_fuzzy_cache WHERE decision != 'error'");
const termCache = fuzzy.filter((row) => row.task === 'term-match');
const termCalls = taskRows('term-match');
const termRescued = termCache.filter((row) => row.rescued === 1).length;
bench.metric('ai.term_match.cached_verdicts', 'Term-match verdicts cached', termCache.length, 'rows', 'info');
bench.metric('ai.term_match.rescue_rate', 'Term-match calls that rescued a listing', pct(ratio(termRescued, termCache.length)), '%', 'higher');
bench.metric('ai.term_match.calls_per_rescue', 'Term-match calls spent per rescued listing', termRescued ? termCalls.length / termRescued : null, 'calls', 'lower');
bench.metric('ai.term_match.reject_share', 'Term-match verdicts that were a confident or plain reject', pct(ratio(termCache.filter((row) => row.decision === 'reject').length, termCache.length)), '%', 'lower');
const termErrored = new Set(termCalls.filter((row) => row.jev_error !== null).map((row) => row.input_hash));
bench.metric('ai.term_match.errors_retried', 'Term-match calls repeated after an error (errors are not cached)', termCalls.filter((row, index) => termCalls.findIndex((other) => other.input_hash === row.input_hash) !== index && termErrored.has(row.input_hash)).length, 'calls', 'lower');
bench.metric('ai.term_match.repeat_calls', 'Term-match calls on an input already answered', repeats(termCalls).repeat, 'calls', 'lower');
// The rescue now remembers a failed call for an hour (FUZZY_ERROR_RETRY_MS).
const lastFailure = new Map<string, number>();
let retriesInBackoff = 0;
for (const row of [...termCalls, ...taskRows('condition')].sort((a, b) => a.created_at.localeCompare(b.created_at))) {
  const at = Date.parse(row.created_at);
  const failed = lastFailure.get(row.input_hash);
  if (failed !== undefined && at - failed < 60 * 60_000) retriesInBackoff += 1;
  if (row.jev_error !== null) lastFailure.set(row.input_hash, at);
  else lastFailure.delete(row.input_hash);
}
bench.metric('ai.term_match.retries_within_hour_of_error', 'Rescue calls (term or condition) re-sent within an hour of the same input failing (the backoff skips these)', retriesInBackoff, 'calls', 'info');
bench.table('fuzzy cache by task and verdict', (() => {
  const map = new Map<string, { task: string; decision: string; rescued: number; rows: number; confSum: number; confN: number }>();
  for (const row of fuzzy) {
    let decision = row.decision;
    if (row.task === 'checks') {
      try {
        decision = String((JSON.parse(row.decision) as { summary?: string }).summary);
      } catch {
        decision = '?';
      }
    } else if (row.task === 'variant' && decision !== 'none' && decision !== 'unknown') {
      decision = 'variant';
    }
    const key = `${row.task}|${decision}|${row.rescued}`;
    const entry = map.get(key) ?? { task: row.task, decision, rescued: row.rescued, rows: 0, confSum: 0, confN: 0 };
    entry.rows += 1;
    if (row.confidence !== null) {
      entry.confSum += row.confidence;
      entry.confN += 1;
    }
    map.set(key, entry);
  }
  return [...map.values()].map(({ confSum, confN, ...rest }) => ({ ...rest, avgConfidence: confN ? Number((confSum / confN).toFixed(2)) : null }));
})());

// Offline: recover the titles behind term-match hashes by hashing every stored
// listing against every watch and research query, then replay the rule
// rescueFuzzyMisses applies before spending a Jev call (lacksQueryModelNumber
// in server/aiRules.ts): the title has none of the query's number-bearing
// terms, e.g. "GTX 1660 Super" for "rtx 2060". Only listings Scout stored are recoverable; manual-search
// queries are not in the export, so this is a subset.
const listingTitles = all<{ title: string; condition: string | null }>(db, 'SELECT DISTINCT title, condition FROM listings');
const searches = [
  ...watches.map((watch) => ({ query: watch.query, included: watch.included_terms ?? '', excluded: watch.excluded_terms ?? '' })),
  ...(tableExists(db, 'market_watches') ? all<{ query: string; included_terms: string | null; excluded_terms: string | null }>(db, 'SELECT query, included_terms, excluded_terms FROM market_watches') : [])
    .map((watch) => ({ query: watch.query, included: watch.included_terms ?? '', excluded: watch.excluded_terms ?? '' })),
];
const termByHash = new Map(termCache.map((row) => [row.input_hash, row]));
const recovered: Array<{ query: string; title: string; decision: string; rescued: number; noModelToken: boolean; missing: string }> = [];
const seenTerm = new Set<string>();
for (const listing of listingTitles) {
  for (const search of searches) {
    const hash = listingTermMatchInputHash({ title: listing.title, listingCondition: listing.condition, query: search.query, includedTerms: search.included, excludedTerms: search.excluded });
    const cached = termByHash.get(hash);
    if (!cached || seenTerm.has(hash)) continue;
    seenTerm.add(hash);
    const text = normalizeFilterText(listing.title);
    const glued = text.replace(/ /g, '');
    const { included } = parseIncludedExcluded(search.query, search.included, search.excluded);
    recovered.push({
      query: search.query,
      title: listing.title,
      decision: cached.decision,
      rescued: cached.rescued,
      noModelToken: lacksQueryModelNumber(listing.title, search.query, search.included, search.excluded),
      missing: included.filter((term) => !termMatches(text, glued, term)).join(' '),
    });
  }
}
const ruleHits = recovered.filter((row) => row.noModelToken);
bench.metric('ai.term_match.recovered', 'Term-match verdicts whose title and query were recovered offline', recovered.length, 'rows', 'info', `${(100 * recovered.length / Math.max(1, termCache.length)).toFixed(1)}% of the cache`);
bench.metric('ai.term_match.rule_decidable', 'Recovered term-match calls a "no model number in title" rule decides', pct(ratio(ruleHits.length, recovered.length)), '%', 'info');
bench.metric('ai.term_match.rule_lost_rescues', 'Rescues that rule would have dropped (must stay 0)', ruleHits.filter((row) => row.rescued === 1).length, 'rows', 'lower');
bench.table('term-match rescues (recovered)', recovered.filter((row) => row.rescued === 1).slice(0, examples).map(({ query, title, missing }) => ({ query, title, missing })));
bench.table('term-match rejects the rule would skip (recovered)', ruleHits.filter((row) => row.rescued === 0).slice(0, examples).map(({ query, title, decision }) => ({ query, title, decision })));

const variantCalls = taskRows('variant');
bench.metric('ai.variant.unsure_rate', 'Variant calls that came back unsure', pct(ratio(variantCalls.filter((row) => row.jev_unsure === 1).length, variantCalls.length)), '%', 'lower');
bench.metric('ai.variant.none_share', 'Variant verdicts "none of the variants"', pct(ratio(fuzzy.filter((row) => row.task === 'variant' && row.decision === 'none').length, fuzzy.filter((row) => row.task === 'variant').length)), '%', 'info');

// ============================================================= negotiability

const negotiability = taskRows('negotiability');
bench.metric('ai.negotiability.unsure_rate', 'Negotiability calls that came back unsure (no write, asked again on the next fresh check)', pct(ratio(negotiability.filter((row) => row.jev_unsure === 1).length, negotiability.length)), '%', 'lower');
bench.metric('ai.negotiability.useful_calls', 'Negotiability calls that changed a listing', negotiability.filter((row) => row.jev_unsure === 0).length, 'calls', 'higher');

// ================================================== description verification

const verification = taskRows('verification');
const vVision = verification.filter(hasVision);
const vVisionDone = verification.filter((row) => row.vision_verdict !== null);
bench.metric('ai.verification.vision_escalation_rate', 'Verifications escalated to vision (Jev unsure or failed)', pct(ratio(vVision.length, verification.length)), '%', 'lower');
const visionMix = { pass: 0, reject: 0, unknown: 0 } as Record<string, number>;
for (const row of vVisionDone) visionMix[row.vision_verdict!] = (visionMix[row.vision_verdict!] ?? 0) + 1;
bench.metric('ai.verification.vision_pass_share', 'Vision verdicts that pass (the only verdict that lets a held alert out)', pct(ratio(visionMix.pass ?? 0, vVisionDone.length)), '%', 'info',
  `pass ${visionMix.pass ?? 0} · reject ${visionMix.reject ?? 0} · unknown ${visionMix.unknown ?? 0}`);
bench.metric('ai.verification.vision_error_rate', 'Vision escalations that failed', pct(ratio(verification.filter((row) => row.vision_error !== null).length, vVision.length)), '%', 'lower');
bench.distributionMetrics('ai.verification.vision_images', 'Photos sent per vision call', distribution(vVisionDone.map((row) => Number(row.vision_images_seen ?? 0))), 'images', 'info', ['p50', 'mean']);

const leanTable = new Map<string, { jev: string; why: string; vision: string; calls: number; confSum: number }>();
for (const row of verification) {
  const answer = parseAnswer(row);
  const jev = row.jev_error ? 'error' : String(answer.decision ?? '?');
  const why = row.jev_error ? 'jev failed' : row.jev_unsure ? (jev === 'unknown' ? 'chose unknown' : 'low confidence') : 'confident';
  const vision = row.vision_verdict ?? (row.vision_error ? 'vision failed' : '—');
  const key = `${jev}|${why}|${vision}`;
  const entry = leanTable.get(key) ?? { jev, why, vision, calls: 0, confSum: 0 };
  entry.calls += 1;
  entry.confSum += Number(row.jev_confidence ?? 0);
  leanTable.set(key, entry);
}
bench.table('verification: Jev verdict → vision verdict', [...leanTable.values()].sort((a, b) => b.calls - a.calls)
  .map(({ confSum, ...rest }) => ({ ...rest, avgJevConfidence: Number((confSum / rest.calls).toFixed(2)) })));

// Threshold check: Jev leans with confidence below VERIFICATION_MIN_CONFIDENCE
// go to vision. How often did vision agree with the lean?
for (const lean of ['pass', 'reject'] as const) {
  const rows = vVisionDone.filter((row) => row.jev_unsure === 1 && parseAnswer(row).decision === lean);
  const agree = rows.filter((row) => row.vision_verdict === lean).length;
  bench.metric(`ai.verification.${lean}_lean_vision_agreement`, `Vision agreed with a low-confidence Jev "${lean}"`, pct(ratio(agree, rows.length)), '%', 'info', `${agree}/${rows.length}`);
}
const unknownChoice = vVisionDone.filter((row) => parseAnswer(row).decision === 'unknown');
bench.metric('ai.verification.unknown_choice_share', 'Vision escalations caused by Jev choosing "unknown" (not low confidence)', pct(ratio(unknownChoice.length, vVisionDone.length)), '%', 'info');
bench.metric('ai.verification.unknown_choice_vision_reject', 'Of those, vision rejected', pct(ratio(unknownChoice.filter((row) => row.vision_verdict === 'reject').length, unknownChoice.length)), '%', 'info');
// Alerts go out only on `pass` (runDescriptionVerification: allowed = decision === 'pass'),
// so a vision call changes whether an alert is sent only when it passes.
bench.metric('ai.verification.vision_calls_alert_neutral', 'Vision calls whose verdict could not release an alert (reject/unknown/failed)', vVision.length - (visionMix.pass ?? 0), 'calls', 'lower',
  'unknown and reject both hold the alert; reject also hides the listing from deal feeds');

// Repeats: the listing keeps one verdict slot (listings.ai_description_verification_*),
// so a description that alternates between fetches (text / missing / Vinted
// boilerplate) re-runs Jev and vision each time it comes back.
type VerifHash = { h: string; listings: number; boiler: number };
const snapshotHashes = new Map(all<VerifHash>(db, `SELECT verification_input_hash AS h, COUNT(DISTINCT listing_id) AS listings,
  MAX(description LIKE ?) AS boiler FROM listing_detail_snapshots WHERE verification_input_hash IS NOT NULL GROUP BY 1`, VINTED_BOILERPLATE).map((row) => [row.h, row]));
const callsByHash = new Map<string, ShadowRow[]>();
for (const row of verification) callsByHash.set(row.input_hash, [...(callsByHash.get(row.input_hash) ?? []), row]);
let sameListingRepeats = 0;
let crossListingRepeats = 0;
let boilerCalls = 0;
let boilerVision = 0;
let unmatched = 0;
for (const [hash, rows] of callsByHash) {
  const snap = snapshotHashes.get(hash);
  if (!snap) {
    unmatched += rows.length;
    continue;
  }
  if (rows.length > snap.listings) sameListingRepeats += rows.length - snap.listings;
  if (snap.listings > 1) crossListingRepeats += Math.min(rows.length, snap.listings) - 1;
  if (snap.boiler) {
    boilerCalls += rows.length;
    boilerVision += rows.filter(hasVision).length;
  }
}
bench.metric('ai.verification.repeat_calls', 'Verification calls on an input already verified', verification.length - callsByHash.size, 'calls', 'lower',
  `${(100 * (verification.length - callsByHash.size) / Math.max(1, verification.length)).toFixed(1)}% of verification calls`);
bench.metric('ai.verification.same_listing_repeats', 'Re-verifications of the same listing and same input', sameListingRepeats, 'calls', 'lower');
bench.metric('ai.verification.cross_listing_repeats', 'Verifications of an input another listing already had', crossListingRepeats, 'calls', 'lower');
bench.metric('ai.verification.boilerplate_calls', 'Jev calls on the Vinted marketing blurb instead of a description', boilerCalls, 'calls', 'lower',
  `${boilerVision} of them also went to vision`);
bench.metric('ai.verification.unmatched_calls', 'Verification calls with no snapshot for their input', unmatched, 'calls', 'info');
// The same calls judged by the repo's current description parser: an input
// whose description it now drops as boilerplate is stored as "no description"
// without any AI call.
const snapshotDescriptions = new Map(all<{ h: string; marketplace: string; description: string | null }>(db, `SELECT verification_input_hash AS h, marketplace, description
  FROM listing_detail_snapshots WHERE verification_input_hash IS NOT NULL AND description IS NOT NULL GROUP BY 1`).map((row) => [row.h, row]));
let droppedCalls = 0;
let droppedVision = 0;
for (const [hash, rows] of callsByHash) {
  const snap = snapshotDescriptions.get(hash);
  if (!snap || listingDescriptionText(snap.description, snap.marketplace as Marketplace) !== null) continue;
  droppedCalls += rows.length;
  droppedVision += rows.filter(hasVision).length;
}
bench.metric('ai.verification.parser_dropped_calls', 'Verification calls whose description the current parser drops as boilerplate (no AI call now)', droppedCalls, 'calls', 'info',
  `${droppedVision} of them went to vision`);

const snapStats = all<{ marketplace: string; snapshots: number; noDescription: number; boilerplate: number; overLimit: number; listings: number }>(db, `SELECT marketplace,
  COUNT(*) AS snapshots, SUM(description IS NULL) AS noDescription, SUM(description LIKE ?) AS boilerplate,
  SUM(LENGTH(description) > ?) AS overLimit, COUNT(DISTINCT listing_id) AS listings
  FROM listing_detail_snapshots GROUP BY 1`, VINTED_BOILERPLATE, LISTING_DESCRIPTION_MAX_CHARS);
bench.table('detail snapshots by marketplace', snapStats);
for (const row of snapStats) {
  const key = row.marketplace.toLowerCase().replace(/\s+/g, '_');
  bench.metric(`ai.verification.no_description.${key}`, `${row.marketplace} detail pages with no usable description`, pct(ratio(row.noDescription + row.boilerplate, row.snapshots)), '%', 'lower',
    `${row.noDescription} missing + ${row.boilerplate} boilerplate of ${row.snapshots}`);
}
// Why the current rejects were rejected (issue text of the stored verdict).
const rejects = all<{ json: string | null }>(db, "SELECT ai_description_verification_json AS json FROM listings WHERE ai_description_verification_status = 'reject'");
const rejectReasons = { jev: { rows: 0, battery: 0, otherModel: 0, damage: 0 }, vision: { rows: 0, battery: 0, otherModel: 0, damage: 0 } };
for (const row of rejects) {
  let summary = '';
  let issues = '';
  try {
    const parsed = JSON.parse(row.json ?? '{}') as { summary?: string; issues?: string[] };
    summary = parsed.summary ?? '';
    issues = (parsed.issues ?? []).join(' ').toLowerCase();
  } catch {
    // unreadable verdict: counted under jev with no reason
  }
  const bucket = /vision/i.test(summary) ? rejectReasons.vision : rejectReasons.jev;
  bucket.rows += 1;
  if (/batter|bateri/.test(issues)) bucket.battery += 1;
  if (/not the sought|different model|rather than the sought/.test(issues)) bucket.otherModel += 1;
  if (/crack|damage|broken|shatter|scratch/.test(issues)) bucket.damage += 1;
}
bench.table('current verification rejects by decider and stated reason', Object.entries(rejectReasons).map(([decider, counts]) => ({ decider, ...counts })));
bench.metric('ai.verification.vision_battery_rejects', 'Vision rejects that cite battery health', pct(ratio(rejectReasons.vision.battery, rejectReasons.vision.rows)), '%', 'lower',
  `${rejectReasons.vision.battery} of ${rejectReasons.vision.rows}; battery wear is a price factor for a reseller, the vision prompt treats it as a material issue`);
bench.table('listing verification status', all(db, `SELECT ai_description_verification_status AS status, ai_description_verification_model AS model,
  (ai_description_verification_error IS NOT NULL) AS hasError, COUNT(*) AS listings FROM listings
  WHERE ai_description_verification_status IS NOT NULL GROUP BY 1, 2, 3 ORDER BY listings DESC`));
bench.table('snapshot verification status', all(db, 'SELECT marketplace, verification_status AS status, COUNT(*) AS snapshots FROM listing_detail_snapshots GROUP BY 1, 2 ORDER BY 1, 3 DESC'));

// Input size as a token proxy: description characters sent per verification
// call, title characters per watch relevance row.
const descLen = new Map(all<{ h: string; len: number }>(db, `SELECT verification_input_hash AS h, MAX(LENGTH(description)) AS len FROM listing_detail_snapshots
  WHERE verification_input_hash IS NOT NULL GROUP BY 1`).map((row) => [row.h, Number(row.len ?? 0)]));
bench.distributionMetrics('ai.verification.description_chars', 'Description characters per verification call', distribution(verification.map((row) => Math.min(descLen.get(row.input_hash) ?? 0, LISTING_DESCRIPTION_MAX_CHARS))), 'chars', 'info', ['p50', 'p90', 'max']);
bench.distributionMetrics('ai.relevance.title_chars', 'Title characters per watch relevance row', distribution(relRows.filter((row) => row.title).map((row) => row.title!.length)), 'chars', 'info', ['p50', 'p90']);
bench.metric('ai.latency.recorded', 'AI calls with a recorded duration', 0, 'calls', 'higher', 'jev_shadow_log has no duration column; latency cannot be benchmarked from an export');

// =========================================================== accuracy proxies

// User triage: 41 actions, nearly all "hidden". Hiding is a buy/skip choice
// (price, condition, already seen), not a relevance label, so this is a weak
// proxy: a hidden listing the AI called relevant is not necessarily an error.
const triage = all<{ marketplace: string; listing_id: string; decision: string | null; hidden: number; title: string | null; verification: string | null }>(db, `SELECT a.marketplace, a.listing_id, a.decision, a.hidden,
  l.title, l.ai_description_verification_status AS verification FROM listing_actions a LEFT JOIN listings l ON l.marketplace = a.marketplace AND l.listing_id = a.listing_id`);
const relByListing = new Map<string, RelRow[]>();
for (const row of relRows) relByListing.set(`${row.marketplace}:${row.listing_id}`, [...(relByListing.get(`${row.marketplace}:${row.listing_id}`) ?? []), row]);
const triageRows = triage.map((row) => {
  const rel = relByListing.get(`${row.marketplace}:${row.listing_id}`) ?? [];
  const p = rel.map((r) => /p=([\d.]+)/.exec(r.reason ?? '')?.[1]).find(Boolean);
  return { action: row.hidden ? 'hidden' : row.decision ?? '?', relevance: rel.length ? relStatus(rel[0]) : 'none', p: p ?? null, verification: row.verification ?? 'none', title: row.title };
});
bench.metric('ai.triage.actions', 'User triage actions (ground truth, thin)', triage.length, 'rows', 'info');
const triageJudged = triageRows.filter((row) => row.relevance === 'relevant' || row.relevance === 'irrelevant');
bench.metric('ai.triage.hidden_ai_relevant', 'Hidden listings the AI had judged relevant', triageRows.filter((row) => row.action === 'hidden' && row.relevance === 'relevant').length, 'rows', 'info',
  `${triageJudged.length} triaged listings carry a relevance verdict`);
bench.table('triage vs AI (by relevance × verification)', (() => {
  const map = new Map<string, number>();
  for (const row of triageRows) map.set(`${row.action}|${row.relevance}|${row.verification}`, (map.get(`${row.action}|${row.relevance}|${row.verification}`) ?? 0) + 1);
  return [...map.entries()].map(([key, rows]) => {
    const [action, relevance, verification] = key.split('|');
    return { action, relevance, verification, rows };
  }).sort((a, b) => b.rows - a.rows);
})());
bench.table('hidden listings AI judged relevant with p < 0.7', triageRows.filter((row) => row.action === 'hidden' && row.relevance === 'relevant' && row.p !== null && Number(row.p) < 0.7)
  .map(({ title, p, verification }) => ({ title, p, verification })));

if (tableExists(db, 'flips')) {
  const flips = all<{ listing_key: string | null; title: string }>(db, 'SELECT listing_key, title FROM flips');
  bench.table('flips vs AI', flips.map((flip) => {
    const rel = flip.listing_key ? relByListing.get(flip.listing_key) ?? [] : [];
    const verification = flip.listing_key ? one<{ s: string | null }>(db, "SELECT ai_description_verification_status AS s FROM listings WHERE marketplace || ':' || listing_id = ?", flip.listing_key)?.s ?? null : null;
    return { title: flip.title, linked: Boolean(flip.listing_key), relevance: rel.map((row) => `${relStatus(row)} ${/p=[\d.]+/.exec(row.reason ?? '')?.[0] ?? ''}`.trim()).join('; ') || null, verification };
  }));
}

// Deterministic rules vs the AI on judged watch rows with a title:
// - junk: a quick flag (for_parts, wanted_ad, swap, replica, accessory, damaged, locked)
//   computed with the watch query; the relevance prompt treats all of these as "no".
// - plain: every include term present, a named variant when the watch has
//   groups, no flag, and no model token outside the query and variant terms.
type RuleRow = { key: string; watch: string; title: string; ai: string; p: string | null; rule: 'junk' | 'plain' | 'other'; detail: string };
const ruleRows: RuleRow[] = [];
for (const row of relRows) {
  const status = relStatus(row);
  if (status !== 'relevant' && status !== 'irrelevant') continue;
  const watch = watchById.get(row.watch_id);
  if (!watch || !row.title) continue;
  const p = /p=([\d.]+)/.exec(row.reason ?? '')?.[1] ?? null;
  const flags = listingFlags({ title: row.title, condition: row.condition, query: watch.query });
  if (flags.length) {
    ruleRows.push({ key: `${row.watch_id}|${row.marketplace}:${row.listing_id}`, watch: watch.name, title: row.title, ai: status, p, rule: 'junk', detail: flags.map((flag) => `${flag.flag}:${flag.match}`).join(',') });
    continue;
  }
  const text = normalizeFilterText(row.title);
  const glued = text.replace(/ /g, '');
  const { included } = parseIncludedExcluded(watch.query, watch.included_terms, watch.excluded_terms);
  const groups = groupsByWatch.get(watch.id) ?? [];
  const variant = groups.length ? assignVariant(text, groups) : null;
  const termsOk = included.every((term) => termMatches(text, glued, term));
  const known = new Set(normalizeFilterText(`${watch.query} ${groups.map((group) => group.terms).join(' ')}`).split(' '));
  // Memory/size specs ("6gb", "128gb", "gddr6") are not other models.
  const strayModel = text.split(' ').filter((token) => isModelToken(token) && !known.has(token) && !/^(\d+(gb|g|tb|mb|mhz|hz|w|cm|mm|%)|gddr\d+x?|ddr\d|pcie?\d*|x\d+|\d{1,2})$/.test(token));
  if (termsOk && (variant === null || variant !== OTHER_VARIANT_KEY) && !strayModel.length) {
    ruleRows.push({ key: `${row.watch_id}|${row.marketplace}:${row.listing_id}`, watch: watch.name, title: row.title, ai: status, p, rule: 'plain', detail: variant ?? '' });
  } else {
    ruleRows.push({ key: `${row.watch_id}|${row.marketplace}:${row.listing_id}`, watch: watch.name, title: row.title, ai: status, p, rule: 'other', detail: strayModel.join(' ') || (termsOk ? `variant ${variant}` : 'terms missing') });
  }
}
const junk = ruleRows.filter((row) => row.rule === 'junk');
const plain = ruleRows.filter((row) => row.rule === 'plain');
bench.metric('ai.rules.judged_rows', 'Judged watch relevance rows with a title (rule comparison base)', ruleRows.length, 'rows', 'info');
bench.metric('ai.rules.junk_share', 'Judged rows a quick flag already marks as junk', pct(ratio(junk.length, ruleRows.length)), '%', 'info');
bench.metric('ai.rules.junk_ai_agreement', 'Flagged-junk rows the AI also excluded', pct(ratio(junk.filter((row) => row.ai === 'irrelevant').length, junk.length)), '%', 'higher',
  `${junk.filter((row) => row.ai === 'relevant').length} flagged rows the AI kept`);
bench.metric('ai.rules.plain_share', 'Judged rows a title rule calls a plain match', pct(ratio(plain.length, ruleRows.length)), '%', 'info');
bench.metric('ai.rules.plain_ai_agreement', 'Plain-match rows the AI also kept', pct(ratio(plain.filter((row) => row.ai === 'relevant').length, plain.length)), '%', 'higher',
  `${plain.filter((row) => row.ai === 'irrelevant').length} plain-looking titles the AI excluded`);
bench.metric('ai.rules.decidable_calls', 'Judged rows a rule could decide where it agrees with the AI', pct(ratio(junk.filter((row) => row.ai === 'irrelevant').length + plain.filter((row) => row.ai === 'relevant').length, ruleRows.length)), '%', 'info',
  'upper bound on relevance calls a pre-filter could skip without changing a verdict');
const dealByRow = new Map(all<{ watch_id: string; marketplace: string; listing_id: string; deal_label: string | null }>(db, `SELECT wl.watch_id, l.marketplace, l.listing_id, wl.deal_label
  FROM watch_listings wl JOIN listings l ON l.id = wl.listing_id`).map((row) => [`${row.watch_id}|${row.marketplace}:${row.listing_id}`, row.deal_label]));
const plainExcluded = plain.filter((row) => row.ai === 'irrelevant');
bench.metric('ai.rules.plain_excluded_strong_deals', 'Plain-match titles the AI excluded that were Very strong / Exceptional deals', plainExcluded.filter((row) => ['Very strong', 'Exceptional'].includes(dealByRow.get(row.key) ?? '')).length, 'rows', 'lower',
  'the relevance check only runs on gated (deal-strength) listings, so an exclusion here hides a deal');

// The shipped plain-variant rule (server/aiRules.ts) on the same judged rows:
// what it decides without an AI call, and where it overrides an AI exclusion.
const shipped = relRows.flatMap((row) => {
  const status = relStatus(row);
  const watch = watchById.get(row.watch_id);
  const groups = watch ? groupsByWatch.get(watch.id) ?? [] : [];
  if ((status !== 'relevant' && status !== 'irrelevant') || !watch || !row.title || !groups.length) return [];
  const match = plainVariantMatch({ title: row.title, condition: row.condition, query: watch.query, includedTerms: watch.included_terms ?? '', excludedTerms: watch.excluded_terms ?? '', groups });
  return [{ watch: watch.name, title: row.title, ai: status, p: /p=([\d.]+)/.exec(row.reason ?? '')?.[1] ?? null, variant: match?.label ?? null, hash: row.input_hash }];
});
const shippedDecided = shipped.filter((row) => row.variant !== null);
const decidedHashes = new Set(shippedDecided.map((row) => row.hash));
bench.metric('ai.relevance.plain_variant_calls', 'Logged relevance calls on inputs the plain-variant rule now decides', relevanceCalls.filter((row) => decidedHashes.has(row.input_hash)).length, 'calls', 'info',
  `of ${relevanceCalls.length} relevance calls (manual searches have no groups, so the rule never runs there)`);
bench.metric('ai.relevance.plain_variant_decided', 'Judged rows on watches with variant groups the plain-variant rule decides without AI', pct(ratio(shippedDecided.length, shipped.length)), '%', 'higher',
  `${shippedDecided.length} of ${shipped.length}`);
bench.metric('ai.relevance.plain_variant_overrides', 'Of those, rows the AI had excluded (the rule keeps them)', shippedDecided.filter((row) => row.ai === 'irrelevant').length, 'rows', 'info');
bench.table('plain-variant rule overrides of AI exclusions', shippedDecided.filter((row) => row.ai === 'irrelevant').slice(0, examples).map(({ hash: _hash, ...row }) => row));

// Candidate accessory vocabulary the AI excludes but flags.ts does not know
// (GPU fans and coolers, phone cases in other languages, bare chips). Not repo
// code: a list to test before adding words to ACCESSORY_GROUPS.
const CANDIDATE_ACCESSORY = ['wentylator*', 'wiatrak*', 'chlodz*', 'radiator*', 'cooler*', 'fan', 'fans', 'hardcase', 'husa', 'huse', 'chip', 'bga', 'backplate', 'sledz', 'bracket', 'riser*', 'tasma'];
const candidateHit = (title: string) => normalizeFilterText(title).split(' ').find((word) => CANDIDATE_ACCESSORY.some((pattern) => pattern.endsWith('*') ? word.startsWith(pattern.slice(0, -1)) : word === pattern)) ?? null;
const candidateRows = ruleRows.filter((row) => row.rule !== 'junk').map((row) => ({ ...row, word: candidateHit(row.title) })).filter((row) => row.word !== null);
bench.metric('ai.rules.candidate_accessory_rows', 'Unflagged judged rows with a candidate accessory word', candidateRows.length, 'rows', 'info', CANDIDATE_ACCESSORY.join(' '));
bench.metric('ai.rules.candidate_accessory_ai_agreement', 'Of those, the AI excluded', pct(ratio(candidateRows.filter((row) => row.ai === 'irrelevant').length, candidateRows.length)), '%', 'higher',
  `${candidateRows.filter((row) => row.ai === 'relevant').length} the AI kept`);
bench.table('candidate accessory words the AI kept', candidateRows.filter((row) => row.ai === 'relevant').slice(0, examples).map(({ watch, title, p, word }) => ({ watch, title, p, word })));
const leading = new Map<string, number>();
for (const row of ruleRows.filter((entry) => entry.rule !== 'junk' && entry.ai === 'irrelevant')) {
  const word = normalizeFilterText(row.title).split(' ')[0] ?? '';
  leading.set(word, (leading.get(word) ?? 0) + 1);
}
bench.table('first title word of unflagged AI exclusions', [...leading.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([word, rows]) => ({ word, rows })));
bench.table('flagged junk the AI kept (possible AI misses)', junk.filter((row) => row.ai === 'relevant').slice(0, examples).map(({ watch, title, p, detail }) => ({ watch, title, p, flags: detail })));
bench.table('plain titles the AI excluded (rule blind spots or AI errors)', plainExcluded.slice(0, examples).map(({ key, watch, title, p, detail }) => ({ watch, title, p, variant: detail, deal: dealByRow.get(key) ?? null })));
bench.table('weakly relevant (0.6 ≤ p < 0.7) watch rows', ruleRows.filter((row) => row.ai === 'relevant' && row.p !== null && Number(row.p) < 0.7).slice(0, examples).map(({ watch, title, p, rule }) => ({ watch, title, p, rule })));

bench.note('Every Jev call in live mode is one jev_shadow_log row; vision escalations are the rows with vision_verdict or vision_error. Manual-search checks are the only unlogged Jev calls.');
bench.note('No shadow-mode rows (deepseek_decision) exist after the switch to Jev live, so Jev-vs-DeepSeek agreement is not measurable; vision is the only second opinion (verification only).');
bench.note('Ground truth is thin: listing_actions has ~41 rows, almost all "hidden", and hiding is a buy/skip choice rather than a relevance label.');
bench.finish();
