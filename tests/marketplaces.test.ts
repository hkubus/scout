import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMarketplaceSearchUrl, buildOlxSearchApiUrl, buildVintedSearchApiUrl, createAllegroLokalnieAdapter, createOlxJsonAdapter, createVintedJsonAdapter, dedupeKey, normalizeListing, parseAllegroBatchEnrichmentApi, parseAllegroCards, parseListingAvailability, parseListingDescription, parseListingImageUrls, parseOlxListingAvailabilityApi, parseOlxOffersApi, parseOlxCards, parsePolishPrice, parsePriceNegotiability, parseSearchPage, parseShippingAvailability, parseStructuredListings, parseVintedCards, parseVintedCatalogApi, parseVintedItemPageAvailability, validateSearchUrl, type ConnectorAdapter } from '../server/marketplaces';
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

test('prefers the Lokalnie offer description over the templated meta boilerplate', () => {
  const boilerplate = 'Kup teraz: Nike Air Max Plus 3 za 800,00 zł i odbierz w mieście Warszawa. Szybko i bezpiecznie w najlepszym miejscu dla lokalnych Allegrowiczów.';
  const html = `<html><head><meta name="description" content="${boilerplate}"></head><body><div class="ml-text-truncate__content"><div class="mlc-no-hydrate"><div class="ml-text-medium mlc-offer__description"><p class="desc-p">Sprzedaję oryginalne Nike Air Max Plus 3.</p></div></div></div></body></html>`;
  assert.equal(parseListingDescription(html, 'Allegro Lokalnie'), 'Sprzedaję oryginalne Nike Air Max Plus 3.');
});

test('normalizes object-shaped JSON-LD images before storage', () => {
  const html = `<script type="application/ld+json">${JSON.stringify({
    '@type': 'Product', name: 'Intel i5', sku: 'i5-8400', url: 'https://allegrolokalnie.pl/oferta/i5-8400',
    image: { contentUrl: 'https://img.example/i5.jpg' }, offers: { price: '180' },
  })}</script>`;
  const [listing] = parseStructuredListings(html, 'Allegro Lokalnie');
  assert.equal(listing.imageUrl, 'https://img.example/i5.jpg');
});

test('collects deduplicated gallery image URLs from detail pages', () => {
  const html = [
    `<script type="application/ld+json">${JSON.stringify({ '@type': 'Product', name: 'GPU', image: ['https://ireland.apollo.olxcdn.com/v1/files/abc-PL/image;s={width}x{height}', 'https://ireland.apollo.olxcdn.com/v1/files/abc-PL/image;s=320x240'] })}</script>`,
    '<meta property="og:image" content="https://ireland.apollo.olxcdn.com/v1/files/def-PL/image;s=644x461">',
    '<img src="https://ireland.apollo.olxcdn.com/v1/files/def-PL/image;s=320x240" alt="">',
    '<img src="https://images1.vinted.net/t/03_0266a_9f08b2cb1_800x800.jpeg?s=sig" alt="">',
    '<img src="https://ireland.apollo.olxcdn.com/favicon.ico" alt="">',
    '<img src="http://ireland.apollo.olxcdn.com/v1/files/insecure-PL/image" alt="">',
  ].join('');
  const urls = parseListingImageUrls(html, 'OLX');
  assert.deepEqual(urls, [
    'https://ireland.apollo.olxcdn.com/v1/files/abc-PL/image;s=1000x750',
    'https://ireland.apollo.olxcdn.com/v1/files/def-PL/image;s=644x461',
    'https://images1.vinted.net/t/03_0266a_9f08b2cb1_800x800.jpeg?s=sig',
  ]);
  assert.deepEqual(parseListingImageUrls('', 'OLX'), []);
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

test('builds OLX offers API URLs from Scout query filters', () => {
  const url = new URL(buildOlxSearchApiUrl('iphone 14', { minPrice: 500, maxPrice: 1500, condition: 'Used', sort: 'newest', page: 3 }));
  assert.equal(url.origin + url.pathname, 'https://www.olx.pl/api/v1/offers/');
  assert.equal(url.searchParams.get('query'), 'iphone 14');
  assert.equal(url.searchParams.get('filter_float_price:from'), '500');
  assert.equal(url.searchParams.get('filter_float_price:to'), '1500');
  assert.equal(url.searchParams.get('filter_enum_state[0]'), 'used');
  assert.equal(url.searchParams.get('sort_by'), 'created_at:desc');
  assert.equal(url.searchParams.get('offset'), '100');
  assert.equal(url.searchParams.get('limit'), '50');
  const unfiltered = new URL(buildOlxSearchApiUrl('steam deck'));
  assert.equal(unfiltered.searchParams.has('offset'), false);
  assert.equal(unfiltered.searchParams.has('sort_by'), false);
  assert.equal(unfiltered.searchParams.has('owner_type'), false);
  assert.equal(unfiltered.searchParams.get('limit'), '50');
  // Seller type is a structured OLX filter, not a post-filter on the results.
  assert.equal(new URL(buildOlxSearchApiUrl('iphone 14', { ownerType: 'private' })).searchParams.get('owner_type'), 'private');
  assert.equal(new URL(buildOlxSearchApiUrl('iphone 14', { ownerType: 'business' })).searchParams.get('owner_type'), 'business');
});

test('maps OLX offers API payloads onto normalized listings', () => {
  const fixture = JSON.parse(readFileSync(resolve(import.meta.dirname, 'fixtures-olx-api.json'), 'utf8'));
  const listings = parseOlxOffersApi(fixture.search);
  assert.equal(listings.pageStatus, 'results');
  assert.equal(listings.empty, false);
  assert.equal(listings.length, 1);
  const [listing] = listings;
  assert.equal(listing.marketplace, 'OLX');
  assert.equal(listing.listingId, '1092728340');
  assert.equal(listing.title, 'Iphon 13 128GB 100% Baterii Black');
  assert.equal(listing.price, 800);
  assert.equal(listing.priceNegotiable, false);
  assert.equal(listing.condition, 'Używane');
  assert.equal(listing.location, 'Małopolskie, Łapanów');
  assert.equal(listing.shippingAvailable, true);
  assert.equal(listing.imageUrl, 'https://ireland.apollo.olxcdn.com/v1/files/nl9i997bhz1g1-PL/image;s=320x240');
  assert.equal(listing.observedAt, '2026-08-20T19:40:08+02:00');
  assert.equal(listing.url, 'https://www.olx.pl/d/oferta/iphon-13-128gb-100-baterii-black-CID99-ID1bVYyE.html');
});

test('treats zero visible totals and exhausted pages as explicit empty OLX searches', () => {
  const empty = parseOlxOffersApi({ data: [], metadata: { visible_total_count: 0 } });
  assert.equal(empty.pageStatus, 'empty');
  assert.equal(empty.empty, true);
  const exhausted = parseOlxOffersApi({ data: [], metadata: { visible_total_count: 145167 } });
  assert.equal(exhausted.empty, true);
  const gibberish = parseOlxOffersApi({ data: [{ id: 1, url: 'https://www.olx.pl/d/oferta/x-ID1.html', title: 'Loosely related', params: [{ key: 'price', value: { value: 40, currency: 'PLN' } }] }], metadata: { visible_total_count: 70 } });
  assert.equal(gibberish.empty, false);
  assert.equal(gibberish.length, 1);
  assert.throws(() => parseOlxOffersApi({ error: { title: 'Not Found' } }), /data array/);
});

test('classifies OLX API availability from HTTP status and payload shape', () => {
  const fixture = JSON.parse(readFileSync(resolve(import.meta.dirname, 'fixtures-olx-api.json'), 'utf8'));
  assert.deepEqual(parseOlxListingAvailabilityApi(fixture.notFound, 404), { status: 'terminal', reason: 'Ad not found.' });
  assert.deepEqual(parseOlxListingAvailabilityApi(null, 410), { status: 'terminal', reason: 'Marketplace returned HTTP 410' });
  assert.equal(parseOlxListingAvailabilityApi(null, 403).status, 'unknown');
  assert.equal(parseOlxListingAvailabilityApi(null, 429).status, 'unknown');
  assert.equal(parseOlxListingAvailabilityApi(null, 503).status, 'unknown');
  assert.equal(parseOlxListingAvailabilityApi(null, 200).status, 'unknown');
  assert.equal(parseOlxListingAvailabilityApi({ error: { detail: 'Bot challenge' } }, 200).status, 'unknown');
  const live = { data: { id: 1092728340, status: 'active', url: 'https://www.olx.pl/d/oferta/x-ID1bVYyE.html', title: 'X', params: [{ key: 'price', value: { value: 800, currency: 'PLN' } }] } };
  assert.deepEqual(parseOlxListingAvailabilityApi(live, 200), { status: 'live' });
  assert.equal(parseOlxListingAvailabilityApi({ data: { status: 'removed' } }, 200).status, 'unknown');
});

test('runs OLX searches and detail checks through the offers API adapter', async () => {
  const fixture = JSON.parse(readFileSync(resolve(import.meta.dirname, 'fixtures-olx-api.json'), 'utf8'));
  const requests: string[] = [];
  const paths: string[] = [];
  const adapter = createOlxJsonAdapter('OLX', async (url) => {
    requests.push(url);
    if (url.endsWith('/api/v1/offers/1092728340/')) return { status: 200, json: { data: fixture.search.data[0] } };
    if (url.endsWith('/api/v1/offers/99999999999/')) return { status: 404, json: fixture.notFound };
    return { status: 200, json: fixture.search };
  }, (path) => paths.push(path));
  const search = await adapter.fetchPublicSearch('https://www.olx.pl/oferty/q-iphone/?search[filter_float_price:from]=500&search[order]=created_at:desc&page=2');
  assert.deepEqual(paths, ['olx-offers-api']);
  const requested = new URL(requests[0]);
  assert.equal(requested.pathname, '/api/v1/offers/');
  assert.equal(requested.searchParams.get('query'), 'iphone');
  assert.equal(requested.searchParams.get('filter_float_price:from'), '500');
  assert.equal(requested.searchParams.get('sort_by'), 'created_at:desc');
  assert.equal(requested.searchParams.get('offset'), '50');
  assert.equal(search.length, 1);
  assert.equal(search[0].listingId, '1092728340');
  assert.equal(search.empty, false);

  const detail = await adapter.fetchDetail('https://www.olx.pl/d/oferta/iphon-13-128gb-100-baterii-black-CID99-ID1bVYyE.html', { listingId: '1092728340' });
  assert.equal(requests[1], 'https://www.olx.pl/api/v1/offers/1092728340/');
  assert.equal(detail.availability.status, 'live');
  assert.equal(detail.listing?.listingId, '1092728340');
  assert.equal(detail.listing?.price, 800);

  const removed = await adapter.fetchDetail('https://www.olx.pl/d/oferta/gone-ID99999999999.html', { listingId: '99999999999' });
  assert.deepEqual(removed.availability, { status: 'terminal', reason: 'Ad not found.' });
  assert.deepEqual(paths, ['olx-offers-api', 'olx-offer-detail-api', 'olx-offer-detail-api']);

  const nonNumeric = await adapter.fetchDetail('https://www.olx.pl/d/oferta/token-only-ID1bVYyE.html');
  assert.equal(nonNumeric.availability.status, 'unknown');

  const failing = createOlxJsonAdapter('OLX', async () => ({ status: 403, json: null }));
  await assert.rejects(() => failing.fetchPublicSearch('https://www.olx.pl/oferty/q-iphone/'), /HTTP 403/);
  assert.equal((await failing.fetchDetail('https://www.olx.pl/d/oferta/x-ID123.html', { listingId: '123' })).availability.status, 'unknown');
});

test('rejects OLX exact URLs that cannot be translated to the offers API', async () => {
  const fixture = JSON.parse(readFileSync(resolve(import.meta.dirname, 'fixtures-olx-api.json'), 'utf8'));
  const adapter = createOlxJsonAdapter('OLX', async () => ({ status: 200, json: fixture.search }));
  await assert.rejects(() => adapter.fetchPublicSearch('https://www.olx.pl/elektronika/'), /offers API/);
  await assert.rejects(() => adapter.fetchPublicSearch('https://allegrolokalnie.pl/oferty/q-iphone/'), /approved|offers API|domain/i);
});

test('builds Vinted catalog API URLs from Scout query filters', () => {
  const url = new URL(buildVintedSearchApiUrl('lego technic', { minPrice: 20, maxPrice: 150, condition: 'New', sort: 'newest', page: 3 }));
  assert.equal(url.origin + url.pathname, 'https://www.vinted.pl/api/v2/catalog/items');
  assert.equal(url.searchParams.get('search_text'), 'lego technic');
  assert.equal(url.searchParams.get('price_from'), '20');
  assert.equal(url.searchParams.get('price_to'), '150');
  assert.deepEqual(url.searchParams.getAll('status_ids[]'), ['6', '1']);
  assert.equal(url.searchParams.get('order'), 'newest_first');
  assert.equal(url.searchParams.get('page'), '3');
  assert.equal(url.searchParams.get('per_page'), '20');
  const unfiltered = new URL(buildVintedSearchApiUrl('lego'));
  assert.equal(unfiltered.searchParams.has('order'), false);
  assert.equal(unfiltered.searchParams.has('page'), false);
  assert.equal(unfiltered.searchParams.get('per_page'), '20');
});

test('maps Vinted catalog API payloads onto normalized listings', () => {
  const fixture = JSON.parse(readFileSync(resolve(import.meta.dirname, 'fixtures-vinted-api.json'), 'utf8'));
  const listings = parseVintedCatalogApi(fixture.search);
  assert.equal(listings.pageStatus, 'results');
  assert.equal(listings.empty, false);
  assert.equal(listings.length, 1);
  const [listing] = listings;
  assert.equal(listing.marketplace, 'Vinted');
  assert.equal(listing.listingId, '40203315928');
  assert.equal(listing.title, 'Lego Technic Porsche 911 RSR');
  assert.equal(listing.price, 149);
  assert.equal(listing.currency, 'PLN');
  assert.equal(listing.condition, 'Bardzo dobry');
  assert.equal(listing.priceNegotiable, null);
  assert.equal(listing.shippingAvailable, null);
  assert.equal(listing.url, 'https://www.vinted.pl/items/40203315928-lego-technic-porsche-911-rsr');
  assert.equal(listing.imageUrl, 'https://images1.vinted.net/t/03_0266a_9f08b2cb1_800x800.jpeg?s=s1');
  assert.ok(listing.observedAt);
  const empty = parseVintedCatalogApi(fixture.empty);
  assert.equal(empty.pageStatus, 'empty');
  assert.equal(empty.empty, true);
  assert.equal(empty.length, 0);
  assert.throws(() => parseVintedCatalogApi({ code: 100, message: 'invalid_authentication_token' }), /items array/);
});

test('translates Vinted catalog pages to the API and falls back to public pages', async () => {
  const fixture = JSON.parse(readFileSync(resolve(import.meta.dirname, 'fixtures-vinted-api.json'), 'utf8'));
  const requested: string[] = [];
  const paths: string[] = [];
  let apiFailures = 0;
  let fallbackSearches = 0;
  const fallback: ConnectorAdapter = {
    marketplace: 'Vinted',
    fetchPublicSearch: async () => {
      fallbackSearches += 1;
      return parseSearchPage('<html><body><div data-testid="no-results">Brak wyników</div></body></html>', 'Vinted');
    },
    fetchDetail: async () => ({ availability: { status: 'unknown', reason: 'unused' } }),
    verifyAvailability: async () => ({ status: 'unknown', reason: 'unused' }),
  };
  const adapter = createVintedJsonAdapter(
    'Vinted',
    async (url) => {
      requested.push(url);
      if (apiFailures++ === 0) throw new Error('Vinted did not issue an anonymous access token (HTTP 403)');
      const searchText = new URL(url).searchParams.get('search_text');
      return { status: 200, json: searchText === 'zzzzqkzzzx' ? fixture.empty : fixture.search };
    },
    async () => ({ status: 200, body: '' }),
    fallback,
    (path) => paths.push(path),
  );
  const catalogUrl = buildMarketplaceSearchUrl('Vinted', 'lego', { minPrice: 20, maxPrice: 150, condition: 'New', sort: 'newest', page: 2 });

  const fenced = await adapter.fetchPublicSearch(catalogUrl);
  assert.equal(fallbackSearches, 1);
  assert.equal(fenced.empty, true);
  assert.deepEqual(paths, ['vinted-catalog-api-fallback']);

  const search = await adapter.fetchPublicSearch(catalogUrl);
  assert.equal(fallbackSearches, 1);
  assert.equal(search.length, 1);
  assert.equal(requested.length, 2);
  assert.deepEqual(paths, ['vinted-catalog-api-fallback', 'vinted-catalog-api']);
  const api = new URL(requested[1]);
  assert.equal(api.origin + api.pathname, 'https://www.vinted.pl/api/v2/catalog/items');
  assert.equal(api.searchParams.get('search_text'), 'lego');
  assert.equal(api.searchParams.get('price_from'), '20');
  assert.equal(api.searchParams.get('price_to'), '150');
  assert.deepEqual(api.searchParams.getAll('status_ids[]'), ['6', '1']);
  assert.equal(api.searchParams.get('order'), 'newest_first');
  assert.equal(api.searchParams.get('page'), '2');
  assert.equal(api.searchParams.get('per_page'), '20');

  const empty = await adapter.fetchPublicSearch(buildMarketplaceSearchUrl('Vinted', 'zzzzqkzzzx', {}));
  assert.equal(empty.empty, true);
  assert.equal(fallbackSearches, 1);
  await assert.rejects(() => adapter.fetchPublicSearch('https://vinted.pl.evil.example/catalog?search_text=lego'), /approved/i);
});

test('falls back to the Chrome-UA catalog page when the Vinted catalog API is retired', async () => {
  const cardHtml = `<html><body><div class="Grid-module-scss-module__HmDNda__feed-grid__item"><div class="ItemBox-module-scss-module__NoC3Da__new-item-box__image"><img src="https://images1.vinted.net/t/item.webp" alt="x"/></div><a href="/items/10057436612-lego-mix-polybagow?referrer=catalog" data-testid="product-item-id-10057436612--overlay-link" title="Lego Mix polybagów, Marka: LEGO, Stan: Nowy bez metki, 50.00 zł, 55.40 zł"></a></div></body></html>`;
  const paths: string[] = [];
  let fallbackSearches = 0;
  const fallback: ConnectorAdapter = {
    marketplace: 'Vinted',
    fetchPublicSearch: async () => {
      fallbackSearches += 1;
      return parseSearchPage('<html><body></body></html>', 'Vinted');
    },
    fetchDetail: async () => ({ availability: { status: 'unknown', reason: 'unused' } }),
    verifyAvailability: async () => ({ status: 'unknown', reason: 'unused' }),
  };
  const adapter = createVintedJsonAdapter(
    'Vinted',
    // /api/v2/catalog/items answers 404 (HTML body, JSON content-type) as of 2026-09-19.
    async () => ({ status: 404, json: null }),
    async () => ({ status: 200, body: cardHtml }),
    fallback,
    (path) => paths.push(path),
  );
  const search = await adapter.fetchPublicSearch(buildMarketplaceSearchUrl('Vinted', 'lego', {}));
  assert.equal(search.length, 1);
  assert.equal(search[0].listingId, '10057436612');
  assert.equal(search[0].price, 50);
  assert.equal(fallbackSearches, 0);
  assert.deepEqual(paths, ['vinted-catalog-page']);
});

test('falls through to the generic adapter when the Vinted catalog page also fails', async () => {
  const paths: string[] = [];
  let fallbackSearches = 0;
  const fallback: ConnectorAdapter = {
    marketplace: 'Vinted',
    fetchPublicSearch: async () => {
      fallbackSearches += 1;
      return parseSearchPage('<html><body><div data-testid="no-results">Brak wyników</div></body></html>', 'Vinted');
    },
    fetchDetail: async () => ({ availability: { status: 'unknown', reason: 'unused' } }),
    verifyAvailability: async () => ({ status: 'unknown', reason: 'unused' }),
  };
  const adapter = createVintedJsonAdapter(
    'Vinted',
    async () => ({ status: 404, json: null }),
    async () => ({ status: 403, body: '' }),
    fallback,
    (path) => paths.push(path),
  );
  const result = await adapter.fetchPublicSearch(buildMarketplaceSearchUrl('Vinted', 'lego', {}));
  assert.equal(result.empty, true);
  assert.equal(fallbackSearches, 1);
  assert.deepEqual(paths, ['vinted-catalog-api-fallback']);
});

test('preserves the API cause when Vinted page and API both fail without a fallback', async () => {
  const adapter = createVintedJsonAdapter(
    'Vinted',
    async () => { throw new Error('Vinted did not issue an anonymous access token (HTTP 403)'); },
    async () => ({ status: 403, body: '' }),
    undefined,
  );
  const error = await adapter.fetchPublicSearch(buildMarketplaceSearchUrl('Vinted', 'lego', {})).then(
    () => { throw new Error('expected fetchPublicSearch to throw'); },
    (error: unknown) => error,
  );
  assert.match((error as Error).message, /Vinted catalog page returned HTTP 403/);
  assert.match(String(((error as Error).cause as Error)?.message ?? ''), /anonymous access token/);
});

test('classifies Vinted item pages as live, terminal, or unknown without JSON routes', async () => {
  const itemHtml = `<html><head><script type="application/ld+json">${JSON.stringify({
    '@type': 'Product', name: 'Lego Technic Porsche', image: ['https://images1.vinted.net/t/item.jpeg'],
    brand: { name: 'LEGO' }, offers: { price: 149, priceCurrency: 'PLN', availability: 'InStock', itemCondition: 'UsedCondition', url: 'https://www.vinted.pl/items/40203315928-lego-technic-porsche' },
  })}</script></head><body></body></html>`;
  const soldHtml = itemHtml.replace('InStock', 'SoldOut');
  const pages: Record<string, { status: number; body: string }> = {
    'https://www.vinted.pl/items/40203315928': { status: 200, body: itemHtml },
    'https://www.vinted.pl/items/40203315929': { status: 200, body: soldHtml },
    'https://www.vinted.pl/items/40203315930': { status: 404, body: '' },
    'https://www.vinted.pl/items/40203315931': { status: 403, body: '' },
    'https://www.vinted.pl/items/40203315932': { status: 200, body: '<html><head><title>Just a moment...</title></head><body>cf-chl-platform challenge</body></html>' },
  };
  const paths: string[] = [];
  const adapter = createVintedJsonAdapter(
    'Vinted',
    async () => { throw new Error('item JSON routes are closed'); },
    async (url) => {
      const page = pages[url];
      if (!page) throw new Error(`Unexpected page request: ${url}`);
      return page;
    },
    undefined,
    (path) => paths.push(path),
  );

  const live = await adapter.fetchDetail('https://www.vinted.pl/items/40203315928');
  assert.deepEqual(live.availability, { status: 'live' });
  assert.equal(live.listing?.price, 149);
  assert.equal(live.listing?.condition, 'Używane');
  assert.equal(live.listing?.listingId, '40203315928-lego-technic-porsche');
  assert.deepEqual(paths, ['vinted-item-page']);

  const sold = await adapter.fetchDetail('https://www.vinted.pl/items/40203315929');
  assert.equal(sold.availability.status, 'terminal');
  assert.equal(sold.listing, undefined);

  const removed = await adapter.fetchDetail('https://www.vinted.pl/items/40203315930');
  assert.deepEqual(removed.availability, { status: 'terminal', reason: 'Marketplace returned HTTP 404' });
  assert.equal((await adapter.fetchDetail('https://www.vinted.pl/items/40203315931')).availability.status, 'unknown');
  assert.equal((await adapter.fetchDetail('https://www.vinted.pl/items/40203315932')).availability.status, 'unknown');
  assert.equal(parseVintedItemPageAvailability(itemHtml).status, 'live');
  assert.equal(parseVintedItemPageAvailability('', 503).status, 'unknown');
});

test('enriches Allegro Lokalnie search conditions through the anonymous batch API', async () => {
  const cardHtml = `<article class="mlc-itembox__container" data-card-analytics-click="7e6a8b9c-1d2e-4f3a-9b8c-7d6e5f4a3b2c">
      <a href="/oferta/lego-technic-porsche" itemprop="url"><h3 itemprop="itemOffered">Lego Technic Porsche</h3></a>
      <span class="mlc-itembox__offer-type mlc-itembox__offer-type--buy_now">Kup teraz</span>
      <span class="ml-offer-price__dollars">149</span>
    </article>`;
  const requests: Array<{ url: string; body: string | null }> = [];
  const paths: string[] = [];
  const adapter = createAllegroLokalnieAdapter('Allegro Lokalnie', async () => cardHtml, async (url, body) => {
    requests.push({ url, body });
    return { status: 200, json: [{ item_id: 'lego-technic-porsche', item_variant: 'brand_new', item_name: 'Lego Technic Porsche', item_price: '149.00' }] };
  }, (path) => paths.push(path));
  const search = await adapter.fetchPublicSearch('https://allegrolokalnie.pl/oferty/q/lego?zrodlo=lokalnie');
  assert.equal(search.length, 1);
  assert.equal(search[0].condition, 'Nowe');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://allegrolokalnie.pl/api/additionaldata/offers');
  assert.deepEqual(JSON.parse(requests[0].body ?? '{}'), { offer_ids: ['7e6a8b9c-1d2e-4f3a-9b8c-7d6e5f4a3b2c'] });
  assert.deepEqual(paths, ['allegro-ssr-page', 'allegro-condition-batch']);
});

test('keeps Allegro Lokalnie search results when batch enrichment fails', async () => {
  const cardHtml = `<article class="mlc-itembox__container" data-card-analytics-click="7e6a8b9c-1d2e-4f3a-9b8c-7d6e5f4a3b2c">
      <a href="/oferta/lego-technic-porsche" itemprop="url"><h3 itemprop="itemOffered">Lego Technic Porsche</h3></a>
      <span class="mlc-itembox__offer-type mlc-itembox__offer-type--buy_now">Kup teraz</span>
      <span class="ml-offer-price__dollars">149</span>
    </article>`;
  const failingPaths: string[] = [];
  const failing = createAllegroLokalnieAdapter('Allegro Lokalnie', async () => cardHtml, async () => ({ status: 503, json: null }), (path) => failingPaths.push(path));
  const search = await failing.fetchPublicSearch('https://allegrolokalnie.pl/oferty/q/lego?zrodlo=lokalnie');
  assert.equal(search.length, 1);
  assert.equal(search[0].condition, undefined);
  assert.deepEqual(failingPaths, ['allegro-ssr-page']);
  const malformed = createAllegroLokalnieAdapter('Allegro Lokalnie', async () => cardHtml, async () => ({ status: 200, json: 'not-an-array' }));
  assert.equal((await malformed.fetchPublicSearch('https://allegrolokalnie.pl/oferty/q/lego')).length, 1);
  assert.deepEqual([...parseAllegroBatchEnrichmentApi([
    { item_id: 'a-slug', item_variant: 'visibly_used' },
    { item_id: 'b-slug', item_variant: 'Very_Good' },
    { item_id: 'c-slug', item_variant: 'unknown_variant' },
    'junk',
  ])], [['a-slug', 'Używane'], ['b-slug', 'Bardzo dobry']]);
});

test('merges Allegro JSON-LD search items with card uuids and shipping signals', () => {
  const jsonLd = `<script type="application/ld+json">${JSON.stringify({
    '@type': 'ItemList', itemListElement: [{ position: 1, item: {
      name: 'Lego Technic Porsche', image: { url: 'https://a.allegroimg.com/original/lego.jpg' },
      url: 'https://allegrolokalnie.pl/oferta/lego-technic-porsche',
      offers: { price: '149', priceCurrency: 'PLN' }, itemCondition: 'https://schema.org/NewCondition',
    } }],
  })}</script>`;
  const card = `<article class="mlc-itembox__container" data-card-analytics-click="7e6a8b9c-1d2e-4f3a-9b8c-7d6e5f4a3b2c">
      <a href="/oferta/lego-technic-porsche" itemprop="url"><h3 itemprop="itemOffered">Lego Technic Porsche</h3></a>
      <span class="mlc-itembox__offer-type mlc-itembox__offer-type--buy_now">Kup teraz</span>
      <span class="price-negotiability">Cena do negocjacji</span>
      <span class="ml-offer-price__dollars">149</span>
    </article>`;
  const listings = parseStructuredListings(`${jsonLd}${card}`, 'Allegro Lokalnie');
  assert.equal(listings.length, 1);
  assert.equal(listings[0].listingId, '7e6a8b9c-1d2e-4f3a-9b8c-7d6e5f4a3b2c');
  assert.equal(listings[0].condition, 'Nowe');
  assert.equal(listings[0].shippingAvailable, true);
  assert.equal(listings[0].priceNegotiable, true);
  assert.equal(listings[0].imageUrl, 'https://a.allegroimg.com/original/lego.jpg');
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

test('excludes Allegro Lokalnie auctions that otherwise leak through the JSON-LD ItemList', () => {
  const jsonLd = `<script type="application/ld+json">${JSON.stringify({
    '@type': 'ItemList', itemListElement: [
      { position: 1, item: { name: 'Steam Deck buy now', url: 'https://allegrolokalnie.pl/oferta/steam-deck-buy', offers: { price: '1200' } } },
      { position: 2, item: { name: 'Steam Deck auction', url: 'https://allegrolokalnie.pl/oferta/steam-deck-auction', offers: { price: '900' } } },
    ],
  })}</script>`;
  const cards = `
    <article class="mlc-itembox__container" data-card-analytics-click="buy-1">
      <a href="/oferta/steam-deck-buy" itemprop="url"><h3 itemprop="itemOffered">Steam Deck buy now</h3></a>
      <span class="mlc-itembox__offer-type mlc-itembox__offer-type--buy_now">Kup teraz</span>
      <span class="ml-offer-price__dollars">1 200</span>
    </article>
    <article class="mlc-itembox__container" data-card-analytics-click="auction-1">
      <a href="/oferta/steam-deck-auction" itemprop="url"><h3 itemprop="itemOffered">Steam Deck auction</h3></a>
      <span class="mlc-itembox__offer-type mlc-itembox__offer-type--bidding">Licytacja</span>
      <span class="ml-offer-price__dollars">900</span>
    </article>`;
  const listings = parseStructuredListings(`${jsonLd}${cards}`, 'Allegro Lokalnie');
  assert.deepEqual(listings.map((listing) => listing.url), ['https://allegrolokalnie.pl/oferta/steam-deck-buy']);
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

test('matches joined model tokens and unit spellings', () => {
  const base = { marketplace: 'OLX' as const, price: 100, currency: 'PLN' as const, url: 'https://www.olx.pl/d/oferta/test', observedAt: new Date().toISOString(), shippingAvailable: null as boolean | null };
  const listings = [
    { ...base, listingId: '1', title: 'iPhone 13 Pro 128 GB' },
    { ...base, listingId: '2', title: 'Karta RTX3080 10GB' },
    { ...base, listingId: '3', title: 'iPhone 13 Pro 128gb' },
  ];
  assert.deepEqual(filterListings(listings, '128gb', '', '').map((listing) => listing.listingId), ['1', '3']);
  assert.deepEqual(filterListings(listings, '128 gb', '', '').map((listing) => listing.listingId), ['1', '3']);
  assert.deepEqual(filterListings(listings, 'rtx 3080', '', '').map((listing) => listing.listingId), ['2']);
});

test('drops query stopwords but keeps single-digit models on token boundaries', () => {
  const base = { marketplace: 'OLX' as const, price: 100, currency: 'PLN' as const, url: 'https://www.olx.pl/d/oferta/test', observedAt: new Date().toISOString(), shippingAvailable: null as boolean | null };
  const listings = [
    { ...base, listingId: '1', title: 'Dysk SSD 1TB do laptopa' },
    { ...base, listingId: '2', title: 'iPhone 5 16GB' },
    { ...base, listingId: '3', title: 'iPhone 15 128GB' },
  ];
  assert.deepEqual(filterListings(listings, 'ssd for laptop', '', '').map((listing) => listing.listingId), ['1']);
  assert.deepEqual(filterListings(listings, 'iphone 5', '', '').map((listing) => listing.listingId), ['2']);
});

test('relaxes the implicit query terms only for opt-in manual searches', () => {
  const base = { marketplace: 'OLX' as const, price: 100, currency: 'PLN' as const, url: 'https://www.olx.pl/d/oferta/test', observedAt: new Date().toISOString(), shippingAvailable: null as boolean | null };
  const listings = [
    { ...base, listingId: '1', title: 'iPhone 13 Pro' },
    { ...base, listingId: '2', title: 'iPhone 13 Pro uszkodzony' },
  ];
  assert.deepEqual(filterListings(listings, 'iphone 13 pro max', '', '').map((listing) => listing.listingId), []);
  assert.deepEqual(filterListings(listings, 'iphone 13 pro max', '', '', { relaxTerms: true }).map((listing) => listing.listingId), ['1', '2']);
  assert.deepEqual(filterListings(listings, 'iphone 13 pro max', '', 'uszkodzony', { relaxTerms: true }).map((listing) => listing.listingId), ['1']);
  // Explicit included terms are a hard requirement and never relax.
  assert.deepEqual(filterListings(listings, 'iphone 13 pro max', 'iphone,13,pro,max', '', { relaxTerms: true }).map((listing) => listing.listingId), []);
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
