import { useState } from "react";
import { ExternalLink, Eye, EyeOff, RefreshCw, Search, Tag } from "lucide-react";
import { marketplaceColors } from "./data";
import type { Listing } from "./types";
import { listingAge } from "./listingSignals";

const formatPln = (value: number | null) =>
  value === null ? "Learning" : `${value.toLocaleString("pl-PL")} zł`;

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

export default function ListingTable({
  listings,
  compact = false,
  isLoading = false,
  onSelect,
  onToggleHidden,
}: {
  listings: Listing[];
  compact?: boolean;
  isLoading?: boolean;
  onSelect?: (listing: Listing) => void;
  onToggleHidden?: (listing: Listing) => void;
}) {
  if (isLoading) {
    return (
      <div className="table-loading">
        <RefreshCw size={20} className="spin" />
        Loading matches…
      </div>
    );
  }
  if (!listings.length) {
    return (
      <div className="empty-state">
        <Search size={25} />
        <strong>No listings yet</strong>
        <span>Run a watch to start building its price history.</span>
      </div>
    );
  }
  return (
    <div
      className={`listing-table-wrap ${compact ? "listing-table-wrap--compact" : ""}`}
      role="table"
      aria-label="Saved marketplace listings"
    >
      <div className="listing-table listing-table--head" role="row">
        <span role="columnheader">Item</span>
        <span role="columnheader">Marketplace</span>
        <span role="columnheader">Price (PLN)</span>
        <span role="columnheader">Typical (PLN)</span>
        <span role="columnheader">Below typical</span>
        <span role="columnheader">Observed</span>
        <span role="columnheader">Deal strength</span>
        <span role="columnheader" aria-label="Actions" />
      </div>
      {listings.map((listing) => (
        <ListingRow key={listing.associationId ?? listing.id} listing={listing} onSelect={onSelect} onToggleHidden={onToggleHidden} />
      ))}
    </div>
  );
}

function ListingThumbnail({ listing }: { listing: Listing }) {
  const [failed, setFailed] = useState(false);
  const image = safeImageUrl(listing.image);
  return image && !failed ? (
    <img src={image} alt="" loading="lazy" onError={() => setFailed(true)} />
  ) : (
    <div className="listing-thumb-placeholder">
      <Tag size={20} />
    </div>
  );
}

function ListingRow({ listing, onSelect, onToggleHidden }: { listing: Listing; onSelect?: (listing: Listing) => void; onToggleHidden?: (listing: Listing) => void }) {
  const aiFiltered = Boolean(listing.aiFiltered);
  const hidden = Boolean(listing.hidden);
  return (
    <div className={`listing-table listing-row${aiFiltered ? " listing-row--ai-filtered" : ""}${hidden ? " listing-row--hidden" : ""}`} role="row">
      <button
        type="button"
        className="listing-item listing-item--button"
        onClick={() => onSelect?.(listing)}
        disabled={!onSelect}
        aria-label={`View details for ${listing.title}`}
      >
        <ListingThumbnail listing={listing} />
        <div>
          <strong>{listing.title}</strong>
          <span>{listing.subtitle || listing.watch}</span>
          <ListingSignalChips listing={listing} />
          {listing.decision ? (
            <em className={`decision-chip decision-chip--${listing.decision}`}>
              {listing.decision === "buy" ? "Buy" : listing.decision === "watch" ? "Watch" : "Pass"}
            </em>
          ) : null}
          {listing.variantLabel ? (
            <em className="decision-chip decision-chip--variant" title={`Scored against the “${listing.variantLabel}” model baseline, not the watch-wide blend${listing.variantSource === "jev" ? " · placed by AI" : listing.variantSource === "manual" ? " · set manually" : ""}`}>
              {listing.variantLabel}
            </em>
          ) : null}
          {listing.typicalSource === "reference-band" ? (
            <em className="decision-chip decision-chip--reference" title="Typical shown from the watch's reference research series while its own baseline is learning">
              series baseline
            </em>
          ) : null}
          {aiFiltered ? (
            <em className="decision-chip decision-chip--ai-filtered" title="Hidden by AI relevance filtering">
              Filtered by AI
            </em>
          ) : null}
          {hidden ? (
            <em className="decision-chip decision-chip--hidden" title="Manually hidden from the overview and alerts">
              <EyeOff size={11} />Hidden
            </em>
          ) : null}
        </div>
      </button>
      <div className="marketplace-cell" role="cell">
        <i style={{ background: marketplaceColors[listing.marketplace] }} />
        {listing.marketplace}
      </div>
      <strong className="price-cell" role="cell">{formatPln(listing.price)}</strong>
      <span role="cell">{formatPln(listing.typical)}</span>
      <strong className="discount-cell" role="cell">
        {listing.belowTypical === null ? "—" : `${listing.belowTypical.toFixed(1)}%`}
      </strong>
      <span className="observed-cell" role="cell">{listing.observed}</span>
      <div className="strength-cell" role="cell">
        <DealBars strength={listing.dealStrength} />
        <span>{listing.typical === null ? "Learning" : listing.dealLabel}</span>
      </div>
      <div className="row-actions" role="cell">
        {onToggleHidden ? (
          <button
            type="button"
            className="icon-button row-action"
            onClick={() => onToggleHidden(listing)}
            aria-label={hidden ? `Unhide ${listing.title}` : `Hide ${listing.title}`}
            title={hidden ? "Unhide listing" : "Hide listing from the overview and alerts"}
          >
            {hidden ? <Eye size={17} /> : <EyeOff size={17} />}
          </button>
        ) : null}
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
    </div>
  );
}

export function ListingSignalChips({ listing }: { listing: Listing }) {
  const age = listingAge(listing);
  return (
    <>
      {age ? <em className={`decision-chip decision-chip--age decision-chip--age-${age.freshness}`} title={age.detail}>{age.label}</em> : null}
      {listing.promoted ? <em className="decision-chip decision-chip--promoted" title="Paid placement or highlight">Promoted</em> : null}
      {listing.sellerType === "business" ? <em className="decision-chip decision-chip--business" title="The marketplace marks this seller as a business account">Business</em> : null}
    </>
  );
}

function DealBars({ strength }: { strength: number }) {
  return (
    <span className={`deal-bars deal-bars--${strength}`} role="img" aria-label={`${strength} of 5 deal strength`}>
      {[1, 2, 3, 4, 5].map((bar) => (
        <i key={bar} className={bar <= strength ? "is-filled" : ""} />
      ))}
    </span>
  );
}
