import { useEffect, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  Check,
  CheckCircle2,
  Info,
  LoaderCircle,
  Plus,
  Send,
  X,
  Zap,
} from "lucide-react";
import { api } from "./api";
import { marketplaceColors } from "./data";
import type { WatchPreset } from "./presets";
import type { Marketplace, MarketWatch, NotificationRecord, Watch } from "./types";

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "Something went wrong";

export function WatchDialog({
  initialWatch = null,
  preset = null,
  onClose,
  onSubmit,
}: {
  initialWatch?: Watch | null;
  preset?: WatchPreset | null;
  onClose: () => void;
  onSubmit: (watch: Watch) => Promise<void>;
}) {
  const [name, setName] = useState(initialWatch?.name ?? (preset?.query ? `${preset.query} watch` : ""));
  const [query, setQuery] = useState(initialWatch?.query ?? preset?.query ?? "");
  const [terms, setTerms] = useState(initialWatch?.terms ?? preset?.terms ?? "");
  const [excluded, setExcluded] = useState(initialWatch?.excluded ?? preset?.excluded ?? "");
  const [location, setLocation] = useState(initialWatch?.location ?? preset?.location ?? "Polska");
  const [condition, setCondition] = useState(initialWatch?.condition ?? preset?.condition ?? "Any");
  const [interval, setIntervalValue] = useState(String(initialWatch?.interval ?? 5));
  const [sensitivity, setSensitivity] = useState(String(initialWatch?.sensitivity ?? 1));
  const [exactUrls, setExactUrls] = useState(initialWatch?.exactUrls.join("\n") ?? "");
  const [sources, setSources] = useState<Marketplace[]>(initialWatch?.sources ?? preset?.sources ?? [
    "OLX",
    "Allegro Lokalnie",
    "Vinted",
  ]);
  const [minPrice, setMinPrice] = useState(initialWatch?.minPrice === null || initialWatch?.minPrice === undefined ? preset?.minPrice === null || preset?.minPrice === undefined ? "" : String(preset.minPrice) : String(initialWatch.minPrice));
  const [maxPrice, setMaxPrice] = useState(initialWatch?.maxPrice === null || initialWatch?.maxPrice === undefined ? preset?.maxPrice === null || preset?.maxPrice === undefined ? "" : String(preset.maxPrice) : String(initialWatch.maxPrice));
  const [shippingOnly, setShippingOnly] = useState(initialWatch?.shippingOnly ?? preset?.shippingOnly ?? false);
  const [typoVariants, setTypoVariants] = useState(initialWatch?.typoVariants ?? false);
  const [aiRelevance, setAiRelevance] = useState(initialWatch?.aiRelevance ?? true);
  const [referenceOptions, setReferenceOptions] = useState<MarketWatch[]>([]);
  const [referenceMarketWatchId, setReferenceMarketWatchId] = useState(initialWatch?.referenceMarketWatchId ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const numericInterval = Number(interval);
  const numericMin = minPrice === "" ? null : Number(minPrice);
  const numericMax = maxPrice === "" ? null : Number(maxPrice);
  const validPrices =
    (numericMin === null || numericMin >= 0) &&
    (numericMax === null || numericMax > 0) &&
    (numericMin === null || numericMax === null || numericMin <= numericMax);
  const canSubmit = Boolean(
    name.trim() &&
      query.trim() &&
      sources.length &&
      Number.isInteger(numericInterval) &&
      numericInterval >= 5 &&
      numericInterval <= 1440 &&
      validPrices,
  );
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !submitting) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, submitting]);
  useEffect(() => {
    let active = true;
    api.marketResearch({ pageSize: 1 }).then((result) => {
      if (active) setReferenceOptions(result.watches);
    }).catch(() => { /* the fallback-baseline select stays empty; core dialog works without it */ });
    return () => { active = false; };
  }, []);
  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit({
        id: initialWatch?.id ?? `watch-${Date.now()}`,
        name: name.trim(),
        query: query.trim(),
        terms: terms.trim(),
        excluded: excluded.trim(),
        sources,
        location: location.trim() || "Polska",
        condition,
        samples: initialWatch?.samples ?? 0,
        targetSamples: initialWatch?.targetSamples ?? 30,
        observationHours: initialWatch?.observationHours ?? 0,
        readiness: initialWatch?.readiness ?? 0,
        status: initialWatch?.status ?? "Learning",
        interval: numericInterval,
        nextScan: "due now",
        enabled: initialWatch?.enabled ?? true,
        exactUrls: exactUrls
          .split(/\r?\n/)
          .map((url) => url.trim())
          .filter(Boolean),
        sensitivity: Number(sensitivity),
        shippingOnly,
        typoVariants,
        aiRelevance,
        referenceMarketWatchId: referenceMarketWatchId.trim() ? referenceMarketWatchId.trim() : null,
        minPrice: numericMin,
        maxPrice: numericMax,
      });
    } catch (submitError) {
      setError(errorMessage(submitError));
      setSubmitting(false);
    }
  };
  const toggleSource = (source: Marketplace) =>
    setSources((current) =>
      current.includes(source)
        ? current.filter((item) => item !== source)
        : [...current, source],
    );
  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) =>
        event.target === event.currentTarget && !submitting && onClose()
      }
    >
      <section
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="watch-dialog-title"
      >
        <div className="modal-header">
          <div>
              <span className="modal-kicker">{initialWatch ? "Edit search" : "Create a search"}</span>
            <h2 id="watch-dialog-title">{initialWatch ? "Edit watch" : "New watch"}</h2>
            <p>
              Scout learns first, then alerts when the price breaks its normal
              range.
            </p>
          </div>
          <button
            className="icon-button"
            disabled={submitting}
            onClick={onClose}
            aria-label="Close"
          >
            <X size={20} />
          </button>
        </div>
        <div className="modal-body">
          <label className="field-label">
            Watch name
            <input
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. Steam Deck OLED 512GB"
            />
          </label>
          <label className="field-label">
            Search terms
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="What should Scout search for?"
            />
          </label>
          <div className="field-row">
            <label className="field-label">
              Included terms
              <input
                value={terms}
                onChange={(event) => setTerms(event.target.value)}
                placeholder="oled, 512gb"
              />
            </label>
            <label className="field-label">
              Excluded terms
              <input
                value={excluded}
                onChange={(event) => setExcluded(event.target.value)}
                placeholder="broken, parts"
              />
            </label>
          </div>
          <div className="field-row">
            <label className="field-label">
              Location
              <input
                value={location}
                onChange={(event) => setLocation(event.target.value)}
              />
            </label>
            <label className="field-label">
              Condition
              <select
                value={condition}
                onChange={(event) => setCondition(event.target.value)}
              >
                <option>Any</option>
                <option>New</option>
                <option>Like new</option>
                <option>Very good</option>
                <option>Good</option>
              </select>
            </label>
          </div>
          <div className="field-row">
            <label className="field-label">
              Minimum price <span>PLN · optional</span>
              <input type="number" min="0" value={minPrice} onChange={(event) => setMinPrice(event.target.value)} placeholder="No minimum" />
            </label>
            <label className="field-label">
              Maximum price <span>PLN · optional</span>
              <input type="number" min="1" value={maxPrice} onChange={(event) => setMaxPrice(event.target.value)} placeholder="No maximum" />
            </label>
          </div>
          <div className="field-row">
            <label className="field-label">
              Polling interval <span>5–1440 min</span>
              <input
                type="number"
                min="5"
                max="1440"
                value={interval}
                onChange={(event) => setIntervalValue(event.target.value)}
              />
            </label>
            <label className="field-label">
              Sensitivity
              <select
                value={sensitivity}
                onChange={(event) => setSensitivity(event.target.value)}
              >
                <option value="0.8">Conservative</option>
                <option value="1">Balanced</option>
                <option value="1.3">Sensitive</option>
              </select>
            </label>
          </div>
          <div className="field-label">
            <span>Sources</span>
            <div className="source-options">
              {(["OLX", "Allegro Lokalnie", "Vinted"] as Marketplace[]).map(
                (source) => (
                  <button
                    type="button"
                    key={source}
                    className={`source-option ${sources.includes(source) ? "source-option--selected" : ""}`}
                    aria-pressed={sources.includes(source)}
                    onClick={() => toggleSource(source)}
                  >
                    <i style={{ background: marketplaceColors[source] }} />
                    {source}
                    {sources.includes(source) ? <Check size={15} /> : null}
                  </button>
                ),
              )}
            </div>
          </div>
          <label className="check-option check-option--modal">
            <input type="checkbox" checked={shippingOnly} onChange={(event) => setShippingOnly(event.target.checked)} />
            <span><strong>Require shipping</strong><small>Only learn from and alert on listings with confirmed shipping</small></span>
          </label>
          <label className="check-option check-option--modal">
            <input type="checkbox" checked={typoVariants} onChange={(event) => setTypoVariants(event.target.checked)} />
            <span><strong>Scan typo variants</strong><small>Catch misspelled listings — up to 2 extra searches per scan</small></span>
          </label>
          <label className="check-option check-option--modal">
            <input type="checkbox" checked={aiRelevance} onChange={(event) => setAiRelevance(event.target.checked)} />
            <span><strong>Use AI relevance filtering</strong><small>Exclude accessories, replacement parts, services, and unrelated listings when OpenRouter is configured</small></span>
          </label>
          <label className="field-label">
            Fallback baseline <span>optional · research series</span>
            <select value={referenceMarketWatchId} onChange={(event) => setReferenceMarketWatchId(event.target.value)}>
              <option value="">None — learn from own history</option>
              {referenceOptions.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
            </select>
          </label>
          {referenceMarketWatchId ? (
            <div className="modal-note">
              <Info size={16} />
              <span>
                While this watch is still learning, listings display a “series baseline” typical from the reference research series' probable-sale band. It improves ranking and display only — no alerts fire earlier.
              </span>
            </div>
          ) : null}
          <label className="field-label">
            Exact search URLs <span>optional · one per line</span>
            <textarea
              rows={3}
              value={exactUrls}
              onChange={(event) => setExactUrls(event.target.value)}
              placeholder={
                "https://www.olx.pl/d/oferty/q-steam-deck/\nhttps://www.vinted.pl/catalog?search_text=steam%20deck"
              }
            />
          </label>
          {error ? (
            <div className="form-error" role="alert">
              <AlertTriangle size={15} />
              {error}
            </div>
          ) : null}
          {!validPrices ? <div className="form-error" role="alert"><AlertTriangle size={15} />Minimum price cannot exceed maximum price.</div> : null}
          <div className="modal-note">
            <Zap size={16} />
            <span>
              Baseline learning needs 30 comparable listings and 6 hours of
              observations. No deal alerts fire while learning.
            </span>
          </div>
        </div>
        <div className="modal-footer">
          <button
            className="outline-button"
            disabled={submitting}
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            className="primary-button"
            disabled={!canSubmit || submitting}
            onClick={submit}
          >
            {submitting ? (
              <LoaderCircle size={17} className="spin" />
            ) : (
              <Plus size={17} />
            )}
            {submitting ? (initialWatch ? "Saving…" : "Creating…") : (initialWatch ? "Save watch" : "Create watch")}
          </button>
        </div>
      </section>
    </div>
  );
}

export function PriceFilterDialog({ watch, onClose, onSubmit }: { watch: Watch; onClose: () => void; onSubmit: (minPrice: number | null, maxPrice: number | null) => Promise<void> }) {
  const [minPrice, setMinPrice] = useState(watch.minPrice === null ? "" : String(watch.minPrice));
  const [maxPrice, setMaxPrice] = useState(watch.maxPrice === null ? "" : String(watch.maxPrice));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const numericMin = minPrice === "" ? null : Number(minPrice);
  const numericMax = maxPrice === "" ? null : Number(maxPrice);
  const valid = (numericMin === null || (Number.isFinite(numericMin) && numericMin >= 0)) && (numericMax === null || (Number.isFinite(numericMax) && numericMax > 0)) && (numericMin === null || numericMax === null || numericMin <= numericMax);
  useEffect(() => { const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !saving) onClose(); }; window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey); }, [onClose, saving]);
  const save = async () => { if (!valid) return; setSaving(true); setError(null); try { await onSubmit(numericMin, numericMax); } catch (saveError) { setError(errorMessage(saveError)); setSaving(false); } };
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !saving && onClose()}><section className="modal modal--compact" role="dialog" aria-modal="true" aria-labelledby="price-filter-title"><div className="modal-header"><div><span className="modal-kicker">Watch filters</span><h2 id="price-filter-title">Price range</h2><p>Only matching prices count toward {watch.name}’s learned baseline and alerts.</p></div><button className="icon-button" disabled={saving} onClick={onClose} aria-label="Close"><X size={20} /></button></div><div className="modal-body"><div className="field-row"><label className="field-label">Minimum price <span>PLN</span><input autoFocus type="number" min="0" placeholder="No minimum" value={minPrice} onChange={(event) => setMinPrice(event.target.value)} /></label><label className="field-label">Maximum price <span>PLN</span><input type="number" min="1" placeholder="No maximum" value={maxPrice} onChange={(event) => setMaxPrice(event.target.value)} /></label></div>{!valid ? <div className="form-error" role="alert"><AlertTriangle size={15} />Enter a valid range; minimum cannot exceed maximum.</div> : null}{error ? <div className="form-error" role="alert"><AlertTriangle size={15} />{error}</div> : null}<div className="modal-note"><Info size={16} /><span>Clearing both fields removes the price filter. Existing history is kept but excluded from this watch while outside the range.</span></div></div><div className="modal-footer"><button className="outline-button" disabled={saving} onClick={onClose}>Cancel</button><button className="primary-button" disabled={!valid || saving} onClick={save}>{saving ? <LoaderCircle size={17} className="spin" /> : <Check size={17} />}{saving ? 'Saving…' : 'Save price filter'}</button></div></section></div>;
}

export function HistoryDialog({ onClose }: { onClose: () => void }) {
  const [rows, setRows] = useState<NotificationRecord[]>([]);
  const [pagination, setPagination] = useState<{ page: number; pageSize: number; total: number; hasNext: boolean } | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    api
      .notifications()
      .then((result) => {
        if (active) {
          setRows(result.notifications);
          setPagination(result.pagination);
        }
      })
      .catch((loadError) => {
        if (active) setError(errorMessage(loadError));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <section
        className="modal modal--history"
        role="dialog"
        aria-modal="true"
        aria-labelledby="history-title"
      >
        <div className="modal-header">
          <div>
            <span className="modal-kicker">Delivery log</span>
            <h2 id="history-title">Notification history</h2>
            <p>Actual delivery attempts from this Scout instance.</p>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close">
            <X size={20} />
          </button>
        </div>
        <div className="history-list">
          {loading ? (
            <div className="table-loading">
              <LoaderCircle size={18} className="spin" />
              Loading notifications…
            </div>
          ) : error ? (
            <div className="form-error">
              <AlertTriangle size={15} />
              {error}
            </div>
          ) : rows.length ? (
            <>
            {rows.map((row) => (
              <div className="history-row" key={row.id}>
                <div className="history-icon">
                  <Send size={15} />
                </div>
                <div>
                  <strong>{row.title}</strong>
                  <span>
                    {row.reason} ·{" "}
                    {new Date(row.observedAt).toLocaleString("pl-PL")}
                  </span>
                </div>
                <em className={`history-status history-status--${row.status}`}>
                  {row.status === "delivered" ? (
                    <CheckCircle2 size={15} />
                  ) : (
                    <AlertTriangle size={15} />
                  )}
                  {row.status}
                </em>
              </div>
            ))}
            {pagination?.hasNext ? <button className="link-button messages-load-more" disabled={loadingOlder} onClick={async () => { setLoadingOlder(true); try { const result = await api.notifications({ page: (pagination.page ?? 1) + 1 }); setRows((current) => [...current, ...result.notifications]); setPagination(result.pagination); } catch (loadError) { setError(errorMessage(loadError)); } finally { setLoadingOlder(false); } }}>{loadingOlder ? <LoaderCircle size={15} className="spin" /> : <ArrowRight size={15} />}{loadingOlder ? "Loading…" : "Load older notifications"}</button> : null}
            </>
          ) : (
            <div className="panel-empty panel-empty--large">
              No notifications have been sent yet.
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button className="outline-button" onClick={onClose}>
            Done
          </button>
        </div>
      </section>
    </div>
  );
}
