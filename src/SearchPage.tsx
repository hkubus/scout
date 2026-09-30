import { useEffect, useRef, useState, type FormEvent } from "react";
import { AlertTriangle, Bell, Check, ExternalLink, ListFilter, LoaderCircle, Search, Tag } from "lucide-react";
import { api } from "./api";
import { marketplaceColors } from "./data";
import { subscribe } from "./events";
import type { WatchPreset } from "./presets";
import { OlxCategoryPicker } from "./OlxCategoryPicker";
import type { Listing, Marketplace, OlxCategory, SearchFilters, SearchSourceStatus } from "./types";

const formatPln = (value: number | null) =>
  value === null ? "Learning" : `${value.toLocaleString("pl-PL")} zł`;

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "Something went wrong";

/** Stable id without depending on a secure context (`crypto.randomUUID`). */
function makeSearchId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Merge streamed or paged results into the current list, cheapest first. */
function mergeListings(current: Listing[], incoming: Listing[]) {
  const byId = new Map(current.map((listing) => [listing.id, listing]));
  for (const listing of incoming) byId.set(listing.id, listing);
  return [...byId.values()].sort((a, b) => a.price - b.price);
}

function safeImageUrl(value: string | null | undefined) {
  if (!value) return null;
  if (value.startsWith("data:image/")) return value;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function PageHeader({ title, description }: { title: string; description?: string }) {
  return (
    <header className="page-header page-header--inner">
      <div>
        <h1>{title}</h1>
        {description ? <p>{description}</p> : null}
      </div>
    </header>
  );
}

function ListingThumbnail({ listing }: { listing: Listing }) {
  const [failed, setFailed] = useState(false);
  const image = safeImageUrl(listing.image);
  return image && !failed ? <img src={image} alt="" loading="lazy" onError={() => setFailed(true)} /> : <div className="listing-thumb-placeholder"><Tag size={20} /></div>;
}

export default function SearchPage({ onSelectListing, onSaveWatch }: { onSelectListing: (listing: Listing) => void; onSaveWatch: (preset: WatchPreset) => void }) {
  const [query, setQuery] = useState("");
  const [terms, setTerms] = useState("");
  const [excluded, setExcluded] = useState("");
  const [minPrice, setMinPrice] = useState("");
  const [maxPrice, setMaxPrice] = useState("");
  const [condition, setCondition] = useState("Any");
  const [ownerType, setOwnerType] = useState("Any");
  const [location, setLocation] = useState("");
  const [shippingOnly, setShippingOnly] = useState(false);
  const [olxCategory, setOlxCategory] = useState<OlxCategory | null>(null);
  // Persisted across searches: once a user turns the Jev relevance filter off,
  // their next searches stay fast until they re-enable it here.
  const [aiRelevance, setAiRelevance] = useState(
    () => localStorage.getItem("scout-search-ai-relevance") !== "0",
  );
  const [sources, setSources] = useState<Marketplace[]>([
    "OLX",
    "Allegro Lokalnie",
    "Vinted",
  ]);
  const [listings, setListings] = useState<Listing[]>([]);
  const [sourceStatuses, setSourceStatuses] = useState<SearchSourceStatus[]>(
    [],
  );
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [exhausted, setExhausted] = useState(false);
  const [page, setPage] = useState(1);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const searchSequence = useRef(0);
  const searchController = useRef<AbortController | null>(null);
  const searchIdRef = useRef("");
  const numericMin = minPrice === "" ? null : Number(minPrice);
  const numericMax = maxPrice === "" ? null : Number(maxPrice);
  const validPrices =
    (numericMin === null || (Number.isFinite(numericMin) && numericMin >= 0)) &&
    (numericMax === null || (Number.isFinite(numericMax) && numericMax > 0)) &&
    (numericMin === null || numericMax === null || numericMin <= numericMax);
  const buildFilters = (targetPage: number): SearchFilters => ({
    query: query.trim(),
    terms: terms.trim(),
    excluded: excluded.trim(),
    sources,
    minPrice: numericMin,
    maxPrice: numericMax,
    shippingOnly,
    condition,
    location: location.trim() || "Polska",
    ownerType: ownerType === "Any" ? null : ownerType.toLowerCase() as "private" | "business",
    olxCategory: sources.includes("OLX") ? olxCategory : null,
    page: targetPage,
    aiRelevance,
  });
  const toggleSource = (source: Marketplace) =>
    setSources((current) =>
      current.includes(source)
        ? current.filter((item) => item !== source)
        : [...current, source],
    );

  // Per-source progress arrives over SSE while the request is still running, so
  // a fast marketplace renders before a slow one finishes. Events are keyed by
  // the search id and merged best-effort; the HTTP response reconciles.
  useEffect(() => {
    const unsubscribe = subscribe("search", (payload) => {
      const event = payload as { searchId?: string; status?: SearchSourceStatus; listings?: Listing[] } | null;
      if (!event || event.searchId !== searchIdRef.current || !event.status) return;
      setSourceStatuses((current) => [...current.filter((item) => item.source !== event.status!.source), event.status!]);
      if (event.listings?.length) setListings((current) => mergeListings(current, event.listings!));
    });
    return unsubscribe;
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!query.trim() || !sources.length || !validPrices) return;
    searchController.current?.abort();
    const controller = new AbortController();
    searchController.current = controller;
    const sequence = ++searchSequence.current;
    const searchId = makeSearchId();
    searchIdRef.current = searchId;
    setLoading(true);
    setLoadingMore(false);
    setError(null);
    setSearched(true);
    setListings([]);
    setPage(1);
    setExhausted(false);
    setSourceStatuses(sources.map((source): SearchSourceStatus => ({ source, status: "searching", count: 0, pendingShipping: 0, durationMs: 0, message: "Searching…" })));
    try {
      const result = await api.search({ ...buildFilters(1), searchId }, controller.signal);
      if (sequence !== searchSequence.current || controller.signal.aborted) return;
      setListings(result.listings);
      setSourceStatuses(result.sources);
      setExhausted(result.listings.length === 0);
    } catch (searchError) {
      if (sequence !== searchSequence.current || controller.signal.aborted) return;
      setError(errorMessage(searchError));
    } finally {
      if (sequence === searchSequence.current) setLoading(false);
    }
  };

  // Pages past the per-request cap instead of dropping results silently.
  const loadMore = async () => {
    if (loading || loadingMore || exhausted || page >= 10) return;
    const nextPage = page + 1;
    setLoadingMore(true);
    setError(null);
    try {
      const result = await api.search(buildFilters(nextPage));
      setListings((current) => mergeListings(current, result.listings));
      // Keep the first page's per-source counts; only surface new failures.
      setSourceStatuses((current) => current.map((item) => {
        const updated = result.sources.find((status) => status.source === item.source);
        return updated?.status === "error" ? updated : item;
      }));
      setPage(nextPage);
      if (!result.listings.length) setExhausted(true);
    } catch (loadError) {
      setError(errorMessage(loadError));
    } finally {
      setLoadingMore(false);
    }
  };
  return (
    <>
      <PageHeader
        title="Search"
        description="Search all marketplaces now without creating a watch or changing its price history."
      />
      <form className="manual-search-panel" onSubmit={submit}>
        <div className="manual-search-query">
          <Search size={19} />
          <input
            autoFocus
            aria-label="Search marketplaces"
            placeholder="What are you looking for?"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <button
            className="primary-button"
            disabled={
              loading || !query.trim() || !sources.length || !validPrices
            }
          >
            {loading ? (
              <LoaderCircle size={18} className="spin" />
            ) : (
              <Search size={18} />
            )}
            {loading ? "Searching…" : "Search all"}
          </button>
        </div>
        <div className="search-filter-grid">
          <label className="field-label">
            Minimum price <span>PLN</span>
            <input
              type="number"
              min="0"
              step="1"
              placeholder="No minimum"
              value={minPrice}
              onChange={(event) => setMinPrice(event.target.value)}
            />
          </label>
          <label className="field-label">
            Maximum price <span>PLN</span>
            <input
              type="number"
              min="1"
              step="1"
              placeholder="No maximum"
              value={maxPrice}
              onChange={(event) => setMaxPrice(event.target.value)}
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
              <option>Used</option>
            </select>
          </label>
          <label className="field-label">
            Seller <span>OLX only</span>
            <select
              value={ownerType}
              onChange={(event) => setOwnerType(event.target.value)}
            >
              <option>Any</option>
              <option>Private</option>
              <option>Business</option>
            </select>
          </label>
          <label className="field-label">
            Location <span>where available</span>
            <input
              placeholder="Anywhere"
              value={location}
              onChange={(event) => setLocation(event.target.value)}
            />
          </label>
        </div>
        <div className="search-advanced-row">
          <label className="field-label">
            Included terms
            <input
              placeholder="e.g. oled, 512gb"
              value={terms}
              onChange={(event) => setTerms(event.target.value)}
            />
          </label>
          <label className="field-label">
            Excluded terms
            <input
              placeholder="e.g. broken, parts"
              value={excluded}
              onChange={(event) => setExcluded(event.target.value)}
            />
          </label>
        </div>
        {sources.includes("OLX") ? (
          <div className="search-olx-category">
            <OlxCategoryPicker query={query} value={olxCategory} onChange={setOlxCategory} />
          </div>
        ) : null}
        <div className="search-options-row">
          <div>
            <span className="filter-label">Sources</span>
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
          <label className="check-option">
            <input
              type="checkbox"
              checked={shippingOnly}
              onChange={(event) => setShippingOnly(event.target.checked)}
            />
            <span>
              <strong>Shipping only</strong>
              <small>Hide pickup-only and unknown delivery results</small>
            </span>
          </label>
          <label className="check-option">
            <input
              type="checkbox"
              checked={aiRelevance}
              onChange={(event) => {
                setAiRelevance(event.target.checked);
                localStorage.setItem(
                  "scout-search-ai-relevance",
                  event.target.checked ? "1" : "0",
                );
              }}
            />
            <span>
              <strong>AI relevance filtering</strong>
              <small>Hide accessories, parts, and unrelated matches; off is faster</small>
            </span>
          </label>
        </div>
        {!validPrices ? (
          <div className="form-error" role="alert">
            <AlertTriangle size={15} />
            Enter a valid price range; the minimum cannot exceed the maximum.
          </div>
        ) : null}
      </form>
      {sourceStatuses.length ? (
        <div
          className="search-source-statuses"
          aria-label="Marketplace search status"
        >
          {sourceStatuses.map((status) => (
            <div
              key={status.source}
              className={`search-source-status search-source-status--${status.status}`}
            >
              <i style={{ background: marketplaceColors[status.source] }} />
              <div>
                <strong>{status.source}</strong>
                <span>
                  {status.message}
                  {status.pendingShipping
                    ? ` · ${status.pendingShipping} delivery checks pending`
                    : ""}
                </span>
              </div>
              <small>
                {status.status === "searching"
                  ? "…"
                  : `${(status.durationMs / 1000).toFixed(1)}s`}
              </small>
            </div>
          ))}
        </div>
      ) : null}
      {error ? (
        <div className="search-error" role="alert">
          <AlertTriangle size={18} />
          {error}
        </div>
      ) : null}
      <section className="search-results">
        <div className="section-heading-row">
          <h2>
            {searched
              ? `${listings.length} ${listings.length === 1 ? "result" : "results"}${loading ? " so far…" : ""}`
              : "Results"}
          </h2>
          {searched && !loading ? (
            <div className="search-results-actions">
              <span className="toolbar-meta">Sorted by lowest price</span>
              {listings.length && !exhausted && page < 10 ? (
                <button className="outline-button" type="button" disabled={loadingMore} onClick={loadMore}>
                  {loadingMore ? <LoaderCircle size={15} className="spin" /> : null}
                  {loadingMore ? "Loading…" : "Load more"}
                </button>
              ) : null}
              <button className="outline-button" type="button" onClick={() => onSaveWatch({ query: query.trim(), terms: terms.trim(), excluded: excluded.trim(), sources, location: location.trim() || "Polska", condition, minPrice: numericMin, maxPrice: numericMax, shippingOnly, aiRelevance, olxCategory: sources.includes("OLX") ? olxCategory : null })}><Bell size={15} />Save as watch</button>
            </div>
          ) : null}
        </div>
        {listings.length ? (
          <SearchResultsTable listings={listings} onSelect={onSelectListing} />
        ) : loading ? (
          <div className="table-loading">
            <LoaderCircle size={20} className="spin" />
            Searching public marketplace pages…
          </div>
        ) : (
          <div className="empty-state">
            <ListFilter size={25} />
            <strong>
              {searched ? "No matching listings" : "Ready when you are"}
            </strong>
            <span>
              {searched
                ? "Try widening the price range or removing a filter."
                : "Choose filters and search across the selected marketplaces."}
            </span>
          </div>
        )}
      </section>
    </>
  );
}

function SearchResultsTable({ listings, onSelect }: { listings: Listing[]; onSelect: (listing: Listing) => void }) {
  return (
    <div className="search-table-wrap" role="table" aria-label="Manual search results">
      <div className="search-table search-table--head" role="row">
        <span role="columnheader">Item</span>
        <span role="columnheader">Marketplace</span>
        <span role="columnheader">Price</span>
        <span role="columnheader">Shipping</span>
        <span role="columnheader">Condition / location</span>
        <span role="columnheader" />
      </div>
      {listings.map((listing) => (
        <div className="search-table search-result-row" role="row" key={listing.associationId ?? listing.id}>
          <button
            type="button"
            className="listing-item listing-item--button"
            onClick={() => onSelect(listing)}
            aria-label={`View details for ${listing.title}`}
          >
            <ListingThumbnail listing={listing} />
            <div>
              <strong>{listing.title}</strong>
              <span>{listing.subtitle || "No extra details"}</span>
            </div>
          </button>
          <div className="marketplace-cell" role="cell">
            <i style={{ background: marketplaceColors[listing.marketplace] }} />
            {listing.marketplace}
          </div>
          <div className="price-cell search-price-cell" role="cell">
            <strong>{formatPln(listing.price)}</strong>
            <PriceNegotiability listing={listing} />
          </div>
          <span
            className={`shipping-state shipping-state--${listing.shippingAvailable === true ? "yes" : listing.shippingAvailable === false ? "no" : "unknown"}`}
            role="cell"
          >
            {listing.shippingAvailable === true
              ? "Available"
              : listing.shippingAvailable === false
                ? "Pickup only"
                : "Unknown"}
          </span>
          <span role="cell">
            {[listing.condition, listing.location]
              .filter(Boolean)
              .join(" · ") || "—"}
          </span>
          <a
            href={listing.url}
            target="_blank"
            rel="noopener noreferrer"
            className="external-link"
            aria-label={`Open ${listing.title}`}
          >
            <ExternalLink size={17} />
          </a>
        </div>
      ))}
    </div>
  );
}

function PriceNegotiability({ listing }: { listing: Listing }) {
  const supported = listing.marketplace === "OLX" || listing.marketplace === "Allegro Lokalnie";
  const state = !supported ? "unknown" : listing.priceNegotiable === true ? "yes" : listing.priceNegotiable === false ? "no" : "unknown";
  const label = !supported ? "Not checked" : listing.priceNegotiable === true ? "Negotiable" : listing.priceNegotiable === false ? "Fixed price" : "Not indicated";
  return <span className={`negotiability-state negotiability-state--${state}`}>{label}</span>;
}

