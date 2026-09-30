import test from 'node:test';
import assert from 'node:assert/strict';
import { isPubliclyBoundHost, RateLimiter, rateLimitKey, securityHeaders } from '../server/security';

test('detects loopback and public listening addresses', () => {
  assert.equal(isPubliclyBoundHost('127.0.0.1'), false);
  assert.equal(isPubliclyBoundHost('localhost'), false);
  assert.equal(isPubliclyBoundHost('0.0.0.0'), true);
});

test('adds browser security headers and bounds repeated requests', () => {
  const headers = securityHeaders(true);
  assert.match(headers['Content-Security-Policy'], /frame-ancestors 'none'/);
  assert.equal(headers['X-Frame-Options'], 'DENY');
  assert.equal(headers['X-Content-Type-Options'], 'nosniff');
  assert.match(String(headers['Strict-Transport-Security']), /max-age=31536000/);

  const limiter = new RateLimiter(1_000);
  assert.equal(limiter.consume('client', 2, 10).allowed, true);
  assert.equal(limiter.consume('client', 2, 10).allowed, true);
  assert.equal(limiter.consume('client', 2, 10).allowed, false);
  assert.equal(limiter.consume('client', 2, 1_011).allowed, true);
});

test('keys IPv6 clients by /64 and IPv4-mapped clients by IPv4 address', () => {
  assert.equal(rateLimitKey('203.0.113.7'), '203.0.113.7');
  assert.equal(rateLimitKey('::ffff:203.0.113.7'), '203.0.113.7');
  assert.equal(rateLimitKey('::ffff:cb00:7107'), '203.0.113.7');
  assert.equal(rateLimitKey('2001:db8:1:2:aaaa::1'), '2001:db8:1:2::/64');
  assert.equal(rateLimitKey('2001:DB8:1:2:ffff:ffff:ffff:ffff'), '2001:db8:1:2::/64');
  assert.equal(rateLimitKey('2001:db8::1'), '2001:db8:0:0::/64');
  assert.equal(rateLimitKey('::1'), '0:0:0:0::/64');
  assert.equal(rateLimitKey('fe80::1%eth0'), 'fe80:0:0:0::/64');
});

test('a full limiter does not reset live counters', () => {
  const evicting = new RateLimiter(1_000, 2);
  evicting.consume('a', 1, 0);
  evicting.consume('b', 1, 100);
  evicting.consume('c', 1, 200);
  assert.equal(evicting.size, 2);
  assert.equal(evicting.consume('b', 1, 300).allowed, false, 'only the oldest bucket is evicted');

  const rejecting = new RateLimiter(1_000, 2, 'reject');
  assert.equal(rejecting.consume('a', 1, 0).allowed, true);
  assert.equal(rejecting.consume('a', 1, 0).allowed, false);
  rejecting.consume('b', 1, 500);
  const flood = rejecting.consume('c', 1, 600);
  assert.equal(flood.allowed, false, 'new keys are refused while the table is full');
  assert.equal(flood.retryAfterSeconds, 1);
  assert.equal(rejecting.consume('a', 1, 700).allowed, false, 'existing counter survives the flood');
  assert.equal(rejecting.consume('c', 1, 1_001).allowed, true, 'expired buckets make room');
});
