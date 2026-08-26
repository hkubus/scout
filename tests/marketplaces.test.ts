import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMarketplaceSearchUrl, dedupeKey, normalizeListing, parseAllegroCards, parseListingAvailability, parseListingDescription, parseOlxCards, parsePolishPrice, parsePriceNegotiability, parseSearchPage, parseShippingAvailability, parseStructuredListings, parseVintedCards, validateSearchUrl } from '../server/marketplaces';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { median, pruneBefore, scoreDeal } from '../server/scoring';
import { buildDiscordEmbed, buildNtfyPayload, meetsMinimumPriority, notificationKey, priorityFromDiscount, publishNtfy, validateNtfyConfig } from '../server/notifications';
import { filterListings } from '../server/service';

test('validates approved HTTPS search URLs and blocks off-domain redirects', () => {
  assert.equal(validateSearchUrl('https://www.olx.pl/d/q-steam-deck/').valid, true);
  assert.equal(validateSearchUrl('http://www.olx.pl/d/q-steam-deck/').valid, false);
  assert.equal(validateSearchUrl('https://olx.pl.evil.example/').valid, false);
  assert.equal(validateSearchUrl('https://allegrolokalnie.pl/oferty/').marketplace, 'Allegro Lokalnie');
  assert.equal(validateSearchUrl('https://allegro.pl/oferty/').valid, false);
});

test('builds native marketplace filter URLs for price and supported conditions', () => {
  const olx = new URL(buildMarketplaceSearchUrl('OLX', 'steam deck', { minPrice: 500, maxPrice: 1500, shippingOnly: true }));
  assert.equal(olx.searchParams.get('search[filter_float_price:from]'), '500');
  assert.equal(olx.searchParams.get('search[filter_float_price:to]'), '1500');
  assert.equal(olx.searchParams.get('courier'), 'on');

  const allegro = new URL(buildMarketplaceSearchUrl('Allegro Lokalnie', 'steam deck', { minPrice: 500, maxPrice: 1500, condition: 'New' }));
  assert.equal(allegro.searchParams.get('price_from'), '500');
  assert.equal(allegro.searchParams.get('price_to'), '1500');
  assert.deepEqual(allegro.searchParams.getAll('zrodlo'), ['lokalnie']);
  assert.equal(allegro.searchParams.get('stan'), 'nowe');

  const vinted = new URL(buildMarketplaceSearchUrl('Vinted', 'steam deck', { minPrice: 500, maxPrice: 1500, condition: 'New' }));
  assert.equal(vinted.searchParams.get('price_from'), '500');
  assert.equal(vinted.searchParams.get('price_to'), '1500');
  assert.deepEqual(vinted.searchParams.getAll('status_ids[]'), ['6', '1']);
  const usedVinted = new URL(buildMarketplaceSearchUrl('Vinted', 'steam deck', { condition: 'Used' }));
  assert.deepEqual(usedVinted.searchParams.getAll('status_ids[]'), ['2', '3', '4', '5']);
});

test('adds marketplace-native newest ordering for generated watch URLs', () => {
  const olx = new URL(buildMarketplaceSearchUrl('OLX', 'steam deck', { sort: 'newest' }));
  assert.equal(olx.searchParams.get('search[order]'), 'created_at:desc');

  const allegro = new URL(buildMarketplaceSearchUrl('Allegro Lokalnie', 'steam deck', { sort: 'newest' }));
  assert.equal(allegro.searchParams.get('sort'), 'startingTime-desc');

  const vinted = new URL(buildMarketplaceSearchUrl('Vinted', 'steam deck', { sort: 'newest' }));
  assert.equal(vinted.searchParams.get('order'), 'newest_first');

  const manual = new URL(buildMarketplaceSearchUrl('OLX', 'steam deck'));
  assert.equal(manual.searchParams.has('search[order]'), false);
});

test('normalizes Polish prices and deduplicates by marketplace/listing id', () => {
  assert.equal(parsePolishPrice('1 899,00 zł'), 1899);
  const listing = normalizeListing({ marketplace: 'OLX', listingId: 'abc', title: '  Deck  512GB ', price: '1 899 zł', url: 'https://www.olx.pl/d/oferta/deck-abc' });
  assert.equal(listing.title, 'Deck 512GB');
  assert.equal(listing.priceNegotiable, null);
  assert.equal(dedupeKey(listing), 'olx:abc');
});

test('detects explicit Polish negotiation signals without guessing from silence', () => {
  assert.equal(parsePriceNegotiability('Cena do negocjacji'), true);
  assert.equal(parsePriceNegotiability('Możliwość negocjacji'), true);
  assert.equal(parsePriceNegotiability('Cena nie do negocjacji'), false);
  assert.equal(parsePriceNegotiability('Cena sztywna'), false);
  assert.equal(parsePriceNegotiability('Używany, stan bardzo dobry'), null);
});

test('parses public JSON-LD listing fixtures and fails closed on unsupported markup', () => {
  const fixture = readFileSync(resolve(import.meta.dirname, 'fixtures-olx.html'), 'utf8');
  const listings = parseStructuredListings(fixture, 'OLX');
  assert.equal(listings.length, 1);
  assert.equal(listings[0].price, 1899);
  assert.equal(parseStructuredListings('<html><body>challenge</body></html>', 'OLX').length, 0);
});

test('accepts explicit empty search pages but rejects arbitrary zero-card markup', () => {
  const empty = parseSearchPage('<html><body><div data-testid="no-results">No results</div></body></html>', 'OLX');
  assert.equal(empty.empty, true);
  assert.equal(empty.pageStatus, 'empty');
  assert.equal(empty.length, 0);
  assert.throws(() => parseSearchPage('<html><body><p>Welcome to the marketplace</p></body></html>', 'OLX'), /no supported listing or empty-state/);
});

test('classifies listing details as live, terminal, or unknown without inferring a sale', () => {
  const live = parseListingAvailability('<html><body><h1>Steam Deck OLED</h1><div data-testid="ad-card-title">Steam Deck OLED 512GB</div><button>Wyślij wiadomość</button></body></html>', 'OLX');
  assert.deepEqual(live, { status: 'live' });
  const terminal = parseListingAvailability('<html><body><h1>Ogłoszenie jest niedostępne</h1><p>Ta oferta nie jest już dostępna.</p></body></html>', 'OLX');
  assert.equal(terminal.status, 'terminal');
  assert.equal(parseListingAvailability('<html><body><h1>Checking your browser</h1><p>Cloudflare challenge</p></body></html>', 'OLX').status, 'unknown');
  assert.equal(parseListingAvailability('', 'OLX', 404).status, 'terminal');
  assert.equal(parseListingAvailability('', 'OLX', 503).status, 'unknown');
});

test('extracts a listing description from detail-page structured data and description markup', () => {
  const structured = `<script type="application/ld+json">${JSON.stringify({ '@type': 'Product', name: 'Steam Deck', description: 'Działa bez zastrzeżeń. W zestawie ładowarka.', offers: { price: '1200' } })}</script>`;
  assert.equal(parseListingDescription(structured, 'OLX'), 'Działa bez zastrzeżeń. W zestawie ładowarka.');
  assert.equal(parseListingDescription('<div data-testid="item-description"><p>Sprawny, bez blokady konta.</p></div>', 'Vinted'), 'Sprawny, bez blokady konta.');
  assert.equal(parseListingDescription('<html><body><h1>Steam Deck</h1></body></html>', 'OLX'), null);
});

test('normalizes object-shaped JSON-LD images before storage', () => {
  const html = `<script type="application/ld+json">${JSON.stringify({
    '@type': 'Product', name: 'Intel i5', sku: 'i5-8400', url: 'https://allegrolokalnie.pl/oferta/i5-8400',
    image: { contentUrl: 'https://img.example/i5.jpg' }, offers: { price: '180' },
  })}</script>`;
  const [listing] = parseStructuredListings(html, 'Allegro Lokalnie');
  assert.equal(listing.imageUrl, 'https://img.example/i5.jpg');
});

test('parses rendered OLX cards without relying on generated class names', () => {
  const html = `<div data-cy="l-card" data-testid="l-card" id="1089143315"><img src="https://ireland.apollo.olxcdn.com/image.jpg" alt="Intel i5"><div data-testid="card-delivery-badge">Dostawa</div><div data-testid="ad-card-title"><a data-testid="card-title-link" href="/d/oferta/intel-i5-8400-CID99-IDabc123.html"><h4>Intel Core i5 8400</h4></a><p data-testid="ad-price">180 zł</p><span>Do negocjacji</span></div><div data-nx-name="NexusBadge">Używane</div><p data-testid="location-date">Warszawa - Dzisiaj</p></div>`;
  const [listing] = parseOlxCards(html);
  assert.equal(listing.listingId, '1089143315');
  assert.equal(listing.price, 180);
  assert.equal(listing.location, 'Warszawa');
  assert.equal(listing.condition, 'Używane');
  assert.equal(listing.shippingAvailable, true);
  assert.equal(listing.priceNegotiable, true);
});

test('parses Allegro Lokalnie offer type as shipping availability', () => {
  const html = `
    <article class="mlc-itembox__container" data-card-analytics-click="buy-1">
      <a href="/oferta/steam-deck-buy" itemprop="url"><h3 itemprop="itemOffered">Steam Deck with shipping</h3></a>
      <span class="mlc-itembox__offer-type mlc-itembox__offer-type--buy_now">Kup teraz</span>
      <span class="price-negotiability">Cena do negocjacji</span>
      <span class="ml-offer-price__dollars">1 200</span>
    </article>
    <article class="mlc-itembox__container" data-card-analytics-click="classified-1">
      <a href="/oferta/steam-deck-pickup" itemprop="url"><h3 itemprop="itemOffered">Steam Deck pickup only</h3></a>
      <span class="mlc-itembox__offer-type mlc-itembox__offer-type--classified">Ogłoszenie</span>
      <span class="price-negotiability">Cena sztywna</span>
      <span class="ml-offer-price__dollars">900</span>
    </article>`;
  const listings = parseAllegroCards(html);
  assert.deepEqual(listings.map((listing) => listing.shippingAvailable), [true, false]);
  assert.deepEqual(listings.map((listing) => listing.priceNegotiable), [true, false]);
  assert.deepEqual(listings.map((listing) => listing.listingId), ['buy-1', 'classified-1']);
});

test('reads shipping state from Vinted and marketplace detail-page signals', () => {
    assert.equal(parseShippingAvailability('<div data-testid="item-shipping-banner"><h3>Wysyłka</h3></div>', 'Vinted'), true);
    assert.equal(parseShippingAvailability('<main><p>Tylko odbiór osobisty</p></main>', 'Vinted'), false);
    assert.equal(parseShippingAvailability('<script>window.item={"transaction_permitted":false}</script>', 'Vinted'), false);
    assert.equal(parseShippingAvailability('<div class="mlc-delivery-options__name">Allegro Paczkomaty InPost</div>', 'Allegro Lokalnie'), true);
  assert.equal(parseShippingAvailability('<main><p>Odbiór osobisty</p></main>', 'Allegro Lokalnie'), false);
  assert.equal(parseShippingAvailability('<html><body>challenge</body></html>', 'Vinted'), null);
});

test('parses Vinted public card labels and uses item price rather than total price', () => {
  const html = `<div><img src="https://images1.vinted.net/item.webp" alt="Procesor"><a href="/items/9728935135-procesor-i5-8400?referrer=catalog" data-testid="product-item-id-9728935135--overlay-link" title="Procesor i5-8400, Marka: Intel, Stan: Bardzo dobry, 80.00 zł, 86.90 zł"></a></div>`;
  const [listing] = parseVintedCards(html);
  assert.equal(listing.listingId, '9728935135');
  assert.equal(listing.title, 'Procesor i5-8400');
  assert.equal(listing.price, 80);
  assert.equal(listing.condition, 'Bardzo dobry');
});

test('keeps cold-start deals silent until samples and hours are ready', () => {
  const cold = scoreDeal([100, 105, 110, 98], 40, { observedHours: 2 });
  assert.equal(cold.qualifies, false);
  const prices = Array.from({ length: 40 }, (_, index) => 1000 + (index % 5) * 15);
  const ready = scoreDeal(prices, 650, { observedHours: 30 });
  assert.equal(ready.isReady, true);
  assert.equal(ready.qualifies, true);
  assert.equal(scoreDeal(prices, 650, { observedHours: 6 }).isReady, true);
  assert.equal(scoreDeal(prices, 650, { observedHours: 5 }).isReady, false);
  assert.equal(median([1, 3, 2]), 2);
  assert.equal(median([1, 3]), 2);
});

test('prunes observations older than the retention window', () => {
  const now = Date.parse('2026-08-22T00:00:00.000Z');
  const retained = pruneBefore([{ observedAt: '2026-08-01T00:00:00.000Z' }, { observedAt: '2025-12-01T00:00:00.000Z' }], now, 180);
  assert.equal(retained.length, 1);
});

test('builds one stable Discord embed key per listing', () => {
  const listing = { marketplace: 'OLX' as const, listingId: 'ABC-1', title: 'Deck', price: 900, currency: 'PLN' as const, url: 'https://www.olx.pl/d/oferta/deck-abc-1', observedAt: '2026-08-22T00:00:00.000Z' };
  const embed = buildDiscordEmbed({ listing, typical: 1400, discountPercent: 35.7, confidence: 94 });
  assert.equal(notificationKey(listing), 'olx:abc-1');
  assert.equal(embed.embeds[0].fields.find((field) => field.name === 'Confidence')?.value, '94%');
  assert.equal(embed.embeds[0].url, listing.url);
});

test('maps deal tiers to independent notification thresholds and ntfy payloads', async () => {
  const listing = { marketplace: 'OLX' as const, listingId: 'ntfy-1', title: 'Deck', price: 900, currency: 'PLN' as const, url: 'https://www.olx.pl/d/oferta/deck-ntfy-1', observedAt: '2026-08-22T00:00:00.000Z' };
  assert.equal(priorityFromDiscount(18), 'strong');
  assert.equal(priorityFromDiscount(20), 'very-strong');
  assert.equal(priorityFromDiscount(30), 'exceptional');
  assert.equal(meetsMinimumPriority('very-strong', 'strong'), true);
  assert.equal(meetsMinimumPriority('strong', 'exceptional'), false);
  const config = validateNtfyConfig({ serverUrl: 'https://ntfy.sh/', topic: 'scout-deals', token: 'tk_test', minimumPriority: 'exceptional' });
  const payload = buildNtfyPayload({ listing, typical: 1400, discountPercent: 35.7, confidence: 94 }, config.topic);
  let requestedUrl = '';
  let requestedInit: RequestInit | undefined;
  await publishNtfy(config, payload, async (input, init) => {
    requestedUrl = String(input);
    requestedInit = init;
    return new Response(null, { status: 200 });
  });
  assert.equal(requestedUrl, 'https://ntfy.sh/');
  assert.equal(requestedInit?.headers && new Headers(requestedInit.headers).get('authorization'), 'Bearer tk_test');
  assert.equal(JSON.parse(String(requestedInit?.body)).priority, 5);
  assert.equal(JSON.parse(String(requestedInit?.body)).click, listing.url);
});

test('rejects unsafe ntfy endpoints and invalid topics', () => {
  assert.throws(() => validateNtfyConfig({ serverUrl: 'https://example.com?token=secret', topic: 'scout-deals' }), /credentials or query/);
  assert.throws(() => validateNtfyConfig({ serverUrl: 'http://example.com', topic: 'scout-deals' }), /HTTPS/);
  assert.throws(() => validateNtfyConfig({ serverUrl: 'https://ntfy.sh', topic: 'not a topic' }), /topic must be/);
});

test('uses query tokens as the default comparability filter', () => {
  const base = { marketplace: 'OLX' as const, price: 100, currency: 'PLN' as const, url: 'https://www.olx.pl/d/oferta/test', observedAt: new Date().toISOString(), shippingAvailable: null as boolean | null };
  const listings = [
    { ...base, listingId: '1', title: 'Procesor Intel i5-8400' },
    { ...base, listingId: '2', title: 'Komputer Ryzen 7500F' },
    { ...base, listingId: '3', title: 'Uszkodzony Intel i5 8400' },
  ];
  assert.deepEqual(filterListings(listings, 'i5 8400', '', 'uszkodzony').map((listing) => listing.listingId), ['1']);
  listings[0].shippingAvailable = true;
  assert.deepEqual(filterListings(listings, 'i5 8400', '', 'uszkodzony', true).map((listing) => listing.listingId), ['1']);
  listings[0].shippingAvailable = false;
  assert.deepEqual(filterListings(listings, 'i5 8400', '', 'uszkodzony', true), []);
});

test('applies manual and watch price, condition, and location filters', () => {
  const base = { marketplace: 'OLX' as const, currency: 'PLN' as const, url: 'https://www.olx.pl/d/oferta/test', observedAt: new Date().toISOString(), shippingAvailable: true };
  const listings = [
    { ...base, listingId: '1', title: 'Intel i5 8400', price: 180, condition: 'Używane', location: 'Warszawa' },
    { ...base, listingId: '2', title: 'Intel i5 8400 nowy', price: 260, condition: 'Nowe', location: 'Kraków' },
    { ...base, listingId: '3', title: 'Intel i5 8400', price: 500, condition: 'Używane', location: 'Warszawa' },
  ];
  assert.deepEqual(filterListings(listings, 'i5 8400', '', '', { minPrice: 150, maxPrice: 300 }).map((listing) => listing.listingId), ['1', '2']);
  assert.deepEqual(filterListings(listings, 'i5 8400', '', '', { condition: 'Used', location: 'Warszawa' }).map((listing) => listing.listingId), ['1', '3']);
  assert.deepEqual(filterListings(listings, 'i5 8400', '', '', { condition: 'New' }).map((listing) => listing.listingId), ['2']);
});
