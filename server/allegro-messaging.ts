import type { Locator, Page } from 'playwright-core';
import { validateSearchUrl } from './marketplaces';

export type AllegroMessagingErrorCode = 'invalid-listing' | 'session' | 'composer' | 'delivery';

export class AllegroMessagingError extends Error {
  code: AllegroMessagingErrorCode;

  constructor(message: string, code: AllegroMessagingErrorCode) {
    super(message);
    this.name = 'AllegroMessagingError';
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
    const url = new URL(value);
    return (url.hostname === 'allegro.pl' || url.hostname.endsWith('.allegro.pl'))
      && /(?:\/auth\/|\/logowanie|\/login)/i.test(url.pathname);
  } catch {
    return false;
  }
}

async function ensureAuthenticated(page: Page) {
  if (isLoginUrl(page.url())) {
    throw new AllegroMessagingError('The Allegro Lokalnie session is no longer authenticated. Re-import it in Settings.', 'session');
  }
  const loginControl = await firstVisible([
    page.locator('[data-testid="login-button"]').first(),
    page.getByRole('link', { name: /Zaloguj(?: kontem Allegro)?/i }).first(),
    page.getByRole('button', { name: /Zaloguj(?: kontem Allegro)?/i }).first(),
  ]);
  if (loginControl) {
    throw new AllegroMessagingError('The Allegro Lokalnie session is no longer authenticated. Re-import it in Settings.', 'session');
  }
}

/** Send exactly one message through the already-authenticated Allegro Lokalnie page. */
export async function sendAllegroMessageOnPage(page: Page, listingUrl: string, message: string) {
  const validated = validateSearchUrl(listingUrl, 'Allegro Lokalnie');
  if (!validated.valid) throw new AllegroMessagingError(validated.reason, 'invalid-listing');
  const safeMessage = message.trim();
  if (!safeMessage) throw new AllegroMessagingError('The negotiation message is empty.', 'delivery');

  const response = await page.goto(validated.url, { waitUntil: 'domcontentloaded', timeout: 25_000 });
  await page.waitForTimeout(900);
  await ensureAuthenticated(page);
  if (response && !response.ok()) throw new AllegroMessagingError(`Allegro Lokalnie offer page returned ${response.status()}.`, 'delivery');

  const chatButton = await firstVisible([
    page.locator('[data-testid="seller-details-actions"] a[href*="/konwersacje/"]:not([href*="propose_price"])').first(),
    page.locator('a[href*="/konwersacje/"]:not([href*="propose_price"])').filter({ hasText: /Napisz(?: na czacie)?/i }).first(),
    page.getByRole('link', { name: /^Napisz(?: na czacie)?$/i }).first(),
    page.getByRole('button', { name: /^Napisz(?: na czacie)?$/i }).first(),
  ]);
  if (!chatButton) throw new AllegroMessagingError('Allegro Lokalnie did not expose the seller chat button on this offer.', 'composer');

  await chatButton.click({ timeout: 8_000, noWaitAfter: true });
  await page.waitForTimeout(900);
  await ensureAuthenticated(page);

  const composer = await firstVisible([
    page.locator('textarea[placeholder*="Wpisz wiadomość"]').first(),
    page.locator('textarea[aria-label*="Wiadomość"]').first(),
    page.locator('textarea.ml-textarea__inner__field').first(),
    page.locator('textarea[name="message"]').first(),
    page.locator('[contenteditable="true"]').first(),
    page.locator('textarea').first(),
  ]);
  if (!composer) throw new AllegroMessagingError('Allegro Lokalnie did not open a message composer. The offer may not accept new conversations.', 'composer');
  await composer.fill(safeMessage);

  const sendButton = await firstVisible([
    page.locator('[data-testid*="send-message"]').first(),
    page.locator('[data-testid*="message-send"]').first(),
    page.getByRole('button', { name: /^Wyślij(?: wiadomość)?$/i }).first(),
    page.locator('button').filter({ hasText: /^Wyślij(?: wiadomość)?$/i }).first(),
    page.locator('button[aria-label*="Wyślij"]').first(),
    page.locator('button[type="submit"]').first(),
  ]);
  if (!sendButton) throw new AllegroMessagingError('Allegro Lokalnie did not expose the message send button.', 'composer');

  await sendButton.click({ timeout: 8_000, noWaitAfter: true });
  await page.waitForTimeout(900);
  await ensureAuthenticated(page);
  const visibleText = await page.locator('body').innerText().catch(() => '');
  if (/nie udało się wysłać wiadomości|nie można wysłać wiadomości|wystąpił błąd podczas wysyłania|spróbuj ponownie/i.test(visibleText)) {
    throw new AllegroMessagingError('Allegro Lokalnie could not send the message. Check the offer and your account limits.', 'delivery');
  }
}
