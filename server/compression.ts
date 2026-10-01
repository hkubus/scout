import { pipeline, Readable } from 'node:stream';
import { promisify } from 'node:util';
import zlib from 'node:zlib';
import type { FastifyReply, FastifyRequest } from 'fastify';

// Dynamic JSON is compressed per response, so keep brotli at a cheap quality
// (q4 is about as small as gzip-6 at a fraction of q11's CPU). Static files are
// precompressed at build time instead (scripts/precompress.mjs).
const COMPRESS_THRESHOLD_BYTES = 1024;
const brotliOptions = (sizeHint?: number): zlib.BrotliOptions => ({
  params: {
    [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
    [zlib.constants.BROTLI_PARAM_QUALITY]: 4,
    ...(sizeHint === undefined ? {} : { [zlib.constants.BROTLI_PARAM_SIZE_HINT]: sizeHint }),
  },
});
const gzipOptions: zlib.ZlibOptions = { level: 6 };
const brotliCompress = promisify(zlib.brotliCompress);
const gzip = promisify(zlib.gzip);
const compressibleType = /^(?:application\/json|text\/(?!event-stream))/i;

// Replies whose stream this hook is compressing. If that stream fails before
// its first byte, Fastify sends the error through onSend again while the
// content-encoding header is still set (also on the raw response), so the
// hook drops the header and treats the error body like any other payload.
const streamingEncoded = new WeakSet<FastifyReply>();

export type ResponseEncoding = 'br' | 'gzip';

/** Pick br, else gzip, from an Accept-Encoding header; `q=0` refuses a coding. */
export function negotiateEncoding(header: string | string[] | undefined): ResponseEncoding | null {
  const value = Array.isArray(header) ? header.join(',') : header;
  if (!value) return null;
  const accepted = new Set<string>();
  for (const part of value.split(',')) {
    const [name, ...params] = part.trim().toLowerCase().split(';');
    const q = params.map((param) => param.trim()).find((param) => param.startsWith('q='));
    if (q && !(Number(q.slice(2)) > 0)) continue;
    accepted.add(name.trim());
  }
  if (accepted.has('br')) return 'br';
  if (accepted.has('gzip')) return 'gzip';
  return null;
}

function addVaryAcceptEncoding(reply: FastifyReply) {
  const current = reply.getHeader('vary');
  const value = Array.isArray(current) ? current.join(', ') : current === undefined ? '' : String(current);
  if (value.split(',').some((entry) => ['*', 'accept-encoding'].includes(entry.trim().toLowerCase()))) return;
  reply.header('vary', value ? `${value}, Accept-Encoding` : 'Accept-Encoding');
}

/**
 * onSend hook that compresses /api/* JSON and text responses (including
 * streams such as /api/export) with br or gzip when the client accepts it.
 * Hijacked routes (/events, /mcp) never reach onSend; binary types, tiny
 * bodies, bodiless statuses and already-encoded responses pass through.
 */
export async function compressApiResponse(request: FastifyRequest, reply: FastifyReply, payload: unknown) {
  if (!request.routeOptions.url?.startsWith('/api/')) return payload;
  if (payload === null || payload === undefined) return payload;
  if (reply.statusCode === 204 || reply.statusCode === 206 || reply.statusCode === 304) return payload;
  if (streamingEncoded.has(reply)) {
    streamingEncoded.delete(reply);
    if (reply.raw.headersSent) return payload;
    reply.removeHeader('content-encoding');
    reply.raw.removeHeader('content-encoding');
  }
  if (reply.hasHeader('content-encoding')) return payload;
  const type = reply.getHeader('content-type');
  if (typeof type !== 'string' || !compressibleType.test(type)) return payload;
  const isStream = payload instanceof Readable;
  if (!isStream && typeof payload !== 'string' && !Buffer.isBuffer(payload)) return payload;
  const size = isStream ? undefined : typeof payload === 'string' ? Buffer.byteLength(payload) : (payload as Buffer).byteLength;
  // The body depends on Accept-Encoding once it is large enough to compress.
  if (size !== undefined && size < COMPRESS_THRESHOLD_BYTES) return payload;
  addVaryAcceptEncoding(reply);
  const encoding = negotiateEncoding(request.headers['accept-encoding']);
  if (!encoding) return payload;

  let body: Buffer | Readable;
  if (isStream) {
    const compressor = encoding === 'br' ? zlib.createBrotliCompress(brotliOptions()) : zlib.createGzip(gzipOptions);
    // pipeline tears the source down (ending an async generator) when the
    // client aborts and Fastify destroys the compressor, or on an error.
    body = pipeline(payload as Readable, compressor, () => {});
    streamingEncoded.add(reply);
  } else {
    const input = payload as string | Buffer;
    body = encoding === 'br' ? await brotliCompress(input, brotliOptions(size)) : await gzip(input, gzipOptions);
  }
  reply.header('content-encoding', encoding);
  reply.removeHeader('content-length');
  return body;
}
