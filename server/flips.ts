import { createHash } from 'node:crypto';
import {
  DEFAULT_FEE_PRESETS, FLIP_CHANNELS, LISTING_CHANNELS, LISTING_CHANNEL_STATUSES, LISTING_CONDITIONS, NO_DELIVERY, PARCEL_SIZES,
  isFlipChannel, isListingChannel, listingPrice, normalizeFeePresets, readyToListGaps, readyToListMessage, saleFee,
  type FeePresets, type FlipChannel, type FlipDelivery, type FlipListing, type FlipListingChannel, type ListingChannel, type ListingChannelStatus, type ListingCondition, type ParcelSize,
} from '../src/profit';
import sharp from 'sharp';
import type { Flip, FlipPhoto, FlipsData } from '../src/types';
import { FEE_PRESETS_KEY, ServiceError } from './service';

/** More than any of the three marketplaces takes per listing. */
export const MAX_FLIP_PHOTOS = 20;
export const MAX_FLIP_PHOTO_BYTES = 10 * 1024 * 1024;
/** Long edge of a stored photo; the marketplaces show no more than this. */
export const MAX_FLIP_PHOTO_EDGE = 2000;
/** A photo sent to Hatbot stays under about 2 MB once base64-encoded. */
export const MAX_POSTING_PHOTO_BYTES = 1_500_000;
/** Where each marketplace's own listings live. */
export const LISTING_HOSTS: Record<ListingChannel, string> = { OLX: 'olx.pl', 'Allegro Lokalnie': 'allegrolokalnie.pl', Vinted: 'vinted.pl' };
const MAX_LISTING_ERROR_CHARS = 500;

// One image at a time and no decoded-image cache: the server is small.
sharp.concurrency(1);
sharp.cache(false);

/** Recognise the image by its bytes, never by the declared type. */
export function sniffImageMime(data: Uint8Array): 'image/jpeg' | 'image/png' | 'image/webp' | null {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, index) => data[index] === byte)) return 'image/png';
  if (data.length >= 12 && String.fromCharCode(...data.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...data.subarray(8, 12)) === 'WEBP') return 'image/webp';
  return null;
}

/**
 * Store every photo as WebP: about a third of a JPEG's size at the same look,
 * and all three marketplaces take it. The camera's rotation is applied and the
 * metadata (GPS position included) is dropped. A WebP that is already small
 * enough is kept as it is, so it is never compressed twice.
 */
/**
 * A stored photo as a JPEG for posting, at most 2000 px on the long side,
 * stepping the quality down until it fits `MAX_POSTING_PHOTO_BYTES`.
 */
export async function toPostingJpeg(data: Uint8Array): Promise<Buffer> {
  try {
    let jpeg = Buffer.alloc(0);
    for (const quality of [85, 75, 65, 55]) {
      jpeg = await sharp(data, { failOn: 'error', limitInputPixels: 100_000_000 })
        .rotate()
        .resize({ width: MAX_FLIP_PHOTO_EDGE, height: MAX_FLIP_PHOTO_EDGE, fit: 'inside', withoutEnlargement: true })
        .flatten({ background: '#ffffff' })
        .jpeg({ quality, mozjpeg: true })
        .toBuffer();
      if (jpeg.byteLength <= MAX_POSTING_PHOTO_BYTES) break;
    }
    return jpeg;
  } catch {
    throw new ServiceError('The photo could not be read as an image', 415);
  }
}

/**
 * The URL of a new listing, checked to be on that marketplace's own host
 * (`www.olx.pl` and `m.olx.pl` count as olx.pl).
 */
export function listingUrlOn(channel: ListingChannel, raw: string | null | undefined): string {
  const host = LISTING_HOSTS[channel];
  let url: URL;
  try { url = new URL(String(raw ?? '').trim()); } catch { throw new ServiceError(`Recording ${channel} as listed needs the new listing's URL on ${host}`, 400); }
  const onHost = url.hostname === host || url.hostname.endsWith(`.${host}`);
  if (url.protocol !== 'https:' || url.username || url.password || !onHost) throw new ServiceError(`${url.href} is not an https:// address on ${host}`, 400);
  return url.href;
}

export async function toWebp(data: Uint8Array): Promise<Buffer> {
  try {
    const image = sharp(data, { failOn: 'error', limitInputPixels: 100_000_000 });
    const { format, width = 0, height = 0, orientation } = await image.metadata();
    if (format === 'webp' && Math.max(width, height) <= MAX_FLIP_PHOTO_EDGE && (orientation ?? 1) === 1) return Buffer.from(data);
    return await image
      .rotate()
      .resize({ width: MAX_FLIP_PHOTO_EDGE, height: MAX_FLIP_PHOTO_EDGE, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 85 })
      .toBuffer();
  } catch {
    throw new ServiceError('The photo could not be read as an image', 415);
  }
}

function listingFromJson(value: unknown): FlipListing | null {
  if (typeof value !== 'string' || !value) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { return null; }
  if (!parsed || typeof parsed !== 'object') return null;
  const raw = parsed as Record<string, unknown>;
  const prices: Partial<Record<FlipChannel, number>> = {};
  if (raw.prices && typeof raw.prices === 'object') {
    for (const channel of FLIP_CHANNELS) {
      const price = (raw.prices as Record<string, unknown>)[channel];
      if (typeof price === 'number' && Number.isFinite(price) && price > 0) prices[channel] = price;
    }
  }
  const condition = LISTING_CONDITIONS.includes(raw.condition as ListingCondition) ? raw.condition as ListingCondition : null;
  const delivery = (raw.delivery && typeof raw.delivery === 'object' ? raw.delivery : {}) as Record<string, unknown>;
  return {
    title: typeof raw.title === 'string' ? raw.title : '',
    description: typeof raw.description === 'string' ? raw.description : '',
    condition,
    ...(typeof raw.category === 'string' && raw.category.trim() ? { category: raw.category.trim().slice(0, 80) } : {}),
    prices,
    basePrice: typeof raw.basePrice === 'number' && Number.isFinite(raw.basePrice) && raw.basePrice > 0 ? raw.basePrice : null,
    delivery: {
      shipping: delivery.shipping === true,
      pickup: delivery.pickup === true,
      parcelSize: PARCEL_SIZES.includes(delivery.parcelSize as ParcelSize) ? delivery.parcelSize as ParcelSize : null,
    },
  };
}

function listingChannelsFromJson(value: unknown): FlipListingChannel[] {
  let parsed: unknown = [];
  try { parsed = JSON.parse(String(value ?? '[]')); } catch { parsed = []; }
  if (!Array.isArray(parsed)) return [];
  const byChannel = new Map<ListingChannel, FlipListingChannel>();
  for (const item of parsed) {
    if (!item || typeof item !== 'object' || !isListingChannel(item.channel) || !LISTING_CHANNEL_STATUSES.includes(item.status)) continue;
    byChannel.set(item.channel, {
      channel: item.channel,
      status: item.status,
      url: typeof item.url === 'string' && item.url ? item.url : null,
      error: typeof item.error === 'string' && item.error ? item.error : null,
      updatedAt: String(item.updatedAt ?? ''),
    });
  }
  return LISTING_CHANNELS.flatMap((channel) => byChannel.get(channel) ?? []);
}

/** What `scout_flip` hands Hatbot to post. */
export interface FlipToPost {
  id: number;
  updatedAt: string;
  title: string;
  description: string;
  condition: ListingCondition;
  category: string | null;
  delivery: FlipDelivery;
  prices: Partial<Record<ListingChannel, number>>;
  currency: 'PLN';
  photos: Array<{ id: number; mime: 'image/jpeg' }>;
}

export interface FlipInput {
  title: string;
  listingKey?: string | null;
  watchId?: string | null;
  buyChannel: FlipChannel;
  boughtOn: string;
  buyPrice: number;
  buyCosts?: number;
  listedOn?: FlipChannel[];
  note?: string;
}

export interface FlipPatch extends Partial<FlipInput> {
  /** null un-sells the flip and clears every sale field. */
  soldOn?: string | null;
  saleChannel?: FlipChannel | null;
  salePrice?: number | null;
  /** Omit to use the sale channel's fee preset at the moment of sale. */
  saleFee?: number | null;
  saleCosts?: number | null;
  delisted?: FlipChannel[];
}

const channels = (value: unknown): FlipChannel[] => {
  let parsed: unknown = [];
  try { parsed = JSON.parse(String(value ?? '[]')); } catch { parsed = []; }
  return Array.isArray(parsed) ? [...new Set(parsed.filter(isFlipChannel))] : [];
};
const num = (value: unknown) => (value === null || value === undefined ? null : Number(value));

function flipFromRow(row: Record<string, any>, photos: FlipPhoto[] = []): Flip {
  return {
    id: Number(row.id),
    title: String(row.title),
    listingKey: row.listing_key ?? null,
    watchId: row.watch_id ?? null,
    buyChannel: isFlipChannel(row.buy_channel) ? row.buy_channel : 'Other',
    boughtOn: String(row.bought_on),
    buyPrice: Number(row.buy_price_pln),
    buyCosts: Number(row.buy_costs_pln ?? 0),
    listedOn: channels(row.listed_on_json),
    soldOn: row.sold_on ?? null,
    saleChannel: isFlipChannel(row.sale_channel) ? row.sale_channel : null,
    salePrice: num(row.sale_price_pln),
    saleFee: num(row.sale_fee_pln),
    saleCosts: num(row.sale_costs_pln),
    delisted: channels(row.delisted_json),
    note: String(row.note ?? ''),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    listing: listingFromJson(row.listing_json),
    photos,
    readyToList: Boolean(row.listing_ready_at),
    listingChannels: listingChannelsFromJson(row.listing_channels_json),
    listingRevisedAt: row.listing_revised_at ?? null,
  };
}

/**
 * The operator's flip ledger. Kept apart from the marketplace tables on
 * purpose: nothing in scanning, scoring or alerting reads it, so the
 * operator's own buy and sale prices can never leak into asking-price
 * statistics.
 */
export class FlipStore {
  constructor(private db: any, private onChange: (payload: Record<string, unknown>) => void = () => {}) {}

  feePresets(): FeePresets {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(FEE_PRESETS_KEY) as { value?: string } | undefined;
    if (!row?.value) return { ...DEFAULT_FEE_PRESETS };
    try { return normalizeFeePresets(JSON.parse(row.value)); } catch { return { ...DEFAULT_FEE_PRESETS }; }
  }

  setFeePresets(presets: FeePresets) {
    const normalized = normalizeFeePresets(presets);
    this.db.prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run(FEE_PRESETS_KEY, JSON.stringify(normalized), new Date().toISOString());
    this.onChange({ feePresets: true });
    return normalized;
  }

  /** Photo metadata only, grouped by flip, in posting order. */
  private photosByFlip(flipId?: number) {
    const rows = (flipId === undefined
      ? this.db.prepare('SELECT id, flip_id, mime, byte_size FROM flip_photos ORDER BY flip_id, position, id').all()
      : this.db.prepare('SELECT id, flip_id, mime, byte_size FROM flip_photos WHERE flip_id = ? ORDER BY position, id').all(flipId)) as Array<Record<string, any>>;
    const byFlip = new Map<number, FlipPhoto[]>();
    for (const row of rows) {
      const list = byFlip.get(Number(row.flip_id)) ?? [];
      list.push({ id: Number(row.id), mime: String(row.mime), byteSize: Number(row.byte_size) });
      byFlip.set(Number(row.flip_id), list);
    }
    return byFlip;
  }

  list(): FlipsData {
    const rows = this.db.prepare('SELECT * FROM flips ORDER BY COALESCE(sold_on, bought_on) DESC, id DESC').all() as Array<Record<string, any>>;
    const photos = this.photosByFlip();
    return { flips: rows.map((row) => flipFromRow(row, photos.get(Number(row.id)) ?? [])), feePresets: this.feePresets() };
  }

  get(id: number): Flip {
    const row = this.db.prepare('SELECT * FROM flips WHERE id = ?').get(id) as Record<string, any> | undefined;
    if (!row) throw new ServiceError('Flip not found', 404);
    return flipFromRow(row, this.photosByFlip(id).get(id) ?? []);
  }

  /** A draft without `delivery` keeps the stored one, so older clients don't wipe it. */
  setListing(id: number, listing: FlipListing | null): Flip {
    const current = this.get(id);
    const next = listing ? { ...listing, delivery: listing.delivery ?? current.listing?.delivery ?? { ...NO_DELIVERY } } : null;
    this.assertStillComplete(current, next, current.photos.length);
    this.db.prepare('UPDATE flips SET listing_json = ?, updated_at = ? WHERE id = ?').run(next ? JSON.stringify(next) : null, new Date().toISOString(), id);
    this.revise(id);
    this.onChange({ id });
    return this.get(id);
  }

  /**
   * A flip marked ready keeps a complete draft, so Hatbot never sees one
   * with a gap: an edit that would leave one is refused.
   */
  private assertStillComplete(flip: Flip, listing: FlipListing | null, photoCount: number) {
    if (!flip.readyToList) return;
    const gaps = readyToListGaps(listing, photoCount, flip.listingChannels.map((item) => item.channel));
    if (gaps.length) throw new ServiceError(`This flip is ready to list, so its draft must keep ${gaps.join(', ')}. Cancel “Ready to list” first to change that.`, 400);
  }

  /** Everything that gets posted, hashed: text, delivery, prices, photos, channels. */
  private fingerprint(flip: Flip) {
    const channels = flip.listingChannels.map((item) => item.channel);
    const listing = flip.listing;
    return createHash('sha256').update(JSON.stringify({
      ready: flip.readyToList,
      channels,
      title: listing?.title ?? null,
      description: listing?.description ?? null,
      condition: listing?.condition ?? null,
      category: listing?.category ?? null,
      delivery: listing?.delivery ?? null,
      prices: channels.map((channel) => listingPrice(listing, channel)),
      photos: flip.photos.map((photo) => photo.id),
    })).digest('hex');
  }

  /**
   * Move the draft's revision when what gets posted changed (or `force`).
   * Hatbot asks the owner again on every new revision, so recording a
   * channel's status never calls this. Each revision is later than the last.
   */
  private revise(id: number, force = false) {
    const flip = this.get(id);
    const row = this.db.prepare('SELECT listing_fingerprint, listing_revised_at FROM flips WHERE id = ?').get(id) as { listing_fingerprint: string | null; listing_revised_at: string | null };
    const fingerprint = this.fingerprint(flip);
    if (!force && row.listing_fingerprint === fingerprint) return;
    const previous = row.listing_revised_at ? Date.parse(row.listing_revised_at) : 0;
    const revisedAt = new Date(Math.max(Date.now(), previous + 1)).toISOString();
    this.db.prepare('UPDATE flips SET listing_fingerprint = ?, listing_revised_at = ? WHERE id = ?').run(fingerprint, revisedAt, id);
  }

  /**
   * Mark a flip "Ready to list" on `picked`, or re-mark it. Channels already
   * listed stay picked; failed and declined ones go back to ready, which is
   * how the owner retries.
   */
  markReady(id: number, picked: ListingChannel[]): Flip {
    const flip = this.get(id);
    if (flip.soldOn) throw new ServiceError('This flip is already sold', 400);
    if (!picked.length) throw new ServiceError('Pick at least one marketplace to list it on', 400);
    const previous = new Map(flip.listingChannels.map((item) => [item.channel, item]));
    const channels = LISTING_CHANNELS.filter((channel) => picked.includes(channel) || previous.get(channel)?.status === 'listed');
    const gaps = readyToListGaps(flip.listing, flip.photos.length, channels);
    if (gaps.length) throw new ServiceError(readyToListMessage(gaps), 400);
    const now = new Date().toISOString();
    let retried = false;
    const next = channels.map((channel): FlipListingChannel => {
      const current = previous.get(channel);
      if (current?.status === 'listed' || (current?.status === 'ready' && flip.readyToList)) return current;
      if (current) retried = true;
      return { channel, status: 'ready', url: null, error: null, updatedAt: now };
    });
    this.db.prepare('UPDATE flips SET listing_ready_at = COALESCE(listing_ready_at, ?), listing_channels_json = ?, updated_at = ? WHERE id = ?').run(now, JSON.stringify(next), now, id);
    this.revise(id, !flip.readyToList || retried);
    this.onChange({ id });
    return this.get(id);
  }

  /** Take a flip out of `scout_flips_to_list`; listed channels keep their URL. */
  cancelReady(id: number): Flip {
    this.get(id);
    this.clearReady(id);
    this.onChange({ id });
    return this.get(id);
  }

  private clearReady(id: number) {
    const flip = this.get(id);
    if (!flip.readyToList) return;
    const listed = flip.listingChannels.filter((item) => item.status === 'listed');
    this.db.prepare('UPDATE flips SET listing_ready_at = NULL, listing_channels_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(listed), new Date().toISOString(), id);
    this.revise(id);
  }

  /**
   * Hatbot's report for one channel. `listed` is always kept, even after a
   * cancel, because the listing is live; `failed` and `declined` only change
   * a picked channel that isn't listed. Repeating a report changes nothing,
   * and the draft's revision never moves.
   */
  recordListing(flipId: number, channel: string, status: Exclude<ListingChannelStatus, 'ready'>, url?: string | null, error?: string | null) {
    if (!isListingChannel(channel)) throw new ServiceError(`Unknown channel "${channel}": use OLX, Allegro Lokalnie or Vinted`, 400);
    const flip = this.get(flipId);
    const current = flip.listingChannels.find((item) => item.channel === channel);
    let record: FlipListingChannel;
    let listedOn = flip.listedOn;
    if (status === 'listed') {
      const href = listingUrlOn(channel, url);
      if (current?.status === 'listed' && current.url === href && listedOn.includes(channel)) return;
      record = { channel, status, url: href, error: null, updatedAt: new Date().toISOString() };
      if (!listedOn.includes(channel)) listedOn = [...listedOn, channel];
    } else {
      if (!current || current.status === 'listed') return;
      const text = String(error ?? '').trim().slice(0, MAX_LISTING_ERROR_CHARS) || null;
      if (current.status === status && current.error === text) return;
      record = { channel, status, url: null, error: text, updatedAt: new Date().toISOString() };
    }
    const channels = LISTING_CHANNELS.flatMap((item) => (item === channel ? [record] : flip.listingChannels.filter((other) => other.channel === item)));
    this.db.prepare('UPDATE flips SET listing_channels_json = ?, listed_on_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(channels), JSON.stringify(listedOn), new Date().toISOString(), flipId);
    this.onChange({ id: flipId });
  }

  /** Flips marked ready, each with its draft revision and picked channels. */
  readyToList() {
    const rows = this.db.prepare('SELECT id, listing_revised_at, listing_channels_json FROM flips WHERE listing_ready_at IS NOT NULL ORDER BY listing_ready_at, id').all() as Array<Record<string, any>>;
    return rows.map((row) => ({
      id: Number(row.id),
      updatedAt: String(row.listing_revised_at),
      channels: listingChannelsFromJson(row.listing_channels_json).map(({ channel, status, url, error }) => ({ channel, status, ...(url ? { url } : {}), ...(error ? { error } : {}) })),
    }));
  }

  /** The draft of a flip marked ready, as Hatbot posts it. */
  toPost(id: number): FlipToPost {
    const flip = this.get(id);
    if (!flip.readyToList || !flip.listing?.condition) throw new ServiceError(`Flip ${id} is not marked ready to list`, 404);
    const listing = flip.listing;
    const prices: Partial<Record<ListingChannel, number>> = {};
    for (const { channel } of flip.listingChannels) {
      const price = listingPrice(listing, channel);
      if (price) prices[channel] = price;
    }
    return {
      id: flip.id,
      updatedAt: String(flip.listingRevisedAt),
      title: listing.title,
      description: listing.description,
      condition: listing.condition!,
      category: listing.category ?? null,
      delivery: listing.delivery ?? { ...NO_DELIVERY },
      prices,
      currency: 'PLN',
      photos: flip.photos.map((photo) => ({ id: photo.id, mime: 'image/jpeg' as const })),
    };
  }

  /** One photo of a flip marked ready, re-encoded as JPEG for posting. */
  async photoToPost(photoId: number) {
    const row = this.db.prepare('SELECT p.data, f.listing_ready_at FROM flip_photos p JOIN flips f ON f.id = p.flip_id WHERE p.id = ?').get(photoId) as { data: Uint8Array; listing_ready_at: string | null } | undefined;
    if (!row?.listing_ready_at) throw new ServiceError(`Photo ${photoId} is not on a flip marked ready to list`, 404);
    const jpeg = await toPostingJpeg(row.data);
    return { id: photoId, mime: 'image/jpeg' as const, base64: jpeg.toString('base64') };
  }

  async addPhoto(flipId: number, data: Uint8Array): Promise<FlipPhoto> {
    this.get(flipId);
    if (data.byteLength > MAX_FLIP_PHOTO_BYTES) throw new ServiceError('Photos can be at most 10 MB', 413);
    if (!sniffImageMime(data)) throw new ServiceError('Photos must be JPEG, PNG or WebP', 415);
    this.assertPhotoRoom(flipId);
    const webp = await toWebp(data);
    // Checked again after converting: other uploads may have landed meanwhile.
    this.get(flipId);
    this.assertPhotoRoom(flipId);
    const position = Number((this.db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS next FROM flip_photos WHERE flip_id = ?').get(flipId) as { next: number }).next);
    const result = this.db.prepare('INSERT INTO flip_photos (flip_id, position, mime, data, byte_size, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(flipId, position, 'image/webp', webp, webp.byteLength, new Date().toISOString());
    this.revise(flipId);
    this.onChange({ id: flipId });
    return { id: Number(result.lastInsertRowid), mime: 'image/webp', byteSize: webp.byteLength };
  }

  private assertPhotoRoom(flipId: number) {
    const count = Number((this.db.prepare('SELECT COUNT(*) AS count FROM flip_photos WHERE flip_id = ?').get(flipId) as { count: number }).count);
    if (count >= MAX_FLIP_PHOTOS) throw new ServiceError(`A flip can have at most ${MAX_FLIP_PHOTOS} photos`, 400);
  }

  /**
   * Convert photos stored before WebP became the format, one at a time.
   * Returns how many were converted; unreadable ones are left as they are.
   */
  async convertStoredPhotosToWebp(): Promise<number> {
    const ids = (this.db.prepare("SELECT id FROM flip_photos WHERE mime != 'image/webp' ORDER BY id").all() as Array<{ id: number }>).map((row) => Number(row.id));
    let converted = 0;
    for (const id of ids) {
      const row = this.db.prepare('SELECT flip_id, data FROM flip_photos WHERE id = ?').get(id) as { flip_id: number; data: Uint8Array } | undefined;
      if (!row) continue;
      let webp: Buffer;
      try { webp = await toWebp(row.data); } catch { continue; }
      this.db.prepare("UPDATE flip_photos SET mime = 'image/webp', data = ?, byte_size = ? WHERE id = ?").run(webp, webp.byteLength, id);
      this.onChange({ id: Number(row.flip_id) });
      converted += 1;
    }
    return converted;
  }

  photo(photoId: number): { mime: string; data: Uint8Array } | null {
    const row = this.db.prepare('SELECT mime, data FROM flip_photos WHERE id = ?').get(photoId) as { mime: string; data: Uint8Array } | undefined;
    return row ? { mime: row.mime, data: row.data } : null;
  }

  deletePhoto(photoId: number) {
    const row = this.db.prepare('SELECT flip_id FROM flip_photos WHERE id = ?').get(photoId) as { flip_id: number } | undefined;
    if (!row) throw new ServiceError('Photo not found', 404);
    const flip = this.get(Number(row.flip_id));
    this.assertStillComplete(flip, flip.listing, flip.photos.length - 1);
    this.db.prepare('DELETE FROM flip_photos WHERE id = ?').run(photoId);
    this.revise(flip.id);
    this.onChange({ id: flip.id });
  }

  /** Reorders a flip's photos; `ids` must be exactly its photos. */
  orderPhotos(flipId: number, ids: number[]): Flip {
    const current = (this.photosByFlip(flipId).get(flipId) ?? []).map((photo) => photo.id);
    if (ids.length !== current.length || new Set(ids).size !== ids.length || !ids.every((id) => current.includes(id))) {
      throw new ServiceError('Send every photo of this flip exactly once', 400);
    }
    const update = this.db.prepare('UPDATE flip_photos SET position = ? WHERE id = ?');
    ids.forEach((id, position) => update.run(position, id));
    this.revise(flipId);
    this.onChange({ id: flipId });
    return this.get(flipId);
  }

  create(input: FlipInput): Flip {
    const now = new Date().toISOString();
    const result = this.db.prepare(`INSERT INTO flips (title, listing_key, watch_id, buy_channel, bought_on, buy_price_pln, buy_costs_pln, listed_on_json, note, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      input.title, input.listingKey ?? null, input.watchId ?? null, input.buyChannel, input.boughtOn, input.buyPrice, input.buyCosts ?? 0,
      JSON.stringify([...new Set(input.listedOn ?? [])]), input.note ?? '', now, now,
    );
    this.onChange({ id: Number(result.lastInsertRowid) });
    return this.get(Number(result.lastInsertRowid));
  }

  update(id: number, patch: FlipPatch): Flip {
    const current = this.get(id);
    const next: Flip = { ...current };
    if (patch.title !== undefined) next.title = patch.title;
    if (patch.listingKey !== undefined) next.listingKey = patch.listingKey;
    if (patch.watchId !== undefined) next.watchId = patch.watchId;
    if (patch.buyChannel !== undefined) next.buyChannel = patch.buyChannel;
    if (patch.boughtOn !== undefined) next.boughtOn = patch.boughtOn;
    if (patch.buyPrice !== undefined) next.buyPrice = patch.buyPrice;
    if (patch.buyCosts !== undefined) next.buyCosts = patch.buyCosts;
    if (patch.listedOn !== undefined) next.listedOn = [...new Set(patch.listedOn)];
    if (patch.note !== undefined) next.note = patch.note;
    if (patch.delisted !== undefined) next.delisted = [...new Set(patch.delisted)];
    if (patch.soldOn === null) {
      Object.assign(next, { soldOn: null, saleChannel: null, salePrice: null, saleFee: null, saleCosts: null, delisted: [] });
    } else {
      if (patch.soldOn !== undefined) next.soldOn = patch.soldOn;
      if (patch.saleChannel !== undefined) next.saleChannel = patch.saleChannel;
      if (patch.salePrice !== undefined) next.salePrice = patch.salePrice;
      if (patch.saleCosts !== undefined) next.saleCosts = patch.saleCosts;
      if (patch.saleFee !== undefined) next.saleFee = patch.saleFee;
      const selling = next.soldOn !== null;
      if (selling && (next.salePrice === null || next.saleChannel === null)) throw new ServiceError('A sale needs a date, a channel and a price', 400);
      if (!selling && (patch.salePrice !== undefined || patch.saleChannel !== undefined)) throw new ServiceError('Set the sale date to record a sale', 400);
      if (selling && next.soldOn! < next.boughtOn) throw new ServiceError('The sale date cannot be before the purchase date', 400);
      // The fee is fixed when the sale is recorded, from the channel's preset,
      // unless the operator entered the actual fee.
      const saleChanged = patch.salePrice !== undefined || patch.saleChannel !== undefined;
      if (selling && patch.saleFee === undefined && (saleChanged || current.saleFee === null)) {
        next.saleFee = saleFee(next.salePrice!, this.feePresets()[next.saleChannel!]);
      }
    }
    this.db.prepare(`UPDATE flips SET title = ?, listing_key = ?, watch_id = ?, buy_channel = ?, bought_on = ?, buy_price_pln = ?, buy_costs_pln = ?, listed_on_json = ?,
      sold_on = ?, sale_channel = ?, sale_price_pln = ?, sale_fee_pln = ?, sale_costs_pln = ?, delisted_json = ?, note = ?, updated_at = ? WHERE id = ?`).run(
      next.title, next.listingKey, next.watchId, next.buyChannel, next.boughtOn, next.buyPrice, next.buyCosts, JSON.stringify(next.listedOn),
      next.soldOn, next.saleChannel, next.salePrice, next.saleFee, next.saleCosts, JSON.stringify(next.delisted), next.note, new Date().toISOString(), id,
    );
    // Sold: nothing left to post.
    if (next.soldOn) this.clearReady(id);
    this.onChange({ id });
    return this.get(id);
  }

  delete(id: number) {
    this.db.prepare('DELETE FROM flip_photos WHERE flip_id = ?').run(id);
    const result = this.db.prepare('DELETE FROM flips WHERE id = ?').run(id);
    if (!result.changes) throw new ServiceError('Flip not found', 404);
    this.onChange({ id, deleted: true });
  }
}
