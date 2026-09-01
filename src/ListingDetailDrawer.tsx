import { useEffect, useState } from "react";
import {
  AlertTriangle,
  Calculator,
  Bell,
  Check,
  CheckCircle2,
  ExternalLink,
  Info,
  LoaderCircle,
  Send,
  ShieldCheck,
  Tag,
  X,
} from "lucide-react";
import { api } from "./api";
import { watchPresetFromListing, type WatchPreset } from "./presets";
import { PriceSparkline } from "./PriceSparkline";
import type {
  Listing,
  ListingDecision,
  ListingDetail,
  NegotiationDraft,
  NegotiationRecommendation,
  SellerMessage,
} from "./types";

const formatPln = (value: number | null) =>
  value === null ? "Learning" : `${value.toLocaleString("pl-PL")} zł`;

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "Something went wrong";

function safeImageUrl(value: string | null | undefined) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function ListingThumbnail({ listing }: { listing: Listing }) {
  const [failed, setFailed] = useState(false);
  const image = safeImageUrl(listing.image);
  return image && !failed ? <img src={image} alt="" loading="lazy" onError={() => setFailed(true)} /> : <div className="listing-thumb-placeholder"><Tag size={20} /></div>;
}

export default function ListingDetailDrawer({
  listing,
  onClose,
  onUpdated,
  onCreateWatch,
}: {
  listing: Listing;
  onClose: () => void;
  onUpdated: (listing: Listing) => void;
  onCreateWatch?: (preset: WatchPreset) => void;
}) {
  const [detail, setDetail] = useState<ListingDetail>({
    listing,
    history: [],
    action: { decision: listing.decision ?? null, note: listing.note ?? '', updatedAt: null },
    firstSeenAt: listing.observedAt,
    lastSeenAt: listing.observedAt,
  });
  const [decision, setDecision] = useState<ListingDecision | null>(listing.decision ?? null);
  const [note, setNote] = useState(listing.note ?? "");
  const [shippingCost, setShippingCost] = useState("");
  const [extraCost, setExtraCost] = useState("");
  const [resalePrice, setResalePrice] = useState(listing.typical === null ? "" : String(listing.typical));
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [normalizing, setNormalizing] = useState(false);
  const [negotiating, setNegotiating] = useState(false);
  const [recommending, setRecommending] = useState(false);
  const [negotiationMaxTotal, setNegotiationMaxTotal] = useState("");
  const [negotiationShippingCost, setNegotiationShippingCost] = useState("");
  const [negotiationOtherCosts, setNegotiationOtherCosts] = useState("");
  const [negotiationOffer, setNegotiationOffer] = useState("");
  const [negotiationRecommendation, setNegotiationRecommendation] = useState<NegotiationRecommendation | null>(null);
  const [negotiationDraft, setNegotiationDraft] = useState<NegotiationDraft | null>(null);
  const [draftMessage, setDraftMessage] = useState("");
  const [drafting, setDrafting] = useState(false);
  const [lastNegotiation, setLastNegotiation] = useState<SellerMessage | null>(null);
  const [storedListing, setStoredListing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const currentListing = detail.listing;
  const marketplaceListingKey = currentListing.marketplaceListingKey ?? currentListing.id;
  const canMessageMarketplace = currentListing.marketplace === "OLX" || currentListing.marketplace === "Allegro Lokalnie";
  const totalCost = currentListing.price + (Number(shippingCost) || 0) + (Number(extraCost) || 0);
  const expectedResale = resalePrice === "" ? null : Number(resalePrice);
  const expectedProfit = expectedResale === null || !Number.isFinite(expectedResale) ? null : expectedResale - totalCost;
  const expectedMargin = expectedProfit === null || totalCost <= 0 ? null : (expectedProfit / totalCost) * 100;
  const typicalSavings = currentListing.typical === null ? null : currentListing.typical - totalCost;
  const showDescriptionSafeguard = currentListing.dealStrength >= 4 || Boolean(detail.descriptionSnapshot);

  useEffect(() => {
    let active = true;
    const fallback: ListingDetail = {
      listing,
      history: [],
      action: { decision: listing.decision ?? null, note: listing.note ?? '', updatedAt: null },
      firstSeenAt: listing.observedAt,
      lastSeenAt: listing.observedAt,
    };
    setDetail(fallback);
    setDecision(listing.decision ?? null);
    setNote(listing.note ?? "");
    setResalePrice(listing.typical === null ? "" : String(listing.typical));
    setShippingCost("");
    setExtraCost("");
    setNegotiationOffer("");
    setNegotiationMaxTotal("");
    setNegotiationShippingCost("");
    setNegotiationOtherCosts("");
    setNegotiationRecommendation(null);
    setNegotiationDraft(null);
    setDraftMessage("");
    setLastNegotiation(null);
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

  const saveAction = async (nextDecision = decision) => {
    setSaving(true);
    setError(null);
    try {
      const result = await api.updateListingAction(marketplaceListingKey, { decision: nextDecision, note });
      const updatedListing = { ...detail.listing, decision: result.action.decision, note: result.action.note };
      setDetail((current) => ({ ...current, listing: updatedListing, action: result.action }));
      setDecision(result.action.decision);
      setNote(result.action.note);
      onUpdated(updatedListing);
    } catch (saveError) {
      setError(errorMessage(saveError));
    } finally {
      setSaving(false);
    }
  };

  const normalizeWithAi = async () => {
    setNormalizing(true);
    setError(null);
    try {
      const result = await api.normalizeListing(marketplaceListingKey, Boolean(currentListing.aiNormalizationError));
      setDetail(result);
      setDecision(result.action.decision);
      setNote(result.action.note);
      onUpdated(result.listing);
    } catch (normalizeError) {
      setError(errorMessage(normalizeError));
    } finally {
      setNormalizing(false);
    }
  };

  const suggestNegotiationOffer = async () => {
    if (!canMessageMarketplace || !storedListing) return;
    const maxTotalCost = Number(negotiationMaxTotal);
    const shippingCost = negotiationShippingCost.trim() === "" ? 0 : Number(negotiationShippingCost);
    const otherCosts = negotiationOtherCosts.trim() === "" ? 0 : Number(negotiationOtherCosts);
    if (!Number.isFinite(maxTotalCost) || maxTotalCost <= 0) {
      setError("Enter a positive maximum total cost before asking for a suggestion.");
      return;
    }
    if (![shippingCost, otherCosts].every((value) => Number.isFinite(value) && value >= 0)) {
      setError("Known delivery and fee costs must be zero or positive.");
      return;
    }
    setRecommending(true);
    setError(null);
    try {
      const result = await api.recommendNegotiation(marketplaceListingKey, { maxTotalCost, shippingCost, otherCosts });
      setNegotiationRecommendation(result);
      if (result.openingOffer !== null) setNegotiationOffer(String(result.openingOffer));
    } catch (recommendationError) {
      setError(errorMessage(recommendationError));
    } finally {
      setRecommending(false);
    }
  };

  const negotiateWithAi = async () => {
    if (!canMessageMarketplace || !storedListing) return;
    const offerPrice = negotiationOffer.trim() === "" ? null : Number(negotiationOffer);
    if (offerPrice !== null && (!Number.isFinite(offerPrice) || offerPrice <= 0 || offerPrice >= currentListing.price)) {
      setError("Opening offer must be positive and lower than the listing price.");
      return;
    }
    const maxTotalCost = negotiationMaxTotal.trim() === "" ? null : Number(negotiationMaxTotal);
    const shippingCost = negotiationShippingCost.trim() === "" ? 0 : Number(negotiationShippingCost);
    const otherCosts = negotiationOtherCosts.trim() === "" ? 0 : Number(negotiationOtherCosts);
    if (maxTotalCost !== null && (!Number.isFinite(maxTotalCost) || maxTotalCost <= 0)) {
      setError("Maximum total cost must be positive when provided.");
      return;
    }
    if (![shippingCost, otherCosts].every((value) => Number.isFinite(value) && value >= 0)) {
      setError("Known delivery and fee costs must be zero or positive.");
      return;
    }
    setDrafting(true);
    setError(null);
    try {
      const budget = maxTotalCost === null ? undefined : { maxTotalCost, shippingCost, otherCosts };
      const result = await api.draftNegotiation(marketplaceListingKey, offerPrice, budget);
      setNegotiationDraft(result);
      setDraftMessage(result.message);
    } catch (draftError) {
      setError(errorMessage(draftError));
    } finally {
      setDrafting(false);
    }
  };

  const sendNegotiation = async () => {
    if (!negotiationDraft || !draftMessage.trim()) return;
    if (draftMessage.trim().length > 450) {
      setError("Keep the reviewed message to 450 characters or fewer.");
      return;
    }
    if (!window.confirm(`Send this reviewed message to the ${currentListing.marketplace} seller?\n\n${draftMessage.trim()}`)) return;
    setNegotiating(true);
    setError(null);
    try {
      const maxTotalCost = negotiationMaxTotal.trim() === "" ? null : Number(negotiationMaxTotal);
      const shippingCost = negotiationShippingCost.trim() === "" ? 0 : Number(negotiationShippingCost);
      const otherCosts = negotiationOtherCosts.trim() === "" ? 0 : Number(negotiationOtherCosts);
      const budget = maxTotalCost === null ? undefined : { maxTotalCost, shippingCost, otherCosts };
      const result = await api.negotiateAndSend(marketplaceListingKey, negotiationDraft.offerPrice, budget, draftMessage.trim());
      setLastNegotiation(result.message);
      setNegotiationDraft(null);
      setDraftMessage("");
    } catch (negotiationError) {
      setError(errorMessage(negotiationError));
    } finally {
      setNegotiating(false);
    }
  };

  const chartPoints = detail.history.length
    ? detail.history
    : [{ price: currentListing.price, observedAt: currentListing.observedAt }];
  const lastPoint = chartPoints[chartPoints.length - 1];
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
              <span>{currentListing.typical === null ? "Baseline is still learning" : `${Math.abs(currentListing.belowTypical ?? 0).toFixed(1)}% below typical`}</span>
              <small>{currentListing.condition || "Condition not specified"}{currentListing.location ? ` · ${currentListing.location}` : ""}</small>
            </div>
          </div>

          <section className="drawer-section drawer-section--ai">
            <div className="drawer-section-heading">
              <div><span className="drawer-section-kicker">AI enrichment</span><h3>Listing normalization</h3></div>
              <Tag size={17} />
            </div>
            {currentListing.aiNormalization ? (
              <>
                <div className="ai-normalization-title">
                  <strong>{currentListing.aiNormalization.canonicalTitle}</strong>
                  <span>{currentListing.aiNormalization.category}{currentListing.aiNormalization.confidence < 0.65 ? " · low confidence" : ""}</span>
                </div>
                <div className="ai-normalization-fields">
                  {[
                    ["Brand", currentListing.aiNormalization.brand],
                    ["Model", currentListing.aiNormalization.model],
                    ["Variant", currentListing.aiNormalization.variant],
                    ["Condition", currentListing.aiNormalization.condition],
                  ].filter(([, value]) => value).map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}
                </div>
                {currentListing.aiNormalization.attributes.length ? <div className="ai-normalization-tags">{currentListing.aiNormalization.attributes.map((attribute) => <span key={`${attribute.name}-${attribute.value}`}>{attribute.name}: {attribute.value}</span>)}</div> : null}
                {currentListing.aiNormalization.flags.length ? <div className="ai-normalization-warning"><AlertTriangle size={14} />{currentListing.aiNormalization.flags.join(" · ")}</div> : null}
                {currentListing.aiNormalization.conditionNotes.length ? <p className="drawer-section-copy">Condition signals: {currentListing.aiNormalization.conditionNotes.join(" · ")}</p> : null}
                {currentListing.aiNormalization.evidence.length ? <p className="drawer-section-copy">Evidence: {currentListing.aiNormalization.evidence.join(" · ")}</p> : null}
              </>
            ) : (
              <p className="drawer-section-copy">No normalized product identity has been stored for this listing yet.</p>
            )}
            {storedListing ? <button className="outline-button ai-normalize-button" type="button" disabled={normalizing} onClick={() => void normalizeWithAi()}>{normalizing ? <LoaderCircle size={15} className="spin" /> : <Tag size={15} />}{normalizing ? "Normalizing…" : currentListing.aiNormalizationError ? "Retry normalization" : currentListing.aiNormalization ? "Refresh normalization" : "Normalize with AI"}</button> : <span className="drawer-muted">AI normalization is available after a listing is saved by a watch.</span>}
            {currentListing.aiNormalizationError ? <div className="ai-normalization-error"><AlertTriangle size={14} />{currentListing.aiNormalizationError}</div> : null}
          </section>

          {showDescriptionSafeguard ? <section className="drawer-section drawer-section--verification">
            <div className="drawer-section-heading">
              <div><span className="drawer-section-kicker">High-priority deal safeguard</span><h3>Description verification</h3></div>
              <ShieldCheck size={17} />
            </div>
            {currentListing.aiDescriptionVerificationStatus === "pass" ? <div className="description-verification-result description-verification-result--pass"><CheckCircle2 size={15} /><strong>Passed</strong><span>The description supports a functional item.</span></div> : null}
            {currentListing.aiDescriptionVerificationStatus === "reject" ? <div className="description-verification-result description-verification-result--reject"><AlertTriangle size={15} /><strong>Alert held</strong><span>The description contains a material issue.</span></div> : null}
            {currentListing.aiDescriptionVerificationStatus === "unknown" ? <div className="description-verification-result description-verification-result--unknown"><AlertTriangle size={15} /><strong>Alert held</strong><span>The listing could not be verified safely.</span></div> : null}
            {currentListing.aiDescriptionVerificationStatus === "fallback" ? <div className="description-verification-result description-verification-result--unknown"><AlertTriangle size={15} /><strong>Alert sent without AI check</strong><span>OpenRouter verification failed, so deterministic scoring was used.</span></div> : null}
            {currentListing.aiDescriptionVerificationStatus === "pending" ? <div className="description-verification-result description-verification-result--pending"><LoaderCircle size={15} className="spin" /><strong>Checking</strong><span>Fetching the detail page and description.</span></div> : null}
            {currentListing.aiDescriptionVerificationStatus === "not-configured" || !currentListing.aiDescriptionVerificationStatus ? <p className="drawer-section-copy">OpenRouter is not configured for this safeguard, so the high-priority alert follows deterministic scoring.</p> : null}
            {detail.descriptionSnapshot ? <div className="listing-description-snapshot">
              <div className="listing-description-snapshot-heading"><strong>Saved listing state</strong><span>{new Date(detail.descriptionSnapshot.capturedAt).toLocaleString("pl-PL")}</span></div>
              <div className="listing-description-snapshot-meta"><span>{formatPln(detail.descriptionSnapshot.price)}</span>{detail.descriptionSnapshot.condition ? <span>{detail.descriptionSnapshot.condition}</span> : null}{detail.descriptionSnapshot.location ? <span>{detail.descriptionSnapshot.location}</span> : null}</div>
              <p>{detail.descriptionSnapshot.description || "No description was exposed on the detail page."}</p>
            </div> : <p className="drawer-section-copy">No detail snapshot has been saved yet.</p>}
            {currentListing.aiDescriptionVerification?.summary ? <p className="drawer-section-copy">{currentListing.aiDescriptionVerification.summary}</p> : null}
            {currentListing.aiDescriptionVerification?.issues.length ? <div className="ai-normalization-warning"><AlertTriangle size={14} />{currentListing.aiDescriptionVerification.issues.join(" · ")}</div> : null}
            {currentListing.aiDescriptionVerification?.evidence.length ? <p className="drawer-section-copy">Evidence: {currentListing.aiDescriptionVerification.evidence.join(" · ")}</p> : null}
            {currentListing.aiDescriptionVerificationError ? <div className="ai-normalization-error"><AlertTriangle size={14} />{currentListing.aiDescriptionVerificationError}</div> : null}
          </section> : null}

          <section className="drawer-section drawer-section--negotiation">
            <div className="drawer-section-heading">
              <div><span className="drawer-section-kicker">Seller contact</span><h3>Negotiate with AI</h3></div>
              <Send size={17} />
            </div>
            {canMessageMarketplace ? <>
              <p className="drawer-section-copy">Scout calculates the money first from the current asking price and your total-cost limit. OpenRouter only writes the final Polish message with the configured DeepSeek model.</p>
              <div className="negotiation-budget-grid">
                <label className="drawer-note-label negotiation-budget-label">
                  Maximum total cost <span>required for a suggestion · PLN</span>
                  <input type="number" min="1" step="1" value={negotiationMaxTotal} onChange={(event) => { setNegotiationMaxTotal(event.target.value); setNegotiationRecommendation(null); setNegotiationDraft(null); setDraftMessage(""); setNegotiationOffer(""); }} placeholder="e.g. 2100" disabled={!storedListing || recommending || drafting || negotiating} />
                </label>
                <label className="drawer-note-label negotiation-budget-label">
                  Delivery and fees <span>optional · PLN</span>
                  <input type="number" min="0" step="1" value={negotiationShippingCost} onChange={(event) => { setNegotiationShippingCost(event.target.value); setNegotiationRecommendation(null); setNegotiationDraft(null); setDraftMessage(""); setNegotiationOffer(""); }} placeholder="e.g. 15" disabled={!storedListing || recommending || drafting || negotiating} />
                </label>
              </div>
              <label className="drawer-note-label negotiation-budget-label">
                Other known costs <span>optional · PLN</span>
                <input type="number" min="0" step="1" value={negotiationOtherCosts} onChange={(event) => { setNegotiationOtherCosts(event.target.value); setNegotiationRecommendation(null); setNegotiationDraft(null); setDraftMessage(""); setNegotiationOffer(""); }} placeholder="0" disabled={!storedListing || recommending || drafting || negotiating} />
              </label>
              <button className="outline-button negotiation-suggest-button" type="button" disabled={!storedListing || recommending || negotiating} onClick={() => void suggestNegotiationOffer()}>
                {recommending ? <LoaderCircle size={15} className="spin" /> : <Calculator size={15} />}
                {recommending ? "Calculating…" : "Suggest an offer"}
              </button>
              {negotiationRecommendation ? <div className={`negotiation-recommendation negotiation-recommendation--${negotiationRecommendation.status}`} aria-live="polite">
                <div className="negotiation-recommendation-heading">
                  <div>
                    <span className="drawer-section-kicker">Deterministic price policy</span>
                    <strong>{negotiationRecommendation.status === "ready" ? "Suggested opening offer" : negotiationRecommendation.status === "budget-required" ? "Budget needed" : negotiationRecommendation.status === "not-negotiable" ? "Fixed-price listing" : negotiationRecommendation.status === "manual-review" ? "Manual review needed" : negotiationRecommendation.status === "budget-too-low" ? "Budget is too low" : "No safe offer"}</strong>
                  </div>
                  {negotiationRecommendation.openingOffer !== null ? <b>{formatPln(negotiationRecommendation.openingOffer)}</b> : null}
                </div>
                {negotiationRecommendation.openingOffer !== null ? <div className="negotiation-recommendation-metrics"><span>Current ask <strong>{formatPln(negotiationRecommendation.askingPrice)}</strong></span><span>Ceiling <strong>{formatPln(negotiationRecommendation.ceilingPrice)}</strong></span><span>Opening gap <strong>{negotiationRecommendation.openingDiscountPercent?.toFixed(1)}%</strong></span></div> : null}
                <p>{negotiationRecommendation.rationale}</p>
                {negotiationRecommendation.counterOffers.length ? <small>Possible path: {negotiationRecommendation.counterOffers.map((offer) => formatPln(offer)).join(" → ")}</small> : null}
              </div> : null}
              <label className="drawer-note-label negotiation-offer-label">
                Opening offer <span>optional · PLN</span>
                <input type="number" min="1" max={Math.max(1, currentListing.price - 0.01)} step="0.01" value={negotiationOffer} onChange={(event) => { setNegotiationOffer(event.target.value); setNegotiationDraft(null); setDraftMessage(""); }} placeholder="Ask for a reduction without naming a price" disabled={!storedListing || recommending || drafting || negotiating} />
              </label>
              <button className="primary-button drawer-negotiate-button" type="button" disabled={!storedListing || drafting || negotiating || saving} onClick={() => void negotiateWithAi()}>
                {drafting ? <LoaderCircle size={15} className="spin" /> : <Send size={15} />}
                {drafting ? "Writing draft…" : negotiationDraft ? "Regenerate draft" : "Draft message with AI"}
              </button>
              {negotiationDraft ? <div className="negotiation-draft">
                <div className="negotiation-draft-heading"><strong>Review before sending</strong><span>{negotiationDraft.model}</span></div>
                <textarea aria-label="Reviewed negotiation message" maxLength={450} value={draftMessage} onChange={(event) => setDraftMessage(event.target.value)} disabled={negotiating} />
                <div className="negotiation-draft-footer"><small>{draftMessage.length}/450 characters · Scout checks links, contact details, tone, and the approved offer before delivery.</small><button className="primary-button" type="button" disabled={negotiating || !draftMessage.trim()} onClick={() => void sendNegotiation()}>{negotiating ? <LoaderCircle size={15} className="spin" /> : <Send size={15} />}{negotiating ? "Sending…" : "Send reviewed message"}</button></div>
              </div> : null}
              {!storedListing ? <span className="drawer-muted">Save this listing through a watch before contacting the seller.</span> : null}
              {lastNegotiation ? <div className="negotiation-success"><CheckCircle2 size={15} /><div><strong>Message sent</strong><p>{lastNegotiation.message}</p></div></div> : null}
            </> : <p className="drawer-section-copy">AI seller negotiation is currently available for OLX and Allegro Lokalnie listings.</p>}
          </section>

          <section className="drawer-section drawer-section--decision">
            <div className="drawer-section-heading">
              <div><span className="drawer-section-kicker">Triage</span><h3>What do you want to do?</h3></div>
              {decision ? <span className={`decision-chip decision-chip--${decision}`}>{decision === "buy" ? "Buy" : decision === "watch" ? "Watch" : "Pass"}</span> : null}
            </div>
            <div className="decision-grid">
              {(["buy", "watch", "pass"] as ListingDecision[]).map((option) => {
                const Icon = option === "buy" ? Check : option === "watch" ? Bell : X;
                const label = option === "buy" ? "Buy" : option === "watch" ? "Watch" : "Pass";
                return (
                  <button
                    type="button"
                    key={option}
                    className={`decision-button decision-button--${option} ${decision === option ? "decision-button--active" : ""}`}
                    disabled={saving}
                    onClick={() => void saveAction(option)}
                  >
                    <Icon size={16} />{label}
                  </button>
                );
              })}
            </div>
            {decision ? <button className="clear-decision" type="button" disabled={saving} onClick={() => void saveAction(null)}>Clear decision</button> : null}
            {onCreateWatch ? (
              <button className="outline-button drawer-save-note" type="button" onClick={() => onCreateWatch(watchPresetFromListing(currentListing))}>
                <Bell size={15} />
                Save as watch
              </button>
            ) : null}
            <label className="drawer-note-label">
              Note
              <textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="e.g. Ask for a battery-health screenshot" />
            </label>
            <button className="outline-button drawer-save-note" type="button" disabled={saving} onClick={() => void saveAction()}>
              {saving ? <LoaderCircle size={15} className="spin" /> : <Check size={15} />}
              {saving ? "Saving…" : "Save note"}
            </button>
            {error ? <div className="form-error" role="alert"><AlertTriangle size={15} />{error}</div> : null}
          </section>

          <section className="drawer-section">
            <div className="drawer-section-heading">
              <div><span className="drawer-section-kicker">Evidence</span><h3>Price history</h3></div>
              {loading ? <LoaderCircle size={16} className="spin" /> : <span className="drawer-muted">{detail.history.length ? `${detail.history.length} observations` : "First look"}</span>}
            </div>
            <div className="price-chart-card"><PriceSparkline points={chartPoints} /><div className="price-chart-labels"><span>{formatPln(Math.min(...chartPoints.map((point) => point.price)))}</span><strong>Latest {formatPln(lastPoint.price)}</strong><span>{formatPln(Math.max(...chartPoints.map((point) => point.price)))}</span></div></div>
            <div className="drawer-meta-grid">
              <div><span>First seen</span><strong>{new Date(detail.firstSeenAt).toLocaleDateString("pl-PL", { day: "2-digit", month: "short" })}</strong></div>
              <div><span>Last seen</span><strong>{new Date(detail.lastSeenAt).toLocaleDateString("pl-PL", { day: "2-digit", month: "short" })}</strong></div>
              <div><span>Shipping</span><strong>{currentListing.shippingAvailable === true ? "Available" : currentListing.shippingAvailable === false ? "Pickup only" : "Unknown"}</strong></div>
            </div>
          </section>

          <section className="drawer-section drawer-section--calculator">
            <div className="drawer-section-heading">
              <div><span className="drawer-section-kicker">Scenario</span><h3>Total cost & resale</h3></div>
              <Calculator size={17} />
            </div>
            <p className="drawer-section-copy">Estimate what this deal costs after delivery and what is left if you resell it.</p>
            <div className="calculator-fields">
              <label className="field-label">Shipping / fees <span>PLN</span><input type="number" min="0" step="1" value={shippingCost} onChange={(event) => setShippingCost(event.target.value)} placeholder="0" /></label>
              <label className="field-label">Other cost <span>PLN</span><input type="number" min="0" step="1" value={extraCost} onChange={(event) => setExtraCost(event.target.value)} placeholder="0" /></label>
              <label className="field-label">Expected resale <span>PLN</span><input type="number" min="0" step="1" value={resalePrice} onChange={(event) => setResalePrice(event.target.value)} placeholder="Add estimate" /></label>
            </div>
            <div className="calculator-results">
              <div><span>Total cost</span><strong>{formatPln(totalCost)}</strong></div>
              <div><span>Expected profit</span><strong className={expectedProfit === null ? "" : expectedProfit >= 0 ? "result-positive" : "result-negative"}>{expectedProfit === null ? "Add resale" : formatPln(expectedProfit)}</strong></div>
              <div><span>Margin</span><strong className={expectedMargin === null ? "" : expectedMargin >= 0 ? "result-positive" : "result-negative"}>{expectedMargin === null ? "—" : `${expectedMargin.toFixed(1)}%`}</strong></div>
            </div>
            {typicalSavings !== null ? <div className={`calculator-callout ${typicalSavings >= 0 ? "calculator-callout--positive" : "calculator-callout--negative"}`}><Info size={15} />{typicalSavings >= 0 ? `${formatPln(typicalSavings)} below the learned typical price after extra costs.` : `${formatPln(Math.abs(typicalSavings))} above the learned typical price after extra costs.`}</div> : null}
          </section>
        </div>
        <div className="listing-drawer-footer">
          <span>{currentListing.observed}</span>
          <a className="primary-button" href={currentListing.url} target="_blank" rel="noreferrer"><ExternalLink size={16} />Open listing</a>
        </div>
      </aside>
    </div>
  );
}

