import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createSecureServer, type Http2SecureServer, type IncomingHttpHeaders, type ServerHttp2Stream } from 'node:http2';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliCompressSync, deflateRawSync, deflateSync, gzipSync } from 'node:zlib';
import { decodeOlxApiBody, fetchOlxApiSingleRequest } from '../server/service';

// A fresh self-signed localhost certificate per run; nothing is checked in.
function selfSignedCertificate(): { key: Buffer; cert: Buffer } | null {
  const directory = mkdtempSync(join(tmpdir(), 'scout-h2-cert-'));
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
      '-keyout', join(directory, 'key.pem'), '-out', join(directory, 'cert.pem')], { stdio: 'ignore' });
    return { key: readFileSync(join(directory, 'key.pem')), cert: readFileSync(join(directory, 'cert.pem')) };
  } catch {
    return null;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const certificate = selfSignedCertificate();
const payload = { data: [{ id: 1, title: 'Konsola PS5 — stan idealny', description: '<p>Sprzedam zestaw, żółć</p>' }], metadata: { visible_total_count: 1 } };
const body = Buffer.from(JSON.stringify(payload));

async function withServer(handler: (stream: ServerHttp2Stream, headers: IncomingHttpHeaders) => void, run: (origin: string, ca: Buffer) => Promise<void>) {
  const server: Http2SecureServer = createSecureServer({ key: certificate!.key, cert: certificate!.cert });
  server.on('stream', handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await run(`https://localhost:${(server.address() as AddressInfo).port}`, certificate!.cert);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('OLX offers-API request sends accept-encoding and decodes gzip, deflate, br and identity bodies', { skip: certificate ? false : 'openssl unavailable' }, async () => {
  const encoded: Record<string, Buffer> = { gzip: gzipSync(body), deflate: deflateSync(body), br: brotliCompressSync(body), identity: body };
  const seen: string[] = [];
  let encoding = 'identity';
  await withServer((stream, headers) => {
    seen.push(String(headers['accept-encoding'] ?? ''));
    stream.respond({ ':status': 200, 'content-type': 'application/json', ...(encoding === 'identity' ? {} : { 'content-encoding': encoding }) });
    stream.end(encoded[encoding]);
  }, async (origin, ca) => {
    for (encoding of Object.keys(encoded)) {
      const result = await fetchOlxApiSingleRequest(`${origin}/api/v1/offers/?query=ps5`, 5_000, { ca });
      assert.equal(result.status, 200, encoding);
      assert.deepEqual(result.json, payload, encoding);
    }
  });
  assert.deepEqual(seen, Array(4).fill('gzip, deflate, br'));
});

test('OLX offers-API request fails closed to json=null on corrupt or oversized compressed bodies', { skip: certificate ? false : 'openssl unavailable' }, async () => {
  // 17 MB of zeros compresses to ~17 KB but exceeds the 16 MB decode guard.
  const bomb = gzipSync(Buffer.alloc(17 * 1024 * 1024, 0x20));
  const cases: Array<[string, Buffer]> = [['gzip', bomb], ['gzip', Buffer.from('not gzip at all')], ['br', Buffer.from('not brotli')]];
  let index = 0;
  await withServer((stream) => {
    const [encoding, content] = cases[index];
    stream.respond({ ':status': 403, 'content-encoding': encoding });
    stream.end(content);
  }, async (origin, ca) => {
    for (index = 0; index < cases.length; index += 1) {
      const result = await fetchOlxApiSingleRequest(`${origin}/api/v1/offers/`, 5_000, { ca });
      assert.equal(result.status, 403);
      assert.equal(result.json, null, `case ${index}`);
    }
  });
});

test('decodeOlxApiBody accepts raw deflate and passes unknown encodings through', () => {
  assert.deepEqual(decodeOlxApiBody(deflateRawSync(body), 'deflate'), body);
  assert.deepEqual(decodeOlxApiBody(gzipSync(body), 'GZIP'), body);
  assert.deepEqual(decodeOlxApiBody(body, 'zstd-unknown'), body);
  assert.deepEqual(decodeOlxApiBody(body, null), body);
  assert.throws(() => decodeOlxApiBody(deflateSync(Buffer.alloc(17 * 1024 * 1024)), 'deflate'), { code: 'ERR_BUFFER_TOO_LARGE' });
});
