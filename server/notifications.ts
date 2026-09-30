import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import type { NormalizedListing } from './marketplaces';
import type { NotificationPriority } from '../src/types';
import { discardResponse } from './fetch-diagnostics';

const processFetch = globalThis.fetch;

export const notificationPriorityRank: Record<NotificationPriority, number> = {
  strong: 1,
  'very-strong': 2,
  exceptional: 3,
};

export function isNotificationPriority(value: unknown): value is NotificationPriority {
  return value === 'strong' || value === 'very-strong' || value === 'exceptional';
}

export function parseNotificationPriority(value: unknown, fallback: NotificationPriority): NotificationPriority {
  return isNotificationPriority(value) ? value : fallback;
}

export function priorityFromDiscount(discountPercent: number): NotificationPriority {
  if (discountPercent >= 30) return 'exceptional';
  if (discountPercent >= 20) return 'very-strong';
  return 'strong';
}

export function meetsMinimumPriority(actual: NotificationPriority, minimum: NotificationPriority) {
  return notificationPriorityRank[actual] >= notificationPriorityRank[minimum];
}

export function notificationPriorityLabel(priority: NotificationPriority) {
  if (priority === 'exceptional') return 'Exceptional';
  if (priority === 'very-strong') return 'Very strong';
  return 'Strong';
}

export function ntfyPriorityNumber(priority: NotificationPriority) {
  if (priority === 'exceptional') return 5;
  if (priority === 'very-strong') return 4;
  return 3;
}

export interface NtfyConfig {
  serverUrl: string;
  topic: string;
  token?: string;
  minimumPriority: NotificationPriority;
  /** Tapping an alert opens the Scout iOS app (`scout://`) instead of the marketplace page. */
  openInApp: boolean;
}

export interface NtfyAction {
  action: 'view';
  label: string;
  url: string;
  clear?: boolean;
}

export interface NtfyPayload {
  topic: string;
  title: string;
  message: string;
  priority: number;
  tags: string[];
  click: string;
  actions?: NtfyAction[];
}

/** Opens the Deals tab of the Scout iOS app. */
export const SCOUT_APP_DEALS_LINK = 'scout://deals';

/**
 * Opens one listing in the Scout iOS app. Built with encodeURIComponent, not
 * URLSearchParams: the app decodes `+` literally, so spaces (as in
 * "Allegro Lokalnie") must be `%20`.
 */
export function scoutAppListingLink(listing: Pick<NormalizedListing, 'marketplace' | 'listingId'>, watchId?: string | null) {
  const key = encodeURIComponent(`${listing.marketplace}:${listing.listingId}`);
  return `scout://listing?key=${key}${watchId ? `&watchId=${encodeURIComponent(watchId)}` : ''}`;
}

export function validateNtfyConfig(input: {
  serverUrl?: string | null;
  topic?: string | null;
  token?: string | null;
  minimumPriority?: unknown;
  openInApp?: unknown;
}): NtfyConfig {
  const serverValue = (input.serverUrl ?? 'https://ntfy.sh').trim();
  let server: URL;
  try { server = new URL(serverValue); } catch { throw new Error('Enter a valid ntfy server URL'); }
  if (server.protocol !== 'https:') throw new Error('ntfy server must use HTTPS');
  if (server.username || server.password || server.search || server.hash) throw new Error('ntfy server URL cannot include credentials or query parameters');
  if (!isSafeNetworkHost(server.hostname)) throw new Error('ntfy server cannot target a local or private network address');
  const serverUrl = `${server.origin}${server.pathname.replace(/\/+$/, '')}`;
  const topic = (input.topic ?? '').trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(topic)) throw new Error('ntfy topic must be 1–64 letters, numbers, hyphens, or underscores');
  const token = (input.token ?? '').trim() || undefined;
  if (token && token.length > 512) throw new Error('ntfy access token is too long');
  return { serverUrl, topic, token, minimumPriority: parseNotificationPriority(input.minimumPriority, 'exceptional'), openInApp: input.openInApp === true };
}

function isPrivateAddress(hostname: string) {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const ipv4 = host.split('.').map(Number);
  if (isIP(host) === 4) {
    return ipv4[0] === 0 || ipv4[0] === 10 || ipv4[0] === 127 || ipv4[0] === 169 && ipv4[1] === 254
      || ipv4[0] === 172 && ipv4[1] >= 16 && ipv4[1] <= 31 || ipv4[0] === 192 && (ipv4[1] === 168 || ipv4[1] === 0 && ipv4[2] === 0 || ipv4[1] === 0 && ipv4[2] === 2)
      || ipv4[0] === 100 && ipv4[1] >= 64 && ipv4[1] <= 127 || ipv4[0] === 198 && (ipv4[1] === 18 || ipv4[1] === 19 || ipv4[1] === 51)
      || ipv4[0] === 203 && ipv4[1] === 0 && ipv4[2] === 113 || ipv4[0] >= 224;
  }
  if (isIP(host) === 6) {
    if (host.startsWith('::ffff:')) return isPrivateAddress(host.slice('::ffff:'.length));
    return host === '::' || host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe8') || host.startsWith('fe9') || host.startsWith('fea') || host.startsWith('feb');
  }
  return false;
}

function isSafeNetworkHost(hostname: string) {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.lan') || isPrivateAddress(host)) return false;
  return true;
}

function assertSafeNtfyHost(serverUrl: string) {
  const host = new URL(serverUrl).hostname;
  if (!isSafeNetworkHost(host)) throw new Error('ntfy server cannot target a local or private network address');
}

async function assertSafeNtfyDestination(serverUrl: string) {
  assertSafeNtfyHost(serverUrl);
  const host = new URL(serverUrl).hostname;
  if (isIP(host)) return;
  const addresses = await lookup(host, { all: true, verbatim: true });
  if (!addresses.length || addresses.some((address) => isPrivateAddress(address.address))) throw new Error('ntfy server resolved to a local or private network address');
}

export interface DealNotificationInput {
  listing: NormalizedListing;
  typical: number;
  discountPercent: number;
  confidence: number;
  observedAt?: string;
  /** Model variant the typical describes, when the watch groups variants. */
  variantLabel?: string | null;
}

export function buildNtfyPayload(
  input: DealNotificationInput,
  topic: string,
  priority = priorityFromDiscount(input.discountPercent),
  options: { openInApp?: boolean; watchId?: string | null } = {},
): NtfyPayload {
  const { listing } = input;
  const tags = priority === 'exceptional' ? ['rotating_light', 'moneybag'] : priority === 'very-strong' ? ['warning', 'moneybag'] : ['moneybag'];
  return {
    topic,
    title: `${notificationPriorityLabel(priority)} deal · ${listing.marketplace}`,
    message: [
      listing.title,
      ...(input.variantLabel ? [`Variant: ${input.variantLabel}`] : []),
      `${listing.price.toLocaleString('pl-PL')} zł · ${input.discountPercent.toFixed(1)}% below typical · ${input.confidence}% confidence`,
      listing.url,
    ].join('\n'),
    priority: ntfyPriorityNumber(priority),
    tags,
    // In app mode the marketplace page stays one tap away as an action button.
    click: options.openInApp ? scoutAppListingLink(listing, options.watchId) : listing.url,
    ...(options.openInApp ? { actions: [{ action: 'view' as const, label: 'Open listing', url: listing.url, clear: true }] } : {}),
  };
}

export async function publishNtfy(config: NtfyConfig, payload: NtfyPayload, fetcher: typeof fetch = globalThis.fetch) {
  assertSafeNtfyHost(config.serverUrl);
  if (fetcher === processFetch) await assertSafeNtfyDestination(config.serverUrl);
  const response = await fetcher(`${config.serverUrl}/`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(config.token ? { authorization: `Bearer ${config.token}` } : {}),
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(12_000),
  });
  discardResponse(response, 'ntfy');
  if (!response.ok) throw new Error(`ntfy returned ${response.status}`);
}

export function buildDiscordEmbed(input: DealNotificationInput) {
  const { listing } = input;
  const safeTitle = listing.title.replace(/[\r\n]+/g, ' ').trim().slice(0, 256) || 'Scout deal';
  const safeImageUrl = listing.imageUrl && /^https:\/\//i.test(listing.imageUrl) ? listing.imageUrl.slice(0, 2_000) : undefined;
  return {
    username: 'Scout',
    embeds: [{
      title: safeTitle,
      url: listing.url,
      color: input.discountPercent >= 30 ? 0xf15a35 : 0xf4b734,
      thumbnail: safeImageUrl ? { url: safeImageUrl } : undefined,
      fields: [
        { name: 'Marketplace', value: listing.marketplace, inline: true },
        ...(input.variantLabel ? [{ name: 'Variant', value: input.variantLabel, inline: true }] : []),
        { name: 'Price', value: `${listing.price.toLocaleString('pl-PL')} zł`, inline: true },
        { name: 'Typical price', value: `${input.typical.toLocaleString('pl-PL')} zł`, inline: true },
        { name: 'Below typical', value: `${input.discountPercent.toFixed(1)}%`, inline: true },
        { name: 'Confidence', value: `${input.confidence}%`, inline: true },
        { name: 'Observed', value: input.observedAt ?? listing.observedAt, inline: true },
      ],
      footer: { text: 'Scout · public-page monitor' },
    }],
  };
}

export function notificationKey(listing: Pick<NormalizedListing, 'marketplace' | 'listingId'>) {
  return `${listing.marketplace}:${listing.listingId}`.toLowerCase();
}
