import test from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import Fastify from 'fastify';
import { ScoutLogController } from '../server/request-log';

type LogLine = { level: number; msg: string; reqId?: string; method?: string; url?: string; statusCode?: number; ms?: unknown; ip?: string };

function buildApp() {
  const lines: LogLine[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      for (const text of String(chunk).split('\n')) if (text) lines.push(JSON.parse(text) as LogLine);
      callback();
    },
  });
  const app = Fastify({ logger: { level: 'info', stream }, logController: new ScoutLogController() });
  let ready = true;
  // Like Scout's handler for unexpected errors, minus its own log line, so
  // every line the test sees comes from the controller.
  app.setErrorHandler((_error, _request, reply) => reply.code(500).send({ error: 'Internal server error' }));
  app.get('/api/thing', async () => ({ ok: true }));
  app.get('/api/health', async () => ({ status: 'ok' }));
  app.get('/api/ready', async (_request, reply) => reply.code(ready ? 200 : 503).send({ status: ready ? 'ready' : 'starting' }));
  app.get('/api/boom', async () => { throw new Error('boom'); });
  return { app, lines, setReady: (value: boolean) => { ready = value; } };
}

test('writes one line per request with method, URL, status, ms, IP and reqId', async () => {
  const { app, lines } = buildApp();
  try {
    const response = await app.inject({ method: 'GET', url: '/api/thing?q=x100v&page=2', remoteAddress: '203.0.113.7' });
    assert.equal(response.statusCode, 200);
    assert.equal(lines.length, 1);
    const [line] = lines;
    assert.equal(line.msg, 'request completed');
    assert.equal(line.level, 30);
    assert.equal(line.method, 'GET');
    assert.equal(line.url, '/api/thing?q=x100v&page=2');
    assert.equal(line.statusCode, 200);
    assert.equal(typeof line.ms, 'number');
    assert.ok((line.ms as number) >= 0);
    assert.equal(line.ip, '203.0.113.7');
    assert.ok(line.reqId);
    assert.ok(!lines.some((entry) => entry.msg === 'incoming request'));
  } finally {
    await app.close();
  }
});

test('skips passing probes and logs failing ones', async () => {
  const { app, lines, setReady } = buildApp();
  try {
    assert.equal((await app.inject({ method: 'GET', url: '/api/health' })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: '/api/ready' })).statusCode, 200);
    assert.equal(lines.length, 0);

    setReady(false);
    assert.equal((await app.inject({ method: 'GET', url: '/api/ready' })).statusCode, 503);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].url, '/api/ready');
    assert.equal(lines[0].statusCode, 503);
    assert.equal(lines[0].level, 50);
  } finally {
    await app.close();
  }
});

test('logs a 500 at error level and a 404 as a single line', async () => {
  const { app, lines } = buildApp();
  try {
    assert.equal((await app.inject({ method: 'GET', url: '/api/boom' })).statusCode, 500);
    assert.equal((await app.inject({ method: 'GET', url: '/api/nope' })).statusCode, 404);
    assert.equal(lines.length, 2);
    assert.deepEqual(lines.map((line) => [line.url, line.statusCode, line.level]), [['/api/boom', 500, 50], ['/api/nope', 404, 30]]);
    assert.ok(lines.every((line) => line.msg === 'request completed'));
  } finally {
    await app.close();
  }
});
