/**
 * Which of the operator's sold flips describe a listing's resale price. Pure:
 * the caller loads flips and watches. The result only feeds the display-only
 * resale basis (src/profit.ts); flip prices never reach baselines, bands or
 * alerts.
 */
import { OWN_SALES_WINDOW_DAYS, estimateResaleNet, isFlipChannel, type FeePresets, type ResaleEvidence } from '../src/profit';
import { excludedTermMatches, normalizeFilterText, parseIncludedExcluded, termMatches } from './text';
import { OTHER_VARIANT_KEY, assignVariant, type VariantGroup } from './variants';

export interface SoldFlip {
  title: string;
  watchId: string | null;
  /** YYYY-MM-DD. */
  soldOn: string;
  salePrice: number;
}

export interface ResaleWatch {
  id: string;
  query: string;
  includedTerms: string;
  excludedTerms: string;
  groups: VariantGroup[];
}

const DAY_MS = 86_400_000;

/** Whether a flip's title passes a watch's term filter, as a scan would judge the listing. */
function passesWatchTerms(watch: ResaleWatch, title: string) {
  const { included, excluded } = parseIncludedExcluded(watch.query, watch.includedTerms, watch.excludedTerms);
  const spaced = normalizeFilterText(title);
  const glued = spaced.replace(/ /g, '');
  return included.every((term) => termMatches(spaced, glued, term)) && !excluded.some((term) => excludedTermMatches(spaced, glued, term));
}

/**
 * Sale prices of the flips that are the same thing as a listing on `watch`
 * in `variantKey`, sold in the OWN_SALES_WINDOW_DAYS up to `asOf`. A flip
 * counts when it was bought from this watch or its title passes the watch's
 * filter, and, on a grouped watch, when its title falls in the same named
 * variant (the Other bucket mixes models, so it takes none).
 */
export function ownSalesFor(flips: readonly SoldFlip[], watch: ResaleWatch, variantKey: string | null, asOf: number) {
  const grouped = watch.groups.length > 0;
  if (grouped && (!variantKey || variantKey === OTHER_VARIANT_KEY)) return [];
  const from = asOf - OWN_SALES_WINDOW_DAYS * DAY_MS;
  const prices: number[] = [];
  for (const flip of flips) {
    // A sale counts from the start of its day, so one recorded today counts at once.
    const soldAt = Date.parse(`${flip.soldOn}T00:00:00Z`);
    if (!Number.isFinite(soldAt) || soldAt > asOf || soldAt < from || !(flip.salePrice > 0)) continue;
    if (flip.watchId !== watch.id && !passesWatchTerms(watch, flip.title)) continue;
    if (grouped && assignVariant(flip.title, watch.groups) !== variantKey) continue;
    prices.push(flip.salePrice);
  }
  return prices;
}

export interface ResaleWatchRow extends ResaleWatch {
  /** Linked research series whose probable-sale band the basis may use. */
  referenceId: string | null;
}

/**
 * Everything the resale basis reads, loaded once per request: fee presets,
 * sold flips, and per watch the filter and the linked research band, each
 * fetched on first use and cached.
 */
export class ResaleContext {
  private readonly sales = new Map<string, number[]>();
  private readonly bands = new Map<string, { p25: number | null; samples: number }>();
  private watches: Map<string, ResaleWatchRow> | null = null;
  private flips: readonly SoldFlip[] | null = null;

  constructor(
    readonly presets: FeePresets,
    private readonly load: {
      flips: () => SoldFlip[];
      watches: () => ResaleWatchRow[];
      band: (referenceId: string) => { p25: number | null; samples: number };
    },
    private readonly now = Date.now(),
  ) {}

  private evidence(watchId: string | null, variantKey: string | null): ResaleEvidence {
    if (!watchId) return {};
    this.watches ??= new Map(this.load.watches().map((watch) => [watch.id, watch]));
    const watch = this.watches.get(watchId);
    if (!watch) return {};
    const key = `${watchId}|${variantKey ?? ''}`;
    let ownSales = this.sales.get(key);
    if (!ownSales) {
      this.flips ??= this.load.flips();
      ownSales = this.flips.length ? ownSalesFor(this.flips, watch, variantKey, this.now) : [];
      this.sales.set(key, ownSales);
    }
    let band = watch.referenceId ? this.bands.get(watch.referenceId) : undefined;
    if (watch.referenceId && !band) {
      band = this.load.band(watch.referenceId);
      this.bands.set(watch.referenceId, band);
    }
    return { ownSales, bandP25: band?.p25 ?? null, bandSamples: band?.samples };
  }

  /** Estimated net and its basis for buying a listing at `price` and reselling it on the same marketplace. */
  estimate(marketplace: string, watchId: string | null, variantKey: string | null, price: number, typical: number | null) {
    if (!isFlipChannel(marketplace) || typical === null) return null;
    return estimateResaleNet(price, typical, this.presets[marketplace], this.evidence(watchId, variantKey));
  }
}
