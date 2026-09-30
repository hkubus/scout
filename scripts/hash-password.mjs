#!/usr/bin/env node
// Print a SCOUT_PASSWORD_HASH value. Plain Node (no tsx) so it also runs on a
// production host. Reads the password from stdin to keep it out of shell history:
//   node scripts/hash-password.mjs
//   printf '%s' "$PASSWORD" | node scripts/hash-password.mjs
// Must stay in sync with hashPassword() in server/auth.ts.
import { randomBytes, scrypt } from 'node:crypto';
import { createInterface } from 'node:readline';

const N = 32_768;
const r = 8;
const p = 1;

async function readPassword() {
  if (!process.stdin.isTTY) {
    let input = '';
    for await (const chunk of process.stdin) input += chunk;
    return input.replace(/\r?\n$/, '');
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  // Suppress echo while typing.
  rl._writeToOutput = () => {};
  process.stderr.write('Password: ');
  const password = await new Promise((resolve) => rl.question('', resolve));
  rl.close();
  process.stderr.write('\n');
  return password;
}

const password = await readPassword();
if (password.length < 12) {
  console.error('Use a password of at least 12 characters.');
  process.exit(1);
}
const salt = randomBytes(16);
scrypt(password.normalize('NFKC'), salt, 32, { N, r, p, maxmem: 128 * N * r * 2 }, (error, key) => {
  if (error) throw error;
  console.log(['scrypt', N, r, p, salt.toString('base64url'), key.toString('base64url')].join('$'));
});
