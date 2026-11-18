import test from 'node:test';
import assert from 'node:assert/strict';
import { DeliveryRejectedError, assertDeliveryResponse, isPermanentDeliveryStatus } from '../server/notifications';
import { alertFixture, deliveries, listing, seedWatch, stubChannels } from './alertFixture';
// A channel's permanent refusal is not retried.

test('classifies 4xx other than 408 and 429 as permanent delivery refusals', () => {
  for (const status of [400, 401, 403, 404, 410, 413, 422]) assert.equal(isPermanentDeliveryStatus(status), true, String(status));
  for (const status of [200, 204, 301, 408, 429, 500, 502, 503]) assert.equal(isPermanentDeliveryStatus(status), false, String(status));
  assert.throws(() => assertDeliveryResponse('Discord', 400), (error: unknown) => error instanceof DeliveryRejectedError && error.message === 'Discord returned 400');
  assert.throws(() => assertDeliveryResponse('ntfy', 429), (error: unknown) => !(error instanceof DeliveryRejectedError) && (error as Error).message === 'ntfy returned 429');
  assert.doesNotThrow(() => assertDeliveryResponse('Discord', 204));
});

test('a Discord 400 is not retried and does not restart the alert sequence for the same listing', async () => {
  const context = alertFixture();
  const channels = stubChannels(() => 400);
  try {
    seedWatch(context.db, 'reject-watch');
    context.service.saveSettings({ webhook: 'https://discord.com/api/webhooks/123/token' });
    const notifyDeal = (context.service as any).notifyDeal.bind(context.service) as (...args: any[]) => Promise<void>;
    await notifyDeal('reject-watch', listing('bad-payload', 800), 1000, 20, 90);
    assert.equal(channels.calls.length, 1);
    assert.deepEqual(deliveries(context.db).map(({ listing_key, status, attempt_count, next_attempt_at }) => ({ listing_key, status, attempt_count, next_attempt_at })), [
      { listing_key: 'reject-watch|OLX|bad-payload|alert:1|channel:Discord', status: 'rejected', attempt_count: 1, next_attempt_at: null },
    ]);
    assert.equal(deliveries(context.db)[0].message, 'Discord returned 400');
    // Neither the retry loop nor later scans of the unchanged listing send it again.
    context.db.prepare('UPDATE notification_deliveries SET updated_at = ?').run(new Date(Date.now() - 60 * 60_000).toISOString());
    await (context.service as any).processNotificationRetries();
    await notifyDeal('reject-watch', listing('bad-payload', 800), 1000, 20, 90);
    await notifyDeal('reject-watch', listing('bad-payload', 790), 1000, 21, 90);
    assert.equal(channels.calls.length, 1);
    assert.equal(deliveries(context.db).length, 1);
    // The channel's status says so.
    const discord = context.service.getConnectors().find((connector) => connector.name === 'Discord')!;
    assert.equal(discord.status, 'Degraded');
    assert.match(discord.detail, /Discord returned 400: rejected, not retried/);
    // A real improvement (5% cheaper) is a new alert and is tried again.
    await notifyDeal('reject-watch', listing('bad-payload', 750), 1000, 25, 90);
    assert.equal(channels.calls.length, 2);
    assert.equal(deliveries(context.db).at(-1)?.listing_key, 'reject-watch|OLX|bad-payload|alert:2|channel:Discord');
  } finally {
    channels.restore();
    context.close();
  }
});

test('an ntfy 404 is refused for good; transient errors keep retrying and re-sequencing after give-up', async () => {
  const context = alertFixture();
  let status = 404;
  const channels = stubChannels(() => status);
  try {
    seedWatch(context.db, 'ntfy-watch');
    context.service.saveSettings({ ntfy: { serverUrl: 'https://ntfy.sh', topic: 'scout-deals', minimumPriority: 'strong' } });
    const notifyDeal = (context.service as any).notifyDeal.bind(context.service) as (...args: any[]) => Promise<void>;
    await notifyDeal('ntfy-watch', listing('gone-topic'), 1000, 20, 90);
    assert.equal(deliveries(context.db)[0].status, 'rejected');
    assert.match(context.service.getConnectors().find((connector) => connector.name === 'ntfy')!.detail, /ntfy returned 404: rejected, not retried\. Check the ntfy topic and token/);

    // A 503 is transient: retried with backoff, as before.
    status = 503;
    await notifyDeal('ntfy-watch', listing('outage'), 1000, 20, 90);
    const failed = deliveries(context.db).at(-1)!;
    assert.equal(failed.status, 'failed');
    assert.ok(failed.next_attempt_at);
    status = 200;
    context.db.prepare('UPDATE notification_deliveries SET next_attempt_at = ? WHERE listing_key = ?').run(new Date(Date.now() - 1_000).toISOString(), failed.listing_key);
    await (context.service as any).processNotificationRetries();
    assert.equal(deliveries(context.db).at(-1)!.status, 'delivered');

    // After a transient give-up the unchanged listing still starts a new sequence (it rescued the Oct 6 ntfy outage).
    status = 503;
    await notifyDeal('ntfy-watch', listing('long-outage'), 1000, 20, 90);
    context.db.prepare("UPDATE notification_deliveries SET attempt_count = 5, next_attempt_at = NULL WHERE listing_key LIKE '%long-outage%'").run();
    status = 200;
    await notifyDeal('ntfy-watch', listing('long-outage'), 1000, 20, 90);
    assert.deepEqual(deliveries(context.db).filter((row) => row.listing_key.includes('long-outage')).map((row) => [row.listing_key, row.status]), [
      ['ntfy-watch|OLX|long-outage|alert:1|channel:ntfy', 'failed'],
      ['ntfy-watch|OLX|long-outage|alert:2|channel:ntfy', 'delivered'],
    ]);
  } finally {
    channels.restore();
    context.close();
  }
});

// Each alert sequence has its own row; only channels alerting together share it.

test('a channel that starts alerting later gets its own alert row, not another channel\'s older one', async () => {
  const context = alertFixture();
  const channels = stubChannels(() => 204);
  try {
    seedWatch(context.db, 'two-channels');
    context.service.saveSettings({ webhook: 'https://discord.com/api/webhooks/123/token' });
    const notifyDeal = (context.service as any).notifyDeal.bind(context.service) as (...args: any[]) => Promise<void>;
    await notifyDeal('two-channels', listing('shared', 800), 1000, 20, 90);
    await notifyDeal('two-channels', listing('shared', 750), 1000, 25, 90);
    // ntfy is configured afterwards: Discord has nothing new to say, ntfy alerts for the first time.
    context.service.saveSettings({ ntfy: { serverUrl: 'https://ntfy.sh', topic: 'scout-deals', minimumPriority: 'strong' } });
    await notifyDeal('two-channels', listing('shared', 750), 1000, 25, 90);
    assert.deepEqual(deliveries(context.db).map((row) => row.listing_key), [
      'two-channels|OLX|shared|alert:1|channel:Discord',
      'two-channels|OLX|shared|alert:2|channel:Discord',
      'two-channels|OLX|shared|alert:3|channel:ntfy',
    ]);
    const payloads = context.db.prepare('SELECT listing_key, payload_json FROM notifications ORDER BY id').all() as Array<{ listing_key: string; payload_json: string }>;
    assert.deepEqual(payloads.map((row) => [row.listing_key, JSON.parse(row.payload_json)._scout.listing.price]), [
      ['two-channels|OLX|shared|alert:1', 800],
      ['two-channels|OLX|shared|alert:2', 750],
      ['two-channels|OLX|shared|alert:3', 750],
    ]);
    // Both channels alerting together still share one event row.
    await notifyDeal('two-channels', listing('shared', 700), 1000, 30, 95);
    assert.deepEqual(deliveries(context.db).slice(-2).map((row) => row.listing_key).sort(), [
      'two-channels|OLX|shared|alert:4|channel:Discord',
      'two-channels|OLX|shared|alert:4|channel:ntfy',
    ]);
  } finally {
    channels.restore();
    context.close();
  }
});
