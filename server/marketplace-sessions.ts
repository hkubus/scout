import { isApprovedMarketplaceSessionHost, type Marketplace } from './marketplaces';

export type SameSite = 'Strict' | 'Lax' | 'None';

export interface MarketplaceCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: SameSite;
}

export interface MarketplaceStorageOrigin {
  origin: string;
  localStorage?: Array<{ name: string; value: string }>;
}

export interface MarketplaceStorageState {
  cookies: MarketplaceCookie[];
  origins: MarketplaceStorageOrigin[];
}

export const MAX_STORAGE_STATE_BYTES = 512 * 1024;

export class MarketplaceSessionValidationError extends Error {}

function fail(message: string): never {
  throw new MarketplaceSessionValidationError(message);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, maxLength: number) {
  if (typeof value !== 'string' || value.length > maxLength) fail(`${label} must be a string of at most ${maxLength} characters`);
  return value;
}

function optionalBoolean(value: Record<string, unknown>, key: string) {
  if (value[key] !== undefined && typeof value[key] !== 'boolean') fail(`${key} must be a boolean`);
  return value[key] as boolean | undefined;
}

function parseInput(input: unknown) {
  if (typeof input !== 'string') return input;
  if (Buffer.byteLength(input, 'utf8') > MAX_STORAGE_STATE_BYTES) fail(`Storage state is larger than ${MAX_STORAGE_STATE_BYTES} bytes`);
  try { return JSON.parse(input) as unknown; } catch { fail('Storage state must be valid JSON'); }
}

export function parseMarketplaceStorageState(input: unknown, marketplace: Marketplace): MarketplaceStorageState {
  const parsed = record(parseInput(input), 'Storage state');
  const rawCookies = parsed.cookies;
  const rawOrigins = parsed.origins;
  if (!Array.isArray(rawCookies) || rawCookies.length > 500) fail('Storage state cookies must be an array with at most 500 entries');
  if (rawOrigins !== undefined && (!Array.isArray(rawOrigins) || rawOrigins.length > 50)) fail('Storage state origins must be an array with at most 50 entries');

  const cookies = rawCookies.map((raw, index) => {
    const value = record(raw, `Cookie ${index + 1}`);
    const name = text(value.name, `Cookie ${index + 1} name`, 256);
    const cookieValue = text(value.value, `Cookie ${index + 1} value`, 32_768);
    const domain = text(value.domain, `Cookie ${index + 1} domain`, 255).trim();
    const normalizedDomain = domain.replace(/^\.+/, '').toLowerCase();
    if (!normalizedDomain || !isApprovedMarketplaceSessionHost(marketplace, normalizedDomain)) fail(`Cookie ${index + 1} belongs outside ${marketplace}`);
    const path = text(value.path, `Cookie ${index + 1} path`, 2_048);
    if (!path.startsWith('/')) fail(`Cookie ${index + 1} path must start with /`);
    if (value.expires !== undefined && (typeof value.expires !== 'number' || !Number.isFinite(value.expires))) fail(`Cookie ${index + 1} expires must be a finite number`);
    const sameSite = value.sameSite as SameSite | undefined;
    if (sameSite !== undefined && !['Strict', 'Lax', 'None'].includes(sameSite)) fail(`Cookie ${index + 1} has an unsupported sameSite value`);
    return {
      name, value: cookieValue, domain, path,
      ...(value.expires === undefined ? {} : { expires: value.expires as number }),
      ...(optionalBoolean(value, 'httpOnly') === undefined ? {} : { httpOnly: optionalBoolean(value, 'httpOnly') }),
      ...(optionalBoolean(value, 'secure') === undefined ? {} : { secure: optionalBoolean(value, 'secure') }),
      ...(sameSite === undefined ? {} : { sameSite }),
    } satisfies MarketplaceCookie;
  });

  const origins = (rawOrigins ?? []).map((raw, index) => {
    const value = record(raw, `Origin ${index + 1}`);
    const rawOrigin = text(value.origin, `Origin ${index + 1}`, 512);
    let parsedOrigin: URL;
    try { parsedOrigin = new URL(rawOrigin); } catch { fail(`Origin ${index + 1} must be a valid URL`); }
    if (parsedOrigin.protocol !== 'https:' || parsedOrigin.username || parsedOrigin.password || parsedOrigin.port || parsedOrigin.pathname !== '/' || parsedOrigin.search || parsedOrigin.hash || !isApprovedMarketplaceSessionHost(marketplace, parsedOrigin.hostname)) {
      fail(`Origin ${index + 1} is outside the approved ${marketplace} HTTPS origin`);
    }
    const rawStorage = value.localStorage;
    if (rawStorage !== undefined && (!Array.isArray(rawStorage) || rawStorage.length > 1_000)) fail(`Origin ${index + 1} localStorage must be an array with at most 1000 entries`);
    const localStorage = (rawStorage ?? []).map((rawItem, itemIndex) => {
      const item = record(rawItem, `Origin ${index + 1} localStorage item ${itemIndex + 1}`);
      return { name: text(item.name, 'localStorage name', 512), value: text(item.value, 'localStorage value', 32_768) };
    });
    return { origin: parsedOrigin.origin, ...(localStorage.length ? { localStorage } : {}) } satisfies MarketplaceStorageOrigin;
  });

  const state = { cookies, origins } satisfies MarketplaceStorageState;
  if (!cookies.length && !origins.some((origin) => (origin.localStorage?.length ?? 0) > 0)) fail('Storage state does not contain any cookies or localStorage entries');
  if (Buffer.byteLength(JSON.stringify(state), 'utf8') > MAX_STORAGE_STATE_BYTES) fail(`Storage state is larger than ${MAX_STORAGE_STATE_BYTES} bytes`);
  return state;
}
