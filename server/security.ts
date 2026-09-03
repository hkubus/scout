export function isPubliclyBoundHost(host: string) {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  return !['127.0.0.1', '::1', 'localhost'].includes(normalized);
}

type RateLimitBucket = { count: number; resetAt: number };

export class RateLimiter {
  private readonly buckets = new Map<string, RateLimitBucket>();

  constructor(private readonly windowMs = 60_000, private readonly maxEntries = 10_000) {}

  consume(key: string, limit: number, now = Date.now()) {
    this.purgeExpired(now);
    let bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) bucket = { count: 0, resetAt: now + this.windowMs };
    bucket.count += 1;
    this.buckets.set(key, bucket);
    if (this.buckets.size > this.maxEntries) {
      // Evict the oldest entries first so IP rotation cannot grow memory unbounded.
      const oldest = [...this.buckets.entries()].sort((a, b) => a[1].resetAt - b[1].resetAt);
      for (const [entryKey] of oldest.slice(0, this.buckets.size - this.maxEntries)) {
        this.buckets.delete(entryKey);
      }
    }
    return { allowed: bucket.count <= limit, remaining: Math.max(0, limit - bucket.count), retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)) };
  }

  private purgeExpired(now: number) {
    for (const [entryKey, entry] of this.buckets) {
      if (entry.resetAt <= now) this.buckets.delete(entryKey);
    }
  }
}

export function securityHeaders(secure = false) {
  return {
    'Content-Security-Policy': "default-src 'self'; base-uri 'self'; frame-ancestors 'none'; object-src 'none'; img-src 'self' data: https:; connect-src 'self' https:; style-src 'self' 'unsafe-inline'; script-src 'self'; font-src 'self' data:",
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    ...(secure ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {}),
  };
}
