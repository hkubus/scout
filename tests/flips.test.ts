import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase } from '../server/db';
import sharp from 'sharp';
import { FlipStore, MAX_FLIP_PHOTO_EDGE, MAX_FLIP_PHOTOS, sniffImageMime, toWebp } from '../server/flips';
import { ServiceError } from '../server/service';
import type { PurchaseScreenshotReading } from '../server/vision';
import { DEFAULT_FEE_PRESETS, listingConditionFromLabel, roundToNines, suggestedListingPrice, estimateFlipNet, flipNet, normalizeFeePresets, quarterOf, saleFee, salesRecord, salesRecordCsv } from '../src/profit';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'scout-flips-'));
  const db = openDatabase(join(directory, 'scout.sqlite'));
  const events: unknown[] = [];
  const store = new FlipStore(db, (payload) => events.push(payload));
  return { db, store, events, close: () => { db.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test('profit maths: fees, realised net and forward estimates', () => {
  assert.equal(saleFee(1000, DEFAULT_FEE_PRESETS['Allegro Lokalnie']), 49);
  assert.equal(saleFee(300, { percent: 0, fixed: 0 }), 0);
  assert.equal(saleFee(299.99, { percent: 4.9, fixed: 1 }), 15.7);
  assert.equal(flipNet({ buyPrice: 1000, buyCosts: 25, salePrice: null, saleFee: null, saleCosts: null }), null);
  // 1 000 zł Vinted buy resold for 1 300 zł on Lokalnie Elektronika.
  assert.equal(flipNet({ buyPrice: 1000, buyCosts: 0, salePrice: 1300, saleFee: 63.7, saleCosts: 0 }), 236.3);
  assert.deepEqual(estimateFlipNet({ buyPrice: 220, buyCosts: 12, resalePrice: 300, preset: DEFAULT_FEE_PRESETS['Allegro Lokalnie'] }), { fee: 14.7, net: 53.3 });
  assert.deepEqual(quarterOf('2026-09-30'), { year: 2026, quarter: 3 });
  assert.deepEqual(quarterOf('2026-10-01'), { year: 2026, quarter: 4 });
  const presets = normalizeFeePresets({ OLX: { percent: 8, fixed: 0 }, Vinted: { percent: -1, fixed: 'x' }, Bogus: { percent: 1 } });
  assert.deepEqual(presets.OLX, { percent: 8, fixed: 0 });
  assert.deepEqual(presets.Vinted, DEFAULT_FEE_PRESETS.Vinted);
  assert.equal('Bogus' in presets, false);
});

test('the sales record has one row per day and a running total that restarts each quarter', () => {
  const sales = [
    { soldOn: '2026-06-30', salePrice: 999 },
    { soldOn: '2026-07-02', salePrice: 300 },
    { soldOn: '2026-07-02', salePrice: 250.5 },
    { soldOn: '2026-08-15', salePrice: 400 },
    { soldOn: null, salePrice: null },
    { soldOn: '2026-10-01', salePrice: 100 },
  ];
  const rows = salesRecord(sales, 2026, 3);
  assert.deepEqual(rows, [
    { index: 1, date: '2026-07-02', daySales: 550.5, quarterToDate: 550.5 },
    { index: 2, date: '2026-08-15', daySales: 400, quarterToDate: 950.5 },
  ]);
  assert.equal(salesRecordCsv(rows).split('\r\n')[1], '1;2026-07-02;550,50;550,50');
  assert.deepEqual(salesRecord(sales, 2026, 4).map((row) => row.quarterToDate), [100]);
});

test('recording a sale fixes the fee from the preset at that moment', () => {
  const context = fixture();
  try {
    const flip = context.store.create({ title: 'RTX 3070', buyChannel: 'OLX', boughtOn: '2026-09-01', buyPrice: 1000, buyCosts: 20, listedOn: ['OLX', 'Allegro Lokalnie', 'Vinted'] });
    assert.deepEqual([flip.soldOn, flip.salePrice, flip.listedOn], [null, null, ['OLX', 'Allegro Lokalnie', 'Vinted']]);
    const sold = context.store.update(flip.id, { soldOn: '2026-09-20', saleChannel: 'Allegro Lokalnie', salePrice: 1300, saleCosts: 0, delisted: ['OLX'] });
    assert.equal(sold.saleFee, 63.7);
    assert.equal(flipNet(sold), 216.3);
    assert.deepEqual(sold.delisted, ['OLX']);
    // Later preset edits do not rewrite recorded sales.
    context.store.setFeePresets({ ...DEFAULT_FEE_PRESETS, 'Allegro Lokalnie': { percent: 7.9, fixed: 0 } });
    assert.equal(context.store.get(flip.id).saleFee, 63.7);
    // Editing only the costs keeps the fee; changing the price re-derives it.
    assert.equal(context.store.update(flip.id, { saleCosts: 15 }).saleFee, 63.7);
    assert.equal(context.store.update(flip.id, { salePrice: 1000 }).saleFee, 79);
    // An entered fee wins over the preset.
    assert.equal(context.store.update(flip.id, { saleFee: 50 }).saleFee, 50);
    const unsold = context.store.update(flip.id, { soldOn: null });
    assert.deepEqual([unsold.soldOn, unsold.saleChannel, unsold.salePrice, unsold.saleFee, unsold.delisted], [null, null, null, null, []]);
    assert.ok(context.events.length >= 5);
  } finally { context.close(); }
});

test('flip updates reject incomplete or impossible sales and unknown ids', () => {
  const context = fixture();
  try {
    const flip = context.store.create({ title: 'CPU', buyChannel: 'Vinted', boughtOn: '2026-09-10', buyPrice: 300 });
    const rejects = (patch: Parameters<FlipStore['update']>[1], pattern: RegExp) => assert.throws(() => context.store.update(flip.id, patch), (error: unknown) => error instanceof ServiceError && error.status === 400 && pattern.test(error.message));
    rejects({ soldOn: '2026-09-12' }, /date, a channel and a price/);
    rejects({ salePrice: 400 }, /Set the sale date/);
    rejects({ soldOn: '2026-09-01', saleChannel: 'OLX', salePrice: 400 }, /before the purchase date/);
    assert.throws(() => context.store.update(9999, { title: 'x' }), (error: unknown) => error instanceof ServiceError && error.status === 404);
    assert.throws(() => context.store.delete(9999), (error: unknown) => error instanceof ServiceError && error.status === 404);
    context.store.delete(flip.id);
    assert.equal(context.store.list().flips.length, 0);
    assert.deepEqual(context.store.list().feePresets, DEFAULT_FEE_PRESETS);
  } finally { context.close(); }
});

const image = (width: number, height: number) => sharp({ create: { width, height, channels: 3, background: { r: 200, g: 40, b: 40 } } });

test('listing drafts and photos are stored per flip as WebP, checked by their bytes, and ordered', async () => {
  const context = fixture();
  const JPEG = await image(40, 30).jpeg().toBuffer();
  const PNG = await image(30, 40).png().toBuffer();
  try {
    const flip = context.store.create({ title: 'RTX 3070', buyChannel: 'Vinted', boughtOn: '2026-09-28', buyPrice: 1150 });
    assert.equal(flip.listing, null);
    assert.deepEqual(flip.photos, []);
    const listing = { title: 'Gigabyte RTX 3070 Eagle OC 8GB', description: 'Sprawna, bez kopania.', condition: 'good' as const, prices: { OLX: 1450, 'Allegro Lokalnie': 1525 }, basePrice: 1450 };
    assert.deepEqual(context.store.setListing(flip.id, listing).listing, listing);

    const first = await context.store.addPhoto(flip.id, JPEG);
    const second = await context.store.addPhoto(flip.id, PNG);
    assert.deepEqual([first.mime, second.mime], ['image/webp', 'image/webp']);
    assert.deepEqual(context.store.get(flip.id).photos.map((photo) => photo.id), [first.id, second.id]);
    assert.deepEqual(context.store.orderPhotos(flip.id, [second.id, first.id]).photos.map((photo) => photo.id), [second.id, first.id]);
    assert.throws(() => context.store.orderPhotos(flip.id, [first.id]), /exactly once/);
    const stored = context.store.photo(first.id)!;
    assert.equal(sniffImageMime(stored.data), 'image/webp');
    assert.equal(stored.data.byteLength, first.byteSize);
    assert.deepEqual(await sharp(stored.data).metadata().then(({ width, height }) => [width, height]), [40, 30]);
    assert.equal(context.store.list().flips[0].photos.length, 2);

    // Declared types are never trusted: HTML or SVG is refused by content.
    await assert.rejects(context.store.addPhoto(flip.id, new TextEncoder().encode('<svg onload=alert(1)>')), (error: unknown) => error instanceof ServiceError && error.status === 415);
    // Bytes that only look like a JPEG are refused when decoding.
    await assert.rejects(context.store.addPhoto(flip.id, new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46])), (error: unknown) => error instanceof ServiceError && error.status === 415);
    assert.equal(sniffImageMime(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 ')), 'image/webp');
    for (let index = 2; index < MAX_FLIP_PHOTOS; index += 1) await context.store.addPhoto(flip.id, JPEG);
    await assert.rejects(context.store.addPhoto(flip.id, JPEG), /at most 20 photos/);

    context.store.deletePhoto(first.id);
    assert.equal(context.store.get(flip.id).photos.length, MAX_FLIP_PHOTOS - 1);
    assert.throws(() => context.store.deletePhoto(first.id), (error: unknown) => error instanceof ServiceError && error.status === 404);
    context.store.delete(flip.id);
    assert.equal((context.db.prepare('SELECT COUNT(*) AS count FROM flip_photos').get() as { count: number }).count, 0);
    assert.equal(context.store.setListing(context.store.create({ title: 'x', buyChannel: 'OLX', boughtOn: '2026-09-01', buyPrice: 1 }).id, null).listing, null);
  } finally { context.close(); }
});

test('photos are turned upright, shrunk to the size limit, and older ones converted to WebP', async () => {
  // A phone photo stored sideways with an EXIF rotation, larger than the limit.
  const sideways = await image(3000, 1500).jpeg().withMetadata({ orientation: 6 }).toBuffer();
  const upright = await sharp(await toWebp(sideways)).metadata();
  assert.equal(upright.format, 'webp');
  assert.deepEqual([upright.width, upright.height], [MAX_FLIP_PHOTO_EDGE / 2, MAX_FLIP_PHOTO_EDGE]);
  assert.equal(upright.orientation, undefined);
  // A small WebP is kept byte for byte.
  const small = await image(20, 20).webp().toBuffer();
  assert.deepEqual(await toWebp(small), small);

  const context = fixture();
  try {
    const flip = context.store.create({ title: 'Lampa', buyChannel: 'OLX', boughtOn: '2026-09-28', buyPrice: 50 });
    const png = await image(10, 10).png().toBuffer();
    const insert = context.db.prepare('INSERT INTO flip_photos (flip_id, position, mime, data, byte_size, created_at) VALUES (?, ?, ?, ?, ?, ?)');
    const old = Number(insert.run(flip.id, 0, 'image/png', png, png.byteLength, '2026-09-28T10:00:00Z').lastInsertRowid);
    const broken = Number(insert.run(flip.id, 1, 'image/jpeg', Buffer.from([0xff, 0xd8, 0xff]), 3, '2026-09-28T10:00:00Z').lastInsertRowid);
    assert.equal(await context.store.convertStoredPhotosToWebp(), 1);
    assert.equal(context.store.photo(old)!.mime, 'image/webp');
    assert.equal(sniffImageMime(context.store.photo(old)!.data), 'image/webp');
    assert.equal(context.store.photo(broken)!.mime, 'image/jpeg', 'an unreadable photo is left alone');
    assert.equal(await context.store.convertStoredPhotosToWebp(), 0);
  } finally { context.close(); }
});

test('prices round to the nearest 9,99 and marketplace condition labels map to Scout conditions', () => {
  assert.equal(roundToNines(1450), 1449.99);
  assert.equal(roundToNines(1525), 1529.99);
  assert.equal(roundToNines(134.99), 139.99);
  assert.equal(roundToNines(129.99), 129.99);
  assert.equal(roundToNines(5), 9.99);
  assert.equal(roundToNines(4), 4, 'no 9,99 price is near enough');
  const labels: Array<[string | null, string | null]> = [
    ['Nowe', 'new'], ['Nowy', 'new'], ['Nowy bez metki', 'new'], ['Nowy z metką', 'new-with-tags'],
    ['Bardzo dobry', 'like-new'], ['Używany - jak nowy', 'like-new'], ['Używane', 'good'], ['Dobry', 'good'],
    ['Uszkodzone', 'damaged'], ['Zadowalający', 'damaged'], ['Used', 'good'], ['', null], [null, null], ['Inne', null],
  ];
  for (const [label, condition] of labels) assert.equal(listingConditionFromLabel(label), condition, String(label));
});

test('suggested listing prices leave the same amount on every platform', () => {
  assert.equal(suggestedListingPrice(1450, DEFAULT_FEE_PRESETS.OLX), 1450);
  assert.equal(suggestedListingPrice(1450, DEFAULT_FEE_PRESETS['Allegro Lokalnie']), 1525);
  assert.equal(suggestedListingPrice(300, { percent: 8, fixed: 2 }), 329);
  assert.equal(suggestedListingPrice(0, DEFAULT_FEE_PRESETS.OLX), null);
  assert.equal(suggestedListingPrice(100, { percent: 100, fixed: 0 }), null);
});

test('a resale draft starts from the saved original listing and falls back to its text', async () => {
  const { ScoutService } = await import('../server/service');
  const directory = mkdtempSync(join(tmpdir(), 'scout-resale-draft-'));
  const db = openDatabase(join(directory, 'scout.sqlite'));
  const previousKey = process.env.SCOUT_OPENROUTER_API_KEY;
  process.env.SCOUT_OPENROUTER_API_KEY = 'test-key';
  const seen: Array<{ title: string; description: string | null }> = [];
  let fail = false;
  let fetched = 0;
  let answerCondition: 'good' | null = 'good';
  const service = new ScoutService(db, () => {}, {
    writeResaleListing: async (context) => {
      seen.push({ title: context.title, description: context.description });
      if (fail) throw new Error('provider down');
      return { title: 'Sony WH-1000XM4 słuchawki', description: 'Sprzedam słuchawki.\n- etui w zestawie', condition: answerCondition, category: 'Słuchawki' };
    },
    fetchListingDetailHtml: async () => { fetched += 1; throw new Error('offline'); },
  });
  try {
    const now = new Date().toISOString();
    const saved = db.prepare('INSERT INTO listings (marketplace, listing_id, title, price_pln, url, condition, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('OLX', 'a1', 'Sony WH-1000XM4 okazja', 500, 'https://www.olx.pl/d/oferta/a1', 'Uszkodzone', now, now);
    db.prepare(`INSERT INTO listing_detail_snapshots (listing_id, marketplace, external_listing_id, title, price_pln, url, description, state_hash, captured_at)
      VALUES (?, 'OLX', 'a1', 'Sony WH-1000XM4 okazja', 500, 'https://www.olx.pl/d/oferta/a1', ?, 'h1', ?)`).run(saved.lastInsertRowid, 'Etui w zestawie. Odbiór Kraków, tel 600100200.', now);

    const { draft: written, images: none } = await service.draftResaleListing('OLX:a1');
    assert.deepEqual(none, [], 'photos are only fetched when asked for');
    assert.equal(written.method, 'ai');
    assert.equal(written.condition, 'good');
    assert.equal(written.category, 'Słuchawki');
    assert.equal(written.source!.description, 'Etui w zestawie. Odbiór Kraków, tel 600100200.');
    assert.deepEqual(seen[0], { title: 'Sony WH-1000XM4 okazja', description: 'Etui w zestawie. Odbiór Kraków, tel 600100200.' });
    assert.equal(fetched, 0, 'a saved description is used without fetching the page');

    // When AI can't tell the condition, the original's own label decides.
    answerCondition = null;
    assert.equal((await service.draftResaleListing('OLX:a1')).draft.condition, 'damaged');

    // A flip not bought through Scout is written from the operator's notes.
    const fromNotes = await service.draftResaleListingFromNotes({ title: 'Słuchawki Sony', notes: 'Etui, kabel.', condition: 'good' });
    assert.equal(fromNotes.source, null);
    assert.deepEqual(seen.at(-1), { title: 'Słuchawki Sony', description: 'Etui, kabel.' });

    fail = true;
    await assert.rejects(service.draftResaleListingFromNotes({ title: 'x', notes: '', condition: null }), (error: unknown) => error instanceof ServiceError && error.status === 502);
    const { draft: copied } = await service.draftResaleListing('OLX:a1');
    assert.equal(copied.method, 'copy');
    assert.equal(copied.condition, 'damaged', 'a copied draft keeps the original condition');
    assert.equal(copied.description, 'Etui w zestawie. Odbiór Kraków, tel 600100200.');

    // Without a saved description the live page is tried; a failure still drafts.
    db.prepare('INSERT INTO listings (marketplace, listing_id, title, price_pln, url, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('Vinted', 'v1', 'Kurtka Patagonia M', 200, 'https://www.vinted.pl/items/v1', now, now);
    const { draft: bare } = await service.draftResaleListing('Vinted:v1');
    assert.equal(fetched, 1);
    assert.equal(bare.description, '');
    assert.equal(bare.title, 'Kurtka Patagonia M');

    // When the original page is gone, the search thumbnail is the photo; the
    // page is fetched once for both the description and the gallery.
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    db.prepare('INSERT INTO listings (marketplace, listing_id, title, price_pln, url, image_url, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('OLX', 'p1', 'Lampa', 90, 'https://www.olx.pl/d/oferta/p1', 'https://ireland.apollo.olxcdn.com/v1/files/p1/image', now, now);
    const realFetch = globalThis.fetch;
    const requested: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      requested.push(String(input));
      return new Response(png, { status: 200, headers: { 'content-type': 'image/png' } });
    }) as typeof fetch;
    try {
      const { images } = await service.draftResaleListing('OLX:p1', { photos: true });
      assert.equal(images.length, 1);
      assert.equal(images[0].mime, 'image/png');
      assert.deepEqual(requested, ['https://ireland.apollo.olxcdn.com/v1/files/p1/image']);
      assert.equal(fetched, 2);
    } finally {
      globalThis.fetch = realFetch;
    }

    await assert.rejects(service.draftResaleListing('OLX:missing'), (error: unknown) => error instanceof ServiceError && error.status === 404);
  } finally {
    if (previousKey === undefined) delete process.env.SCOUT_OPENROUTER_API_KEY;
    else process.env.SCOUT_OPENROUTER_API_KEY = previousKey;
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('an offer page is read from its own product data, never from other offers on it', async () => {
  const { parseOfferPage } = await import('../server/marketplaces');
  const productPage = `<script type="application/ld+json">{"@type":"ItemList","itemListElement":[{"@type":"ListItem","name":"Inna oferta","offers":{"price":"10"}}]}</script>
    <script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"RTX 3070 &amp; pudełko","offers":{"@type":"Offer","price":"1 199,99","priceCurrency":"PLN","itemCondition":"https://schema.org/UsedCondition"}}</script>`;
  assert.deepEqual(parseOfferPage(productPage), { title: 'RTX 3070 & pudełko', price: 1199.99, condition: 'Używane', currency: 'PLN' });
  const metaPage = '<meta property="og:title" content="Kurtka Patagonia M | Vinted"><meta property="product:price:amount" content="250.00"><meta property="product:price:currency" content="PLN">';
  assert.deepEqual(parseOfferPage(metaPage), { title: 'Kurtka Patagonia M', price: 250, condition: null, currency: 'PLN' });
  assert.equal(parseOfferPage('<meta property="og:title" content="Jacka"><meta property="product:price:amount" content="300"><meta property="product:price:currency" content="SEK">')!.price, null, 'a foreign price is not read as złoty');
  assert.equal(parseOfferPage('<html><body>blocked</body></html>'), null);
});

test('a flip is prefilled from an offer link: a tracked listing first, else the live page', async () => {
  const { ScoutService } = await import('../server/service');
  const directory = mkdtempSync(join(tmpdir(), 'scout-flip-import-'));
  const db = openDatabase(join(directory, 'scout.sqlite'));
  const pages: string[] = [];
  const service = new ScoutService(db, () => {}, {
    fetchListingDetailHtml: async (url) => {
      pages.push(url);
      return '<script type="application/ld+json">{"@type":"Product","name":"Słuchawki Sony WH-1000XM4","offers":{"price":420,"priceCurrency":"PLN"}}</script>';
    },
  });
  try {
    const now = new Date().toISOString();
    db.prepare('INSERT INTO listings (marketplace, listing_id, title, price_pln, url, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('OLX', '9001', 'RTX 3070 Eagle', 1100, 'https://www.olx.pl/d/oferta/rtx-3070-CID99-ID1abc.html?reason=extended', now, now);
    const tracked = await service.importFlipFromUrl(' https://www.olx.pl/d/oferta/rtx-3070-CID99-ID1abc.html#gallery ');
    assert.equal(tracked.method, 'scout');
    assert.equal(tracked.listingKey, 'OLX:9001', 'a tracked listing is linked so its resale draft can use it');
    assert.deepEqual([tracked.title, tracked.buyChannel, tracked.buyPrice, tracked.boughtOn], ['RTX 3070 Eagle', 'OLX', 1100, null]);
    assert.equal(tracked.url, 'https://www.olx.pl/d/oferta/rtx-3070-CID99-ID1abc.html', 'the link is kept without tracking parameters');
    assert.equal(pages.length, 0, 'a tracked listing needs no page fetch');

    const live = await service.importFlipFromUrl('https://www.vinted.pl/items/123-sluchawki');
    assert.equal(live.method, 'page');
    assert.deepEqual([live.title, live.buyChannel, live.buyPrice, live.listingKey], ['Słuchawki Sony WH-1000XM4', 'Vinted', 420, null]);
    assert.deepEqual(pages, ['https://www.vinted.pl/items/123-sluchawki']);

    await assert.rejects(service.importFlipFromUrl('https://allegro.pl/oferta/123'), (error: unknown) => error instanceof ServiceError && error.status === 400 && /OLX, Allegro Lokalnie or Vinted/.test(error.message));
    await assert.rejects(service.importFlipFromUrl('http://www.olx.pl/d/oferta/x'), (error: unknown) => error instanceof ServiceError && error.status === 400);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a flip is prefilled from a purchase screenshot read by the vision model', async () => {
  const { ScoutService } = await import('../server/service');
  const directory = mkdtempSync(join(tmpdir(), 'scout-flip-screenshot-'));
  const db = openDatabase(join(directory, 'scout.sqlite'));
  const previousKey = process.env.SCOUT_OPENROUTER_API_KEY;
  const seen: Array<{ imageDataUrl: string; today: string }> = [];
  let reading: PurchaseScreenshotReading = { isPurchase: true, platform: 'Vinted', title: 'Kurtka Patagonia M', itemPrice: 180, extraCosts: 16.49, currency: 'PLN', date: '2026-10-05' };
  const service = new ScoutService(db, () => {}, {
    readPurchaseScreenshot: async (input) => { seen.push(input); return reading; },
  });
  const png = await sharp({ create: { width: 40, height: 80, channels: 3, background: '#fff' } }).png().toBuffer();
  const today = new Date(2026, 9, 7, 12);
  try {
    delete process.env.SCOUT_OPENROUTER_API_KEY;
    await assert.rejects(service.importFlipFromScreenshot(png, today), (error: unknown) => error instanceof ServiceError && error.status === 409);
    process.env.SCOUT_OPENROUTER_API_KEY = 'test-key';

    const result = await service.importFlipFromScreenshot(png, today);
    assert.deepEqual(
      [result.method, result.title, result.buyChannel, result.buyPrice, result.buyCosts, result.boughtOn, result.listingKey, result.warnings],
      ['screenshot', 'Kurtka Patagonia M', 'Vinted', 180, 16.49, '2026-10-05', null, []],
    );
    assert.equal(seen[0].today, '2026-10-07');
    assert.match(seen[0].imageDataUrl, /^data:image\/webp;base64,/);

    reading = { ...reading, platform: null, currency: 'EUR', date: '2026-12-01' };
    const foreign = await service.importFlipFromScreenshot(png, today);
    assert.deepEqual([foreign.buyChannel, foreign.buyPrice, foreign.buyCosts, foreign.boughtOn], ['Other', null, null, null], 'foreign prices and future dates are left for the operator');
    assert.equal(foreign.warnings.length, 2);

    reading = { ...reading, title: null, itemPrice: null };
    await assert.rejects(service.importFlipFromScreenshot(png, today), (error: unknown) => error instanceof ServiceError && error.status === 422);
    await assert.rejects(service.importFlipFromScreenshot(Buffer.from('not an image'), today), (error: unknown) => error instanceof ServiceError && error.status === 415);
  } finally {
    if (previousKey === undefined) delete process.env.SCOUT_OPENROUTER_API_KEY;
    else process.env.SCOUT_OPENROUTER_API_KEY = previousKey;
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the purchase reader sends the screenshot and tidies what the model returns', async () => {
  const { readPurchaseScreenshotWithVision } = await import('../server/vision');
  let body: any;
  const fetcher = (async (_url: string, init: RequestInit) => {
    body = JSON.parse(String(init.body));
    const content = JSON.stringify({ isPurchase: true, platform: 'allegro lokalnie', title: '  Lampa   biurkowa ', itemPrice: '89,99', extraCosts: 0, currency: 'zł', date: '2026-02-30x' });
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
  }) as unknown as typeof fetch;
  const reading = await readPurchaseScreenshotWithVision({ imageDataUrl: 'data:image/webp;base64,AAAA', today: '2026-10-07' }, { apiKey: 'k', model: 'vision/test' }, fetcher);
  assert.deepEqual(reading, { isPurchase: true, platform: 'Allegro Lokalnie', title: 'Lampa biurkowa', itemPrice: 89.99, extraCosts: 0, currency: 'PLN', date: null });
  assert.equal(body.model, 'vision/test');
  assert.deepEqual(body.messages[1].content[1], { type: 'image_url', image_url: { url: 'data:image/webp;base64,AAAA' } });
});
