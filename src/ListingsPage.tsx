import { useCallback, useEffect, useMemo, useState } from "react";
import { Search, SlidersHorizontal, X } from "lucide-react";
import { api } from "./api";
import { subscribe } from "./events";
import { applyListingActionToPage, isListingActionEvent, listingActionKey, type DecisionFilter, type ListingActionEvent } from "./listingActions";
import { pageForFilters, reuseUnchangedListings } from "./listingRows";
import ListingTable from "./ListingTable";
import type { Listing, ListingAction, Marketplace } from "./types";
import { PageHeader, SelectControl } from "./ui";

const PAGE_SIZE = 50;

type Sort = "Newest" | "Strongest" | "Price";
type Visibility = "Visible" | "Hidden" | "AI" | "All";

/** Filters another page opens Listings with (Overview counts, a watch card). */
export type ListingsPreset = {
  watchId?: string;
  watchName?: string;
  minStrength?: number;
  sort?: Sort;
  decision?: DecisionFilter;
  visibility?: Visibility;
};

const strengthOptions = [
  { value: "1", label: "All strengths" },
  { value: "3", label: "Strong+ (≥12%)" },
  { value: "4", label: "Very strong+ (≥20%)" },
  { value: "5", label: "Exceptional (≥30%)" },
];
const decisionOptions = [
  { value: "All", label: "Any decision" },
  { value: "none", label: "Untriaged" },
  { value: "buy", label: "Buy" },
  { value: "watch", label: "Maybe" },
  { value: "pass", label: "Pass" },
];
const visibilityOptions = [
  { value: "Visible", label: "Visible" },
  { value: "Hidden", label: "Hidden only" },
  { value: "AI", label: "Filtered by AI" },
  { value: "All", label: "Visible and hidden" },
];
const sortOptions = [
  { value: "Newest", label: "Recently seen" },
  { value: "Strongest", label: "Strongest first" },
  { value: "Price", label: "Lowest price" },
];

export default function ListingsPage({
  listings,
  refreshKey,
  preset,
  onSelectListing,
  onToggleHidden,
}: {
  listings: Listing[];
  /** Bumped when server events (scans, listing actions) leave the fetched page stale. */
  refreshKey: number;
  preset: ListingsPreset;
  onSelectListing: (listing: Listing) => void;
  onToggleHidden: (listing: Listing) => Promise<ListingAction | null>;
}) {
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [watch, setWatch] = useState(preset.watchId ? { id: preset.watchId, name: preset.watchName ?? preset.watchId } : null);
  const [marketplace, setMarketplace] = useState<"All" | Marketplace>("All");
  const [sort, setSort] = useState<Sort>(preset.sort ?? "Newest");
  const [minStrength, setMinStrength] = useState(preset.minStrength ?? 1);
  const [decision, setDecision] = useState<DecisionFilter>(preset.decision ?? "All");
  const [visibility, setVisibility] = useState<Visibility>(preset.visibility ?? "Visible");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [remote, setRemote] = useState<{ listings: Listing[]; pagination: { page: number; pageSize: number; total: number; hasNext: boolean } } | null>(null);
  const remoteListings = remote?.listings ?? null;
  const pagination = remote?.pagination ?? null;
  const [loadingPage, setLoadingPage] = useState(false);

  // Debounce typing so one search fires after the user pauses, not per keystroke.
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  const sortKey = sort === "Strongest" ? "strongest" : sort === "Price" ? "price" : "newest";
  const visibilityKey = visibility === "Visible" ? "visible" : visibility === "Hidden" ? "hidden" : "all";
  const aiFiltered = visibility === "AI" ? "only" : "exclude";
  const watchId = watch?.id ?? null;

  // Every filter is applied by the API across all pages, so a filter change
  // restarts from page 1 instead of filtering only the loaded page. The page
  // is derived in the same render, so no request goes out with the old page.
  const filtersKey = [watchId, debouncedSearch, marketplace, sortKey, minStrength, decision, visibility].join("|");
  const [storedPage, setPageState] = useState({ key: filtersKey, page: 1 });
  const pageState = pageForFilters(storedPage, filtersKey);
  if (pageState !== storedPage) setPageState(pageState);
  const page = pageState.page;

  useEffect(() => {
    const controller = new AbortController();
    setLoadingPage(true);
    api.listings({
      page,
      pageSize: PAGE_SIZE,
      watchId: watchId ?? undefined,
      q: debouncedSearch || undefined,
      marketplace: marketplace === "All" ? undefined : marketplace,
      sort: sortKey,
      minStrength,
      decision: decision === "All" ? undefined : decision,
      visibility: visibilityKey,
      aiFiltered,
    }, controller.signal)
      // Unchanged rows keep their identity, so their memoized rows skip.
      .then((result) => setRemote((current) => ({ listings: current ? reuseUnchangedListings(current.listings, result.listings) : result.listings, pagination: result.pagination })))
      .catch(() => {
        if (controller.signal.aborted) return;
        setRemote(null);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingPage(false);
      });
    return () => controller.abort();
  }, [page, watchId, debouncedSearch, marketplace, sortKey, minStrength, decision, visibilityKey, aiFiltered, refreshKey]);

  // Triage saves (this tab or another) patch the loaded page at once and drop
  // rows that left the decision/visibility filter; App schedules the refetch.
  const applyListingAction = useCallback((event: ListingActionEvent) => {
    setRemote((current) => {
      if (!current) return current;
      const { rows, removed } = applyListingActionToPage(current.listings, event, decision, visibilityKey);
      if (rows === current.listings) return current;
      return { listings: rows, pagination: { ...current.pagination, total: Math.max(0, current.pagination.total - removed) } };
    });
  }, [decision, visibilityKey]);
  useEffect(() => subscribe("listing-action", (payload) => {
    if (isListingActionEvent(payload)) applyListingAction(payload);
  }), [applyListingAction]);
  const toggleHidden = useCallback(async (listing: Listing) => {
    const action = await onToggleHidden(listing);
    if (action) applyListingAction({ key: listingActionKey(listing), decision: action.decision, hidden: action.hidden });
  }, [applyListingAction, onToggleHidden]);

  // Offline fallback only: an unreachable API filters the dashboard feed in
  // memory. Server-backed results already cover every page and are pre-sorted.
  const filtered = useMemo(() => {
    if (remoteListings) return remoteListings;
    const normalizedSearch = debouncedSearch.toLowerCase();
    const matches: Listing[] = [];
    for (const listing of listings) {
      if (marketplace !== "All" && listing.marketplace !== marketplace) continue;
      if (watchId && listing.watchId !== watchId) continue;
      if (listing.dealStrength < minStrength) continue;
      if (decision === "none" ? listing.decision : decision !== "All" && listing.decision !== decision) continue;
      if (visibility === "AI" ? !listing.aiFiltered : listing.aiFiltered) continue;
      if (visibility === "Visible" && listing.hidden) continue;
      if (visibility === "Hidden" && !listing.hidden) continue;
      if (!`${listing.title} ${listing.subtitle} ${listing.condition ?? ""} ${listing.location ?? ""}`.toLowerCase().includes(normalizedSearch)) continue;
      matches.push(listing);
    }
    return matches.sort((a, b) =>
      sort === "Strongest"
        ? b.dealStrength - a.dealStrength
        : sort === "Price"
          ? a.price - b.price
          : (Date.parse(b.observedAt) || 0) - (Date.parse(a.observedAt) || 0),
    ).slice(0, PAGE_SIZE);
  }, [remoteListings, listings, marketplace, debouncedSearch, watchId, minStrength, sort, decision, visibility]);

  const activeFilters = (marketplace !== "All" ? 1 : 0) + (minStrength > 1 ? 1 : 0) + (decision !== "All" ? 1 : 0) + (visibility !== "Visible" ? 1 : 0);
  const pageCount = pagination ? Math.max(1, Math.ceil(pagination.total / pagination.pageSize)) : 1;
  const goToPage = (next: number) => {
    setPageState({ key: filtersKey, page: next });
    window.scrollTo({ top: 0 });
  };

  return (
    <>
      <PageHeader title="Listings" />
      <div className="toolbar toolbar--listings">
        <label className="search-input">
          <Search size={17} />
          <input
            aria-label="Search listings"
            placeholder="Search title or condition"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <button
          type="button"
          className={`outline-button filters-toggle${activeFilters ? " active-filter" : ""}`}
          aria-expanded={filtersOpen}
          aria-controls="listing-filters"
          onClick={() => setFiltersOpen((open) => !open)}
        >
          <SlidersHorizontal size={15} />
          Filters{activeFilters ? ` (${activeFilters})` : ""}
        </button>
        <div id="listing-filters" className={`filters listing-filters${filtersOpen ? " listing-filters--open" : ""}`}>
          <SelectControl
            label="Marketplace"
            value={marketplace}
            options={[{ value: "All", label: "All marketplaces" }, "OLX", "Allegro Lokalnie", "Vinted"]}
            onChange={(value) => setMarketplace(value as "All" | Marketplace)}
          />
          <SelectControl label="Deal strength" value={String(minStrength)} options={strengthOptions} onChange={(value) => setMinStrength(Number(value))} />
          <SelectControl label="Decision" value={decision} options={decisionOptions} onChange={(value) => setDecision(value as DecisionFilter)} />
          <SelectControl label="Visibility" value={visibility} options={visibilityOptions} onChange={(value) => setVisibility(value as Visibility)} />
          <SelectControl label="Sort" value={sort} options={sortOptions} onChange={(value) => setSort(value as Sort)} />
        </div>
      </div>
      <div className="listings-summary">
        {watch ? (
          <span className="active-filter">
            {watch.name}
            <button type="button" onClick={() => setWatch(null)} aria-label="Show listings from every watch">
              <X size={14} />
            </button>
          </span>
        ) : null}
        {pagination ? (
          <span className="toolbar-meta">
            {pagination.total.toLocaleString("pl-PL")} {pagination.total === 1 ? "listing" : "listings"}
            {pageCount > 1 ? ` · page ${pagination.page} of ${pageCount}` : ""}
          </span>
        ) : null}
      </div>
      <ListingTable listings={filtered} onSelect={onSelectListing} onToggleHidden={visibility === "AI" ? undefined : toggleHidden} />
      {pagination && (pagination.page > 1 || pagination.hasNext) ? (
        <div className="research-pagination listings-pagination">
          <button className="outline-button" disabled={page <= 1 || loadingPage} onClick={() => goToPage(Math.max(1, page - 1))}>Previous</button>
          <span>Page {pagination.page} of {pageCount}</span>
          <button className="outline-button" disabled={!pagination.hasNext || loadingPage} onClick={() => goToPage(page + 1)}>Next</button>
        </div>
      ) : null}
    </>
  );
}
