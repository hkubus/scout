import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Activity, ArrowRight, LoaderCircle, RefreshCw, Send } from "lucide-react";
import { api } from "./api";
import type { Connector, ConnectorRun } from "./types";

type Toast = { type: "success" | "error" | "info" };

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "Something went wrong";

function PageHeader({
  title,
  description,
  action,
  actionIcon,
  actionDisabled,
  onAction,
}: {
  title: string;
  description?: string;
  action?: string;
  actionIcon?: ReactNode;
  actionDisabled?: boolean;
  onAction?: () => void;
}) {
  return (
    <header className="page-header page-header--inner">
      <div>
        <h1>{title}</h1>
        {description ? <p>{description}</p> : null}
      </div>
      {action ? <button className="primary-button" disabled={actionDisabled} onClick={onAction}>{actionIcon}{action}</button> : null}
    </header>
  );
}

export default function ConnectorsPage({
  connectors,
  scanning,
  onScan,
  onHistory,
  onToast,
}: {
  connectors: Connector[];
  scanning: boolean;
  onScan: () => void;
  onHistory: () => void;
  onToast: (message: string, type?: Toast["type"]) => void;
}) {
  const [runs, setRuns] = useState<ConnectorRun[]>([]);
  const [runsPagination, setRunsPagination] = useState<{ page: number; pageSize: number; total: number; hasNext: boolean } | null>(null);
  const [loadingRuns, setLoadingRuns] = useState(true);
  const [loadingOlderRuns, setLoadingOlderRuns] = useState(false);
  const [testing, setTesting] = useState(false);
  const loadRuns = useCallback(async () => {
    try {
      const result = await api.connectorRuns();
      setRuns(result.runs);
      setRunsPagination(result.pagination);
    } catch (error) {
      onToast(errorMessage(error), "error");
    } finally {
      setLoadingRuns(false);
    }
  }, [onToast]);
  useEffect(() => {
    void loadRuns();
  }, [loadRuns]);
  const testWebhook = async () => {
    setTesting(true);
    try {
      await api.testWebhook();
      onToast("Discord test delivered.");
      await loadRuns();
    } catch (error) {
      onToast(errorMessage(error), "error");
    } finally {
      setTesting(false);
    }
  };
  const testNtfy = async () => {
    setTesting(true);
    try {
      await api.testNtfy();
      onToast("ntfy test delivered.");
      await loadRuns();
    } catch (error) {
      onToast(errorMessage(error), "error");
    } finally {
      setTesting(false);
    }
  };
  const connectorColor = (source: string) =>
    connectors.find((connector) => connector.name === source)?.color ??
    "#8a94a6";
  return (
    <>
      <PageHeader
        title="Connectors"
        description="Public-page health, pacing, and notification delivery."
        action={scanning ? "Queueing…" : "Scan now"}
        actionIcon={
          scanning ? (
            <LoaderCircle size={18} className="spin" />
          ) : (
            <RefreshCw size={18} />
          )
        }
        actionDisabled={scanning}
        onAction={onScan}
      />
      <div className="connector-banner">
        <div className="banner-icon">
          <Activity size={22} />
        </div>
        <div>
          <strong>Monitoring is best-effort by design.</strong>
          <span>
            Failures are recorded per source; one blocked marketplace never
            stops the others.
          </span>
        </div>
        <button onClick={onHistory}>
          Notification history <ArrowRight size={16} />
        </button>
      </div>
      <div className="connector-cards">
        {connectors.map((connector) => (
          <ConnectorCard
            connector={connector}
            key={connector.name}
            testing={testing}
            onTest={connector.name === "Discord" ? testWebhook : connector.name === "ntfy" ? testNtfy : undefined}
          />
        ))}
      </div>
      <div className="connector-runs">
        <div className="section-heading-row">
          <h2>Recent connector runs</h2>
          <button
            className="icon-button"
            aria-label="Refresh connector runs"
            onClick={() => {
              setLoadingRuns(true);
              void loadRuns();
            }}
          >
            <RefreshCw size={16} className={loadingRuns ? "spin" : ""} />
          </button>
        </div>
        <div className="run-table">
          <div className="run-head">
            <span>Source</span>
            <span>Result</span>
            <span>Duration</span>
            <span>Started</span>
          </div>
          {loadingRuns ? (
            <div className="table-loading">
              <LoaderCircle size={18} className="spin" />
              Loading runs…
            </div>
          ) : runs.length ? (
            <>
            {runs.map((run) => (
              <div className="run-row" key={run.id}>
                <span className="connector-name">
                  <i style={{ background: connectorColor(run.source) }} />
                  {run.source}
                </span>
                <span className={`run-result run-result--${run.status}`}>
                  <i />
                  {run.status === "ok"
                    ? "Completed"
                    : run.status === "running"
                      ? "Running"
                      : "Failed"}
                </span>
                <span>{run.duration}</span>
                <span title={run.startedAt}>
                  {new Date(run.startedAt).toLocaleString("pl-PL", {
                    month: "short",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
              </div>
            ))}
            {runsPagination?.hasNext ? <button className="link-button messages-load-more" disabled={loadingOlderRuns} onClick={async () => { setLoadingOlderRuns(true); try { const result = await api.connectorRuns({ page: (runsPagination.page ?? 1) + 1 }); setRuns((current) => [...current, ...result.runs]); setRunsPagination(result.pagination); } catch (error) { onToast(errorMessage(error), "error"); } finally { setLoadingOlderRuns(false); } }}>{loadingOlderRuns ? <LoaderCircle size={15} className="spin" /> : <ArrowRight size={15} />}{loadingOlderRuns ? "Loading…" : "Load older runs"}</button> : null}
            </>
          ) : (
            <div className="panel-empty panel-empty--large">
              No connector runs yet. Start a scan to test the selected sources.
            </div>
          )}
        </div>
      </div>
    </>
  );
}
function ConnectorCard({
  connector,
  testing,
  onTest,
}: {
  connector: Connector;
  testing: boolean;
  onTest?: () => void;
}) {
  const configured =
    (connector.name !== "Discord" && connector.name !== "ntfy") ||
    !connector.detail.toLowerCase().includes("not configured");
  return (
    <article className="connector-card">
      <div className="connector-card-top">
        <span className="connector-logo" style={{ color: connector.color }}>
          {connector.kind === "discord"
            ? "D"
            : connector.kind === "ntfy"
              ? "N"
              : connector.name === "Allegro Lokalnie"
                ? "A"
                : connector.name[0]}
        </span>
        <span
          className={`status-pill status-pill--${connector.status.toLowerCase()}`}
        >
          <i />
          {connector.status}
        </span>
      </div>
      <h3>{connector.name}</h3>
      <p>{connector.detail}</p>
      <div className="connector-metrics">
        <div>
          <span>Runs</span>
          <strong>{connector.requests}</strong>
        </div>
        <div>
          <span>Last duration</span>
          <strong>{connector.latency}</strong>
        </div>
        <div>
          <span>Last good</span>
          <strong>{connector.lastSuccess}</strong>
        </div>
      </div>
      {onTest ? (
        <button
          className="outline-button connector-test"
          disabled={testing || !configured}
          onClick={onTest}
        >
          {testing ? (
            <LoaderCircle size={15} className="spin" />
          ) : (
            <Send size={15} />
          )}
          {configured
            ? testing
              ? "Sending…"
              : connector.kind === "ntfy" ? "Test ntfy notification" : "Test webhook"
            : "Configure in Settings"}
        </button>
      ) : null}
    </article>
  );
}


