import { useEffect, useState } from "react";
import {
  AlertTriangle,
  Bell,
  Check,
  CheckCircle2,
  ExternalLink,
  Eye,
  EyeOff,
  LoaderCircle,
  PackageCheck,
  Pencil,
  Scale,
  X,
} from "lucide-react";
import { api } from "./api";
import { watchPresetFromListing, type WatchPreset } from "./presets";
import { PriceSparkline } from "./PriceSparkline";
import { listingAge } from "./listingSignals";
import { DEFAULT_FEE_PRESETS, FLIP_CHANNELS, saleFee, type FeePresets, type FlipChannel } from "./profit";
import { dayMonth, formatDate } from "./format";
import { decisionLabels, discountDisplay, formatPln, ListingThumbnail } from "./ui";
import type {
  Flip,
  Listing,
  ListingDecision,
  ListingDetail,
  VerificationComparison,
} from "./types";

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "Something went wrong";

export default function ListingDetailDrawer({
  listing,
  onClose,
  onUpdated,
  onCreateWatch,
  onFlipAdded,
}: {
  listing: Listing;
  onClose: () => void;
  onUpdated: (listing: Listing) => void;
  onCreateWatch?: (preset: WatchPreset) => void;
  onFlipAdded?: (flip: Flip) => void;
}) {
  const [detail, setDetail] = useState<ListingDetail>({
    listing,
    history: [],
    action: { decision: listing.decision ?? null, note: listing.note ?? '', hidden: listing.hidden ?? false, updatedAt: null },
    firstSeenAt: listing.observedAt,
    lastSeenAt: listing.observedAt,
  });
  const [decision, setDecision] = useState<ListingDecision | null>(listing.decision ?? null);
  const [note, setNote] = useState(listing.note ?? "");
  const [hidden, setHidden] = useState(listing.hidden ?? false);
  const [shippingCost, setShippingCost] = useState("");
  const [extraCost, setExtraCost] = useState("");
  const [resalePrice, setResalePrice] = useState(listing.typical === null ? "" : String(listing.typical));
  // Resell on the same platform by default; the fee comes from the operator's
  // presets on the Flips page. Display-only, like the rest of the calculator.
  const [sellOn, setSellOn] = useState<FlipChannel>(listing.marketplace);
  const [feePresets, setFeePresets] = useState<FeePresets>(DEFAULT_FEE_PRESETS);
  const [addingFlip, setAddingFlip] = useState(false);
  const [flipAdded, setFlipAdded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [comparison, setComparison] = useState<VerificationComparison | null>(null);
  const [comparing, setComparing] = useState(false);
  const [editingEstimate, setEditingEstimate] = useState(false);
  const [storedListing, setStoredListing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const currentListing = detail.listing;
  const postedAge = listingAge(currentListing);
  const marketplaceListingKey = currentListing.marketplaceListingKey ?? currentListing.id;
  const toFiniteCost = (value: string) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  const totalCost = currentListing.price + toFiniteCost(shippingCost) + toFiniteCost(extraCost);
  const expectedResale = resalePrice === "" ? null : Number(resalePrice);
  const resaleFee = expectedResale === null || !Number.isFinite(expectedResale) ? 0 : saleFee(expectedResale, feePresets[sellOn]);
  const expectedProfit = expectedResale === null || !Number.isFinite(expectedResale) ? null : expectedResale - resaleFee - totalCost;
  // ROI is profit relative to what you spend; margin is profit relative to the sale price.
  const expectedRoi = expectedProfit === null || totalCost <= 0 ? null : (expectedProfit / totalCost) * 100;
  const expectedMargin = expectedProfit === null || expectedResale === null || expectedResale <= 0 ? null : (expectedProfit / expectedResale) * 100;
  const showDescriptionSafeguard = currentListing.dealStrength >= 4 || Boolean(detail.descriptionSnapshot);
  const verificationStatus = currentListing.aiDescriptionVerificationStatus;
  const discount = discountDisplay(currentListing);

  useEffect(() => {
    let active = true;
    api.flips().then((result) => { if (active) setFeePresets(result.feePresets); }).catch(() => { /* estimates fall back to the default presets */ });
    return () => { active = false; };
  }, []);

  const addFlip = async () => {
    setAddingFlip(true);
    setError(null);
    try {
      const today = new Date();
      const boughtOn = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
      const result = await api.createFlip({
        title: currentListing.title.slice(0, 200),
        listingKey: marketplaceListingKey,
        watchId: currentListing.watchId ?? null,
        buyChannel: currentListing.marketplace,
        boughtOn,
        buyPrice: currentListing.price,
        buyCosts: toFiniteCost(shippingCost) + toFiniteCost(extraCost),
      });
      setFlipAdded(true);
      onFlipAdded?.(result.flip);
    } catch (addError) {
      setError(errorMessage(addError));
    } finally {
      setAddingFlip(false);
    }
  };

  useEffect(() => {
    let active = true;
    const fallback: ListingDetail = {
      listing,
      history: [],
      action: { decision: listing.decision ?? null, note: listing.note ?? '', hidden: listing.hidden ?? false, updatedAt: null },
      firstSeenAt: listing.observedAt,
      lastSeenAt: listing.observedAt,
    };
    setDetail(fallback);
    setDecision(listing.decision ?? null);
    setNote(listing.note ?? "");
    setHidden(listing.hidden ?? false);
    setResalePrice(listing.typical === null ? "" : String(listing.typical));
    setShippingCost("");
    setExtraCost("");
    setComparison(null);
    setError(null);
    setLoading(true);
    setStoredListing(false);
    api
      .listingDetail(listing.marketplaceListingKey ?? listing.id, listing.watchId)
      .then((result) => {
        if (!active) return;
        setStoredListing(true);
        setDetail(result);
        setDecision(result.action.decision);
        setNote(result.action.note);
        setHidden(result.action.hidden);
        if (result.listing.typical !== null) setResalePrice(String(result.listing.typical));
      })
      .catch(async () => {
        // Manual search results do not have stored observations yet, but their triage action can still persist.
        try {
          const action = await api.listingAction(listing.marketplaceListingKey ?? listing.id);
          if (!active) return;
          setDetail((current) => ({ ...current, action }));
          setDecision(action.decision);
          setNote(action.note);
          setHidden(action.hidden);
        } catch {
          // The listing itself remains useful when the API is offline or the result is not stored.
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [listing.id, listing.watchId, listing.marketplaceListingKey]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, saving]);

  const saveAction = async (nextDecision = decision, nextHidden = hidden) => {
    setSaving(true);
    setError(null);
    try {
      const result = await api.updateListingAction(marketplaceListingKey, { decision: nextDecision, note, hidden: nextHidden });
      const updatedListing = { ...detail.listing, decision: result.action.decision, note: result.action.note, hidden: result.action.hidden };
      setDetail((current) => ({ ...current, listing: updatedListing, action: result.action }));
      setDecision(result.action.decision);
      setNote(result.action.note);
      setHidden(result.action.hidden);
      onUpdated(updatedListing);
    } catch (saveError) {
      setError(errorMessage(saveError));
    } finally {
      setSaving(false);
    }
  };

  const changeVariant = async (variantId: string | null) => {
    if (!currentListing.watchId) return;
    setSaving(true);
    setError(null);
    try {
      const result = await api.setListingVariant(marketplaceListingKey, currentListing.watchId, variantId);
      setDetail(result);
      if (result.listing.typical !== null) setResalePrice(String(result.listing.typical));
      onUpdated(result.listing);
    } catch (variantError) {
      setError(errorMessage(variantError));
    } finally {
      setSaving(false);
    }
  };

  const compareJevVsLlm = async () => {
    if (!storedListing || comparing) return;
    setComparing(true);
    setError(null);
    try {
      const result = await api.compareVerification(marketplaceListingKey);
      setComparison(result);
    } catch (compareError) {
      setError(errorMessage(compareError));
    } finally {
      setComparing(false);
    }
  };

  const chartPoints = detail.history.length
    ? detail.history
    : [{ price: currentListing.price, observedAt: currentListing.observedAt }];
  const priceChanged = new Set(chartPoints.map((point) => point.price)).size > 1;
  const facts = [
    currentListing.shippingAvailable === true ? "Shipping" : currentListing.shippingAvailable === false ? "Pickup only" : null,
    currentListing.sellerType === "business" ? "Business seller" : currentListing.sellerType === "private" ? "Private seller" : null,
    currentListing.promoted ? "Promoted" : null,
    currentListing.condition || null,
    currentListing.location || null,
  ].filter(Boolean);
  const toggleDecision = (option: ListingDecision) => void saveAction(decision === option ? null : option);
  return (
    <div
      className="listing-drawer-backdrop"
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && !saving && onClose()}
    >
      <aside className="listing-drawer" role="dialog" aria-modal="true" aria-labelledby="listing-detail-title">
        <div className="listing-drawer-header">
          <div>
            <span className="drawer-kicker">{currentListing.marketplace} · {currentListing.watch}</span>
            <h2 id="listing-detail-title">{currentListing.title}</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close listing details">
            <X size={20} />
          </button>
        </div>
        <div className="listing-drawer-body">
          <div className="drawer-hero">
            <div className="drawer-image-wrap">
              <ListingThumbnail listing={currentListing} />
            </div>
            <div className="drawer-hero-copy">
              <strong className="drawer-price">{formatPln(currentListing.price)}</strong>
              <span className="drawer-typical">
                {currentListing.typical === null ? "Typical price is still learning" : (
                  <>
                    typical {formatPln(currentListing.typical)}
                    {currentListing.typicalSource === "reference-band" ? <span title="From the watch's research series while its own typical is learning"> (research)</span> : null}
                    {" · "}
                    <b className={`discount-cell--${discount.tone}`}>{discount.tone === "none" ? `${discount.text} vs typical` : `${discount.text} below`}</b>
                  </>
                )}
              </span>
              {postedAge ? <small title={postedAge.detail}>{postedAge.label}</small> : null}
              {currentListing.variantLabel ? <em className="decision-chip decision-chip--variant" title="Model variant this listing is scored against, not the watch-wide blend">{currentListing.variantLabel}</em> : null}
            </div>
          </div>
          {facts.length ? <p className="drawer-facts">{facts.join(" · ")}</p> : null}
          {verificationStatus && verificationStatus !== "not-configured" ? <VerificationLine status={verificationStatus} /> : null}

          <div className="decision-grid" role="group" aria-label="Decision">
            {(["buy", "watch", "pass"] as ListingDecision[]).map((option) => {
              const Icon = option === "buy" ? Check : option === "watch" ? Bell : X;
              return (
                <button
                  type="button"
                  key={option}
                  className={`decision-button decision-button--${option} ${decision === option ? "decision-button--active" : ""}`}
                  aria-pressed={decision === option}
                  title={decision === option ? "Click again to clear" : undefined}
                  disabled={saving}
                  onClick={() => toggleDecision(option)}
                >
                  <Icon size={16} />{decisionLabels[option]}
                </button>
              );
            })}
          </div>

          <section className="drawer-estimate">
            <div className="drawer-estimate-line">
              {expectedProfit === null ? (
                <span>Add a resale price to estimate profit.</span>
              ) : (
                <span>
                  ≈ <strong className={expectedProfit >= 0 ? "result-positive" : "result-negative"}>{expectedProfit >= 0 ? "+" : "−"}{formatPln(Math.abs(Math.round(expectedProfit)))}</strong>
                  {expectedRoi !== null ? ` (ROI ${expectedRoi.toFixed(0)}%)` : ""} if resold at {formatPln(expectedResale)} on {sellOn}
                </span>
              )}
              <button type="button" className="icon-button" aria-expanded={editingEstimate} aria-label="Edit the estimate" title="Edit costs, resale price and channel" onClick={() => setEditingEstimate((open) => !open)}>
                <Pencil size={15} />
              </button>
            </div>
            {editingEstimate ? (
              <div className="calculator-fields">
                <label className="field-label">Shipping / fees (zł)<input type="number" min="0" step="1" value={shippingCost} onChange={(event) => setShippingCost(event.target.value)} placeholder="0" /></label>
                <label className="field-label">Other cost (zł)<input type="number" min="0" step="1" value={extraCost} onChange={(event) => setExtraCost(event.target.value)} placeholder="0" /></label>
                <label className="field-label">Expected resale (zł)<input type="number" min="0" step="1" value={resalePrice} onChange={(event) => setResalePrice(event.target.value)} placeholder="Add estimate" /></label>
                <label className="field-label" title={resaleFee ? `Seller fee ${formatPln(Math.round(resaleFee))}` : "No seller fee"}>Sell on<select value={sellOn} onChange={(event) => setSellOn(event.target.value as FlipChannel)}>{FLIP_CHANNELS.map((channel) => <option key={channel}>{channel}</option>)}</select></label>
                <p className="drawer-muted">Cost {formatPln(totalCost)}{resaleFee ? ` · seller fee ${formatPln(Math.round(resaleFee))}` : ""}{expectedMargin !== null ? ` · margin ${expectedMargin.toFixed(0)}%` : ""}. An estimate from asking prices, not sales.</p>
              </div>
            ) : null}
            <button type="button" className="outline-button drawer-flip-button" disabled={addingFlip || flipAdded} onClick={() => void addFlip()}>
              {addingFlip ? <LoaderCircle size={15} className="spin" /> : flipAdded ? <Check size={15} /> : <PackageCheck size={15} />}
              {flipAdded ? "Added to Flips" : "I bought this"}
            </button>
          </section>

          <label className="drawer-note-label">
            Note
            <textarea
              value={note}
              rows={2}
              onChange={(event) => setNote(event.target.value)}
              // Saved when you leave the field, like the decision buttons.
              onBlur={() => { if (note !== detail.action.note && !saving) void saveAction(); }}
              placeholder="e.g. Ask for a battery-health screenshot"
            />
          </label>
          {error ? <div className="form-error" role="alert"><AlertTriangle size={15} />{error}</div> : null}

          <section className="drawer-section">
            <div className="drawer-section-heading">
              <h3>Price history</h3>
              {loading ? <LoaderCircle size={16} className="spin" /> : <span className="drawer-muted">Seen {formatDate(dayMonth, detail.firstSeenAt)} – {formatDate(dayMonth, detail.lastSeenAt)}</span>}
            </div>
            {priceChanged ? (
              <div className="price-chart-card">
                <PriceSparkline points={chartPoints} reference={currentListing.typical} />
                <div className="price-chart-labels">
                  <span>{formatPln(Math.min(...chartPoints.map((point) => point.price)))}</span>
                  <strong>{currentListing.typical !== null ? "– – typical" : `${chartPoints.length} observations`}</strong>
                  <span>{formatPln(Math.max(...chartPoints.map((point) => point.price)))}</span>
                </div>
              </div>
            ) : (
              <p className="drawer-section-copy">{loading ? "Loading…" : `Unchanged at ${formatPln(currentListing.price)} since Scout first saw it.`}</p>
            )}
          </section>

          {detail.variantGroups?.length && currentListing.watchId ? (
            <section className="drawer-section">
              <label className="field-label drawer-inline-field">
                Model variant
                <select
                  value={currentListing.variantSource === "manual" ? currentListing.variantKey ?? "" : ""}
                  disabled={saving}
                  title={currentListing.variantSource === "manual"
                    ? "Set manually; scans keep this variant until you switch back to automatic."
                    : currentListing.variantSource === "jev"
                      ? "Placed by AI because no variant's terms matched the title."
                      : "Matched by the variant's terms, or Other / unclassified when none matched."}
                  onChange={(event) => void changeVariant(event.target.value || null)}
                >
                  <option value="">Automatic{currentListing.variantSource !== "manual" ? ` (${currentListing.variantLabel ?? "Other / unclassified"})` : ""}</option>
                  {detail.variantGroups.map((group) => <option key={group.id} value={group.id}>{group.label}</option>)}
                </select>
              </label>
            </section>
          ) : null}

          {showDescriptionSafeguard && (detail.descriptionSnapshot || currentListing.aiDescriptionVerification) ? (
            <details className="drawer-details">
              <summary>Description check details</summary>
              {currentListing.aiDescriptionVerification?.summary ? <p className="drawer-section-copy">{currentListing.aiDescriptionVerification.summary}</p> : null}
              {currentListing.aiDescriptionVerification?.issues.length ? <div className="ai-normalization-warning"><AlertTriangle size={14} />{currentListing.aiDescriptionVerification.issues.join(" · ")}</div> : null}
              {currentListing.aiDescriptionVerification?.evidence.length ? <p className="drawer-section-copy">Evidence: {currentListing.aiDescriptionVerification.evidence.join(" · ")}</p> : null}
              {currentListing.aiDescriptionVerificationError ? <div className="ai-normalization-error"><AlertTriangle size={14} />{currentListing.aiDescriptionVerificationError}</div> : null}
              {detail.descriptionSnapshot ? <div className="listing-description-snapshot">
                <div className="listing-description-snapshot-heading"><strong>Saved description</strong><span>{new Date(detail.descriptionSnapshot.capturedAt).toLocaleString("pl-PL")}</span></div>
                <div className="listing-description-snapshot-meta"><span>{formatPln(detail.descriptionSnapshot.price)}</span>{detail.descriptionSnapshot.condition ? <span>{detail.descriptionSnapshot.condition}</span> : null}{detail.descriptionSnapshot.location ? <span>{detail.descriptionSnapshot.location}</span> : null}</div>
                <p>{detail.descriptionSnapshot.description || "No description was exposed on the detail page."}</p>
              </div> : null}
            </details>
          ) : null}

          {showDescriptionSafeguard && storedListing ? (
            <details className="drawer-details">
              <summary>AI diagnostics (Jev vs LLM)</summary>
              {detail.verificationInputHash ? <p className="drawer-section-copy">Input hash <strong>{detail.verificationInputHash.slice(0, 12)}…</strong>{detail.verificationModel ? <> · stored model <strong>{detail.verificationModel}</strong></> : null}</p> : null}
              {detail.verificationTrace?.length ? (
                <div className="ai-normalization-tags" style={{ flexDirection: "column", alignItems: "stretch", gap: 8 }}>
                  {detail.verificationTrace.map((entry) => (
                    <div key={entry.id} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      <span><strong>Jev</strong> · {entry.jevModel} · {new Date(entry.createdAt).toLocaleString("pl-PL")}{entry.note ? ` · ${entry.note}` : ""}</span>
                      <span>{entry.jevError ? `Jev error: ${entry.jevError}` : `answer: ${JSON.stringify(entry.jevAnswer)}${entry.jevConfidence !== null ? ` · confidence ${entry.jevConfidence.toFixed(2)}` : ""}${entry.jevUnsure ? " · unsure" : ""}`}</span>
                      {(entry.visionVerdict || entry.visionError || entry.deepseekDecision) ? (
                        <span>Vision: {entry.visionError ? entry.visionError : `${entry.visionVerdict ?? "—"}${entry.visionConfidence !== null && entry.visionConfidence !== undefined ? ` (${entry.visionConfidence.toFixed(2)})` : ""}${entry.visionImagesSeen !== null && entry.visionImagesSeen !== undefined ? ` · ${entry.visionImagesSeen} photo(s)` : ""}`} · LLM: {entry.deepseekDecision ?? "—"}{entry.agreement !== null && entry.agreement !== undefined ? (entry.agreement ? " · agree" : " · disagree") : ""}</span>
                      ) : null}
                    </div>
                  ))}
                </div>
              ) : <p className="drawer-section-copy">No stored Jev trace for this description yet.</p>}
              <button className="outline-button ai-normalize-button" type="button" disabled={comparing} onClick={() => void compareJevVsLlm()}>{comparing ? <LoaderCircle size={15} className="spin" /> : <Scale size={15} />}{comparing ? "Comparing…" : comparison ? "Re-run comparison" : "Compare Jev vs LLM"}</button>
              {comparison ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
                  <div className="ai-normalization-tags" style={{ flexDirection: "column", alignItems: "stretch" }}>
                    <span><strong>Jev</strong> · {comparison.jevModel}</span>
                    {comparison.jev.ok
                      ? <span>decision <strong>{comparison.jev.judgment.decision}</strong> · confidence {comparison.jev.judgment.confidence === null ? "null" : comparison.jev.judgment.confidence.toFixed(2)}{comparison.jev.judgment.unsure ? " · unsure → would escalate to vision" : " · firm"}</span>
                      : <span>Jev error: {comparison.jev.error}</span>}
                    <details><summary className="drawer-muted">Raw Jev JSON</summary><pre style={{ whiteSpace: "pre-wrap", fontSize: 12, margin: "4px 0 0" }}>{JSON.stringify(comparison.jev.ok ? comparison.jev.raw : { error: comparison.jev.error }, null, 2)}</pre></details>
                  </div>
                  <div className="ai-normalization-tags" style={{ flexDirection: "column", alignItems: "stretch" }}>
                    <span><strong>LLM</strong> · {comparison.llmModel}</span>
                    {comparison.llm.ok
                      ? <>
                        <span>decision <strong>{comparison.llm.verification.decision}</strong> · confidence {comparison.llm.verification.confidence.toFixed(2)}</span>
                        <span>{comparison.llm.verification.summary}</span>
                        {comparison.llm.verification.issues.length ? <span>Issues: {comparison.llm.verification.issues.join(" · ")}</span> : null}
                        {comparison.llm.verification.evidence.length ? <span>Evidence: {comparison.llm.verification.evidence.join(" · ")}</span> : null}
                      </>
                      : <span>LLM error: {comparison.llm.error}</span>}
                    <details><summary className="drawer-muted">Raw LLM JSON</summary><pre style={{ whiteSpace: "pre-wrap", fontSize: 12, margin: "4px 0 0" }}>{JSON.stringify(comparison.llm.ok ? comparison.llm.raw : { error: comparison.llm.error }, null, 2)}</pre></details>
                  </div>
                </div>
              ) : null}
            </details>
          ) : null}
        </div>
        <div className="listing-drawer-footer">
          <div className="listing-drawer-footer-actions">
            <button
              className="outline-button"
              type="button"
              disabled={saving}
              aria-label={hidden ? "Unhide listing" : "Hide listing"}
              title={hidden ? "Show this listing again in the overview and alerts" : "Remove this listing from the overview and alerts without deleting its history"}
              onClick={() => void saveAction(decision, !hidden)}
            >
              {hidden ? <Eye size={15} /> : <EyeOff size={15} />}
              <span>{hidden ? "Unhide" : "Hide"}</span>
            </button>
            {onCreateWatch ? (
              <button className="outline-button" type="button" aria-label="Save as watch" title="Create a watch from this listing" onClick={() => onCreateWatch(watchPresetFromListing(currentListing))}>
                <Bell size={15} />
                <span>Save as watch</span>
              </button>
            ) : null}
          </div>
          <a className="primary-button" href={currentListing.url} target="_blank" rel="noopener noreferrer"><ExternalLink size={16} />Open listing</a>
        </div>
      </aside>
    </div>
  );
}

/** The description check as one line, shown only when it actually ran. */
function VerificationLine({ status }: { status: NonNullable<Listing["aiDescriptionVerificationStatus"]> }) {
  if (status === "pass") return <div className="description-verification-result description-verification-result--pass"><CheckCircle2 size={15} /><strong>Description looks fine</strong></div>;
  if (status === "reject") return <div className="description-verification-result description-verification-result--reject"><AlertTriangle size={15} /><strong>Alert held:</strong><span>the description mentions a material issue.</span></div>;
  if (status === "unknown") return <div className="description-verification-result description-verification-result--unknown"><AlertTriangle size={15} /><strong>Alert held:</strong><span>the description could not be checked.</span></div>;
  if (status === "fallback") return <div className="description-verification-result description-verification-result--unknown"><AlertTriangle size={15} /><strong>Alerted without an AI check</strong><span>(the check failed).</span></div>;
  if (status === "pending") return <div className="description-verification-result description-verification-result--pending"><LoaderCircle size={15} className="spin" /><strong>Checking the description…</strong></div>;
  return null;
}
