import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase } from '../server/db';
import { ScoutService } from '../server/service';
import {
  DUPLICATE_SIMILARITY,
  duplicateSimilarity,
  findDuplicatePairs,
  normalizeTitleForMatch,
  type DuplicateCandidate,
} from '../server/duplicates';
import { crossPostChip } from '../src/listingSignals';
import type { CompactListingDetail } from '../src/types';

let nextId = 1;
function listing(marketplace: string, title: string, price: number, extra: Partial<DuplicateCandidate> = {}): DuplicateCandidate {
  return { id: nextId++, marketplace, title, price, ...extra };
}
const isDuplicate = (a: DuplicateCandidate, b: DuplicateCandidate) => duplicateSimilarity(a, b) >= DUPLICATE_SIMILARITY;

test('normalizes titles: folds Polish letters, drops filler and joins capacities', () => {
  assert.deepEqual(normalizeTitleForMatch('Sprzedam ŁÓŻECZKO dziecięce Klupś, stan idealny!'), ['lozeczk', 'dzieciec', 'klups']);
  assert.deepEqual(normalizeTitleForMatch('iPhone13 Pro 128 GB'), ['iphon', '13', 'pro', '128gb']);
  assert.deepEqual(normalizeTitleForMatch('iphone 13pro 128gb'), ['iphon', '13', 'pro', '128gb']);
  assert.deepEqual(normalizeTitleForMatch('RTX3080 Ti 10GB'), ['rtx', '3080', 'ti', '10gb']);
  // Polish "w" (in) is a word, not watts, when it stands alone.
  assert.deepEqual(normalizeTitleForMatch('Ładowarka 65W w pudełku'), ['ladowark', '65w', 'pudelk']);
  // Inflected forms share a stem; model words and short words stay whole.
  assert.deepEqual(normalizeTitleForMatch('napęd napędem czarny czarna biały białe'), ['naped', 'czarn', 'bial']);
  assert.deepEqual(normalizeTitleForMatch('Galaxy S23 Ultra mini slim'), ['galax', 's', '23', 'ultra', 'mini', 'slim']);
});

test('matches the same item cross-posted with the same or a paraphrased title', () => {
  const identical = [listing('OLX', 'Konsola Sony PlayStation 5 Slim z napędem', 1900), listing('Vinted', 'Konsola Sony PlayStation 5 Slim z napędem', 1900)];
  assert.ok(duplicateSimilarity(identical[0], identical[1]) >= 0.9);

  const paraphrased = [
    listing('OLX', 'Sprzedam iPhone 13 Pro 128 GB grafitowy, stan idealny', 2500, { condition: 'Używane', location: 'Mazowieckie, Warszawa, Mokotów' }),
    listing('Vinted', 'Iphone 13 pro 128gb grafitowy', 2450, { condition: 'Bardzo dobry' }),
  ];
  assert.ok(isDuplicate(paraphrased[0], paraphrased[1]));

  const diacritics = [
    listing('Allegro Lokalnie', 'Łóżeczko dziecięce Klupś Safari białe 120x60', 450, { location: 'Kraków' }),
    listing('OLX', 'Lozeczko dzieciece Klups Safari biale 120x60', 420, { location: 'Kraków, Podgórze' }),
  ];
  assert.ok(isDuplicate(diacritics[0], diacritics[1]));

  // A shorter title that leaves the capacity out still matches.
  const shorter = [listing('OLX', 'Samsung Galaxy S23 256GB czarny', 2100), listing('Vinted', 'Samsung Galaxy S23 czarny', 2100)];
  assert.ok(isDuplicate(shorter[0], shorter[1]));
});

test('scores closer prices and known equal conditions higher', () => {
  const base = listing('OLX', 'Nintendo Switch OLED biały komplet', 1000, { condition: 'Używane' });
  const same = listing('Vinted', 'Nintendo Switch OLED biały komplet', 1000, { condition: 'Dobry' });
  const dearer = listing('Vinted', 'Nintendo Switch OLED biały komplet', 1150, { condition: 'Dobry' });
  const unknownCondition = listing('Vinted', 'Nintendo Switch OLED biały komplet', 1000);
  assert.equal(duplicateSimilarity(base, same), 1);
  assert.ok(duplicateSimilarity(base, dearer) < duplicateSimilarity(base, same));
  assert.ok(duplicateSimilarity(base, unknownCondition) < duplicateSimilarity(base, same));
  assert.equal(duplicateSimilarity(base, same), duplicateSimilarity(same, base));
});

test('does not match near-misses', () => {
  const cases: Array<[string, DuplicateCandidate, DuplicateCandidate]> = [
    ['same marketplace', listing('OLX', 'Konsola Sony PlayStation 5 Slim', 1900), listing('OLX', 'Konsola Sony PlayStation 5 Slim', 1900)],
    ['other capacity', listing('OLX', 'iPhone 13 128GB niebieski', 1500), listing('Vinted', 'iPhone 13 256GB niebieski', 1550)],
    ['other model number', listing('OLX', 'Karta graficzna RTX 3080 Gigabyte', 2400), listing('Vinted', 'Karta graficzna RTX 3070 Gigabyte', 2400)],
    ['Pro against plain', listing('OLX', 'iPhone 13 Pro 128GB niebieski', 2000), listing('Vinted', 'iPhone 13 128GB niebieski', 2000)],
    ['Super against plain', listing('OLX', 'Karta GTX 1660 Super MSI', 600), listing('Allegro Lokalnie', 'Karta GTX 1660 MSI', 600)],
    ['other colour', listing('OLX', 'iPhone 13 128GB czarny', 1500), listing('Vinted', 'iPhone 13 128GB niebieski', 1500)],
    ['price more than 25% apart', listing('OLX', 'Konsola Sony PlayStation 5 Slim', 1500), listing('Vinted', 'Konsola Sony PlayStation 5 Slim', 1900)],
    ['new against used', listing('OLX', 'Konsola Sony PlayStation 5 Slim', 1900, { condition: 'Nowe' }), listing('Vinted', 'Konsola Sony PlayStation 5 Slim', 1900, { condition: 'Dobry' })],
    ['other city', listing('OLX', 'Konsola Sony PlayStation 5 Slim', 1900, { location: 'Mazowieckie, Warszawa, Wola' }), listing('Allegro Lokalnie', 'Konsola Sony PlayStation 5 Slim', 1900, { location: 'Gdańsk' })],
    ['too few words', listing('OLX', 'iPhone 13', 1500), listing('Vinted', 'iPhone 13', 1500)],
    ['different item, shared brand words', listing('OLX', 'Buty Nike Air Max 90 białe 42', 300), listing('Vinted', 'Buty Nike Air Force 1 białe 42', 300)],
  ];
  for (const [name, a, b] of cases) assert.ok(duplicateSimilarity(a, b) < DUPLICATE_SIMILARITY, `${name}: ${duplicateSimilarity(a, b)}`);
});

test('the same region alone does not make two places the same', () => {
  const a = listing('OLX', 'Rower Kross Hexagon 5.0 rama M', 900, { location: 'Mazowieckie, Radom' });
  const b = listing('Allegro Lokalnie', 'Rower Kross Hexagon 5.0 rama M', 900, { location: 'Mazowieckie, Płock' });
  assert.equal(duplicateSimilarity(a, b), 0);
});

test('findDuplicatePairs returns canonical pairs above the threshold', () => {
  const olx = listing('OLX', 'Konsola Sony PlayStation 5 Slim z napędem', 1900);
  const vinted = listing('Vinted', 'PlayStation 5 Slim z napędem konsola Sony', 1850);
  const allegro = listing('Allegro Lokalnie', 'Sony PlayStation 5 Slim napęd konsola', 1950);
  const unrelated = listing('Vinted', 'Xbox Series X 1TB pad', 1900);
  const pairs = findDuplicatePairs([vinted, unrelated, allegro, olx]);
  assert.deepEqual(pairs.map((pair) => [pair.a, pair.b]), [[olx.id, vinted.id], [olx.id, allegro.id], [vinted.id, allegro.id]].map(([a, b]) => [Math.min(a, b), Math.max(a, b)]).sort((x, y) => x[0] - y[0] || x[1] - y[1]));
  for (const pair of pairs) {
    assert.ok(pair.a < pair.b);
    assert.ok(pair.similarity >= DUPLICATE_SIMILARITY);
  }
});

test('drops matches from titles too plain to tell copies apart', () => {
  const olx = listing('OLX', 'Apple iPhone 13 128GB', 1500);
  const vinted = [1, 2, 3].map((index) => listing('Vinted', 'Apple iPhone 13 128GB', 1500 + index * 10));
  assert.deepEqual(findDuplicatePairs([olx, ...vinted]), []);
  // Two copies on one marketplace (a seller who posted twice) still count.
  assert.equal(findDuplicatePairs([olx, ...vinted.slice(0, 2)]).length, 2);
});

test('the prefix filter finds the same pairs as comparing every pair', () => {
  // Ten words across 500 titles, so many titles overlap and some are too plain.
  const words = ['konsola', 'sony', 'playstation', '5', 'slim', 'pad', 'dualsense', 'biały', 'czarny', 'gra'];
  const marketplaces = ['OLX', 'Allegro Lokalnie', 'Vinted'];
  // mulberry32: a small deterministic generator so the case is reproducible.
  let seed = 7;
  const random = () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const candidates: DuplicateCandidate[] = [];
  for (let index = 0; index < 500; index += 1) {
    const count = 3 + Math.floor(random() * 4);
    const title = Array.from({ length: count }, () => words[Math.floor(random() * words.length)]).join(' ');
    candidates.push({ id: index + 1, marketplace: marketplaces[Math.floor(random() * 3)], title, price: 1000 + Math.floor(random() * 8) * 50 });
  }
  const scores: Array<[DuplicateCandidate, DuplicateCandidate, number]> = [];
  for (let i = 0; i < candidates.length; i += 1) {
    for (let j = i + 1; j < candidates.length; j += 1) {
      const similarity = duplicateSimilarity(candidates[i], candidates[j]);
      if (similarity > 0) scores.push([candidates[i], candidates[j], similarity]);
    }
  }
  for (const threshold of [DUPLICATE_SIMILARITY, 0.85]) {
    const all = scores.filter(([, , similarity]) => similarity >= threshold);
    // The same plain-title rule findDuplicatePairs applies after scoring.
    const counts = new Map<string, number>();
    const bump = (key: string) => counts.set(key, (counts.get(key) ?? 0) + 1);
    for (const [a, b] of all) { bump(`${a.id}:${b.marketplace}`); bump(`${b.id}:${a.marketplace}`); }
    const expected = all
      .filter(([a, b]) => counts.get(`${a.id}:${b.marketplace}`)! <= 2 && counts.get(`${b.id}:${a.marketplace}`)! <= 2)
      .map(([a, b]) => `${Math.min(a.id, b.id)}:${Math.max(a.id, b.id)}`)
      .sort();
    assert.ok(expected.length > 50, `matching pairs at ${threshold}: ${expected.length}`);
    assert.ok(expected.length < all.length, `plain-title matches dropped at ${threshold}`);
    assert.deepEqual(findDuplicatePairs(candidates, threshold).map((pair) => `${pair.a}:${pair.b}`).sort(), expected);
  }
});

test('the feed chip names the saving, or says this copy is the cheapest', () => {
  const cheapest = (marketplace: 'OLX' | 'Allegro Lokalnie' | 'Vinted', price: number) => ({ key: `${marketplace}:1`, marketplace, price, url: 'https://example.test/1' });
  assert.equal(crossPostChip({ price: 500 }), null);
  assert.deepEqual(
    { ...crossPostChip({ price: 500, duplicateCount: 1, duplicateCheapest: cheapest('Vinted', 450) }), detail: undefined },
    { text: 'Vinted −50 zł', cheaper: true, detail: undefined },
  );
  assert.equal(crossPostChip({ price: 500, duplicateCount: 2, duplicateCheapest: cheapest('Allegro Lokalnie', 420) })?.text, '2× · Allegro −80 zł');
  assert.match(crossPostChip({ price: 500, duplicateCount: 2, duplicateCheapest: cheapest('Allegro Lokalnie', 420) })!.detail, /420 zł on Allegro Lokalnie, 80 zł less\. Matched by title, price, condition and place, not photos/);
  assert.deepEqual(
    { ...crossPostChip({ price: 450, duplicateCount: 1, duplicateCheapest: cheapest('OLX', 450) }), detail: undefined },
    { text: 'Also on OLX', cheaper: false, detail: undefined },
  );
  assert.equal(crossPostChip({ price: 450, duplicateCount: 3, duplicateCheapest: cheapest('OLX', 470) })?.text, '3× elsewhere');
  assert.match(crossPostChip({ price: 450, duplicateCount: 3, duplicateCheapest: cheapest('OLX', 470) })!.detail, /this one is the cheapest/);
});

// Service: refreshDuplicatePairs, the feed rows, listing detail and aging out.

const templateDirectory = mkdtempSync(join(tmpdir(), 'scout-duplicates-template-'));
after(() => rmSync(templateDirectory, { recursive: true, force: true }));
let template: string | undefined;
function fixture() {
  if (!template) {
    template = join(templateDirectory, 'scout.sqlite');
    openDatabase(template).close();
  }
  const directory = mkdtempSync(join(tmpdir(), 'scout-duplicates-'));
  copyFileSync(template, join(directory, 'scout.sqlite'));
  const db = openDatabase(join(directory, 'scout.sqlite'));
  const events: Array<{ event: string; payload: unknown }> = [];
  const service = new ScoutService(db, (event, payload) => events.push({ event, payload }), { suggestVariantGroups: async () => [] });
  return { db, service, events, close: () => { db.close(); rmSync(directory, { recursive: true, force: true }); } };
}

function seed(db: any) {
  const now = new Date().toISOString();
  const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
  db.prepare(`INSERT INTO watches (id, name, query, sources_json, enabled, next_scan_at, created_at, updated_at) VALUES ('ps5', 'PS5', 'ps5', '["OLX","Vinted","Allegro Lokalnie"]', 1, ?, ?, ?)`).run(now, now, now);
  const insert = db.prepare('INSERT INTO listings (marketplace, listing_id, title, price_pln, url, image_url, condition, location, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const link = db.prepare('INSERT INTO watch_listings (watch_id, listing_id, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)');
  const rows: Array<[string, string, string, number, string | null, string | null, string]> = [
    ['OLX', 'o1', 'Konsola Sony PlayStation 5 Slim z napędem', 1900, 'Używane', 'Warszawa, Mokotów', now],
    ['Vinted', 'v1', 'PlayStation 5 Slim z napędem konsola Sony', 1800, 'Bardzo dobry', null, now],
    ['Allegro Lokalnie', 'a1', 'Sony PlayStation 5 Slim napęd, konsola', 1950, 'używany', 'Warszawa', daysAgo(20)],
    ['Vinted', 'v2', 'Pad DualSense biały do PS5', 220, 'Dobry', null, now],
  ];
  for (const [marketplace, listingId, title, price, condition, location, seen] of rows) {
    const result = insert.run(marketplace, listingId, title, price, `https://example.test/${listingId}`, `https://img.example.test/${listingId}.jpg`, condition, location, seen, seen);
    link.run('ps5', Number(result.lastInsertRowid), seen, seen);
  }
}

test('refreshDuplicatePairs stores copies, badges feed rows and lists them in the detail', () => {
  const context = fixture();
  try {
    seed(context.db);
    // The Allegro copy was last seen 20 days ago, outside the 14-day window.
    const first = context.service.refreshDuplicatePairs();
    assert.deepEqual({ pairs: first.pairs, added: first.added, removed: first.removed }, { pairs: 1, added: 1, removed: 0 });
    assert.deepEqual(context.events.filter((entry) => entry.event === 'watch').map((entry) => entry.payload), [{ duplicates: 1 }]);
    const stored = context.db.prepare('SELECT listing_id_a, listing_id_b, similarity FROM listing_duplicate_pairs').all() as Array<{ listing_id_a: number; listing_id_b: number; similarity: number }>;
    assert.equal(stored.length, 1);
    assert.ok(stored[0].listing_id_a < stored[0].listing_id_b);

    const rows = context.service.listingsPage({ pageSize: 50, visibility: 'all' }).listings;
    const olx = rows.find((row) => row.id === 'OLX:o1')!;
    const vinted = rows.find((row) => row.id === 'Vinted:v1')!;
    assert.equal(olx.duplicateCount, 1);
    assert.deepEqual(olx.duplicateCheapest, { key: 'Vinted:v1', marketplace: 'Vinted', price: 1800, url: 'https://example.test/v1' });
    assert.equal(vinted.duplicateCount, 1);
    assert.equal(vinted.duplicateCheapest?.key, 'OLX:o1');
    // Rows without copies carry no duplicate fields at all.
    const pad = rows.find((row) => row.id === 'Vinted:v2')!;
    assert.equal('duplicateCount' in pad, false);
    assert.equal('duplicateCheapest' in pad, false);

    const detail = context.service.listingDetail('OLX:o1');
    assert.equal(detail.duplicates?.length, 1);
    assert.deepEqual({ ...detail.duplicates![0], similarity: undefined }, {
      key: 'Vinted:v1', marketplace: 'Vinted', title: 'PlayStation 5 Slim z napędem konsola Sony', price: 1800,
      url: 'https://example.test/v1', image: 'https://img.example.test/v1.jpg', observedAt: detail.duplicates![0].observedAt, similarity: undefined,
    });
    assert.ok(detail.duplicates![0].similarity >= DUPLICATE_SIMILARITY);
    assert.deepEqual(context.service.listingDetail('Vinted:v2').duplicates, []);

    // An unchanged refresh writes nothing and stays quiet.
    const second = context.service.refreshDuplicatePairs();
    assert.deepEqual({ added: second.added, removed: second.removed }, { added: 0, removed: 0 });
    assert.equal(context.events.filter((entry) => entry.event === 'watch').length, 1);
  } finally { context.close(); }
});

test('copies seen again join, and copies that age out or end are dropped', () => {
  const context = fixture();
  try {
    seed(context.db);
    context.service.refreshDuplicatePairs();
    // The Allegro copy shows up in a scan again: three copies, three pairs.
    context.db.prepare("UPDATE listings SET last_seen_at = ? WHERE listing_id = 'a1'").run(new Date().toISOString());
    assert.equal(context.service.refreshDuplicatePairs().pairs, 3);
    const rows = context.service.listingsPage({ pageSize: 50, visibility: 'all' }).listings;
    const olx = rows.find((row) => row.id === 'OLX:o1')!;
    assert.equal(olx.duplicateCount, 2);
    assert.equal(olx.duplicateCheapest?.key, 'Vinted:v1');
    assert.deepEqual(context.service.listingDetail('OLX:o1').duplicates!.map((copy) => copy.key), ['Vinted:v1', 'Allegro Lokalnie:a1']);

    // A copy verified gone stops counting at once, before the next refresh.
    context.db.prepare("UPDATE listings SET availability_status = 'terminal' WHERE listing_id = 'v1'").run();
    assert.deepEqual(context.service.listingDetail('OLX:o1').duplicates!.map((copy) => copy.key), ['Allegro Lokalnie:a1']);
    const ended = context.service.refreshDuplicatePairs();
    assert.deepEqual({ pairs: ended.pairs, removed: ended.removed }, { pairs: 1, removed: 2 });

    // Fifteen days on, every listing is outside the window.
    const later = context.service.refreshDuplicatePairs(Date.now() + 15 * 86_400_000);
    assert.deepEqual({ pairs: later.pairs, removed: later.removed }, { pairs: 0, removed: 1 });
    assert.equal((context.db.prepare('SELECT COUNT(*) AS count FROM listing_duplicate_pairs').get() as { count: number }).count, 0);
  } finally { context.close(); }
});

test('pairs go with their listings when retention deletes them', () => {
  const context = fixture();
  try {
    seed(context.db);
    context.service.refreshDuplicatePairs();
    context.db.prepare("DELETE FROM listings WHERE listing_id = 'v1'").run();
    assert.equal((context.db.prepare('SELECT COUNT(*) AS count FROM listing_duplicate_pairs').get() as { count: number }).count, 0);
  } finally { context.close(); }
});

test('the scheduler refreshes duplicates at most hourly', () => {
  const context = fixture();
  try {
    seed(context.db);
    (context.service as any).refreshDuplicatePairsIfDue();
    assert.equal((context.db.prepare('SELECT COUNT(*) AS count FROM listing_duplicate_pairs').get() as { count: number }).count, 1);
    context.db.prepare('DELETE FROM listing_duplicate_pairs').run();
    (context.service as any).refreshDuplicatePairsIfDue();
    assert.equal((context.db.prepare('SELECT COUNT(*) AS count FROM listing_duplicate_pairs').get() as { count: number }).count, 0);
    context.db.prepare("UPDATE settings SET value = ? WHERE key = 'last_duplicate_refresh'").run(new Date(Date.now() - 61 * 60_000).toISOString());
    (context.service as any).refreshDuplicatePairsIfDue();
    assert.equal((context.db.prepare('SELECT COUNT(*) AS count FROM listing_duplicate_pairs').get() as { count: number }).count, 1);
  } finally { context.close(); }
});

test('compact agent detail lists copies only when there are some', async () => {
  const context = fixture();
  try {
    seed(context.db);
    context.service.refreshDuplicatePairs();
    const compact = await context.service.listingDetailForAgent('OLX:o1', { format: 'compact' }) as CompactListingDetail;
    assert.deepEqual(compact.duplicates?.map((copy) => ({ key: copy.key, price: copy.price })), [{ key: 'Vinted:v1', price: 1800 }]);
    const none = await context.service.listingDetailForAgent('Vinted:v2', { format: 'compact' }) as CompactListingDetail;
    assert.equal('duplicates' in none, false);
  } finally { context.close(); }
});
