import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, Database, Search, X } from "lucide-react";
import { api } from "./api";
import { subscribe } from "./events";
import { applyListingActionToPage, isListingActionEvent, listingActionKey, type ListingActionEvent } from "./listingActions";
import ListingTable from "./ListingTable";
import type { Listing, ListingAction, ListingDecision, Marketplace } from "./types";

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

export default function ListingsPage({
  listings,
  refreshKey,
  selectedWatchId,
  onClearWatch,
  onSelectListing,
  onToggleHidden,
}: {
  listings: Listing[];
  /** Bumped when server events (scans, listing actions) leave the fetched page stale. */
  refreshKey: number;
  selectedWatchId: string | null;
  onClearWatch: () => void;
  onSelectListing: (listing: Listing) => void;
  onToggleHidden: (listing: Listing) => Promise<ListingAction | null>;
}) {
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [marketplace, setMarketplace] = useState<"All" | Marketplace>("All");
  const [sort, setSort] = useState<"Newest" | "Strongest" | "Price">("Newest");
  const [decision, setDecision] = useState<"All" | ListingDecision>("All");
  const [visibility, setVisibility] = useState<"Visible" | "Hidden" | "All">("Visible");
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

  // Every filter is applied by the API across all pages, so a filter change
  // restarts from page 1 instead of filtering only the loaded page. The page
  // is derived in the same render, so no request goes out with the old page.
  const filtersKey = [selectedWatchId, debouncedSearch, marketplace, sortKey, decision, visibilityKey].join("|");
  const [pageState, setPageState] = useState({ key: filtersKey, page: 1 });
  const page = pageState.key === filtersKey ? pageState.page : 1;

  useEffect(() => {
    const controller = new AbortController();
    setLoadingPage(true);
    api.listings({
      page,
      pageSize: 500,
      watchId: selectedWatchId ?? undefined,
      q: debouncedSearch || undefined,
      marketplace: marketplace === "All" ? undefined : marketplace,
      sort: sortKey,
      decision: decision === "All" ? undefined : decision,
      visibility: visibilityKey,
    }, controller.signal)
      .then((result) => setRemote({ listings: result.listings, pagination: result.pagination }))
      .catch(() => {
        if (controller.signal.aborted) return;
        setRemote(null);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingPage(false);
      });
    return () => controller.abort();
  }, [page, selectedWatchId, debouncedSearch, marketplace, sortKey, decision, visibilityKey, refreshKey]);

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
      if (selectedWatchId && listing.watchId !== selectedWatchId) continue;
      if (decision !== "All" && listing.decision !== decision) continue;
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
    );
  }, [remoteListings, listings, marketplace, debouncedSearch, selectedWatchId, sort, decision, visibility]);

  return (
    <>
      <header className="page-header">
        <div>
          <h1>Listings</h1>
          <p>Every saved match, with the baseline behind the deal score.</p>
        </div>
      </header>
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
        <SelectControl
          value={marketplace === "All" ? "All marketplaces" : marketplace}
          options={["All marketplaces", "OLX", "Allegro Lokalnie", "Vinted"]}
          onChange={(value) => setMarketplace(value === "All marketplaces" ? "All" : value as Marketplace)}
        />
        <SelectControl
          value={sort === "Newest" ? "Newest first" : sort === "Strongest" ? "Strongest first" : "Lowest price"}
          options={["Newest first", "Strongest first", "Lowest price"]}
          onChange={(value) => setSort(value === "Strongest first" ? "Strongest" : value === "Lowest price" ? "Price" : "Newest")}
        />
        <SelectControl
          value={decision === "All" ? "All decisions" : decision === "buy" ? "Buy" : decision === "watch" ? "Watch" : "Pass"}
          options={["All decisions", "Buy", "Watch", "Pass"]}
          onChange={(value) => setDecision(value === "Buy" ? "buy" : value === "Watch" ? "watch" : value === "Pass" ? "pass" : "All")}
        />
        <SelectControl
          value={visibility === "Visible" ? "Visible listings" : visibility === "Hidden" ? "Hidden only" : "All listings"}
          options={["Visible listings", "Hidden only", "All listings"]}
          onChange={(value) => setVisibility(value === "Hidden only" ? "Hidden" : value === "All listings" ? "All" : "Visible")}
        />
      </div>
      {selectedWatchId ? (
        <div className="active-filter">
          <span>
            Showing listings for <strong>{listings.find((listing) => listing.watchId === selectedWatchId)?.watch ?? selectedWatchId}</strong>
          </span>
          <button onClick={onClearWatch}>
            <X size={14} />
            Clear filter
          </button>
        </div>
      ) : null}
      <ListingTable listings={filtered} onSelect={onSelectListing} onToggleHidden={toggleHidden} />
      {pagination && (pagination.page > 1 || pagination.hasNext) ? (
        <div className="research-pagination listings-pagination">
          <button className="outline-button" disabled={page <= 1 || loadingPage} onClick={() => setPageState({ key: filtersKey, page: Math.max(1, page - 1) })}>Previous</button>
          <span>Page {pagination.page} · {pagination.total.toLocaleString("pl-PL")} matching listings</span>
          <button className="outline-button" disabled={!pagination.hasNext || loadingPage} onClick={() => setPageState({ key: filtersKey, page: page + 1 })}>Next</button>
        </div>
      ) : null}
      <div className="retention-note">
        <Database size={17} />
        <span>Listing history is retained for 180 days. Thumbnail cache is pruned separately.</span>
      </div>
    </>
  );
}
