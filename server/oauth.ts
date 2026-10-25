// Connected apps: OAuth 2.1 with PKCE for public clients, as in MCP's
// authorization spec, so an app such as Hatbot connects with one button
// instead of the operator editing SCOUT_API_TOKENS. The app registers itself,
// the operator presses Allow on Scout's "Let … in?" page, and the app trades
// the one-time code for a token that works on /mcp only. Codes and tokens are
// stored only as SHA-256 digests; a token lasts until the operator disconnects it.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { securityHeaders } from './security';

type Db = {
  exec: (sql: string) => unknown;
  prepare: (sql: string) => { run: (...args: any[]) => { changes: number | bigint; lastInsertRowid: number | bigint }; get: (...args: any[]) => unknown; all: (...args: any[]) => unknown[] };
};

/** Every connected-app token starts with this, so Scout can tell one apart from a SCOUT_API_TOKENS entry. */
export const CONNECTED_APP_TOKEN_PREFIX = 'scout_app_';
export const CODE_TTL_MS = 5 * 60_000;
export const MAX_CLIENTS = 50;
const UNUSED_CLIENT_MS = 24 * 60 * 60_000;
const LAST_USED_TOUCH_MS = 60_000;
const MAX_REDIRECT_URIS = 10;

export const CONSENT_PATH = '/oauth/authorize';
const OAUTH_ROUTES = new Set(['/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource', '/oauth/register', CONSENT_PATH, '/oauth/token']);

/** The OAuth endpoints, which sit outside /api and authenticate on their own terms. */
export function isOAuthRoute(routeUrl: string | undefined): routeUrl is string {
  return routeUrl !== undefined && OAUTH_ROUTES.has(routeUrl);
}

export const isConnectedAppToken = (token: string) => token.startsWith(CONNECTED_APP_TOKEN_PREFIX);

/** `resource_metadata` points MCP clients at the metadata that starts the OAuth flow. */
export const mcpChallenge = (origin: string) => `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`;

export class OAuthError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message);
  }
}

export type OAuthClient = { id: string; name: string; redirectUris: string[] };
export type ConnectedApp = { id: number; name: string; connectedAt: string; lastUsedAt: string | null };
export type Authorization = { client: OAuthClient; redirectUri: string; codeChallenge: string; state: string | undefined };

const sha256Hex = (value: string) => createHash('sha256').update(value).digest('hex');
const randomToken = () => randomBytes(32).toString('base64url');
const iso = (ms: number) => new Date(ms).toISOString();
const text = (value: unknown) => (typeof value === 'string' ? value : undefined);

function redirectUriProblem(raw: unknown) {
  if (typeof raw !== 'string' || raw.length > 2000) return 'Each redirect URI must be a string of at most 2000 characters.';
  if (raw.includes('#')) return 'Redirect URIs must not have a fragment.';
  let url: URL;
  try { url = new URL(raw); } catch { return `${raw} is not a URL.`; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'Redirect URIs must be http or https URLs.';
  if (url.username || url.password) return 'Redirect URIs must not carry credentials.';
  return null;
}

export class OAuthStore {
  constructor(private readonly db: Db) {}

  /** RFC 7591 dynamic registration, limited to public clients using the authorization code. */
  register(input: unknown, now = Date.now()): OAuthClient {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new OAuthError('invalid_client_metadata', 'Send the registration as a JSON object.');
    const body = input as Record<string, unknown>;
    const name = typeof body.client_name === 'string' ? body.client_name.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim() : '';
    if (!name || name.length > 100) throw new OAuthError('invalid_client_metadata', 'client_name must be 1 to 100 characters.');
    const uris = body.redirect_uris;
    if (!Array.isArray(uris) || uris.length === 0 || uris.length > MAX_REDIRECT_URIS) throw new OAuthError('invalid_redirect_uri', `redirect_uris must list 1 to ${MAX_REDIRECT_URIS} URIs.`);
    for (const uri of uris) {
      const problem = redirectUriProblem(uri);
      if (problem) throw new OAuthError('invalid_redirect_uri', problem);
    }
    if (body.grant_types !== undefined && !(Array.isArray(body.grant_types) && body.grant_types.includes('authorization_code'))) {
      throw new OAuthError('invalid_client_metadata', 'Scout grants only authorization_code.');
    }
    if (body.response_types !== undefined && !(Array.isArray(body.response_types) && body.response_types.includes('code'))) {
      throw new OAuthError('invalid_client_metadata', 'Scout answers only response_type code.');
    }
    if (body.token_endpoint_auth_method !== undefined && body.token_endpoint_auth_method !== 'none') {
      throw new OAuthError('invalid_client_metadata', 'Scout registers only public clients (token_endpoint_auth_method "none").');
    }
    this.purgeClients(now);
    const count = Number((this.db.prepare('SELECT COUNT(*) AS count FROM oauth_clients').get() as { count: number }).count);
    if (count >= MAX_CLIENTS) {
      // Make room by dropping the oldest app that holds no token, so a burst of
      // registrations can't lock the owner out for a day.
      const evicted = this.db.prepare('DELETE FROM oauth_clients WHERE id = (SELECT id FROM oauth_clients WHERE id NOT IN (SELECT client_id FROM connected_app_tokens) ORDER BY created_at LIMIT 1)').run();
      if (Number(evicted.changes) === 0) throw new OAuthError('invalid_client_metadata', `Scout already has ${MAX_CLIENTS} connected apps. Disconnect some in Settings first.`);
    }
    const client: OAuthClient = { id: randomBytes(16).toString('base64url'), name, redirectUris: [...new Set(uris as string[])] };
    this.db.prepare('INSERT INTO oauth_clients (id, name, redirect_uris_json, created_at) VALUES (?, ?, ?, ?)').run(client.id, client.name, JSON.stringify(client.redirectUris), iso(now));
    return client;
  }

  /** Drop apps registered over a day ago that hold no token: never connected, or since disconnected. */
  purgeClients(now = Date.now()) {
    this.db.prepare('DELETE FROM oauth_clients WHERE created_at <= ? AND id NOT IN (SELECT client_id FROM connected_app_tokens)').run(iso(now - UNUSED_CLIENT_MS));
    this.db.prepare('DELETE FROM oauth_codes WHERE expires_at <= ?').run(iso(now));
  }

  client(id: string): OAuthClient | null {
    const row = this.db.prepare('SELECT id, name, redirect_uris_json FROM oauth_clients WHERE id = ?').get(id) as { id: string; name: string; redirect_uris_json: string } | undefined;
    return row ? { id: row.id, name: row.name, redirectUris: JSON.parse(row.redirect_uris_json) as string[] } : null;
  }

  /**
   * Check an authorization request. Every failure is shown on Scout's page and
   * redirects nowhere: an unknown client or redirect_uri can't be trusted with
   * an error redirect, and Scout's own clients never send the rest wrong.
   */
  authorization(params: Record<string, unknown>): Authorization {
    const clientId = text(params.client_id);
    const client = clientId ? this.client(clientId) : null;
    if (!client) throw new OAuthError('invalid_client', "Scout doesn't know this app. Start connecting again from the app.");
    const redirectUri = text(params.redirect_uri);
    if (!redirectUri || !client.redirectUris.includes(redirectUri)) throw new OAuthError('invalid_request', "This app asked to go back to an address it didn't register, so Scout won't send it there.");
    if (text(params.response_type) !== 'code') throw new OAuthError('unsupported_response_type', 'The app asked for something other than response_type=code.');
    if (text(params.code_challenge_method) !== 'S256') throw new OAuthError('invalid_request', 'The app must use PKCE with code_challenge_method=S256.');
    const codeChallenge = text(params.code_challenge);
    if (!codeChallenge || !/^[A-Za-z0-9_-]{43,128}$/.test(codeChallenge)) throw new OAuthError('invalid_request', 'The app sent no valid code_challenge.');
    const state = text(params.state);
    if (state !== undefined && state.length > 1000) throw new OAuthError('invalid_request', 'The app sent an overlong state.');
    return { client, redirectUri, codeChallenge, state };
  }

  /** A one-time code bound to the client, redirect_uri and code_challenge. */
  createCode(authorization: Authorization, now = Date.now()) {
    this.db.prepare('DELETE FROM oauth_codes WHERE expires_at <= ?').run(iso(now));
    const code = randomToken();
    this.db.prepare('INSERT INTO oauth_codes (code_hash, client_id, redirect_uri, code_challenge, expires_at) VALUES (?, ?, ?, ?, ?)')
      .run(sha256Hex(code), authorization.client.id, authorization.redirectUri, authorization.codeChallenge, iso(now + CODE_TTL_MS));
    return code;
  }

  /** The token endpoint: trade a code and its PKCE verifier for a token, once. */
  exchange(params: Record<string, unknown>, now = Date.now()) {
    if (text(params.grant_type) !== 'authorization_code') throw new OAuthError('unsupported_grant_type', 'Scout grants only authorization_code.');
    const code = text(params.code);
    const redirectUri = text(params.redirect_uri);
    const clientId = text(params.client_id);
    const verifier = text(params.code_verifier);
    if (!code || !redirectUri || !clientId || !verifier) throw new OAuthError('invalid_request', 'Send code, redirect_uri, client_id and code_verifier.');
    const codeHash = sha256Hex(code);
    const row = this.db.prepare('SELECT client_id, redirect_uri, code_challenge, expires_at, used_at, token_id FROM oauth_codes WHERE code_hash = ?').get(codeHash) as
      { client_id: string; redirect_uri: string; code_challenge: string; expires_at: string; used_at: string | null; token_id: number | null } | undefined;
    if (!row) throw new OAuthError('invalid_grant', 'The code is unknown or has expired.');
    if (row.used_at !== null) {
      // A replayed code may have been stolen, so the token it gave stops working too (RFC 6749 §4.1.2).
      if (row.token_id !== null) this.db.prepare('DELETE FROM connected_app_tokens WHERE id = ?').run(row.token_id);
      throw new OAuthError('invalid_grant', 'The code was already used.');
    }
    if (Date.parse(row.expires_at) <= now) throw new OAuthError('invalid_grant', 'The code has expired.');
    if (row.client_id !== clientId || row.redirect_uri !== redirectUri) throw new OAuthError('invalid_grant', 'The code was given to a different client or redirect_uri.');
    const expected = Buffer.from(row.code_challenge);
    const actual = Buffer.from(createHash('sha256').update(verifier).digest('base64url'));
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      throw new OAuthError('invalid_grant', "The code_verifier doesn't match the code_challenge.");
    }
    const client = this.client(clientId);
    if (!client) throw new OAuthError('invalid_grant', 'The app that asked for this code is gone.');
    const token = `${CONNECTED_APP_TOKEN_PREFIX}${randomToken()}`;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const claimed = this.db.prepare('UPDATE oauth_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL').run(iso(now), codeHash);
      if (Number(claimed.changes) !== 1) throw new OAuthError('invalid_grant', 'The code was already used.');
      const inserted = this.db.prepare('INSERT INTO connected_app_tokens (token_hash, client_id, client_name, created_at) VALUES (?, ?, ?, ?)').run(sha256Hex(token), client.id, client.name, iso(now));
      this.db.prepare('UPDATE oauth_codes SET token_id = ? WHERE code_hash = ?').run(Number(inserted.lastInsertRowid), codeHash);
      this.db.prepare('UPDATE oauth_clients SET first_token_at = COALESCE(first_token_at, ?) WHERE id = ?').run(iso(now), client.id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return token;
  }

  /** The connected app a token belongs to, or null; notes when it was last used. */
  verify(token: string, now = Date.now()): ConnectedApp | null {
    if (!isConnectedAppToken(token) || token.length > 200) return null;
    const tokenHash = sha256Hex(token);
    const row = this.db.prepare('SELECT id, client_name, created_at, last_used_at FROM connected_app_tokens WHERE token_hash = ?').get(tokenHash) as
      { id: number; client_name: string; created_at: string; last_used_at: string | null } | undefined;
    if (!row) return null;
    let lastUsedAt = row.last_used_at;
    if (lastUsedAt === null || Date.parse(lastUsedAt) + LAST_USED_TOUCH_MS <= now) {
      lastUsedAt = iso(now);
      this.db.prepare('UPDATE connected_app_tokens SET last_used_at = ? WHERE id = ?').run(lastUsedAt, row.id);
    }
    return { id: Number(row.id), name: row.client_name, connectedAt: row.created_at, lastUsedAt };
  }

  list(): ConnectedApp[] {
    return (this.db.prepare('SELECT id, client_name, created_at, last_used_at FROM connected_app_tokens ORDER BY created_at DESC, id DESC').all() as Array<{ id: number; client_name: string; created_at: string; last_used_at: string | null }>)
      .map((row) => ({ id: Number(row.id), name: row.client_name, connectedAt: row.created_at, lastUsedAt: row.last_used_at }));
  }

  /** Disconnect: the token stops working on the next request. */
  revoke(id: number) {
    return Number(this.db.prepare('DELETE FROM connected_app_tokens WHERE id = ?').run(id).changes) > 0;
  }
}

/** The page's CSP, letting its Allow/Cancel form follow Scout's 302 to the app. */
export function consentPagePolicy(redirectOrigin: string) {
  return securityHeaders()['Content-Security-Policy'].replace("form-action 'self'", `form-action 'self' ${redirectOrigin}`);
}

const requestOrigin = (request: FastifyRequest) => `${request.protocol}://${request.host}`;

function redirectTo(base: string, params: Record<string, string | undefined>) {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(key, value);
  return url.href;
}

function sendOAuthError(reply: FastifyReply, error: unknown) {
  if (!(error instanceof OAuthError)) throw error;
  return reply.code(error.status).header('cache-control', 'no-store').send({ error: error.code, error_description: error.message });
}

export type OAuthRouteOptions = {
  store: OAuthStore;
  /** Serve the dashboard shell, which renders the sign-in or the "Let … in?" page. */
  sendPage: (reply: FastifyReply) => unknown;
  /** Whether this request may press Allow: a signed-in session, or any request while auth is off. */
  canConsent: (request: FastifyRequest) => boolean;
  /** Where apps reach Scout; by default the origin the request came in on. */
  origin?: (request: FastifyRequest) => string;
};

/**
 * Registers the OAuth endpoints and the dashboard's /api routes for them. The
 * caller's onRequest hooks decide who reaches what: the /api routes need the
 * dashboard's sign-in and the Allow POST a same-origin session.
 */
export async function registerOAuthRoutes(app: FastifyInstance, { store, sendPage, canConsent, origin: originOf = requestOrigin }: OAuthRouteOptions) {
  app.get('/.well-known/oauth-authorization-server', async (request) => {
    const origin = originOf(request);
    return {
      issuer: origin,
      authorization_endpoint: `${origin}${CONSENT_PATH}`,
      token_endpoint: `${origin}/oauth/token`,
      registration_endpoint: `${origin}/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
    };
  });

  app.get('/.well-known/oauth-protected-resource', async (request) => {
    const origin = originOf(request);
    return { resource: `${origin}/mcp`, authorization_servers: [origin] };
  });

  app.get(CONSENT_PATH, async (request, reply) => {
    try {
      const { redirectUri } = store.authorization(request.query as Record<string, unknown>);
      reply.header('Content-Security-Policy', consentPagePolicy(new URL(redirectUri).origin));
    } catch (error) {
      // The page shows what's wrong once signed in; its form can't leave Scout.
      if (!(error instanceof OAuthError)) throw error;
    }
    reply.header('cache-control', 'no-store');
    return sendPage(reply);
  });

  // What the page shows: needs the dashboard's sign-in, being under /api.
  app.get('/api/oauth/authorize', async (request, reply) => {
    try {
      const { client, redirectUri } = store.authorization(request.query as Record<string, unknown>);
      return { clientName: client.name, redirectOrigin: new URL(redirectUri).origin };
    } catch (error) {
      if (!(error instanceof OAuthError)) throw error;
      return reply.code(400).send({ error: error.message });
    }
  });

  app.get('/api/connected-apps', async () => ({ apps: store.list() }));
  app.delete('/api/connected-apps/:id', async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!Number.isSafeInteger(id) || !store.revoke(id)) return reply.code(404).send({ error: 'That app is not connected' });
    return { ok: true };
  });

  // Form posts are parsed only here, so /api keeps refusing them (a cross-site
  // form can't send JSON).
  await app.register(async (scope) => {
    scope.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 16_384 }, (_request, body, done) => {
      done(null, Object.fromEntries(new URLSearchParams(body as string)));
    });

    scope.post('/oauth/register', async (request, reply) => {
      try {
        const client = store.register(request.body);
        return reply.code(201).header('cache-control', 'no-store').send({ client_id: client.id, client_name: client.name, redirect_uris: client.redirectUris });
      } catch (error) {
        return sendOAuthError(reply, error);
      }
    });

    scope.post(CONSENT_PATH, async (request, reply) => {
      if (!canConsent(request)) return reply.code(401).type('text/plain').send('Sign in to Scout first.');
      const body = (request.body ?? {}) as Record<string, unknown>;
      let authorization: Authorization;
      try {
        authorization = store.authorization(body);
      } catch (error) {
        if (!(error instanceof OAuthError)) throw error;
        return reply.code(400).type('text/plain').send(error.message);
      }
      const { redirectUri, state } = authorization;
      const location = body.decision === 'allow'
        ? redirectTo(redirectUri, { code: store.createCode(authorization), state })
        : redirectTo(redirectUri, { error: 'access_denied', state });
      return reply.code(302).header('cache-control', 'no-store').header('location', location).send();
    });

    scope.post('/oauth/token', async (request, reply) => {
      try {
        const token = store.exchange((request.body ?? {}) as Record<string, unknown>);
        return reply.header('cache-control', 'no-store').header('pragma', 'no-cache').send({ access_token: token, token_type: 'Bearer' });
      } catch (error) {
        return sendOAuthError(reply, error);
      }
    });
  });
}
