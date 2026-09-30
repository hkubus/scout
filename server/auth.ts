// Single-operator authentication: a password-backed browser session (HttpOnly
// cookie, server-side session rows) plus optional static bearer tokens for
// MCP clients and scripts. Everything here is independent of Fastify so it can
// be unit tested directly.
import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import type { ScryptOptions } from 'node:crypto';
import { isIP } from 'node:net';

type Db = { prepare: (sql: string) => { run: (...args: any[]) => unknown; get: (...args: any[]) => unknown } };

const scrypt = (password: string, salt: Buffer, keylen: number, options: ScryptOptions) => new Promise<Buffer>((resolve, reject) => {
  scryptCallback(password, salt, keylen, options, (error, key) => (error ? reject(error) : resolve(key)));
});

const SCRYPT_N = 32_768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 32;
const MIN_PASSWORD_LENGTH = 12;
const MIN_TOKEN_LENGTH = 32;

export const SESSION_COOKIE = 'scout_session';
export const SESSION_IDLE_MS = 7 * 24 * 60 * 60_000;
export const SESSION_ABSOLUTE_MS = 30 * 24 * 60 * 60_000;
const SESSION_TOUCH_MS = 5 * 60_000;

const b64 = (buffer: Buffer) => buffer.toString('base64url');
const sha256 = (value: string) => createHash('sha256').update(value).digest();

/** Encode a password as `scrypt$N$r$p$salt$hash` (base64url fields). */
export async function hashPassword(password: string) {
  const salt = randomBytes(16);
  const key = await scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: 128 * SCRYPT_N * SCRYPT_R * 2 });
  return ['scrypt', SCRYPT_N, SCRYPT_R, SCRYPT_P, b64(salt), b64(key)].join('$');
}

function parsePasswordHash(stored: string) {
  const parts = stored.trim().split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const [n, r, p] = parts.slice(1, 4).map(Number);
  const salt = Buffer.from(parts[4], 'base64url');
  const key = Buffer.from(parts[5], 'base64url');
  const powerOfTwo = Number.isInteger(n) && n >= 16_384 && n <= 1_048_576 && (n & (n - 1)) === 0;
  if (!powerOfTwo || !Number.isInteger(r) || r < 1 || r > 32 || !Number.isInteger(p) || p < 1 || p > 16 || salt.length < 16 || key.length < 16) return null;
  return { n, r, p, salt, key };
}

export function isValidPasswordHash(stored: string) {
  return parsePasswordHash(stored) !== null;
}

export async function verifyPassword(password: string, stored: string) {
  const parsed = parsePasswordHash(stored);
  if (!parsed) return false;
  const key = await scrypt(password.normalize('NFKC'), parsed.salt, parsed.key.length, { N: parsed.n, r: parsed.r, p: parsed.p, maxmem: 128 * parsed.n * parsed.r * 2 });
  return timingSafeEqual(key, parsed.key);
}

export type AuthConfig = {
  enabled: boolean;
  passwordHash: string | null;
  /** SHA-256 digests of the configured bearer tokens. */
  tokenDigests: Buffer[];
  /** Fingerprint of the password; sessions minted under another password are rejected. */
  credentialId: string;
  /** True only when SCOUT_AUTH=off explicitly accepted unauthenticated trusted-network mode. */
  explicitlyOff: boolean;
};

/**
 * Read credentials from the environment. Auth is on whenever any credential
 * is configured. With none configured Scout refuses to start when it listens
 * beyond loopback or is configured for a reverse proxy (`proxied`), unless
 * SCOUT_AUTH=off explicitly opts back into trusted-network mode.
 */
export async function loadAuthConfig(env: NodeJS.ProcessEnv, options: { publiclyBound: boolean; proxied?: boolean }): Promise<AuthConfig> {
  const mode = env.SCOUT_AUTH?.trim().toLowerCase() ?? '';
  if (mode && mode !== 'off' && mode !== 'on') throw new Error('SCOUT_AUTH must be "on" or "off"');

  const configuredHash = env.SCOUT_PASSWORD_HASH?.trim() ?? '';
  const plainPassword = env.SCOUT_PASSWORD ?? '';
  if (configuredHash && plainPassword) throw new Error('Set only one of SCOUT_PASSWORD_HASH or SCOUT_PASSWORD');
  if (configuredHash && !isValidPasswordHash(configuredHash)) throw new Error('SCOUT_PASSWORD_HASH is not a valid scrypt hash; generate one with `node scripts/hash-password.mjs`');
  if (plainPassword && plainPassword.length < MIN_PASSWORD_LENGTH) throw new Error(`SCOUT_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters`);
  const passwordHash = configuredHash || (plainPassword ? await hashPassword(plainPassword) : null);

  const tokens = (env.SCOUT_API_TOKENS ?? '').split(',').map((token) => token.trim()).filter(Boolean);
  for (const token of tokens) {
    if (token.length < MIN_TOKEN_LENGTH) throw new Error(`Every SCOUT_API_TOKENS entry must be at least ${MIN_TOKEN_LENGTH} characters`);
  }

  const hasCredentials = Boolean(passwordHash) || tokens.length > 0;
  if (mode === 'off') {
    if (hasCredentials) throw new Error('SCOUT_AUTH=off conflicts with configured SCOUT_PASSWORD/SCOUT_PASSWORD_HASH/SCOUT_API_TOKENS');
    return { enabled: false, passwordHash: null, tokenDigests: [], credentialId: '', explicitlyOff: true };
  }
  if (!hasCredentials && (mode === 'on' || options.publiclyBound || options.proxied)) {
    const reason = mode === 'on'
      ? 'SCOUT_AUTH=on is set but no credentials are configured, so Scout would run without authentication'
      : options.publiclyBound
        ? 'Scout is listening beyond loopback without authentication'
        : 'Scout is configured for a reverse proxy (SCOUT_TRUST_PROXY or SCOUT_PUBLIC_ORIGIN is set) without authentication, so the proxy would publish it unprotected';
    throw new Error(`${reason}. Set SCOUT_PASSWORD_HASH (or SCOUT_PASSWORD) and/or SCOUT_API_TOKENS, or set SCOUT_AUTH=off to accept trusted-LAN mode.`);
  }
  // With SCOUT_PASSWORD the hash is re-salted on every boot, so fingerprint the
  // plaintext instead (slow and keyed by SCOUT_SECRET, since the fingerprint is
  // stored beside each session) to keep sessions valid across restarts.
  const credentialId = configuredHash
    ? createHash('sha256').update(`scout-credential:${configuredHash}`).digest('hex').slice(0, 32)
    : plainPassword
      ? (await scrypt(plainPassword.normalize('NFKC'), sha256(`scout-credential:${env.SCOUT_SECRET ?? ''}`), 16, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: 128 * SCRYPT_N * SCRYPT_R * 2 })).toString('hex')
      : '';
  return { enabled: hasCredentials, passwordHash, tokenDigests: tokens.map(sha256), credentialId, explicitlyOff: false };
}

/**
 * Whether a matched route template needs a credential. Callers must pass the
 * router's template (`request.routeOptions.url`), not the raw request URL,
 * because routing percent-decodes the path. Unmatched requests only reach the
 * not-found handler, which serves no data.
 */
export function isProtectedRoute(routeUrl: string | undefined): routeUrl is string {
  if (!routeUrl) return false;
  return routeUrl.startsWith('/api/') || routeUrl === '/events' || routeUrl === '/mcp';
}

export function bearerToken(header: string | undefined) {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header ?? '');
  return match ? match[1] : null;
}

export function matchesApiToken(config: AuthConfig, token: string) {
  const digest = sha256(token);
  let matched = false;
  // Compare against every token so timing does not reveal which one matched.
  for (const candidate of config.tokenDigests) matched = timingSafeEqual(candidate, digest) || matched;
  return matched;
}

export function parseCookies(header: string | undefined) {
  const cookies = new Map<string, string>();
  for (const part of (header ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!cookies.has(name)) {
      try { cookies.set(name, decodeURIComponent(value)); } catch { /* ignore malformed cookie */ }
    }
  }
  return cookies;
}

export function sessionCookie(token: string, secure: boolean, maxAgeMs = SESSION_ABSOLUTE_MS) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(maxAgeMs / 1000)}${secure ? '; Secure' : ''}`;
}

export function clearedSessionCookie(secure: boolean) {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`;
}

/**
 * CSRF guard for cookie-authenticated state changes. Browsers always attach
 * Origin to cross-origin and non-GET fetches and Sec-Fetch-Site to every
 * request, and neither can be set by page script. The source must match the
 * full origin (scheme, host, and port) the request arrived on, or one of the
 * configured public origins.
 */
export function isSameOriginRequest(headers: { origin?: string; 'sec-fetch-site'?: string; referer?: string }, requestOrigin: string, allowedOrigins: readonly string[] = []) {
  const fetchSite = headers['sec-fetch-site'];
  if (fetchSite && fetchSite !== 'same-origin') return false;
  const source = headers.origin ?? headers.referer;
  if (!source || source === 'null') return fetchSite === 'same-origin';
  let parsed: URL;
  try { parsed = new URL(source); } catch { return false; }
  let own: string | null = null;
  try { own = new URL(requestOrigin).origin; } catch { /* malformed Host: rely on the allowlist */ }
  return parsed.origin === own || allowedOrigins.includes(parsed.origin);
}

export class SessionStore {
  constructor(private readonly db: Db, private readonly credentialId: string) {}

  create(meta: { ip?: string; userAgent?: string }, now = Date.now()) {
    const token = b64(randomBytes(32));
    const iso = new Date(now).toISOString();
    this.db.prepare('INSERT INTO auth_sessions (token_hash, credential_id, created_at, last_seen_at, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(this.hash(token), this.credentialId, iso, iso, new Date(now + SESSION_ABSOLUTE_MS).toISOString(), meta.ip ?? null, (meta.userAgent ?? '').slice(0, 300) || null);
    return token;
  }

  /** Returns true for a live session and slides its idle window forward. */
  validate(token: string, now = Date.now()) {
    const session = this.lookup(token, now);
    if (!session) return false;
    if (now - session.lastSeen > SESSION_TOUCH_MS) this.db.prepare('UPDATE auth_sessions SET last_seen_at = ? WHERE token_hash = ?').run(new Date(now).toISOString(), session.tokenHash);
    return true;
  }

  /** Like validate(), but never extends the idle window (for background checks such as live-stream heartbeats). */
  isActive(token: string, now = Date.now()) {
    return this.lookup(token, now) !== null;
  }

  private lookup(token: string, now: number) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const tokenHash = this.hash(token);
    const row = this.db.prepare('SELECT credential_id, last_seen_at, expires_at FROM auth_sessions WHERE token_hash = ?').get(tokenHash) as { credential_id: string; last_seen_at: string; expires_at: string } | undefined;
    if (!row) return null;
    const lastSeen = Date.parse(row.last_seen_at);
    if (row.credential_id !== this.credentialId || Date.parse(row.expires_at) <= now || lastSeen + SESSION_IDLE_MS <= now) {
      this.db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(tokenHash);
      return null;
    }
    return { tokenHash, lastSeen };
  }

  revoke(token: string) {
    this.db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(this.hash(token));
  }

  revokeAll() {
    this.db.prepare('DELETE FROM auth_sessions').run();
  }

  purgeExpired(now = Date.now()) {
    this.db.prepare('DELETE FROM auth_sessions WHERE expires_at <= ? OR last_seen_at <= ? OR credential_id <> ?')
      .run(new Date(now).toISOString(), new Date(now - SESSION_IDLE_MS).toISOString(), this.credentialId);
  }

  private hash(token: string) {
    return sha256(token).toString('hex');
  }
}

const PROXY_ADDRESS_NAMES = new Set(['loopback', 'linklocal', 'uniquelocal']);

function isProxyAddress(entry: string) {
  if (PROXY_ADDRESS_NAMES.has(entry)) return true;
  const [address, prefix, ...rest] = entry.split('/');
  const family = isIP(address);
  if (!family || rest.length > 0) return false;
  if (prefix === undefined) return true;
  // proxy-addr also accepts a dotted IPv4 netmask such as 255.255.255.0.
  if (family === 4 && isIP(prefix) === 4) return true;
  return /^\d{1,3}$/.test(prefix) && Number(prefix) <= (family === 4 ? 32 : 128);
}

/**
 * Parse SCOUT_TRUST_PROXY into Fastify's trustProxy option: `true`/`false`, a
 * hop count, or comma-separated proxy IPs/CIDRs (plus proxy-addr's
 * `loopback`/`linklocal`/`uniquelocal`). Anything else fails startup clearly.
 */
export function trustProxySetting(value: string | undefined): boolean | string | ((address: string, hop: number) => boolean) {
  const raw = value?.trim() ?? '';
  if (!raw || raw.toLowerCase() === 'false') return false;
  if (raw.toLowerCase() === 'true') return true;
  if (/^\d+$/.test(raw)) {
    const hops = Number(raw);
    return (_address, hop) => hop < hops;
  }
  const entries = raw.split(',').map((entry) => entry.trim());
  const invalid = entries.find((entry) => !isProxyAddress(entry));
  if (invalid !== undefined) {
    throw new Error(`SCOUT_TRUST_PROXY must be true, false, a hop count, or comma-separated proxy IPs/CIDRs (invalid entry: "${invalid}")`);
  }
  return entries.join(',');
}
