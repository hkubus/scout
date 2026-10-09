import { memo, type ReactNode } from "react";
import { ExternalLink, Eye, EyeOff, RefreshCw, Search } from "lucide-react";
import { marketplaceColors } from "./data";
import { listingRowKey, sameListingFields } from "./listingRows";
import type { Listing } from "./types";
import { dealTierLabel, decisionLabels, discountDisplay, formatPln, listingAgeLabel, ListingThumbnail } from "./ui";

// Memoized: App re-renders (toasts, connection, busy watches) and refetches
// that change only some rows should not reconcile every row.
export default memo(function ListingTable({
  listings,
  isLoading = false,
  empty,
  onSelect,
  onToggleHidden,
}: {
  listings: Listing[];
  isLoading?: boolean;
  /** Replaces the default "No listings yet" state. */
  empty?: ReactNode;
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
    return empty ?? (
      <div className="empty-state">
        <Search size={25} />
        <strong>No listings yet</strong>
        <span>Run a watch to start building its price history.</span>
      </div>
    );
  }
  return (
    <div className="listing-table-wrap" role="table" aria-label="Saved marketplace listings">
      <div className="listing-table listing-table--head" role="row">
        <span role="columnheader">Item</span>
        <span role="columnheader">Marketplace</span>
        <span role="columnheader">Price</span>
        <span role="columnheader">Typical</span>
        <span role="columnheader">vs typical</span>
        <span role="columnheader" title="What reselling at the typical asking price on the same marketplace would net after its seller fee">Est. net</span>
        <span role="columnheader">Age</span>
        <span role="columnheader" aria-label="Actions" />
      </div>
      {listings.map((listing) => (
        <ListingRow key={listingRowKey(listing)} listing={listing} onSelect={onSelect} onToggleHidden={onToggleHidden} />
      ))}
    </div>
  );
});

type ListingRowProps = { listing: Listing; onSelect?: (listing: Listing) => void; onToggleHidden?: (listing: Listing) => void };

// A refetch replaces every row object; rows whose fields are unchanged skip
// (their handlers then receive an equal-content object, which is harmless).
const ListingRow = memo(function ListingRow({ listing, onSelect, onToggleHidden }: ListingRowProps) {
  const aiFiltered = Boolean(listing.aiFiltered);
  const hidden = Boolean(listing.hidden);
  const discount = discountDisplay(listing);
  const age = listingAgeLabel(listing);
  const decisionClass = listing.decision ? ` listing-row--decision-${listing.decision}` : "";
  return (
    <div className={`listing-table listing-row${aiFiltered ? " listing-row--ai-filtered" : ""}${hidden ? " listing-row--hidden" : ""}${decisionClass}`} role="row">
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
          <span className="listing-item-meta">
            <span>{listing.subtitle || listing.watch}</span>
            <ListingChips listing={listing} />
          </span>
        </div>
      </button>
      <div className="marketplace-cell" role="cell">
        <i style={{ background: marketplaceColors[listing.marketplace] }} />
        {listing.marketplace}
      </div>
      <strong className="price-cell" role="cell">{formatPln(listing.price)}</strong>
      <span className="typical-cell" role="cell">
        {listing.typical === null ? "Learning" : formatPln(listing.typical)}
        {listing.typicalSource === "reference-band" ? <sup title="From the watch's research series while its own typical is learning">*</sup> : null}
      </span>
      <strong className={`discount-cell discount-cell--${discount.tone}`} role="cell" title={dealTierLabel(listing)}>
        {discount.text}
      </strong>
      <NetCell listing={listing} />
      <span className={`age-cell${age.old ? " age-cell--old" : ""}`} role="cell" title={age.detail}>{age.label}</span>
      <div className="row-actions" role="cell">
        {onToggleHidden ? (
          <button
            type="button"
            className="icon-button row-action row-action--hide"
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
}, (previous: ListingRowProps, next: ListingRowProps) =>
  previous.onSelect === next.onSelect
  && previous.onToggleHidden === next.onToggleHidden
  && sameListingFields(previous.listing, next.listing));

/** Estimated net at the typical; an estimate from asking prices, so it stays muted when unknown. */
function NetCell({ listing }: { listing: Listing }) {
  const net = listing.estimatedNet ?? null;
  if (net === null || listing.typical === null) return <span className="net-cell net-cell--empty" role="cell">—</span>;
  return (
    <span
      className={`net-cell ${net >= 0 ? "result-positive" : "result-negative"}`}
      role="cell"
      title={`If resold at the typical ${formatPln(listing.typical)} on ${listing.marketplace}, after its seller fee. An estimate from asking prices, not sales.`}
    >
      {net >= 0 ? "+" : "−"}{Math.abs(net).toLocaleString("pl-PL")} zł
    </span>
  );
}

/**
 * At most two short chips after the subtitle: the triage decision first, then
 * the state or signal that matters most. Age has its own column.
 */
function ListingChips({ listing }: { listing: Listing }) {
  const chips: ReactNode[] = [];
  if (listing.decision) chips.push(<em key="decision" className={`decision-chip decision-chip--${listing.decision}`}>{decisionLabels[listing.decision]}</em>);
  if (listing.targetHit) chips.push(<em key="target" className="decision-chip decision-chip--target" title="At or below the watch's target price">Target</em>);
  if (listing.hidden) chips.push(<em key="hidden" className="decision-chip decision-chip--hidden" title="Manually hidden from the overview and alerts"><EyeOff size={11} />Hidden</em>);
  if (listing.aiFiltered) chips.push(<em key="ai" className="decision-chip decision-chip--ai-filtered" title="Hidden by AI relevance filtering">Filtered by AI</em>);
  if (listing.variantLabel) chips.push(<em key="variant" className="decision-chip decision-chip--variant" title={`Scored against the “${listing.variantLabel}” model typical, not the watch-wide blend${listing.variantSource === "jev" ? " · placed by AI" : listing.variantSource === "manual" ? " · set manually" : ""}`}>{listing.variantLabel}</em>);
  if (listing.sellerType === "business") chips.push(<em key="business" className="decision-chip decision-chip--business" title="The marketplace marks this seller as a business account">Business</em>);
  if (listing.promoted) chips.push(<em key="promoted" className="decision-chip decision-chip--promoted" title="Paid placement or highlight">Promoted</em>);
  if (!chips.length) return null;
  const extra = chips.length - 2;
  return <>{chips.slice(0, 2)}{extra > 0 ? <em className="decision-chip decision-chip--more">+{extra}</em> : null}</>;
}
