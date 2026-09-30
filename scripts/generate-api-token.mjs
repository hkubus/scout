#!/usr/bin/env node
// Print a random SCOUT_API_TOKENS entry (256 bits, base64url). Plain Node (no
// tsx) so it also runs on a production host:
//   node scripts/generate-api-token.mjs        # one token
//   node scripts/generate-api-token.mjs 3      # three tokens, comma-separated
// Separate several tokens with commas in SCOUT_API_TOKENS; each one works as a
// bearer token and as a dashboard sign-in.
import { randomBytes } from 'node:crypto';

const count = process.argv[2] === undefined ? 1 : Number(process.argv[2]);
if (!Number.isInteger(count) || count < 1 || count > 20) {
  console.error('Usage: node scripts/generate-api-token.mjs [count 1-20]');
  process.exit(1);
}
console.log(Array.from({ length: count }, () => randomBytes(32).toString('base64url')).join(','));
