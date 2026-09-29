import { useEffect, useState } from "react";
import {
  AlertTriangle,
  Calculator,
  Bell,
  Check,
  CheckCircle2,
  ExternalLink,
  Eye,
  EyeOff,
  Info,
  Layers,
  LoaderCircle,
  Scale,
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
  VerificationComparison,
} from "./types";

const formatPln = (value: number | null) =>
  value === null ? "Learning" : `${value.toLocaleString("pl-PL")} zł`;

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "Something went wrong";

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
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [comparison, setComparison] = useState<VerificationComparison | null>(null);
  const [comparing, setComparing] = useState(false);
  const [storedListing, setStoredListing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const currentListing = detail.listing;
  const marketplaceListingKey = currentListing.marketplaceListingKey ?? currentListing.id;
  const toFiniteCost = (value: string) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  const totalCost = currentListing.price + toFiniteCost(shippingCost) + toFiniteCost(extraCost);
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

  const changeGroup = async (groupKey: string | null) => {
    if (!currentListing.watchId) return;
    setSaving(true);
    setError(null);
    try {
      const result = await api.setListingGroup(marketplaceListingKey, currentListing.watchId, groupKey);
      setDetail(result);
      if (result.listing.typical !== null) setResalePrice(String(result.listing.typical));
      onUpdated(result.listing);
    } catch (groupError) {
      setError(errorMessage(groupError));
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
            <span className="drawer-kicker">{currentListing.marketplace} · {currentListing.watch}{currentListing.group ? ` · ${currentListing.group}` : currentListing.group === null ? " · no model group" : ""}</span>
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
              <span>{currentListing.typical === null ? currentListing.group === null ? "Matches no model group — not scored" : "Baseline is still learning" : `${Math.abs(currentListing.belowTypical ?? 0).toFixed(1)}% below typical`}{currentListing.typicalSource === "reference-band" ? " · series baseline" : ""}</span>
              <small>{currentListing.condition || "Condition not specified"}{currentListing.location ? ` · ${currentListing.location}` : ""}</small>
            </div>
          </div>

          {detail.groups?.length && currentListing.watchId ? <section className="drawer-section">
            <div className="drawer-section-heading">
              <div><span className="drawer-section-kicker">Scored within</span><h3>Model group</h3></div>
              <Layers size={17} />
            </div>
            <label className="field-label">
              Group
              <select
                value={currentListing.groupSource === "manual" ? currentListing.groupKey ?? "" : ""}
                disabled={saving}
                onChange={(event) => void changeGroup(event.target.value || null)}
              >
                <option value="">Automatic{currentListing.groupSource !== "manual" ? ` — ${currentListing.group ?? "no match"}` : ""}</option>
                {detail.groups.map((group) => <option key={group.key} value={group.key}>{group.name}</option>)}
              </select>
            </label>
            <p className="drawer-section-copy">
              {currentListing.groupSource === "manual"
                ? "Set manually — scans keep this group until you switch back to automatic."
                : currentListing.groupSource === "jev"
                  ? "Placed by AI because no group's terms matched the title."
                  : currentListing.groupSource === "rule"
                    ? "Matched by the group's terms."
                    : "No group's terms matched, so this listing is not scored. Pick a group to score it."}
            </p>
          </section> : null}

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

          {showDescriptionSafeguard ? <section className="drawer-section drawer-section--ai">
            <div className="drawer-section-heading">
              <div><span className="drawer-section-kicker">Jev vs LLM</span><h3>What each engine returned</h3></div>
              <Scale size={17} />
            </div>
            <p className="drawer-section-copy">Jev returns a typed judgment only (decision + confidence). The LLM returns a full verification (decision + confidence + summary + issues + evidence).</p>
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
            ) : <p className="drawer-section-copy">No stored Jev trace for this description yet — run a comparison below.</p>}
            {storedListing ? <button className="outline-button ai-normalize-button" type="button" disabled={comparing} onClick={() => void compareJevVsLlm()}>{comparing ? <LoaderCircle size={15} className="spin" /> : <Scale size={15} />}{comparing ? "Comparing…" : comparison ? "Re-run comparison" : "Compare Jev vs LLM"}</button> : <span className="drawer-muted">Comparison is available after a listing is saved by a watch.</span>}
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
          </section> : null}

          <section className="drawer-section drawer-section--decision">
            <div className="drawer-section-heading">
              <div><span className="drawer-section-kicker">Triage</span><h3>What do you want to do?</h3></div>
              {hidden ? <span className="decision-chip decision-chip--hidden"><EyeOff size={11} />Hidden</span> : null}
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
            <button
              className="outline-button drawer-save-note"
              type="button"
              disabled={saving}
              title={hidden ? "Show this listing again in the overview and alerts" : "Remove this listing from the overview and alerts without deleting its history"}
              onClick={() => void saveAction(decision, !hidden)}
            >
              {saving ? <LoaderCircle size={15} className="spin" /> : hidden ? <Eye size={15} /> : <EyeOff size={15} />}
              {hidden ? "Unhide listing" : "Hide listing"}
            </button>
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
          <a className="primary-button" href={currentListing.url} target="_blank" rel="noopener noreferrer"><ExternalLink size={16} />Open listing</a>
        </div>
      </aside>
    </div>
  );
}

