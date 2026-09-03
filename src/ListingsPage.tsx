import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { ChevronDown, Database, Search, X } from "lucide-react";
import { api } from "./api";
import ListingTable from "./ListingTable";
import type { Listing, ListingDecision, Marketplace } from "./types";

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
  selectedWatchId,
  onClearWatch,
  onSelectListing,
}: {
  listings: Listing[];
  selectedWatchId: string | null;
  onClearWatch: () => void;
  onSelectListing: (listing: Listing) => void;
}) {
  const [search, setSearch] = useState("");
  const [marketplace, setMarketplace] = useState<"All" | Marketplace>("All");
  const [sort, setSort] = useState<"Newest" | "Strongest" | "Price">("Newest");
  const [decision, setDecision] = useState<"All" | ListingDecision>("All");
  const [page, setPage] = useState(1);
  const [remoteListings, setRemoteListings] = useState<Listing[] | null>(null);
  const [pagination, setPagination] = useState<{ page: number; pageSize: number; total: number; hasNext: boolean } | null>(null);
  const [loadingPage, setLoadingPage] = useState(false);
  const deferredSearch = useDeferredValue(search);

  useEffect(() => {
    setPage(1);
  }, [selectedWatchId]);

  useEffect(() => {
    const controller = new AbortController();
    setLoadingPage(true);
    api.listings({ page, pageSize: 500, watchId: selectedWatchId ?? undefined }, controller.signal)
      .then((result) => {
        setRemoteListings(result.listings);
        setPagination(result.pagination);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setRemoteListings(null);
        setPagination(null);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingPage(false);
      });
    return () => controller.abort();
  }, [page, selectedWatchId]);

  const pageListings = remoteListings ?? listings;
  const filtered = useMemo(() => {
    const normalizedSearch = deferredSearch.trim().toLowerCase();
    const matches: Listing[] = [];
    for (const listing of pageListings) {
      if (marketplace !== "All" && listing.marketplace !== marketplace) continue;
      if (selectedWatchId && listing.watchId !== selectedWatchId) continue;
      if (decision !== "All" && listing.decision !== decision) continue;
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
  }, [pageListings, marketplace, deferredSearch, selectedWatchId, sort, decision]);

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
      <ListingTable listings={filtered} onSelect={onSelectListing} />
      {pagination && (pagination.page > 1 || pagination.hasNext) ? (
        <div className="research-pagination listings-pagination">
          <button className="outline-button" disabled={page <= 1 || loadingPage} onClick={() => setPage((current) => Math.max(1, current - 1))}>Previous</button>
          <span>Page {pagination.page} · {pagination.total.toLocaleString("pl-PL")} saved matches</span>
          <button className="outline-button" disabled={!pagination.hasNext || loadingPage} onClick={() => setPage((current) => current + 1)}>Next</button>
        </div>
      ) : null}
      <div className="retention-note">
        <Database size={17} />
        <span>Listing history is retained for 180 days. Thumbnail cache is pruned separately.</span>
      </div>
    </>
  );
}
