import { DEFAULT_FEE_PRESETS, FLIP_CHANNELS, LISTING_CONDITIONS, isFlipChannel, normalizeFeePresets, saleFee, type FeePresets, type FlipChannel, type FlipListing, type ListingCondition } from '../src/profit';
import type { Flip, FlipPhoto, FlipsData } from '../src/types';
import { ServiceError } from './service';

const FEE_PRESETS_KEY = 'flip_fee_presets';
/** More than any of the three marketplaces takes per listing. */
export const MAX_FLIP_PHOTOS = 20;
export const MAX_FLIP_PHOTO_BYTES = 10 * 1024 * 1024;

/** Recognise the image by its bytes, never by the declared type. */
export function sniffImageMime(data: Uint8Array): 'image/jpeg' | 'image/png' | 'image/webp' | null {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, index) => data[index] === byte)) return 'image/png';
  if (data.length >= 12 && String.fromCharCode(...data.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...data.subarray(8, 12)) === 'WEBP') return 'image/webp';
  return null;
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
  return {
    title: typeof raw.title === 'string' ? raw.title : '',
    description: typeof raw.description === 'string' ? raw.description : '',
    condition,
    prices,
    basePrice: typeof raw.basePrice === 'number' && Number.isFinite(raw.basePrice) && raw.basePrice > 0 ? raw.basePrice : null,
  };
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

  setListing(id: number, listing: FlipListing | null): Flip {
    this.get(id);
    this.db.prepare('UPDATE flips SET listing_json = ?, updated_at = ? WHERE id = ?').run(listing ? JSON.stringify(listing) : null, new Date().toISOString(), id);
    this.onChange({ id });
    return this.get(id);
  }

  addPhoto(flipId: number, data: Uint8Array): FlipPhoto {
    this.get(flipId);
    if (data.byteLength > MAX_FLIP_PHOTO_BYTES) throw new ServiceError('Photos can be at most 10 MB', 413);
    const mime = sniffImageMime(data);
    if (!mime) throw new ServiceError('Photos must be JPEG, PNG or WebP', 415);
    const count = Number((this.db.prepare('SELECT COUNT(*) AS count FROM flip_photos WHERE flip_id = ?').get(flipId) as { count: number }).count);
    if (count >= MAX_FLIP_PHOTOS) throw new ServiceError(`A flip can have at most ${MAX_FLIP_PHOTOS} photos`, 400);
    const position = Number((this.db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS next FROM flip_photos WHERE flip_id = ?').get(flipId) as { next: number }).next);
    const result = this.db.prepare('INSERT INTO flip_photos (flip_id, position, mime, data, byte_size, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(flipId, position, mime, data, data.byteLength, new Date().toISOString());
    this.onChange({ id: flipId });
    return { id: Number(result.lastInsertRowid), mime, byteSize: data.byteLength };
  }

  photo(photoId: number): { mime: string; data: Uint8Array } | null {
    const row = this.db.prepare('SELECT mime, data FROM flip_photos WHERE id = ?').get(photoId) as { mime: string; data: Uint8Array } | undefined;
    return row ? { mime: row.mime, data: row.data } : null;
  }

  deletePhoto(photoId: number) {
    const row = this.db.prepare('SELECT flip_id FROM flip_photos WHERE id = ?').get(photoId) as { flip_id: number } | undefined;
    if (!row) throw new ServiceError('Photo not found', 404);
    this.db.prepare('DELETE FROM flip_photos WHERE id = ?').run(photoId);
    this.onChange({ id: Number(row.flip_id) });
  }

  /** Reorders a flip's photos; `ids` must be exactly its photos. */
  orderPhotos(flipId: number, ids: number[]): Flip {
    const current = (this.photosByFlip(flipId).get(flipId) ?? []).map((photo) => photo.id);
    if (ids.length !== current.length || new Set(ids).size !== ids.length || !ids.every((id) => current.includes(id))) {
      throw new ServiceError('Send every photo of this flip exactly once', 400);
    }
    const update = this.db.prepare('UPDATE flip_photos SET position = ? WHERE id = ?');
    ids.forEach((id, position) => update.run(position, id));
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
