import { isIP } from 'node:net';

export function isPubliclyBoundHost(host: string) {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  return !['127.0.0.1', '::1', 'localhost'].includes(normalized);
}

/**
 * Rate-limit identity for a client address. IPv4 (including IPv4-mapped IPv6)
 * keys on the full address; other IPv6 addresses key on their /64 prefix,
 * because one host routinely controls a whole /64.
 */
export function rateLimitKey(ip: string) {
  const address = ip.trim().toLowerCase().replace(/^\[|\]$/g, '').split('%', 1)[0];
  if (isIP(address) !== 6) return address;
  const [head, tail] = address.split('::');
  const hextets = (part: string | undefined) => (part ? part.split(':') : []).flatMap((group) => {
    if (!group.includes('.')) return [parseInt(group, 16)];
    const [a, b, c, d] = group.split('.').map(Number);
    return [(a << 8) | b, (c << 8) | d];
  });
  const headGroups = hextets(head);
  const tailGroups = hextets(tail);
  const groups = tail === undefined ? headGroups : [...headGroups, ...Array(8 - headGroups.length - tailGroups.length).fill(0), ...tailGroups];
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    return [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff].join('.');
  }
  return `${groups.slice(0, 4).map((group) => group.toString(16)).join(':')}::/64`;
}

type RateLimitBucket = { count: number; resetAt: number };

export class RateLimiter {
  private readonly buckets = new Map<string, RateLimitBucket>();

  /**
   * When the table is full of live buckets, `evict` drops the oldest one so
   * memory stays bounded; `reject` refuses the new key instead, so a flood of
   * fresh addresses cannot reset counters that are still active.
   */
  constructor(private readonly windowMs = 60_000, private readonly maxEntries = 10_000, private readonly whenFull: 'evict' | 'reject' = 'evict') {}

  consume(key: string, limit: number, now = Date.now()) {
    let bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      if (!bucket && this.buckets.size >= this.maxEntries) {
        this.purgeExpired(now);
        if (this.buckets.size >= this.maxEntries) {
          if (this.whenFull === 'reject') {
            let soonest = Infinity;
            for (const entry of this.buckets.values()) soonest = Math.min(soonest, entry.resetAt);
            return { allowed: false, remaining: 0, retryAfterSeconds: Math.max(1, Math.ceil((soonest - now) / 1000)) };
          }
          let oldestKey: string | undefined;
          let oldestReset = Infinity;
          for (const [entryKey, entry] of this.buckets) {
            if (entry.resetAt < oldestReset) { oldestKey = entryKey; oldestReset = entry.resetAt; }
          }
          if (oldestKey !== undefined) this.buckets.delete(oldestKey);
        }
      }
      bucket = { count: 0, resetAt: now + this.windowMs };
      this.buckets.set(key, bucket);
    }
    bucket.count += 1;
    return { allowed: bucket.count <= limit, remaining: Math.max(0, limit - bucket.count), retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)) };
  }

  get size() {
    return this.buckets.size;
  }

  private purgeExpired(now: number) {
    for (const [entryKey, entry] of this.buckets) {
      if (entry.resetAt <= now) this.buckets.delete(entryKey);
    }
  }
}

export function securityHeaders(secure = false) {
  return {
    'Content-Security-Policy': "default-src 'self'; base-uri 'self'; frame-ancestors 'none'; object-src 'none'; img-src 'self' data: https:; connect-src 'self'; form-action 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; font-src 'self' data:",
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    ...(secure ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {}),
  };
}
