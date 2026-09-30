import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, ArrowLeft, ArrowRight, Check, Download, ImagePlus, LoaderCircle, Megaphone, Pencil, Plus, RotateCcw, Trash2, Wallet, X } from "lucide-react";
import { api } from "./api";
import {
  DAC7_THRESHOLD,
  FEE_PRESET_NOTES,
  FLIP_CHANNELS,
  LISTING_CONDITIONS,
  LISTING_CONDITION_LABELS,
  UNREGISTERED_QUARTERLY_LIMITS,
  suggestedListingPrice,
  flipCost,
  flipNet,
  quarterOf,
  saleFee,
  salesRecord,
  salesRecordCsv,
  type FeePresets,
  type FlipChannel,
  type FlipListing,
  type ListingCondition,
} from "./profit";
import type { Flip, FlipPhoto } from "./types";

type ToastType = "success" | "error" | "info";

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "Something went wrong";

export const formatZl = (value: number) =>
  `${value.toLocaleString("pl-PL", { minimumFractionDigits: Number.isInteger(value) ? 0 : 2, maximumFractionDigits: 2 })} zł`;

/** Today as the operator's calendar date. */
export const todayDate = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
};

const toAmount = (raw: string) => {
  if (raw.trim() === "") return 0;
  const value = Number(raw.replace(",", "."));
  return Number.isFinite(value) && value >= 0 ? value : NaN;
};

function Stat({ label, value, detail, title }: { label: string; value: string; detail: string; title?: string }) {
  return (
    <div className="stat" title={title}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  );
}

function ChannelToggles({ value, onChange, exclude = [] }: { value: FlipChannel[]; onChange: (next: FlipChannel[]) => void; exclude?: FlipChannel[] }) {
  return (
    <div className="source-options">
      {FLIP_CHANNELS.filter((channel) => !exclude.includes(channel)).map((channel) => (
        <button
          key={channel}
          type="button"
          className={`source-option ${value.includes(channel) ? "source-option--selected" : ""}`}
          aria-pressed={value.includes(channel)}
          onClick={() => onChange(value.includes(channel) ? value.filter((item) => item !== channel) : [...value, channel])}
        >
          {channel}
          {value.includes(channel) ? <Check size={15} /> : null}
        </button>
      ))}
    </div>
  );
}

function Modal({ title, kicker, onClose, busy, children, footer }: { title: string; kicker: string; onClose: () => void; busy: boolean; children: React.ReactNode; footer: React.ReactNode }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !busy) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, busy]);
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}>
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby="flip-dialog-title">
        <div className="modal-header">
          <div><span className="modal-kicker">{kicker}</span><h2 id="flip-dialog-title">{title}</h2></div>
          <button className="icon-button" disabled={busy} onClick={onClose} aria-label="Close"><X size={20} /></button>
        </div>
        <div className="modal-body">{children}</div>
        <div className="modal-footer">{footer}</div>
      </section>
    </div>
  );
}

function FlipDialog({ flip, onClose, onSaved }: { flip: Flip | null; onClose: () => void; onSaved: (flip: Flip) => void }) {
  const [title, setTitle] = useState(flip?.title ?? "");
  const [boughtOn, setBoughtOn] = useState(flip?.boughtOn ?? todayDate());
  const [buyChannel, setBuyChannel] = useState<FlipChannel>(flip?.buyChannel ?? "OLX");
  const [buyPrice, setBuyPrice] = useState(flip ? String(flip.buyPrice) : "");
  const [buyCosts, setBuyCosts] = useState(flip && flip.buyCosts ? String(flip.buyCosts) : "");
  const [listedOn, setListedOn] = useState<FlipChannel[]>(flip?.listedOn ?? []);
  const [note, setNote] = useState(flip?.note ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const price = toAmount(buyPrice);
  const costs = toAmount(buyCosts);
  const valid = Boolean(title.trim() && boughtOn && buyPrice.trim() && Number.isFinite(price) && Number.isFinite(costs));
  const save = async () => {
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      const body = { title: title.trim(), boughtOn, buyChannel, buyPrice: price, buyCosts: costs, listedOn, note: note.trim() };
      const result = flip ? await api.updateFlip(flip.id, body) : await api.createFlip(body);
      onSaved(result.flip);
    } catch (saveError) {
      setError(errorMessage(saveError));
      setBusy(false);
    }
  };
  return (
    <Modal
      kicker="Flip ledger"
      title={flip ? "Edit flip" : "Add a flip"}
      onClose={onClose}
      busy={busy}
      footer={<><button className="outline-button" disabled={busy} onClick={onClose}>Cancel</button><button className="primary-button" disabled={!valid || busy} onClick={() => void save()}>{busy ? <LoaderCircle size={17} className="spin" /> : <Check size={17} />}{flip ? "Save flip" : "Add flip"}</button></>}
    >
      <label className="field-label">Item<input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} placeholder="e.g. Gigabyte RTX 3070 Eagle" /></label>
      <div className="field-row">
        <label className="field-label">Bought on<input type="date" value={boughtOn} onChange={(event) => setBoughtOn(event.target.value)} /></label>
        <label className="field-label">Bought from<select value={buyChannel} onChange={(event) => setBuyChannel(event.target.value as FlipChannel)}>{FLIP_CHANNELS.map((channel) => <option key={channel}>{channel}</option>)}</select></label>
      </div>
      <div className="field-row">
        <label className="field-label">Price paid <span>PLN</span><input inputMode="decimal" value={buyPrice} onChange={(event) => setBuyPrice(event.target.value)} placeholder="0" /></label>
        <label className="field-label">Extra costs <span>shipping in, buyer fees, repairs</span><input inputMode="decimal" value={buyCosts} onChange={(event) => setBuyCosts(event.target.value)} placeholder="0" /></label>
      </div>
      <div className="field-label"><span>Listed for sale on <span>used for the delist checklist</span></span><ChannelToggles value={listedOn} onChange={setListedOn} /></div>
      <label className="field-label">Note <span>optional</span><textarea value={note} onChange={(event) => setNote(event.target.value)} /></label>
      {error ? <div className="form-error" role="alert"><AlertTriangle size={15} />{error}</div> : null}
    </Modal>
  );
}

function SellDialog({ flip, feePresets, onClose, onSaved }: { flip: Flip; feePresets: FeePresets; onClose: () => void; onSaved: (flip: Flip) => void }) {
  const [soldOn, setSoldOn] = useState(flip.soldOn ?? todayDate());
  const [channel, setChannel] = useState<FlipChannel>(flip.saleChannel ?? flip.listedOn[0] ?? "OLX");
  const [salePrice, setSalePrice] = useState(flip.salePrice === null ? "" : String(flip.salePrice));
  const [feeOverride, setFeeOverride] = useState(flip.saleFee === null ? "" : String(flip.saleFee));
  const [saleCosts, setSaleCosts] = useState(flip.saleCosts ? String(flip.saleCosts) : "");
  const [delisted, setDelisted] = useState<FlipChannel[]>(flip.delisted);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const price = toAmount(salePrice);
  const presetFee = Number.isFinite(price) ? saleFee(price, feePresets[channel]) : 0;
  const fee = feeOverride.trim() === "" ? presetFee : toAmount(feeOverride);
  const costs = toAmount(saleCosts);
  const valid = Boolean(soldOn && salePrice.trim() && Number.isFinite(price) && price > 0 && Number.isFinite(fee) && Number.isFinite(costs) && soldOn >= flip.boughtOn);
  const net = valid ? flipNet({ buyPrice: flip.buyPrice, buyCosts: flip.buyCosts, salePrice: price, saleFee: fee, saleCosts: costs }) : null;
  const otherListings = flip.listedOn.filter((listed) => listed !== channel);
  const save = async () => {
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.updateFlip(flip.id, { soldOn, saleChannel: channel, salePrice: price, saleFee: fee, saleCosts: costs, delisted: delisted.filter((item) => otherListings.includes(item)) });
      onSaved(result.flip);
    } catch (saveError) {
      setError(errorMessage(saveError));
      setBusy(false);
    }
  };
  return (
    <Modal
      kicker={flip.title}
      title={flip.soldOn ? "Edit sale" : "Mark as sold"}
      onClose={onClose}
      busy={busy}
      footer={<><button className="outline-button" disabled={busy} onClick={onClose}>Cancel</button><button className="primary-button" disabled={!valid || busy} onClick={() => void save()}>{busy ? <LoaderCircle size={17} className="spin" /> : <Check size={17} />}Save sale</button></>}
    >
      <div className="field-row">
        <label className="field-label">Sold on<input type="date" value={soldOn} min={flip.boughtOn} onChange={(event) => setSoldOn(event.target.value)} /></label>
        <label className="field-label">Sold on platform<select value={channel} onChange={(event) => { setChannel(event.target.value as FlipChannel); setFeeOverride(""); }}>{FLIP_CHANNELS.map((option) => <option key={option}>{option}</option>)}</select></label>
      </div>
      <div className="field-row">
        <label className="field-label">Sale price <span>what the buyer paid for the item</span><input autoFocus inputMode="decimal" value={salePrice} onChange={(event) => setSalePrice(event.target.value)} placeholder="0" /></label>
        <label className="field-label">Platform fee <span>{feePresets[channel].percent}%{feePresets[channel].fixed ? ` + ${formatZl(feePresets[channel].fixed)}` : ""} preset</span><input inputMode="decimal" value={feeOverride} onChange={(event) => setFeeOverride(event.target.value)} placeholder={formatZl(presetFee)} /></label>
      </div>
      <label className="field-label">Your selling costs <span>shipping you paid, packaging</span><input inputMode="decimal" value={saleCosts} onChange={(event) => setSaleCosts(event.target.value)} placeholder="0" /></label>
      {otherListings.length ? (
        <div className="field-label">
          <span>Delist everywhere else <span>so it cannot sell twice</span></span>
          <ChannelToggles value={delisted} onChange={setDelisted} exclude={FLIP_CHANNELS.filter((item) => !otherListings.includes(item))} />
          {otherListings.some((item) => !delisted.includes(item)) ? <small className="field-hint">Still listed on {otherListings.filter((item) => !delisted.includes(item)).join(", ")}. Tick each one once you have taken it down.</small> : <small className="field-hint">Taken down everywhere else.</small>}
        </div>
      ) : null}
      <div className="calculator-results">
        <div><span>Cost</span><strong>{formatZl(flipCost(flip))}</strong></div>
        <div><span>Net profit</span><strong className={net === null ? "" : net >= 0 ? "result-positive" : "result-negative"}>{net === null ? "—" : formatZl(net)}</strong></div>
      </div>
      {error ? <div className="form-error" role="alert"><AlertTriangle size={15} />{error}</div> : null}
    </Modal>
  );
}

/** The marketplaces the browser extension fills. */
const LISTING_PLATFORMS = FLIP_CHANNELS.filter((channel) => channel !== "Other");
const MAX_PHOTO_EDGE = 2000;

/**
 * Phone photos are several megabytes; the marketplaces resize them anyway.
 * Shrink to 2000 px on the long edge as JPEG, keeping small JPEGs as they are.
 */
async function prepareForUpload(file: File): Promise<Blob> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new Error(`${file.name}: this browser can't read the image. Export it as JPEG (HEIC is not supported).`);
  }
  const scale = Math.min(1, MAX_PHOTO_EDGE / Math.max(bitmap.width, bitmap.height));
  if (scale === 1 && file.type === "image/jpeg" && file.size <= 4 * 1024 * 1024) {
    bitmap.close();
    return file;
  }
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return new Promise((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error(`${file.name}: could not convert the image`))), "image/jpeg", 0.88));
}

function ListingDialog({ flip, feePresets, onClose, onSaved }: { flip: Flip; feePresets: FeePresets; onClose: () => void; onSaved: (flip: Flip) => void }) {
  const draft = flip.listing;
  const [title, setTitle] = useState(draft?.title ?? flip.title);
  const [description, setDescription] = useState(draft?.description ?? "");
  const [condition, setCondition] = useState<ListingCondition | "">(draft?.condition ?? "");
  const [basePrice, setBasePrice] = useState(draft?.basePrice ? String(draft.basePrice) : "");
  const [prices, setPrices] = useState<Record<string, string>>(() => Object.fromEntries(LISTING_PLATFORMS.map((channel) => [channel, draft?.prices[channel] ? String(draft.prices[channel]) : ""])));
  const [photos, setPhotos] = useState<FlipPhoto[]>(flip.photos);
  const [uploading, setUploading] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const base = toAmount(basePrice);
  const suggestion = (channel: FlipChannel) => (Number.isFinite(base) && base > 0 ? suggestedListingPrice(base, feePresets[channel]) : null);
  const priceFor = (channel: FlipChannel) => {
    const entered = prices[channel]?.trim() ? toAmount(prices[channel]) : null;
    return entered !== null && Number.isFinite(entered) && entered > 0 ? entered : suggestion(channel);
  };
  const valid = Boolean(title.trim()) && (basePrice.trim() === "" || (Number.isFinite(base) && base > 0)) && LISTING_PLATFORMS.every((channel) => !prices[channel]?.trim() || (Number.isFinite(toAmount(prices[channel])) && toAmount(prices[channel]) > 0));

  const addPhotos = async (files: FileList | null) => {
    if (!files?.length) return;
    setError(null);
    try {
      for (const [index, file] of [...files].entries()) {
        setUploading(`Uploading ${index + 1} of ${files.length}…`);
        const result = await api.uploadFlipPhoto(flip.id, await prepareForUpload(file));
        setPhotos((current) => [...current, result.photo]);
      }
    } catch (uploadError) {
      setError(errorMessage(uploadError));
    } finally {
      setUploading(null);
    }
  };
  const move = async (index: number, offset: number) => {
    const next = [...photos];
    const [photo] = next.splice(index, 1);
    next.splice(index + offset, 0, photo);
    setPhotos(next);
    try { await api.orderFlipPhotos(flip.id, next.map((item) => item.id)); } catch (orderError) { setError(errorMessage(orderError)); setPhotos(photos); }
  };
  const removePhoto = async (photo: FlipPhoto) => {
    try { await api.deleteFlipPhoto(photo.id); setPhotos((current) => current.filter((item) => item.id !== photo.id)); } catch (deleteError) { setError(errorMessage(deleteError)); }
  };
  const save = async () => {
    if (!valid) return;
    setBusy(true);
    setError(null);
    const listing: FlipListing = {
      title: title.trim(),
      description,
      condition: condition || null,
      basePrice: Number.isFinite(base) && base > 0 ? base : null,
      prices: Object.fromEntries(LISTING_PLATFORMS.flatMap((channel) => { const price = priceFor(channel); return price ? [[channel, price]] : []; })),
    };
    try {
      const result = await api.saveFlipListing(flip.id, listing);
      onSaved({ ...result.flip, photos });
    } catch (saveError) {
      setError(errorMessage(saveError));
      setBusy(false);
    }
  };
  return (
    <Modal
      kicker={flip.title}
      title="Listing"
      onClose={onClose}
      busy={busy || Boolean(uploading)}
      footer={<><button className="outline-button" disabled={busy} onClick={onClose}>Close</button><button className="primary-button" disabled={!valid || busy || Boolean(uploading)} onClick={() => void save()}>{busy ? <LoaderCircle size={17} className="spin" /> : <Check size={17} />}Save listing</button></>}
    >
      <p className="field-hint">What the Scout browser extension fills into the OLX, Allegro Lokalnie and Vinted forms. You check each form and publish it yourself.</p>
      <label className="field-label">Title <span>{title.trim().length} characters</span><input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={200} /></label>
      <label className="field-label">Description <span>{description.length} characters</span><textarea rows={7} value={description} onChange={(event) => setDescription(event.target.value)} maxLength={9000} placeholder="Model, condition, what's included, tested how, why you're selling" /></label>
      <div className="field-row">
        <label className="field-label">Condition<select value={condition} onChange={(event) => setCondition(event.target.value as ListingCondition | "")}><option value="">Set on each site</option>{LISTING_CONDITIONS.map((option) => <option key={option} value={option}>{LISTING_CONDITION_LABELS[option].label}</option>)}</select></label>
        <label className="field-label">You want to receive <span>before fees, PLN</span><input inputMode="decimal" value={basePrice} onChange={(event) => setBasePrice(event.target.value)} placeholder="e.g. 1450" /></label>
      </div>
      <div className="field-label">
        <span>Asking price per platform <span>empty = suggested from your fee presets</span></span>
        <div className="listing-prices">
          {LISTING_PLATFORMS.map((channel) => {
            const price = priceFor(channel);
            const fee = price ? saleFee(price, feePresets[channel]) : 0;
            return (
              <label key={channel}>
                <strong>{channel}</strong>
                <input inputMode="decimal" aria-label={`${channel} asking price`} value={prices[channel]} placeholder={suggestion(channel) ? String(suggestion(channel)) : "—"} onChange={(event) => setPrices((current) => ({ ...current, [channel]: event.target.value }))} />
                <small>{price ? `${formatZl(price - fee)} after ${fee ? formatZl(fee) + " fee" : "no fee"}` : "set a price"}</small>
              </label>
            );
          })}
        </div>
      </div>
      <div className="field-label">
        <span>Photos <span>{photos.length} of 20 · first one is the cover</span></span>
        <div className="listing-photos">
          {photos.map((photo, index) => (
            <figure key={photo.id}>
              <img src={api.flipPhotoUrl(photo.id)} alt={`Photo ${index + 1}`} loading="lazy" />
              <figcaption>
                <button type="button" className="icon-button" aria-label="Move earlier" disabled={index === 0} onClick={() => void move(index, -1)}><ArrowLeft size={14} /></button>
                <button type="button" className="icon-button" aria-label="Delete photo" onClick={() => void removePhoto(photo)}><Trash2 size={14} /></button>
                <button type="button" className="icon-button" aria-label="Move later" disabled={index === photos.length - 1} onClick={() => void move(index, 1)}><ArrowRight size={14} /></button>
              </figcaption>
            </figure>
          ))}
          {photos.length < 20 ? (
            <label className="listing-photo-add">
              {uploading ? <LoaderCircle size={18} className="spin" /> : <ImagePlus size={18} />}
              <span>{uploading ?? "Add photos"}</span>
              <input type="file" accept="image/jpeg,image/png,image/webp" multiple disabled={Boolean(uploading)} onChange={(event) => { void addPhotos(event.target.files); event.target.value = ""; }} />
            </label>
          ) : null}
        </div>
        <small className="field-hint">Photos are resized to at most 2000 px and stored on your Scout server. The iOS app can add them straight from your phone.</small>
      </div>
      {error ? <div className="form-error" role="alert"><AlertTriangle size={15} />{error}</div> : null}
    </Modal>
  );
}

function FeePresetsPanel({ presets, onSaved, onToast }: { presets: FeePresets; onSaved: (presets: FeePresets) => void; onToast: (message: string, type?: ToastType) => void }) {
  const [draft, setDraft] = useState(() => Object.fromEntries(FLIP_CHANNELS.map((channel) => [channel, { percent: String(presets[channel].percent), fixed: String(presets[channel].fixed) }])) as Record<FlipChannel, { percent: string; fixed: string }>);
  const [busy, setBusy] = useState(false);
  const parsed = FLIP_CHANNELS.map((channel) => [channel, { percent: toAmount(draft[channel].percent), fixed: toAmount(draft[channel].fixed) }] as const);
  const valid = parsed.every(([, preset]) => Number.isFinite(preset.percent) && preset.percent <= 50 && Number.isFinite(preset.fixed) && preset.fixed <= 1000);
  const save = async () => {
    setBusy(true);
    try {
      const result = await api.saveFeePresets(Object.fromEntries(parsed) as FeePresets);
      onSaved(result.feePresets);
      onToast("Fee presets saved. Recorded sales keep the fee they were saved with.");
    } catch (saveError) {
      onToast(errorMessage(saveError), "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="flips-panel">
      <div className="panel-title"><h3>Seller fee presets</h3></div>
      <p className="field-hint">Used to prefill the platform fee when you record a sale and for estimates in the listing drawer. They are private-seller rates as of September 2026; check them against your own account.</p>
      <div className="fee-preset-grid">
        {FLIP_CHANNELS.map((channel) => (
          <div className="fee-preset-row" key={channel}>
            <strong>{channel}</strong>
            <label>%<input inputMode="decimal" aria-label={`${channel} fee percent`} value={draft[channel].percent} onChange={(event) => setDraft((current) => ({ ...current, [channel]: { ...current[channel], percent: event.target.value } }))} /></label>
            <label>+ zł<input inputMode="decimal" aria-label={`${channel} fixed fee`} value={draft[channel].fixed} onChange={(event) => setDraft((current) => ({ ...current, [channel]: { ...current[channel], fixed: event.target.value } }))} /></label>
            <small>{FEE_PRESET_NOTES[channel]}</small>
          </div>
        ))}
      </div>
      <button className="outline-button" disabled={!valid || busy} onClick={() => void save()}>{busy ? <LoaderCircle size={15} className="spin" /> : <Check size={15} />}Save presets</button>
    </section>
  );
}

export default function FlipsPage({ refreshKey, onToast }: { refreshKey: number; onToast: (message: string, type?: ToastType) => void }) {
  const [flips, setFlips] = useState<Flip[]>([]);
  const [feePresets, setFeePresets] = useState<FeePresets | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Flip | "new" | null>(null);
  const [selling, setSelling] = useState<Flip | null>(null);
  const [listing, setListing] = useState<Flip | null>(null);
  const today = todayDate();
  const current = quarterOf(today);
  const [recordQuarter, setRecordQuarter] = useState(`${current.year}-Q${current.quarter}`);

  const load = async () => {
    try {
      const result = await api.flips();
      setFlips(result.flips);
      setFeePresets(result.feePresets);
    } catch (loadError) {
      onToast(errorMessage(loadError), "error");
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { void load(); }, [refreshKey]);

  const summary = useMemo(() => {
    const sold = flips.filter((flip) => flip.soldOn && flip.salePrice !== null);
    const inYear = sold.filter((flip) => quarterOf(flip.soldOn!).year === current.year);
    const inQuarter = inYear.filter((flip) => quarterOf(flip.soldOn!).quarter === current.quarter);
    const sum = (items: Flip[], pick: (flip: Flip) => number) => items.reduce((total, flip) => total + pick(flip), 0);
    const open = flips.filter((flip) => !flip.soldOn);
    const byPlatform = FLIP_CHANNELS.filter((channel) => channel !== "Other").map((channel) => {
      const sales = inYear.filter((flip) => flip.saleChannel === channel);
      return { channel, count: sales.length, revenue: sum(sales, (flip) => flip.salePrice!) };
    });
    return {
      quarterRevenue: sum(inQuarter, (flip) => flip.salePrice!),
      quarterNet: sum(inQuarter, (flip) => flipNet(flip) ?? 0),
      yearNet: sum(inYear, (flip) => flipNet(flip) ?? 0),
      yearSales: inYear.length,
      openCount: open.length,
      openCost: sum(open, flipCost),
      byPlatform,
      stillListed: sold.filter((flip) => flip.listedOn.some((channel) => channel !== flip.saleChannel && !flip.delisted.includes(channel))),
    };
  }, [flips, current.year, current.quarter]);

  const limit = UNREGISTERED_QUARTERLY_LIMITS[current.year] ?? null;
  const limitShare = limit ? summary.quarterRevenue / limit : null;
  const quarterOptions = useMemo(() => {
    const keys = new Set([`${current.year}-Q${current.quarter}`]);
    for (const flip of flips) if (flip.soldOn) { const { year, quarter } = quarterOf(flip.soldOn); keys.add(`${year}-Q${quarter}`); }
    return [...keys].sort().reverse();
  }, [flips, current.year, current.quarter]);
  const [recordYear, recordQ] = recordQuarter.split("-Q").map(Number);
  const record = useMemo(() => salesRecord(flips, recordYear, recordQ), [flips, recordYear, recordQ]);

  const downloadRecord = () => {
    // BOM so Excel opens the Polish headers as UTF-8.
    const url = URL.createObjectURL(new Blob(["﻿", salesRecordCsv(record)], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `ewidencja-sprzedazy-${recordYear}-Q${recordQ}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const replaceFlip = (flip: Flip) => setFlips((items) => items.some((item) => item.id === flip.id) ? items.map((item) => (item.id === flip.id ? flip : item)) : [flip, ...items]);
  const unsell = async (flip: Flip) => {
    if (!window.confirm(`Remove the recorded sale of ${flip.title}?`)) return;
    try { replaceFlip((await api.updateFlip(flip.id, { soldOn: null })).flip); } catch (error) { onToast(errorMessage(error), "error"); }
  };
  const remove = async (flip: Flip) => {
    if (!window.confirm(`Delete ${flip.title} from the ledger? This cannot be undone.`)) return;
    try { await api.deleteFlip(flip.id); setFlips((items) => items.filter((item) => item.id !== flip.id)); } catch (error) { onToast(errorMessage(error), "error"); }
  };

  return (
    <>
      <header className="page-header page-header--inner">
        <div>
          <h1>Flips</h1>
          <p>What you bought, where it is listed, and what each sale actually netted. Your own prices stay here and never feed Scout's market statistics.</p>
        </div>
        <button className="primary-button" onClick={() => setEditing("new")}><Plus size={19} />Add flip</button>
      </header>

      <section className="research-stats" aria-label="Flip summary">
        <Stat
          label={`Revenue Q${current.quarter} ${current.year}`}
          value={formatZl(summary.quarterRevenue)}
          detail={limit ? `of ${formatZl(limit)} · ${Math.round((limitShare ?? 0) * 100)}%` : "no limit on record for this year"}
          title="Działalność nierejestrowana: revenue (full sale prices) in a quarter may not exceed 225% of the minimum wage. Above it you have 7 days to register a business."
        />
        <Stat label="Net this quarter" value={formatZl(summary.quarterNet)} detail={`${formatZl(summary.yearNet)} this year`} />
        <Stat label="Unsold" value={String(summary.openCount)} detail={`${formatZl(summary.openCost)} tied up`} />
        <Stat label={`Sales ${current.year}`} value={String(summary.yearSales)} detail="across all platforms" />
      </section>

      {limit ? (
        <div className={`flips-limit ${limitShare !== null && limitShare >= 0.8 ? "flips-limit--warn" : ""}`}>
          <div className="flips-limit-bar"><i style={{ width: `${Math.min(100, (limitShare ?? 0) * 100)}%` }} /></div>
          <small>{limitShare !== null && limitShare >= 1 ? "Over the quarterly limit for działalność nierejestrowana: register a business within 7 days." : limitShare !== null && limitShare >= 0.8 ? `${formatZl(limit - summary.quarterRevenue)} left before the quarterly limit.` : `${formatZl(limit - summary.quarterRevenue)} left in this quarter's limit.`}</small>
        </div>
      ) : null}

      {summary.stillListed.length ? (
        <div className="form-error flips-alert" role="status"><AlertTriangle size={15} />Sold but still listed elsewhere: {summary.stillListed.map((flip) => `${flip.title} (${flip.listedOn.filter((channel) => channel !== flip.saleChannel && !flip.delisted.includes(channel)).join(", ")})`).join("; ")}.</div>
      ) : null}

      <section className="flips-panel">
        <div className="panel-title"><Wallet size={16} /><h3>Ledger</h3></div>
        {loading ? (
          <div className="table-loading"><LoaderCircle size={18} className="spin" />Loading flips…</div>
        ) : flips.length ? (
          <div className="flips-table" role="table">
            <div className="flips-row flips-row--head" role="row"><span>Item</span><span>Bought</span><span>Cost</span><span>Sold</span><span>Net</span><span /></div>
            {flips.map((flip) => {
              const net = flipNet(flip);
              return (
                <div className="flips-row" role="row" key={flip.id}>
                  <span><strong>{flip.title}</strong>{flip.note ? <small>{flip.note}</small> : null}{!flip.soldOn && flip.listedOn.length ? <small>Listed on {flip.listedOn.join(", ")}</small> : null}{!flip.soldOn && (flip.listing || flip.photos.length) ? <small>Listing ready{flip.photos.length ? ` · ${flip.photos.length} photo${flip.photos.length === 1 ? "" : "s"}` : ""}</small> : null}</span>
                  <span>{flip.boughtOn}<small>{flip.buyChannel}</small></span>
                  <span>{formatZl(flipCost(flip))}</span>
                  <span>{flip.soldOn ? <>{formatZl(flip.salePrice!)}<small>{flip.soldOn} · {flip.saleChannel}{flip.saleFee ? ` · fee ${formatZl(flip.saleFee)}` : ""}</small></> : <em className="decision-chip decision-chip--watch">Unsold</em>}</span>
                  <strong className={net === null ? "" : net >= 0 ? "result-positive" : "result-negative"}>{net === null ? "—" : formatZl(net)}</strong>
                  <span className="flips-actions">
                    <button className="outline-button" onClick={() => setSelling(flip)} disabled={!feePresets}>{flip.soldOn ? "Edit sale" : "Mark sold"}</button>
                    {!flip.soldOn ? <button className="icon-button" aria-label={`Listing for ${flip.title}`} title="Listing text, prices and photos" disabled={!feePresets} onClick={() => setListing(flip)}><Megaphone size={15} /></button> : null}
                    {flip.soldOn ? <button className="icon-button" aria-label={`Remove the sale of ${flip.title}`} title="Remove sale" onClick={() => void unsell(flip)}><RotateCcw size={15} /></button> : null}
                    <button className="icon-button" aria-label={`Edit ${flip.title}`} onClick={() => setEditing(flip)}><Pencil size={15} /></button>
                    <button className="icon-button" aria-label={`Delete ${flip.title}`} onClick={() => void remove(flip)}><Trash2 size={15} /></button>
                  </span>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="page-empty"><Wallet size={22} /><strong>No flips yet</strong><span>Add one here, or use “I bought this” in a listing's details.</span></div>
        )}
      </section>

      <section className="flips-panel">
        <div className="panel-title"><h3>DAC7 · sales per platform in {current.year}</h3></div>
        <p className="field-hint">A platform reports you to the tax office once you reach {DAC7_THRESHOLD.sales} sales or {DAC7_THRESHOLD.euro.toLocaleString("pl-PL")} € of sales on it in a year. It is only a report and creates no tax by itself.</p>
        <div className="flips-dac7">
          {summary.byPlatform.map((platform) => (
            <div key={platform.channel} className={platform.count >= DAC7_THRESHOLD.sales * 0.8 ? "flips-dac7--warn" : ""}>
              <span>{platform.channel}</span>
              <strong>{platform.count} / {DAC7_THRESHOLD.sales}</strong>
              <small>{formatZl(platform.revenue)} in sales</small>
            </div>
          ))}
        </div>
      </section>

      <section className="flips-panel">
        <div className="panel-title">
          <h3>Sales record (uproszczona ewidencja sprzedaży)</h3>
          <select aria-label="Quarter" value={recordQuarter} onChange={(event) => setRecordQuarter(event.target.value)}>
            {quarterOptions.map((key) => <option key={key} value={key}>{key.replace("-", " ")}</option>)}
          </select>
          <button className="icon-button" aria-label="Download the sales record as CSV" title="Download CSV" disabled={!record.length} onClick={downloadRecord}><Download size={16} /></button>
        </div>
        <p className="field-hint">One row per day with sales, with the running total for the quarter. Keep it for działalność nierejestrowana; purchase costs are recorded separately above.</p>
        {record.length ? (
          <div className="flips-table flips-table--record" role="table">
            <div className="flips-row flips-row--head" role="row"><span>Lp.</span><span>Date</span><span>Sales that day</span><span>Quarter to date</span></div>
            {record.map((row) => (
              <div className="flips-row" role="row" key={row.date}><span>{row.index}</span><span>{row.date}</span><span>{formatZl(row.daySales)}</span><strong>{formatZl(row.quarterToDate)}</strong></div>
            ))}
          </div>
        ) : <div className="panel-empty">No sales in {recordQuarter.replace("-", " ")}.</div>}
      </section>

      {feePresets ? <FeePresetsPanel key={JSON.stringify(feePresets)} presets={feePresets} onSaved={setFeePresets} onToast={onToast} /> : null}

      {editing ? <FlipDialog flip={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={(flip) => { replaceFlip(flip); setEditing(null); onToast(`${flip.title} saved.`); }} /> : null}
      {listing && feePresets ? <ListingDialog flip={listing} feePresets={feePresets} onClose={() => { setListing(null); void load(); }} onSaved={(flip) => { replaceFlip(flip); setListing(null); onToast(`Listing for ${flip.title} saved.`); }} /> : null}
      {selling && feePresets ? <SellDialog flip={selling} feePresets={feePresets} onClose={() => setSelling(null)} onSaved={(flip) => { replaceFlip(flip); setSelling(null); onToast(`Sale of ${flip.title} recorded.`); }} /> : null}
    </>
  );
}
