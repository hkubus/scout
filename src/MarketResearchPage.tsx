import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  BarChart3,
  Bell,
  Check,
  Clock3,
  Database,
  ExternalLink,
  Eye,
  LoaderCircle,
  MoreHorizontal,
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
import { AnalyticsTrendChart, formatAnalyticsDate, formatAnalyticsPrice } from "./AnalyticsTrendChart";
import { marketWatchInputFromListing } from "./presets";
import { OlxCategoryPicker } from "./OlxCategoryPicker";
import { PriceSparkline } from "./PriceSparkline";
import { dayMonthYear, formatDate, mediumDateShortTime } from "./format";
import { formatPln, ListingThumbnail, PageHeader, SelectControl } from "./ui";
import type {
  Marketplace,
  MarketListingSnapshot,
  MarketResearchData,
  MarketTrackedListing,
  MarketWatch,
  MarketWatchInput,
  MarketWatchTrend,
  OlxCategory,
  PriceHistoryPoint,
  SaleBand,
} from "./types";

type ToastType = "success" | "error" | "info";

const SALE_BAND_TOOLTIP =
  "Listings verified no-longer-available; their last asking price is used as a probable-sale estimate, not a confirmed sale price. Prices stale > 30 days before disappearance are excluded.";

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "Something went wrong";

/** The probable-sale estimate as one full-width line, so the band never truncates. */
function SaleBandLine({ band }: { band: SaleBand | null }) {
  if (!band || band.median === null || band.p25 === null || band.p75 === null) {
    return <p className="research-sale-band" title={SALE_BAND_TOOLTIP}>Probable sale: learning <small>({band ? `${band.eligibleCount} ended so far` : "no ended listings yet"})</small></p>;
  }
  return (
    <p className="research-sale-band" title={SALE_BAND_TOOLTIP}>
      Probable sale <strong>≈ {formatPln(band.median)}</strong> <small>{formatPln(band.p25)}–{formatPln(band.p75)} · {band.eligibleCount} ended</small>
    </p>
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
  const [snapshotListing, setSnapshotListing] = useState<MarketTrackedListing | null>(null);
  const [watchPreset, setWatchPreset] = useState<MarketWatchInput | null>(null);
  const [dialogNonce, setDialogNonce] = useState(0);
  const [trendWatch, setTrendWatch] = useState<MarketWatch | null>(null);
  const [menuWatch, setMenuWatch] = useState<string | null>(null);
  const loadSequence = useRef(0);
  const loadController = useRef<AbortController | null>(null);

  const load = useCallback(async (showLoader = false) => {
    loadController.current?.abort();
    const controller = new AbortController();
    loadController.current = controller;
    const sequence = ++loadSequence.current;
    if (showLoader) setLoading(true);
    try {
      const result = await api.marketResearch({
        page,
        pageSize: 25,
        watchId: selectedWatch === "All" ? undefined : selectedWatch,
        status: status === "All" ? undefined : status,
      }, controller.signal);
      if (sequence !== loadSequence.current || controller.signal.aborted) return;
      setData(result);
    } catch (error) {
      if (sequence !== loadSequence.current || controller.signal.aborted) return;
      onToast(errorMessage(error), "error");
    } finally {
      // Whichever request is newest ends the loading state, so a refresh that
      // supersedes the first load cannot leave the spinner up forever.
      if (sequence === loadSequence.current) setLoading(false);
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
  const openCreate = () => { setEditingWatch(null); setWatchPreset(null); setDialogNonce((value) => value + 1); setShowDialog(true); };
  const openEdit = (watch: MarketWatch) => { setEditingWatch(watch); setWatchPreset(null); setDialogNonce((value) => value + 1); setShowDialog(true); };
  const openCreateFromListing = (listing: MarketTrackedListing) => {
    setEditingWatch(null);
    setWatchPreset(marketWatchInputFromListing(listing));
    setDialogNonce((value) => value + 1);
    setShowDialog(true);
  };
  const closeDialog = () => { if (showDialog) { setShowDialog(false); setEditingWatch(null); setWatchPreset(null); } };
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
  const visible = useMemo(
    () => data.listings.filter((listing) =>
      (selectedWatch === "All" || listing.marketWatchId === selectedWatch)
      && (status === "All" || listing.status === status)),
    [data.listings, selectedWatch, status],
  );
  const totalEnded = data.aggregates?.endedCount ?? data.watches.reduce((sum, watch) => sum + watch.endedListings, 0);
  const totalActive = data.aggregates?.activeCount ?? data.watches.reduce((sum, watch) => sum + watch.activeListings, 0);

  return (
    <>
      <PageHeader title="Research">
        <button className="primary-button" onClick={openCreate}><Plus size={18} />New research watch</button>
      </PageHeader>
      {data.watches.length ? (
        <p className="research-meta" title="A listing counts as ended only after three verified terminal checks; a missing search result alone is never treated as a sale.">
          {data.watches.filter((watch) => watch.enabled).length} of {data.watches.length} research watches active · {totalActive.toLocaleString("pl-PL")} live · {totalEnded.toLocaleString("pl-PL")} ended listings
        </p>
      ) : null}
      {loading ? (
        <div className="table-loading"><LoaderCircle size={20} className="spin" />Loading market research…</div>
      ) : data.watches.length ? (
        <div className="research-watch-list">
          {data.watches.map((watch) => (
            <article className={`research-watch ${watch.enabled ? "" : "research-watch--paused"}`} key={watch.id}>
              <div className="research-watch-heading">
                <div><strong>{watch.name}</strong><span>{watch.query.toLowerCase() !== watch.name.toLowerCase() ? `${watch.query} · ` : ""}{watch.sources.join(", ")}</span></div>
                {watch.enabled ? null : <span className="state-chip state-chip--paused"><i />Paused</span>}
              </div>
              <MarketWatchFilterSummary watch={watch} />
              <SaleBandLine band={watch.saleBand} />
              <div className="research-watch-footer">
                <span><Clock3 size={14} />{watch.totalListings} tracked · {watch.endedListings} ended · {watch.enabled ? `next ${watch.nextScan}` : "paused"}</span>
                <div>
                  <button className="icon-button" title="Price trend" aria-label={`Price trend for ${watch.name}`} onClick={() => setTrendWatch(watch)}><BarChart3 size={16} /></button>
                  <div className="menu-anchor">
                    <button className="icon-button" title="More actions" aria-label={`More actions for ${watch.name}`} aria-haspopup="menu" aria-expanded={menuWatch === watch.id} disabled={busyIds.has(watch.id)} onClick={() => setMenuWatch((current) => current === watch.id ? null : watch.id)}>
                      {busyIds.has(watch.id) ? <LoaderCircle size={16} className="spin" /> : <MoreHorizontal size={17} />}
                    </button>
                    {menuWatch === watch.id ? (
                      <div className="action-menu" role="menu">
                        <button role="menuitem" disabled={!watch.enabled} onClick={() => { setMenuWatch(null); void scan(watch); }}><RefreshCw size={15} />Scan now</button>
                        <button role="menuitem" onClick={() => { setMenuWatch(null); openEdit(watch); }}><SlidersHorizontal size={15} />Edit filters</button>
                        <button role="menuitem" onClick={() => { setMenuWatch(null); void toggle(watch); }}>{watch.enabled ? <Pause size={15} /> : <Play size={15} />}{watch.enabled ? "Pause" : "Resume"}</button>
                        <button role="menuitem" className="danger-action" onClick={() => { setMenuWatch(null); void remove(watch); }}><Trash2 size={15} />Delete</button>
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <div className="page-empty"><BarChart3 size={28} /><strong>No market research watches yet</strong><span>Create one to start collecting daily asking-price snapshots.</span><button className="primary-button" onClick={openCreate}><Plus size={17} />New research watch</button></div>
      )}
      {data.watches.length ? (
        <section className="research-history">
          <div className="section-heading-row"><h2>Saved listings</h2><div className="filters"><SelectControl label="Research watch" value={selectedWatch} options={[{ value: "All", label: "All research watches" }, ...data.watches.map((watch) => ({ value: watch.id, label: watch.name }))]} onChange={(value) => { setSelectedWatch(value); setPage(1); }} /><SelectControl label="Status" value={status} options={[{ value: "All", label: "All statuses" }, { value: "active", label: "Active" }, { value: "ended", label: "Ended" }, { value: "superseded", label: "Previous series" }]} onChange={(value) => { setStatus(value as typeof status); setPage(1); }} /></div></div>
          <MarketResearchTable listings={visible} onViewSnapshot={setSnapshotListing} />
          {data.pagination && (data.pagination.page > 1 || data.pagination.hasNext) ? <div className="research-pagination"><button className="outline-button" disabled={page <= 1 || loading} onClick={() => setPage((current) => Math.max(1, current - 1))}>Previous</button><span>Page {data.pagination.page} · {data.pagination.total.toLocaleString("pl-PL")} listings</span><button className="outline-button" disabled={!data.pagination.hasNext || loading} onClick={() => setPage((current) => current + 1)}>Next</button></div> : null}
        </section>
      ) : null}
      {showDialog ? <MarketWatchDialog key={editingWatch?.id ?? `new-${dialogNonce}`} initialWatch={editingWatch} preset={watchPreset} onClose={closeDialog} onSubmit={editingWatch ? update : create} /> : null}
      {trendWatch ? <MarketWatchTrendDialog watch={trendWatch} refreshKey={refreshKey} onClose={() => setTrendWatch(null)} /> : null}
      {snapshotListing ? <MarketListingSnapshotModal listing={snapshotListing} onClose={() => setSnapshotListing(null)} onToast={onToast} onSaved={() => void load(false)} onWatch={openCreateFromListing} /> : null}
    </>
  );
}

function MarketWatchTrendDialog({ watch, refreshKey, onClose }: {
  watch: MarketWatch;
  refreshKey: number;
  onClose: () => void;
}) {
  const [days, setDays] = useState(90);
  const [trend, setTrend] = useState<MarketWatchTrend | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const trendSequence = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    const sequence = ++trendSequence.current;
    setLoading(true);
    setError(null);
    api.marketWatchTrend(watch.id, days, controller.signal).then((result) => {
      if (sequence !== trendSequence.current || controller.signal.aborted) return;
      setTrend(result);
    }).catch((requestError) => {
      if (sequence !== trendSequence.current || controller.signal.aborted) return;
      setError(errorMessage(requestError));
    }).finally(() => {
      if (sequence === trendSequence.current && !controller.signal.aborted) setLoading(false);
    });
    return () => { controller.abort(); };
  }, [watch.id, days, refreshKey]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const lastPoint = trend?.points.length ? trend.points[trend.points.length - 1] : null;
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="modal modal--analytics" role="dialog" aria-modal="true" aria-labelledby="market-trend-title">
        <div className="modal-header">
          <div>
            <span className="modal-kicker">Price trend</span>
            <h2 id="market-trend-title">{watch.name}</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close research trend"><X size={20} /></button>
        </div>
        <div className="modal-body analytics-body">
          <div className="analytics-toolbar">
            <span>{trend ? `${trend.totalObservations.toLocaleString("pl-PL")} observations · ${formatAnalyticsDate(trend.firstObservedAt)}–${formatAnalyticsDate(trend.lastObservedAt)}` : "Loading observation history…"}</span>
            <div className="analytics-range-options" role="group" aria-label="Trend time range">
              {[30, 90, 180].map((option) => <button key={option} className={days === option ? "analytics-range-option analytics-range-option--active" : "analytics-range-option"} onClick={() => setDays(option)}>{option}d</button>)}
            </div>
          </div>
          {loading && !trend ? <div className="analytics-loading"><LoaderCircle size={20} className="spin" />Loading trend…</div> : null}
          {error ? <div className="analytics-error" role="alert"><AlertTriangle size={16} />{error}</div> : null}
          {trend && !error ? (
            <>
              <div className="analytics-stat-grid">
                <div className="analytics-stat"><span>Active median</span><strong>{formatAnalyticsPrice(lastPoint?.medianPrice ?? null)}</strong><small>latest observed day</small></div>
                <div className="analytics-stat"><span>Active band</span><strong>{lastPoint?.lowerPrice != null && lastPoint?.upperPrice != null ? `${lastPoint.lowerPrice.toLocaleString("pl-PL")}–${lastPoint.upperPrice.toLocaleString("pl-PL")} zł` : "—"}</strong><small>middle 50% of asking prices</small></div>
                <div className="analytics-stat"><span>Probable-sale median</span><strong>{formatAnalyticsPrice(trend.probableSaleMedian)}</strong><small>reference line · estimated</small></div>
                <div className="analytics-stat"><span>Listings last day</span><strong>{lastPoint?.listingCount ?? 0}</strong><small>unique listings observed</small></div>
              </div>
              <section className="analytics-section">
                <div className="analytics-section-heading"><h3>Asking prices vs probable sales</h3><span title="The dashed line is the probable-sale median from listings verified as no longer available: an estimate, not a confirmed sale price.">Middle 50% shaded · dashed: probable sale</span></div>
                <div className="analytics-chart-card"><AnalyticsTrendChart analytics={{ watchName: watch.name, points: trend.points }} referenceMedian={trend.probableSaleMedian} /></div>
              </section>
            </>
          ) : null}
        </div>
      </section>
    </div>
  );
}

function MarketWatchFilterSummary({ watch }: { watch: MarketWatch }) {
  const tags: string[] = [];
  if (watch.terms) tags.push(`include: ${watch.terms}`);
  if (watch.excluded) tags.push(`exclude: ${watch.excluded}`);
  if (watch.minPrice !== null || watch.maxPrice !== null) tags.push(`price: ${watch.minPrice === null ? "0" : watch.minPrice.toLocaleString("pl-PL")}–${watch.maxPrice === null ? "∞" : watch.maxPrice.toLocaleString("pl-PL")} zł`);
  if (watch.condition !== "Any") tags.push(`condition: ${watch.condition}`);
  if (watch.shippingOnly) tags.push("shipping only");
  if (watch.olxCategory) tags.push(`OLX category: ${watch.olxCategory.label}`);
  return tags.length ? <div className="research-watch-filters">{tags.map((tag) => <span key={tag}>{tag}</span>)}</div> : null;
}

function MarketResearchTable({ listings, onViewSnapshot }: {
  listings: MarketTrackedListing[];
  onViewSnapshot: (listing: MarketTrackedListing) => void;
}) {
  if (!listings.length) return <div className="empty-state"><Database size={24} /><strong>No saved listings in this view</strong><span>The first successful snapshot will populate this history.</span></div>;
  return (
    <div className="research-table-wrap" role="table" aria-label="Market research listings">
      <div className="research-table research-table--head" role="row"><span role="columnheader">Listing</span><span role="columnheader">Status</span><span role="columnheader">First price</span><span role="columnheader" title="For ended listings, the last asking price: not a confirmed sale">Last price</span><span role="columnheader">Change</span><span role="columnheader">Observations</span><span role="columnheader">Last seen / ended</span><span role="columnheader" /></div>
      {listings.map((listing) => (
        <div className="research-table research-listing-row" role="row" key={listing.id}>
          <div className="research-listing" role="cell"><ListingThumbnail listing={listing} /><div><strong>{listing.title}</strong><span><i style={{ background: marketplaceColors[listing.marketplace] }} />{listing.marketplace} · {listing.watchName}</span></div></div>
          <span className={`research-status research-status--${listing.status}`} role="cell"><i />{listing.status === "ended" ? "Ended" : listing.status === "superseded" ? "Previous series" : listing.missingScans ? `Verifying ${listing.missingScans}/3` : "Active"}</span>
          <span data-label="First price" role="cell">{formatPln(listing.firstPrice)}</span>
          <strong data-label="Last price" role="cell">{formatPln(listing.lastPrice)}</strong>
          <span data-label="Change" role="cell" className={listing.priceChangePercent < 0 ? "price-down" : listing.priceChangePercent > 0 ? "price-up" : ""}>{listing.priceChangePercent === 0 ? "—" : `${listing.priceChangePercent > 0 ? "+" : ""}${listing.priceChangePercent.toFixed(1)}%`}</span>
          <span data-label="Observations" role="cell">{listing.observations}</span>
          <span data-label="Last seen / ended" role="cell">{formatDate(dayMonthYear, listing.endedAt ?? listing.lastSeenAt)}</span>
          <span role="cell" className="research-row-actions">
            <button
              className="icon-button"
              title="Saved copy, price history and actions"
              aria-label={`View ${listing.title}`}
              onClick={() => onViewSnapshot(listing)}
            >
              <Eye size={17} />
            </button>
            <a href={listing.url} target="_blank" rel="noopener noreferrer" className="external-link" aria-label={`Open ${listing.title}`}><ExternalLink size={17} /></a>
          </span>
        </div>
      ))}
    </div>
  );
}

function MarketListingSnapshotModal({ listing, onClose, onToast, onSaved, onWatch }: {
  listing: MarketTrackedListing;
  onClose: () => void;
  onToast: (message: string, type?: ToastType) => void;
  onSaved: () => void;
  onWatch: (listing: MarketTrackedListing) => void;
}) {
  const [snapshot, setSnapshot] = useState<MarketListingSnapshot | null>(null);
  const [history, setHistory] = useState<PriceHistoryPoint[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [lightbox, setLightbox] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.marketListingSnapshot(listing.id)
      .then((result) => { if (!cancelled) setSnapshot(result.snapshot); })
      .catch((error) => onToast(errorMessage(error), "error"))
      .finally(() => { if (!cancelled) setLoading(false); });
    api.marketListingHistory(listing.id)
      .then((result) => { if (!cancelled) setHistory(result.points); })
      .catch(() => { /* price history is optional in this view */ });
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
            <span className="modal-kicker">{listing.marketplace} · {formatPln(listing.lastPrice)}{listing.status === "ended" ? " · no longer available" : ""}</span>
            <h2 id="snapshot-title">{listing.title}</h2>
          </div>
          <button className="icon-button" disabled={saving} onClick={onClose} aria-label="Close"><X size={20} /></button>
        </div>
        <div className="modal-body modal-body--snapshot">
          {loading ? (
            <div className="table-loading"><LoaderCircle size={20} className="spin" />Loading the preserved copy…</div>
          ) : snapshot ? (
            <>
              <div className="snapshot-meta">
                <span>Saved {formatDate(mediumDateShortTime, snapshot.capturedAt)}</span>
                {snapshot.condition ? <span>Condition: {snapshot.condition}</span> : null}
                {snapshot.location ? <span>Location: {snapshot.location}</span> : null}
                <span>{snapshot.images.length} image{snapshot.images.length === 1 ? "" : "s"} stored</span>
              </div>
              {history && history.length ? (
                <div className="snapshot-price-history">
                  <strong>Price history</strong>
                  <div className="price-chart-card">
                    <PriceSparkline points={history} />
                    <div className="price-chart-labels">
                      <span>{formatPln(Math.min(...history.map((point) => point.price)))}</span>
                      <strong>Latest {formatPln(history[history.length - 1].price)}</strong>
                      <span>{formatPln(Math.max(...history.map((point) => point.price)))}</span>
                    </div>
                  </div>
                </div>
              ) : null}
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
          <a className="outline-button" href={listing.url} target="_blank" rel="noopener noreferrer">Open on {listing.marketplace}</a>
          <button className="outline-button" onClick={() => { onClose(); onWatch(listing); }}>
            <Bell size={16} />
            Save as research watch
          </button>
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

function MarketWatchDialog({
  initialWatch,
  preset = null,
  onClose,
  onSubmit,
}: {
  initialWatch: MarketWatch | null;
  preset?: MarketWatchInput | null;
  onClose: () => void;
  onSubmit: (watch: MarketWatchInput) => Promise<void>;
}) {
  const [name, setName] = useState(initialWatch?.name ?? preset?.name ?? "");
  const [query, setQuery] = useState(initialWatch?.query ?? preset?.query ?? "");
  const [terms, setTerms] = useState(initialWatch?.terms ?? preset?.terms ?? "");
  const [excluded, setExcluded] = useState(initialWatch?.excluded ?? preset?.excluded ?? "");
  const [condition, setCondition] = useState(initialWatch?.condition ?? preset?.condition ?? "Any");
  const [interval, setIntervalValue] = useState(String(initialWatch?.intervalHours ?? preset?.intervalHours ?? 24));
  const [sources, setSources] = useState<Marketplace[]>(initialWatch?.sources ?? preset?.sources ?? ["OLX", "Allegro Lokalnie", "Vinted"]);
  const [minPrice, setMinPrice] = useState(initialWatch?.minPrice === null || initialWatch?.minPrice === undefined ? preset?.minPrice === null || preset?.minPrice === undefined ? "" : String(preset.minPrice) : String(initialWatch.minPrice));
  const [maxPrice, setMaxPrice] = useState(initialWatch?.maxPrice === null || initialWatch?.maxPrice === undefined ? preset?.maxPrice === null || preset?.maxPrice === undefined ? "" : String(preset.maxPrice) : String(initialWatch.maxPrice));
  const [shippingOnly, setShippingOnly] = useState(initialWatch?.shippingOnly ?? preset?.shippingOnly ?? false);
  const [typoVariants, setTypoVariants] = useState(initialWatch?.typoVariants ?? preset?.typoVariants ?? false);
  const [olxCategory, setOlxCategory] = useState<OlxCategory | null>(initialWatch?.olxCategory ?? preset?.olxCategory ?? null);
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
      await onSubmit({ name: name.trim(), query: query.trim(), terms: terms.trim(), excluded: excluded.trim(), condition, sources, intervalHours: numericInterval, minPrice: numericMin, maxPrice: numericMax, shippingOnly, typoVariants, olxCategory: sources.includes("OLX") ? olxCategory : null });
    } catch (submitError) {
      setError(errorMessage(submitError));
      setSubmitting(false);
    }
  };
  const editing = Boolean(initialWatch);

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !submitting && onClose()}>
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby="market-watch-title">
        <div className="modal-header"><h2 id="market-watch-title">{editing ? "Edit research watch" : "New research watch"}</h2><button className="icon-button" disabled={submitting} onClick={onClose} aria-label="Close"><X size={20} /></button></div>
        <div className="modal-body">
          <label className="field-label">Watch name<input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Used RTX 4070 market" /></label>
          <label className="field-label">Search phrase<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="e.g. RTX 4070" /></label>
          <div className="field-row"><label className="field-label">Included terms<input value={terms} onChange={(event) => setTerms(event.target.value)} placeholder="e.g. 12gb, founders edition" /></label><label className="field-label">Excluded terms<input value={excluded} onChange={(event) => setExcluded(event.target.value)} placeholder="e.g. broken, parts" /></label></div>
          <label className="field-label">Condition<select value={condition} onChange={(event) => setCondition(event.target.value)}><option>Any</option><option>New</option><option>Used</option><option>Like new</option><option>Very good</option><option>Good</option></select></label>
          <div className="field-row"><label className="field-label">Minimum price <span className="field-hint-inline">PLN · optional</span><input type="number" min="0" step="1" value={minPrice} onChange={(event) => setMinPrice(event.target.value)} placeholder="No minimum" /></label><label className="field-label">Maximum price <span className="field-hint-inline">PLN · optional</span><input type="number" min="1" step="1" value={maxPrice} onChange={(event) => setMaxPrice(event.target.value)} placeholder="No maximum" /></label></div>
          <div className="field-row"><label className="field-label">Snapshot interval <span className="field-hint-inline">6–168 hours</span><input type="number" min="6" max="168" value={interval} onChange={(event) => setIntervalValue(event.target.value)} /></label><div className="field-label"><span>Sources</span><div className="source-options">{(["OLX", "Allegro Lokalnie", "Vinted"] as Marketplace[]).map((source) => <button type="button" key={source} aria-pressed={sources.includes(source)} className={`source-option ${sources.includes(source) ? "source-option--selected" : ""}`} onClick={() => toggleSource(source)}><i style={{ background: marketplaceColors[source] }} />{source}{sources.includes(source) ? <Check size={15} /> : null}</button>)}</div></div></div>
          {sources.includes("OLX") ? <OlxCategoryPicker query={query} value={olxCategory} onChange={setOlxCategory} /> : null}
          <div className="modal-checks">
            <label className="check-option" title="Only save listings with confirmed delivery options"><input type="checkbox" checked={shippingOnly} onChange={(event) => setShippingOnly(event.target.checked)} /><strong>Require shipping</strong></label>
            <label className="check-option" title="Catch misspelled listings with up to 2 extra searches per scan"><input type="checkbox" checked={typoVariants} onChange={(event) => setTypoVariants(event.target.checked)} /><strong>Also search typo variants</strong></label>
          </div>
          {error ? <div className="form-error" role="alert"><AlertTriangle size={15} />{error}</div> : null}
          {!validPrices ? <div className="form-error" role="alert"><AlertTriangle size={15} />Minimum price cannot exceed maximum price.</div> : null}
          {editing ? <p className="modal-footnote">Changing the search starts a new comparable series; earlier observations stay available.</p> : null}
        </div>
        <div className="modal-footer"><button className="outline-button" disabled={submitting} onClick={onClose}>Cancel</button><button className="primary-button" disabled={!valid || submitting} onClick={submit}>{submitting ? <LoaderCircle size={17} className="spin" /> : editing ? <Check size={17} /> : <Plus size={17} />}{submitting ? "Saving…" : editing ? "Save research watch" : "Create research watch"}</button></div>
      </section>
    </div>
  );
}
