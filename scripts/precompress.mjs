#!/usr/bin/env node
// Write .br (quality 11) and .gz (level 9) siblings for the built frontend so
// @fastify/static (preCompressed) serves them without per-request CPU. Plain
// Node (no dependencies); runs after `vite build`, which empties dist first.
//   node scripts/precompress.mjs [dir]
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import zlib from 'node:zlib';

const root = resolve(process.argv[2] ?? 'dist');
const MIN_BYTES = 1024;
const compressible = /\.(?:js|css|html|svg)$/i;
const brotli = promisify(zlib.brotliCompress);
const gzip = promisify(zlib.gzip);

async function* files(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* files(path);
    else if (entry.isFile() && compressible.test(entry.name)) yield path;
  }
}

const jobs = [];
for await (const path of files(root)) {
  if ((await stat(path)).size < MIN_BYTES) continue;
  jobs.push((async () => {
    const source = await readFile(path);
    const [br, gz] = await Promise.all([
      brotli(source, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: source.byteLength } }),
      gzip(source, { level: 9 }),
    ]);
    await Promise.all([writeFile(`${path}.br`, br), writeFile(`${path}.gz`, gz)]);
    return { raw: source.byteLength, br: br.byteLength, gz: gz.byteLength };
  })());
}
const results = await Promise.all(jobs);
const total = (key) => results.reduce((sum, result) => sum + result[key], 0);
console.log(`precompressed ${results.length} files in ${root}: ${total('raw')} B -> ${total('br')} B br, ${total('gz')} B gzip`);
