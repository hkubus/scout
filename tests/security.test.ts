import test from 'node:test';
import assert from 'node:assert/strict';
import { isPubliclyBoundHost, RateLimiter, securityHeaders } from '../server/security';

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
