import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Check, Download, LoaderCircle, MoreHorizontal, Pencil, Plus, RotateCcw, Trash2, Wallet, X } from "lucide-react";
import { api, forgetInFlightGets } from "./api";
import { subscribe, subscribeStatus } from "./events";
import {
  DAC7_THRESHOLD,
  FEE_PRESET_NOTES,
  FLIP_CHANNELS,
  UNREGISTERED_QUARTERLY_LIMITS,
  flipCost,
  flipNet,
  quarterOf,
  saleFee,
  salesRecord,
  salesRecordCsv,
  type FeePresets,
  type FlipChannel,
} from "./profit";
import { dayMonth, dayMonthYear, formatDate } from "./format";
import type { Flip } from "./types";
import { PageHeader } from "./ui";

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

/** "14 wrz" this year, "14 wrz 2025" otherwise; ledger dates are calendar days. */
const formatDay = (day: string) => {
  const date = new Date(`${day}T12:00:00`);
  return formatDate(date.getFullYear() === new Date().getFullYear() ? dayMonth : dayMonthYear, date);
};

function RowMenu({ label, items }: { label: string; items: Array<{ label: string; icon: React.ReactNode; danger?: boolean; onSelect: () => void }> }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="menu-anchor">
      <button className="icon-button" aria-label={label} title="More actions" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <MoreHorizontal size={17} />
      </button>
      {open ? (
        <div className="action-menu" role="menu">
          {items.map((item) => (
            <button key={item.label} role="menuitem" className={item.danger ? "danger-action" : undefined} onClick={() => { setOpen(false); item.onSelect(); }}>
              {item.icon}{item.label}
            </button>
          ))}
        </div>
      ) : null}
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

function Modal({ title, kicker, onClose, busy, children, footer }: { title: string; kicker?: string; onClose: () => void; busy: boolean; children: React.ReactNode; footer: React.ReactNode }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !busy) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, busy]);
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}>
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby="flip-dialog-title">
        <div className="modal-header">
          <div>{kicker ? <span className="modal-kicker">{kicker}</span> : null}<h2 id="flip-dialog-title">{title}</h2></div>
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
        <label className="field-label">Price paid (zł)<input inputMode="decimal" value={buyPrice} onChange={(event) => setBuyPrice(event.target.value)} placeholder="0" /></label>
        <label className="field-label" title="Shipping in, buyer fees, repairs">Extra costs (zł)<input inputMode="decimal" value={buyCosts} onChange={(event) => setBuyCosts(event.target.value)} placeholder="0" /></label>
      </div>
      <div className="field-label"><span title="Used for the delist checklist when it sells">Listed for sale on</span><ChannelToggles value={listedOn} onChange={setListedOn} /></div>
      <label className="field-label">Note <span className="field-hint-inline">optional</span><textarea value={note} onChange={(event) => setNote(event.target.value)} /></label>
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
        <label className="field-label">Sale price <span className="field-hint-inline">what the buyer paid for the item</span><input autoFocus inputMode="decimal" value={salePrice} onChange={(event) => setSalePrice(event.target.value)} placeholder="0" /></label>
        <label className="field-label">Platform fee <span className="field-hint-inline">{feePresets[channel].percent}%{feePresets[channel].fixed ? ` + ${formatZl(feePresets[channel].fixed)}` : ""} preset</span><input inputMode="decimal" value={feeOverride} onChange={(event) => setFeeOverride(event.target.value)} placeholder={formatZl(presetFee)} /></label>
      </div>
      <label className="field-label">Your selling costs <span className="field-hint-inline">shipping you paid, packaging</span><input inputMode="decimal" value={saleCosts} onChange={(event) => setSaleCosts(event.target.value)} placeholder="0" /></label>
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
    <details className="flips-panel flips-section">
      <summary>Seller fee presets</summary>
      <p className="field-hint">Prefill the platform fee when you record a sale, and the listing drawer's estimate. Private-seller rates as of September 2026; check them against your own account.</p>
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
    </details>
  );
}

export default function FlipsPage({ onToast }: { onToast: (message: string, type?: ToastType) => void }) {
  const [flips, setFlips] = useState<Flip[]>([]);
  const [feePresets, setFeePresets] = useState<FeePresets | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Flip | "new" | null>(null);
  const [selling, setSelling] = useState<Flip | null>(null);
  const today = todayDate();
  const current = quarterOf(today);
  const [recordQuarter, setRecordQuarter] = useState(`${current.year}-Q${current.quarter}`);
  const [ledgerView, setLedgerView] = useState<"unsold" | "sold" | null>(null);

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
  useEffect(() => { void load(); }, []);
  // A change from another tab or an MCP client emits 'flips'; a stream that
  // reconnects may have missed one, so it refetches too.
  useEffect(() => {
    const reload = () => {
      forgetInFlightGets();
      void load();
    };
    const unsubscribeFlips = subscribe("flips", reload);
    const unsubscribeStatus = subscribeStatus((_status, reconnected) => {
      if (reconnected) reload();
    });
    return () => {
      unsubscribeFlips();
      unsubscribeStatus();
    };
  }, []);

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
      soldCount: sold.length,
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

  // Unsold stock is what needs attention, so it opens first while there is any.
  const view = ledgerView ?? (summary.openCount ? "unsold" : "sold");
  const shown = flips.filter((flip) => (view === "unsold") === !flip.soldOn);
  const dac7Warning = summary.byPlatform.some((platform) => platform.count >= DAC7_THRESHOLD.sales * 0.8);

  return (
    <>
      <PageHeader title="Flips">
        <button className="primary-button" onClick={() => setEditing("new")}><Plus size={18} />Add flip</button>
      </PageHeader>

      <div className="overview-summary" aria-label="Flip summary">
        <span><strong>{formatZl(summary.quarterNet)}</strong> net in Q{current.quarter}</span>
        <span><strong>{formatZl(summary.yearNet)}</strong> net in {current.year}</span>
        <span><strong>{summary.openCount}</strong> unsold ({formatZl(summary.openCost)} tied up)</span>
      </div>

      {limit ? (
        <div
          className={`flips-limit ${limitShare !== null && limitShare >= 0.8 ? "flips-limit--warn" : ""}`}
          title="Działalność nierejestrowana: revenue (full sale prices) in a quarter may not exceed 225% of the minimum wage. Above it you have 7 days to register a business."
        >
          <small>
            Q{current.quarter} revenue {formatZl(summary.quarterRevenue)} of {formatZl(limit)}
            {limitShare !== null && limitShare >= 1 ? " · over the limit: register a business within 7 days" : ` · ${formatZl(limit - summary.quarterRevenue)} left`}
          </small>
          <div className="flips-limit-bar"><i style={{ width: `${Math.min(100, (limitShare ?? 0) * 100)}%` }} /></div>
        </div>
      ) : null}

      {summary.stillListed.length ? (
        <div className="form-error flips-alert" role="status"><AlertTriangle size={15} />Sold but still listed elsewhere: {summary.stillListed.map((flip) => `${flip.title} (${flip.listedOn.filter((channel) => channel !== flip.saleChannel && !flip.delisted.includes(channel)).join(", ")})`).join("; ")}.</div>
      ) : null}

      <section className="flips-panel">
        <div className="panel-title">
          <h3>Ledger</h3>
          <div className="segmented" role="group" aria-label="Ledger">
            <button type="button" aria-pressed={view === "unsold"} className={view === "unsold" ? "segmented-option segmented-option--active" : "segmented-option"} onClick={() => setLedgerView("unsold")}>Unsold ({summary.openCount})</button>
            <button type="button" aria-pressed={view === "sold"} className={view === "sold" ? "segmented-option segmented-option--active" : "segmented-option"} onClick={() => setLedgerView("sold")}>Sold ({summary.soldCount})</button>
          </div>
        </div>
        {loading ? (
          <div className="table-loading"><LoaderCircle size={18} className="spin" />Loading flips…</div>
        ) : shown.length ? (
          <div className="flips-table" role="table">
            <div className="flips-row flips-row--head" role="row"><span>Item</span><span>Bought</span><span>Cost</span><span>Sold</span><span>Net</span><span /></div>
            {shown.map((flip) => {
              const net = flipNet(flip);
              return (
                <div className="flips-row" role="row" key={flip.id}>
                  <span><strong>{flip.title}</strong>{flip.note ? <small>{flip.note}</small> : null}{!flip.soldOn && flip.listedOn.length ? <small>Listed on {flip.listedOn.join(", ")}</small> : null}</span>
                  <span data-label="Bought">{formatDay(flip.boughtOn)}<small>{flip.buyChannel}</small></span>
                  <span data-label="Cost">{formatZl(flipCost(flip))}</span>
                  {flip.soldOn ? <span data-label="Sold">{formatZl(flip.salePrice!)}<small>{formatDay(flip.soldOn)} · {flip.saleChannel}{flip.saleFee ? ` · fee ${formatZl(flip.saleFee)}` : ""}</small></span> : <span className="flips-row-empty" />}
                  {flip.soldOn ? <strong data-label="Net" className={net === null ? "" : net >= 0 ? "result-positive" : "result-negative"}>{net === null ? "—" : formatZl(net)}</strong> : <span className="flips-row-empty" />}
                  <span className="flips-actions">
                    {flip.soldOn ? null : <button className="outline-button" onClick={() => setSelling(flip)} disabled={!feePresets}>Mark sold</button>}
                    <RowMenu
                      label={`More actions for ${flip.title}`}
                      items={[
                        ...(flip.soldOn ? [{ label: "Edit sale", icon: <Pencil size={15} />, onSelect: () => setSelling(flip) }] : []),
                        { label: flip.soldOn ? "Edit purchase" : "Edit", icon: <Pencil size={15} />, onSelect: () => setEditing(flip) },
                        ...(flip.soldOn ? [{ label: "Remove sale", icon: <RotateCcw size={15} />, onSelect: () => void unsell(flip) }] : []),
                        { label: "Delete", icon: <Trash2 size={15} />, danger: true, onSelect: () => void remove(flip) },
                      ]}
                    />
                  </span>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="page-empty">
            <Wallet size={22} />
            <strong>{flips.length ? (view === "unsold" ? "Everything has sold" : "No sales recorded yet") : "No flips yet"}</strong>
            <span>{flips.length ? "" : "Add one here, or use “I bought this” in a listing's details. Your own prices never feed Scout's market statistics."}</span>
          </div>
        )}
      </section>

      <details className="flips-panel flips-section" open={dac7Warning}>
        <summary>DAC7: sales per platform in {current.year}</summary>
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
      </details>

      <details className="flips-panel flips-section">
        <summary>Sales record (uproszczona ewidencja sprzedaży)</summary>
        <div className="flips-record-controls">
          <select aria-label="Quarter" value={recordQuarter} onChange={(event) => setRecordQuarter(event.target.value)}>
            {quarterOptions.map((key) => <option key={key} value={key}>{key.replace("-", " ")}</option>)}
          </select>
          <button className="outline-button" disabled={!record.length} onClick={downloadRecord}><Download size={15} />Download CSV</button>
        </div>
        {record.length ? (
          <div className="flips-table flips-table--record" role="table">
            <div className="flips-row flips-row--head" role="row"><span>Lp.</span><span>Date</span><span>Sales that day</span><span>Quarter to date</span></div>
            {record.map((row) => (
              <div className="flips-row" role="row" key={row.date}><span>{row.index}</span><span>{formatDay(row.date)}</span><span>{formatZl(row.daySales)}</span><strong>{formatZl(row.quarterToDate)}</strong></div>
            ))}
          </div>
        ) : <div className="panel-empty">No sales in {recordQuarter.replace("-", " ")}.</div>}
      </details>

      {feePresets ? <FeePresetsPanel key={JSON.stringify(feePresets)} presets={feePresets} onSaved={setFeePresets} onToast={onToast} /> : null}

      {editing ? <FlipDialog flip={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={(flip) => { replaceFlip(flip); setEditing(null); onToast(`${flip.title} saved.`); }} /> : null}
      {selling && feePresets ? <SellDialog flip={selling} feePresets={feePresets} onClose={() => setSelling(null)} onSaved={(flip) => { replaceFlip(flip); setSelling(null); onToast(`Sale of ${flip.title} recorded.`); }} /> : null}
    </>
  );
}
