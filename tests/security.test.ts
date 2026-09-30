import test from 'node:test';
import assert from 'node:assert/strict';
import { isAllowedHost, isCrossSiteBrowserRequest, isPubliclyBoundHost, RateLimiter, rateLimitKey, secretProblem, securityHeaders } from '../server/security';

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

test('rejects placeholder and weak SCOUT_SECRET values', () => {
  assert.match(String(secretProblem('replace-with-a-random-value-at-least-32-characters-long')), /placeholder/);
  assert.match(String(secretProblem('change-me-in-production-change-me-in-production')), /placeholder/);
  assert.match(String(secretProblem('short')), /at least 32/);
  assert.match(String(secretProblem('ab'.repeat(20))), /entropy/);
  assert.equal(secretProblem('9f2c4e7a1b3d5f60718293a4b5c6d7e8f9012a3b4c5d6e7f8091a2b3c4d5e6f7'), null);
});

test('pins the Host header against DNS rebinding', () => {
  for (const host of ['127.0.0.1:3001', 'localhost:3001', '[::1]:3001', '192.168.1.20:3001', 'scout.localhost']) assert.equal(isAllowedHost(host, []), true, host);
  assert.equal(isAllowedHost('attacker.example:3001', []), false);
  assert.equal(isAllowedHost(undefined, []), false);
  assert.equal(isAllowedHost('scout.home.arpa', ['scout.home.arpa']), true);
  assert.equal(isAllowedHost('SCOUT.home.arpa:8080', ['scout.home.arpa']), true);
});

test('flags browser cross-site requests but lets header-less clients through', () => {
  const own = 'http://127.0.0.1:3001';
  assert.equal(isCrossSiteBrowserRequest({}, own), false);
  assert.equal(isCrossSiteBrowserRequest({ origin: own, 'sec-fetch-site': 'same-origin' }, own), false);
  assert.equal(isCrossSiteBrowserRequest({ 'sec-fetch-site': 'cross-site' }, own), true);
  assert.equal(isCrossSiteBrowserRequest({ origin: 'https://evil.example' }, own), true);
  assert.equal(isCrossSiteBrowserRequest({ origin: 'null' }, own), true);
});
