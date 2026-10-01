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
  Sparkles,
  X,
  Zap,
} from "lucide-react";
import { api } from "./api";
import { marketplaceColors } from "./data";
import { OlxCategoryPicker } from "./OlxCategoryPicker";
import type { WatchPreset } from "./presets";
import type { Marketplace, MarketWatch, NotificationRecord, OlxCategory, SellerType, VariantGroup, Watch } from "./types";

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "Something went wrong";

// crypto.randomUUID() needs a secure context, which a plain-HTTP LAN origin
// is not; this id only has to be unique within one watch.
const newVariantId = () =>
  `variant-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export function WatchDialog({
  initialWatch = null,
  preset = null,
  onClose,
  onSubmit,
}: {
  initialWatch?: Watch | null;
  preset?: WatchPreset | null;
  onClose: () => void;
  onSubmit: (watch: Omit<Watch, "id"> & { id?: string }) => Promise<void>;
}) {
  const [name, setName] = useState(initialWatch?.name ?? (preset?.query ? `${preset.query} watch` : ""));
  const [query, setQuery] = useState(initialWatch?.query ?? preset?.query ?? "");
  const [terms, setTerms] = useState(initialWatch?.terms ?? preset?.terms ?? "");
  const [excluded, setExcluded] = useState(initialWatch?.excluded ?? preset?.excluded ?? "");
  const [condition, setCondition] = useState(initialWatch?.condition ?? preset?.condition ?? "Any");
  const [interval, setIntervalValue] = useState(String(initialWatch?.interval ?? 5));
  const [sourceIntervals, setSourceIntervals] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const [marketplace, minutes] of Object.entries(initialWatch?.sourceIntervals ?? {})) {
      if (typeof minutes === "number" && Number.isFinite(minutes)) initial[marketplace] = String(minutes);
    }
    return initial;
  });
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
  const [olxCategory, setOlxCategory] = useState<OlxCategory | null>(initialWatch?.olxCategory ?? preset?.olxCategory ?? null);
  const [sellerType, setSellerType] = useState<SellerType | null>(initialWatch?.sellerType ?? preset?.sellerType ?? null);
  const [ignorePromoted, setIgnorePromoted] = useState(initialWatch?.ignorePromoted ?? false);
  const [aiRelevance, setAiRelevance] = useState(initialWatch?.aiRelevance ?? preset?.aiRelevance ?? true);
  const [variantGroups, setVariantGroups] = useState<VariantGroup[]>(initialWatch?.variantGroups ?? []);
  // New watches wait for listings and then propose their own groups.
  const [variantGroupsAuto, setVariantGroupsAuto] = useState(initialWatch ? Boolean(initialWatch.variantGroupsAuto) : true);
  const [suggesting, setSuggesting] = useState(false);
  const [suggestionNote, setSuggestionNote] = useState<string | null>(null);
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
  const validSourceIntervals = Object.entries(sourceIntervals).every(([, raw]) => {
    if (raw === "") return true;
    const minutes = Number(raw);
    return Number.isInteger(minutes) && minutes >= 5 && minutes <= 1440;
  });
  const canSubmit = Boolean(
    name.trim() &&
      query.trim() &&
      sources.length &&
      Number.isInteger(numericInterval) &&
      numericInterval >= 5 &&
      numericInterval <= 1440 &&
      validPrices &&
      validSourceIntervals,
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
    // Only the research watch list is used; it does not depend on the page size.
    api.marketResearch({ pageSize: 1 }).then((result) => {
      if (active) setReferenceOptions(result.watches);
    }).catch(() => { /* the fallback-baseline select stays empty; core dialog works without it */ });
    return () => { active = false; };
  }, []);
  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    const rawSensitivity = Number(sensitivity);
    const safeSensitivity = Number.isFinite(rawSensitivity) && rawSensitivity >= 0.6 && rawSensitivity <= 1.6 ? rawSensitivity : 1;
    const parsedSourceIntervals: Partial<Record<Marketplace, number>> = {};
    for (const [source, raw] of Object.entries(sourceIntervals)) {
      if (raw === "") continue;
      const minutes = Number(raw);
      if (!Number.isInteger(minutes) || minutes < 5 || minutes > 1440) continue;
      if (!sources.includes(source as Marketplace)) continue;
      parsedSourceIntervals[source as Marketplace] = minutes;
    }
    try {
      await onSubmit({
        ...(initialWatch?.id ? { id: initialWatch.id } : {}),
        name: name.trim(),
        query: query.trim(),
        terms: terms.trim(),
        excluded: excluded.trim(),
        sources,
        location: "Polska",
        condition,
        samples: initialWatch?.samples ?? 0,
        targetSamples: initialWatch?.targetSamples ?? 30,
        observationHours: initialWatch?.observationHours ?? 0,
        readiness: initialWatch?.readiness ?? 0,
        status: initialWatch?.status ?? "Learning",
        interval: numericInterval,
        sourceIntervals: parsedSourceIntervals,
        nextScan: "due now",
        enabled: initialWatch?.enabled ?? true,
        exactUrls: exactUrls
          .split(/\r?\n/)
          .map((url) => url.trim())
          .filter(Boolean),
        sensitivity: safeSensitivity,
        shippingOnly,
        typoVariants,
        aiRelevance,
        variantGroups: cleanVariantGroups,
        variantGroupsAuto: variantGroupsAuto && !cleanVariantGroups.length,
        variants: initialWatch?.variants ?? [],
        dealCounts: initialWatch?.dealCounts ?? { exceptional: 0, veryStrong: 0, strong: 0 },
        referenceMarketWatchId: referenceMarketWatchId.trim() ? referenceMarketWatchId.trim() : null,
        minPrice: numericMin,
        maxPrice: numericMax,
        // Kept only while OLX is a source, so a removed source cannot leave a
        // hidden scope behind for when it is re-added.
        olxCategory: sources.includes("OLX") ? olxCategory : null,
        sellerType,
        ignorePromoted,
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
  const setSourceInterval = (source: Marketplace, value: string) =>
    setSourceIntervals((current) => ({ ...current, [source]: value }));
  const addVariant = () =>
    setVariantGroups((current) =>
      current.length >= 12
        ? current
        : [...current, { id: newVariantId(), label: "", terms: "" }],
    );
  const updateVariant = (index: number, patch: Partial<VariantGroup>) =>
    setVariantGroups((current) =>
      current.map((group, position) => (position === index ? { ...group, ...patch } : group)),
    );
  const removeVariant = (index: number) =>
    setVariantGroups((current) => current.filter((_, position) => position !== index));
  const suggestVariants = async () => {
    if (!initialWatch?.id) return;
    setSuggesting(true);
    setSuggestionNote(null);
    try {
      const result = await api.suggestVariantGroups(initialWatch.id);
      const source = result.method === "ai" ? "AI" : "title analysis";
      if (result.groups.length) {
        setVariantGroups(result.groups);
        setSuggestionNote(`Suggested ${result.groups.length} from ${result.listings} listings (${source}). Review, then save to apply.`);
      } else {
        setSuggestionNote(result.listings < 2 ? "Not enough listings yet to suggest variants." : `No distinct models found in ${result.listings} listings (${source}).`);
      }
    } catch (suggestError) {
      setSuggestionNote(errorMessage(suggestError));
    } finally {
      setSuggesting(false);
    }
  };
  const cleanVariantGroups = variantGroups
    .map((group) => ({ ...group, label: group.label.trim(), terms: group.terms.trim() }))
    .filter((group) => group.label && group.terms);
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
            <label className="field-label">
              Seller <span>OLX, Vinted</span>
              <select
                value={sellerType ?? ""}
                onChange={(event) => setSellerType(event.target.value === "private" || event.target.value === "business" ? event.target.value : null)}
              >
                <option value="">Any seller</option>
                <option value="private">Private only</option>
                <option value="business">Business only</option>
              </select>
            </label>
          </div>
          {sources.includes("OLX") ? (
            <OlxCategoryPicker query={query} value={olxCategory} onChange={setOlxCategory} />
          ) : null}
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
              Default polling interval <span>5–1440 min</span>
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
            {sources.length ? (
              <div className="source-intervals">
                <small className="source-intervals-hint">
                  Optional per-marketplace check interval. Leave blank to follow the default.
                </small>
                {sources.map((source) => (
                  <label className="source-interval-row" key={source}>
                    <span className="source-interval-name">
                      <i style={{ background: marketplaceColors[source] }} />
                      {source}
                    </span>
                    <input
                      type="number"
                      min="5"
                      max="1440"
                      inputMode="numeric"
                      aria-label={`${source} polling interval in minutes`}
                      placeholder={`Default · ${interval || 5}`}
                      value={sourceIntervals[source] ?? ""}
                      onChange={(event) => setSourceInterval(source, event.target.value)}
                    />
                    <em>min</em>
                  </label>
                ))}
              </div>
            ) : null}
          </div>
          <label className="check-option check-option--modal">
            <input type="checkbox" checked={shippingOnly} onChange={(event) => setShippingOnly(event.target.checked)} />
            <span><strong>Require shipping</strong><small>Only learn from and alert on listings with confirmed shipping</small></span>
          </label>
          <label className="check-option check-option--modal">
            <input type="checkbox" checked={ignorePromoted} onChange={(event) => setIgnorePromoted(event.target.checked)} />
            <span><strong>Skip promoted listings</strong><small>Ignore paid placements and highlighted ads, which are mostly dealers (OLX, Vinted)</small></span>
          </label>
          <label className="check-option check-option--modal">
            <input type="checkbox" checked={typoVariants} onChange={(event) => setTypoVariants(event.target.checked)} />
            <span><strong>Scan typo variants</strong><small>Catch misspelled listings — up to 2 extra searches per scan</small></span>
          </label>
          <label className="check-option check-option--modal">
            <input type="checkbox" checked={aiRelevance} onChange={(event) => setAiRelevance(event.target.checked)} />
            <span><strong>Use AI relevance filtering</strong><small>Exclude accessories, replacement parts, services, and unrelated listings when OpenRouter is configured</small></span>
          </label>
          <div className="field-label">
            <span>Model variants <span>optional · split a broad search by model</span></span>
            <div className="variant-editor">
              {variantGroups.map((group, index) => (
                <div className="variant-row" key={group.id}>
                  <input
                    value={group.label}
                    onChange={(event) => updateVariant(index, { label: event.target.value })}
                    placeholder="Label, e.g. 1660 Super"
                  />
                  <input
                    value={group.terms}
                    onChange={(event) => updateVariant(index, { terms: event.target.value })}
                    placeholder="Match terms, e.g. 1660 super"
                  />
                  <button
                    type="button"
                    className="icon-button"
                    onClick={() => removeVariant(index)}
                    aria-label={`Remove ${group.label || "variant"}`}
                  >
                    <X size={16} />
                  </button>
                </div>
              ))}
              <div className="variant-actions">
                <button type="button" className="ghost-button" disabled={variantGroups.length >= 12} onClick={addVariant}>
                  <Plus size={15} />
                  Add variant
                </button>
                {initialWatch?.id ? (
                  <button type="button" className="ghost-button" disabled={suggesting} onClick={() => void suggestVariants()}>
                    {suggesting ? <LoaderCircle size={15} className="spin" /> : <Sparkles size={15} />}
                    {variantGroups.length ? "Re-suggest from listings" : "Suggest from listings"}
                  </button>
                ) : null}
              </div>
              {suggestionNote ? <small className="field-hint" role="status">{suggestionNote}</small> : null}
              {variantGroups.length ? null : (
                <label className="check-option check-option--modal">
                  <input type="checkbox" checked={variantGroupsAuto} onChange={(event) => setVariantGroupsAuto(event.target.checked)} />
                  <span><strong>Generate variants automatically</strong><small>Once {initialWatch ? "this watch has" : "the watch finds"} enough listings, Scout groups them by model from their titles. You can edit the groups afterwards.</small></span>
                </label>
              )}
              <small className="field-hint">
                The most specific match wins, so “1660 super” and “1660 ti” take precedence over “1660”. Listings that match no group share an “Other” baseline. Each variant learns its own typical price and alerts separately.
              </small>
            </div>
          </div>
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
          {!validSourceIntervals ? <div className="form-error" role="alert"><AlertTriangle size={15} />Per-marketplace intervals must be whole minutes between 5 and 1440.</div> : null}
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
