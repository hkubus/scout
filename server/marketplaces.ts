export type Marketplace = 'OLX' | 'Allegro Lokalnie' | 'Vinted';

export interface NormalizedListing {
  marketplace: Marketplace;
  listingId: string;
  title: string;
  price: number;
  currency: 'PLN';
  url: string;
  imageUrl?: string;
  condition?: string;
  location?: string;
  shippingAvailable?: boolean | null;
  observedAt: string;
}

export type MarketplaceSearchSort = 'newest';

export interface MarketplaceSearchFilters {
  minPrice?: number | null;
  maxPrice?: number | null;
  condition?: string;
  shippingOnly?: boolean;
  location?: string;
  sort?: MarketplaceSearchSort;
}

const hosts: Record<Marketplace, string[]> = {
  OLX: ['olx.pl', 'www.olx.pl'],
  'Allegro Lokalnie': ['allegrolokalnie.pl', 'www.allegrolokalnie.pl'],
  Vinted: ['vinted.pl', 'www.vinted.pl'],
};

function isAllowedHost(hostname: string, allowed: string[]) {
  return allowed.some((host) => hostname === host || hostname.endsWith(`.${host}`));
}

export function isApprovedMarketplaceHost(marketplace: Marketplace, hostname: string) {
  return isAllowedHost(hostname.toLowerCase().replace(/\.$/, ''), hosts[marketplace]);
}

export function validateSearchUrl(input: string, expectedMarketplace?: Marketplace) {
  let parsed: URL;
  try { parsed = new URL(input); } catch { return { valid: false, reason: 'Invalid URL' } as const; }
  if (parsed.protocol !== 'https:') return { valid: false, reason: 'Only HTTPS search URLs are allowed' } as const;
  if (parsed.username || parsed.password) return { valid: false, reason: 'Credentials in URLs are not allowed' } as const;
  const matches = (Object.keys(hosts) as Marketplace[]).filter((marketplace) => isAllowedHost(parsed.hostname.toLowerCase(), hosts[marketplace]));
  if (!matches.length) return { valid: false, reason: 'Marketplace domain is not approved' } as const;
  if (expectedMarketplace && !matches.includes(expectedMarketplace)) return { valid: false, reason: 'URL does not belong to the selected marketplace' } as const;
  return { valid: true, marketplace: matches[0], url: parsed.toString() } as const;
}

function olxQuerySlug(query: string) {
  return query.trim().toLowerCase().replace(/[^a-z0-9ąćęłńóśźż]+/gi, '-');
}

function setPriceParams(url: URL, filters: MarketplaceSearchFilters, minKey: string, maxKey: string) {
  if (filters.minPrice !== null && filters.minPrice !== undefined) url.searchParams.set(minKey, String(filters.minPrice));
  if (filters.maxPrice !== null && filters.maxPrice !== undefined) url.searchParams.set(maxKey, String(filters.maxPrice));
}

function vintedConditionIds(condition?: string) {
  const normalized = condition?.trim().toLowerCase();
  if (normalized === 'new') return ['6', '1'];
  if (normalized === 'used') return ['2', '3', '4', '5'];
  return [];
}

function setMarketplaceSort(url: URL, marketplace: Marketplace, sort?: MarketplaceSearchSort) {
  if (sort !== 'newest') return;
  if (marketplace === 'OLX') url.searchParams.set('search[order]', 'created_at:desc');
  else if (marketplace === 'Allegro Lokalnie') url.searchParams.set('sort', 'startingTime-desc');
  else url.searchParams.set('order', 'newest_first');
}

/** Build a marketplace-native search URL before applying Scout's cross-site safety checks. */
export function buildMarketplaceSearchUrl(marketplace: Marketplace, query: string, filters: MarketplaceSearchFilters = {}) {
  if (marketplace === 'OLX') {
    const url = new URL(`https://www.olx.pl/oferty/q-${olxQuerySlug(query)}/`);
    setPriceParams(url, filters, 'search[filter_float_price:from]', 'search[filter_float_price:to]');
    if (filters.shippingOnly) url.searchParams.set('courier', 'on');
    setMarketplaceSort(url, marketplace, filters.sort);
    return url.toString();
  }

  if (marketplace === 'Allegro Lokalnie') {
    const url = new URL(`https://allegrolokalnie.pl/oferty/q/${encodeURIComponent(query.trim())}`);
    url.searchParams.set('zrodlo', 'lokalnie');
    setPriceParams(url, filters, 'price_from', 'price_to');
    if (filters.condition?.trim().toLowerCase() === 'new') url.searchParams.set('stan', 'nowe');
    setMarketplaceSort(url, marketplace, filters.sort);
    return url.toString();
  }

  const url = new URL('https://www.vinted.pl/catalog');
  url.searchParams.set('search_text', query.trim());
  setPriceParams(url, filters, 'price_from', 'price_to');
  for (const statusId of vintedConditionIds(filters.condition)) url.searchParams.append('status_ids[]', statusId);
  setMarketplaceSort(url, marketplace, filters.sort);
  return url.toString();
}

export function parsePolishPrice(value: string | number | null | undefined) {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
  if (!value) return null;
  const normalized = value.replace(/\u00a0/g, ' ').replace(/zł|PLN/gi, '').replace(/\s/g, '').replace(/,(?=\d{1,2}$)/, '.').replace(/[^\d.\-]/g, '');
  const amount = Number(normalized);
  return Number.isFinite(amount) && amount >= 0 ? Math.round(amount * 100) / 100 : null;
}

export function normalizeListing(input: Omit<Partial<NormalizedListing>, 'marketplace' | 'listingId' | 'title' | 'price' | 'url'> & { marketplace: Marketplace; listingId: string; title: string; price: string | number; url: string }): NormalizedListing {
  const price = parsePolishPrice(input.price);
  if (price === null) throw new Error('Listing price is not a valid PLN amount');
  const validated = validateSearchUrl(input.url, input.marketplace);
  if (!validated.valid) throw new Error(validated.reason);
  return {
    marketplace: input.marketplace,
    listingId: input.listingId.trim(),
    title: input.title.trim().replace(/\s+/g, ' '),
    price,
    currency: 'PLN',
    url: validated.url,
    imageUrl: input.imageUrl,
    condition: input.condition?.trim(),
    location: input.location?.trim(),
    shippingAvailable: input.shippingAvailable ?? null,
    observedAt: input.observedAt ?? new Date().toISOString(),
  };
}

export function dedupeKey(listing: Pick<NormalizedListing, 'marketplace' | 'listingId'>) {
  return `${listing.marketplace.toLowerCase()}:${listing.listingId}`;
}

function flattenStructured(value: unknown): Array<Record<string, any>> {
  if (!value) return [];
  if (Array.isArray(value)) return value.flatMap(flattenStructured);
  if (typeof value !== 'object') return [];
  const record = value as Record<string, any>;
  const nested = [record.itemListElement, record.item, record['@graph']].flatMap(flattenStructured);
  return [record, ...nested];
}

function structuredImage(value: unknown): string | undefined {
  const image = Array.isArray(value) ? value[0] : value;
  if (typeof image === 'string') return image;
  if (image && typeof image === 'object') {
    const record = image as Record<string, unknown>;
    const candidate = record.url ?? record.contentUrl;
    return typeof candidate === 'string' ? candidate : undefined;
  }
  return undefined;
}

function decodeHtml(value: string) {
  return value
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)));
}

function attribute(fragment: string, name: string) {
  const match = fragment.match(new RegExp(`(?:\\s|<)${name}=["']([^"']*)["']`, 'i'));
  return match ? decodeHtml(match[1]) : undefined;
}

function textContent(fragment: string) {
  return decodeHtml(fragment.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim());
}

/** Parse OLX's rendered public result cards. The class names are intentionally ignored. */
export function parseOlxCards(html: string) {
  const starts = [...html.matchAll(/<div[^>]*data-cy=["']l-card["'][^>]*>/gi)];
  const listings: NormalizedListing[] = [];
  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index];
    const chunk = html.slice(start.index, starts[index + 1]?.index ?? html.length);
    const titleBlock = chunk.match(/<div[^>]*data-testid=["']ad-card-title["'][^>]*>([\s\S]*?)(?=<div[^>]*data-testid=["']location-date["'])/i)?.[1] ?? chunk;
    const titleLink = titleBlock.match(/<a[^>]*data-testid=["']card-title-link["'][^>]*>[\s\S]*?<h4[^>]*>([\s\S]*?)<\/h4>/i);
    const linkTag = titleBlock.match(/<a[^>]*data-testid=["']card-title-link["'][^>]*>/i)?.[0];
    const priceRaw = titleBlock.match(/<p[^>]*data-testid=["']ad-price["'][^>]*>([\s\S]*?)<\/p>/i)?.[1];
    const href = linkTag ? attribute(linkTag, 'href') : undefined;
    const title = titleLink ? textContent(titleLink[1]) : undefined;
    const price = priceRaw ? parsePolishPrice(textContent(priceRaw)) : null;
    if (!href || !title || price === null) continue;
    const url = new URL(href, 'https://www.olx.pl').toString();
    const startTag = start[0];
    const listingId = attribute(startTag, 'id') ?? url.match(/-ID([A-Za-z0-9]+)\.html/i)?.[1];
    if (!listingId) continue;
    const imageTag = chunk.match(/<img[^>]*>/i)?.[0];
    const locationRaw = chunk.match(/<p[^>]*data-testid=["']location-date["'][^>]*>([\s\S]*?)<\/p>/i)?.[1];
    const badgeRaw = chunk.match(/<div[^>]*data-nx-name=["']NexusBadge["'][^>]*>([\s\S]*?)<\/div>/i)?.[1];
    try {
      listings.push(normalizeListing({ marketplace: 'OLX', listingId, title, price, url, imageUrl: imageTag ? attribute(imageTag, 'src') : undefined, condition: badgeRaw ? textContent(badgeRaw) : undefined, location: locationRaw ? textContent(locationRaw).split(' - ')[0] : undefined, shippingAvailable: /data-testid=["']card-delivery-badge["']/i.test(chunk) }));
    } catch { /* malformed or off-domain cards are ignored */ }
  }
  return listings;
}

/** Parse Allegro Lokalnie's rendered cards, including the offer type that signals shipping support. */
export function parseAllegroCards(html: string) {
  const starts = [...html.matchAll(/<article[^>]*class=["'][^"']*mlc-itembox__container[^"']*["'][^>]*>/gi)];
  const listings: NormalizedListing[] = [];
  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index];
    const chunk = html.slice(start.index, starts[index + 1]?.index ?? html.length);
    const linkTag = [...chunk.matchAll(/<a[^>]*>/gi)].map((match) => match[0]).find((tag) => /itemprop=["']url["']/i.test(tag));
    const href = linkTag ? attribute(linkTag, 'href') : undefined;
    const titleRaw = chunk.match(/<h3[^>]*itemprop=["']itemOffered["'][^>]*>([\s\S]*?)<\/h3>/i)?.[1];
    const priceRaw = chunk.match(/<span[^>]*class=["'][^"']*ml-offer-price__dollars[^"']*["'][^>]*>([\s\S]*?)<\/span>/i)?.[1];
    const offerTag = chunk.match(/<span[^>]*class=["'][^"']*mlc-itembox__offer-type[^"']*["'][^>]*>[\s\S]*?<\/span>/i)?.[0];
    if (!href || !titleRaw || !priceRaw || !offerTag) continue;
    const title = textContent(titleRaw);
    const price = parsePolishPrice(textContent(priceRaw));
    const offerClass = attribute(offerTag, 'class') ?? '';
    const offerText = textContent(offerTag);
    const shippingAvailable = /mlc-itembox__offer-type--buy_now/i.test(offerClass) || /kup teraz/i.test(offerText)
      ? true
      : /mlc-itembox__offer-type--classified/i.test(offerClass) || /ogłoszenie/i.test(offerText)
        ? false
        : null;
    if (!title || price === null || shippingAvailable === null) continue;
    const url = new URL(href, 'https://allegrolokalnie.pl').toString();
    const listingId = attribute(start[0], 'data-card-analytics-click') ?? url.match(/\/oferta\/([^/?#]+)/i)?.[1];
    if (!listingId) continue;
    const imageTag = chunk.match(/<img[^>]*itemprop=["']image["'][^>]*>/i)?.[0] ?? chunk.match(/<img[^>]*>/i)?.[0];
    try {
      listings.push(normalizeListing({ marketplace: 'Allegro Lokalnie', listingId, title, price, url, imageUrl: imageTag ? attribute(imageTag, 'src') : undefined, shippingAvailable }));
    } catch { /* malformed or off-domain cards are ignored */ }
  }
  return listings;
}

/** Parse Vinted's server-rendered public product overlays and accessible labels. */
export function parseVintedCards(html: string) {
  const anchors = [...html.matchAll(/<a[^>]*data-testid=["']product-item-id-(\d+)--overlay-link["'][^>]*>/gi)];
  const listings: NormalizedListing[] = [];
  for (const anchor of anchors) {
    const tag = anchor[0];
    const listingId = anchor[1];
    const href = attribute(tag, 'href');
    const label = attribute(tag, 'title');
    if (!href || !label) continue;
    const priceRaw = label.match(/\d[\d\s.,]*\s*zł/i)?.[0];
    const price = parsePolishPrice(priceRaw);
    const title = label.split(/,\s*(?:Marka|Stan):/i)[0]?.trim();
    if (!title || price === null) continue;
    const preceding = html.slice(Math.max(0, (anchor.index ?? 0) - 2200), anchor.index);
    const imageTags = [...preceding.matchAll(/<img[^>]*>/gi)];
    const imageTag = imageTags.at(-1)?.[0];
    const condition = label.match(/,\s*Stan:\s*([^,]+)/i)?.[1]?.trim();
    try {
      listings.push(normalizeListing({ marketplace: 'Vinted', listingId, title, price, url: new URL(href, 'https://www.vinted.pl').toString(), imageUrl: imageTag ? attribute(imageTag, 'src') : undefined, condition }));
    } catch { /* malformed or off-domain cards are ignored */ }
  }
  return listings;
}

function visiblePageText(html: string) {
  return textContent(html.replace(/<script\b[\s\S]*?<\/script>/gi, ' ').replace(/<style\b[\s\S]*?<\/style>/gi, ' '));
}

/** Read shipping availability from a marketplace detail page when the search card omits it. */
export function parseShippingAvailability(html: string, marketplace: Marketplace): boolean | null {
  if (marketplace === 'Vinted') {
    if (/data-testid=["']item-shipping-banner["']/i.test(html)) return true;
    if (/tylko odbiór osobisty|brak opcji wysyłki/i.test(visiblePageText(html))) return false;
    const transactionMatch = html.match(/transaction_permitted(?:\\)?["']?\s*:\s*(true|false)/i);
    return transactionMatch ? transactionMatch[1].toLowerCase() === 'true' : null;
  }

  if (marketplace === 'Allegro Lokalnie') {
    const deliveryOptions = [...html.matchAll(/<div[^>]*class=["'][^"']*mlc-delivery-options__name[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi)]
      .map((match) => textContent(match[1]));
    if (deliveryOptions.length) return deliveryOptions.some((option) => !/odbiór osobisty/i.test(option));
    if (/brak dostępnych opcji wysyłki|tylko odbiór osobisty|odbiór osobisty/i.test(visiblePageText(html))) return false;
  }

  return null;
}

/** Parse the small, stable JSON-LD surface that marketplaces publish on public pages. */
export function parseStructuredListings(html: string, marketplace: Marketplace) {
  const listings: NormalizedListing[] = [];
  const scripts = html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const match of scripts) {
    try {
      const parsed = JSON.parse(match[1].trim());
      for (const item of flattenStructured(parsed)) {
        const offer = Array.isArray(item.offers) ? item.offers[0] : item.offers ?? item;
        const url = item.url ?? offer?.url;
        const title = item.name ?? item.headline;
        const price = offer?.price ?? item.price;
        const listingId = item.sku ?? item.productID ?? item.identifier ?? (typeof url === 'string' ? url.split('/').filter(Boolean).at(-1) : undefined);
        if (!url || !title || price === undefined || !listingId) continue;
        try {
          listings.push(normalizeListing({ marketplace, listingId: String(listingId), title: String(title), price, url: String(url), imageUrl: structuredImage(item.image), condition: typeof offer?.itemCondition === 'string' ? offer.itemCondition : undefined, location: typeof item.address?.addressLocality === 'string' ? item.address.addressLocality : undefined }));
        } catch { /* invalid/off-domain structured data is ignored */ }
      }
    } catch { /* malformed JSON-LD is common in blocked pages */ }
  }
  const unique = new Map<string, NormalizedListing>();
  const cardListings = marketplace === 'OLX' ? parseOlxCards(html) : marketplace === 'Allegro Lokalnie' ? parseAllegroCards(html) : parseVintedCards(html);
  for (const listing of cardListings) listings.push(listing);
  for (const listing of listings) unique.set(dedupeKey(listing), listing);
  return [...unique.values()];
}

export function exponentialBackoff(failures: number, baseMs = 5 * 60_000, maxMs = 6 * 60 * 60_000) {
  const safeFailures = Math.max(0, Math.floor(failures));
  return Math.min(maxMs, baseMs * (2 ** safeFailures));
}

export interface ConnectorAdapter {
  marketplace: Marketplace;
  fetchPublicSearch(url: string): Promise<NormalizedListing[]>;
}

/**
 * The first release keeps the browser connector behind a small adapter boundary.
 * Deployments can provide a Chromium-backed fetcher without changing normalization,
 * scoring, storage, or notification code.
 */
export function createPublicAdapter(marketplace: Marketplace, fetcher: (url: string) => Promise<string>): ConnectorAdapter {
  return {
    marketplace,
    async fetchPublicSearch(url) {
      const validation = validateSearchUrl(url, marketplace);
      if (!validation.valid) throw new Error(validation.reason);
      const html = await fetcher(validation.url);
      if (!html || html.length < 80) throw new Error('Public page returned no usable markup');
      const listings = parseStructuredListings(html, marketplace);
      if (!listings.length) throw new Error('Public page has no supported listing markup');
      return listings;
    },
  };
}
