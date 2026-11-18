/**
 * Deal scoring and listing quality, as the export stands: what the baselines
 * are made of, how stable the stored typical price is, whether variant rules
 * put listings in the right bucket, what the exclusions and flags miss, how
 * clean the Strong+ feed and the sent alerts are, and how Scout's
 * "net at typical" compares with the real flip ledger.
 *
 *   node --import tsx scripts/bench/scoring.ts <scout-improvement-*.sqlite> [--json=out.json] [--examples=10]
 *
 * The replay of past scans is scoring-replay.ts. Read-only; about 5 s.
 *
 * Ground truth is thin: a handful of flips, a few dozen hide/pass actions and
 * no negotiation outcomes, and every marketplace price is an asking price.
 * Junk is judged by proxies (stored flags, hides, AI relevance, the
 * description check, an independent title heuristic in scoring-data.ts).
 */

import { Bench, distribution, quantile, ratio, exportInfo } from './lib';
import {
  DAY_MS,
  OTHER_VARIANT_KEY,
  assignVariant,
  buildBaselines,
  foldTitle,
  groupClassMap,
  independentVariantClass,
  junkKinds,
  junkProxies,
  loadAssocs,
  loadListings,
  loadObservations,
  loadWatches,
  modelAnchor,
  pct,
  round,
  statesAt,
  type Assoc,
  type ListingState,
  type WatchCfg,
} from './scoring-data';
import { excludedTermMatches, normalizeFilterText, parseIncludedExcluded } from '../../server/text';
import { DEFAULT_FEE_PRESETS, estimateResaleNet, estimatedNetAtTypical, flipNet, isFlipChannel, normalizeFeePresets, saleFee, type FeePresets, type ResaleBasis } from '../../src/profit';
import { ownSalesFor, type ResaleWatch, type SoldFlip } from '../../server/resale';

const started = Date.now();
const bench = new Bench('scoring');
const { db } = bench;
const nowMs = Date.parse(bench.now);
const exampleCount = Number(bench.args.flags.get('examples') ?? 10);
bench.param('examples', exampleCount);

const watches = loadWatches(db);
const listings = loadListings(db);
const assocs = loadAssocs(db);
const observations = loadObservations(db);
const assocByWatch = new Map<string, Map<number, Assoc>>();
for (const assoc of assocs) {
  let map = assocByWatch.get(assoc.watchId);
  if (!map) assocByWatch.set(assoc.watchId, (map = new Map()));
  map.set(assoc.listingId, assoc);
}
const enabled = watches.filter((w) => w.enabled && !w.archived);
const enabledIds = new Set(enabled.map((w) => w.id));
bench.param('enabled_watches', enabled.map((w) => w.name));
bench.note(`Loaded ${watches.length} watches (${enabled.length} enabled), ${assocs.length} watch listings, ${[...observations.values()].reduce((n, rows) => n + rows.length, 0)} observations in ${Date.now() - started} ms.`);
bench.note('Ground truth is thin: 5 flips, 41 listing_actions (40 hides), no negotiation outcomes; all marketplace prices are asking prices. "Junk" below means a proxy: stored flag, hidden/passed, AI-irrelevant, description check rejected, or the title heuristic in scoring-data.ts.');

const median = (values: number[]) => quantile([...values].sort((a, b) => a - b), 0.5);
const bucketName = (watch: WatchCfg, key: string) => (key === OTHER_VARIANT_KEY ? 'Other' : watch.groups.find((g) => g.id === key)?.label ?? key);
const isReady = (n: number) => n >= 30;

// ------------------------------------------------------------ 1. baselines now

interface BucketView {
  watch: WatchCfg;
  key: string;
  median: number | null;
  states: ListingState[];
}
const bucketViews: BucketView[] = [];
const bucketMedian = new Map<string, number | null>();
const sampleAges: number[] = [];
const enabledSampleFlags = { n: 0, stale30: 0, flagged: 0, hidden: 0, rejected: 0, junkTitle: 0, unverified: 0, duplicate: 0 };
const cleanShifts: number[] = [];
const windowShifts: number[] = [];
const madRatios: number[] = [];
const baselineRows: Array<Record<string, unknown>> = [];
const otherWrongModel = { n: 0, wrong: 0 };

const dupPairs = new Map<number, Set<number>>();
for (const row of db.prepare('SELECT listing_id_a a, listing_id_b b FROM listing_duplicate_pairs').all() as Array<{ a: number; b: number }>) {
  for (const [x, y] of [[row.a, row.b], [row.b, row.a]]) {
    let set = dupPairs.get(x);
    if (!set) dupPairs.set(x, (set = new Set()));
    set.add(y);
  }
}

for (const watch of watches) {
  const assocMap = assocByWatch.get(watch.id) ?? new Map();
  const states = statesAt(watch, observations.get(watch.id) ?? [], assocMap, listings);
  const baselines = buildBaselines(watch, states.values(), nowMs);
  const window30 = buildBaselines(watch, states.values(), nowMs, { windowDays: 30 });
  const clean = buildBaselines(watch, states.values(), nowMs, { exclude: (s) => junkProxies(watch, s.assoc, s.listing).any });
  const anchor = modelAnchor(watch.query);
  for (const bucket of baselines.buckets.values()) {
    const sampleStates = bucket.samples.map((s) => states.get(s.listingId)!).filter(Boolean);
    bucketViews.push({ watch, key: bucket.key, median: bucket.stats.median, states: sampleStates });
    bucketMedian.set(`${watch.id}|${bucket.key}`, bucket.stats.median);
    const ids = new Set(sampleStates.map((s) => s.listing.id));
    const signatures = new Map<string, number>();
    let duplicates = 0;
    for (const state of sampleStates) {
      const sig = `${foldTitle(state.listing.title)}|${state.latestPrice}`;
      signatures.set(sig, (signatures.get(sig) ?? 0) + 1);
      const partners = dupPairs.get(state.listing.id);
      if (partners && [...partners].some((p) => p < state.listing.id && ids.has(p))) duplicates += 1;
    }
    for (const count of signatures.values()) duplicates += count - 1;
    const proxies = sampleStates.map((s) => junkProxies(watch, s.assoc, s.listing));
    const ages = sampleStates.map((s) => (nowMs - s.latestAt) / DAY_MS);
    const stale30 = ages.filter((a) => a > 30).length;
    const unverified = sampleStates.filter((s) => s.assoc.relevance !== 'relevant').length;
    const med = bucket.stats.median;
    const cleanMed = clean.buckets.get(bucket.key)?.stats.median ?? null;
    const winMed = window30.buckets.get(bucket.key)?.stats.median ?? null;
    const mad = med ? median(bucket.prices.map((p) => Math.abs(p - med))) : null;
    const madRatio = med && mad !== null ? mad / med : null;
    if (bucket.key === OTHER_VARIANT_KEY && watch.groups.length && anchor) {
      for (const s of sampleStates) {
        otherWrongModel.n += 1;
        if (independentVariantClass(s.listing.title, anchor, watch.query) === 'missing') otherWrongModel.wrong += 1;
      }
    }
    const scored = bucket.prices.length >= 10;
    if (enabledIds.has(watch.id) && scored) {
      sampleAges.push(...ages);
      enabledSampleFlags.n += sampleStates.length;
      enabledSampleFlags.stale30 += stale30;
      enabledSampleFlags.flagged += proxies.filter((p) => p.flagged).length;
      enabledSampleFlags.hidden += proxies.filter((p) => p.hidden).length;
      enabledSampleFlags.rejected += proxies.filter((p) => p.rejected).length;
      enabledSampleFlags.junkTitle += proxies.filter((p) => p.junkTitle).length;
      enabledSampleFlags.unverified += unverified;
      enabledSampleFlags.duplicate += duplicates;
      if (med && cleanMed) cleanShifts.push(Math.abs(cleanMed / med - 1));
      if (med && winMed) windowShifts.push(Math.abs(winMed / med - 1));
      if (madRatio !== null) madRatios.push(madRatio);
    }
    baselineRows.push({
      watch: watch.name,
      on: watch.enabled,
      bucket: bucketName(watch, bucket.key),
      n: bucket.prices.length,
      ready: isReady(bucket.prices.length),
      median: round(med, 0),
      madPct: pct(madRatio),
      ageP50d: round(median(ages), 1),
      stale30Pct: pct(ratio(stale30, ages.length)),
      junkTitlePct: pct(ratio(proxies.filter((p) => p.junkTitle).length, proxies.length)),
      rejectedPct: pct(ratio(proxies.filter((p) => p.rejected).length, proxies.length)),
      unverifiedPct: pct(ratio(unverified, sampleStates.length)),
      dupPct: pct(ratio(duplicates, sampleStates.length)),
      cleanMedian: round(cleanMed, 0),
      window30Median: round(winMed, 0),
    });
  }
}
const ageDist = distribution(sampleAges);
bench.metric('scoring.baseline.sample_age_days.p50', 'Enabled watches: age of the price each baseline sample contributes, p50', ageDist.p50, 'days', 'info');
bench.metric('scoring.baseline.sample_age_days.p90', 'Enabled watches: baseline sample age p90', ageDist.p90, 'days', 'info');
bench.metric('scoring.baseline.stale30_share', 'Enabled watches: baseline samples last seen over 30 days ago (watchBaselines has no time window; gone listings are mostly sold ones)', ratio(enabledSampleFlags.stale30, enabledSampleFlags.n), 'share', 'info');
bench.metric('scoring.baseline.junk_title_share', 'Enabled watches: baseline samples with a junk title (broken, part, bundle, other model…)', ratio(enabledSampleFlags.junkTitle, enabledSampleFlags.n), 'share', 'lower');
bench.metric('scoring.baseline.flagged_share', 'Enabled watches: baseline samples carrying a stored quick flag', ratio(enabledSampleFlags.flagged, enabledSampleFlags.n), 'share', 'lower');
bench.metric('scoring.baseline.rejected_share', 'Enabled watches: baseline samples the description check rejected', ratio(enabledSampleFlags.rejected, enabledSampleFlags.n), 'share', 'lower');
bench.metric('scoring.baseline.unverified_relevance_share', 'Enabled watches: baseline samples the AI relevance check never marked relevant', ratio(enabledSampleFlags.unverified, enabledSampleFlags.n), 'share', 'info', 'the AI gate only checks listings strong enough to alert');
bench.metric('scoring.baseline.duplicate_share', 'Enabled watches: baseline samples that repeat another sample (same title+price, or a stored cross-source duplicate pair)', ratio(enabledSampleFlags.duplicate, enabledSampleFlags.n), 'share', 'lower');
bench.metric('scoring.baseline.clean_median_shift_abs.max', 'Enabled buckets: |median without junk-proxy samples / median − 1|, max', cleanShifts.length ? Math.max(...cleanShifts) : null, 'ratio', 'info');
bench.metric('scoring.baseline.window30_median_shift_abs.max', 'Enabled buckets: |median of last 30 days / all-history median − 1|, max', windowShifts.length ? Math.max(...windowShifts) : null, 'ratio', 'info');
bench.metric('scoring.baseline.mad_ratio.p50', 'Enabled buckets: MAD / median, p50 (spread a deal must beat)', median(madRatios), 'ratio', 'info');
bench.metric('scoring.baseline.other_wrong_model_share', 'Other buckets (watches with variant groups): samples that are not the watched model at all', ratio(otherWrongModel.wrong, otherWrongModel.n), 'share', 'lower', `n=${otherWrongModel.n}`);
bench.table('baselines_now', baselineRows);

// ------------------------------------------------------------ 2. inventory and stale labels

const inventoryRows: Array<Record<string, unknown>> = [];
let staleCompared = 0;
let staleOff = 0;
let outOfBoundsStrong = 0;
let staleStrong = 0;
const staleExamples: Array<Record<string, unknown>> = [];
for (const watch of watches) {
  const rows = [...(assocByWatch.get(watch.id)?.values() ?? [])];
  const withListing = rows.filter((a) => listings.has(a.listingId));
  for (const assoc of withListing) {
    const listing = listings.get(assoc.listingId)!;
    const outOfBounds = (watch.minPrice !== null && listing.price < watch.minPrice) || (watch.maxPrice !== null && listing.price > watch.maxPrice);
    if (outOfBounds && (assoc.strength ?? 0) >= 3) outOfBoundsStrong += 1;
    if (enabledIds.has(watch.id) && (assoc.strength ?? 0) >= 3 && assoc.typical !== null) {
      const now = bucketMedian.get(`${watch.id}|${assoc.variantKey ?? OTHER_VARIANT_KEY}`);
      if (now && Math.abs(assoc.typical / now - 1) > 0.25) staleStrong += 1;
    }
    if (!enabledIds.has(watch.id) || assoc.typical === null || nowMs - Date.parse(assoc.lastSeen) > 7 * DAY_MS) continue;
    const current = bucketMedian.get(`${watch.id}|${assoc.variantKey ?? OTHER_VARIANT_KEY}`);
    if (!current) continue;
    staleCompared += 1;
    if (Math.abs(assoc.typical / current - 1) > 0.1) {
      staleOff += 1;
      if (staleExamples.length < exampleCount) staleExamples.push({ watch: watch.name, title: listing.title.slice(0, 60), price: listing.price, storedTypical: assoc.typical, currentTypical: current, label: assoc.label, lastSeen: assoc.lastSeen.slice(0, 10) });
    }
  }
  inventoryRows.push({
    watch: watch.name,
    on: watch.enabled,
    listings: withListing.length,
    noTypicalPct: pct(ratio(withListing.filter((a) => a.typical === null).length, withListing.length)),
    otherPct: watch.groups.length ? pct(ratio(withListing.filter((a) => (a.variantKey ?? OTHER_VARIANT_KEY) === OTHER_VARIANT_KEY).length, withListing.length)) : null,
    jevVariantPct: pct(ratio(withListing.filter((a) => a.variantSource === 'jev').length, withListing.length)),
    strongPlus: withListing.filter((a) => (a.strength ?? 0) >= 3).length,
    exceptional: withListing.filter((a) => a.strength === 5).length,
    qualifiesNow: withListing.filter((a) => a.qualifies === 1).length,
  });
}
bench.metric('scoring.inventory.watch_listings', 'Watch–listing associations', assocs.length, 'count', 'info');
bench.metric('scoring.inventory.strong_plus_out_of_bounds', 'Associations still labelled Strong+ whose price is outside the watch\'s current price bounds (scored before the bounds were set)', outOfBoundsStrong, 'count', 'lower');
bench.metric('scoring.inventory.strong_plus_stale_typical', 'Enabled watches: Strong+ rows (any age) whose stored typical is over 25% from the bucket median now — e.g. i5 rows priced against whole PCs before the bounds; Listings sorted by deal still shows them', staleStrong, 'count', 'lower');
bench.metric('scoring.inventory.stored_typical_off_10pct_share', 'Enabled watches, seen in the last 7 days: stored typical more than 10% from the bucket median now', ratio(staleOff, staleCompared), 'share', 'lower', `n=${staleCompared}; typical is written when a listing is stored and not refreshed`);
bench.table('inventory_by_watch', inventoryRows);
bench.table('stale_typical_examples', staleExamples);

// ------------------------------------------------------------ 3. stability of the stored typical

const daily = new Map<string, Map<string, number[]>>();
for (const watch of watches) {
  const assocMap = assocByWatch.get(watch.id) ?? new Map();
  for (const obs of observations.get(watch.id) ?? []) {
    if (obs.baseline === null) continue;
    const key = `${watch.name}|${bucketName(watch, assocMap.get(obs.listingId)?.variantKey ?? OTHER_VARIANT_KEY)}`;
    const day = new Date(obs.at).toISOString().slice(0, 10);
    let days = daily.get(key);
    if (!days) daily.set(key, (days = new Map()));
    let values = days.get(day);
    if (!values) days.set(day, (values = []));
    values.push(obs.baseline);
  }
}
const changesRecent: number[] = [];
const changesEarly: number[] = [];
const bigJumps: Array<Record<string, unknown>> = [];
const weekly: Array<Record<string, unknown>> = [];
const mondayOf = (day: string) => {
  const d = new Date(day);
  return new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * DAY_MS).toISOString().slice(0, 10);
};
const lastWeeks = [...new Set([...daily.values()].flatMap((days) => [...days.keys()].map(mondayOf)))].sort().slice(-8);
for (const [key, days] of daily) {
  const sorted = [...days.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, values]) => ({ day, typical: median(values)!, n: values.length }));
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    if (Date.parse(cur.day) - Date.parse(prev.day) > 2 * DAY_MS || prev.n < 3 || cur.n < 3) continue;
    const change = Math.abs(cur.typical / prev.typical - 1);
    (cur.day >= '2026-10-01' ? changesRecent : changesEarly).push(change);
    if (change >= 0.1) bigJumps.push({ bucket: key, from: prev.day, to: cur.day, before: round(prev.typical, 0), after: round(cur.typical, 0), changePct: pct(cur.typical / prev.typical - 1) });
  }
  const weeks = new Map<string, number[]>();
  for (const row of sorted) {
    const monday = mondayOf(row.day);
    let values = weeks.get(monday);
    if (!values) weeks.set(monday, (values = []));
    values.push(row.typical);
  }
  const row: Record<string, unknown> = { bucket: key };
  for (const week of lastWeeks) row[week.slice(5)] = weeks.has(week) ? round(median(weeks.get(week)!), 0) : null;
  if (lastWeeks.some((week) => weeks.has(week))) weekly.push(row);
}
const recentDist = distribution(changesRecent);
bench.metric('scoring.stability.daily_typical_change.p50', 'Day-over-day change of the stored typical per bucket since 2026-10-01, p50', recentDist.p50, 'ratio', 'lower', `n=${recentDist.n}`);
bench.metric('scoring.stability.daily_typical_change.p95', 'Day-over-day change of the stored typical since 2026-10-01, p95', recentDist.p95, 'ratio', 'lower');
bench.metric('scoring.stability.daily_typical_change.max', 'Day-over-day change of the stored typical since 2026-10-01, max', recentDist.max, 'ratio', 'lower');
bench.metric('scoring.stability.daily_typical_change_before_oct.p95', 'Same before 2026-10-01 (config and code were still changing)', distribution(changesEarly).p95, 'ratio', 'info');
bench.table('typical_jumps_10pct', bigJumps.sort((a, b) => Math.abs(Number(b.changePct)) - Math.abs(Number(a.changePct))).slice(0, 25));
bench.table('typical_by_week', weekly);

// ------------------------------------------------------------ 4. variant accuracy

interface VariantCheck { watch: WatchCfg; title: string; price: number; cls: string; rule: string; stored: string; expected: string | null; source: string | null }
const checks: VariantCheck[] = [];
for (const watch of watches) {
  const anchor = modelAnchor(watch.query);
  if (!watch.groups.length || !anchor) continue;
  const classMap = groupClassMap(watch);
  for (const assoc of assocByWatch.get(watch.id)?.values() ?? []) {
    const listing = listings.get(assoc.listingId);
    if (!listing) continue;
    const cls = independentVariantClass(listing.title, anchor, watch.query);
    const expected = cls === 'missing' || cls === 'multi' ? null : classMap.get(cls) ?? OTHER_VARIANT_KEY;
    checks.push({ watch, title: listing.title, price: listing.price, cls, rule: assignVariant(listing.title, watch.groups), stored: assoc.variantKey ?? OTHER_VARIANT_KEY, expected, source: assoc.variantSource });
  }
}
type Kind = 'agree' | 'cross_variant' | 'missed_to_other' | 'named_wrong_class' | 'wrong_model_in_named' | 'multi_model_in_named' | 'unclassified_other';
const kindOf = (c: VariantCheck): Kind => {
  if (c.expected === null) {
    if (c.rule === OTHER_VARIANT_KEY) return 'unclassified_other';
    return c.cls === 'multi' ? 'multi_model_in_named' : 'wrong_model_in_named';
  }
  if (c.rule === c.expected) return 'agree';
  if (c.rule === OTHER_VARIANT_KEY) return 'missed_to_other';
  if (c.expected === OTHER_VARIANT_KEY) return 'named_wrong_class';
  return 'cross_variant';
};
const live = checks.filter((c) => enabledIds.has(c.watch.id));
const classifiable = live.filter((c) => c.expected !== null);
const inNamed = live.filter((c) => c.rule !== OTHER_VARIANT_KEY);
const count = (rows: VariantCheck[], kind: Kind) => rows.filter((c) => kindOf(c) === kind).length;
bench.metric('scoring.variant.rule_disagree_share', 'Enabled watches: titles where the variant rule and an independent model parse disagree', ratio(classifiable.length - count(classifiable, 'agree'), classifiable.length), 'share', 'lower', `n=${classifiable.length}`);
bench.metric('scoring.variant.cross_variant_share', 'Enabled watches: titles priced against the wrong named variant (e.g. a Super in the plain bucket)', ratio(count(classifiable, 'cross_variant') + count(classifiable, 'named_wrong_class'), classifiable.length), 'share', 'lower');
bench.metric('scoring.variant.missed_to_other_share', 'Enabled watches: titles of a named variant that fall into Other (glued "rtx2060", no "rtx", "12400 f")', ratio(count(classifiable, 'missed_to_other'), classifiable.length), 'share', 'lower');
bench.metric('scoring.variant.wrong_model_in_named_share', 'Enabled watches: titles in a named bucket that never name the watched model', ratio(count(inNamed, 'wrong_model_in_named'), inNamed.length), 'share', 'lower');
bench.metric('scoring.variant.multi_model_in_named_share', 'Enabled watches: titles in a named bucket that list several GPU models', ratio(count(inNamed, 'multi_model_in_named'), inNamed.length), 'share', 'lower');
bench.metric('scoring.variant.stored_differs_from_rule_share', 'Enabled watches: stored variant differs from what the rule gives today (old rules or Jev overrides)', ratio(live.filter((c) => c.stored !== c.rule).length, live.length), 'share', 'info');
const variantSummary: Array<Record<string, unknown>> = [];
for (const watch of watches.filter((w) => w.groups.length)) {
  const rows = checks.filter((c) => c.watch.id === watch.id);
  const kinds = ['cross_variant', 'named_wrong_class', 'missed_to_other', 'wrong_model_in_named', 'multi_model_in_named'] as Kind[];
  const row: Record<string, unknown> = { watch: watch.name, on: watch.enabled, n: rows.length, agreePct: pct(ratio(count(rows, 'agree'), rows.filter((c) => c.expected !== null).length)) };
  for (const kind of kinds) row[kind] = count(rows, kind);
  // Price evidence: mismatched titles' prices relative to the bucket they are in vs the bucket they belong to.
  const mismatched = rows.filter((c) => ['cross_variant', 'named_wrong_class', 'missed_to_other'].includes(kindOf(c)));
  const toRule = mismatched.map((c) => c.price / (bucketMedian.get(`${watch.id}|${c.rule}`) ?? NaN)).filter(Number.isFinite);
  const toExpected = mismatched.map((c) => c.price / (bucketMedian.get(`${watch.id}|${c.expected}`) ?? NaN)).filter(Number.isFinite);
  row.priceVsRuleBucketP50 = round(median(toRule), 2);
  row.priceVsTrueBucketP50 = round(median(toExpected), 2);
  variantSummary.push(row);
}
bench.table('variant_accuracy_by_watch', variantSummary);
const variantExamples: Array<Record<string, unknown>> = [];
for (const kind of ['cross_variant', 'named_wrong_class', 'missed_to_other', 'wrong_model_in_named', 'multi_model_in_named'] as Kind[]) {
  for (const c of checks.filter((x) => kindOf(x) === kind && enabledIds.has(x.watch.id)).slice(0, Math.ceil(exampleCount / 2))) {
    variantExamples.push({ kind, watch: c.watch.name, title: c.title.slice(0, 64), price: c.price, rule: bucketName(c.watch, c.rule), parsed: c.cls || 'plain' });
  }
}
bench.table('variant_mismatch_examples', variantExamples);

// ------------------------------------------------------------ 5. exclusions and flags

const DAMAGED_CONDITION = /uszkodz|damaged|na cz[eę][sś]ci|for parts|nie dzia/i;
const exclusionRows: Array<Record<string, unknown>> = [];
const exclusionExamples: Array<Record<string, unknown>> = [];
let brokenTotal = 0;
let brokenKept = 0;
let brokenKeptStrong = 0;
let damagedConditionKept = 0;
let brokenUnflagged = 0;
for (const watch of watches) {
  const { excluded } = parseIncludedExcluded(watch.query, String(watch.raw.included_terms ?? ''), watch.excludedTerms);
  let broken = 0;
  let kept = 0;
  let keptStrong = 0;
  let condition = 0;
  for (const assoc of assocByWatch.get(watch.id)?.values() ?? []) {
    const listing = listings.get(assoc.listingId);
    if (!listing) continue;
    // As the watch filter decides it now (evaluateDeterministic): excluded terms and their inflections, on the title and the condition label.
    const title = normalizeFilterText(listing.title);
    const conditionText = normalizeFilterText(listing.condition ?? '');
    const excludedHit = excluded.some((term) => excludedTermMatches(title, title.replace(/ /g, ''), term) || (conditionText !== '' && excludedTermMatches(conditionText, conditionText.replace(/ /g, ''), term)));
    const isBroken = junkKinds(listing.title, watch.query).includes('broken');
    if (isBroken) {
      broken += 1;
      if (!listing.flags.some((f) => f === 'damaged' || f === 'for_parts')) brokenUnflagged += 1;
      if (!excludedHit) {
        kept += 1;
        if ((assoc.strength ?? 0) >= 3) keptStrong += 1;
        if (exclusionExamples.length < exampleCount) exclusionExamples.push({ watch: watch.name, excluded: excluded.join(','), title: listing.title.slice(0, 64), condition: listing.condition, price: listing.price, label: assoc.label, flags: listing.flags.join(',') });
      }
    }
    if (listing.condition && DAMAGED_CONDITION.test(listing.condition) && !excludedHit) condition += 1;
  }
  brokenTotal += broken;
  brokenKept += kept;
  brokenKeptStrong += keptStrong;
  damagedConditionKept += condition;
  exclusionRows.push({ watch: watch.name, excluded: excluded.join(',') || '—', brokenTitles: broken, notExcluded: kept, notExcludedStrongPlus: keptStrong, damagedCondition: condition });
}
bench.metric('scoring.exclusion.broken_title_kept', 'Watch listings with a broken/for-parts title that the watch\'s excluded terms let through ("uszkodzone" misses "uszkodzona", "niesprawna", …)', brokenKept, 'count', 'lower', `of ${brokenTotal} broken titles`);
bench.metric('scoring.exclusion.broken_title_kept_strong_plus', 'Of those, labelled Strong+ (they look like deals because they are broken)', brokenKeptStrong, 'count', 'lower');
bench.metric('scoring.exclusion.damaged_condition_kept', 'Watch listings whose marketplace condition says damaged/for parts that the watch\'s excluded terms let through (watches without exclusions count too)', damagedConditionKept, 'count', 'lower');
bench.metric('scoring.flags.broken_title_unflagged_share', 'Broken-title watch listings without a damaged/for_parts quick flag', ratio(brokenUnflagged, brokenTotal), 'share', 'lower', `n=${brokenTotal}`);
bench.table('exclusions_by_watch', exclusionRows);
bench.table('exclusion_misses', exclusionExamples);

// ------------------------------------------------------------ 6. Strong+ feed quality

const feedRows: Array<Record<string, unknown>> = [];
const feed = { strong: 0, visible: 0, residual: 0, unchecked: 0, recentVisible: 0, recentResidual: 0 };
const tierRows = new Map<number, { n: number; any: number; irrelevant: number; rejected: number; hidden: number; title: number }>();
const residualExamples: Array<Record<string, unknown>> = [];
for (const watch of watches) {
  for (const assoc of assocByWatch.get(watch.id)?.values() ?? []) {
    const listing = listings.get(assoc.listingId);
    if (!listing || (assoc.strength ?? 0) < 3) continue;
    const proxies = junkProxies(watch, assoc, listing);
    const tier = tierRows.get(assoc.strength!) ?? { n: 0, any: 0, irrelevant: 0, rejected: 0, hidden: 0, title: 0 };
    tier.n += 1;
    tier.any += Number(proxies.any);
    tier.irrelevant += Number(proxies.irrelevant);
    tier.rejected += Number(proxies.rejected);
    tier.hidden += Number(proxies.hidden);
    tier.title += Number(proxies.junkTitle);
    tierRows.set(assoc.strength!, tier);
    if (!enabledIds.has(watch.id)) continue;
    feed.strong += 1;
    // Deals → Top deals and scout_deals leave out hidden/passed, AI-irrelevant and description-rejected rows.
    if (proxies.hidden || proxies.irrelevant || proxies.rejected) continue;
    feed.visible += 1;
    const residual = proxies.flagged || proxies.junkTitle;
    if (residual) {
      feed.residual += 1;
      if (residualExamples.length < exampleCount) residualExamples.push({ watch: watch.name, title: listing.title.slice(0, 64), price: listing.price, typical: assoc.typical, strength: assoc.strength, kinds: junkKinds(listing.title, watch.query).join('+'), flags: listing.flags.join(',') });
    }
    if (assoc.relevance !== 'relevant' && listing.verification !== 'pass') feed.unchecked += 1;
    if (nowMs - Date.parse(assoc.lastSeen) <= 30 * DAY_MS) {
      feed.recentVisible += 1;
      if (residual) feed.recentResidual += 1;
    }
  }
}
for (const [tier, row] of [...tierRows.entries()].sort(([a], [b]) => b - a)) {
  feedRows.push({ tier, n: row.n, junkAnyPct: pct(ratio(row.any, row.n)), irrelevantPct: pct(ratio(row.irrelevant, row.n)), rejectedPct: pct(ratio(row.rejected, row.n)), hiddenPct: pct(ratio(row.hidden, row.n)), junkTitlePct: pct(ratio(row.title, row.n)) });
}
bench.metric('scoring.feed.strong_plus_residual_junk_share', 'Enabled watches: Strong+ rows the deals feed shows (not hidden, irrelevant or rejected) that are flagged or junk-titled', ratio(feed.residual, feed.visible), 'share', 'lower', `n=${feed.visible}`);
bench.metric('scoring.feed.strong_plus_residual_junk_share_30d', 'Same, seen in the last 30 days', ratio(feed.recentResidual, feed.recentVisible), 'share', 'lower', `n=${feed.recentVisible}`);
bench.metric('scoring.feed.strong_plus_unchecked_share', 'Enabled watches: feed-visible Strong+ rows neither AI-relevant nor description-passed', ratio(feed.unchecked, feed.visible), 'share', 'lower');
bench.table('stored_tiers_junk', feedRows);
bench.table('feed_residual_junk_examples', residualExamples);

// Description check: rejects with no stated reason cannot be reviewed by the operator.
const rejectRows = db.prepare(`SELECT w.name watch, COUNT(*) n,
    SUM(COALESCE(json_array_length(json_extract(l.ai_description_verification_json, '$.issues')), 0) = 0) no_issue,
    SUM(LOWER(COALESCE(json_extract(l.ai_description_verification_json, '$.issues'), '')) LIKE '%battery%') battery
  FROM listings l JOIN watch_listings wl ON wl.listing_id = l.id JOIN watches w ON w.id = wl.watch_id
  WHERE l.ai_description_verification_status = 'reject' GROUP BY w.name ORDER BY n DESC`).all() as Array<{ watch: string; n: number; no_issue: number; battery: number }>;
const rejectTotal = rejectRows.reduce((s, r) => s + r.n, 0);
bench.metric('scoring.verification.reject_without_issue_share', 'Description-check rejects that list no issue (opaque "Jev verification reject.")', ratio(rejectRows.reduce((s, r) => s + r.no_issue, 0), rejectTotal), 'share', 'lower', `n=${rejectTotal}`);
bench.table('description_rejects_by_watch', rejectRows);

// ------------------------------------------------------------ 7. sent alerts

interface Sent { watchId: string; key: string; price: number; typical: number; marketplace: string; priority: string; estimatedNet: number | null; at: string }
const sent = new Map<string, Sent>();
for (const row of db.prepare("SELECT payload_json p, created_at at FROM notifications WHERE status = 'delivered' ORDER BY id").all() as Array<{ p: string; at: string }>) {
  try {
    const scout = JSON.parse(row.p)?._scout;
    const listing = scout?.listing;
    if (!scout?.watchId || !listing?.marketplace || !listing?.listingId || !(scout.typical > 0)) continue;
    const key = `${scout.watchId}|${listing.marketplace}:${listing.listingId}`;
    if (!sent.has(key)) sent.set(key, { watchId: scout.watchId, key: `${listing.marketplace}:${listing.listingId}`, price: Number(listing.price), typical: Number(scout.typical), marketplace: listing.marketplace, priority: String(scout.priority ?? ''), estimatedNet: typeof scout.estimatedNet === 'number' ? scout.estimatedNet : null, at: row.at });
  } catch { /* not a deal payload */ }
}
const listingByKey = new Map([...listings.values()].map((l) => [l.key, l]));
const sentRows = [...sent.values()].map((s) => {
  const watch = watches.find((w) => w.id === s.watchId);
  const listing = listingByKey.get(s.key);
  const assoc = listing ? assocByWatch.get(s.watchId)?.get(listing.id) : undefined;
  return { s, watch, listing, assoc, proxies: watch && listing && assoc ? junkProxies(watch, assoc, listing) : null };
});
const known = sentRows.filter((r) => r.proxies);
bench.metric('scoring.alerts.sent', 'Distinct (watch, listing) deal alerts delivered', sent.size, 'count', 'info');
bench.metric('scoring.alerts.residual_junk_share', 'Delivered alerts that are now flagged, hidden, description-rejected or junk-titled', ratio(known.filter((r) => r.proxies!.flagged || r.proxies!.hidden || r.proxies!.rejected || r.proxies!.junkTitle).length, known.length), 'share', 'lower', `n=${known.length}`);
const recentSent = known.filter((r) => r.s.at >= '2026-10-01');
bench.metric('scoring.alerts.residual_junk_share_since_oct', 'Same, alerts sent since 2026-10-01 (after the relevance and description gates settled)', ratio(recentSent.filter((r) => r.proxies!.flagged || r.proxies!.hidden || r.proxies!.rejected || r.proxies!.junkTitle).length, recentSent.length), 'share', 'lower', `n=${recentSent.length}`);
bench.metric('scoring.alerts.hidden_share', 'Delivered alerts the operator later hid or passed', ratio(known.filter((r) => r.proxies!.hidden).length, known.length), 'share', 'info');
bench.metric('scoring.alerts.irrelevant_share', 'Delivered alerts now marked AI-irrelevant (sent before the relevance gate caught them)', ratio(known.filter((r) => r.proxies!.irrelevant).length, known.length), 'share', 'lower');
bench.table('alerts_by_watch', watches.map((watch) => {
  const rows = known.filter((r) => r.watch?.id === watch.id);
  return {
    watch: watch.name,
    sent: rows.length,
    hiddenPct: pct(ratio(rows.filter((r) => r.proxies!.hidden).length, rows.length)),
    irrelevantPct: pct(ratio(rows.filter((r) => r.proxies!.irrelevant).length, rows.length)),
    rejectedPct: pct(ratio(rows.filter((r) => r.proxies!.rejected).length, rows.length)),
    junkTitlePct: pct(ratio(rows.filter((r) => r.proxies!.junkTitle).length, rows.length)),
  };
}).filter((row) => row.sent > 0));

// ------------------------------------------------------------ 8. flips: Scout's estimated net against the ledger

let feePresets: FeePresets = DEFAULT_FEE_PRESETS;
try {
  const settings = JSON.parse(exportInfo(db, 'settings') ?? '{}');
  feePresets = normalizeFeePresets(settings.feePresets);
} catch { /* defaults */ }
const presetFor = (channel: string) => (isFlipChannel(channel) ? feePresets[channel] : feePresets.Other);

interface FlipRow { id: number; title: string; listing_key: string | null; watch_id: string | null; buy_channel: string; bought_on: string; buy_price_pln: number; buy_costs_pln: number | null; sold_on: string | null; sale_channel: string | null; sale_price_pln: number | null; sale_fee_pln: number | null; sale_costs_pln: number | null }
const flips = db.prepare('SELECT * FROM flips ORDER BY bought_on').all() as unknown as FlipRow[];
// The resale basis reads the operator's sold flips (server/resale.ts); each
// flip is estimated from the others sold before it was bought.
const soldFlips = flips.filter((f) => f.sold_on && Number(f.sale_price_pln) > 0).map((f) => ({ id: f.id, flip: { title: f.title, watchId: f.watch_id, soldOn: f.sold_on!, salePrice: Number(f.sale_price_pln) } satisfies SoldFlip }));
const resaleWatch = (w: (typeof watches)[number]): ResaleWatch => ({ id: w.id, query: w.query, includedTerms: String(w.raw.included_terms ?? ''), excludedTerms: w.excludedTerms, groups: w.groups });
const ownSalesAt = (watch: (typeof watches)[number], variantKey: string | null, asOf: number, exceptFlip?: number) =>
  ownSalesFor(soldFlips.filter((o) => o.id !== exceptFlip).map((o) => o.flip), resaleWatch(watch), watch.groups.length ? variantKey : null, asOf);
const linkedBands = watches.filter((w) => w.referenceMarketWatchId).length;
bench.note(`Resale basis: ${linkedBands} watch(es) link a research band${linkedBands ? '; the bench does not replay bands, so their estimates use own sales or the haircut' : ', so the sale-band tier has no evidence here'}.`);
const flipRows: Array<Record<string, unknown>> = [];
const saleToTypical: number[] = [];
const overstatement: number[] = [];
const atTypicalOverstatement: number[] = [];
const buyDiscounts: number[] = [];
const buyCosts: number[] = [];
for (const flip of flips) {
  buyCosts.push(Number(flip.buy_costs_pln ?? 0));
  const candidates = watches.filter((w) => {
    const anchor = modelAnchor(w.query);
    return w.id === flip.watch_id || (anchor && !['missing', 'multi'].includes(independentVariantClass(flip.title, anchor, w.query)) && foldTitle(flip.title).includes(anchor));
  });
  const watch = candidates.find((w) => w.id === flip.watch_id) ?? candidates[0];
  let typical: number | null = null;
  let basis = '';
  let resale: { net: number; basis: ResaleBasis } | null = null;
  if (watch) {
    const assocMap = assocByWatch.get(watch.id) ?? new Map();
    const boughtMs = Date.parse(`${flip.bought_on}T23:59:59Z`);
    const listing = flip.listing_key ? listingByKey.get(flip.listing_key) : undefined;
    const variantKey = (listing ? assocMap.get(listing.id)?.variantKey : undefined) ?? assignVariant(flip.title, watch.groups);
    const own = listing ? (observations.get(watch.id) ?? []).filter((o) => o.listingId === listing.id && o.at <= boughtMs && o.baseline !== null) : [];
    if (own.length) {
      typical = own[own.length - 1].baseline;
      basis = 'listing';
    } else {
      // The bucket's stored typical over the three days up to the purchase.
      const key = assignVariant(flip.title, watch.groups);
      const values = (observations.get(watch.id) ?? []).filter((o) => o.baseline !== null && o.at <= boughtMs && o.at > boughtMs - 3 * DAY_MS && (assocMap.get(o.listingId)?.variantKey ?? OTHER_VARIANT_KEY) === key).map((o) => o.baseline!);
      typical = median(values);
      basis = values.length ? `bucket ${bucketName(watch, key)} (${values.length} obs)` : '';
      if (typical === null) {
        // Watch not scanning then: the bucket median at the end of the export.
        typical = bucketMedian.get(`${watch.id}|${key}`) ?? null;
        basis = typical === null ? '' : `bucket ${bucketName(watch, key)} at export`;
      }
    }
    // What Scout shows now: the resale basis on the buy marketplace, after its buying costs and seller fee.
    if (typical !== null) resale = estimateResaleNet(flip.buy_price_pln, typical, presetFor(flip.buy_channel), { ownSales: ownSalesAt(watch, variantKey, boughtMs, flip.id) });
  }
  const realized = flip.sale_price_pln === null ? null : flipNet({ buyPrice: flip.buy_price_pln, buyCosts: Number(flip.buy_costs_pln ?? 0), salePrice: flip.sale_price_pln, saleFee: flip.sale_fee_pln, saleCosts: flip.sale_costs_pln });
  // What Scout showed before the resale basis: resale at typical after the seller fee, buy costs ignored.
  const atTypical = typical === null ? null : estimatedNetAtTypical(flip.buy_price_pln, typical, presetFor(flip.buy_channel));
  const estimated = resale?.net ?? null;
  if (typical !== null && flip.sale_price_pln !== null) saleToTypical.push(flip.sale_price_pln / typical);
  if (typical !== null) buyDiscounts.push(1 - flip.buy_price_pln / typical);
  if (estimated !== null && realized !== null) overstatement.push(estimated - realized);
  if (atTypical !== null && realized !== null) atTypicalOverstatement.push(atTypical - realized);
  flipRows.push({ id: flip.id, title: flip.title.slice(0, 40), watch: watch?.name ?? '—', basis: basis || '—', buy: flip.buy_price_pln, buyCosts: flip.buy_costs_pln, typical: round(typical, 0), sale: flip.sale_price_pln, saleFee: flip.sale_fee_pln, estNetAtTypical: atTypical, resaleBasis: resale ? `${resale.basis.resalePrice} (${resale.basis.label}), buying ${resale.basis.buyCosts}` : null, estNet: estimated, realizedNet: realized, saleToTypical: typical && flip.sale_price_pln ? round(flip.sale_price_pln / typical, 3) : null });
}
const saleRatio = median(saleToTypical);
bench.metric('scoring.flips.matched', 'Flips with a typical price at purchase', saleToTypical.length, 'count', 'info', `of ${flips.length}; flips without a watch (RAM) have none`);
bench.metric('scoring.flips.sale_to_typical.p50', 'Realised sale price / typical asking price at purchase, p50', saleRatio, 'ratio', 'info', 'tiny n; asking prices overstate sales');
bench.metric('scoring.flips.buy_discount_vs_typical.p50', 'Buy price below typical at purchase, p50', median(buyDiscounts), 'ratio', 'info');
bench.metric('scoring.flips.estimated_net_overstatement_pln.p50', 'Scout\'s estimated net (resale basis, buying costs) minus the realised net, p50', median(overstatement), 'PLN', 'info', `n=${overstatement.length}; signed, see abs_error`);
bench.metric('scoring.flips.estimated_net_abs_error_pln.p50', 'Scout\'s estimated net minus the realised net, absolute, p50', median(overstatement.map(Math.abs)), 'PLN', 'lower', `n=${overstatement.length}`);
bench.metric('scoring.flips.net_at_typical_overstatement_pln.p50', 'The old "net at typical" (no haircut, no buying costs) minus the realised net, p50', median(atTypicalOverstatement), 'PLN', 'info', `n=${atTypicalOverstatement.length}`);
bench.table('flips', flipRows);

// What sent alerts would net if items resold at the flips' realised share of typical, paying the flips' median buy costs.
const buyCost = median(buyCosts) ?? 0;
const estNets: number[] = [];
const basisNets: number[] = [];
const haircutNets: number[] = [];
for (const { s, watch, assoc } of sentRows) {
  const preset = presetFor(s.marketplace);
  const est = estimatedNetAtTypical(s.price, s.typical, preset);
  if (est !== null) estNets.push(est);
  const ownSales = watch ? ownSalesAt(watch, assoc?.variantKey ?? null, Date.parse(s.at)) : [];
  const now = estimateResaleNet(s.price, s.typical, preset, { ownSales });
  if (now) basisNets.push(now.net);
  if (saleRatio !== null) {
    const resale = saleRatio * s.typical;
    haircutNets.push(resale - saleFee(resale, preset) - buyCost - s.price);
  }
}
bench.metric('scoring.econ.alert_net_at_typical.p50', 'Delivered alerts: the old net at typical, p50', median(estNets), 'PLN', 'info', `n=${estNets.length}`);
bench.metric('scoring.econ.alert_net_at_basis.p50', 'Delivered alerts: Scout\'s estimated net now (resale basis, buying costs), p50', median(basisNets), 'PLN', 'info', `n=${basisNets.length}`);
bench.metric('scoring.econ.alert_net_ge_30_at_basis_share', 'Delivered alerts Scout now estimates at ≥ 30 zł net', ratio(basisNets.filter((n) => n >= 30).length, basisNets.length), 'share', 'info');
bench.metric('scoring.econ.alert_net_at_realised.p50', 'Delivered alerts: net if resold at the flips\' sale/typical ratio with their median buy costs, p50', median(haircutNets), 'PLN', 'higher', `ratio ${round(saleRatio, 3)}, buy costs ${buyCost} zł`);
bench.metric('scoring.econ.alert_net_ge_30_at_typical_share', 'Delivered alerts netting ≥ 30 zł at typical', ratio(estNets.filter((n) => n >= 30).length, estNets.length), 'share', 'info');
bench.metric('scoring.econ.alert_net_ge_30_at_realised_share', 'Delivered alerts netting ≥ 30 zł at the realised ratio', ratio(haircutNets.filter((n) => n >= 30).length, haircutNets.length), 'share', 'higher');
// Discount needed for a 30 zł net at the realised ratio, per enabled bucket, vs the 18–20% alert threshold.
const thresholdRows: Array<Record<string, unknown>> = [];
if (saleRatio !== null) {
  for (const view of bucketViews.filter((v) => enabledIds.has(v.watch.id) && v.median && v.states.length >= 10)) {
    const t = view.median!;
    for (const channel of ['OLX', 'Vinted', 'Allegro Lokalnie'] as const) {
      const resale = saleRatio * t;
      const maxBuy = resale - saleFee(resale, feePresets[channel]) - buyCost - 30;
      thresholdRows.push({ watch: view.watch.name, bucket: bucketName(view.watch, view.key), typical: round(t, 0), channel, maxBuyFor30: round(maxBuy, 0), neededDiscountPct: pct(1 - maxBuy / t) });
    }
  }
}
const needed = thresholdRows.filter((r) => r.channel === 'OLX').map((r) => Number(r.neededDiscountPct) / 100);
bench.metric('scoring.econ.needed_discount_for_30pln.p50', 'Enabled buckets: discount below typical needed to net 30 zł at the realised ratio (alerts start at 18–20%)', median(needed), 'ratio', 'info');
bench.table('needed_discount_by_bucket', thresholdRows);

// ------------------------------------------------------------ 9. research watch: asking vs ended

const research = db.prepare(`SELECT ml.title, ml.first_price_pln first, ml.last_price_pln last, ml.lowest_price_pln lowest, ml.status, ml.ended_reason reason, mw.name watch, mw.query query
  FROM market_listings ml JOIN market_watches mw ON mw.id = ml.market_watch_id WHERE ml.last_price_pln > 0`).all() as Array<{ title: string; first: number; last: number; lowest: number; status: string; reason: string | null; watch: string; query: string }>;
const researchRows: Array<Record<string, unknown>> = [];
const endedRatios: number[] = [];
for (const name of [...new Set(research.map((r) => r.watch))]) {
  const rows = research.filter((r) => r.watch === name);
  const anchor = modelAnchor(rows[0].query) ?? '';
  const byClass = new Map<string, typeof rows>();
  for (const row of rows) {
    const cls = anchor ? independentVariantClass(row.title, anchor, rows[0].query) : '';
    if (cls === 'missing' || cls === 'multi' || junkKinds(row.title, rows[0].query).length) continue;
    let list = byClass.get(cls);
    if (!list) byClass.set(cls, (list = []));
    list.push(row);
  }
  for (const [cls, list] of byClass) {
    // Explicitly unavailable or 404/410 after being seen: sold, reserved or withdrawn.
    const ended = list.filter((r) => r.status === 'ended' && r.reason && !/blocked|session/i.test(r.reason));
    const active = list.filter((r) => r.status === 'active');
    if (active.length < 10) continue;
    const activeMedian = median(active.map((r) => r.last));
    const endedMedian = median(ended.map((r) => r.last));
    if (ended.length >= 10 && activeMedian && endedMedian) endedRatios.push(endedMedian / activeMedian);
    const dealWatch = watches.find((w) => modelAnchor(w.query) === anchor && w.groups.length);
    const dealKey = dealWatch ? groupClassMap(dealWatch).get(cls) : undefined;
    researchRows.push({
      watch: name,
      variant: cls || 'plain',
      dealWatchTypical: dealWatch && dealKey ? round(bucketMedian.get(`${dealWatch.id}|${dealKey}`), 0) : null,
      active: active.length,
      activeMedian: round(activeMedian, 0),
      ended: ended.length,
      endedMedian: round(endedMedian, 0),
      endedToActive: activeMedian && endedMedian ? round(endedMedian / activeMedian, 3) : null,
      priceCutPct: pct(ratio(list.filter((r) => r.last < r.first).length, list.length)),
    });
  }
}
bench.metric('scoring.research.ended_to_active_median.p50', 'Research watches: median last price of ended listings / of active ones, per variant, p50 (a crude "what sells" signal)', median(endedRatios), 'ratio', 'info', `variants with ≥10 ended: ${endedRatios.length}`);
bench.table('research_asking_vs_ended', researchRows);

bench.metric('scoring.runtime_ms', 'Benchmark wall time', Date.now() - started, 'ms', 'info');
bench.finish();
