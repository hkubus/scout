import type { Locator, Page } from 'playwright-core';
import { validateSearchUrl } from './marketplaces';

export type OlxMessagingErrorCode = 'invalid-listing' | 'session' | 'composer' | 'delivery';

export class OlxMessagingError extends Error {
  code: OlxMessagingErrorCode;

  constructor(message: string, code: OlxMessagingErrorCode) {
    super(message);
    this.name = 'OlxMessagingError';
    this.code = code;
  }
}

async function firstVisible(locators: Locator[]) {
  for (const locator of locators) {
    if (await locator.count() && await locator.isVisible().catch(() => false)) return locator;
  }
  return null;
}

function isLoginUrl(value: string) {
  try {
    return new URL(value).hostname === 'login.olx.pl';
  } catch {
    return false;
  }
}

async function ensureAuthenticated(page: Page) {
  if (isLoginUrl(page.url())) {
    throw new OlxMessagingError('The OLX session is no longer authenticated. Re-import it in Settings.', 'session');
  }
  const loginSubmit = page.locator('[data-testid="login-submit-button"]').first();
  if (await loginSubmit.count() && await loginSubmit.isVisible().catch(() => false)) {
    throw new OlxMessagingError('The OLX session is no longer authenticated. Re-import it in Settings.', 'session');
  }
}

/** Send exactly one message through the already-authenticated OLX page. */
export async function sendOlxMessageOnPage(page: Page, listingUrl: string, message: string) {
  const validated = validateSearchUrl(listingUrl, 'OLX');
  if (!validated.valid) throw new OlxMessagingError(validated.reason, 'invalid-listing');
  const safeMessage = message.trim();
  if (!safeMessage) throw new OlxMessagingError('The negotiation message is empty.', 'delivery');

  const response = await page.goto(validated.url, { waitUntil: 'domcontentloaded', timeout: 25_000 });
  await page.waitForTimeout(900);
  await ensureAuthenticated(page);
  if (response && !response.ok()) throw new OlxMessagingError(`OLX listing page returned ${response.status()}.`, 'delivery');

  const chatButton = await firstVisible([
    page.locator('[data-testid="chat-button"]').first(),
    page.getByRole('button', { name: /Wyślij wiadomość/i }).first(),
    page.getByRole('link', { name: /Wyślij wiadomość/i }).first(),
  ]);
  if (!chatButton) throw new OlxMessagingError('OLX did not expose the seller message button on this listing.', 'composer');

  await chatButton.click({ timeout: 8_000, noWaitAfter: true });
  await page.waitForTimeout(900);
  await ensureAuthenticated(page);

  const composer = await firstVisible([
    page.locator('textarea[placeholder*="Napisz wiadomość"]').first(),
    page.locator('textarea[aria-label*="Napisz wiadomość"]').first(),
    page.locator('[contenteditable="true"]').first(),
    page.locator('textarea').first(),
  ]);
  if (!composer) throw new OlxMessagingError('OLX did not open a message composer. The listing may not accept new conversations.', 'composer');
  await composer.fill(safeMessage);

  const sendButton = await firstVisible([
    page.locator('[data-testid="send-message"]').first(),
    page.locator('[data-testid="chat-send-button"]').first(),
    page.getByRole('button', { name: /^Wyślij$/i }).first(),
    page.locator('button').filter({ hasText: /^Wyślij$/i }).first(),
    page.locator('button[aria-label*="Wyślij"]').first(),
    page.locator('button[type="submit"]').first(),
  ]);
  if (!sendButton) throw new OlxMessagingError('OLX did not expose the message send button.', 'composer');

  await sendButton.click({ timeout: 8_000, noWaitAfter: true });
  await page.waitForTimeout(900);
  await ensureAuthenticated(page);
  const visibleText = await page.locator('body').innerText().catch(() => '');
  if (/Nie można wysłać wiadomości|nie możesz rozpocząć nowych rozmów/i.test(visibleText)) {
    throw new OlxMessagingError('OLX could not send the message. Check the listing and your account limits.', 'delivery');
  }
  const composerValue = await composer.inputValue().catch(async () => await composer.textContent().catch(() => ''));
  if (!visibleText.includes(safeMessage) && String(composerValue ?? '').trim() !== '') {
    throw new OlxMessagingError('OLX did not confirm that the message was delivered. Review the conversation before retrying.', 'delivery');
  }
}
