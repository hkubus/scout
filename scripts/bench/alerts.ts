/**
 * Alert benchmark: how fast, how reliably and how usefully Scout turns a
 * stored deal into a Discord/ntfy alert, measured from an improvement export.
 *
 *   node --import tsx scripts/bench/alerts.ts <scout-improvement-*.sqlite> [--json=out.json] [--now=ISO]
 *
 * Sections (metric id prefixes):
 *   alerts.<window>.*            volume, per-channel delivery outcome and send time
 *   alerts.<window>.pipeline.*   scan start → alert → delivery, OLX posting → delivery
 *   alerts.all.realerts.*        alert:N≥2 events classified by why they re-fired
 *   alerts.all.retry.*           attempts spent on permanent errors and after give-up
 *   alerts.<window>.quality.*    alerted listings later hidden, flagged, gone soon
 *   alerts.<window>.funnel.*     listings that reached the alert tiers but never alerted
 *   alerts.digest.*, alerts.flips.*, export.logs.*   context
 *
 * Code references: notification keys and planning server/service.ts:7592-7762 (planDealNotification :7719),
 * delivery and retry backoff :7651-7705, retries :7817-7860, priority tiers
 * server/notifications.ts:24-28, qualify gate server/scoring.ts:115-116.
 * Prices are asking prices.
 */

import { all, Bench, distribution, exportInfo, one, scalar } from './lib';
import { errorCluster, exportTimeZone, isoWeek, LocalClock, loadScans, loadWatches, MARKETPLACES, mpKey, pct, round, type ScanRow, upperBound } from './scan-lib';

const bench = new Bench('alerts');
const { db } = bench;
const nowMs = Date.parse(bench.now);
const RECENT_DAYS = 14;
const recentFrom = Date.parse(bench.daysAgo(RECENT_DAYS));
const windows = [{ key: 'recent', from: recentFrom }, { key: 'all', from: Number.NEGATIVE_INFINITY }];
const inWindow = (ms: number, from: number) => ms >= from && ms <= nowMs;
const seconds = (ms: number) => ms / 1000;
const minutes = (ms: number) => ms / 60_000;
const hours = (ms: number) => ms / 3_600_000;
const clock = new LocalClock(exportTimeZone(db));
const watches = loadWatches(db);
bench.param('recentDays', RECENT_DAYS);
bench.param('timeZone', clock.timeZone);

type Channel = 'Discord' | 'ntfy';
const CHANNELS: Channel[] = ['Discord', 'ntfy'];
const PRIORITY_RANK: Record<string, number> = { strong: 1, 'very-strong': 2, exceptional: 3 };

// ------------------------------------------------------------------ loading

interface AlertEvent {
  key: string; watchId: string; marketplace: string; listingId: string; sequence: number;
  createdMs: number; sentMs: number; status: string;
  priority: string | null; price: number | null; discount: number | null; targetPrice: number | null;
}
interface Delivery {
  key: string; eventKey: string; channel: Channel; status: string; attempts: number; message: string | null;
  createdMs: number; sentMs: number; updatedMs: number; event: AlertEvent | undefined;
}

const EVENT_KEY = /^([^|]+)\|(OLX|Vinted|Allegro Lokalnie)\|(.+)\|alert:(\d+)$/;
const events = new Map<string, AlertEvent>();
let testOrDigestEvents = 0;
for (const row of all<Record<string, unknown>>(db, 'SELECT listing_key, payload_json, status, sent_at, created_at FROM notifications ORDER BY id')) {
  const key = String(row.listing_key);
  const match = EVENT_KEY.exec(key);
  if (!match) { testOrDigestEvents += 1; continue; }
  let meta: Record<string, any> = {};
  try { meta = (JSON.parse(String(row.payload_json)) as { _scout?: Record<string, any> })._scout ?? {}; } catch { /* keep empty */ }
  events.set(key, {
    key, watchId: match[1], marketplace: match[2], listingId: match[3], sequence: Number(match[4]),
    createdMs: Date.parse(String(row.created_at)), sentMs: row.sent_at ? Date.parse(String(row.sent_at)) : Number.NaN, status: String(row.status),
    priority: typeof meta.priority === 'string' ? meta.priority : null,
    price: Number.isFinite(Number(meta.listing?.price)) ? Number(meta.listing.price) : null,
    discount: meta.discountPercent === null || meta.discountPercent === undefined ? null : Number(meta.discountPercent),
    targetPrice: meta.targetPrice === null || meta.targetPrice === undefined ? null : Number(meta.targetPrice),
  });
}
const deliveries: Delivery[] = all<Record<string, unknown>>(db, 'SELECT listing_key, channel, status, attempt_count, message, sent_at, created_at, updated_at FROM notification_deliveries ORDER BY id')
  .filter((row) => String(row.listing_key).includes('|alert:'))
  .map((row) => {
    const key = String(row.listing_key);
    const eventKey = key.replace(/\|channel:.*$/, '');
    return {
      key, eventKey, channel: String(row.channel) as Channel, status: String(row.status), attempts: Number(row.attempt_count ?? 0),
      message: row.message === null || row.message === undefined ? null : String(row.message),
      createdMs: Date.parse(String(row.created_at)), sentMs: row.sent_at ? Date.parse(String(row.sent_at)) : Number.NaN,
      updatedMs: row.updated_at ? Date.parse(String(row.updated_at)) : Number.NaN,
      event: events.get(eventKey),
    };
  });
const deliveriesByEvent = new Map<string, Delivery[]>();
for (const delivery of deliveries) {
  const list = deliveriesByEvent.get(delivery.eventKey);
  if (list) list.push(delivery);
  else deliveriesByEvent.set(delivery.eventKey, [delivery]);
}
bench.param('alertEvents', events.size);
bench.param('testOrDigestNotifications', testOrDigestEvents);

interface ListingInfo {
  watchId: string; marketplace: string; externalId: string; listingRowId: number;
  firstMs: number; lastMs: number; postedMs: number;
  verification: string | null; flagged: boolean; hidden: boolean; price: number;
}
const hiddenKeys = new Set(all<{ marketplace: string; listing_id: string }>(db, 'SELECT marketplace, listing_id FROM listing_actions WHERE hidden = 1')
  .map((row) => `${row.marketplace}|${row.listing_id}`));
const listingInfo = new Map<string, ListingInfo>();
for (const row of all<Record<string, unknown>>(db, `SELECT wl.watch_id, wl.listing_id AS row_id, l.marketplace, l.listing_id AS external_id, wl.first_seen_at, wl.last_seen_at,
    l.posted_at, l.ai_description_verification_status AS verification, l.flags_json, l.price_pln
  FROM watch_listings wl JOIN listings l ON l.id = wl.listing_id`)) {
  const key = `${row.watch_id}|${row.marketplace}|${row.external_id}`;
  listingInfo.set(key, {
    watchId: String(row.watch_id), marketplace: String(row.marketplace), externalId: String(row.external_id), listingRowId: Number(row.row_id),
    firstMs: Date.parse(String(row.first_seen_at)), lastMs: Date.parse(String(row.last_seen_at)),
    postedMs: row.posted_at ? Date.parse(String(row.posted_at)) : Number.NaN,
    verification: row.verification === null || row.verification === undefined ? null : String(row.verification),
    flagged: Boolean(row.flags_json) && String(row.flags_json) !== '[]',
    hidden: hiddenKeys.has(`${row.marketplace}|${row.external_id}`),
    price: Number(row.price_pln),
  });
}
const eventListingKey = (event: AlertEvent) => `${event.watchId}|${event.marketplace}|${event.listingId}`;

// Watch scans per watch+marketplace, sorted by start, to find the scan that raised each alert.
const scansByPair = new Map<string, { starts: number[]; scans: ScanRow[] }>();
for (const scan of loadScans(db)) {
  if (scan.kind !== 'watch') continue;
  const key = `${scan.watchId}|${scan.marketplace}`;
  let entry = scansByPair.get(key);
  if (!entry) scansByPair.set(key, entry = { starts: [], scans: [] });
  entry.starts.push(scan.startMs);
  entry.scans.push(scan);
}
/** The watch scan that raised an alert: the latest one for the pair that started before the alert row was written. */
function originScan(event: AlertEvent): ScanRow | null {
  const entry = scansByPair.get(`${event.watchId}|${event.marketplace}`);
  if (!entry) return null;
  const index = upperBound(entry.starts, event.createdMs) - 1;
  if (index < 0) return null;
  const scan = entry.scans[index];
  // processDealCandidates runs right after completeScan (server/service.ts:6680-6683); anything later is a retry or another path.
  return event.createdMs - scan.startMs <= 15 * 60_000 ? scan : null;
}

const eventList = [...events.values()].filter((event) => event.createdMs <= nowMs);
/**
 * Alert sequences are per channel but share the notifications row (INSERT OR IGNORE, server/service.ts:7791), so a
 * channel that first alerts later (configured later, or a higher minimum priority reached later) reuses an old
 * alert:N row whose created_at and payload belong to the other channel. Only deliveries claimed within a minute
 * of the row count as that event's.
 */
const SAME_EVENT_MS = 60_000;
const eventDeliveries = (event: AlertEvent) => (deliveriesByEvent.get(event.key) ?? []).filter((d) => Math.abs(d.createdMs - event.createdMs) <= SAME_EVENT_MS);
const firstDelivered = (event: AlertEvent) => {
  const times = eventDeliveries(event).filter((d) => d.status === 'delivered' && Number.isFinite(d.sentMs)).map((d) => d.sentMs);
  return times.length ? Math.min(...times) : Number.NaN;
};

// ------------------------------------------------------------------- volume

for (const window of windows) {
  const rows = eventList.filter((event) => inWindow(event.createdMs, window.from));
  const id = `alerts.${window.key}`;
  bench.metric(`${id}.events`, `Alert events (alert:N keys, ${window.key})`, rows.length, 'count', 'info');
  bench.metric(`${id}.listings`, `Distinct alerted watch listings (${window.key})`, new Set(rows.map(eventListingKey)).size, 'count', 'info');
  if (window.key === 'recent') bench.metric(`${id}.events_per_day`, `Alert events per day (last ${RECENT_DAYS} d)`, rows.length / RECENT_DAYS, 'count', 'info');
  bench.metric(`${id}.night_share`, `Alert events raised 22:00–08:00 local (${window.key})`, rows.length ? rows.filter((event) => clock.isNight(event.createdMs)).length / rows.length : null, 'ratio', 'info');
  for (const marketplace of MARKETPLACES) bench.metric(`${id}.${mpKey(marketplace)}.events`, `${marketplace} alert events (${window.key})`, rows.filter((event) => event.marketplace === marketplace).length, 'count', 'info');
}
{
  const byWeek = new Map<string, Record<string, number>>();
  for (const delivery of deliveries) {
    if (!delivery.event) continue;
    const week = isoWeek(new Date(delivery.event.createdMs).toISOString());
    const row = byWeek.get(week) ?? { delivered: 0, failed: 0, attempts: 0, exceptional: 0, very_strong: 0 };
    if (delivery.status === 'delivered') row.delivered += 1;
    else row.failed += 1;
    row.attempts += delivery.attempts;
    if (delivery.event.priority === 'exceptional') row.exceptional += 1;
    else if (delivery.event.priority === 'very-strong') row.very_strong += 1;
    byWeek.set(`${week}|${delivery.channel}`, row);
  }
  bench.table('deliveries_by_week', [...byWeek.entries()].sort().map(([key, row]) => ({ week: key.split('|')[0], channel: key.split('|')[1], ...row })));
  const byWatch = new Map<string, { events: number; listings: Set<string>; realerts: number }>();
  for (const event of eventList) {
    const row = byWatch.get(event.watchId) ?? { events: 0, listings: new Set<string>(), realerts: 0 };
    row.events += 1;
    row.listings.add(eventListingKey(event));
    if (event.sequence > 1) row.realerts += 1;
    byWatch.set(event.watchId, row);
  }
  bench.table('events_by_watch', [...byWatch.entries()].map(([watchId, row]) => ({
    watch: watches.get(watchId)?.name ?? '(deleted)', enabled: watches.get(watchId)?.enabled ? 'yes' : 'no',
    events: row.events, listings: row.listings.size, realert_events: row.realerts,
  })).sort((a, b) => b.events - a.events));
}

// --------------------------------------------------------- delivery outcome

for (const window of windows) {
  for (const channel of CHANNELS) {
    const rows = deliveries.filter((d) => d.channel === channel && inWindow(d.createdMs, window.from));
    const id = `alerts.${window.key}.${channel.toLowerCase()}`;
    const delivered = rows.filter((d) => d.status === 'delivered');
    bench.metric(`${id}.deliveries`, `${channel} alert deliveries (${window.key})`, rows.length, 'count', 'info');
    bench.metric(`${id}.delivered_share`, `${channel} deliveries that eventually succeeded (${window.key})`, rows.length ? delivered.length / rows.length : null, 'ratio', 'higher');
    bench.metric(`${id}.first_attempt_share`, `${channel} deliveries that succeeded on the first attempt (${window.key})`, rows.length ? delivered.filter((d) => d.attempts === 1).length / rows.length : null, 'ratio', 'higher');
    bench.metric(`${id}.gave_up`, `${channel} deliveries abandoned after 5 attempts (${window.key})`, rows.filter((d) => d.status === 'failed' && d.attempts >= 5).length, 'count', 'lower');
    bench.metric(`${id}.extra_attempts`, `${channel} attempts beyond the first (${window.key})`, rows.reduce((sum, d) => sum + Math.max(0, d.attempts - 1), 0), 'count', 'lower');
    const firstTry = delivered.filter((d) => d.attempts === 1 && Number.isFinite(d.sentMs));
    bench.distributionMetrics(`${id}.send_s`, `${channel} claim → delivered, first-attempt deliveries (${window.key})`, distribution(firstTry.map((d) => seconds(d.sentMs - d.createdMs))), 's', 'lower', ['p50', 'p90', 'max']);
    const retried = delivered.filter((d) => d.attempts > 1 && Number.isFinite(d.sentMs));
    bench.distributionMetrics(`${id}.retried_delay_s`, `${channel} claim → delivered when a retry was needed (${window.key})`, distribution(retried.map((d) => seconds(d.sentMs - d.createdMs))), 's', 'lower', ['p50', 'max']);
  }
}
{
  const clusters = new Map<string, { channel: string; cluster: string; deliveries: number; attempts: number; delivered: number; first: string; last: string }>();
  for (const delivery of deliveries) {
    if (!delivery.message) continue;
    const key = `${delivery.channel}|${errorCluster(delivery.message)}`;
    const iso = new Date(delivery.createdMs).toISOString().slice(0, 16);
    const row = clusters.get(key) ?? { channel: delivery.channel, cluster: errorCluster(delivery.message), deliveries: 0, attempts: 0, delivered: 0, first: iso, last: iso };
    row.deliveries += 1;
    row.attempts += delivery.attempts;
    if (delivery.status === 'delivered') row.delivered += 1;
    if (iso < row.first) row.first = iso;
    if (iso > row.last) row.last = iso;
    clusters.set(key, row);
  }
  bench.table('delivery_errors', [...clusters.values()].sort((a, b) => b.attempts - a.attempts));
  // Both channels of one event are claimed in one synchronous loop (server/service.ts:7789-7794), so their claim times should match.
  const skew: number[] = [];
  let late = 0;
  for (const list of deliveriesByEvent.values()) {
    if (list.length < 2) continue;
    const created = list.map((d) => d.createdMs);
    const gap = Math.max(...created) - Math.min(...created);
    if (gap > SAME_EVENT_MS) late += 1;
    else skew.push(seconds(gap));
  }
  bench.metric('alerts.all.channel_claim_skew_s.p90', 'Claim-time gap between the two channels of one alert event p90', distribution(skew).p90, 's', 'lower');
  bench.metric('alerts.all.events_reused_by_later_channel', 'alert:N rows a second channel reused >1 min later (its own price and time are not recorded in notifications)', late, 'count', 'lower');
}

// ----------------------------------------------------------------- pipeline

{
  interface PipelineRow { event: AlertEvent; scan: ScanRow; info: ListingInfo | undefined; firstSight: boolean; deliveredMs: number }
  const rows: PipelineRow[] = [];
  let unmatched = 0;
  for (const event of eventList) {
    const scan = originScan(event);
    if (!scan) { unmatched += 1; continue; }
    const info = listingInfo.get(eventListingKey(event));
    // First sight: the listing's first store happened in the scan that raised the alert.
    const firstSight = Boolean(info && info.firstMs >= scan.startMs - 1000 && info.firstMs <= event.createdMs + 1000);
    rows.push({ event, scan, info, firstSight, deliveredMs: firstDelivered(event) });
  }
  bench.metric('alerts.all.pipeline.unmatched_events', 'Alert events with no watch scan of the pair started ≤15 min earlier (retries, deleted scans)', unmatched, 'count', 'info');
  for (const window of windows) {
    const scoped = rows.filter((row) => inWindow(row.event.createdMs, window.from));
    const id = `alerts.${window.key}.pipeline`;
    const firsts = scoped.filter((row) => row.event.sequence === 1);
    bench.metric(`${id}.first_sight_share`, `alert:1 events raised by the scan that first stored the listing (${window.key})`, firsts.length ? firsts.filter((row) => row.firstSight).length / firsts.length : null, 'ratio', 'info');
    bench.distributionMetrics(`${id}.scan_start_to_alert_s`, `Scan start → alert row (fetch, AI relevance, store, verification) (${window.key})`, distribution(scoped.map((row) => seconds(row.event.createdMs - row.scan.startMs))), 's', 'lower', ['p50', 'p90', 'max']);
    bench.distributionMetrics(`${id}.scan_end_to_alert_s`, `Scan completed → alert row (description verification + queueing) (${window.key})`, distribution(scoped.filter((row) => Number.isFinite(row.scan.endMs)).map((row) => seconds(row.event.createdMs - row.scan.endMs))), 's', 'lower', ['p50', 'p90', 'max']);
    bench.distributionMetrics(`${id}.scan_start_to_delivered_s`, `Scan start → first channel delivered (${window.key})`, distribution(scoped.filter((row) => Number.isFinite(row.deliveredMs)).map((row) => seconds(row.deliveredMs - row.scan.startMs))), 's', 'lower', ['p50', 'p90', 'max']);
    for (const marketplace of MARKETPLACES) {
      const mp = firsts.filter((row) => row.event.marketplace === marketplace && row.firstSight && Number.isFinite(row.deliveredMs));
      bench.metric(`${id}.${mpKey(marketplace)}.first_sight_to_delivered_s.p50`, `${marketplace} first stored → delivered, first-sight alert:1 (${window.key})`, distribution(mp.map((row) => seconds(row.deliveredMs - (row.info as ListingInfo).firstMs))).p50, 's', 'lower');
    }
    const olx = firsts.filter((row) => row.event.marketplace === 'OLX' && row.firstSight && row.info && Number.isFinite(row.info.postedMs) && Number.isFinite(row.deliveredMs)
      && row.deliveredMs - (row.info as ListingInfo).postedMs < 86_400_000);
    bench.distributionMetrics(`${id}.olx.posted_to_delivered_min`, `OLX posting → alert delivered, first-sight alert:1 (${window.key})`, distribution(olx.map((row) => minutes(row.deliveredMs - (row.info as ListingInfo).postedMs))), 'min', 'lower', ['p50', 'p90']);
  }
  // Slowest alert events, for inspection.
  bench.table('slowest_alerts_recent', rows.filter((row) => inWindow(row.event.createdMs, recentFrom))
    .map((row) => ({
      created: new Date(row.event.createdMs).toISOString().slice(0, 19), marketplace: row.event.marketplace, seq: row.event.sequence, priority: row.event.priority,
      scan_s: Number.isFinite(row.scan.endMs) ? round(seconds(row.scan.endMs - row.scan.startMs)) : null,
      scan_end_to_alert_s: Number.isFinite(row.scan.endMs) ? round(seconds(row.event.createdMs - row.scan.endMs)) : null,
      alert_to_delivered_s: Number.isFinite(row.deliveredMs) ? round(seconds(row.deliveredMs - row.event.createdMs)) : null,
      verification: row.info?.verification ?? null,
    }))
    .sort((a, b) => (b.scan_end_to_alert_s ?? 0) + (b.alert_to_delivered_s ?? 0) - (a.scan_end_to_alert_s ?? 0) - (a.alert_to_delivered_s ?? 0))
    .slice(0, 10));
}

// ---------------------------------------------------------------- re-alerts

{
  // Per listing and channel, consecutive alert sequences. shouldAlert (server/service.ts:7644) re-fires on a ≥5% price
  // drop or a higher priority; planDealNotification (server/service.ts:7749-7755) also starts a new sequence after a give-up.
  const byListingChannel = new Map<string, Delivery[]>();
  for (const delivery of deliveries) {
    if (!delivery.event) continue;
    const key = `${eventListingKey(delivery.event)}|${delivery.channel}`;
    const list = byListingChannel.get(key);
    if (list) list.push(delivery);
    else byListingChannel.set(key, [delivery]);
  }
  const counts = { price_drop: 0, priority_up: 0, after_give_up: 0, after_give_up_unchanged: 0, unexplained: 0 };
  let maxAttempts = 0;
  let maxAttemptsKey = '';
  const unexplained: Array<Record<string, unknown>> = [];
  for (const [key, list] of byListingChannel) {
    list.sort((a, b) => (a.event as AlertEvent).sequence - (b.event as AlertEvent).sequence);
    const attempts = list.reduce((sum, d) => sum + d.attempts, 0);
    if (attempts > maxAttempts) { maxAttempts = attempts; maxAttemptsKey = key; }
    let lastDelivered: Delivery | null = null;
    for (let i = 0; i < list.length; i += 1) {
      const current = list[i];
      const event = current.event as AlertEvent;
      if (i > 0) {
        const previous = list[i - 1];
        const reference = lastDelivered?.event;
        const priceDrop = reference?.price !== null && reference?.price !== undefined && event.price !== null && event.price <= reference.price * 0.95;
        const priorityUp = reference?.priority && event.priority && (PRIORITY_RANK[event.priority] ?? 0) > (PRIORITY_RANK[reference.priority] ?? 0);
        if (previous.status === 'failed' && previous.attempts >= 5) {
          counts.after_give_up += 1;
          const before = previous.event as AlertEvent;
          if (before.price === event.price && before.priority === event.priority) counts.after_give_up_unchanged += 1;
        } else if (priceDrop) counts.price_drop += 1;
        else if (priorityUp) counts.priority_up += 1;
        else {
          counts.unexplained += 1;
          unexplained.push({ key, seq: event.sequence, created: new Date(event.createdMs).toISOString().slice(0, 16), price: event.price, priority: event.priority, previous_price: reference?.price ?? null, previous_priority: reference?.priority ?? null });
        }
      }
      if (current.status === 'delivered') lastDelivered = current;
    }
  }
  bench.metric('alerts.all.realerts.price_drop', 'Re-alerts after a ≥5% price drop since the last delivered alert', counts.price_drop, 'count', 'info');
  bench.metric('alerts.all.realerts.priority_up', 'Re-alerts after the priority tier rose', counts.priority_up, 'count', 'info');
  bench.metric('alerts.all.realerts.after_give_up', 'New alert sequences started because the previous one gave up after 5 attempts', counts.after_give_up, 'count', 'lower');
  bench.metric('alerts.all.realerts.after_give_up_unchanged', '… of which price and priority were unchanged (same alert, more attempts)', counts.after_give_up_unchanged, 'count', 'lower');
  bench.metric('alerts.all.realerts.unexplained', 'Re-alerts with no price drop, priority rise or give-up before them', counts.unexplained, 'count', 'lower');
  bench.metric('alerts.all.retry.max_attempts_one_listing_channel', 'Most delivery attempts spent on one listing in one channel', maxAttempts, 'count', 'lower', maxAttemptsKey);
  if (unexplained.length) bench.table('realerts_unexplained', unexplained.slice(0, 20));
  // Attempts on errors a retry cannot fix: HTTP 4xx other than 408/429 (a bad payload or a deleted webhook).
  const permanent = deliveries.filter((d) => d.message && /returned 4(?!08|29)\d\d/.test(d.message));
  bench.metric('alerts.all.retry.attempts_on_http_4xx', 'Delivery attempts whose recorded error was a non-retryable HTTP 4xx', permanent.reduce((sum, d) => sum + d.attempts, 0), 'count', 'lower');
  bench.metric('alerts.all.retry.retryable_failures_recovered', 'Deliveries that failed at least once on a network error and later succeeded', deliveries.filter((d) => d.status === 'delivered' && d.attempts > 1).length, 'count', 'info');
}

// ------------------------------------------------------------------ quality

{
  for (const window of windows) {
    const alerted = new Map<string, { event: AlertEvent; deliveredMs: number }>();
    for (const event of eventList) {
      if (!inWindow(event.createdMs, window.from)) continue;
      const key = eventListingKey(event);
      const delivered = firstDelivered(event);
      if (!Number.isFinite(delivered)) continue;
      const existing = alerted.get(key);
      if (!existing || delivered < existing.deliveredMs) alerted.set(key, { event, deliveredMs: delivered });
    }
    const id = `alerts.${window.key}.quality`;
    const infos = [...alerted.entries()].map(([key, value]) => ({ ...value, info: listingInfo.get(key) })).filter((row) => row.info) as Array<{ event: AlertEvent; deliveredMs: number; info: ListingInfo }>;
    bench.metric(`${id}.alerted_listings`, `Watch listings with a delivered alert (${window.key})`, infos.length, 'count', 'info');
    bench.metric(`${id}.hidden_share`, `Alerted listings the operator later hid (listing_actions.hidden) (${window.key})`, infos.length ? infos.filter((row) => row.info.hidden).length / infos.length : null, 'ratio', 'lower');
    bench.metric(`${id}.flagged`, `Alerted listings carrying a junk flag (for parts, damaged, wanted ad) (${window.key})`, infos.filter((row) => row.info.flagged).length, 'count', 'lower');
    bench.metric(`${id}.verification_unknown_or_reject`, `Alerted listings whose stored verification is unknown/reject now (${window.key})`, infos.filter((row) => row.info.verification === 'unknown' || row.info.verification === 'reject').length, 'count', 'info');
    for (const marketplace of MARKETPLACES) {
      const rows = infos.filter((row) => row.info.marketplace === marketplace && row.info.lastMs <= nowMs - 6 * 3_600_000);
      bench.metric(`${id}.${mpKey(marketplace)}.visible_after_alert_h.p50`, `${marketplace} alert delivered → listing last seen, p50 (gone listings only) (${window.key})`, distribution(rows.map((row) => Math.max(0, hours(row.info.lastMs - row.deliveredMs)))).p50, 'h', 'info');
      bench.metric(`${id}.${mpKey(marketplace)}.gone_within_1h_share`, `${marketplace} alerted listings last seen <1 h after the alert (${window.key})`, rows.length ? rows.filter((row) => row.info.lastMs - row.deliveredMs < 3_600_000).length / rows.length : null, 'ratio', 'info');
    }
  }
}

// ------------------------------------------------------------------- funnel

{
  // Per watch listing: the strongest scored observation (discount_percent is only written once the watch's own
  // baseline is ready, server/service.ts:7425-7430) and the first time it crossed each alert tier.
  const obs = all<{ watch_id: string; listing_id: number; observed_at: string; discount_percent: number; deal_strength: number | null; price_pln: number; baseline_pln: number | null }>(db,
    'SELECT watch_id, listing_id, observed_at, discount_percent, deal_strength, price_pln, baseline_pln FROM observations WHERE discount_percent IS NOT NULL ORDER BY id');
  const byRowId = new Map<string, ListingInfo>();
  for (const info of listingInfo.values()) byRowId.set(`${info.watchId}|${info.listingRowId}`, info);
  interface Peak { info: ListingInfo; maxDiscount: number; maxStrength: number; first20Ms: number; first18Ms: number; maxSavingPln: number }
  const peaks = new Map<string, Peak>();
  for (const row of obs) {
    const info = byRowId.get(`${row.watch_id}|${row.listing_id}`);
    if (!info) continue;
    const key = `${info.watchId}|${info.marketplace}|${info.externalId}`;
    const at = Date.parse(row.observed_at);
    const peak = peaks.get(key) ?? { info, maxDiscount: Number.NEGATIVE_INFINITY, maxStrength: 0, first20Ms: Number.NaN, first18Ms: Number.NaN, maxSavingPln: 0 };
    peak.maxDiscount = Math.max(peak.maxDiscount, row.discount_percent);
    peak.maxStrength = Math.max(peak.maxStrength, row.deal_strength ?? 0);
    if (row.baseline_pln !== null) peak.maxSavingPln = Math.max(peak.maxSavingPln, row.baseline_pln - row.price_pln);
    if (row.discount_percent >= 20 && !Number.isFinite(peak.first20Ms)) peak.first20Ms = at;
    if (row.discount_percent >= 18 && !Number.isFinite(peak.first18Ms)) peak.first18Ms = at;
    peaks.set(key, peak);
  }
  const alertedAt = new Map<string, number>();
  for (const event of eventList) {
    const delivered = firstDelivered(event);
    if (!Number.isFinite(delivered)) continue;
    const key = eventListingKey(event);
    alertedAt.set(key, Math.min(alertedAt.get(key) ?? Number.POSITIVE_INFINITY, delivered));
  }
  const firstEventAt = new Map<string, number>();
  for (const event of eventList) firstEventAt.set(eventListingKey(event), Math.min(firstEventAt.get(eventListingKey(event)) ?? Number.POSITIVE_INFINITY, event.createdMs));
  for (const window of windows) {
    const id = `alerts.${window.key}.funnel`;
    const tier = [...peaks.entries()].filter(([, peak]) => Number.isFinite(peak.first20Ms) && inWindow(peak.first20Ms, window.from));
    const reasons = { alerted: 0, alert_attempted_failed: 0, hidden: 0, verification_reject: 0, verification_unknown: 0, unexplained: 0 };
    const unexplainedRows: Array<Record<string, unknown>> = [];
    const qualifyToAlert: number[] = [];
    for (const [key, peak] of tier) {
      if (alertedAt.has(key)) {
        reasons.alerted += 1;
        qualifyToAlert.push(minutes((alertedAt.get(key) as number) - peak.first20Ms));
      } else if (firstEventAt.has(key)) reasons.alert_attempted_failed += 1;
      else if (peak.info.hidden) reasons.hidden += 1;
      else if (peak.info.verification === 'reject') reasons.verification_reject += 1;
      else if (peak.info.verification === 'unknown') reasons.verification_unknown += 1;
      else {
        reasons.unexplained += 1;
        unexplainedRows.push({ watch: watches.get(peak.info.watchId)?.name ?? '(deleted)', marketplace: peak.info.marketplace, listing: peak.info.externalId, first_20pct: new Date(peak.first20Ms).toISOString().slice(0, 16), max_discount: round(peak.maxDiscount), max_strength: peak.maxStrength, verification: peak.info.verification });
      }
    }
    bench.metric(`${id}.reached_20pct`, `Watch listings whose scored asking price reached ≥20% below typical (${window.key})`, tier.length, 'count', 'info');
    // How long each outcome stayed listed after it first reached 20%: a blocked deal that vanishes as fast as alerted
    // ones was probably as attractive to other buyers (or removed by the marketplace; "gone" is not "sold").
    const lifetimeRows: Array<Record<string, unknown>> = [];
    const outcomeOf = (key: string, peak: Peak) => alertedAt.has(key) ? 'alerted' : peak.info.hidden ? 'hidden' : peak.info.verification === 'reject' ? 'verification_reject' : peak.info.verification === 'unknown' ? 'verification_unknown' : 'other';
    for (const outcome of ['alerted', 'verification_reject', 'verification_unknown']) {
      for (const marketplace of MARKETPLACES) {
        const rows = tier.filter(([key, peak]) => outcomeOf(key, peak) === outcome && peak.info.marketplace === marketplace && peak.info.lastMs <= nowMs - 6 * 3_600_000);
        if (!rows.length) continue;
        lifetimeRows.push({
          outcome, marketplace, listings: rows.length,
          gone_within_1h_pct: pct(rows.filter(([, peak]) => peak.info.lastMs - peak.first20Ms < 3_600_000).length, rows.length),
          visible_h_p50: round(distribution(rows.map(([, peak]) => hours(Math.max(0, peak.info.lastMs - peak.first20Ms)))).p50, 2),
          max_discount_p50: round(distribution(rows.map(([, peak]) => peak.maxDiscount)).p50),
        });
        if (window.key === 'recent' && outcome !== 'alerted') {
          bench.metric(`${id}.${outcome}.${mpKey(marketplace)}.gone_within_1h_share`, `${marketplace} ≥20% listings blocked by ${outcome.replace(/_/g, ' ')} and gone <1 h later (${window.key})`, rows.filter(([, peak]) => peak.info.lastMs - peak.first20Ms < 3_600_000).length / rows.length, 'ratio', 'info');
        }
      }
    }
    bench.table(`funnel_lifetime_${window.key}`, lifetimeRows);
    for (const [reason, n] of Object.entries(reasons)) bench.metric(`${id}.reached_20pct.${reason}`, `… ${reason.replace(/_/g, ' ')} (${window.key})`, n, 'count', reason === 'unexplained' ? 'lower' : 'info');
    bench.distributionMetrics(`${id}.first_20pct_to_delivered_min`, `First ≥20% observation → first delivered alert (${window.key})`, distribution(qualifyToAlert), 'min', 'lower', ['p50', 'p90']);
    // Strength 4–5 ("Very strong"/"Exceptional" in the feed, server/scoring.ts:121-146) blends PLN saved with the percentage,
    // but alerts gate on percentage alone (≥18% to qualify, ≥20% for very-strong): expensive listings can be top-tier deals that never alert.
    const strongNoAlert = [...peaks.entries()].filter(([key, peak]) => peak.maxStrength >= 4 && peak.maxDiscount < 18 && !alertedAt.has(key)
      && inWindow(peak.info.firstMs, window.from));
    bench.metric(`${id}.strength4_below_18pct`, `Listings scored Very strong+ in the feed but under the 18% alert gate (${window.key})`, strongNoAlert.length, 'count', 'info');
    bench.metric(`${id}.strength4_below_18pct.saving_pln.p50`, `… their best asking-price saving vs typical, p50 (${window.key})`, distribution(strongNoAlert.map(([, peak]) => peak.maxSavingPln)).p50, 'PLN', 'info');
    if (window.key === 'recent') bench.table('strength4_below_18pct_recent', strongNoAlert.map(([, peak]) => ({
      watch: watches.get(peak.info.watchId)?.name ?? '(deleted)', marketplace: peak.info.marketplace, listing: peak.info.externalId,
      price_now: peak.info.price, max_discount: round(peak.maxDiscount), saving_pln: round(peak.maxSavingPln, 0), max_strength: peak.maxStrength,
      visible_h: round(hours(peak.info.lastMs - peak.info.firstMs), 1),
    })));
    if (window.key === 'all') bench.table('funnel_unexplained', unexplainedRows.slice(0, 25));
  }
}

// ------------------------------------------------------------- digest, flips

{
  const config = one<{ value?: string }>(db, "SELECT value FROM settings WHERE key = 'daily_digest_config'")?.value ?? null;
  let enabled: boolean | null = null;
  try { enabled = config ? Boolean((JSON.parse(config) as { enabled?: boolean }).enabled) : null; } catch { enabled = null; }
  bench.metric('alerts.digest.enabled', 'Daily digest enabled (1/0)', enabled === null ? null : Number(enabled), 'flag', 'info');
  bench.metric('alerts.digest.candidates', 'Daily digest candidate rows', scalar(db, 'SELECT COUNT(*) FROM daily_digest_candidates'), 'count', 'info');
  bench.metric('alerts.digest.pending_while_disabled', 'Digest candidates never sent, left from when the digest was on', enabled === false ? scalar(db, 'SELECT COUNT(*) FROM daily_digest_candidates WHERE digest_date IS NULL') : 0, 'count', 'info');
  const flips = all<{ id: number; listing_key: string | null; watch_id: string | null; buy_channel: string }>(db, 'SELECT id, listing_key, watch_id, buy_channel FROM flips');
  bench.metric('alerts.flips.total', 'Flips recorded (thin ground truth)', flips.length, 'count', 'info');
  let linked = 0;
  let linkedAlerted = 0;
  for (const flip of flips) {
    if (!flip.listing_key || !flip.watch_id) continue;
    linked += 1;
    const [marketplace, ...rest] = flip.listing_key.split(':');
    if (alertedListing(flip.watch_id, marketplace, rest.join(':'))) linkedAlerted += 1;
  }
  bench.metric('alerts.flips.linked_to_listing', 'Flips linked to a Scout listing', linked, 'count', 'higher');
  bench.metric('alerts.flips.linked_and_alerted', 'Linked flips whose listing had a delivered alert', linkedAlerted, 'count', 'info');
}
function alertedListing(watchId: string, marketplace: string, listingId: string) {
  return eventList.some((event) => event.watchId === watchId && event.marketplace === marketplace && event.listingId === listingId && Number.isFinite(firstDelivered(event)));
}

// --------------------------------------------------------------------- logs

{
  // The export copies service.logs(), an in-memory ring of LOG_BUFFER_LIMIT = 500 lines (server/service.ts:302, :1079;
  // server/improvementExport.ts:186), so it holds only what happened since the last restart.
  const rows = all<{ at: string; message: string }>(db, 'SELECT at, message FROM export_logs ORDER BY id');
  bench.metric('export.logs.rows', 'Log lines carried in the export', rows.length, 'count', 'higher');
  const exportedAt = exportInfo(db, 'exported_at');
  const started = rows.find((row) => row.message.startsWith('started'));
  bench.metric('export.logs.process_uptime_s', 'Process uptime at export, from the "started" log line', started && exportedAt ? seconds(Date.parse(exportedAt) - Date.parse(started.at)) : null, 's', 'info');
  bench.metric('export.logs.oldest_line_age_h', 'Age of the oldest exported log line', rows.length && exportedAt ? hours(Date.parse(exportedAt) - Date.parse(rows[0].at)) : null, 'h', 'higher');
  const errors7d = scalar(db, "SELECT COUNT(*) FROM scans WHERE status = 'failed' AND started_at >= ?", bench.daysAgo(7));
  bench.metric('export.logs.failed_scans_7d_without_log', 'Failed scans in the last 7 days (each logs one error line, server/service.ts:6690) with no log line left', Math.max(0, (errors7d ?? 0) - rows.filter((row) => Date.parse(row.at) >= Date.parse(bench.daysAgo(7))).length), 'count', 'lower');
}

bench.note('Alert events are notifications rows keyed watch|marketplace|listing|alert:N; test- and digest: rows are excluded. Deliveries are per channel (…|channel:X).');
bench.note('Funnel uses observations.discount_percent, written only once a watch\'s own baseline is ready, and today\'s hidden/verification state; channel minimum priorities changed over time (ntfy carried very-strong alerts in Sep–Nov), so "unexplained" can include alerts suppressed by the settings of the day.');
bench.note('Ground truth is thin: 5 flips (1 linked), 41 listing_actions (40 hidden), 0 negotiation outcomes. Prices are asking prices; "gone" means no longer returned on the first result page, not sold.');
bench.finish();
