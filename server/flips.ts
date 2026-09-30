import { DEFAULT_FEE_PRESETS, isFlipChannel, normalizeFeePresets, saleFee, type FeePresets, type FlipChannel } from '../src/profit';
import type { Flip, FlipsData } from '../src/types';
import { ServiceError } from './service';

const FEE_PRESETS_KEY = 'flip_fee_presets';

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

function flipFromRow(row: Record<string, any>): Flip {
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

  list(): FlipsData {
    const rows = this.db.prepare('SELECT * FROM flips ORDER BY COALESCE(sold_on, bought_on) DESC, id DESC').all() as Array<Record<string, any>>;
    return { flips: rows.map(flipFromRow), feePresets: this.feePresets() };
  }

  get(id: number): Flip {
    const row = this.db.prepare('SELECT * FROM flips WHERE id = ?').get(id) as Record<string, any> | undefined;
    if (!row) throw new ServiceError('Flip not found', 404);
    return flipFromRow(row);
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
    const result = this.db.prepare('DELETE FROM flips WHERE id = ?').run(id);
    if (!result.changes) throw new ServiceError('Flip not found', 404);
    this.onChange({ id, deleted: true });
  }
}
