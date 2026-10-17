import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import { isApprovedMarketplaceSessionHost, validateSearchUrl, type Marketplace } from '../server/marketplaces';
import { parseMarketplaceStorageState } from '../server/marketplace-sessions';

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
// The login runs in an ordinary Chromium window, not one started by Playwright: automation and
// remote-debugging switches set navigator.webdriver, and marketplaces block that as a bot.
// "Continue where you left off" keeps session cookies on disk when the window closes.
const profileDir = mkdtempSync(join(tmpdir(), 'scout-login-'));
mkdirSync(join(profileDir, 'Default'));
writeFileSync(join(profileDir, 'Default', 'Preferences'), JSON.stringify({ session: { restore_on_startup: 1 } }));
const browserProcess = spawn(executablePath, [
  `--user-data-dir=${profileDir}`,
  '--no-first-run',
  '--no-default-browser-check',
  // Playwright launches with the same flag, so it can decrypt the cookies afterwards.
  '--password-store=basic',
  loginUrl.url,
], { detached: true, stdio: 'ignore' });
let browserError: Error | undefined;
const browserExited = new Promise<void>((resolve) => {
  browserProcess.once('error', (error) => { browserError = error; resolve(); });
  browserProcess.once('exit', () => resolve());
});

async function stopBrowser(signal: NodeJS.Signals) {
  const pid = browserProcess.pid;
  if (pid === undefined) return;
  if (browserProcess.exitCode === null && browserProcess.signalCode === null) browserProcess.kill(signal);
  // Chromium's network service can outlive the main process while it writes the cookie database.
  for (let waited = 0; waited < 10_000; waited += 100) {
    try { process.kill(-pid, 0); } catch { return; }
    await delay(100);
  }
  try { process.kill(-pid, 'SIGKILL'); } catch { /* already stopped */ }
}

const prompt = createInterface({ input, output });
const loginFinished = new AbortController();
let cancelled = false;
void browserExited.then(() => loginFinished.abort());
prompt.once('close', () => { cancelled = true; loginFinished.abort(); });
try {
  console.log(`A browser window is open at ${loginUrl.url}. Log in manually with your own ${marketplace} account.`);
  console.log('Complete any verification steps yourself; Scout does not capture passwords or bypass CAPTCHAs.');
  try {
    await prompt.question('When the account is logged in, close the browser window or press Enter here to save the session…', { signal: loginFinished.signal });
  } catch (error) {
    if (!loginFinished.signal.aborted) throw error;
    output.write('\n');
  }
  if (browserError) throw new Error(`Could not start Chromium: ${browserError.message}`);
  const browserStatus = browserProcess.exitCode || browserProcess.signalCode;
  if (browserStatus) throw new Error(`Chromium exited unexpectedly (${browserStatus}); no session was saved.`);
  if (cancelled && browserProcess.exitCode === null) throw new Error('Cancelled; no session was saved.');
  // SIGINT makes Chromium flush its cookie database the way closing the window does; SIGTERM skips that.
  await stopBrowser('SIGINT');

  // Read the closed profile with Playwright while answering every request locally, so the
  // marketplace never sees the automated browser and no restored tab or service worker runs.
  for (const directory of ['Sessions', 'Service Worker']) rmSync(join(profileDir, 'Default', directory), { recursive: true, force: true });
  const context = await chromium.launchPersistentContext(profileDir, { executablePath, headless: true, serviceWorkers: 'block' });
  let session;
  try {
    await context.route('**/*', (route) => route.fulfill({ contentType: 'text/html', body: '<html></html>' }));
    // A real browser profile also collects third-party cookies; Scout's import only accepts the marketplace's own.
    const cookies = (await context.cookies()).filter((cookie) => isApprovedMarketplaceSessionHost(marketplace, cookie.domain.replace(/^\.+/, '')));
    // storageState() only includes localStorage for origins this context has visited.
    const page = context.pages()[0] ?? await context.newPage();
    for (const origin of new Set([new URL(loginUrl.url).origin, ...cookies.map((cookie) => `https://${cookie.domain.replace(/^\.+/, '')}`)])) await page.goto(origin);
    session = parseMarketplaceStorageState({ cookies, origins: (await context.storageState()).origins }, marketplace);
  } finally {
    await context.close();
  }
  writeFileSync(outputPath, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 });
  try { chmodSync(outputPath, 0o600); } catch (error) {
    throw new Error(`Saved the session but could not restrict its permissions: ${error instanceof Error ? error.message : String(error)}`);
  }
  console.log(`Saved Playwright storage state to ${outputPath}. Import this file in Scout → Settings → Marketplace accounts.`);
} finally {
  prompt.close();
  await stopBrowser('SIGKILL');
  rmSync(profileDir, { recursive: true, force: true, maxRetries: 3 });
}
