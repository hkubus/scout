import test from 'node:test';
import assert from 'node:assert/strict';
import {
  allegroSellerProfileUrl, createOlxJsonAdapter, createVintedJsonAdapter, normalizeSellerId, olxSellerListingsUrl, parseAllegroOfferSeller,
  parseAllegroSellerProfile, parseOlxOfferSeller, parseOlxOffersApi, parseOlxSellerListings, parseSearchPage, parseVintedCatalogApi,
  parseVintedItemPageAvailability, parseVintedItemSeller, parseVintedPageSignals, parseVintedWardrobe, vintedWardrobeUrl,
} from '../server/marketplaces';
import { priceDrops, titleSimilarity } from '../server/negotiation';

// Synthetic payloads in the shapes the marketplaces send (checked against
// live pages on 2026-10-16); no real names, ids or messages.
function olxOffer(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id, url: `https://www.olx.pl/d/oferta/test-CID99-ID${id}.html`, title: `Test offer ${id}`, status: 'active', business: false,
    created_time: '2026-10-01T10:00:00+02:00', description: '<p>Stan dobry.</p>',
    params: [{ key: 'price', value: { value: 500, currency: 'PLN', negotiable: true } }, { key: 'state', value: { label: 'Używane' } }],
    user: { id: 1001, name: 'Seller A', uuid: 'u-1', other_ads_enabled: true }, ...overrides,
  };
}

test('seller ids are numeric or Client ids, never free text', () => {
  assert.deepEqual([1001, '1001', 'Client:42', ' 7 ', 'a b', '', 1.5, null, '<x>'].map(normalizeSellerId), ['1001', '1001', 'Client:42', '7', null, null, null, null, null]);
});

test('OLX search and detail offers carry the seller', () => {
  const [listing] = parseOlxOffersApi({ data: [olxOffer(11)], metadata: { visible_total_count: 1 } });
  assert.equal(listing.sellerId, '1001');
  assert.deepEqual(parseOlxOfferSeller(olxOffer(11, { business: true })), { id: '1001', name: 'Seller A', type: 'business' });
  assert.equal(parseOlxOfferSeller(olxOffer(11, { user: undefined })), null);
  assert.equal(olxSellerListingsUrl('1001', 11), 'https://www.olx.pl/api/v1/offers/?offset=0&limit=11&user_id=1001');
  const page = parseOlxSellerListings({ data: [olxOffer(11), olxOffer(12)], metadata: { total_elements: 5, visible_total_count: 2 } });
  assert.deepEqual([page.listings.map((item) => item.listingId), page.total], [['11', '12'], 5]);
});

test('the OLX detail adapter returns the seller and description of a live offer only', async () => {
  const live = createOlxJsonAdapter('OLX', async () => ({ status: 200, json: { data: olxOffer(11) } }));
  const detail = await live.fetchDetail('https://www.olx.pl/d/oferta/test-CID99-ID11.html', { listingId: '11' });
  assert.deepEqual([detail.availability, detail.listing?.price, detail.description, detail.seller?.id], [{ status: 'live' }, 500, 'Stan dobry.', '1001']);
  const gone = createOlxJsonAdapter('OLX', async () => ({ status: 404, json: { error: { detail: 'Not found' } } }));
  const ended = await gone.fetchDetail('https://www.olx.pl/d/oferta/test-CID99-ID11.html', { listingId: '11' });
  assert.equal(ended.availability.status, 'terminal');
  assert.equal(ended.seller, undefined);
});

test('Vinted catalog cards, API items and item pages carry the seller', () => {
  const escaped = '<script>self.__next_f.push([1,"{\\"productItem\\":{\\"id\\":501,\\"isPromoted\\":false,\\"user\\":{\\"id\\":2002,\\"photo\\":null,\\"isBusiness\\":false}}}"])</script>';
  assert.deepEqual(parseVintedPageSignals(escaped).get('501'), { promoted: false, sellerType: 'private', sellerId: '2002' });
  const [item] = parseVintedCatalogApi({ items: [{ id: 501, title: 'Test', price: { amount: '90.0', currency_code: 'PLN' }, url: 'https://www.vinted.pl/items/501-test', user: { id: 2002, business: false } }] });
  assert.equal(item.sellerId, '2002');
  assert.deepEqual(parseVintedItemSeller('{\\"itemId\\":501,\\"sellerId\\":2002}'), { id: '2002', name: null, type: null });
  assert.equal(parseVintedItemSeller('<a href="/member/2002-someone">')?.id, '2002');
  assert.equal(parseVintedItemSeller('<p>nothing</p>'), null);
});

test('Cloudflare\'s passive beacon does not make a Vinted item page look blocked', () => {
  const product = `<script type="application/ld+json">${JSON.stringify({ '@type': 'Product', name: 'Test', url: 'https://www.vinted.pl/items/501-test', offers: { price: '90', priceCurrency: 'PLN', availability: 'https://schema.org/InStock' } })}</script>`;
  const beacon = "<script>(function(){var a=document.createElement('script');a.src='/cdn-cgi/challenge-platform/scripts/jsd/main.js';})();</script>";
  assert.equal(parseVintedItemPageAvailability(`<html><body>${product}${beacon}<button>Kup teraz</button></body></html>`, 200).status, 'live');
  const challenge = '<html><body><script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1?ray=1"></script><p>Checking your browser before accessing the site.</p></body></html>';
  assert.equal(parseVintedItemPageAvailability(challenge, 200).status, 'unknown');
});

test('the Vinted wardrobe lists only items for sale, with the total', () => {
  const item = (id: number, flags: Record<string, boolean> = {}) => ({ id, title: `Item ${id}`, price: { amount: '50.0', currency_code: 'PLN' }, url: `https://www.vinted.pl/items/${id}-item`, status: 'Dobry', user: { id: 2002, business: false }, is_closed: false, is_hidden: false, is_reserved: false, is_draft: false, ...flags });
  const page = parseVintedWardrobe({ items: [item(1), item(2, { is_closed: true }), item(3, { is_reserved: true }), item(4, { is_hidden: true }), item(5)], pagination: { total_entries: 9 } });
  assert.deepEqual([page.listings.map((listing) => listing.listingId), page.total, page.listings[0].sellerId], [['1', '5'], 9, '2002']);
  assert.throws(() => parseVintedWardrobe({ code: 100 }), /did not contain items/);
  assert.equal(vintedWardrobeUrl('2002', 11), 'https://www.vinted.pl/api/v2/wardrobe/2002/items?page=1&per_page=11');
});

test('the Vinted item-page adapter returns the seller and description', async () => {
  const body = `<html><body><script type="application/ld+json">${JSON.stringify({ '@type': 'Product', name: 'Test', description: 'Opis testowy.', url: 'https://www.vinted.pl/items/501-test', offers: { price: '90', priceCurrency: 'PLN' } })}</script><script>{\\"sellerId\\":2002}</script><button>Kup teraz</button></body></html>`;
  const adapter = createVintedJsonAdapter('Vinted', async () => ({ status: 404, json: null }), async () => ({ status: 200, body }));
  const detail = await adapter.fetchDetail('https://www.vinted.pl/items/501-test');
  assert.deepEqual([detail.availability.status, detail.listing?.price, detail.description, detail.seller?.id], ['live', 90, 'Opis testowy.', '2002']);
});

test('Allegro Lokalnie offer pages name the seller by Client id; profiles list their offers', () => {
  const page = '<script>{&quot;location&quot;:{&quot;city&quot;:&quot;X&quot;},&quot;seller&quot;:{&quot;id&quot;:&quot;0000-uuid&quot;,&quot;name&quot;:&quot;Ala (Client:42)&quot;,&quot;type&quot;:&quot;individual&quot;}}</script><a href="/uzytkownik/Client%3A42">profil</a>';
  assert.deepEqual(parseAllegroOfferSeller(page), { id: 'Client:42', name: 'Ala', type: 'private' });
  assert.deepEqual(parseAllegroOfferSeller('<a href="/uzytkownik/Client%3A42">profil</a>'), { id: 'Client:42', name: null, type: null });
  assert.equal(parseAllegroOfferSeller('<p>none</p>'), null);
  assert.equal(allegroSellerProfileUrl('Client:42'), 'https://allegrolokalnie.pl/uzytkownik/Client%3A42');

  const profile = `<script type="application/ld+json">${JSON.stringify({ '@type': 'ItemList', itemListElement: [
    { position: 1, item: { name: 'Offer one', url: 'https://allegrolokalnie.pl/oferta/offer-one', offers: { price: '100' } } },
    { position: 2, item: { name: 'Offer two', url: 'https://allegrolokalnie.pl/oferta/offer-two', offers: { price: '200' } } },
  ] })}</script>`;
  const offers = parseAllegroSellerProfile(profile);
  assert.deepEqual([offers.listings.map((listing) => listing.url), offers.total], [parseSearchPage(profile, 'Allegro Lokalnie').map((listing) => listing.url), null]);
  assert.equal(offers.listings.length, 2);
});

test('price drops count each cut and ignore repeats', () => {
  const points = [
    { price: 2000, observedAt: '2026-10-01T00:00:00Z' }, { price: 2000, observedAt: '2026-10-02T00:00:00Z' },
    { price: 1900, observedAt: '2026-10-03T00:00:00Z' }, { price: 1950, observedAt: '2026-10-04T00:00:00Z' },
    { price: 1800, observedAt: '2026-10-05T00:00:00Z' },
  ];
  assert.deepEqual(priceDrops(points.slice().reverse()), { count: 2, total: 250, lastAt: '2026-10-05T00:00:00Z', firstPrice: 2000 });
  assert.deepEqual(priceDrops([]), { count: 0, total: 0, lastAt: null, firstPrice: null });
  assert.equal(titleSimilarity('iPhone 13 Pro 128GB grafitowy', 'Iphone 13 PRO 128 GB grafitowy'), 4 / 7);
  assert.equal(titleSimilarity('iPhone 13 Pro 128GB', 'iPhone 13 Pro 128GB!'), 1);
});
