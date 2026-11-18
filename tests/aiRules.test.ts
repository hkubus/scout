import test from 'node:test';
import assert from 'node:assert/strict';
import { lacksQueryModelNumber, plainVariantMatch } from '../server/aiRules';
import type { VariantGroup } from '../server/variants';

// Variant groups as the owner's watches define them (2026-11 improvement export).
const IPHONE_12: VariantGroup[] = [
  { id: 'iphone-12', label: 'iPhone 12', terms: 'iphone 12' },
  { id: 'iphone-12-mini', label: 'iPhone 12 mini', terms: 'iphone 12 mini' },
  { id: 'iphone-12-pro', label: 'iPhone 12 Pro', terms: 'iphone 12 pro' },
  { id: 'iphone-12-pro-max', label: 'iPhone 12 Pro Max', terms: 'iphone 12 pro max' },
];
const RTX_2060: VariantGroup[] = [
  { id: 'rtx-2060', label: 'RTX 2060', terms: 'rtx 2060' },
  { id: 'rtx-2060-super', label: 'RTX 2060 Super', terms: 'rtx 2060 super' },
];
const GTX_1660: VariantGroup[] = [
  { id: 'v-super', label: '1660 super', terms: '1660 super' },
  { id: 'v-ti', label: '1660 ti', terms: '1660 ti' },
  { id: 'v-plain', label: '1660', terms: '1660' },
];

const iphone = (title: string, condition: string | null = 'Używane') =>
  plainVariantMatch({ title, condition, query: 'iPhone 12', includedTerms: '', excludedTerms: '', groups: IPHONE_12 });
const rtx = (title: string) => plainVariantMatch({ title, query: 'rtx 2060', includedTerms: '', excludedTerms: 'uszkodzone', groups: RTX_2060 });
const gtx = (title: string) => plainVariantMatch({ title, query: 'GTX 1660', includedTerms: '', excludedTerms: 'uszkodzone', groups: GTX_1660 });

test('plain variant: titles the relevance AI wrongly excluded on the export are decided relevant', () => {
  assert.deepEqual(iphone('iPhone 12 Pro Max 128GB stan 9/10 Graphite'), { variant: 'iphone-12-pro-max', label: 'iPhone 12 Pro Max' });
  assert.deepEqual(iphone('iPhone 12 mini 64GB'), { variant: 'iphone-12-mini', label: 'iPhone 12 mini' });
  assert.deepEqual(iphone('iPhone 12 pro Max'), { variant: 'iphone-12-pro-max', label: 'iPhone 12 Pro Max' });
  assert.deepEqual(rtx('Rtx 2060 super'), { variant: 'rtx-2060-super', label: 'RTX 2060 Super' });
});

test('plain variant: brands, board lines, colours, specs and condition words stay plain', () => {
  assert.equal(gtx('Karta graficzna Gigabyte GeForce GTX 1660 SUPER OC 6GB GDDR6')?.variant, 'v-super');
  assert.equal(gtx('Zotac Gaming GeForce GTX 1660 Super 6GB 192Bit GDDR6')?.variant, 'v-super');
  assert.equal(iphone('iPhone 12 (Biały, 128GB)')?.variant, 'iphone-12');
  assert.equal(iphone('iPhone 12 128 GB fioletowy')?.variant, 'iphone-12');
  assert.equal(iphone('IPhone 12 mini 256 GB 80%')?.variant, 'iphone-12-mini');
  assert.equal(iphone('Sprzedam telefon iphone 12')?.variant, 'iphone-12');
});

test('plain variant: anything that might be another item goes to the AI', () => {
  // Words outside the vocabulary: extras, battery talk, unknown models.
  assert.equal(iphone('iPhone 12 Pro Max, Pacific Blue - używany + gratisy'), null);
  assert.equal(iphone('iPhone 12 bateria 85%'), null);
  assert.equal(iphone('U.S Polo iPhone 12 case'), null);
  assert.equal(iphone('iPhone XS 64GB stan 12/10'), null);
  assert.equal(rtx('RTX 2060 RTX 3060 12GB'), null);
  // A quick flag: accessory lead, parts, damage, wanted ad.
  assert.equal(iphone('Etui iPhone 12'), null);
  assert.equal(iphone('iPhone 12 na części'), null);
  assert.equal(iphone('iPhone 12 64GB', 'Uszkodzone'), null);
  assert.equal(iphone('Kupię iPhone 12'), null);
  // Missing include term, an exclude term, or no named variant.
  assert.equal(iphone('iPhone 13 128GB'), null);
  assert.equal(rtx('RTX 2060 uszkodzone'), null);
  assert.equal(plainVariantMatch({ title: 'iPhone 12', query: 'iPhone 12', includedTerms: '', excludedTerms: '', groups: [] }), null);
  assert.equal(plainVariantMatch({ title: 'iPhone 12', query: 'iPhone 12', includedTerms: '', excludedTerms: '', groups: [{ id: 'x', label: 'X', terms: 'iphone 12 pro' }] }), null);
});

test('missing query model number: rejects near-misses with none of the query numbers in any form', () => {
  assert.equal(lacksQueryModelNumber('GTX 1660 Super 6GB', 'rtx 2060', '', ''), true);
  assert.equal(lacksQueryModelNumber('Laptop Lenovo Legion', 'rtx 3050', '', ''), true);
  // Any query number present, spaced or glued, leaves the call to Jev.
  assert.equal(lacksQueryModelNumber('Karta RTX2060 6GB', 'rtx 2060', '', ''), false);
  assert.equal(lacksQueryModelNumber('Intel Core i5-12400F', 'i5 12400', '', ''), false);
  assert.equal(lacksQueryModelNumber('GeForce 2060 6 GB', 'rtx 2060 6gb', '', ''), false);
  assert.equal(lacksQueryModelNumber('iPhone dwunastka 128 GB', 'iphone 12 128gb', '', ''), false);
  // A digit run must match whole: "5" is not inside "15".
  assert.equal(lacksQueryModelNumber('iPhone 15', 'iphone 5', '', ''), true);
  // No number in the query (or in explicit include terms): never decided here.
  assert.equal(lacksQueryModelNumber('Ładowarka Dell', 'ladowarka', '', ''), false);
  assert.equal(lacksQueryModelNumber('Karta graficzna', 'rtx 2060', 'karta, graficzna', ''), false);
});
