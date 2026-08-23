import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { validateSearchUrl, type Marketplace } from '../server/marketplaces';

const loginUrls: Record<Marketplace, string> = {
  OLX: 'https://www.olx.pl/',
  'Allegro Lokalnie': 'https://allegrolokalnie.pl/',
  Vinted: 'https://www.vinted.pl/',
};

function argument(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const marketplace = argument('--marketplace') as Marketplace | undefined;
if (!marketplace || !Object.hasOwn(loginUrls, marketplace)) {
  throw new Error('Usage: npm run marketplace:login -- --marketplace "OLX" [--output ./data/olx.storage-state.json]');
}

const outputPath = resolve(argument('--output') ?? `./data/${marketplace.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.storage-state.json`);
const executablePath = process.env.SCOUT_CHROMIUM_PATH ?? ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].find(existsSync);
if (!executablePath) throw new Error('Chromium is not available. Set SCOUT_CHROMIUM_PATH to a locally installed browser.');

const loginUrl = validateSearchUrl(loginUrls[marketplace], marketplace);
if (!loginUrl.valid) throw new Error(loginUrl.reason);

mkdirSync(dirname(outputPath), { recursive: true });
const browser = await chromium.launch({ executablePath, headless: false, args: ['--disable-gpu'] });
const context = await browser.newContext({ locale: 'pl-PL' });
const page = await context.newPage();
const prompt = createInterface({ input, output });
try {
  await page.goto(loginUrl.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  console.log(`A browser window is open at ${loginUrl.url}. Log in manually with your own ${marketplace} account.`);
  console.log('Complete any verification steps yourself; Scout does not capture passwords or bypass CAPTCHAs.');
  await prompt.question('Press Enter after the account is logged in to save the session…');
  await context.storageState({ path: outputPath });
  console.log(`Saved Playwright storage state to ${outputPath}. Import this file in Scout → Settings → Marketplace accounts.`);
} finally {
  prompt.close();
  await context.close();
  await browser.close();
}
