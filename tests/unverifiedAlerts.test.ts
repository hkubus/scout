import test from 'node:test';
import assert from 'node:assert/strict';
import { compactListing } from '../server/deals';
import { buildDiscordEmbed, buildNtfyPayload, descriptionUnverifiedReason } from '../server/notifications';
import type { Listing } from '../src/types';
import { alertFixture, deliveries, listing, seedWatch, stubChannels } from './alertFixture';

// The legacy DeepSeek path keeps verification to one stubbed call.
if (process.env.SCOUT_JEV_MODE === undefined) process.env.SCOUT_JEV_MODE = 'legacy';

// A description check without a verdict alerts, marked unverified; a reject holds it.

test('describes why a description check gave no verdict', () => {
  assert.equal(descriptionUnverifiedReason({ status: 'pass' }), null);
  assert.equal(descriptionUnverifiedReason({ status: 'reject', verification: { issues: ['Cracked'] } }), null);
  assert.equal(descriptionUnverifiedReason({ status: null }), null);
  assert.equal(descriptionUnverifiedReason({ status: 'fallback', error: 'OpenRouter returned 502' }), 'AI check unavailable (provider outage)');
  assert.equal(descriptionUnverifiedReason({ status: 'unknown', verification: { issues: ['No photo of the card powered on'], summary: 'Jev was unsure.' } }), 'inconclusive: No photo of the card powered on');
  assert.equal(descriptionUnverifiedReason({ status: 'unknown', verification: { issues: [], summary: 'Jev was unsure.' } }), 'inconclusive: Jev was unsure.');
  assert.equal(descriptionUnverifiedReason({ status: 'unknown', error: 'Vinted authenticated session failed: page.goto: Timeout 25000ms exceeded.\nCall log: …' }), 'check failed: Vinted authenticated session failed: page.goto: Timeout 25000ms exceeded.');
  assert.ok(descriptionUnverifiedReason({ status: 'unknown', error: 'x'.repeat(400) })!.length <= 140);

  const alert = { listing: listing('label'), typical: 1000, discountPercent: 25, confidence: 90, descriptionUnverified: 'inconclusive: No photo' };
  assert.match(buildDiscordEmbed(alert).embeds[0].description ?? '', /^⚠️ Description not verified: inconclusive: No photo/);
  assert.match(buildNtfyPayload(alert, 'topic').message, /\n⚠️ Description not verified: inconclusive: No photo\n/);
  assert.equal(buildDiscordEmbed({ ...alert, descriptionUnverified: null }).embeds[0].description, undefined);

  const row = { id: 'OLX:1', marketplace: 'OLX', title: 'CPU', price: 700, typical: 1000, dealStrength: 4, dealLabel: 'Very strong', watch: 'w', url: 'https://www.olx.pl/d/oferta/1', image: '', observedAt: new Date().toISOString() } as unknown as Listing;
  assert.equal(compactListing({ ...row, aiDescriptionVerificationStatus: 'unknown', aiDescriptionVerification: { decision: 'unknown', confidence: 0.6, summary: 'Unsure', issues: ['No photo'], evidence: [] } }).unverified, 'inconclusive: No photo');
  assert.equal('unverified' in compactListing({ ...row, aiDescriptionVerificationStatus: 'pass' }), false);
});

function verificationFixture() {
  const state = { decision: 'unknown' as 'pass' | 'reject' | 'unknown', page: (): string => '<div data-testid="description">Karta działa, bez zdjęć z testów.</div>', pages: 0, ai: 0 };
  const context = alertFixture({
    verifyListingDescription: async () => {
      state.ai += 1;
      return { decision: state.decision, confidence: 0.6, summary: `Decided ${state.decision}.`, issues: state.decision === 'pass' ? [] : ['No photo of the card powered on'], evidence: [] };
    },
  });
  (context.service as any).fetchPublicPage = async () => { state.pages += 1; return state.page(); };
  context.service.saveSettings({ ai: { apiKey: 'sk-test', model: 'deepseek-v4-flash' }, webhook: 'https://discord.com/api/webhooks/123/token' });
  seedWatch(context.db, 'verify-watch');
  const candidate = (listingId: string, price = 700) => {
    const now = new Date().toISOString();
    context.db.prepare('INSERT OR IGNORE INTO listings (marketplace, listing_id, title, price_pln, url, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('OLX', listingId, `CPU ${listingId}`, price, `https://www.olx.pl/d/oferta/${listingId}`, now, now);
    return { watchId: 'verify-watch', listing: listing(listingId, price), typical: 1000, discountPercent: 30, confidence: 95, requiresDescriptionVerification: true };
  };
  const process = (items: unknown[]) => (context.service as any).processDealCandidates(items, () => (context.service as any).scanNotifyContext()) as Promise<void>;
  const stored = (listingId: string) => context.db.prepare('SELECT ai_description_verification_status AS status, ai_description_verification_error AS error, ai_description_verification_input_hash AS hash FROM listings WHERE listing_id = ?').get(listingId) as { status: string; error: string | null; hash: string | null };
  return { ...context, state, candidate, process, stored };
}

test('an inconclusive description check alerts at once, marked unverified, and a reject still holds it', async () => {
  const context = verificationFixture();
  let discordStatus = 500;
  const channels = stubChannels(() => discordStatus);
  try {
    await context.process([context.candidate('unsure-card')]);
    assert.equal(channels.calls.length, 1);
    assert.match(channels.calls[0].body.embeds[0].description, /^⚠️ Description not verified: inconclusive: No photo of the card powered on/);
    const payload = JSON.parse((context.db.prepare("SELECT payload_json FROM notifications WHERE listing_key LIKE '%unsure-card%'").get() as { payload_json: string }).payload_json);
    assert.equal(payload._scout.descriptionUnverified, 'inconclusive: No photo of the card powered on');
    // The retry of the failed first attempt keeps the label.
    discordStatus = 204;
    context.db.prepare('UPDATE notification_deliveries SET next_attempt_at = ?').run(new Date(Date.now() - 1_000).toISOString());
    await (context.service as any).processNotificationRetries();
    assert.equal(channels.calls.length, 2);
    assert.match(channels.calls[1].body.embeds[0].description, /Description not verified/);
    assert.equal(deliveries(context.db)[0].status, 'delivered');
    // The next scan reuses the stored verdict and does not alert again.
    await context.process([context.candidate('unsure-card')]);
    assert.equal(context.state.ai, 1);
    assert.equal(channels.calls.length, 2);

    context.state.decision = 'reject';
    await context.process([context.candidate('damaged-card')]);
    assert.equal(context.state.ai, 2);
    assert.equal(channels.calls.length, 2, 'a reject never alerts');

    context.state.decision = 'pass';
    await context.process([context.candidate('fine-card')]);
    assert.equal(channels.calls.length, 3);
    assert.equal(channels.calls[2].body.embeds[0].description, undefined, 'a pass has no label');
  } finally {
    channels.restore();
    context.close();
  }
});

test('a page that failed to load alerts marked unverified and is checked again on the next scan without a second alert', async () => {
  const context = verificationFixture();
  const channels = stubChannels(() => 204);
  try {
    context.state.page = () => { throw new Error('Vinted authenticated session failed: Chromium page returned 429 for Vinted (anonymous browser)'); };
    await context.process([context.candidate('blocked-page')]);
    assert.equal(channels.calls.length, 1);
    assert.match(channels.calls[0].body.embeds[0].description, /^⚠️ Description not verified: check failed: Vinted authenticated session failed: Chromium page returned 429/);
    assert.equal(context.state.ai, 0);
    // Not a finished verdict: an error and no input hash.
    assert.deepEqual({ ...context.stored('blocked-page') }, { status: 'unknown', error: 'Vinted authenticated session failed: Chromium page returned 429 for Vinted (anonymous browser)', hash: null });

    // The next scan fetches the page again and stores the real verdict, without alerting twice.
    context.state.page = () => '<div data-testid="description">Karta działa.</div>';
    context.state.decision = 'pass';
    await context.process([context.candidate('blocked-page')]);
    assert.equal(context.state.pages, 2);
    assert.equal(context.state.ai, 1);
    assert.equal(context.stored('blocked-page').status, 'pass');
    assert.equal(channels.calls.length, 1);
    // With a finished verdict, later scans neither fetch nor alert.
    await context.process([context.candidate('blocked-page')]);
    assert.equal(context.state.pages, 2);
    assert.equal(channels.calls.length, 1);
  } finally {
    channels.restore();
    context.close();
  }
});

test('a listing page without a description alerts marked unverified', async () => {
  const context = verificationFixture();
  const channels = stubChannels(() => 204);
  try {
    context.state.page = () => '<html><body>No description here</body></html>';
    await context.process([context.candidate('no-description')]);
    assert.equal(context.state.ai, 0);
    assert.equal(channels.calls.length, 1);
    assert.match(channels.calls[0].body.embeds[0].description, /^⚠️ Description not verified: no description on the listing page/);
    assert.equal(context.stored('no-description').status, 'unknown');
  } finally {
    channels.restore();
    context.close();
  }
});

test('the daily digest marks unverified deals and leaves out ones the check later rejected', async () => {
  const context = alertFixture();
  const channels = stubChannels(() => 204);
  try {
    seedWatch(context.db, 'digest-watch');
    context.service.saveSettings({
      webhook: 'https://discord.com/api/webhooks/123/token',
      discordMinimumPriority: 'strong',
      ntfy: { serverUrl: 'https://ntfy.sh', topic: 'scout-digest', minimumPriority: 'strong' },
      dailyDigest: { enabled: true, time: '00:00', discord: true, ntfy: true },
    });
    const now = new Date().toISOString();
    const insert = context.db.prepare(`INSERT INTO listings (marketplace, listing_id, title, price_pln, url, first_seen_at, last_seen_at, ai_description_verification_status) VALUES ('OLX', ?, ?, 820, ?, ?, ?, ?)`);
    for (const [id, status] of [['digest-unsure', 'unknown'], ['digest-fine', 'pass'], ['digest-rejected', 'reject']] as const) {
      insert.run(id, `CPU ${id}`, `https://www.olx.pl/d/oferta/${id}`, now, now, status);
      await (context.service as any).notifyDeal('digest-watch', listing(id, 820), 1000, 18, 91);
    }
    assert.equal(channels.calls.length, 0, 'ordinary deals wait for the digest');
    await (context.service as any).processDailyDigest();
    const discord = channels.calls.find((call) => call.url.includes('discord.com'))!;
    const fields = discord.body.embeds[0].fields as Array<{ value: string }>;
    assert.equal(fields.length, 2);
    assert.match(fields.find((field) => field.value.includes('digest-unsure'))!.value, /\n⚠️ Description not verified$/);
    assert.doesNotMatch(fields.find((field) => field.value.includes('digest-fine'))!.value, /not verified/);
    const ntfy = channels.calls.find((call) => call.url.startsWith('https://ntfy.sh'))!;
    assert.match(ntfy.body.message, /CPU digest-unsure · 820 zł · ⚠️ not verified\n/);
    assert.doesNotMatch(ntfy.body.message, /digest-rejected/);
  } finally {
    channels.restore();
    context.close();
  }
});
