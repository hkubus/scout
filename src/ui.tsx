import { useState, type ReactNode } from "react";
import { ChevronDown, Tag } from "lucide-react";
import { formatAge } from "./listingSignals";
import type { Listing, ListingDecision } from "./types";

/** Shared building blocks for the listing pages, drawer and dialogs. */

export const formatPln = (value: number | null) =>
  value === null ? "Learning" : `${value.toLocaleString("pl-PL")} zł`;

export function safeImageUrl(value: string | null | undefined) {
  if (!value) return null;
  if (value.startsWith("data:image/")) return value;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export function SelectControl({
  label,
  value,
  options,
  onChange,
}: {
  /** Accessible name; defaults to the selected value. */
  label?: string;
  value: string;
  options: Array<string | { value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  return (
    <label className="select-control">
      <select aria-label={label ?? value} value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => {
          const item = typeof option === "string" ? { value: option, label: option } : option;
          return <option key={item.value} value={item.value}>{item.label}</option>;
        })}
      </select>
      <ChevronDown size={16} />
    </label>
  );
}

export function ListingThumbnail({ listing }: { listing: Pick<Listing, "image"> }) {
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

/** One header for every page: a title and an optional action group, no taglines. */
export function PageHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <header className="page-header page-header--inner">
      <h1>{title}</h1>
      {children ? <div className="page-header-actions">{children}</div> : null}
    </header>
  );
}

export const decisionLabels: Record<ListingDecision, string> = { buy: "Buy", watch: "Maybe", pass: "Pass" };

/** Display name of a stored deal tier; the lowest tier is "Fair", not "Watch". */
export const dealTierLabel = (listing: Pick<Listing, "dealLabel" | "typical">) =>
  listing.typical === null ? "Learning" : listing.dealLabel === "Watch" ? "Fair" : listing.dealLabel;

/**
 * The discount against typical as one coloured value: "−31.6%" tinted by deal
 * tier, a muted "+11%" at or above typical, "—" while the typical is learning.
 */
export function discountDisplay(listing: Pick<Listing, "price" | "typical" | "belowTypical" | "dealStrength">) {
  if (listing.typical === null || listing.belowTypical === null || listing.typical <= 0) return { text: "—", tone: "none" as const };
  if (listing.belowTypical < 0) {
    const tone = listing.dealStrength >= 5 ? "5" : listing.dealStrength === 4 ? "4" : listing.dealStrength === 3 ? "3" : "low";
    return { text: `−${Math.abs(listing.belowTypical).toFixed(1)}%`, tone };
  }
  const above = Math.round(((listing.price - listing.typical) / listing.typical) * 100);
  return { text: above > 0 ? `+${above}%` : "0%", tone: "none" as const };
}

/**
 * Short listing age for the table: when OLX says it was posted (with a bump
 * marker when the seller refreshed it), else when Scout first saw it.
 */
export function listingAgeLabel(listing: Pick<Listing, "postedAt" | "refreshedAt" | "firstSeenAt" | "observed">, now = Date.now()) {
  const posted = listing.postedAt ? formatAge(listing.postedAt, now) : null;
  if (posted) {
    const postedTime = Date.parse(listing.postedAt!);
    const refreshedTime = listing.refreshedAt ? Date.parse(listing.refreshedAt) : NaN;
    const bumped = Number.isFinite(refreshedTime) && refreshedTime - postedTime > 3_600_000 ? formatAge(listing.refreshedAt!, now) : null;
    return {
      label: bumped ? `${posted} ↑${bumped}` : posted,
      detail: `Posted ${new Date(postedTime).toLocaleString("pl-PL")}${bumped ? `, bumped ${bumped} ago` : ""} · last seen ${listing.observed}`,
      old: now - postedTime > 30 * 86_400_000,
    };
  }
  const firstSeen = listing.firstSeenAt ? formatAge(listing.firstSeenAt, now) : null;
  return {
    label: firstSeen ?? listing.observed,
    detail: firstSeen ? `First seen by Scout ${firstSeen} ago · last seen ${listing.observed}` : `Last seen ${listing.observed}`,
    old: false,
  };
}
