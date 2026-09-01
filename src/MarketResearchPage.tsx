import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  BarChart3,
  Check,
  ChevronDown,
  Clock3,
  Database,
  ExternalLink,
  Eye,
  Info,
  LoaderCircle,
  Pause,
  Play,
  Plus,
  RefreshCw,
  SlidersHorizontal,
  Tag,
  Trash2,
  X,
} from "lucide-react";
import { api } from "./api";
import { marketplaceColors } from "./data";
import type {
  Marketplace,
  MarketListingSnapshot,
  MarketResearchData,
  MarketTrackedListing,
  MarketWatch,
  MarketWatchInput,
} from "./types";

type ToastType = "success" | "error" | "info";

const formatPln = (value: number | null) =>
  value === null ? "Learning" : `${value.toLocaleString("pl-PL")} zł`;

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "Something went wrong";

function safeImageUrl(value: string | null | undefined) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function PageHeader({
  title,
  description,
  action,
  onAction,
}: {
  title: string;
  description?: string;
  action?: string;
  onAction?: () => void;
}) {
  return (
    <header className="page-header page-header--inner">
      <div>
        <h1>{title}</h1>
        {description ? <p>{description}</p> : null}
      </div>
      {action ? (
        <button className="primary-button" onClick={onAction}>
          <Plus size={19} />
          {action}
        </button>
      ) : null}
    </header>
  );
}

function Stat({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="stat">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  );
}

function SelectControl({
  value,
  options,
  onChange,
}: {
  value: string;
  options: Array<string | { value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  return (
    <label className="select-control">
      <select aria-label={value} value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => {
          const item = typeof option === "string" ? { value: option, label: option } : option;
          return <option key={item.value} value={item.value}>{item.label}</option>;
        })}
      </select>
      <ChevronDown size={16} />
    </label>
  );
}

export default function MarketResearchPage({
  refreshKey,
  onToast,
}: {
  refreshKey: number;
  onToast: (message: string, type?: ToastType) => void;
}) {
  const [data, setData] = useState<MarketResearchData>({ watches: [], listings: [] });
  const [loading, setLoading] = useState(true);
  const [showDialog, setShowDialog] = useState(false);
  const [editingWatch, setEditingWatch] = useState<MarketWatch | null>(null);
  const [selectedWatch, setSelectedWatch] = useState<string>("All");
  const [status, setStatus] = useState<"All" | "active" | "ended" | "superseded">("All");
  const [page, setPage] = useState(1);
  const [busyIds, setBusyIds] = useState<Set<string>>(() => new Set());
  const [rowBusy, setRowBusy] = useState<Set<number>>(() => new Set());
  const [snapshotListing, setSnapshotListing] = useState<MarketTrackedListing | null>(null);

  const load = useCallback(async (showLoader = false) => {
    if (showLoader) setLoading(true);
    try {
      setData(await api.marketResearch({
        page,
        pageSize: 100,
        watchId: selectedWatch === "All" ? undefined : selectedWatch,
        status: status === "All" ? undefined : status,
      }));
    } catch (error) {
      onToast(errorMessage(error), "error");
    } finally {
      if (showLoader) setLoading(false);
    }
  }, [onToast, page, selectedWatch, status]);

  useEffect(() => { void load(true); }, [load]);
  useEffect(() => { if (refreshKey) void load(false); }, [load, refreshKey]);

  const withBusy = async (watch: MarketWatch, action: () => Promise<void>) => {
    setBusyIds((current) => new Set(current).add(watch.id));
    try {
      await action();
    } finally {
      setBusyIds((current) => {
        const next = new Set(current);
        next.delete(watch.id);
        return next;
      });
    }
  };
  const openCreate = () => { setEditingWatch(null); setShowDialog(true); };
  const openEdit = (watch: MarketWatch) => { setEditingWatch(watch); setShowDialog(true); };
  const closeDialog = () => { if (showDialog) { setShowDialog(false); setEditingWatch(null); } };
  const create = async (input: MarketWatchInput) => {
    const result = await api.createMarketWatch(input);
    closeDialog();
    await load(false);
    onToast(`${result.watch.name} created. Its first market snapshot is running.`, "info");
  };
  const update = async (input: MarketWatchInput) => {
    if (!editingWatch) return;
    await api.updateMarketWatch(editingWatch.id, input);
    closeDialog();
    await load(false);
    onToast(`${input.name} filters saved. The next scan will use them.`);
  };
  const toggle = (watch: MarketWatch) => withBusy(watch, async () => {
    await api.updateMarketWatch(watch.id, { enabled: !watch.enabled });
    await load(false);
    onToast(watch.enabled ? `${watch.name} paused.` : `${watch.name} resumed.`);
  });
  const scan = (watch: MarketWatch) => withBusy(watch, async () => {
    const result = await api.scanMarketWatch(watch.id);
    onToast(`${result.message}. Results will update shortly.`, "info");
  });
  const remove = (watch: MarketWatch) => withBusy(watch, async () => {
    if (!window.confirm(`Delete “${watch.name}” and its saved research history?`)) return;
    await api.deleteMarketWatch(watch.id);
    if (selectedWatch === watch.id) setSelectedWatch("All");
    await load(false);
    onToast(`${watch.name} deleted.`);
  });
  const saveCopy = async (listing: MarketTrackedListing) => {
    setRowBusy((current) => new Set(current).add(listing.id));
    try {
      await api.captureMarketListingSnapshot(listing.id);
      onToast(`Saved a copy of “${listing.title}”.`, "success");
      await load(false);
    } catch (error) {
      onToast(errorMessage(error), "error");
    } finally {
      setRowBusy((current) => {
        const next = new Set(current);
        next.delete(listing.id);
        return next;
      });
    }
  };

  const visible = useMemo(
    () => data.listings.filter((listing) =>
      (selectedWatch === "All" || listing.marketWatchId === selectedWatch)
      && (status === "All" || listing.status === status)),
    [data.listings, selectedWatch, status],
  );
  const totalEnded = data.aggregates?.endedCount ?? data.watches.reduce((sum, watch) => sum + watch.endedListings, 0);
  const totalActive = data.aggregates?.activeCount ?? data.watches.reduce((sum, watch) => sum + watch.activeListings, 0);
  const overallEstimate = data.aggregates?.overallMedianPrice ?? null;

  return (
    <>
      <PageHeader title="Market research" description="Daily snapshots that reveal asking-price movement and estimate where listings leave the market." action="New research watch" onAction={openCreate} />
      <div className="research-explainer"><BarChart3 size={22} /><div><strong>Track the market, separately from deal alerts.</strong><span>Scout records every observed asking price. A listing is marked “no longer available” only after three verified terminal checks. A missing or blocked search result alone is never treated as a sale.</span></div></div>
      <section className="research-stats" aria-label="Market research summary">
        <Stat label="Research watches" value={String(data.watches.length)} detail={`${data.watches.filter((watch) => watch.enabled).length} active`} />
        <Stat label="Live listings" value={String(totalActive)} detail="currently observed" />
        <Stat label="Ended listings" value={String(totalEnded)} detail="verified unavailable" />
        <Stat label="Median estimate" value={overallEstimate === null ? "—" : formatPln(overallEstimate)} detail="last asking price" />
      </section>
      <div className="research-section-heading"><h2>Research watches</h2><span>Default cadence: once every 24 hours</span></div>
      {loading ? (
        <div className="table-loading"><LoaderCircle size={20} className="spin" />Loading market research…</div>
      ) : data.watches.length ? (
        <div className="research-watch-list">
          {data.watches.map((watch) => (
            <article className={`research-watch ${watch.enabled ? "" : "research-watch--paused"}`} key={watch.id}>
              <div className="research-watch-heading"><div><strong>{watch.name}</strong><span>{watch.query}</span></div><span className={`state-chip state-chip--${watch.enabled ? "ready" : "paused"}`}><i />{watch.enabled ? "Active" : "Paused"}</span></div>
              <div className="research-watch-sources">{watch.sources.map((source) => <span key={source}><i style={{ background: marketplaceColors[source] }} />{source}</span>)}</div>
              <MarketWatchFilterSummary watch={watch} />
              <div className="research-watch-metrics"><div><span>Tracked</span><strong>{watch.totalListings}</strong></div><div><span>Ended</span><strong>{watch.endedListings}</strong></div><div><span>Median estimate</span><strong>{watch.estimatedMedianPrice === null ? "—" : formatPln(watch.estimatedMedianPrice)}</strong></div></div>
              <div className="research-watch-footer"><span><Clock3 size={14} />Every {watch.intervalHours}h · Last {watch.lastScan} · Next {watch.nextScan}</span><div><button className="icon-button" title="Edit research filters" aria-label={`Edit ${watch.name}`} disabled={busyIds.has(watch.id)} onClick={() => openEdit(watch)}><SlidersHorizontal size={16} /></button><button className="icon-button" title="Scan research watch now" aria-label={`Scan ${watch.name} now`} disabled={busyIds.has(watch.id) || !watch.enabled} onClick={() => void scan(watch)}>{busyIds.has(watch.id) ? <LoaderCircle size={16} className="spin" /> : <RefreshCw size={16} />}</button><button className={`toggle ${watch.enabled ? "toggle--on" : ""}`} aria-label={watch.enabled ? `Pause ${watch.name}` : `Resume ${watch.name}`} disabled={busyIds.has(watch.id)} onClick={() => void toggle(watch)}>{watch.enabled ? <Pause size={13} /> : <Play size={13} />}</button><button className="icon-button danger-icon" title="Delete research watch" aria-label={`Delete ${watch.name}`} disabled={busyIds.has(watch.id)} onClick={() => void remove(watch)}><Trash2 size={16} /></button></div></div>
            </article>
          ))}
        </div>
      ) : (
        <div className="page-empty"><BarChart3 size={28} /><strong>No market research watches yet</strong><span>Create one to start collecting daily asking-price snapshots.</span><button className="primary-button" onClick={openCreate}><Plus size={17} />New research watch</button></div>
      )}
      {data.watches.length ? (
        <section className="research-history">
          <div className="section-heading-row"><h2>Saved listings</h2><div className="filters"><SelectControl value={selectedWatch} options={[{ value: "All", label: "All research watches" }, ...data.watches.map((watch) => ({ value: watch.id, label: watch.name }))]} onChange={(value) => { setSelectedWatch(value); setPage(1); }} /><SelectControl value={status} options={[{ value: "All", label: "All statuses" }, { value: "active", label: "Active" }, { value: "ended", label: "No longer available" }, { value: "superseded", label: "Previous series" }]} onChange={(value) => { setStatus(value as typeof status); setPage(1); }} /></div></div>
          <MarketResearchTable listings={visible} onViewSnapshot={setSnapshotListing} rowBusy={rowBusy} onSaveCopy={saveCopy} />
          {data.pagination && (data.pagination.page > 1 || data.pagination.hasNext) ? <div className="research-pagination"><button className="outline-button" disabled={page <= 1 || loading} onClick={() => setPage((current) => Math.max(1, current - 1))}>Previous</button><span>Page {data.pagination.page} · {data.pagination.total.toLocaleString("pl-PL")} listings</span><button className="outline-button" disabled={!data.pagination.hasNext || loading} onClick={() => setPage((current) => current + 1)}>Next</button></div> : null}
        </section>
      ) : null}
      {showDialog ? <MarketWatchDialog key={editingWatch?.id ?? "new"} initialWatch={editingWatch} onClose={closeDialog} onSubmit={editingWatch ? update : create} /> : null}
      {snapshotListing ? <MarketListingSnapshotModal listing={snapshotListing} onClose={() => setSnapshotListing(null)} onToast={onToast} onSaved={() => void load(false)} /> : null}
    </>
  );
}

function MarketWatchFilterSummary({ watch }: { watch: MarketWatch }) {
  const tags: string[] = [];
  if (watch.terms) tags.push(`include: ${watch.terms}`);
  if (watch.excluded) tags.push(`exclude: ${watch.excluded}`);
  if (watch.minPrice !== null || watch.maxPrice !== null) tags.push(`price: ${watch.minPrice === null ? "0" : watch.minPrice.toLocaleString("pl-PL")}–${watch.maxPrice === null ? "∞" : watch.maxPrice.toLocaleString("pl-PL")} zł`);
  if (watch.condition !== "Any") tags.push(`condition: ${watch.condition}`);
  if (watch.location && watch.location !== "Polska") tags.push(`location: ${watch.location}`);
  if (watch.shippingOnly) tags.push("shipping only");
  return <div className="research-watch-filters">{tags.length ? tags.map((tag) => <span key={tag}>{tag}</span>) : <span>All prices · any condition</span>}</div>;
}

function MarketResearchTable({ listings, onViewSnapshot, rowBusy, onSaveCopy }: {
  listings: MarketTrackedListing[];
  onViewSnapshot: (listing: MarketTrackedListing) => void;
  rowBusy: Set<number>;
  onSaveCopy: (listing: MarketTrackedListing) => Promise<void>;
}) {
  if (!listings.length) return <div className="empty-state"><Database size={24} /><strong>No saved listings in this view</strong><span>The first successful snapshot will populate this history.</span></div>;
  return (
    <div className="research-table-wrap" role="table" aria-label="Market research listings">
      <div className="research-table research-table--head" role="row"><span role="columnheader">Listing</span><span role="columnheader">Status</span><span role="columnheader">First price</span><span role="columnheader">Last price</span><span role="columnheader">Change</span><span role="columnheader">Observations</span><span role="columnheader">Last seen / ended</span><span role="columnheader" /></div>
      {listings.map((listing) => (
        <div className="research-table research-listing-row" role="row" key={listing.id}>
          <div className="research-listing" role="cell"><MarketThumbnail listing={listing} /><div><strong>{listing.title}</strong><span><i style={{ background: marketplaceColors[listing.marketplace] }} />{listing.marketplace} · {listing.watchName}</span></div></div>
          <span className={`research-status research-status--${listing.status}`} role="cell"><i />{listing.status === "ended" ? "No longer available" : listing.status === "superseded" ? "Previous series" : listing.missingScans ? `Verifying (${listing.missingScans}/3)` : "Active"}{listing.snapshotStatus === "saved" ? <small>copy saved</small> : null}</span>
          <span data-label="First price" role="cell">{formatPln(listing.firstPrice)}</span>
          <strong data-label="Last price" role="cell">{formatPln(listing.lastPrice)}{listing.status === "ended" ? <small>last asking price · not a confirmed sale</small> : null}</strong>
          <span data-label="Change" role="cell" className={listing.priceChangePercent < 0 ? "price-down" : listing.priceChangePercent > 0 ? "price-up" : ""}>{listing.priceChangePercent === 0 ? "—" : `${listing.priceChangePercent > 0 ? "+" : ""}${listing.priceChangePercent.toFixed(1)}%`}</span>
          <span data-label="Observations" role="cell">{listing.observations}</span>
          <span data-label="Last seen / ended" role="cell">{new Date(listing.endedAt ?? listing.lastSeenAt).toLocaleDateString("pl-PL", { day: "2-digit", month: "short", year: "numeric" })}</span>
          <span role="cell" className="research-row-actions">
            <button
              className="icon-button"
              title={listing.snapshotStatus === "saved" ? "View the preserved listing copy" : "View or preserve a listing copy"}
              aria-label={`View saved copy of ${listing.title}`}
              onClick={() => onViewSnapshot(listing)}
            >
              <Eye size={17} />
            </button>
            <button
              className="icon-button"
              title="Save a fresh copy of this listing now"
              aria-label={`Save a copy of ${listing.title}`}
              disabled={rowBusy.has(listing.id)}
              onClick={() => void onSaveCopy(listing)}
            >
              {rowBusy.has(listing.id) ? <LoaderCircle size={17} className="spin" /> : <Database size={17} />}
            </button>
            <a href={listing.url} target="_blank" rel="noreferrer" className="external-link" aria-label={`Open ${listing.title}`}><ExternalLink size={17} /></a>
          </span>
        </div>
      ))}
    </div>
  );
}

function MarketListingSnapshotModal({ listing, onClose, onToast, onSaved }: {
  listing: MarketTrackedListing;
  onClose: () => void;
  onToast: (message: string, type?: ToastType) => void;
  onSaved: () => void;
}) {
  const [snapshot, setSnapshot] = useState<MarketListingSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [lightbox, setLightbox] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.marketListingSnapshot(listing.id)
      .then((result) => { if (!cancelled) setSnapshot(result.snapshot); })
      .catch((error) => onToast(errorMessage(error), "error"))
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [listing.id, onToast]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving) {
        if (lightbox) setLightbox(null);
        else onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lightbox, onClose, saving]);

  const saveCopy = async () => {
    setSaving(true);
    try {
      const result = await api.captureMarketListingSnapshot(listing.id);
      setSnapshot(result.snapshot);
      onToast("Listing copy saved locally.", "success");
      onSaved();
    } catch (error) {
      onToast(errorMessage(error), "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !saving && onClose()}>
      <section className="modal modal--snapshot" role="dialog" aria-modal="true" aria-labelledby="snapshot-title">
        <div className="modal-header">
          <div>
            <span className="modal-kicker">Preserved listing copy</span>
            <h2 id="snapshot-title">{listing.title}</h2>
            <p>
              {listing.marketplace} · {formatPln(listing.lastPrice)} ·{" "}
              {listing.status === "ended" ? "no longer available — the copy below is what Scout preserved" : "a local copy that stays viewable if the listing is sold"}
            </p>
          </div>
          <button className="icon-button" disabled={saving} onClick={onClose} aria-label="Close"><X size={20} /></button>
        </div>
        <div className="modal-body modal-body--snapshot">
          {loading ? (
            <div className="table-loading"><LoaderCircle size={20} className="spin" />Loading the preserved copy…</div>
          ) : snapshot ? (
            <>
              <div className="snapshot-meta">
                <span>Saved {new Date(snapshot.capturedAt).toLocaleString("pl-PL", { dateStyle: "medium", timeStyle: "short" })}</span>
                {snapshot.condition ? <span>Condition: {snapshot.condition}</span> : null}
                {snapshot.location ? <span>Location: {snapshot.location}</span> : null}
                <span>{snapshot.images.length} image{snapshot.images.length === 1 ? "" : "s"} stored</span>
              </div>
              {snapshot.images.length ? (
                <div className="snapshot-gallery">
                  {snapshot.images.map((image) => (
                    <button type="button" key={image.id} className="snapshot-thumb" onClick={() => setLightbox(api.marketSnapshotImageUrl(image.id))} aria-label={`Open image ${image.position + 1}`}>
                      <img src={api.marketSnapshotImageUrl(image.id)} alt="" loading="lazy" />
                    </button>
                  ))}
                </div>
              ) : (
                <div className="snapshot-empty-gallery"><Tag size={20} /><span>No images were stored for this copy.</span></div>
              )}
              {snapshot.description ? (
                <div className="snapshot-description">
                  <strong>Description</strong>
                  <p>{snapshot.description}</p>
                </div>
              ) : (
                <div className="snapshot-description snapshot-description--empty"><strong>Description</strong><p>The detail page did not expose a description when this copy was saved.</p></div>
              )}
              <div className="modal-note"><Info size={16} /><span>Images and the description are stored in Scout's database, so they remain viewable even after the marketplace page is gone.</span></div>
            </>
          ) : (
            <div className="snapshot-missing">
              <Database size={26} />
              <strong>No preserved copy yet</strong>
              <span>Scout saves copies automatically for new research listings. Save one now to keep the description and images before the listing disappears.</span>
              <button className="primary-button" disabled={saving} onClick={() => void saveCopy()}>
                {saving ? <LoaderCircle size={17} className="spin" /> : <Database size={17} />}
                {saving ? "Saving…" : "Save a copy now"}
              </button>
            </div>
          )}
        </div>
        <div className="modal-footer">
          <a className="outline-button" href={listing.url} target="_blank" rel="noreferrer">Open on {listing.marketplace}</a>
          {snapshot ? (
            <button className="primary-button" disabled={saving} onClick={() => void saveCopy()}>
              {saving ? <LoaderCircle size={17} className="spin" /> : <Check size={17} />}
              {saving ? "Saving…" : "Refresh saved copy"}
            </button>
          ) : null}
        </div>
      </section>
      {lightbox ? (
        <div className="lightbox-backdrop" role="presentation" onClick={() => setLightbox(null)}>
          <img src={lightbox} alt="" />
        </div>
      ) : null}
    </div>
  );
}

function MarketThumbnail({ listing }: { listing: MarketTrackedListing }) {
  const [failed, setFailed] = useState(false);
  const image = safeImageUrl(listing.image);
  return image && !failed ? <img src={image} alt="" loading="lazy" onError={() => setFailed(true)} /> : <div className="listing-thumb-placeholder"><Tag size={20} /></div>;
}

function MarketWatchDialog({
  initialWatch,
  onClose,
  onSubmit,
}: {
  initialWatch: MarketWatch | null;
  onClose: () => void;
  onSubmit: (watch: MarketWatchInput) => Promise<void>;
}) {
  const [name, setName] = useState(initialWatch?.name ?? "");
  const [query, setQuery] = useState(initialWatch?.query ?? "");
  const [terms, setTerms] = useState(initialWatch?.terms ?? "");
  const [excluded, setExcluded] = useState(initialWatch?.excluded ?? "");
  const [location, setLocation] = useState(initialWatch?.location ?? "Polska");
  const [condition, setCondition] = useState(initialWatch?.condition ?? "Any");
  const [interval, setIntervalValue] = useState(String(initialWatch?.intervalHours ?? 24));
  const [sources, setSources] = useState<Marketplace[]>(initialWatch?.sources ?? ["OLX", "Allegro Lokalnie", "Vinted"]);
  const [minPrice, setMinPrice] = useState(initialWatch?.minPrice === null || initialWatch?.minPrice === undefined ? "" : String(initialWatch.minPrice));
  const [maxPrice, setMaxPrice] = useState(initialWatch?.maxPrice === null || initialWatch?.maxPrice === undefined ? "" : String(initialWatch.maxPrice));
  const [shippingOnly, setShippingOnly] = useState(initialWatch?.shippingOnly ?? false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const numericInterval = Number(interval);
  const numericMin = minPrice === "" ? null : Number(minPrice);
  const numericMax = maxPrice === "" ? null : Number(maxPrice);
  const validPrices = (numericMin === null || (Number.isFinite(numericMin) && numericMin >= 0)) && (numericMax === null || (Number.isFinite(numericMax) && numericMax > 0)) && (numericMin === null || numericMax === null || numericMin <= numericMax);
  const valid = Boolean(name.trim() && query.trim() && sources.length && Number.isInteger(numericInterval) && numericInterval >= 6 && numericInterval <= 168 && validPrices);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !submitting) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, submitting]);

  const toggleSource = (source: Marketplace) => setSources((current) => current.includes(source) ? current.filter((item) => item !== source) : [...current, source]);
  const submit = async () => {
    if (!valid) return;
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit({ name: name.trim(), query: query.trim(), terms: terms.trim(), excluded: excluded.trim(), location: location.trim() || "Polska", condition, sources, intervalHours: numericInterval, minPrice: numericMin, maxPrice: numericMax, shippingOnly });
    } catch (submitError) {
      setError(errorMessage(submitError));
      setSubmitting(false);
    }
  };
  const editing = Boolean(initialWatch);

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !submitting && onClose()}>
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby="market-watch-title">
        <div className="modal-header"><div><span className="modal-kicker">Market research</span><h2 id="market-watch-title">{editing ? "Edit research watch" : "New research watch"}</h2><p>{editing ? "Changing search criteria starts a new comparable series; previous observations remain available." : "Save recurring search snapshots and compare asking-price history."}</p></div><button className="icon-button" disabled={submitting} onClick={onClose} aria-label="Close"><X size={20} /></button></div>
        <div className="modal-body">
          <label className="field-label">Watch name<input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Used RTX 4070 market" /></label>
          <label className="field-label">Search phrase<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="e.g. RTX 4070" /></label>
          <div className="field-row"><label className="field-label">Included terms<input value={terms} onChange={(event) => setTerms(event.target.value)} placeholder="e.g. 12gb, founders edition" /></label><label className="field-label">Excluded terms<input value={excluded} onChange={(event) => setExcluded(event.target.value)} placeholder="e.g. broken, parts" /></label></div>
          <div className="field-row"><label className="field-label">Location <span>where available</span><input value={location} onChange={(event) => setLocation(event.target.value)} placeholder="Anywhere" /></label><label className="field-label">Condition<select value={condition} onChange={(event) => setCondition(event.target.value)}><option>Any</option><option>New</option><option>Used</option><option>Like new</option><option>Very good</option><option>Good</option></select></label></div>
          <div className="field-row"><label className="field-label">Minimum price <span>PLN · optional</span><input type="number" min="0" step="1" value={minPrice} onChange={(event) => setMinPrice(event.target.value)} placeholder="No minimum" /></label><label className="field-label">Maximum price <span>PLN · optional</span><input type="number" min="1" step="1" value={maxPrice} onChange={(event) => setMaxPrice(event.target.value)} placeholder="No maximum" /></label></div>
          <div className="field-row"><label className="field-label">Snapshot interval <span>6–168 hours</span><input type="number" min="6" max="168" value={interval} onChange={(event) => setIntervalValue(event.target.value)} /></label><div className="field-label"><span>Sources</span><div className="source-options">{(["OLX", "Allegro Lokalnie", "Vinted"] as Marketplace[]).map((source) => <button type="button" key={source} aria-pressed={sources.includes(source)} className={`source-option ${sources.includes(source) ? "source-option--selected" : ""}`} onClick={() => toggleSource(source)}><i style={{ background: marketplaceColors[source] }} />{source}{sources.includes(source) ? <Check size={15} /> : null}</button>)}</div></div></div>
          <label className="check-option check-option--modal"><input type="checkbox" checked={shippingOnly} onChange={(event) => setShippingOnly(event.target.checked)} /><span><strong>Require shipping</strong><small>Only save listings with confirmed delivery options</small></span></label>
          {error ? <div className="form-error" role="alert"><AlertTriangle size={15} />{error}</div> : null}
          {!validPrices ? <div className="form-error" role="alert"><AlertTriangle size={15} />Minimum price cannot exceed maximum price.</div> : null}
          <div className="modal-note"><Info size={16} /><span>Scout displays “no longer available” only after verified terminal checks. The retained last asking price is not a confirmed sale price.</span></div>
        </div>
        <div className="modal-footer"><button className="outline-button" disabled={submitting} onClick={onClose}>Cancel</button><button className="primary-button" disabled={!valid || submitting} onClick={submit}>{submitting ? <LoaderCircle size={17} className="spin" /> : editing ? <Check size={17} /> : <Plus size={17} />}{submitting ? "Saving…" : editing ? "Save research watch" : "Create research watch"}</button></div>
      </section>
    </div>
  );
}
