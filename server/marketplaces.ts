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
  priceNegotiable?: boolean | null;
  observedAt: string;
}

export type ListingAvailability =
  | { status: 'live' }
  | { status: 'terminal'; reason: string }
  | { status: 'unknown'; reason: string };

export interface ListingDetailResult {
  availability: ListingAvailability;
  listing?: NormalizedListing;
}

export type MarketplaceSearchPageStatus = 'results' | 'empty';

/**
 * Search results remain array-compatible for callers from the first release,
 * while the adapter also tells scans whether zero cards was a valid empty
 * page. An arbitrary HTML response must never be treated as empty.
 */
export type MarketplaceSearchResult = NormalizedListing[] & {
  pageStatus: MarketplaceSearchPageStatus;
  empty: boolean;
};

export type MarketplaceSearchSort = 'newest';

export interface MarketplaceSearchFilters {
  minPrice?: number | null;
  maxPrice?: number | null;
  condition?: string;
  shippingOnly?: boolean;
  location?: string;
  sort?: MarketplaceSearchSort;
  page?: number;
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

/**
 * Allegro Lokalnie uses the main Allegro account for authentication. Keep
 * public offer/search URLs restricted to Lokalnie, but accept the related
 * Allegro auth origin in an imported browser session.
 */
export function isApprovedMarketplaceSessionHost(marketplace: Marketplace, hostname: string) {
  const normalized = hostname.toLowerCase().replace(/\.$/, '');
  return isApprovedMarketplaceHost(marketplace, normalized)
    || (marketplace === 'Allegro Lokalnie' && isAllowedHost(normalized, ['allegro.pl', 'www.allegro.pl']));
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

function setMarketplacePage(url: URL, page?: number) {
  if (page !== undefined && Number.isInteger(page) && page > 1 && page <= 10) url.searchParams.set('page', String(page));
}

/** Build a marketplace-native search URL before applying Scout's cross-site safety checks. */
export function buildMarketplaceSearchUrl(marketplace: Marketplace, query: string, filters: MarketplaceSearchFilters = {}) {
  if (marketplace === 'OLX') {
    const url = new URL(`https://www.olx.pl/oferty/q-${olxQuerySlug(query)}/`);
    setPriceParams(url, filters, 'search[filter_float_price:from]', 'search[filter_float_price:to]');
    if (filters.shippingOnly) url.searchParams.set('courier', 'on');
    setMarketplaceSort(url, marketplace, filters.sort);
    setMarketplacePage(url, filters.page);
    return url.toString();
  }

  if (marketplace === 'Allegro Lokalnie') {
    const url = new URL(`https://allegrolokalnie.pl/oferty/q/${encodeURIComponent(query.trim())}`);
    url.searchParams.set('zrodlo', 'lokalnie');
    setPriceParams(url, filters, 'price_from', 'price_to');
    if (filters.condition?.trim().toLowerCase() === 'new') url.searchParams.set('stan', 'nowe');
    setMarketplaceSort(url, marketplace, filters.sort);
    setMarketplacePage(url, filters.page);
    return url.toString();
  }

  const url = new URL('https://www.vinted.pl/catalog');
  url.searchParams.set('search_text', query.trim());
  setPriceParams(url, filters, 'price_from', 'price_to');
  for (const statusId of vintedConditionIds(filters.condition)) url.searchParams.append('status_ids[]', statusId);
  setMarketplaceSort(url, marketplace, filters.sort);
  setMarketplacePage(url, filters.page);
  return url.toString();
}

export function parsePolishPrice(value: string | number | null | undefined) {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? Math.round(value * 100) / 100 : null;
  if (!value) return null;
  const normalized = value.replace(/\u00a0/g, ' ').replace(/zł|PLN/gi, '').replace(/\s/g, '').replace(/,(?=\d{1,2}$)/, '.').replace(/[^\d.\-]/g, '');
  const amount = Number(normalized);
  return Number.isFinite(amount) && amount > 0 ? Math.round(amount * 100) / 100 : null;
}

function normalizeNegotiabilityText(value: string) {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[-_/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Detect only explicit negotiation signals; an omitted signal remains unknown. */
export function parsePriceNegotiability(value: string | null | undefined): boolean | null {
  if (!value) return null;
  const normalized = normalizeNegotiabilityText(value);
  if (/\b(?:nie\s+do\s+negocjacji|bez\s+negocjacji|cena\s+(?:jest\s+)?sztywna|cena\s+nie\s+podlega\s+negocjacj\w*|brak\s+mozliwosci\s+negocjacji|non\s+negotiable|fixed\s+price)\b/i.test(normalized)) return false;
  if (/\b(?:do\s+negocjacji|mozliwosc\s+negocjacji|podlega\s+negocjacji|negocjowal\w*|negotiable)\b/i.test(normalized)) return true;
  return null;
}

function parsePriceNegotiabilityFromMarkup(fragment: string) {
  return parsePriceNegotiability(`${textContent(fragment)} ${fragment}`);
}

export function normalizeListing(input: Omit<Partial<NormalizedListing>, 'marketplace' | 'listingId' | 'title' | 'price' | 'url'> & { marketplace: Marketplace; listingId: string; title: string; price: string | number; url: string }): NormalizedListing {
  const price = parsePolishPrice(input.price);
  if (price === null) throw new Error('Listing price is not a valid PLN amount');
  const validated = validateSearchUrl(input.url, input.marketplace);
  if (!validated.valid) throw new Error(validated.reason);
  let imageUrl: string | undefined;
  if (input.imageUrl) {
    try {
      const candidate = new URL(input.imageUrl, validated.url);
      if (candidate.protocol === 'https:') imageUrl = candidate.toString();
    } catch { /* malformed image URLs are omitted */ }
  }
  return {
    marketplace: input.marketplace,
    listingId: input.listingId.trim(),
    title: input.title.trim().replace(/\s+/g, ' '),
    price,
    currency: 'PLN',
    url: validated.url,
    imageUrl,
    condition: input.condition?.trim(),
    location: input.location?.trim(),
    shippingAvailable: input.shippingAvailable ?? null,
    priceNegotiable: input.priceNegotiable ?? null,
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
      listings.push(normalizeListing({ marketplace: 'OLX', listingId, title, price, url, imageUrl: imageTag ? attribute(imageTag, 'src') : undefined, condition: badgeRaw ? textContent(badgeRaw) : undefined, location: locationRaw ? textContent(locationRaw).split(' - ')[0] : undefined, shippingAvailable: /data-testid=["']card-delivery-badge["']/i.test(chunk), priceNegotiable: parsePriceNegotiabilityFromMarkup(chunk) }));
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
      listings.push(normalizeListing({ marketplace: 'Allegro Lokalnie', listingId, title, price, url, imageUrl: imageTag ? attribute(imageTag, 'src') : undefined, shippingAvailable, priceNegotiable: parsePriceNegotiabilityFromMarkup(chunk) }));
    } catch { /* malformed or off-domain cards are ignored */ }
  }
  return listings;
}

/** Offer slugs are the last path segment of Lokalnie's canonical `/oferta/` URLs. */
function allegroSlugFromUrl(url: string) {
  try {
    const pathname = new URL(url).pathname;
    return pathname.startsWith('/oferta/') ? pathname.split('/').filter(Boolean).at(-1) ?? null : null;
  } catch { return null; }
}

const ALLEGRO_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Map schema.org itemCondition markers onto the Polish labels Scout stores. */
function structuredConditionLabel(value: unknown) {
  if (typeof value !== 'string') return undefined;
  if (/NewCondition/i.test(value)) return 'Nowe';
  if (/UsedCondition/i.test(value)) return 'Używane';
  if (/DamagedCondition/i.test(value)) return 'Uszkodzone';
  return value;
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
      listings.push(normalizeListing({ marketplace: 'Vinted', listingId, title, price, url: new URL(href, 'https://www.vinted.pl').toString(), imageUrl: imageTag ? attribute(imageTag, 'src') : undefined, condition, priceNegotiable: parsePriceNegotiabilityFromMarkup(`${tag} ${label}`) }));
    } catch { /* malformed or off-domain cards are ignored */ }
  }
  return listings;
}

function visiblePageText(html: string) {
  return textContent(html.replace(/<script\b[\s\S]*?<\/script>/gi, ' ').replace(/<style\b[\s\S]*?<\/style>/gi, ' '));
}

function isBlockedMarkup(html: string) {
  const text = visiblePageText(html).toLowerCase();
  return /captcha|cloudflare|access denied|verify you are human|robot check|przejdz weryfikacje|zbyt wiele zapytan|too many requests|challenge page/.test(text)
    || /(?:g-recaptcha|h-captcha|cf-chl-|challenge-platform)/i.test(html);
}

function hasExplicitEmptyState(html: string, marketplace: Marketplace) {
  if (isBlockedMarkup(html)) return false;
  const text = visiblePageText(html).toLowerCase();
  if (/nie znaleziono(?:\s+żadnych)?\s+(?:ogłoszeń|ofert|przedmiotów|wyników)|brak\s+(?:ogłoszeń|ofert|wyników)|no\s+(?:results|listings|items|offers)/i.test(text)) return true;
  if (marketplace === 'OLX') return /data-testid=["'](?:no-results|empty-state|search-results)["']/i.test(html) || /data-cy=["'](?:no-results|search-results)["']/i.test(html);
  if (marketplace === 'Allegro Lokalnie') return /data-testid=["'][^"']*(?:empty|no-results)[^"']*["']/i.test(html) || /mlc-(?:empty|search-results)/i.test(html);
  return /data-testid=["'][^"']*(?:empty|no-results|catalog)[^"']*["']/i.test(html) || /catalog-(?:empty|no-results)/i.test(html);
}

function withSearchStatus(listings: NormalizedListing[], pageStatus: MarketplaceSearchPageStatus, empty: boolean): MarketplaceSearchResult {
  const result = listings as MarketplaceSearchResult;
  Object.defineProperties(result, {
    pageStatus: { configurable: true, enumerable: false, value: pageStatus },
    empty: { configurable: true, enumerable: false, value: empty },
  });
  return result;
}

export function parseSearchPage(html: string, marketplace: Marketplace): MarketplaceSearchResult {
  if (!html) throw new Error('Public page returned no usable markup');
  const listings = parseStructuredListings(html, marketplace);
  if (listings.length) return withSearchStatus(listings, 'results', false);
  if (hasExplicitEmptyState(html, marketplace)) return withSearchStatus(listings, 'empty', true);
  throw new Error('Public page has no supported listing or empty-state markup');
}

function availabilityUnknown(reason: string): ListingAvailability {
  return { status: 'unknown', reason: reason.slice(0, 240) };
}

/** Classify a detail response without interpreting disappearance as a sale. */
export function parseListingAvailability(html: string, marketplace: Marketplace, httpStatus?: number): ListingAvailability {
  if (httpStatus === 404 || httpStatus === 410) return { status: 'terminal', reason: `Marketplace returned HTTP ${httpStatus}` };
  if (httpStatus !== undefined && (httpStatus === 401 || httpStatus === 403 || httpStatus === 408 || httpStatus === 429 || httpStatus >= 500)) {
    return availabilityUnknown(`Marketplace returned HTTP ${httpStatus}`);
  }
  if (!html || html.length < 80) return availabilityUnknown('Detail page returned no usable markup');
  if (isBlockedMarkup(html)) return availabilityUnknown('Marketplace returned a block or challenge page');
  const text = visiblePageText(html).toLowerCase();
  if (/ogłoszenie\s+(?:zostało\s+)?(?:usunięte|zakończone|jest\s+niedostępne)|oferta\s+(?:została\s+)?(?:usunięta|zakończona|jest\s+niedostępna)|(?:ogłoszenie|oferta)\s+niedostępne|przedmiot\s+został\s+sprzedany|sprzedane|sprzedany|sold|item\s+has\s+been\s+removed|listing\s+not\s+found|offer\s+not\s+found|listing\s+is\s+no\s+longer\s+available|offer\s+is\s+no\s+longer\s+available|no\s+longer\s+available|nie\s+istnieje/i.test(text)) {
    return { status: 'terminal', reason: 'The marketplace explicitly marks the listing as unavailable' };
  }
  if (parseStructuredListings(html, marketplace).length || /data-testid=["'](?:ad-card-title|item-title|offer-title|product-item-id-[^"']+--overlay-link)["']/i.test(html) || /(?:add-to-cart|chat-button|contact-seller|kup teraz|wyślij wiadomość|wysyłka)/i.test(text)) {
    return { status: 'live' };
  }
  return availabilityUnknown('Detail markup did not expose a definitive live or terminal state');
}

export const determineListingAvailability = parseListingAvailability;

function normalizeDescriptionCandidate(value: unknown) {
  if (typeof value !== 'string') return null;
  const normalized = textContent(value).slice(0, 8_000).trim();
  return normalized || null;
}

/** Extract only listing-description fields from a marketplace detail page. */
export function parseListingDescription(html: string, marketplace: Marketplace): string | null {
  if (!html) return null;
  const candidates: string[] = [];
  const add = (value: unknown) => {
    const normalized = normalizeDescriptionCandidate(value);
    if (normalized && !candidates.includes(normalized)) candidates.push(normalized);
  };

  const scripts = html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const match of scripts) {
    try {
      const parsed = JSON.parse(match[1].trim());
      for (const item of flattenStructured(parsed)) {
        add(item.description);
        const offer = Array.isArray(item.offers) ? item.offers[0] : item.offers;
        add(offer && typeof offer === 'object' ? (offer as Record<string, unknown>).description : undefined);
      }
    } catch {
      // Malformed JSON-LD is common on partially rendered marketplace pages.
    }
  }

  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = match[0];
    if (/(?:name|property)=["'](?:description|og:description)["']/i.test(tag)) add(attribute(tag, 'content'));
  }

  const descriptionPattern = /<(div|section|p)[^>]*(?:data-testid|data-cy|id|class)=["'][^"']*(?:description|opis)[^"']*["'][^>]*>([\s\S]*?)<\/\1>/gi;
  for (const match of html.matchAll(descriptionPattern)) add(match[2]);

  // Keep the marketplace argument in the parser contract so adapters can add
  // marketplace-specific selectors without changing scan callers.
  void marketplace;
  return candidates[0] ?? null;
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

const MARKETPLACE_IMAGE_CDN_SUFFIXES = ['olxcdn.com', 'allegroimg.com', 'vinted.net'];

/** Replace OLX CDN resize placeholders with a concrete gallery-size request. */
function concreteImageUrl(raw: string) {
  return raw
    .replace(/\{width\}x\{height\}/gi, '1000x750')
    .replace(/%7Bwidth%7Dx%7Bheight%7D/gi, '1000x750');
}

/** A stable identity for a photo regardless of resize variant or signature query. */
function imageIdentityKey(raw: string) {
  return raw
    .split('?')[0]
    .replace(/;s=\d+x\d+/gi, '')
    .replace(/[-_.]\d+x\d+(?=\.[a-z]{3,4}$)/i, '')
    .replace(/\/(\d+)x(\d+)\//, '/');
}

/**
 * Collect gallery photo URLs from a marketplace detail page so listings can be
 * preserved locally before (or shortly after) they leave the marketplace.
 * JSON-LD and Open Graph markup are the stable surfaces; CDN-hosted <img> and
 * srcset entries are a secondary source. Icon/logo-like assets are ignored.
 */
export function parseListingImageUrls(html: string, marketplace: Marketplace, limit = 40): string[] {
  if (!html) return [];
  const found: string[] = [];
  const push = (value: unknown) => {
    if (typeof value !== 'string') return;
    const candidate = concreteImageUrl(value.trim());
    if (!/^https:\/\//i.test(candidate)) return;
    if (candidate.length > 1_000) return;
    if (/favicon|sprite|logo|icon|avatar|placeholder|banner|emoji|flag/i.test(candidate)) return;
    const identity = imageIdentityKey(candidate);
    if (!identity || found.some((existing) => imageIdentityKey(existing) === identity)) return;
    found.push(candidate);
  };

  const scripts = html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const match of scripts) {
    try {
      const parsed = JSON.parse(match[1].trim());
      for (const item of flattenStructured(parsed)) {
        const image = item.image;
        if (Array.isArray(image)) image.forEach(push);
        else push(image);
        push(item.thumbnailUrl);
      }
    } catch { /* malformed JSON-LD is common on partially rendered marketplace pages */ }
  }

  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = match[0];
    if (/(?:property)=["'](?:og:image(?::secure_url)?|twitter:image(?::src)?)["']|(?:name)=["']twitter:image["']/i.test(tag)) push(attribute(tag, 'content'));
  }

  void marketplace;
  const cdnPattern = new RegExp(`https:[^"'\\s<>]+`, 'gi');
  for (const match of html.matchAll(cdnPattern)) {
    const candidate = match[0].replace(/[),.;]+$/, '');
    try {
      const parsed = new URL(candidate);
      if (!MARKETPLACE_IMAGE_CDN_SUFFIXES.some((suffix) => parsed.hostname === suffix || parsed.hostname.endsWith(`.${suffix}`))) continue;
      if (!/\.(?:jpe?g|png|webp)(?:$|[?;])/i.test(parsed.pathname + (parsed.search ?? '')) && !/\/image(;|$)/i.test(parsed.pathname)) continue;
      push(concreteImageUrl(parsed.toString()));
    } catch { /* not a usable URL */ }
    if (found.length >= limit) break;
  }
  return found.slice(0, limit);
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
          const description = [item.description, offer?.description].filter((value): value is string => typeof value === 'string').join(' ');
          const condition = structuredConditionLabel(offer?.itemCondition) ?? structuredConditionLabel(item.itemCondition);
          listings.push(normalizeListing({ marketplace, listingId: String(listingId), title: String(title), price, url: String(url), imageUrl: structuredImage(item.image), condition, location: typeof item.address?.addressLocality === 'string' ? item.address.addressLocality : undefined, priceNegotiable: parsePriceNegotiability(description) }));
        } catch { /* invalid/off-domain structured data is ignored */ }
      }
    } catch { /* malformed JSON-LD is common in blocked pages */ }
  }
  const unique = new Map<string, NormalizedListing>();
  const cardListings = marketplace === 'OLX' ? parseOlxCards(html) : marketplace === 'Allegro Lokalnie' ? parseAllegroCards(html) : parseVintedCards(html);
  if (marketplace === 'Allegro Lokalnie') {
    // The Lokalnie SSR search page embeds a schema.org ItemList (the stable
    // surface) keyed by offer slug, while cards remain the source for the
    // offer uuid plus the shipping/negotiability/location fields JSON-LD
    // omits. Merge per slug so one offer never appears twice under different
    // ids.
    const structuredBySlug = new Map<string, NormalizedListing>();
    for (const listing of listings) {
      const slug = allegroSlugFromUrl(listing.url);
      if (slug && !structuredBySlug.has(slug)) structuredBySlug.set(slug, listing);
    }
    for (const card of cardListings) {
      const slug = allegroSlugFromUrl(card.url);
      const structured = slug ? structuredBySlug.get(slug) : undefined;
      if (!structured) {
        listings.push(card);
        continue;
      }
      if (ALLEGRO_UUID_PATTERN.test(card.listingId)) structured.listingId = card.listingId;
      structured.shippingAvailable = structured.shippingAvailable ?? card.shippingAvailable;
      structured.priceNegotiable = structured.priceNegotiable ?? card.priceNegotiable;
      structured.location = structured.location ?? card.location;
      structured.condition = structured.condition ?? card.condition;
      structured.imageUrl = structured.imageUrl ?? card.imageUrl;
    }
  } else {
    for (const listing of cardListings) listings.push(listing);
  }
  for (const listing of listings) {
    const key = dedupeKey(listing);
    const previous = unique.get(key);
    unique.set(key, previous && listing.priceNegotiable === null && previous.priceNegotiable !== null && previous.priceNegotiable !== undefined
      ? { ...listing, priceNegotiable: previous.priceNegotiable }
      : listing);
  }
  return [...unique.values()];
}

export function exponentialBackoff(failures: number, baseMs = 5 * 60_000, maxMs = 6 * 60 * 60_000) {
  const safeFailures = Math.max(0, Math.floor(failures));
  return Math.min(maxMs, baseMs * (2 ** safeFailures));
}

export interface ConnectorAdapter {
  marketplace: Marketplace;
  fetchPublicSearch(url: string): Promise<MarketplaceSearchResult>;
  /**
   * `context.listingId` carries the marketplace's stored offer id for detail
   * lookups whose public URL does not expose it (OLX API ids are numeric while
   * current listing URLs carry a separate alphanumeric token).
   */
  fetchDetail(url: string, context?: { listingId?: string }): Promise<ListingDetailResult>;
  verifyAvailability(url: string, context?: { listingId?: string }): Promise<ListingAvailability>;
}

/**
 * Observes which transport path a connector actually takes (JSON API, SSR page,
 * Chromium-backed fallback) so scans can log the route each watch runs on.
 */
export type ConnectorPathReporter = (path: string) => void;

/**
 * The first release keeps the browser connector behind a small adapter boundary.
 * Deployments can provide a Chromium-backed fetcher without changing normalization,
 * scoring, storage, or notification code.
 */
export function createPublicAdapter(marketplace: Marketplace, fetcher: (url: string) => Promise<string>, onPath?: ConnectorPathReporter): ConnectorAdapter {
  return {
    marketplace,
    async fetchPublicSearch(url) {
      const validation = validateSearchUrl(url, marketplace);
      if (!validation.valid) throw new Error(validation.reason);
      const html = await fetcher(validation.url);
      onPath?.('public-page');
      return parseSearchPage(html, marketplace);
    },
    async fetchDetail(url) {
      const validation = validateSearchUrl(url, marketplace);
      if (!validation.valid) return { availability: availabilityUnknown(validation.reason) };
      try {
        const html = await fetcher(validation.url);
        onPath?.('public-detail-page');
        const listings = parseStructuredListings(html, marketplace);
        const availability = parseListingAvailability(html, marketplace);
        return { availability, listing: listings[0] };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Detail page verification failed';
        if (/\b(?:404|410)\b/.test(message)) return { availability: { status: 'terminal', reason: message.slice(0, 240) } };
        return { availability: availabilityUnknown(message) };
      }
    },
    async verifyAvailability(url) {
      return (await this.fetchDetail(url)).availability;
    },
  };
}

/**
 * OLX JSON API connector.
 *
 * OLX exposes a verified anonymous offers API (`GET /api/v1/offers/`) that needs
 * no session, cookies, or Chromium. Only `User-Agent: <modern Chrome>` plus
 * `Accept: application/json` are required. Risks and edge cases:
 * - `price.value.type === 'free'` (value 0) offers are skipped because
 *   `normalizeListing` rejects non-positive prices; this matches the HTML parser.
 * - `price.value.type === 'arranged'` still carries a real price, so it is kept.
 * - Photo links contain `{width}x{height}` placeholders that must be substituted.
 * - `priceNegotiable: false` is a real non-negotiable value, not "unknown".
 * - Empty detection must use `metadata.visible_total_count === 0` (or an empty
 *   `data` array, e.g. pages past the end), never the array alone: gibberish
 *   queries return loosely-related offers with a nonzero count.
 * - The offers API has no shipping-only flag; `delivery.rock.active` is mapped
 *   per offer and Scout's downstream `shippingOnly` filter narrows the results.
 * - The API may rate-limit; non-2xx responses fail closed so the existing
 *   `exponentialBackoff` / `connector_runs` handling takes over. Bot fences are
 *   never bypassed.
 */
export interface OlxApiFetchResult {
  status: number;
  json: unknown;
}

const OLX_OFFERS_API_URL = 'https://www.olx.pl/api/v1/offers/';
/** Server-verified maximum: the API rejects `limit` values above 50 (HTTP 400). */
const OLX_API_PAGE_LIMIT = 50;

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Map Scout's cross-marketplace filters onto the verified OLX offers API params. */
export function buildOlxSearchApiUrl(query: string, filters: MarketplaceSearchFilters = {}) {
  const url = new URL(OLX_OFFERS_API_URL);
  const trimmed = query.trim();
  if (trimmed) url.searchParams.set('query', trimmed);
  if (filters.minPrice !== null && filters.minPrice !== undefined) url.searchParams.set('filter_float_price:from', String(filters.minPrice));
  if (filters.maxPrice !== null && filters.maxPrice !== undefined) url.searchParams.set('filter_float_price:to', String(filters.maxPrice));
  const condition = filters.condition?.trim().toLowerCase();
  if (condition === 'new' || condition === 'used') url.searchParams.set('filter_enum_state[0]', condition);
  if (filters.sort === 'newest') url.searchParams.set('sort_by', 'created_at:desc');
  const page = filters.page;
  if (page !== undefined && Number.isInteger(page) && page > 1 && page <= 10) url.searchParams.set('offset', String((page - 1) * OLX_API_PAGE_LIMIT));
  url.searchParams.set('limit', String(OLX_API_PAGE_LIMIT));
  return url.toString();
}

/** Translate an OLX HTML search URL (e.g. a pasted exact URL) into an offers API URL. */
function olxSearchApiUrlFromSearchPage(url: string) {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return null; }
  if (!isApprovedMarketplaceHost('OLX', parsed.hostname)) return null;
  if (parsed.pathname.replace(/\/+$/, '').startsWith('/api/v1/offers')) return parsed.toString();
  const query = parsed.pathname.split('/').map((segment) => { try { return decodeURIComponent(segment); } catch { return segment; } }).find((segment) => segment.startsWith('q-'))?.slice(2);
  if (!query) return null;
  const api = new URL(OLX_OFFERS_API_URL);
  api.searchParams.set('query', query);
  const from = parsed.searchParams.get('search[filter_float_price:from]');
  const to = parsed.searchParams.get('search[filter_float_price:to]');
  if (from) api.searchParams.set('filter_float_price:from', from);
  if (to) api.searchParams.set('filter_float_price:to', to);
  if (parsed.searchParams.get('search[order]') === 'created_at:desc') api.searchParams.set('sort_by', 'created_at:desc');
  const page = Number(parsed.searchParams.get('page'));
  if (Number.isInteger(page) && page > 1 && page <= 10) api.searchParams.set('offset', String((page - 1) * OLX_API_PAGE_LIMIT));
  api.searchParams.set('limit', String(OLX_API_PAGE_LIMIT));
  return api.toString();
}

function parseOlxOffer(offer: unknown): NormalizedListing | null {
  if (!isRecord(offer)) return null;
  const listingId = offer.id === undefined || offer.id === null ? '' : String(offer.id).trim();
  const url = typeof offer.url === 'string' ? offer.url : undefined;
  const title = typeof offer.title === 'string' ? offer.title : undefined;
  const params = Array.isArray(offer.params) ? offer.params.filter(isRecord) : [];
  const priceParam = params.find((param) => param.key === 'price');
  const priceValue = priceParam && isRecord(priceParam.value) ? priceParam.value : undefined;
  const price = priceValue && typeof priceValue.value === 'number' ? priceValue.value : undefined;
  if (!listingId || !url || !title || price === undefined || priceValue?.type === 'free') return null;
  const photos = Array.isArray(offer.photos) ? offer.photos.filter(isRecord) : [];
  const photoLink = photos.find((photo) => typeof photo.link === 'string')?.link as string | undefined;
  const imageUrl = photoLink?.replace('{width}x{height}', '320x240');
  const stateParam = params.find((param) => param.key === 'state');
  const condition = stateParam && isRecord(stateParam.value) && typeof stateParam.value.label === 'string' ? stateParam.value.label : undefined;
  const locationRecord = isRecord(offer.location) ? offer.location : undefined;
  const location = ['region', 'city', 'district'].map((part) => {
    const value = locationRecord && isRecord(locationRecord[part]) ? locationRecord[part].name : undefined;
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  }).filter(Boolean).join(', ') || undefined;
  const rock = isRecord(offer.delivery) && isRecord(offer.delivery.rock) ? offer.delivery.rock : undefined;
  const shippingAvailable = rock && typeof rock.active === 'boolean' ? rock.active : null;
  const priceNegotiable = priceValue && typeof priceValue.negotiable === 'boolean' ? priceValue.negotiable : null;
  const observedAt = typeof offer.created_time === 'string' && offer.created_time ? offer.created_time : undefined;
  return normalizeListing({ marketplace: 'OLX', listingId, title, price, url, imageUrl, condition, location, shippingAvailable, priceNegotiable, observedAt });
}

/**
 * Parse an OLX offers API search response. The `data` array must be present:
 * error payloads without it fail closed instead of masquerading as empty pages.
 */
export function parseOlxOffersApi(json: unknown): MarketplaceSearchResult {
  const payload = isRecord(json) ? json : undefined;
  const data = payload && Array.isArray(payload.data) ? payload.data : undefined;
  if (!data) throw new Error('OLX API search response did not contain a data array');
  const listings: NormalizedListing[] = [];
  for (const offer of data) {
    try {
      const listing = parseOlxOffer(offer);
      if (listing) listings.push(listing);
    } catch { /* malformed or off-domain offers are ignored, matching the HTML parser */ }
  }
  const metadata = payload && isRecord(payload.metadata) ? payload.metadata : undefined;
  const visibleTotal = metadata && Number.isFinite(Number(metadata.visible_total_count)) ? Number(metadata.visible_total_count) : null;
  const empty = data.length === 0 || visibleTotal === 0;
  return withSearchStatus(listings, empty ? 'empty' : 'results', empty);
}

function olxApiErrorDetail(json: unknown) {
  const error = isRecord(json) && isRecord(json.error) ? json.error : undefined;
  const detail = error && typeof error.detail === 'string' ? error.detail.trim() : '';
  return detail ? detail.slice(0, 240) : null;
}

/** Classify OLX API availability from the HTTP status; JSON bodies replace HTML heuristics. */
export function parseOlxListingAvailabilityApi(json: unknown, httpStatus: number): ListingAvailability {
  if (httpStatus === 404 || httpStatus === 410) {
    return { status: 'terminal', reason: olxApiErrorDetail(json) ?? `Marketplace returned HTTP ${httpStatus}` };
  }
  if (httpStatus !== 200 && httpStatus !== 204) return availabilityUnknown(`Marketplace returned HTTP ${httpStatus}`);
  const payload = isRecord(json) ? json : undefined;
  if (payload?.error) return availabilityUnknown(olxApiErrorDetail(payload) ?? 'OLX API returned an error response');
  const data = payload?.data;
  if (!isRecord(data)) return availabilityUnknown('OLX detail response did not include the offer object');
  if (typeof data.status === 'string' && data.status.toLowerCase() !== 'active') return availabilityUnknown(`OLX offer status is "${data.status}"`);
  return { status: 'live' };
}

function olxListingIdFromUrl(url: string) {
  return url.match(/-ID(\d+)\.html/i)?.[1] ?? null;
}

/**
 * A dedicated OLX adapter over the anonymous offers API. The stored numeric
 * listing id is preferred for detail lookups because current OLX URLs carry a
 * separate alphanumeric token that the API rejects; ids without the API's
 * numeric shape degrade to `unknown` rather than risking a false 404 terminal
 * classification.
 */
export function createOlxJsonAdapter(marketplace: Marketplace, fetcher: (url: string) => Promise<OlxApiFetchResult>, onPath?: ConnectorPathReporter): ConnectorAdapter {
  return {
    marketplace,
    async fetchPublicSearch(url) {
      const apiUrl = olxSearchApiUrlFromSearchPage(url);
      if (!apiUrl) throw new Error('OLX search URL could not be translated to the offers API');
      const validation = validateSearchUrl(apiUrl, marketplace);
      if (!validation.valid) throw new Error(validation.reason);
      const { status, json } = await fetcher(validation.url);
      if (status < 200 || status >= 300) throw new Error(`OLX offers API returned HTTP ${status}`);
      onPath?.('olx-offers-api');
      return parseOlxOffersApi(json);
    },
    async fetchDetail(url, context) {
      const validation = validateSearchUrl(url, marketplace);
      if (!validation.valid) return { availability: availabilityUnknown(validation.reason) };
      const listingId = context?.listingId?.trim() || olxListingIdFromUrl(validation.url);
      if (!listingId || !/^\d+$/.test(listingId)) return { availability: availabilityUnknown('OLX offers API requires a numeric offer id') };
      const detailUrl = `${OLX_OFFERS_API_URL}${encodeURIComponent(listingId)}/`;
      let response: OlxApiFetchResult;
      try {
        response = await fetcher(detailUrl);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'OLX detail verification failed';
        return { availability: availabilityUnknown(message) };
      }
      onPath?.('olx-offer-detail-api');
      const availability = parseOlxListingAvailabilityApi(response.json, response.status);
      let listing: NormalizedListing | undefined;
      if (availability.status === 'live' && isRecord(response.json) && isRecord(response.json.data)) {
        try { listing = parseOlxOffer(response.json.data) ?? undefined; } catch { listing = undefined; }
      }
      return { availability, listing };
    },
    async verifyAvailability(url, context) {
      return (await this.fetchDetail(url, context)).availability;
    },
  };
}

/**
 * Allegro Lokalnie connector.
 *
 * Search and liveness stay on plain-HTTP SSR pages: the anonymous JSON surface
 * has no phrase-search endpoint, and `GET /api/offers/{uuid}` is a summary
 * cache that never signals removal (offers archived years ago still return
 * 200). The anonymous JSON is used where it is strictly better —
 * `POST /api/additionaldata/offers` batch-enriches search cards with the
 * condition enum the card markup omits. Risks and edge cases:
 * - The batch caps at 60 offer ids per request (the site's own batch size);
 *   invalid ids are silently dropped, the response order is arbitrary, and
 *   items are keyed by slug (`item_id`), not uuid, so correlation runs through
 *   each listing's offer URL.
 * - Enrichment is opportunistic: any API failure keeps the un-enriched search
 *   results instead of failing the scan.
 * - The JSON surface currently bypasses the bot fence that challenges the HTML
 *   pages; treat it as fragile and do not hammer it.
 */
export interface AllegroApiFetchResult {
  status: number;
  json: unknown;
}

const ALLEGRO_ADDITIONAL_DATA_URL = 'https://allegrolokalnie.pl/api/additionaldata/offers';
/** The site itself batches 60 offer ids per additional-data request. */
const ALLEGRO_ADDITIONAL_DATA_BATCH = 60;

const ALLEGRO_CONDITION_LABELS: Record<string, string> = {
  brand_new: 'Nowe',
  very_good: 'Bardzo dobry',
  visibly_used: 'Używane',
};

/** Parse the anonymous additional-data batch; items correlate by slug, never by uuid. */
export function parseAllegroBatchEnrichmentApi(json: unknown): Map<string, string> {
  const bySlug = new Map<string, string>();
  if (!Array.isArray(json)) return bySlug;
  for (const entry of json) {
    if (!isRecord(entry)) continue;
    const slug = typeof entry.item_id === 'string' ? entry.item_id : undefined;
    const variant = typeof entry.item_variant === 'string' ? entry.item_variant.trim().toLowerCase() : undefined;
    const label = variant ? ALLEGRO_CONDITION_LABELS[variant] : undefined;
    if (slug && label) bySlug.set(slug, label);
  }
  return bySlug;
}

/**
 * Best-effort condition enrichment: cards omit the condition, so offer uuids
 * (from `data-card-analytics-click`) are batch-posted and matched back through
 * each listing's offer-URL slug. JSON-LD-only listings without a card twin
 * carry no uuid and stay un-enriched. Never fails the search; the return value
 * reports what happened for path logging.
 */
async function enrichAllegroSearchConditions(
  listings: MarketplaceSearchResult,
  apiFetcher: (url: string, body: string | null) => Promise<AllegroApiFetchResult>,
): Promise<'enriched' | 'skipped' | 'failed'> {
  try {
    const uuidBySlug = new Map<string, string>();
    for (const listing of listings) {
      if (listing.condition) continue;
      const slug = allegroSlugFromUrl(listing.url);
      if (!slug || uuidBySlug.has(slug)) continue;
      if (ALLEGRO_UUID_PATTERN.test(listing.listingId)) uuidBySlug.set(slug, listing.listingId);
    }
    if (!uuidBySlug.size) return 'skipped';
    const offerIds = [...new Set(uuidBySlug.values())].slice(0, ALLEGRO_ADDITIONAL_DATA_BATCH);
    const { status, json } = await apiFetcher(ALLEGRO_ADDITIONAL_DATA_URL, JSON.stringify({ offer_ids: offerIds }));
    if (status < 200 || status >= 300) return 'failed';
    const conditionsBySlug = parseAllegroBatchEnrichmentApi(json);
    if (!conditionsBySlug.size) return 'failed';
    for (const listing of listings) {
      if (listing.condition) continue;
      const slug = allegroSlugFromUrl(listing.url);
      const label = slug ? conditionsBySlug.get(slug) : undefined;
      if (label) listing.condition = label;
    }
    return 'enriched';
  } catch { /* enrichment is opportunistic; keep the raw search results */ return 'failed'; }
}

export function createAllegroLokalnieAdapter(
  marketplace: Marketplace,
  pageFetcher: (url: string) => Promise<string>,
  apiFetcher: (url: string, body: string | null) => Promise<AllegroApiFetchResult>,
  onPath?: ConnectorPathReporter,
): ConnectorAdapter {
  const base = createPublicAdapter(marketplace, pageFetcher, onPath);
  return {
    marketplace,
    async fetchPublicSearch(url) {
      const validation = validateSearchUrl(url, marketplace);
      if (!validation.valid) throw new Error(validation.reason);
      const html = await pageFetcher(validation.url);
      const result = parseSearchPage(html, marketplace);
      onPath?.('allegro-ssr-page');
      if (await enrichAllegroSearchConditions(result, apiFetcher) === 'enriched') onPath?.('allegro-condition-batch');
      return result;
    },
    async fetchDetail(url, context) {
      return base.fetchDetail(url, context);
    },
    async verifyAvailability(url, context) {
      return base.verifyAvailability(url, context);
    },
  };
}

/**
 * Vinted JSON catalog connector.
 *
 * Anonymous JSON search works after a one-request cookie bootstrap
 * (`GET https://www.vinted.pl/` → `access_token_web`), which the injected api
 * fetcher owns: it must re-bootstrap and retry once on 401. The item JSON
 * routes are closed to anonymous clients, so detail and availability run on
 * the public item page over plain HTTP. Risks and edge cases:
 * - The API is per-ccTLD: bootstrap and calls must target `www.vinted.pl`.
 * - `sort=` is silently ignored; only `order=newest_first` is honored.
 * - Search items carry no `priceNegotiable`, `location`, `shippingAvailable`,
 *   or `created_at_ts`; prices arrive as buyer-view amounts in the domain
 *   currency.
 * - Datacenter IPs can be Cloudflare-fenced on the first bootstrap. JSON
 *   failures fall back to the public-page adapter whose fetcher owns the
 *   Chromium render path; bot fences are never bypassed.
 */
export interface VintedApiFetchResult {
  status: number;
  json: unknown;
}

export interface VintedPageFetchResult {
  status: number;
  body: string;
}

const VINTED_CATALOG_API_URL = 'https://www.vinted.pl/api/v2/catalog/items';
/** The verified anonymous page size; larger values are undocumented. */
const VINTED_API_PAGE_LIMIT = 20;

/** Map Scout's cross-marketplace filters onto the verified Vinted catalog API params. */
export function buildVintedSearchApiUrl(query: string, filters: MarketplaceSearchFilters = {}) {
  const url = new URL(VINTED_CATALOG_API_URL);
  const trimmed = query.trim();
  if (trimmed) url.searchParams.set('search_text', trimmed);
  setPriceParams(url, filters, 'price_from', 'price_to');
  for (const statusId of vintedConditionIds(filters.condition)) url.searchParams.append('status_ids[]', statusId);
  // `sort=` is silently ignored by the API; `order=` is the real parameter.
  if (filters.sort === 'newest') url.searchParams.set('order', 'newest_first');
  setMarketplacePage(url, filters.page);
  url.searchParams.set('per_page', String(VINTED_API_PAGE_LIMIT));
  return url.toString();
}

/** Translate a Vinted HTML catalog URL (e.g. a pasted exact URL) into a catalog API URL. */
function vintedSearchApiUrlFromCatalogUrl(url: string) {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return null; }
  if (!isApprovedMarketplaceHost('Vinted', parsed.hostname)) return null;
  const pathname = parsed.pathname.replace(/\/+$/, '');
  if (pathname === '/api/v2/catalog/items') return parsed.toString();
  if (!pathname.startsWith('/catalog')) return null;
  const api = new URL(VINTED_CATALOG_API_URL);
  const searchText = parsed.searchParams.get('search_text');
  if (searchText?.trim()) api.searchParams.set('search_text', searchText.trim());
  const from = parsed.searchParams.get('price_from');
  const to = parsed.searchParams.get('price_to');
  if (from) api.searchParams.set('price_from', from);
  if (to) api.searchParams.set('price_to', to);
  for (const statusId of [...parsed.searchParams.getAll('status_ids[]'), ...parsed.searchParams.getAll('status_id')]) {
    if (statusId) api.searchParams.append('status_ids[]', statusId);
  }
  if (parsed.searchParams.get('order') === 'newest_first') api.searchParams.set('order', 'newest_first');
  const page = Number(parsed.searchParams.get('page'));
  if (Number.isInteger(page) && page > 1 && page <= 10) api.searchParams.set('page', String(page));
  api.searchParams.set('per_page', String(VINTED_API_PAGE_LIMIT));
  return api.toString();
}

function parseVintedCatalogItem(item: unknown): NormalizedListing | null {
  if (!isRecord(item)) return null;
  const listingId = item.id === undefined || item.id === null ? '' : String(item.id).trim();
  const title = typeof item.title === 'string' ? item.title : undefined;
  const priceRecord = isRecord(item.price) ? item.price : undefined;
  const currency = typeof priceRecord?.currency_code === 'string' ? priceRecord.currency_code.trim().toUpperCase() : '';
  // `NormalizedListing` is PLN-only; rows shown in another catalog currency are skipped.
  if (currency && currency !== 'PLN') return null;
  const price = parsePolishPrice(priceRecord?.amount);
  const path = typeof item.path === 'string' && item.path ? item.path : undefined;
  const url = typeof item.url === 'string' && item.url ? item.url : path ? new URL(path, 'https://www.vinted.pl').toString() : undefined;
  if (!listingId || !title || price === null || !url) return null;
  const photo = isRecord(item.photo) ? item.photo : undefined;
  const imageUrl = typeof photo?.url === 'string' ? photo.url : undefined;
  const condition = typeof item.status === 'string' && item.status.trim() ? item.status.trim() : undefined;
  return normalizeListing({ marketplace: 'Vinted', listingId, title, price, url, imageUrl, condition, shippingAvailable: null, priceNegotiable: null });
}

/**
 * Parse a Vinted catalog API search response. The `items` array must be
 * present: error payloads without it fail closed instead of masquerading as
 * empty pages.
 */
export function parseVintedCatalogApi(json: unknown): MarketplaceSearchResult {
  const payload = isRecord(json) ? json : undefined;
  const items = payload && Array.isArray(payload.items) ? payload.items : undefined;
  if (!items) throw new Error('Vinted catalog API response did not contain an items array');
  const listings: NormalizedListing[] = [];
  for (const item of items) {
    try {
      const listing = parseVintedCatalogItem(item);
      if (listing) listings.push(listing);
    } catch { /* malformed or off-domain items are ignored, matching the HTML parser */ }
  }
  const pagination = payload && isRecord(payload.pagination) ? payload.pagination : undefined;
  const totalEntries = pagination && Number.isFinite(Number(pagination.total_entries)) ? Number(pagination.total_entries) : null;
  const empty = items.length === 0 || totalEntries === 0;
  return withSearchStatus(listings, empty ? 'empty' : 'results', empty);
}

function vintedStructuredAvailability(html: string): ListingAvailability | null {
  const scripts = html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const match of scripts) {
    try {
      for (const item of flattenStructured(JSON.parse(match[1].trim()))) {
        const offers = Array.isArray(item.offers) ? item.offers[0] : item.offers;
        const availability = offers && typeof offers.availability === 'string' ? offers.availability : undefined;
        if (!availability) continue;
        if (/InStock/i.test(availability)) return { status: 'live' };
        if (/SoldOut/i.test(availability)) return { status: 'terminal', reason: 'The marketplace explicitly marks the listing as sold out' };
      }
    } catch { /* malformed JSON-LD is common on partially rendered pages */ }
  }
  return null;
}

/**
 * Classify a Vinted public item page. The JSON item routes are closed to
 * anonymous clients, so availability comes from the HTTP status plus the
 * page's schema.org `Product` LD-JSON (`availability: InStock`); a "sold"
 * state is only trusted when the marketplace states it structurally.
 */
export function parseVintedItemPageAvailability(html: string, httpStatus?: number): ListingAvailability {
  if (httpStatus === 404 || httpStatus === 410) return { status: 'terminal', reason: `Marketplace returned HTTP ${httpStatus}` };
  if (httpStatus !== undefined && (httpStatus === 401 || httpStatus === 403 || httpStatus === 408 || httpStatus === 429 || httpStatus >= 500)) {
    return availabilityUnknown(`Marketplace returned HTTP ${httpStatus}`);
  }
  if (!html || html.length < 80) return availabilityUnknown('Item page returned no usable markup');
  if (isBlockedMarkup(html)) return availabilityUnknown('Marketplace returned a block or challenge page');
  const structured = vintedStructuredAvailability(html);
  if (structured) return structured;
  return parseListingAvailability(html, 'Vinted');
}

export function createVintedJsonAdapter(
  marketplace: Marketplace,
  apiFetcher: (url: string) => Promise<VintedApiFetchResult>,
  pageFetcher: (url: string) => Promise<VintedPageFetchResult>,
  fallback?: ConnectorAdapter,
  onPath?: ConnectorPathReporter,
): ConnectorAdapter {
  return {
    marketplace,
    async fetchPublicSearch(url) {
      const validation = validateSearchUrl(url, marketplace);
      if (!validation.valid) throw new Error(validation.reason);
      const apiUrl = vintedSearchApiUrlFromCatalogUrl(validation.url);
      if (apiUrl) {
        const apiValidation = validateSearchUrl(apiUrl, marketplace);
        if (apiValidation.valid) {
          try {
            const { status, json } = await apiFetcher(apiValidation.url);
            if (status < 200 || status >= 300) throw new Error(`Vinted catalog API returned HTTP ${status}`);
            onPath?.('vinted-catalog-api');
            return parseVintedCatalogApi(json);
          } catch (error) {
            // JSON failures (expired bootstrap, Cloudflare fence, schema
            // drift) fail closed to the public-page adapter, whose fetcher
            // owns the Chromium render fallback.
            if (!fallback) throw error;
            onPath?.('vinted-catalog-api-fallback');
            return fallback.fetchPublicSearch(url);
          }
        }
      }
      const page = await pageFetcher(validation.url);
      onPath?.('vinted-catalog-page');
      return parseSearchPage(page.body, marketplace);
    },
    async fetchDetail(url) {
      const validation = validateSearchUrl(url, marketplace);
      if (!validation.valid) return { availability: availabilityUnknown(validation.reason) };
      let page: VintedPageFetchResult;
      try {
        page = await pageFetcher(validation.url);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Vinted detail verification failed';
        if (/\b(?:404|410)\b/.test(message)) return { availability: { status: 'terminal', reason: message.slice(0, 240) } };
        return { availability: availabilityUnknown(message) };
      }
      onPath?.('vinted-item-page');
      const availability = parseVintedItemPageAvailability(page.body, page.status);
      let listing: NormalizedListing | undefined;
      if (availability.status === 'live') {
        try { listing = parseStructuredListings(page.body, marketplace)[0]; } catch { listing = undefined; }
      }
      return { availability, listing };
    },
    async verifyAvailability(url) {
      return (await this.fetchDetail(url)).availability;
    },
  };
}
