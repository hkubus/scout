/**
 * Offline replay of Scout's deal scoring over the real history in an
 * improvement export.
 *
 *   node --import tsx scripts/bench/scoring-replay.ts <export.sqlite> [--json=out.json]
 *        [--scenarios=current,no_flag_hidden,...] [--no-service] [--future-days=14] [--examples=15]
 *
 * For every listing a watch matched, the decision that matters is the one at
 * its first sighting (that is when a deal alerts). The replay sweeps each
 * watch's observations in time order and, at the start of every scan that
 * found new listings, rebuilds the per-variant baselines from what was known
 * then (scripts/bench/scoring-data.ts mirrors ScoutService.watchBaselines)
 * and scores the new listings with the repo's own scoreDealFromStats and
 * dealStrength. Change server/scoring.ts and rerun to see the effect; change
 * the baseline query in server/service.ts and the "mirror" check below
 * flags that this harness needs the same change.
 *
 * Outcome proxies (there are no sale prices except a handful of flips):
 * - junk: stored quick flag, hidden or passed by the user, AI-irrelevant, or
 *   an independent junk-title heuristic;
 * - future market: median first-sighting asking price of clean listings in
 *   the same watch and variant over the following --future-days; asking
 *   prices, not sales;
 * - fast gone: the listing stopped appearing within 48 h while the watch kept
 *   scanning (sold, reserved or withdrawn; can also be a retitle).
 *
 * Approximations, all reported: current watch config (price bounds, variant
 * groups, stored variant per listing) and current AI verdicts are applied to
 * the whole history; same-price observation runs are collapsed by the
 * service, which can shift the newest-400 cut slightly; no watch uses a
 * reference band, so that path is not replayed.
 */

import { Bench, distribution, ratio } from './lib';
import {
  DAY_MS,
  OTHER_VARIANT_KEY,
  alertsOn,
  applyObservation,
  assignVariantGlued,
  buildBaselines,
  passedTermFilterAt06e9554,
  retaggedVariant,
  inBounds,
  junkKinds,
  junkProxies,
  loadAssocs,
  loadListings,
  loadObservations,
  loadScanStarts,
  loadWatches,
  pct,
  round,
  scoreIn,
  statesAt,
  type Assoc,
  type BaselineOptions,
  type JunkProxies,
  type ListingInfo,
  type ListingState,
  type Obs,
  type WatchCfg,
} from './scoring-data';
import { filterListings } from '../../server/service';

const started = Date.now();
const bench = new Bench('scoring-replay');
const { db, args } = bench;
const nowMs = Date.parse(bench.now);
const futureDays = Number(args.flags.get('future-days') ?? 14);
const exampleCount = Number(args.flags.get('examples') ?? 15);
bench.param('futureDays', futureDays);

const watches = loadWatches(db).filter((watch) => !watch.archived);
const listings = loadListings(db);
const assocList = loadAssocs(db);
const observations = loadObservations(db);
const scanStarts = loadScanStarts(db);
const assocsByWatch = new Map<string, Map<number, Assoc>>();
for (const assoc of assocList) {
  let map = assocsByWatch.get(assoc.watchId);
  if (!map) assocsByWatch.set(assoc.watchId, (map = new Map()));
  map.set(assoc.listingId, assoc);
}
bench.note(`Loaded ${watches.length} watches, ${assocList.length} watch listings, ${[...observations.values()].reduce((n, list) => n + list.length, 0)} observations in ${Date.now() - started} ms.`);
if (watches.some((watch) => watch.referenceMarketWatchId)) bench.note('Some watch uses a reference band; the replay does not model it (typicals while learning will differ).');

// ------------------------------------------------- 1. mirror vs the real code

if (!args.flags.has('no-service')) {
  const { ScoutService } = await import('../../server/service');
  const service = new ScoutService(db, () => {}, { suggestVariantGroups: async () => [] }) as unknown as {
    watchBaselines(row: Record<string, unknown>): { buckets: Map<string, { prices: number[]; firstObservedAt: string | null; stats?: { median: number | null } }> };
  };
  let buckets = 0;
  let matched = 0;
  const mismatches: Array<Record<string, unknown>> = [];
  for (const watch of watches) {
    const real = service.watchBaselines(watch.raw);
    const mirror = buildBaselines(watch, statesAt(watch, observations.get(watch.id) ?? [], assocsByWatch.get(watch.id) ?? new Map(), listings).values(), nowMs);
    const keys = new Set([...real.buckets.keys(), ...mirror.buckets.keys()]);
    for (const key of keys) {
      buckets += 1;
      const a = real.buckets.get(key);
      const b = mirror.buckets.get(key);
      const realFirst = a?.firstObservedAt ? Date.parse(a.firstObservedAt) : null;
      const same = Boolean(a && b) && a!.prices.length === b!.prices.length
        && (a!.stats?.median ?? null) === b!.stats.median && realFirst === b!.firstObservedAt;
      if (same) matched += 1;
      else mismatches.push({ watch: watch.name, bucket: key, realN: a?.prices.length ?? null, mirrorN: b?.prices.length ?? null, realMedian: a?.stats?.median ?? null, mirrorMedian: b?.stats.median ?? null });
    }
  }
  bench.metric('replay.mirror.bucket_match_share', 'Baseline buckets where the mirror equals ScoutService.watchBaselines at export time', ratio(matched, buckets), 'share', 'higher', `${matched}/${buckets}; below 1 means the service baseline changed and scoring-data.ts must follow`);
  if (mismatches.length) bench.table('mirror_mismatches', mismatches);
}

// --------------------------------------------------------- 2. the sweep

interface Decision {
  watch: WatchCfg;
  assoc: Assoc;
  listing: ListingInfo;
  obs: Obs;
  at: number;
  key: string;
  ready: boolean;
  typical: number | null;
  discount: number | null;
  strength: number | null;
  qualifies: boolean;
  /** qualifies after the AI relevance gate and the description-check rejection, as storeListing + processDealCandidates would alert. */
  alerts: boolean;
  junk: JunkProxies;
  futureRef: number | null;
  lifetimeH: number | null;
  /** Gone within 48 h while the watch kept scanning for at least another day. */
  fastGone: boolean | null;
}

const scenarios: Record<string, BaselineOptions> = {
  current: {},
  // The repo's variant rules applied the way ScoutService.retagVariantRules re-tags saved listings (see variantOverride).
  rules_now: {},
  // rules_now, and listings the repo's watch filter (query, included and excluded terms) now rejects are never stored.
  rules_now_refiltered: {},  // listings the repo's watch filter now rejects but the 06e9554 one kept are never stored
  no_flag_hidden: { exclude: (s) => s.listing.flags.length > 0 || s.listing.hidden || s.listing.decision === 'pass' },
  no_junk: { exclude: (s) => isJunkState(s) },
  window30: { windowDays: 30 },
  dedupe_reposts: { dedupeReposts: true },
  combined: { exclude: (s) => isJunkState(s), windowDays: 30, dedupeReposts: true },
  // Not a baseline option: re-buckets every listing with the glued-token variant rule (see variantOverride below).
  variant_glued: {},
};
/** Scenarios that replace stored variant keys with a different rule. */
const variantOverride: Record<string, (watch: WatchCfg, listing: ListingInfo, assoc: Assoc) => string> = {
  variant_glued: (watch, listing) => assignVariantGlued(listing.title, watch.groups),
  rules_now: (watch, listing, assoc) => retaggedVariant(watch, listing, assoc),
  rules_now_refiltered: (watch, listing, assoc) => retaggedVariant(watch, listing, assoc),
};
/** Scenarios that drop listings the repo's watch filter newly rejects, from baselines and decisions alike. */
const refilter = new Set(['rules_now_refiltered']);
const passesFilterCache = new Map<string, boolean>();
function passesWatchFilter(watch: WatchCfg, listing: ListingInfo) {
  const key = `${watch.id}|${listing.id}`;
  let passes = passesFilterCache.get(key);
  if (passes === undefined) {
    const now = filterListings([{ marketplace: listing.marketplace as never, listingId: listing.listingId, title: listing.title, condition: listing.condition ?? undefined, price: listing.price, currency: 'PLN', url: '', observedAt: '', shippingAvailable: null }], watch.query, String(watch.raw.included_terms ?? ''), watch.excludedTerms, {}).length === 1;
    passes = now || !passedTermFilterAt06e9554(watch, listing.title);
    passesFilterCache.set(key, passes);
  }
  return passes;
}
const junkTitleCache = new Map<string, boolean>();
function isJunkState(state: ListingState) {
  const listing = state.listing;
  if (listing.flags.length || listing.hidden || listing.decision === 'pass') return true;
  const cacheKey = `${state.assoc.watchId}|${listing.id}`;
  let junk = junkTitleCache.get(cacheKey);
  if (junk === undefined) {
    const watch = watches.find((item) => item.id === state.assoc.watchId)!;
    junk = junkKinds(listing.title, watch.query).length > 0;
    junkTitleCache.set(cacheKey, junk);
  }
  return junk;
}
const requested = typeof args.flags.get('scenarios') === 'string'
  ? String(args.flags.get('scenarios')).split(',').map((s) => s.trim()).filter((s) => s in scenarios)
  : Object.keys(scenarios);
if (!requested.includes('current')) requested.unshift('current');
bench.param('scenarios', requested);

/** First observation per listing, grouped by the scan that found it. */
function evalGroups(watch: WatchCfg) {
  const list = observations.get(watch.id) ?? [];
  const firsts = new Map<number, Obs>();
  for (const obs of list) if (!firsts.has(obs.listingId)) firsts.set(obs.listingId, obs);
  const groups = new Map<string, { start: number; evals: Obs[] }>();
  for (const obs of firsts.values()) {
    const start = obs.scanId !== null ? scanStarts.get(obs.scanId) ?? obs.at - 1 : obs.at - 1;
    const id = `${obs.scanId ?? `t${obs.at}`}`;
    let group = groups.get(id);
    if (!group) groups.set(id, (group = { start: Math.min(start, obs.at - 1), evals: [] }));
    group.evals.push(obs);
  }
  return [...groups.values()].sort((a, b) => a.start - b.start);
}

/** Sorted scan activity per watch, to tell "listing gone" from "watch stopped". */
const activity = new Map<string, number[]>();
for (const watch of watches) activity.set(watch.id, [...new Set((observations.get(watch.id) ?? []).map((o) => o.at))].sort((a, b) => a - b));
function activeBetween(watchId: string, from: number, to: number) {
  const times = activity.get(watchId) ?? [];
  let lo = 0;
  let hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= from) lo = mid + 1;
    else hi = mid;
  }
  return lo < times.length && times[lo] <= to;
}

function lifetime(watch: WatchCfg, assoc: Assoc) {
  const first = Date.parse(assoc.firstSeen);
  const last = Date.parse(assoc.lastSeen);
  const hours = (last - first) / 3_600_000;
  // Gone: no sighting for a day while the watch kept scanning past the last one.
  const gone = activeBetween(watch.id, last + 3_600_000, last + DAY_MS) && nowMs - last > DAY_MS;
  return { hours, fastGone: gone ? hours <= 48 : hours > 48 ? false : null };
}

const decisionsByScenario = new Map<string, Decision[]>();
const drift = { outOfBounds: 0, noAssoc: 0 };
for (const name of requested) {
  const options = scenarios[name];
  const decisions: Decision[] = [];
  const t0 = Date.now();
  for (const watch of watches) {
    let assocs = assocsByWatch.get(watch.id) ?? new Map<number, Assoc>();
    const override = variantOverride[name];
    if (override && watch.groups.length) {
      const swapped = new Map<number, Assoc>();
      for (const [id, assoc] of assocs) {
        const listing = listings.get(id);
        swapped.set(id, listing ? { ...assoc, variantKey: override(watch, listing, assoc) } : assoc);
      }
      assocs = swapped;
    }
    if (refilter.has(name)) {
      const kept = new Map<number, Assoc>();
      for (const [id, assoc] of assocs) {
        const listing = listings.get(id);
        if (listing && passesWatchFilter(watch, listing)) kept.set(id, assoc);
      }
      assocs = kept;
    }
    const list = observations.get(watch.id) ?? [];
    const states = new Map<number, ListingState>();
    let pointer = 0;
    for (const group of evalGroups(watch)) {
      while (pointer < list.length && list[pointer].at < group.start) applyObservation(watch, states, list[pointer++], assocs, listings);
      const baselines = buildBaselines(watch, states.values(), group.start, options);
      for (const obs of group.evals) {
        const assoc = assocs.get(obs.listingId);
        const listing = listings.get(obs.listingId);
        if (!assoc || !listing) { if (name === 'current') drift.noAssoc += 1; continue; }
        if (!inBounds(watch, obs.price)) { if (name === 'current') drift.outOfBounds += 1; continue; }
        const key = watch.groups.length ? assoc.variantKey ?? OTHER_VARIANT_KEY : OTHER_VARIANT_KEY;
        const scored = scoreIn(watch, baselines, key, obs.price, group.start);
        const qualifies = alertsOn(watch, scored, obs.price);
        const junk = junkProxies(watch, assoc, listing);
        const strength = scored.score.isReady ? scored.strength : null;
        const alerts = qualifies && !junk.irrelevant && !((strength ?? 0) >= 4 && listing.verification === 'reject');
        const life = lifetime(watch, assoc);
        decisions.push({
          watch, assoc, listing, obs, at: obs.at, key,
          ready: scored.score.isReady,
          typical: scored.score.isReady ? scored.score.typical : null,
          discount: scored.score.isReady ? scored.score.discountPercent : null,
          strength,
          qualifies,
          alerts,
          junk,
          futureRef: null,
          lifetimeH: life.hours,
          fastGone: life.fastGone,
        });
      }
    }
  }
  attachFutureReference(decisions);
  decisionsByScenario.set(name, decisions);
  bench.note(`scenario ${name}: ${decisions.length} decisions in ${Date.now() - t0} ms`);
}

/** Median first-sighting price of clean listings in the same watch+variant over the next futureDays. */
function attachFutureReference(decisions: Decision[]) {
  const clean = new Map<string, Array<{ at: number; price: number }>>();
  for (const d of decisions) {
    if (d.junk.any) continue;
    const id = `${d.watch.id}|${d.key}`;
    let list = clean.get(id);
    if (!list) clean.set(id, (list = []));
    list.push({ at: d.at, price: d.obs.price });
  }
  for (const list of clean.values()) list.sort((a, b) => a.at - b.at);
  for (const d of decisions) {
    const list = clean.get(`${d.watch.id}|${d.key}`) ?? [];
    const prices = list.filter((item) => item.at > d.at && item.at <= d.at + futureDays * DAY_MS).map((item) => item.price).sort((a, b) => a - b);
    if (prices.length >= 5) {
      const mid = prices.length >> 1;
      d.futureRef = prices.length % 2 ? prices[mid] : (prices[mid - 1] + prices[mid]) / 2;
    }
  }
}

// --------------------------------------------------------- 3. metrics

const activeDays = new Map<string, number>();
for (const watch of watches) {
  const days = new Set((activity.get(watch.id) ?? []).map((t) => Math.floor(t / DAY_MS)));
  activeDays.set(watch.id, days.size);
}
const totalWatchDays = [...activeDays.values()].reduce((a, b) => a + b, 0);

/** Junk that the AI relevance gate does not already remove from alerts. */
const residualJunk = (j: JunkProxies) => j.flagged || j.hidden || j.rejected || j.junkTitle;

function scenarioMetrics(name: string, decisions: Decision[]) {
  const p = `replay.${name}`;
  const ready = decisions.filter((d) => d.ready);
  const qualifying = decisions.filter((d) => d.qualifies);
  const alerts = decisions.filter((d) => d.alerts);
  const strongPlus = decisions.filter((d) => (d.strength ?? 0) >= 3);
  const junkShare = (rows: Decision[], pick: (j: JunkProxies) => boolean) => ratio(rows.filter((d) => pick(d.junk)).length, rows.length);
  bench.metric(`${p}.decisions`, `${name}: first sightings scored`, decisions.length, 'count', 'info');
  bench.metric(`${p}.ready_share`, `${name}: share scored against a ready baseline`, ratio(ready.length, decisions.length), 'share', 'info');
  bench.metric(`${p}.qualifying`, `${name}: first sightings that qualify (before AI gate)`, qualifying.length, 'count', 'info');
  bench.metric(`${p}.alerts`, `${name}: alerts after AI relevance + description gate`, alerts.length, 'count', 'info');
  bench.metric(`${p}.alerts_per_100_watch_days`, `${name}: alerts per 100 active watch-days`, totalWatchDays ? (alerts.length / totalWatchDays) * 100 : null, 'alerts', 'info', `${totalWatchDays} watch-days`);
  bench.metric(`${p}.qualifying_junk_share`, `${name}: qualifying that are junk by any proxy`, junkShare(qualifying, (j) => j.any), 'share', 'lower');
  bench.metric(`${p}.alert_junk_share`, `${name}: alerts that are flagged, hidden, description-rejected or junk-titled`, junkShare(alerts, residualJunk), 'share', 'lower');
  bench.metric(`${p}.alerts_other_bucket`, `${name}: alerts priced in a watch's Other / unclassified bucket`, alerts.filter((d) => d.watch.groups.length > 0 && d.key === OTHER_VARIANT_KEY).length, 'count', 'lower');
  bench.metric(`${p}.strong_plus`, `${name}: first sightings labelled Strong+`, strongPlus.length, 'count', 'info');
  bench.metric(`${p}.strong_plus_junk_share`, `${name}: Strong+ that are junk by any proxy`, junkShare(strongPlus, (j) => j.any), 'share', 'lower');
  // Typical vs the future clean market, clean ready decisions only.
  const errors = ready.filter((d) => !d.junk.any && d.futureRef && d.typical).map((d) => d.typical! / d.futureRef! - 1);
  const absErr = distribution(errors.map(Math.abs));
  const bias = distribution(errors);
  bench.metric(`${p}.typical_err_vs_future.n`, `${name}: clean ready decisions with a future reference`, absErr.n, 'count', 'info');
  bench.metric(`${p}.typical_abs_err_vs_future.p50`, `${name}: |typical / future clean median − 1| p50`, absErr.p50, 'ratio', 'lower');
  bench.metric(`${p}.typical_abs_err_vs_future.p90`, `${name}: |typical / future clean median − 1| p90`, absErr.p90, 'ratio', 'lower');
  bench.metric(`${p}.typical_bias_vs_future.p50`, `${name}: typical / future clean median − 1, p50 (positive = typical above market)`, bias.p50, 'ratio', 'info');
  // Alerts measured against the future market.
  const cleanAlerts = alerts.filter((d) => !residualJunk(d.junk) && d.futureRef);
  const trueDiscounts = cleanAlerts.map((d) => 1 - d.obs.price / d.futureRef!);
  bench.metric(`${p}.alert_true_discount.p50`, `${name}: clean alerts' discount vs future clean median, p50`, distribution(trueDiscounts).p50, 'ratio', 'higher', `n=${trueDiscounts.length}`);
  bench.metric(`${p}.alert_weak_share`, `${name}: clean alerts under 10% below the future clean median`, ratio(trueDiscounts.filter((v) => v < 0.1).length, trueDiscounts.length), 'share', 'lower');
  const missed = ready.filter((d) => !d.junk.any && !d.alerts && d.futureRef && 1 - d.obs.price / d.futureRef >= 0.25);
  bench.metric(`${p}.missed_clean_deals`, `${name}: clean ready listings ≥25% below the future clean median that did not alert`, missed.length, 'count', 'lower');
  const unready = decisions.filter((d) => !d.ready && !d.junk.any && d.futureRef && 1 - d.obs.price / d.futureRef >= 0.25);
  bench.metric(`${p}.missed_clean_deals_unready`, `${name}: same, but the baseline was not ready yet`, unready.length, 'count', 'lower');
  // Disappearance.
  const known = (rows: Decision[]) => rows.filter((d) => d.fastGone !== null);
  const fast = (rows: Decision[]) => ratio(known(rows).filter((d) => d.fastGone).length, known(rows).length);
  bench.metric(`${p}.alert_fast_gone_48h_share`, `${name}: clean alerts gone within 48 h`, fast(alerts.filter((d) => !residualJunk(d.junk))), 'share', 'higher', `n=${known(alerts.filter((d) => !residualJunk(d.junk))).length}`);
  bench.metric(`${p}.all_fast_gone_48h_share`, `${name}: all clean first sightings gone within 48 h (base rate)`, fast(decisions.filter((d) => !d.junk.any)), 'share', 'info');
  return { missed, alerts, qualifying };
}

const results = new Map<string, ReturnType<typeof scenarioMetrics>>();
for (const name of requested) results.set(name, scenarioMetrics(name, decisionsByScenario.get(name)!));

// ------------------------------------------------- 4. fidelity vs stored

const current = decisionsByScenario.get('current')!;
const storedReady = current.filter((d) => d.obs.baseline !== null);
const readyAgree = storedReady.filter((d) => d.ready).length;
const typicalClose = storedReady.filter((d) => d.ready && d.typical !== null && Math.abs(d.typical / d.obs.baseline! - 1) <= 0.01).length;
const labelAgree = storedReady.filter((d) => d.ready && d.obs.strength !== null && d.strength === d.obs.strength).length;
const storedUnready = current.filter((d) => d.obs.baseline === null);
bench.metric('replay.fidelity.stored_ready_n', 'First sightings stored with a ready baseline', storedReady.length, 'count', 'info');
bench.metric('replay.fidelity.ready_agree_share', 'Of those, replay also ready', ratio(readyAgree, storedReady.length), 'share', 'higher');
bench.metric('replay.fidelity.typical_within_1pct_share', 'Of those, replay typical within 1% of the stored one', ratio(typicalClose, storedReady.length), 'share', 'higher');
bench.metric('replay.fidelity.strength_agree_share', 'Of those, replay deal strength equals the stored one', ratio(labelAgree, storedReady.length), 'share', 'higher');
bench.metric('replay.fidelity.unready_agree_share', 'First sightings stored unready that replay also scores unready', ratio(storedUnready.filter((d) => !d.ready).length, storedUnready.length), 'share', 'higher');
bench.metric('replay.fidelity.out_of_bounds_first_sightings', 'First sightings outside the current price bounds (config changed since)', drift.outOfBounds, 'count', 'info');

const byMonth = new Map<string, { n: number; close: number; strength: number }>();
for (const d of storedReady) {
  const month = new Date(d.at).toISOString().slice(0, 7);
  const row = byMonth.get(month) ?? { n: 0, close: 0, strength: 0 };
  row.n += 1;
  if (d.ready && d.typical !== null && Math.abs(d.typical / d.obs.baseline! - 1) <= 0.01) row.close += 1;
  if (d.ready && d.strength === d.obs.strength) row.strength += 1;
  byMonth.set(month, row);
}
bench.table('fidelity_by_month', [...byMonth.entries()].sort().map(([month, row]) => ({ month, storedReady: row.n, typicalWithin1pct: pct(row.close / row.n), strengthAgree: pct(row.strength / row.n) })));
const byWatchFidelity = new Map<string, { n: number; close: number; medianGap: number[] }>();
for (const d of storedReady) {
  const row = byWatchFidelity.get(d.watch.name) ?? { n: 0, close: 0, medianGap: [] };
  row.n += 1;
  if (d.ready && d.typical !== null) {
    const gap = d.typical / d.obs.baseline! - 1;
    row.medianGap.push(gap);
    if (Math.abs(gap) <= 0.01) row.close += 1;
  }
  byWatchFidelity.set(d.watch.name, row);
}
bench.table('fidelity_by_watch', [...byWatchFidelity.entries()].map(([watch, row]) => ({ watch, storedReady: row.n, typicalWithin1pct: pct(row.close / row.n), medianGapPct: pct(distribution(row.medianGap).p50) })));

// Alerts Scout actually raised (notifications) vs replayed first-sighting alerts.
const notified = new Map<string, number>();
for (const row of db.prepare('SELECT payload_json, created_at FROM notifications').all() as Array<{ payload_json: string; created_at: string }>) {
  try {
    const payload = JSON.parse(row.payload_json);
    const scout = payload?._scout;
    if (scout?.watchId && scout?.listing?.marketplace && scout?.listing?.listingId) {
      const key = `${scout.watchId}|${scout.listing.marketplace}:${scout.listing.listingId}`;
      const at = Date.parse(row.created_at);
      if (!notified.has(key) || at < notified.get(key)!) notified.set(key, at);
    }
  } catch { /* skip unreadable payloads */ }
}
const decisionByKey = new Map(current.map((d) => [`${d.watch.id}|${d.listing.key}`, d]));
let notifiedFirstSighting = 0;
let notifiedFirstSightingReplayAlert = 0;
let notifiedLater = 0;
let notifiedUnknown = 0;
for (const [key, at] of notified) {
  const d = decisionByKey.get(key);
  if (!d) { notifiedUnknown += 1; continue; }
  if (at - d.at <= 2 * 3_600_000) {
    notifiedFirstSighting += 1;
    if (d.alerts) notifiedFirstSightingReplayAlert += 1;
  } else notifiedLater += 1;
}
const replayAlertKeys = current.filter((d) => d.alerts);
bench.metric('replay.fidelity.notified_listings', 'Distinct (watch, listing) alerts in notifications', notified.size, 'count', 'info', `${notifiedFirstSighting} within 2 h of first sighting, ${notifiedLater} later (price drops or later readiness), ${notifiedUnknown} unmatched`);
bench.metric('replay.fidelity.first_sighting_alert_recall', 'Real first-sighting alerts that the replay also alerts', ratio(notifiedFirstSightingReplayAlert, notifiedFirstSighting), 'share', 'higher');
bench.metric('replay.fidelity.replay_alert_precision_vs_notified', 'Replayed alerts that Scout really notified (any time)', ratio(replayAlertKeys.filter((d) => notified.has(`${d.watch.id}|${d.listing.key}`)).length, replayAlertKeys.length), 'share', 'info', 'low values can be channel/priority settings, AI gate state at the time, or scan-era config');

// ------------------------------------------------- 5. per-watch + examples

bench.table('current_by_watch', watches.map((watch) => {
  const rows = current.filter((d) => d.watch.id === watch.id);
  const alerts = rows.filter((d) => d.alerts);
  return {
    watch: watch.name,
    enabled: watch.enabled,
    decisions: rows.length,
    readyPct: pct(ratio(rows.filter((d) => d.ready).length, rows.length)),
    qualifying: rows.filter((d) => d.qualifies).length,
    alerts: alerts.length,
    alertJunkPct: pct(ratio(alerts.filter((d) => residualJunk(d.junk)).length, alerts.length)),
    otherBucketAlerts: alerts.filter((d) => watch.groups.length > 0 && d.key === OTHER_VARIANT_KEY).length,
    strongPlus: rows.filter((d) => (d.strength ?? 0) >= 3).length,
    activeDays: activeDays.get(watch.id) ?? 0,
  };
}));

bench.table('scenario_summary', requested.map((name) => {
  const metric = (suffix: string) => bench.report.metrics.find((m) => m.id === `replay.${name}.${suffix}`)?.value ?? null;
  return {
    scenario: name,
    alerts: metric('alerts'),
    alertJunkPct: pct(metric('alert_junk_share')),
    qualifyingJunkPct: pct(metric('qualifying_junk_share')),
    strongPlus: metric('strong_plus'),
    strongPlusJunkPct: pct(metric('strong_plus_junk_share')),
    typAbsErrP50: pct(metric('typical_abs_err_vs_future.p50')),
    typBiasP50: pct(metric('typical_bias_vs_future.p50')),
    alertTrueDiscP50: pct(metric('alert_true_discount.p50')),
    alertWeakPct: pct(metric('alert_weak_share')),
    missed: metric('missed_clean_deals'),
  };
}));

bench.table('alerts_by_watch_and_scenario', watches.map((watch) => {
  const row: Record<string, unknown> = { watch: watch.name };
  for (const name of requested) {
    const rows = decisionsByScenario.get(name)!.filter((d) => d.watch.id === watch.id);
    row[name] = rows.filter((d) => d.alerts).length;
    if (name === 'variant_glued' || name === 'current') row[`${name}_ready`] = pct(ratio(rows.filter((d) => d.ready).length, rows.length));
  }
  return row;
}));

const example = (d: Decision) => ({
  watch: d.watch.name,
  day: new Date(d.at).toISOString().slice(0, 10),
  title: d.listing.title.slice(0, 70),
  price: d.obs.price,
  typical: round(d.typical, 0),
  futureRef: round(d.futureRef, 0),
  strength: d.strength,
  bucket: d.key === OTHER_VARIANT_KEY ? 'Other' : d.key.slice(0, 18),
  junk: [d.junk.flagged && 'flag', d.junk.hidden && 'hidden', d.junk.irrelevant && 'irrelevant', d.junk.rejected && 'rejected', d.junk.junkTitle && `title:${junkKinds(d.listing.title, d.watch.query).join('+')}`].filter(Boolean).join(' '),
});
const currentResult = results.get('current')!;
bench.table('current_junk_alerts', currentResult.alerts.filter((d) => residualJunk(d.junk)).slice(0, exampleCount).map(example));

// Alert gates as post-hoc filters on the current decisions: what each would cut, and what clean alerts it would cost.
const gates: Record<string, (d: Decision) => boolean> = {
  no_other_bucket: (d) => !(d.watch.groups.length > 0 && d.key === OTHER_VARIANT_KEY),
  no_stored_flags: (d) => d.listing.flags.length === 0,
  under_60pct_off: (d) => (d.discount ?? 0) < 60,
  verified_if_over_40pct: (d) => (d.discount ?? 0) < 40 || d.listing.verification === 'pass',
};
const gateRows: Array<Record<string, unknown>> = [];
// The gates on today's decisions, and on the scenario that models the shipped variant rules and filter.
for (const scenario of ['current', 'rules_now_refiltered'].filter((name) => results.has(name))) {
  const prefix = scenario === 'current' ? 'replay.gate' : `replay.${scenario}.gate`;
  for (const [gate, keep] of Object.entries(gates)) {
    const kept = results.get(scenario)!.alerts.filter(keep);
    const dropped = results.get(scenario)!.alerts.filter((d) => !keep(d));
    const droppedJunk = dropped.filter((d) => residualJunk(d.junk)).length;
    bench.metric(`${prefix}.${gate}.alerts`, `${scenario}, gate ${gate}: alerts left`, kept.length, 'count', 'info');
    bench.metric(`${prefix}.${gate}.alert_junk_share`, `${scenario}, gate ${gate}: alert junk share`, ratio(kept.filter((d) => residualJunk(d.junk)).length, kept.length), 'share', 'lower');
    bench.metric(`${prefix}.${gate}.clean_alerts_lost`, `${scenario}, gate ${gate}: clean alerts it would drop`, dropped.length - droppedJunk, 'count', 'lower');
    gateRows.push({ scenario, gate, alertsLeft: kept.length, dropped: dropped.length, droppedJunk, cleanLost: dropped.length - droppedJunk, junkPctLeft: pct(ratio(kept.filter((d) => residualJunk(d.junk)).length, kept.length)) });
  }
}
bench.table('alert_gates', gateRows);
const otherAlertExamples = [...results.entries()].filter(([name]) => name === 'current' || name === 'rules_now_refiltered')
  .flatMap(([name, result]) => result.alerts.filter((d) => d.watch.groups.length > 0 && d.key === OTHER_VARIANT_KEY).map((d) => ({ scenario: name, ...example(d) })));
bench.table('other_bucket_alerts', otherAlertExamples.slice(0, exampleCount * 2));

// The future reference is the median of the decision's own bucket, so a scenario that re-buckets listings
// also moves its yardstick. Score current and the shipped rules against one yardstick: the shipped buckets.
const shipped = decisionsByScenario.get('rules_now_refiltered');
if (shipped) {
  const yardstick = new Map(shipped.filter((d) => !d.junk.any && d.futureRef).map((d) => [`${d.watch.id}|${d.listing.id}`, d]));
  const byBucket = new Map<string, { current: number[]; shipped: number[]; currentBias: number[]; shippedBias: number[] }>();
  const add = (d: Decision, side: 'current' | 'shipped') => {
    const ref = yardstick.get(`${d.watch.id}|${d.listing.id}`);
    if (!ref || !d.ready || !d.typical) return;
    const id = `${d.watch.name}|${ref.key === OTHER_VARIANT_KEY ? 'Other' : ref.key.slice(0, 22)}`;
    let row = byBucket.get(id);
    if (!row) byBucket.set(id, (row = { current: [], shipped: [], currentBias: [], shippedBias: [] }));
    row[side].push(Math.abs(d.typical / ref.futureRef! - 1));
    row[`${side}Bias`].push(d.typical / ref.futureRef! - 1);
  };
  for (const d of decisionsByScenario.get('current') ?? []) add(d, 'current');
  for (const d of shipped) add(d, 'shipped');
  for (const [side, decisions] of [['current', decisionsByScenario.get('current') ?? []], ['shipped', shipped]] as const) {
    const missed = decisions.filter((d) => {
      const ref = yardstick.get(`${d.watch.id}|${d.listing.id}`);
      return ref && d.ready && !d.alerts && !d.junk.any && 1 - d.obs.price / ref.futureRef! >= 0.25;
    });
    bench.metric(`replay.fixed_yardstick.${side}.missed_clean_deals`, `${side === 'current' ? 'current' : 'rules_now_refiltered'}: clean ready listings ≥25% below the shipped bucket's future clean median that did not alert`, missed.length, 'count', 'lower');
  }
  const all = { current: [...byBucket.values()].flatMap((row) => row.current), shipped: [...byBucket.values()].flatMap((row) => row.shipped) };
  for (const side of ['current', 'shipped'] as const) {
    const dist = distribution(all[side]);
    bench.metric(`replay.fixed_yardstick.${side}.typical_abs_err.p50`, `${side === 'current' ? 'current' : 'rules_now_refiltered'}: |typical / future clean median of the shipped bucket − 1| p50`, dist.p50, 'ratio', 'lower', `n=${dist.n}`);
    bench.metric(`replay.fixed_yardstick.${side}.typical_abs_err.p90`, `${side === 'current' ? 'current' : 'rules_now_refiltered'}: same, p90`, dist.p90, 'ratio', 'lower');
  }
  bench.table('typical_error_fixed_yardstick', [...byBucket.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([bucket, row]) => ({
    bucket,
    currentN: row.current.length,
    currentP50: pct(distribution(row.current).p50),
    currentP90: pct(distribution(row.current).p90),
    currentBiasP50: pct(distribution(row.currentBias).p50),
    shippedN: row.shipped.length,
    shippedP50: pct(distribution(row.shipped).p50),
    shippedP90: pct(distribution(row.shipped).p90),
    shippedBiasP50: pct(distribution(row.shippedBias).p50),
  })));
}

// Junk by discount band among ready Strong+ first sightings: where implausible prices start.
const bands = [[0, 20], [20, 30], [30, 40], [40, 60], [60, 101]];
bench.table('strong_plus_junk_by_discount', bands.map(([lo, hi]) => {
  const rows = current.filter((d) => (d.strength ?? 0) >= 3 && (d.discount ?? -1) >= lo && (d.discount ?? -1) < hi);
  return {
    discountPct: `${lo}–${hi === 101 ? 100 : hi}`,
    n: rows.length,
    junkAnyPct: pct(ratio(rows.filter((d) => d.junk.any).length, rows.length)),
    irrelevantPct: pct(ratio(rows.filter((d) => d.junk.irrelevant).length, rows.length)),
    rejectedPct: pct(ratio(rows.filter((d) => d.junk.rejected).length, rows.length)),
    titlePct: pct(ratio(rows.filter((d) => d.junk.junkTitle).length, rows.length)),
    otherBucketPct: pct(ratio(rows.filter((d) => d.watch.groups.length > 0 && d.key === OTHER_VARIANT_KEY).length, rows.length)),
  };
}));
// Disappearance by marketplace: Vinted search rotation makes "gone" noisy, so compare alerts with their own marketplace's base rate.
const lifeRows: Array<Record<string, unknown>> = [];
for (const marketplace of [...new Set(current.map((d) => d.listing.marketplace))].sort()) {
  const rows = current.filter((d) => d.listing.marketplace === marketplace && !residualJunk(d.junk) && !d.junk.irrelevant && d.fastGone !== null);
  const share = (subset: Decision[]) => pct(ratio(subset.filter((d) => d.fastGone).length, subset.length));
  const alerted = rows.filter((d) => d.alerts);
  const strongNoAlert = rows.filter((d) => !d.alerts && (d.strength ?? 0) >= 3);
  const rest = rows.filter((d) => !d.alerts && (d.strength ?? 0) < 3);
  lifeRows.push({ marketplace, alertsN: alerted.length, alertsGone48hPct: share(alerted), strongNoAlertN: strongNoAlert.length, strongNoAlertGone48hPct: share(strongNoAlert), restN: rest.length, restGone48hPct: share(rest) });
  const id = marketplace.toLowerCase().replace(/[^a-z0-9]+/g, '_');
  bench.metric(`replay.current.fast_gone_lift.${id}`, `${marketplace}: alert gone-in-48h share minus non-deal base rate (pp)`, alerted.length >= 10 && rest.length >= 10 ? (share(alerted)! - share(rest)!) : null, 'pp', 'higher', `alerts n=${alerted.length}, base n=${rest.length}`);
}
bench.table('fast_gone_by_marketplace', lifeRows);
bench.table('current_missed_clean_deals', currentResult.missed.sort((a, b) => a.obs.price / a.futureRef! - b.obs.price / b.futureRef!).slice(0, exampleCount).map(example));

bench.metric('replay.runtime_ms', 'Replay wall time', Date.now() - started, 'ms', 'info');
bench.finish();
