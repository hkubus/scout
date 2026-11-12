import test from 'node:test';
import assert from 'node:assert/strict';
import { FLAGS_VERSION, LISTING_FLAGS, STORED_LISTING_FLAGS, flagsJson, listingFlags, mergeFlags, normalizeFlagText, parseFlagsJson } from '../server/flags';
import type { ListingFlagInput } from '../server/flags';

const names = (input: ListingFlagInput) => listingFlags(input).map((flag) => flag.flag);

test('normalizes Polish text without losing ł, and splits letters from digits', () => {
  assert.equal(normalizeFlagText('Złom, NIE DZIAŁA!'), 'zlom nie dziala');
  assert.equal(normalizeFlagText('iPhone13 128GB – uszkodzeń: brak'), 'iphone 13 128 gb uszkodzen brak');
  assert.equal(normalizeFlagText('Zamienię  na\tPS5'), 'zamienie na ps 5');
});

const cases: Array<[string, ListingFlagInput, string[]]> = [
  // for_parts
  ['na części', { title: 'iPhone 12 na części' }, ['for_parts']],
  ['dawca części', { title: 'Samsung S21 dawca części' }, ['for_parts']],
  ['do naprawy', { title: 'PS4 Pro do naprawy' }, ['for_parts']],
  ['nie do naprawy', { title: 'Laptop', description: 'Płyta nie do naprawy.' }, ['for_parts']],
  ['nic do naprawy', { title: 'Laptop', description: 'Wszystko sprawne, nic do naprawy.' }, []],
  ['uszkodzony', { title: 'Xbox Series X uszkodzony' }, ['for_parts']],
  ['niesprawna', { title: 'Konsola niesprawna' }, ['for_parts']],
  ['nie działa', { title: 'RTX 3080 nie działa' }, ['for_parts']],
  ['nie włącza się in the description', { title: 'iPhone 13', description: 'Telefon nie włącza się po upadku.' }, ['for_parts']],
  ['Złom, nie działa', { title: 'Złom, nie działa' }, ['for_parts']],
  ['bootloop', { title: 'Pixel 6 bootloop' }, ['for_parts']],
  ['broken', { title: 'MacBook Air broken screen' }, ['for_parts']],
  ['not working', { title: 'GPU not working' }, ['for_parts']],
  ['spalona płyta główna', { title: 'Laptop Dell', description: 'Spalona płyta główna, reszta OK.' }, ['for_parts']],
  ['działa bez zarzutu', { title: 'iPhone 13', description: 'Działa bez zarzutu, bateria 90%.' }, []],
  ['bez uszkodzeń', { title: 'iPhone 13 bez uszkodzeń' }, []],
  ['uszkodzeń: brak', { title: 'iPhone 13', description: 'Uszkodzeń: brak. Stan idealny.' }, []],
  ['nie jest uszkodzony', { title: 'iPhone 13', description: 'Telefon nie jest uszkodzony, nigdy nie był naprawiany.' }, []],
  ['nigdy nie był uszkodzony', { title: 'iPhone 13', description: 'Nigdy nie był uszkodzony.' }, []],
  ['bez rys i uszkodzonych pikseli', { title: 'Monitor', description: 'Bez rys i uszkodzonych pikseli.' }, []],
  ['uszkodzone pudełko', { title: 'iPhone 13 uszkodzone pudełko' }, []],
  ['pudełko lekko uszkodzone', { title: 'PS5', description: 'Pudełko lekko uszkodzone, konsola idealna.' }, []],
  ['lekko uszkodzony róg', { title: 'Kindle', description: 'Lekko uszkodzony róg obudowy.' }, []],
  ['uszkodzony: nie', { title: 'iPhone 13', description: 'Uszkodzony: nie' }, []],
  ['jeśli coś nie działa', { title: 'iPhone 13', description: 'Jeśli coś nie działa, zwrot w 14 dni.' }, []],
  ['nic nie działa', { title: 'Tablet', description: 'Nic nie działa.' }, ['for_parts']],
  ['gwarancja na części', { title: 'Laptop', description: 'Gwarancja na części i robociznę.' }, []],
  ['nie, działa', { title: 'Konsola', description: 'Czy coś nie gra? Nie, działa.' }, []],
  // Review of #54: "na części" meaning separately or taken apart, damaged extras, and denials.
  ['nie sprzedaję na części', { title: 'Zestaw', description: 'Zestaw kompletny. Nie sprzedaję na części.' }, []],
  ['nie rozdzielam na części', { title: 'Zestaw', description: 'Komplet, nie rozdzielam na części.' }, []],
  ['możliwa sprzedaż na części', { title: 'Komputer gamingowy RTX 3080 i7, możliwa sprzedaż na części' }, []],
  ['rozłożony na części', { title: 'LEGO 42115', description: 'Zestaw LEGO 42115 rozłożony na części, kompletny, z instrukcją.' }, []],
  ['bez ładowarki na części', { title: 'iPhone 11 bez ładowarki na części' }, ['for_parts']],
  ['nie działa na części', { title: 'iPhone 11 nie działa na części' }, ['for_parts']],
  ['sprzedam na części', { title: 'iPhone 11', description: 'Sprzedam na części, płyta padła.' }, ['for_parts']],
  ['uszkodzony kabel in the set', { title: 'iPhone 13', description: 'Telefon sprawny. W zestawie ładowarka (uszkodzony kabel).' }, []],
  ['szkło hartowane uszkodzone', { title: 'iPhone 13', description: 'Szkło hartowane uszkodzone, ekran pod spodem idealny.' }, []],
  ['brak martwych lub uszkodzonych pikseli', { title: 'Monitor', description: 'Ekran bez rys, brak martwych lub uszkodzonych pikseli.' }, []],
  ['nie posiada uszkodzonych elementów', { title: 'Konsola', description: 'Konsola nie posiada uszkodzonych elementów.' }, []],
  ['oddany do naprawy baterii', { title: 'iPhone 13', description: 'Telefon był raz oddany do naprawy baterii w serwisie Apple.' }, []],
  ['nie wymaga niczego do naprawy', { title: 'Laptop', description: 'Nie wymaga niczego do naprawy.' }, []],
  // damaged
  ['condition Uszkodzone', { title: 'iPhone 13', condition: 'Uszkodzone' }, ['damaged']],
  ['condition Uszkodzony (Allegro Lokalnie)', { title: 'iPhone 13', condition: 'Uszkodzony' }, ['damaged']],
  ['condition Używane', { title: 'iPhone 13', condition: 'Używane' }, []],
  ['condition Zadowalający (Vinted)', { title: 'Kurtka', condition: 'Zadowalający' }, []],
  // locked
  ['blokada iCloud', { title: 'iPhone 11 blokada iCloud' }, ['locked']],
  ['zablokowany na iCloud', { title: 'iPhone 11', description: 'Zablokowany na iCloud, na części.' }, ['for_parts', 'locked']],
  ['iCloud lock', { title: 'iPad iCloud lock' }, ['locked']],
  ['blokada aktywacji', { title: 'Apple Watch blokada aktywacji' }, ['locked']],
  ['FRP', { title: 'Samsung A52 FRP' }, ['locked']],
  ['zablokowany na konto Google', { title: 'Xiaomi', description: 'Zablokowany na konto Google.' }, ['locked']],
  ['MDM', { title: 'iPad Pro MDM' }, ['locked']],
  ['zablokowany na sieć Play', { title: 'iPhone 13 zablokowany na sieć Play' }, []],
  ['bez blokady iCloud', { title: 'iPhone 13 bez blokady iCloud' }, []],
  ['brak blokad: iCloud, FRP', { title: 'Telefon', description: 'Brak blokad: iCloud, FRP, simlock.' }, []],
  ['bez simlocka i blokady iCloud', { title: 'iPhone 13', description: 'Bez simlocka i blokady iCloud.' }, []],
  ['blokada iCloud zdjęta', { title: 'iPhone 13', description: 'Blokada iCloud zdjęta, telefon czysty.' }, []],
  ['iCloud wylogowany', { title: 'iPhone 13', description: 'iCloud wylogowany, konto Google usunięte.' }, []],
  ['blokada iCloud: brak', { title: 'iPhone 13', description: 'Blokada iCloud: brak' }, []],
  // Review of #54: a lock named as removed or absent.
  ['wolny od blokad iCloud', { title: 'iPhone 13', description: 'Telefon wolny od blokad iCloud i simlocka.' }, []],
  ['usunięta blokada iCloud', { title: 'iPhone 13', description: 'Usunięta blokada iCloud, telefon gotowy do użycia.' }, []],
  ['zdjęta blokada FRP', { title: 'Samsung A52', description: 'Zdjęta blokada FRP, konto Google wylogowane.' }, []],
  ['wyłączona blokada aktywacji', { title: 'Apple Watch', description: 'Wyłączona blokada aktywacji.' }, []],
  ['FRP brak', { title: 'Samsung A52', description: 'Konto Google usunięte, FRP brak.' }, []],
  ['blokada iCloud nie', { title: 'iPhone 13', description: 'Blokada iCloud nie.' }, []],
  ['blokady iCloud nie ma', { title: 'iPhone 13', description: 'Blokady iCloud nie ma, simlocka też nie.' }, []],
  ['blokada iCloud nie została zdjęta', { title: 'iPhone 11', description: 'Blokada iCloud nie została zdjęta.' }, ['locked']],
  ['iCloud zablokowany, nie znam hasła', { title: 'iPhone 11', description: 'iCloud zablokowany nie znam hasła.' }, ['locked']],
  ['konto usunięte, FRP aktywne', { title: 'Samsung A52', description: 'Konto usunięte, FRP aktywne.' }, ['locked']],
  ['FRP brak dostępu', { title: 'Samsung A52', description: 'Blokada FRP brak dostępu do konta.' }, ['locked']],
  ['z blokadą FRP na koncie poprzedniego właściciela', { title: 'Samsung A52', description: 'Telefon z blokadą FRP na koncie poprzedniego właściciela.' }, ['locked']],
  // wanted_ad
  ['Kupię iPhone 13', { title: 'Kupię iPhone 13' }, ['wanted_ad']],
  ['szukam', { title: 'Szukam PS5 Digital' }, ['wanted_ad']],
  ['skup', { title: 'Skup telefonów iPhone' }, ['wanted_ad']],
  ['kupie każdy', { title: 'Kupie każdy telefon' }, ['wanted_ad']],
  ['WTB', { title: 'WTB RTX 4090' }, ['wanted_ad']],
  ['szukam nowego właściciela', { title: 'Lego Technic szukam nowego właściciela' }, []],
  ['kupię only in the description', { title: 'iPhone 13', description: 'Kupię też iPhone 14.' }, []],
  ['skup in a shop title that also sells', { title: 'iPhone 13 128GB Gwarancja Skup Sprzedaż' }, []],
  // swap
  ['zamienię na PS5', { title: 'Xbox Series X zamienię na PS5' }, ['swap']],
  ['zamiana', { title: 'PS4 Pro zamiana' }, ['swap']],
  ['wymienię na', { title: 'Wymienię iPhone 12 na Samsunga' }, ['swap']],
  ['wymienię ekran', { title: 'Wymienię ekran w iPhone' }, []],
  ['sprzedam lub zamienię', { title: 'Xbox sprzedam lub zamienię' }, []],
  ['sprzedam/zamienię', { title: 'Xbox sprzedam/zamienię' }, []],
  ['możliwa zamiana', { title: 'PS5 możliwa zamiana' }, []],
  ['zamiana możliwa', { title: 'PS5 zamiana możliwa' }, []],
  ['ewentualnie zamiana', { title: 'PS5 ewentualnie zamiana' }, []],
  ['bez zamiany', { title: 'PS5 bez zamiany' }, []],
  ['zamiany mnie nie interesują', { title: 'PS5 zamiany mnie nie interesują' }, []],
  ['hot swap', { title: 'Klawiatura mechaniczna hot swap' }, []],
  ['tylko zamiana in the description', { title: 'PS4 Pro', description: 'Tylko zamiana na Xboxa.' }, ['swap']],
  ['możliwa zamiana in the description', { title: 'PS4 Pro', description: 'Możliwa zamiana na Xboxa.' }, []],
  ['tylko wymiana baterii', { title: 'iPhone 13', description: 'Sprawny, tylko wymiana baterii była.' }, []],
  // replica
  ['replika', { title: 'Rolex Submariner replika' }, ['replica']],
  ['podróbka', { title: 'AirPods Pro podróbka' }, ['replica']],
  ['kopia 1:1', { title: 'Yeezy kopia 1:1' }, ['replica']],
  ['1:1 alone', { title: 'AirPods Pro 2 1:1' }, ['replica']],
  ['fake', { title: 'Jordan 1 fake' }, ['replica']],
  ['nie oryginał', { title: 'Słuchawki', description: 'Nie oryginał, ale gra dobrze.' }, ['replica']],
  ['nie oryginalne pudełko', { title: 'iPhone 13', description: 'Nie oryginalne pudełko.' }, []],
  ['oryginał, nie podróbka', { title: 'AirPods Pro', description: 'Oryginał, nie podróbka.' }, []],
  ['żadna podróbka ani replika', { title: 'AirPods Pro', description: 'Żadna podróbka ani replika.' }, []],
  ['kopia paragonu', { title: 'iPhone 13', description: 'Dołączam kopię paragonu.' }, []],
  // Review of #54: a 1:1 replacement or exchange, and a non-original part.
  ['po wymianie 1:1', { title: 'iPhone 13', description: 'Telefon po wymianie 1:1 w serwisie Apple, nowy egzemplarz.' }, []],
  ['wymiana gwarancyjna 1:1', { title: 'iPhone 13', description: 'Wymiana gwarancyjna 1:1, nowy egzemplarz.' }, []],
  ['zamiana 1:1', { title: 'iPhone 13', description: 'Interesuje mnie zamiana 1:1 na Pixela.' }, []],
  ['ładowarka nie oryginalna', { title: 'iPhone 13', description: 'Ładowarka nie oryginalna, telefon oryginalny.' }, []],
  ['ekran wymieniony, nie oryginalny', { title: 'iPhone 13', description: 'Ekran wymieniony w serwisie, nie oryginalny.' }, []],
  ['iPhone, nie oryginał', { title: 'iPhone 13', description: 'Telefon nie oryginał, ale działa.' }, ['replica']],
  // accessory
  ['Etui iPhone 13 for iphone 13', { title: 'Etui iPhone 13', query: 'iphone 13' }, ['accessory']],
  ['Etui iPhone 13 for etui iphone 13', { title: 'Etui iPhone 13', query: 'etui iphone 13' }, []],
  ['iPhone 13 + etui gratis', { title: 'iPhone 13 + etui gratis', query: 'iphone 13' }, []],
  ['2x Szkło hartowane', { title: '2x Szkło hartowane iPhone 13', query: 'iphone 13' }, ['accessory']],
  ['Oryginalna ładowarka', { title: 'Oryginalna ładowarka Apple 20W', query: 'iphone 13' }, ['accessory']],
  ['Futerał skórzany do iPhone 13', { title: 'Futerał skórzany do iPhone 13', query: 'iphone 13' }, ['accessory']],
  ['Chłodzenie do RTX 3080', { title: 'Chłodzenie do RTX 3080', query: 'rtx 3080' }, ['accessory']],
  ['Komputer z RTX 3080', { title: 'Komputer do gier z RTX 3080', query: 'rtx 3080' }, []],
  ['Pudełko for a box-less query', { title: 'Pudełko iPhone 13', query: 'iphone 13' }, ['accessory']],
  ['Szkło for an etui query', { title: 'Szkło iPhone 13', query: 'etui iphone 13' }, ['accessory']],
  ['no query, no accessory', { title: 'Etui iPhone 13' }, []],
  ['Xbox is not a box', { title: 'Xbox One S', query: 'xbox' }, []],
  ['Foliowany is not foil', { title: 'Foliowany iPhone 13', query: 'iphone 13' }, []],
  // Review of #54: a phone title that opens with its battery health or a free extra.
  ['Bateria 100% iPhone 13', { title: 'Bateria 100% iPhone 13 128GB', query: 'iphone 13' }, []],
  ['Bateria: 89%', { title: 'Bateria: 89% iPhone 12', query: 'iphone 12' }, []],
  ['Etui gratis!', { title: 'Etui gratis! iPhone 13 128GB', query: 'iphone 13' }, []],
  ['Etui w zestawie', { title: 'Etui w zestawie, iPhone 13 128GB', query: 'iphone 13' }, []],
  ['Ładowarka 20W Apple', { title: 'Ładowarka 20W Apple USB-C', query: 'iphone 13' }, ['accessory']],
  ['Szkło 9H iPhone 13', { title: 'Szkło 9H iPhone 13', query: 'iphone 13' }, ['accessory']],
  ['Bateria 3110 mAh iPhone 13', { title: 'Bateria 3110 mAh iPhone 13', query: 'iphone 13' }, ['accessory']],
  // several at once, in LISTING_FLAGS order
  ['several flags', { title: 'Kupię iPhone na części', condition: 'Uszkodzone', description: 'Blokada iCloud.' }, ['for_parts', 'wanted_ad', 'damaged', 'locked']],
];

for (const [name, input, expected] of cases) {
  test(`flags: ${name}`, () => {
    assert.deepEqual(names(input), expected);
  });
}

test('one entry per flag, from the earliest field, with the normalized match', () => {
  const flags = listingFlags({ title: 'iPhone 13 nie działa', condition: 'Używane', description: 'Na części, nie włącza się. Blokada iCloud.' });
  assert.deepEqual(flags, [
    { flag: 'for_parts', match: 'nie dziala', in: 'title' },
    { flag: 'locked', match: 'blokada icloud', in: 'description' },
  ]);
  assert.deepEqual(listingFlags({ title: 'iPhone 13', condition: 'Uszkodzone' }), [{ flag: 'damaged', match: 'uszkodzone', in: 'condition' }]);
  assert.deepEqual(listingFlags({ title: 'Etui iPhone 13', query: 'iPhone 13' }), [{ flag: 'accessory', match: 'etui', in: 'title' }]);
  assert.deepEqual(listingFlags({ title: 'Futerał do iPhone 13', query: 'iPhone 13' }), [{ flag: 'accessory', match: 'futeral', in: 'title' }]);
  assert.deepEqual(listingFlags({ title: 'Gra Spider-Man 2 do PS5', query: 'PS5' }), [{ flag: 'accessory', match: 'do ps', in: 'title' }]);
  assert.deepEqual(listingFlags({ title: 'Yeezy 1:1' }), [{ flag: 'replica', match: '1:1', in: 'title' }]);
});

test('is deterministic and reads only the first 2000 description characters', () => {
  const input = { title: 'iPhone 13', description: `${'Telefon sprawny. '.repeat(120)}Nie działa.` };
  assert.ok(input.description.length > 2000);
  assert.deepEqual(listingFlags(input), []);
  assert.deepEqual(listingFlags({ ...input, description: 'Nie działa.' }), listingFlags({ ...input, description: 'Nie działa.' }));
});

test('stored flags leave out accessory and round-trip through flags_json', () => {
  assert.deepEqual([...STORED_LISTING_FLAGS].sort(), LISTING_FLAGS.filter((flag) => flag !== 'accessory').sort());
  assert.equal(FLAGS_VERSION, 1);
  const flags = listingFlags({ title: 'Etui iPhone 13 replika', query: 'iphone 13' });
  assert.deepEqual(flags.map((flag) => flag.flag), ['replica', 'accessory']);
  const json = flagsJson(flags);
  assert.equal(json, '[{"flag":"replica","match":"replika","in":"title"}]');
  assert.deepEqual(parseFlagsJson(json), [flags[0]]);
  assert.equal(flagsJson([]), '[]');
  assert.equal(parseFlagsJson(null), null);
  assert.equal(parseFlagsJson('not json'), null);
  assert.deepEqual(parseFlagsJson('[{"flag":"made_up","match":"x","in":"title"},{"flag":"swap","match":"zamiana","in":"title"}]'), [{ flag: 'swap', match: 'zamiana', in: 'title' }]);
});

test('mergeFlags keeps one entry per flag from the earliest field', () => {
  assert.deepEqual(mergeFlags(
    [{ flag: 'locked', match: 'frp', in: 'description' }],
    [{ flag: 'for_parts', match: 'na czesci', in: 'description' }, { flag: 'locked', match: 'blokada icloud', in: 'title' }],
  ), [
    { flag: 'for_parts', match: 'na czesci', in: 'description' },
    { flag: 'locked', match: 'blokada icloud', in: 'title' },
  ]);
});
