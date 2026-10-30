import type { ConversationResult, InboxConversation, InboxMessage, InboxResult, Marketplace } from '../src/types';
import { parseMarketplaceStorageState, type MarketplaceCookie, type MarketplaceStorageState } from './marketplace-sessions';

/**
 * Read-only marketplace inboxes (scout_inbox, scout_conversation) over the
 * JSON endpoints each site's own web app calls, with the stored session's
 * cookies. Mapped 2026-10-17 against real sessions:
 *
 * - OLX: api.chat.olx.pl lists conversations with their messages, behind a
 *   15-minute OAuth access token kept in the session's localStorage. The web
 *   app loads threads and marks them read over a websocket, so Scout reads the
 *   list only.
 * - Vinted: /api/v2/inbox lists conversations without their listing;
 *   /api/v2/conversations/:id has the messages and does not mark them read
 *   (checked on an unread one: the web app sends a separate
 *   PUT …/mark_as_read). The access token lasts an hour.
 * - Allegro Lokalnie: /api/chat/inbox and /api/chat/messages, behind a 30-day
 *   session cookie; the offer behind a conversation takes /api/chat/subject.
 *   Whether /api/chat/messages marks a conversation read is unchecked, so
 *   scout_conversation checks it as it goes.
 *
 * Only GETs leave Scout, apart from the two token renewals (OLX's OAuth
 * refresh grant and Vinted's /web/api/auth/refresh), which rotate the refresh
 * token: the renewed session is saved back before anything else uses it.
 */

export const INBOX_CACHE_MS = 60_000;
export const INBOX_CONVERSATIONS_MAX = 20;
/** Extra requests per scout_inbox call to find a Vinted or Allegro Lokalnie conversation's listing. */
export const INBOX_LOOKUPS_PER_CALL = 5;
export const CONVERSATION_MESSAGES_DEFAULT = 50;
export const CONVERSATION_MESSAGES_MAX = 100;
const MESSAGE_TEXT_CHARS = 2_000;
const TITLE_CHARS = 100;
/** Tokens with less than this left are renewed before use, so a render or poll never runs on an expiring one. */
const RENEW_MARGIN_SECONDS = 300;
const REQUEST_TIMEOUT_MS = 15_000;
const LOOKUP_CACHE_LIMIT = 2_000;
const OLX_PAGE = 40;
const OLX_PAGES = 3;

const OLX_ORIGIN = 'https://www.olx.pl';
const OLX_TOKEN_URL = 'https://login.olx.pl/oauth2/token';
const OLX_REDIRECT_URI = 'https://www.olx.pl/d/callback/';
const VINTED_REFRESH_URL = 'https://www.vinted.pl/web/api/auth/refresh';
/** The constant Vinted's web bundle sends with every auth call (it accepted other values too, 2026-10-17). */
const VINTED_CSRF_TOKEN = '75f6c9fa-dc8e-4e52-a000-e09dd4084b3e';

export class InboxError extends Error {
  constructor(message: string, readonly status = 502) { super(message); }
}

export interface InboxSession { state: MarketplaceStorageState; version: string }

export interface InboxDependencies {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  userAgent: string;
  /** The stored session and an opaque version (its ciphertext), or null. */
  session(marketplace: Marketplace): InboxSession | null;
  /** Saves a renewed session unless it changed since `version`; returns the new version, or null when it changed. */
  saveSession(marketplace: Marketplace, version: string, state: MarketplaceStorageState): string | null;
  sessionFailed(marketplace: Marketplace, message: string): void;
  sessionUsed(marketplace: Marketplace): void;
  /** Runs a marketplace request through Scout's per-marketplace limiter. */
  request<T>(marketplace: Marketplace, task: () => Promise<T>): Promise<T>;
  /** Why Scout stopped reading a marketplace's conversations, if it did. */
  readGuard(marketplace: Marketplace): string | null;
  tripGuard(marketplace: Marketplace, reason: string): void;
  log(message: string): void;
  now?: () => number;
}

/** A conversation as listed, with what Scout needs to read it. */
interface Listed extends InboxConversation {
  rawId: string;
  /** OLX lists every message; the others list the last one. */
  messages?: InboxMessage[];
  /** Allegro Lokalnie: the other person's id decides direction; the subject leads to the listing. */
  subject?: { type: string; id: string };
}

interface Lookup { listingKey: string | null; role: InboxConversation['role']; title: string | null }

interface Thread {
  at: number;
  updatedAt: string | null;
  conversation: Omit<InboxConversation, 'lastMessage'>;
  messages: InboxMessage[];
}

export function sessionExpiredMessage(marketplace: Marketplace) {
  return `${marketplace} session has expired or was signed out: re-import the session (npm run marketplace:login, then Settings → Marketplace accounts)`;
}

export function conversationKey(marketplace: Marketplace, id: string) { return `${marketplace}:${id}`; }

export function parseConversationKey(key: string): { marketplace: Marketplace; id: string } {
  const separator = key.indexOf(':');
  const marketplace = key.slice(0, separator) as Marketplace;
  const id = key.slice(separator + 1).trim();
  if (separator < 0 || !['OLX', 'Vinted', 'Allegro Lokalnie'].includes(marketplace) || !/^[A-Za-z0-9-]{1,80}$/.test(id)) {
    throw new InboxError('Invalid conversation id; expected <Marketplace>:<conversationId> from scout_inbox', 400);
  }
  return { marketplace, id };
}

// ---- Session plumbing -------------------------------------------------------

function cookieApplies(cookie: MarketplaceCookie, url: URL, nowSeconds: number) {
  const domain = cookie.domain.replace(/^\./, '').toLowerCase();
  const host = url.hostname.toLowerCase();
  const hostMatches = cookie.domain.startsWith('.') ? host === domain || host.endsWith(`.${domain}`) : host === domain;
  const live = !(typeof cookie.expires === 'number' && cookie.expires > 0 && cookie.expires <= nowSeconds);
  return hostMatches && url.pathname.startsWith(cookie.path) && live;
}

export function cookieHeader(state: MarketplaceStorageState, url: URL, nowSeconds: number) {
  return state.cookies.filter((cookie) => cookieApplies(cookie, url, nowSeconds)).map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
}

/** Applies a response's Set-Cookie headers to a storage state, as a browser would. */
export function mergeSetCookies(state: MarketplaceStorageState, setCookies: string[], url: URL, nowSeconds: number): MarketplaceStorageState {
  const cookies = state.cookies.map((cookie) => ({ ...cookie }));
  for (const raw of setCookies) {
    const [pair, ...parts] = raw.split(';').map((part) => part.trim());
    const separator = pair.indexOf('=');
    if (separator <= 0) continue;
    const name = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    const attributes = new Map(parts.map((part) => {
      const index = part.indexOf('=');
      return index < 0 ? [part.toLowerCase(), ''] as const : [part.slice(0, index).trim().toLowerCase(), part.slice(index + 1).trim()] as const;
    }));
    const domainAttribute = attributes.get('domain');
    const domain = domainAttribute ? `.${domainAttribute.replace(/^\./, '').toLowerCase()}` : url.hostname.toLowerCase();
    const path = attributes.get('path') || '/';
    const maxAge = attributes.has('max-age') ? Number(attributes.get('max-age')) : null;
    const expiresAt = attributes.get('expires') ? Date.parse(attributes.get('expires')!) : Number.NaN;
    const expires = maxAge !== null && Number.isFinite(maxAge) ? nowSeconds + maxAge : Number.isFinite(expiresAt) ? expiresAt / 1000 : -1;
    const index = cookies.findIndex((cookie) => cookie.name === name && cookie.domain.toLowerCase() === domain && cookie.path === path);
    if (expires !== -1 && expires <= nowSeconds) {
      if (index >= 0) cookies.splice(index, 1);
      continue;
    }
    const sameSiteRaw = attributes.get('samesite')?.toLowerCase();
    const next: MarketplaceCookie = {
      name, value, domain, path, expires,
      httpOnly: attributes.has('httponly'),
      secure: attributes.has('secure'),
      sameSite: sameSiteRaw === 'strict' ? 'Strict' : sameSiteRaw === 'none' ? 'None' : 'Lax',
    };
    if (index >= 0) cookies[index] = next;
    else cookies.push(next);
  }
  return { ...state, cookies };
}

export function jwtExpiry(token: string | null | undefined): number | null {
  const payload = token?.split('.')[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { exp?: unknown };
    return typeof claims.exp === 'number' ? claims.exp : null;
  } catch { return null; }
}

/** OLX's auth0-spa-js cache entry, which holds the refresh token and the current access token. */
function olxAuth(state: MarketplaceStorageState) {
  const item = state.origins.find((origin) => origin.origin === OLX_ORIGIN)?.localStorage
    ?.find((entry) => entry.name.startsWith('@@auth0spajs@@::') && entry.name.includes('::default::') && entry.name.includes('offline_access'));
  if (!item) return null;
  try {
    const cache = JSON.parse(item.value) as { body?: Record<string, unknown>; expiresAt?: number };
    const body = cache.body;
    if (!body || typeof body.refresh_token !== 'string' || typeof body.client_id !== 'string') return null;
    return { name: item.name, cache, body: body as Record<string, unknown> & { refresh_token: string; client_id: string; access_token?: string } };
  } catch { return null; }
}

function olxAccessToken(state: MarketplaceStorageState) {
  const cached = olxAuth(state)?.body.access_token;
  if (typeof cached === 'string' && cached) return cached;
  const cookie = state.cookies.find((entry) => entry.name === 'access_token' && entry.domain.replace(/^\./, '') === 'olx.pl')?.value;
  try { return cookie ? decodeURIComponent(cookie) : null; } catch { return cookie ?? null; }
}

function vintedCookie(state: MarketplaceStorageState, name: string, nowSeconds: number) {
  const url = new URL('https://www.vinted.pl/');
  return state.cookies.find((cookie) => cookie.name === name && cookieApplies(cookie, url, nowSeconds))?.value ?? null;
}

/** When a session's access token runs out, or null when it has none Scout can see (Allegro Lokalnie). */
export function sessionTokenExpiry(marketplace: Marketplace, state: MarketplaceStorageState, nowSeconds: number) {
  if (marketplace === 'OLX') return jwtExpiry(olxAccessToken(state)) ?? 0;
  if (marketplace === 'Vinted') return jwtExpiry(vintedCookie(state, 'access_token_web', nowSeconds)) ?? 0;
  return null;
}

/** Whether the session holds a refresh token Scout can renew it with (OLX, Vinted). */
export function hasRefreshToken(marketplace: Marketplace, state: MarketplaceStorageState, nowSeconds: number) {
  if (marketplace === 'OLX') return olxAuth(state) !== null;
  if (marketplace === 'Vinted') return vintedCookie(state, 'refresh_token_web', nowSeconds) !== null;
  return false;
}

/** Token-renewal calls Scout makes itself; Chromium renders with a stored session must not make them. */
export function isSessionRenewalRequest(method: string, url: string) {
  if (method.toUpperCase() !== 'POST') return false;
  const bare = url.split(/[?#]/)[0];
  return bare === OLX_TOKEN_URL || bare === VINTED_REFRESH_URL;
}

/**
 * A session for a connected app's own browser, without its refresh tokens.
 * That browser runs the site's scripts, which renew an expired access token
 * themselves (Vinted's /session-refresh page) and so spend the refresh token
 * Scout holds, signing Scout out (seen 2026-10-30). Scout keeps renewing, and
 * each renewal reaches the app as a new revision.
 */
export function withoutRefreshTokens(state: MarketplaceStorageState): MarketplaceStorageState {
  return {
    cookies: state.cookies.filter((cookie) => !/^refresh_token/i.test(cookie.name)),
    origins: state.origins.map((origin) => ({
      ...origin,
      localStorage: (origin.localStorage ?? []).map((item) => {
        if (!item.name.startsWith('@@auth0spajs@@::')) return item;
        try {
          const cache = JSON.parse(item.value) as { body?: Record<string, unknown> };
          if (!cache.body || !('refresh_token' in cache.body)) return item;
          const { refresh_token: _, ...body } = cache.body;
          return { ...item, value: JSON.stringify({ ...cache, body }) };
        } catch { return item; }
      }),
    })),
  };
}

// ---- Parsers ------------------------------------------------------------------

type Json = Record<string, any>;
const record = (value: unknown): Json | null => (value && typeof value === 'object' && !Array.isArray(value) ? value as Json : null);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const idText = (value: unknown) => (typeof value === 'string' && value ? value : typeof value === 'number' && Number.isFinite(value) ? String(value) : null);
const plainText = (value: unknown, max = MESSAGE_TEXT_CHARS) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const nullableText = (value: unknown, max = TITLE_CHARS) => plainText(value, max) || null;

function isoTime(value: unknown) {
  if (typeof value !== 'string' || !value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function pln(amount: unknown, currency: unknown, divisor = 1) {
  if (currency !== undefined && currency !== null && currency !== 'PLN') return null;
  const value = typeof amount === 'number' ? amount : typeof amount === 'string' ? Number(amount.replace(',', '.')) : Number.NaN;
  return Number.isFinite(value) && value > 0 ? Math.round((value / divisor) * 100) / 100 : null;
}

const byTime = (a: { time: string | null }, b: { time: string | null }) => (a.time ?? '').localeCompare(b.time ?? '');

function offerStatus(action: string): NonNullable<InboxMessage['offer']>['status'] {
  if (/propos|offer|counter/.test(action)) return 'proposed';
  if (/accept/.test(action)) return 'accepted';
  if (/reject|declin/.test(action)) return 'rejected';
  if (/cancel|withdr|expir/.test(action)) return 'cancelled';
  return null;
}

/** OLX: one page of api.chat.olx.pl/api/conversations; each entry carries its messages. */
export function parseOlxConversations(json: unknown): { conversations: Listed[]; total: number | null } {
  const root = record(json);
  const conversations = list(root?.data).flatMap((raw): Listed[] => {
    const entry = record(raw);
    const rawId = idText(entry?.id);
    if (!entry || !rawId) return [];
    const respondent = record(entry.respondent);
    const self = idText(entry.user_id);
    const other = idText(respondent?.id);
    const messages = list(entry.messages).flatMap((rawMessage): InboxMessage[] => {
      const message = record(rawMessage);
      const id = idText(message?.id);
      if (!message || !id) return [];
      const kind = typeof message.type === 'string' ? message.type : '';
      const author = idText(message.user_id);
      const widget = /^custom:price_negotiation_widget_(?:buyer|seller)_(.+)$/.exec(kind);
      const proposal = record(record(message.extras)?.proposal);
      const price = record(proposal?.price);
      const amount = widget ? pln(price?.cents, price?.currency, 100) : null;
      const system = kind === 'system';
      return [{
        id,
        direction: system ? 'system' : author && author === other ? 'in' : author && author === self ? 'out' : null,
        type: system ? 'event' : widget ? (amount === null ? 'event' : 'offer') : 'text',
        text: plainText(message.text),
        time: isoTime(message.created_at),
        offer: widget && amount !== null ? { amount, status: offerStatus(widget[1]) } : null,
      }];
    }).sort(byTime);
    const ad = record(entry.ad);
    const adId = idText(ad?.id);
    const respondentType = typeof respondent?.type === 'string' ? respondent.type : '';
    return [{
      id: conversationKey('OLX', rawId),
      rawId,
      listingKey: adId ? `OLX:${adId}` : null,
      url: `https://www.olx.pl/myaccount/answer/${rawId}/`,
      role: respondentType === 'seller' ? 'buy' : respondentType === 'buyer' ? 'sell' : null,
      other: { id: other, name: nullableText(respondent?.name) },
      title: nullableText(ad?.title),
      unread: Number(entry.unread_count) > 0,
      updatedAt: messages.at(-1)?.time ?? null,
      lastMessage: messages.at(-1) ?? null,
      messages,
    }];
  });
  const total = Number(record(root?.metadata)?.total_elements);
  return { conversations, total: Number.isFinite(total) ? total : null };
}

/** Vinted: /api/v2/inbox. The list has the last message's text and time, not its author or the listing. */
export function parseVintedInbox(json: unknown): Listed[] {
  return list(record(json)?.conversations).flatMap((raw): Listed[] => {
    const entry = record(raw);
    const rawId = idText(entry?.id);
    if (!entry || !rawId) return [];
    const user = record(entry.opposite_user);
    const updatedAt = isoTime(entry.updated_at);
    const text = plainText(entry.description);
    return [{
      id: conversationKey('Vinted', rawId),
      rawId,
      listingKey: null,
      url: `https://www.vinted.pl/inbox/${rawId}`,
      role: null,
      other: { id: idText(user?.id), name: nullableText(user?.login) },
      title: null,
      unread: entry.unread === true,
      updatedAt,
      lastMessage: text || updatedAt ? { id: null, direction: null, type: 'text', text, time: updatedAt, offer: null } : null,
    }];
  });
}

const VINTED_OFFER_STATUS: Record<number, NonNullable<InboxMessage['offer']>['status']> = { 10: 'proposed', 20: 'accepted', 30: 'rejected', 40: 'cancelled' };

/** Vinted: /api/v2/conversations/:id, oldest message first. */
export function parseVintedConversation(json: unknown): { lookup: Lookup; other: InboxConversation['other']; read: boolean | null; messages: InboxMessage[] } | null {
  const conversation = record(record(json)?.conversation);
  if (!conversation) return null;
  const user = record(conversation.opposite_user);
  const other = idText(user?.id);
  const transaction = record(conversation.transaction);
  const itemIds = list(transaction?.item_ids).map(idText).filter(Boolean);
  const itemId = idText(transaction?.item_id) ?? (itemIds.length === 1 ? itemIds[0] : null);
  const side = transaction?.current_user_side;
  const messages = list(conversation.messages).flatMap((raw, index): InboxMessage[] => {
    const message = record(raw);
    const entity = record(message?.entity);
    if (!message || !entity) return [];
    const kind = typeof message.entity_type === 'string' ? message.entity_type : '';
    const time = isoTime(message.created_at_ts);
    const author = idText(entity.user_id);
    const direction = author ? (author === other ? 'in' : 'out') : 'system';
    const id = idText(entity.id) ?? idText(message.id) ?? idText(entity.offer_request_id) ?? `${kind || 'event'}:${time ?? index}`;
    if (kind === 'message') return [{ id, direction, type: 'text', text: plainText(entity.body), time, offer: null }];
    if (kind === 'offer_request_message' || kind === 'offer_message') {
      const price = record(entity.price);
      const amount = pln(price?.amount, price?.currency_code ?? entity.currency);
      const status = kind === 'offer_message' ? 'proposed' : VINTED_OFFER_STATUS[Number(entity.status)] ?? null;
      return [{ id, direction, type: amount === null ? 'event' : 'offer', text: plainText(entity.body) || plainText(entity.price_label), time, offer: amount === null ? null : { amount, status } }];
    }
    const text = [plainText(entity.title, 300), plainText(entity.subtitle, 300)].filter(Boolean).join(' — ');
    return [{ id, direction: 'system', type: 'event', text: text || kind, time, offer: null }];
  }).sort(byTime);
  return {
    lookup: {
      listingKey: itemId && (itemIds.length <= 1) ? `Vinted:${itemId}` : null,
      role: side === 'buyer' ? 'buy' : side === 'seller' ? 'sell' : null,
      title: nullableText(transaction?.item_title) ?? nullableText(conversation.subtitle),
    },
    other: { id: other, name: nullableText(user?.login) },
    read: typeof conversation.read_by_current_user === 'boolean' ? conversation.read_by_current_user : null,
    messages,
  };
}

function allegroMessage(raw: unknown, participant: string | null, index: number): InboxMessage | null {
  const message = record(raw);
  if (!message) return null;
  const kind = typeof message.type === 'string' ? message.type : '';
  const content = record(message.content) ?? {};
  const time = isoTime(message.inserted_at);
  const id = idText(message.id) ?? `${kind || 'event'}:${time ?? index}`;
  const author = idText(message.author_id);
  const direction = author ? (author === participant ? 'in' : 'out') : 'system';
  if (kind === 'text') return { id, direction, type: 'text', text: plainText(content.body), time, offer: null };
  const negotiation = /^negotiations_price_(.+)$/.exec(kind);
  if (negotiation && negotiation[1] !== 'changed') {
    const amount = pln(content.proposed_price_cents ?? content.price_cents, undefined, 100);
    if (amount !== null) return { id, direction, type: 'offer', text: plainText(content.body), time, offer: { amount, status: offerStatus(negotiation[1]) } };
  }
  if (kind === 'negotiations_price_changed') {
    const from = pln(content.offer_previous_price_cents, undefined, 100);
    const to = pln(content.offer_price_cents, undefined, 100);
    return { id, direction: 'system', type: 'event', text: `Listing price changed${from ? ` from ${from} zł` : ''}${to ? ` to ${to} zł` : ''}`, time, offer: null };
  }
  return { id, direction: 'system', type: 'event', text: plainText(content.body) || kind, time, offer: null };
}

function allegroEntry(raw: unknown): Listed | null {
  const entry = record(raw);
  const rawId = idText(entry?.id);
  if (!entry || !rawId) return null;
  const subject = record(entry.subject);
  const participant = idText(subject?.participant_id);
  const lastMessage = entry.last_message ? allegroMessage(entry.last_message, participant, 0) : null;
  const subjectType = typeof subject?.type === 'string' ? subject.type : null;
  const subjectId = idText(subject?.id);
  return {
    id: conversationKey('Allegro Lokalnie', rawId),
    rawId,
    listingKey: null,
    url: `https://allegrolokalnie.pl/wiadomosci/${rawId}`,
    role: subject?.is_seller === true ? 'sell' : subject?.is_seller === false ? 'buy' : null,
    other: { id: participant, name: nullableText(subject?.participant_name) },
    title: nullableText(subject?.first_item_title),
    unread: entry.is_unseen === true,
    updatedAt: lastMessage?.time ?? null,
    lastMessage,
    ...(subjectType && subjectId ? { subject: { type: subjectType, id: subjectId } } : {}),
  };
}

/** Allegro Lokalnie: /api/chat/inbox (or /api/chat/inbox/:id, which wraps one entry in `conversation`). */
export function parseAllegroInbox(json: unknown): Listed[] {
  const root = record(json);
  const entries = root?.conversation ? [root.conversation] : list(root?.entries);
  return entries.map(allegroEntry).filter((entry): entry is Listed => entry !== null);
}

export function parseAllegroMessages(json: unknown, participant: string | null): InboxMessage[] {
  return list(record(json)?.messages).map((raw, index) => allegroMessage(raw, participant, index)).filter((message): message is InboxMessage => message !== null).sort(byTime);
}

/**
 * Allegro Lokalnie: /api/chat/subject gives the offer behind a conversation
 * (`item` for an enquiry, `items` for a purchase); its id is Scout's listing id.
 */
export function parseAllegroSubject(json: unknown): string | null {
  const root = record(json);
  const items = list(root?.items);
  const id = idText(record(root?.item)?.id) ?? (items.length === 1 ? idText(record(items[0])?.id) : null);
  return id ? `Allegro Lokalnie:${id}` : null;
}

// ---- Client -------------------------------------------------------------------

/** A request that never got an answer (DNS, connect or timeout) becomes a plain tool error. */
async function reach(marketplace: Marketplace, request: () => Promise<Response>) {
  try { return await request(); } catch (error) {
    if (error instanceof InboxError) throw error;
    const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    throw new InboxError(`${marketplace} could not be reached${timedOut ? ' (timed out)' : ''}; try again later`, 502);
  }
}

export class MarketplaceInbox {
  private readonly lists = new Map<Marketplace, { at: number; fetchedAt: string; conversations: Listed[] }>();
  private readonly listing = new Map<Marketplace, Promise<{ fetchedAt: string; conversations: Listed[] }>>();
  private readonly renewing = new Map<Marketplace, Promise<InboxSession>>();
  private readonly lookups = new Map<string, Lookup>();
  private readonly threads = new Map<string, Thread>();

  constructor(private readonly deps: InboxDependencies) {}

  private now() { return this.deps.now ? this.deps.now() : Date.now(); }
  private nowSeconds() { return this.now() / 1000; }

  /** Drops what Scout cached for a marketplace (a re-imported or removed session). */
  forget(marketplace: Marketplace) {
    this.lists.delete(marketplace);
    for (const key of [...this.lookups.keys(), ...this.threads.keys()]) {
      if (key.startsWith(`${marketplace}:`)) { this.lookups.delete(key); this.threads.delete(key); }
    }
  }

  private storedSession(marketplace: Marketplace): InboxSession {
    const session = this.deps.session(marketplace);
    if (!session) throw new InboxError(`No ${marketplace} session is stored: export one with npm run marketplace:login and import it in Settings → Marketplace accounts`, 409);
    return session;
  }

  private expired(marketplace: Marketplace): never {
    const message = sessionExpiredMessage(marketplace);
    this.deps.sessionFailed(marketplace, message);
    throw new InboxError(message, 401);
  }

  /**
   * The stored session with an access token good for a few more minutes,
   * renewing it first when needed. Concurrent callers share one renewal, so a
   * rotated refresh token is never spent twice.
   */
  async freshSession(marketplace: Marketplace, force = false): Promise<InboxSession> {
    const pending = this.renewing.get(marketplace);
    if (pending) return pending;
    const session = this.storedSession(marketplace);
    const expiry = sessionTokenExpiry(marketplace, session.state, this.nowSeconds());
    if (expiry === null || (!force && expiry - this.nowSeconds() > RENEW_MARGIN_SECONDS)) return session;
    const task = this.renew(marketplace, session).finally(() => this.renewing.delete(marketplace));
    this.renewing.set(marketplace, task);
    return task;
  }

  /**
   * Renewals skip the per-marketplace limiter: a render already holds a slot
   * when it asks for a fresh session, and two such renders would wait on each
   * other. They are one sign-in call per token lifetime.
   */
  private async renew(marketplace: Marketplace, session: InboxSession): Promise<InboxSession> {
    const renewed = marketplace === 'OLX' ? await this.renewOlx(session.state) : await this.renewVinted(session.state);
    let state: MarketplaceStorageState;
    try { state = parseMarketplaceStorageState(renewed, marketplace); } catch {
      throw new InboxError(`${marketplace} renewed the session in a form Scout can't store; re-import the session`, 502);
    }
    const version = this.deps.saveSession(marketplace, session.version, state);
    this.deps.log(`${marketplace} session renewed${version ? '' : ' (a newer import replaced it meanwhile)'}`);
    return { state, version: version ?? session.version };
  }

  private async renewOlx(state: MarketplaceStorageState): Promise<MarketplaceStorageState> {
    const auth = olxAuth(state);
    if (!auth) this.expired('OLX');
    const response = await reach('OLX', () => this.deps.fetch(OLX_TOKEN_URL, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', origin: OLX_ORIGIN, referer: `${OLX_ORIGIN}/`, 'user-agent': this.deps.userAgent },
      body: new URLSearchParams({ client_id: auth.body.client_id, redirect_uri: OLX_REDIRECT_URI, grant_type: 'refresh_token', refresh_token: auth.body.refresh_token }).toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }));
    const tokens = record(await response.json().catch(() => null));
    if (response.status === 400 || response.status === 401) this.expired('OLX');
    if (!response.ok || typeof tokens?.access_token !== 'string') throw new InboxError(`OLX sign-in returned HTTP ${response.status} renewing the session`, 502);
    const expiresIn = Number(tokens.expires_in) > 0 ? Number(tokens.expires_in) : 900;
    const now = Math.floor(this.nowSeconds());
    const cache = {
      ...auth.cache,
      body: { ...auth.body, access_token: tokens.access_token, refresh_token: typeof tokens.refresh_token === 'string' ? tokens.refresh_token : auth.body.refresh_token, expires_in: expiresIn },
      expiresAt: now + expiresIn,
    };
    return {
      cookies: state.cookies.map((cookie) => (cookie.name === 'access_token' && cookie.domain.replace(/^\./, '') === 'olx.pl'
        ? { ...cookie, value: tokens.access_token, expires: Math.max(cookie.expires ?? -1, now + 86_400) }
        : cookie)),
      origins: state.origins.map((origin) => (origin.origin === OLX_ORIGIN
        ? { ...origin, localStorage: (origin.localStorage ?? []).map((item) => (item.name === auth.name ? { ...item, value: JSON.stringify(cache) } : item)) }
        : origin)),
    };
  }

  private async renewVinted(state: MarketplaceStorageState): Promise<MarketplaceStorageState> {
    const now = this.nowSeconds();
    if (!vintedCookie(state, 'refresh_token_web', now)) this.expired('Vinted');
    const url = new URL(VINTED_REFRESH_URL);
    const response = await reach('Vinted', () => this.deps.fetch(url.toString(), {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'content-type': 'application/json', accept: 'application/json, text/plain, */*', 'accept-language': 'pl-PL,pl;q=0.9',
        origin: 'https://www.vinted.pl', referer: 'https://www.vinted.pl/', 'user-agent': this.deps.userAgent,
        'x-csrf-token': VINTED_CSRF_TOKEN, cookie: cookieHeader(state, url, now),
      },
      body: '{}',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }));
    await response.text().catch(() => '');
    if (response.status === 400 || response.status === 401) this.expired('Vinted');
    const setCookies = response.headers.getSetCookie();
    if (!response.ok || !setCookies.some((cookie) => cookie.startsWith('access_token_web='))) throw new InboxError(`Vinted returned HTTP ${response.status} renewing the session`, 502);
    return mergeSetCookies(state, setCookies, url, now);
  }

  /** One GET with the session; a 401 renews the session once (OLX, Vinted) and retries. */
  private async getJson(marketplace: Marketplace, url: string, notFound?: string): Promise<unknown> {
    let session = await this.freshSession(marketplace);
    for (let attempt = 0; ; attempt += 1) {
      const target = new URL(url);
      const headers: Record<string, string> = { accept: 'application/json, text/plain, */*', 'accept-language': 'pl-PL,pl;q=0.9', 'user-agent': this.deps.userAgent };
      const cookie = cookieHeader(session.state, target, this.nowSeconds());
      if (cookie) headers.cookie = cookie;
      if (marketplace === 'OLX') headers.authorization = `Bearer ${olxAccessToken(session.state) ?? ''}`;
      const response = await this.deps.request(marketplace, () => reach(marketplace, () => this.deps.fetch(target.toString(), { method: 'GET', redirect: 'manual', headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })));
      const body = await response.text().catch(() => '');
      if (response.status === 401 && attempt === 0 && marketplace !== 'Allegro Lokalnie') {
        const current = this.storedSession(marketplace);
        session = current.version !== session.version ? current : await this.freshSession(marketplace, true);
        continue;
      }
      if (response.status === 401 || (response.status >= 300 && response.status < 400)) this.expired(marketplace);
      if (response.status === 404 && notFound) throw new InboxError(notFound, 404);
      if (response.status === 403 || response.status === 429) throw new InboxError(`${marketplace} refused the request (HTTP ${response.status}); its bot protection may be blocking this server, so try again later`, 502);
      if (!response.ok) throw new InboxError(`${marketplace} returned HTTP ${response.status}`, 502);
      try {
        const json = JSON.parse(body) as unknown;
        this.deps.sessionUsed(marketplace);
        return json;
      } catch { throw new InboxError(`${marketplace} returned a page instead of data`, 502); }
    }
  }

  private async fetchList(marketplace: Marketplace): Promise<Listed[]> {
    if (marketplace === 'OLX') {
      // The web app lists unread and read conversations separately (unread=1, unread=0).
      const unread = parseOlxConversations(await this.getJson('OLX', `https://api.chat.olx.pl/api/conversations?archived=0&unread=1&limit=${OLX_PAGE}`)).conversations;
      const read = parseOlxConversations(await this.getJson('OLX', `https://api.chat.olx.pl/api/conversations?archived=0&unread=0&limit=${OLX_PAGE}`)).conversations;
      const seen = new Set(unread.map((entry) => entry.rawId));
      return [...unread, ...read.filter((entry) => !seen.has(entry.rawId))].sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
    }
    if (marketplace === 'Vinted') return parseVintedInbox(await this.getJson('Vinted', `https://www.vinted.pl/api/v2/inbox?page=1&per_page=${INBOX_CONVERSATIONS_MAX}`));
    return parseAllegroInbox(await this.getJson('Allegro Lokalnie', `https://allegrolokalnie.pl/api/chat/inbox?page_size=${INBOX_CONVERSATIONS_MAX}&page=1`));
  }

  /** The newest conversations, from the one-minute cache unless `fresh`; concurrent calls share one fetch. */
  private async list(marketplace: Marketplace, fresh = false): Promise<{ fetchedAt: string; conversations: Listed[]; cached: boolean }> {
    const cached = this.lists.get(marketplace);
    if (!fresh && cached && this.now() - cached.at < INBOX_CACHE_MS) return { ...cached, cached: true };
    let pending = this.listing.get(marketplace);
    if (!pending) {
      pending = this.fetchList(marketplace).then((conversations) => {
        const entry = { at: this.now(), fetchedAt: new Date(this.now()).toISOString(), conversations };
        this.lists.set(marketplace, entry);
        return entry;
      }).finally(() => this.listing.delete(marketplace));
      this.listing.set(marketplace, pending);
    }
    return { ...(await pending), cached: false };
  }

  private remember<T>(map: Map<string, T>, key: string, value: T) {
    map.delete(key);
    map.set(key, value);
    if (map.size > LOOKUP_CACHE_LIMIT) map.delete(map.keys().next().value as string);
  }

  /** Vinted: the conversation's messages and listing; never marks it read. */
  private async vintedThread(entry: Pick<Listed, 'id' | 'rawId' | 'url' | 'updatedAt'> & { unread?: boolean }): Promise<Thread> {
    const parsed = parseVintedConversation(await this.getJson('Vinted', `https://www.vinted.pl/api/v2/conversations/${entry.rawId}`, 'Conversation not found'));
    if (!parsed) throw new InboxError('Vinted returned a conversation Scout could not read', 502);
    this.remember(this.lookups, entry.id, parsed.lookup);
    const thread: Thread = {
      at: this.now(),
      updatedAt: entry.updatedAt ?? parsed.messages.at(-1)?.time ?? null,
      conversation: { id: entry.id, url: entry.url, ...parsed.lookup, other: parsed.other, unread: entry.unread ?? parsed.read === false, updatedAt: entry.updatedAt ?? parsed.messages.at(-1)?.time ?? null },
      messages: parsed.messages,
    };
    this.remember(this.threads, entry.id, thread);
    return thread;
  }

  private async allegroListing(entry: Listed) {
    const known = this.lookups.get(entry.id);
    if (known) return known;
    if (!entry.subject) return null;
    const subject = `https://allegrolokalnie.pl/api/chat/subject?subject_type=${encodeURIComponent(entry.subject.type)}&subject_id=${encodeURIComponent(entry.subject.id)}`;
    const lookup = { listingKey: parseAllegroSubject(await this.getJson('Allegro Lokalnie', subject)), role: entry.role, title: entry.title };
    this.remember(this.lookups, entry.id, lookup);
    return lookup;
  }

  private present(entry: Listed): InboxConversation {
    const lookup = this.lookups.get(entry.id);
    const thread = this.threads.get(entry.id);
    const current = thread && thread.updatedAt === entry.updatedAt ? thread.messages.at(-1) ?? null : null;
    return {
      id: entry.id,
      listingKey: entry.listingKey ?? lookup?.listingKey ?? null,
      url: entry.url,
      role: entry.role ?? lookup?.role ?? null,
      other: entry.other,
      title: entry.title ?? lookup?.title ?? null,
      unread: entry.unread,
      updatedAt: entry.updatedAt,
      lastMessage: current ?? entry.lastMessage,
    };
  }

  async inbox(marketplace: Marketplace, options: { since?: string | null; limit?: number } = {}): Promise<InboxResult> {
    const since = options.since ? Date.parse(options.since) : null;
    if (since !== null && !Number.isFinite(since)) throw new InboxError('since must be an ISO 8601 date-time', 400);
    const limit = Math.max(1, Math.min(INBOX_CONVERSATIONS_MAX, Math.floor(options.limit ?? INBOX_CONVERSATIONS_MAX)));
    const { fetchedAt, conversations, cached } = await this.list(marketplace);
    const selected = conversations
      .filter((entry) => since === null || (entry.updatedAt !== null && Date.parse(entry.updatedAt) > since))
      .slice(0, limit);

    // Vinted's list has no listing or author and Allegro Lokalnie's no listing:
    // look up a few conversations per call, unread and newest first.
    if (marketplace !== 'OLX' && !this.deps.readGuard(marketplace)) {
      const stale = selected.filter((entry) => {
        if (marketplace === 'Vinted') return this.threads.get(entry.id)?.updatedAt !== entry.updatedAt || !this.lookups.has(entry.id);
        return !this.lookups.has(entry.id) && Boolean(entry.subject);
      }).sort((a, b) => Number(b.unread) - Number(a.unread)).slice(0, INBOX_LOOKUPS_PER_CALL);
      for (const entry of stale) {
        try {
          if (marketplace === 'Vinted') await this.vintedThread(entry);
          else await this.allegroListing(entry);
        } catch (error) {
          if (error instanceof InboxError && error.status === 401) throw error;
          this.deps.log(`${marketplace} conversation lookup failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    const presented = selected.map((entry) => this.present(entry));
    return { marketplace, fetchedAt, cached, count: presented.length, unread: presented.filter((entry) => entry.unread).length, conversations: presented };
  }

  async conversation(key: string, options: { limit?: number } = {}): Promise<ConversationResult> {
    const { marketplace, id: rawId } = parseConversationKey(key);
    const id = conversationKey(marketplace, rawId);
    const limit = Math.max(1, Math.min(CONVERSATION_MESSAGES_MAX, Math.floor(options.limit ?? CONVERSATION_MESSAGES_DEFAULT)));
    const blocked = this.deps.readGuard(marketplace);
    if (blocked) throw new InboxError(blocked, 409);

    const shape = (thread: Thread, cached: boolean, warning?: string): ConversationResult => ({
      ...thread.conversation,
      fetchedAt: new Date(thread.at).toISOString(),
      cached,
      messages: thread.messages.slice(-limit),
      truncated: thread.messages.length > limit,
      ...(warning ? { warning } : {}),
    });
    const cachedThread = this.threads.get(id);
    if (cachedThread && this.now() - cachedThread.at < INBOX_CACHE_MS) return shape(cachedThread, true);

    if (marketplace === 'OLX') {
      const { thread, cached } = await this.olxThread(rawId);
      return shape(thread, cached);
    }
    if (marketplace === 'Vinted') {
      const listed = (await this.list('Vinted')).conversations.find((entry) => entry.rawId === rawId);
      return shape(await this.vintedThread(listed ?? { id, rawId, url: `https://www.vinted.pl/inbox/${rawId}`, updatedAt: null }), false);
    }

    // Allegro Lokalnie: whether opening a conversation marks it read couldn't
    // be checked by hand (no unread conversation to try). So Scout checks each
    // time it opens an unread one, against an up-to-date list, and stops
    // reading the marketplace's conversations if the flag flipped.
    const listing = await this.list(marketplace);
    let entry = listing.conversations.find((conversation) => conversation.rawId === rawId);
    if (entry?.unread && listing.cached) entry = (await this.list(marketplace, true)).conversations.find((conversation) => conversation.rawId === rawId);
    entry ??= parseAllegroInbox(await this.getJson(marketplace, `https://allegrolokalnie.pl/api/chat/inbox/${encodeURIComponent(rawId)}`, 'Conversation not found'))[0];
    if (!entry) throw new InboxError('Conversation not found', 404);
    const messages = parseAllegroMessages(await this.getJson(marketplace, `https://allegrolokalnie.pl/api/chat/messages?conversation_id=${encodeURIComponent(rawId)}`, 'Conversation not found'), entry.other.id);
    await this.allegroListing(entry).catch((error) => {
      if (error instanceof InboxError && error.status === 401) throw error;
      return null;
    });
    const { lastMessage: _last, ...conversation } = this.present(entry);
    const thread: Thread = { at: this.now(), updatedAt: entry.updatedAt, conversation, messages };
    this.remember(this.threads, id, thread);
    if (entry.unread) {
      const after = (await this.list(marketplace, true)).conversations.find((conversation) => conversation.rawId === rawId);
      if (after && !after.unread) {
        const reason = `Scout stopped reading ${marketplace} conversations: opening ${id} marked it read on ${marketplace}. scout_inbox still works; re-importing the session lets Scout try again.`;
        this.deps.tripGuard(marketplace, reason);
        this.deps.log(reason);
        return shape(thread, false, reason);
      }
    }
    return shape(thread, false);
  }

  /**
   * OLX: the conversation's messages come with the list, so no thread endpoint
   * (and no read receipt) is touched. A thread from the cached list is as old
   * as the list.
   */
  private async olxThread(rawId: string): Promise<{ thread: Thread; cached: boolean }> {
    const listing = await this.list('OLX');
    const listed = listing.conversations.find((conversation) => conversation.rawId === rawId);
    let entry = listed;
    for (let page = 1; !entry && page < OLX_PAGES; page += 1) {
      const older = parseOlxConversations(await this.getJson('OLX', `https://api.chat.olx.pl/api/conversations?archived=0&unread=0&limit=${OLX_PAGE}&offset=${page * OLX_PAGE}`));
      entry = older.conversations.find((conversation) => conversation.rawId === rawId);
      if (older.conversations.length < OLX_PAGE) break;
    }
    if (!entry) throw new InboxError(`Conversation not found among the newest ${OLX_PAGE * OLX_PAGES} OLX conversations`, 404);
    const { lastMessage: _last, rawId: _raw, messages, subject: _subject, ...conversation } = entry;
    const thread: Thread = { at: listed ? Date.parse(listing.fetchedAt) : this.now(), updatedAt: entry.updatedAt, conversation, messages: messages ?? [] };
    this.remember(this.threads, entry.id, thread);
    return { thread, cached: Boolean(listed) && listing.cached };
  }
}
