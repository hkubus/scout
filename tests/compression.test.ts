import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import Fastify from 'fastify';
import { compressApiResponse, negotiateEncoding } from '../server/compression';

const big = { listings: Array.from({ length: 200 }, (_, index) => ({ id: `olx-${index}`, title: `Aparat Fujifilm X100V łódź ${index}`, pricePln: 3000 + index })) };

function buildApp() {
  const app = Fastify();
  app.addHook('onSend', compressApiResponse);
  app.get('/api/big', async () => big);
  app.get('/api/small', async () => ({ ok: true }));
  app.get('/api/text', async (_request, reply) => reply.type('text/plain; charset=utf-8').send('line\n'.repeat(1000)));
  app.get('/api/stream', async (_request, reply) => reply.type('application/json').send(Readable.from((function* () {
    yield '{"rows":[';
    for (let index = 0; index < 500; index += 1) yield `${index ? ',' : ''}${JSON.stringify({ index, title: 'Sony A7 III' })}`;
    yield ']}';
  })())));
  app.get('/api/image', async (_request, reply) => reply.type('image/png').send(Buffer.alloc(4096, 7)));
  app.get('/api/binary', async (_request, reply) => reply.type('application/vnd.sqlite3').send(Buffer.alloc(4096, 1)));
  app.get('/api/encoded', async (_request, reply) => reply.header('content-encoding', 'gzip').type('application/json').send(Buffer.from('x'.repeat(2048))));
  app.get('/api/empty', async (_request, reply) => reply.code(204).send());
  app.get('/page', async () => big);
  return app;
}

const decode = (encoding: string | undefined, body: Buffer) => encoding === 'br' ? brotliDecompressSync(body) : encoding === 'gzip' ? gunzipSync(body) : body;

test('negotiates br before gzip and honours q=0', () => {
  assert.equal(negotiateEncoding('gzip, deflate, br'), 'br');
  assert.equal(negotiateEncoding('gzip, deflate'), 'gzip');
  assert.equal(negotiateEncoding('br;q=0, gzip;q=0.5'), 'gzip');
  assert.equal(negotiateEncoding('br;q=0,gzip;q=0'), null);
  assert.equal(negotiateEncoding('identity'), null);
  assert.equal(negotiateEncoding(undefined), null);
  assert.equal(negotiateEncoding(''), null);
});

test('compresses large /api JSON, text and stream bodies with identical decoded bytes', async () => {
  const app = buildApp();
  try {
    for (const url of ['/api/big', '/api/text', '/api/stream']) {
      const identity = await app.inject({ method: 'GET', url });
      assert.equal(identity.statusCode, 200);
      assert.equal(identity.headers['content-encoding'], undefined, url);
      assert.equal(identity.headers.vary, 'Accept-Encoding', url);
      for (const [acceptEncoding, expected] of [['gzip, deflate, br', 'br'], ['gzip, deflate', 'gzip']] as const) {
        const response = await app.inject({ method: 'GET', url, headers: { 'accept-encoding': acceptEncoding } });
        assert.equal(response.statusCode, 200);
        assert.equal(response.headers['content-encoding'], expected, `${url} ${acceptEncoding}`);
        assert.equal(response.headers.vary, 'Accept-Encoding');
        assert.equal(response.headers['content-type'], identity.headers['content-type']);
        assert.ok(response.rawPayload.byteLength < identity.rawPayload.byteLength / 3, `${url} is smaller on the wire`);
        if (response.headers['content-length'] !== undefined) assert.equal(Number(response.headers['content-length']), response.rawPayload.byteLength);
        assert.deepEqual(decode(expected, response.rawPayload), identity.rawPayload, `${url} ${expected} decodes to the identity body`);
      }
    }
    assert.deepEqual(JSON.parse((await app.inject({ method: 'GET', url: '/api/big' })).body), big);
  } finally {
    await app.close();
  }
});

test('leaves small, binary, pre-encoded, bodiless and non-API responses alone', async () => {
  const app = buildApp();
  try {
    const headers = { 'accept-encoding': 'br, gzip' };
    for (const url of ['/api/small', '/api/image', '/api/binary', '/page']) {
      const response = await app.inject({ method: 'GET', url, headers });
      assert.equal(response.statusCode, 200, url);
      assert.equal(response.headers['content-encoding'], undefined, url);
      assert.equal(response.headers.vary, undefined, url);
    }
    const encoded = await app.inject({ method: 'GET', url: '/api/encoded', headers });
    assert.equal(encoded.headers['content-encoding'], 'gzip');
    assert.equal(encoded.rawPayload.toString(), 'x'.repeat(2048));
    const empty = await app.inject({ method: 'GET', url: '/api/empty', headers });
    assert.equal(empty.statusCode, 204);
    assert.equal(empty.headers['content-encoding'], undefined);
  } finally {
    await app.close();
  }
});

test('a stream that fails before its first byte becomes a normal, decodable 500', async () => {
  const app = Fastify({ logger: false });
  app.addHook('onSend', compressApiResponse);
  app.get('/api/failing-stream', async (_request, reply) => reply.type('application/json').send(Readable.from((async function* () {
    await new Promise<void>((resolve) => setImmediate(resolve));
    throw new Error('snapshot open failed');
  })(), { objectMode: false })));
  try {
    for (const acceptEncoding of [undefined, 'br', 'gzip', 'gzip, deflate, br']) {
      const response = await app.inject({ method: 'GET', url: '/api/failing-stream', headers: acceptEncoding ? { 'accept-encoding': acceptEncoding } : {} });
      assert.equal(response.statusCode, 500, String(acceptEncoding));
      const body = JSON.parse(decode(response.headers['content-encoding'] as string | undefined, response.rawPayload).toString());
      assert.equal(body.statusCode, 500, String(acceptEncoding));
      assert.equal(response.headers['content-encoding'], undefined, 'the small error body goes out uncompressed');
    }
  } finally {
    await app.close();
  }
});
