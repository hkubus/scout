import { Handshake, Info } from "lucide-react";
import { marketplaceColors } from "./data";
import type { Marketplace, NegotiationFigures, NegotiationRole, OutcomeShare, RoleOutcomes } from "./types";

const ROLES: NegotiationRole[] = ["buy", "sell"];

/** 0.84 → "84%". */
export const formatShare = (share: number) => `${Math.round(share * 100)}%`;

/** A group's share, but only once it has the screens' minimum of agreed negotiations. */
const shownShare = (group: OutcomeShare, minAgreed: number) =>
  group.agreed >= minAgreed && group.shareOfAsking !== null ? group.shareOfAsking : null;

const counts = (group: OutcomeShare) => `${group.agreed} agreed of ${group.negotiations}`;

/** The counts, plus what is missing below the minimum. */
const countsToMinimum = (group: OutcomeShare, minAgreed: number) =>
  group.agreed >= minAgreed ? counts(group) : `${counts(group)} · needs ${minAgreed}`;

const roleEntries = (figures: NegotiationFigures) =>
  ROLES.flatMap((role) => (figures[role] ? [[role, figures[role]] as const] : []));

const marketplaceEntries = (group: { marketplaces: Partial<Record<Marketplace, OutcomeShare>> }) =>
  Object.entries(group.marketplaces) as Array<[Marketplace, OutcomeShare]>;

/** "You pay 84% of asking · 5 agreed of 7", or the counts below the minimum. */
function RoleHeadline({ role, outcomes, minAgreed }: { role: NegotiationRole; outcomes: RoleOutcomes; minAgreed: number }) {
  const share = shownShare(outcomes, minAgreed);
  const [before, after] = role === "buy" ? ["You pay", "of asking"] : ["Buyers pay you", "of your asking"];
  return (
    <p className={share === null ? "analytics-negotiation-headline analytics-negotiation-headline--counts" : "analytics-negotiation-headline"}>
      {share === null ? (
        <>
          <span>{role === "buy" ? "Buying" : "Selling"}</span>
          <strong>{counts(outcomes)}</strong>
          <small>a share shows from {minAgreed} agreed</small>
        </>
      ) : (
        <>
          <span>{before}</span>
          <strong>{formatShare(share)}</strong>
          <span>{after}</span>
          <small>· {counts(outcomes)}</small>
        </>
      )}
    </p>
  );
}

/** "84%", or "2 of 4" muted below the minimum, or "—" with none. */
function ShareCell({ group, minAgreed }: { group: OutcomeShare | undefined; minAgreed: number }) {
  if (!group) return <td>—</td>;
  const share = shownShare(group, minAgreed);
  return share === null
    ? <td title={`${counts(group)} · a share shows from ${minAgreed} agreed`}><span className="analytics-table-muted">{group.agreed} of {group.negotiations}</span></td>
    : <td title={counts(group)}><strong>{formatShare(share)}</strong></td>;
}

function RoleTable({ outcomes, minAgreed, showAllRow }: { outcomes: RoleOutcomes; minAgreed: number; showAllRow: boolean }) {
  const columns = marketplaceEntries(outcomes).map(([marketplace]) => marketplace);
  const rows = [
    ...(showAllRow ? [{ key: "all", name: "All watches", group: outcomes }] : []),
    ...outcomes.watches.map((watch) => ({ key: watch.id, name: watch.name, group: watch })),
  ];
  // One cell would only repeat the headline.
  if (rows.length < 2 && columns.length < 2) return null;
  return (
    <table className="analytics-table">
      <thead>
        <tr>
          <th>Watch</th>
          {columns.map((marketplace) => <th key={marketplace}>{marketplace}</th>)}
          {columns.length > 1 ? <th>All</th> : null}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.key}>
            <td><span className="analytics-table-name">{row.name}</span></td>
            {columns.map((marketplace) => <ShareCell key={marketplace} group={row.group.marketplaces[marketplace]} minAgreed={minAgreed} />)}
            {columns.length > 1 ? <ShareCell group={row.group} minAgreed={minAgreed} /> : null}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const footnote = (minAgreed: number) =>
  `All time. Final prices from negotiations Hatbot recorded, as a share of the asking price; a share shows once a group has ${minAgreed} agreed. They never feed Scout's typical prices.`;

/** The Analytics page's "Your negotiations" card: every role, watch × marketplace, all time. */
export function NegotiationOutcomesSection({ figures, showAllRow }: { figures: NegotiationFigures; showAllRow: boolean }) {
  const roles = roleEntries(figures);
  return (
    <section className="analytics-section analytics-section--card">
      <div className="analytics-section-heading">
        <h3>Your negotiations</h3>
        <Handshake size={16} />
      </div>
      {roles.length ? roles.map(([role, outcomes]) => (
        <div key={role}>
          <RoleHeadline role={role} outcomes={outcomes} minAgreed={figures.minAgreed} />
          <RoleTable outcomes={outcomes} minAgreed={figures.minAgreed} showAllRow={showAllRow} />
        </div>
      )) : <div className="analytics-inline-empty analytics-chart-empty--short">No recorded negotiations match these filters.</div>}
      <p className="analytics-note"><Info size={13} />{footnote(figures.minAgreed)}</p>
    </section>
  );
}

/** A watch's "Your negotiations" card: per role, a headline and its marketplaces. */
export function NegotiationOutcomesCard({ figures }: { figures: NegotiationFigures }) {
  return (
    <section className="analytics-section analytics-section--card">
      <div className="analytics-section-heading"><h3>Your negotiations</h3><Handshake size={16} /></div>
      {roleEntries(figures).map(([role, outcomes]) => (
        <div key={role}>
          <RoleHeadline role={role} outcomes={outcomes} minAgreed={figures.minAgreed} />
          <div className="analytics-source-list">
            {marketplaceEntries(outcomes).map(([marketplace, group]) => {
              const share = shownShare(group, figures.minAgreed);
              return (
                <div className="analytics-source-row" key={marketplace}>
                  <span><i style={{ background: marketplaceColors[marketplace] }} />{marketplace}</span>
                  <strong>{share === null ? "—" : formatShare(share)}</strong>
                  <small>{countsToMinimum(group, figures.minAgreed)}</small>
                </div>
              );
            })}
          </div>
        </div>
      ))}
      <p className="analytics-note"><Info size={13} />{footnote(figures.minAgreed)}</p>
    </section>
  );
}
