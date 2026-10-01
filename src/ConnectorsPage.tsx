import { useCallback, useEffect, useState } from "react";
import { ArrowRight, LoaderCircle, RefreshCw, Send } from "lucide-react";
import { api } from "./api";
import { formatDate, monthDayTime } from "./format";
import type { Connector, ConnectorRun } from "./types";
import { PageHeader } from "./ui";

type Toast = { type: "success" | "error" | "info" };

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "Something went wrong";

function runHealth(status: string): "OK" | "Warning" | "Degraded" | string {
  if (status === "ok") return "OK";
  if (status === "running" || status === "warning") return "Warning";
  if (status === "error" || status === "degraded") return "Degraded";
  return status;
}

export default function ConnectorsPage({
  connectors,
  scanning,
  onScan,
  onHistory,
  onOpenSettings,
  onToast,
}: {
  connectors: Connector[];
  scanning: boolean;
  onScan: () => void;
  onHistory: () => void;
  onOpenSettings: () => void;
  onToast: (message: string, type?: Toast["type"]) => void;
}) {
  const [runs, setRuns] = useState<ConnectorRun[]>([]);
  const [runsPagination, setRunsPagination] = useState<{ page: number; pageSize: number; total: number; hasNext: boolean } | null>(null);
  const [loadingRuns, setLoadingRuns] = useState(true);
  const [loadingOlderRuns, setLoadingOlderRuns] = useState(false);
  const [testingDiscord, setTestingDiscord] = useState(false);
  const [testingNtfy, setTestingNtfy] = useState(false);
  // Most runs are routine; failures (with their message) are what this list is for.
  const [problemsOnly, setProblemsOnly] = useState(true);
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
    setTestingDiscord(true);
    try {
      await api.testWebhook();
      onToast("Discord test delivered.");
      await loadRuns();
    } catch (error) {
      onToast(errorMessage(error), "error");
    } finally {
      setTestingDiscord(false);
    }
  };
  const testNtfy = async () => {
    setTestingNtfy(true);
    try {
      await api.testNtfy();
      onToast("ntfy test delivered.");
      await loadRuns();
    } catch (error) {
      onToast(errorMessage(error), "error");
    } finally {
      setTestingNtfy(false);
    }
  };
  const connectorColor = (source: string) =>
    connectors.find((connector) => connector.name === source)?.color ??
    "#8a94a6";
  const shownRuns = problemsOnly ? runs.filter((run) => run.status === "error" || run.status === "degraded" || run.status === "warning") : runs;
  return (
    <>
      <PageHeader title="Connectors">
        <button className="outline-button" onClick={onHistory}>Notification history</button>
        <button className="primary-button" disabled={scanning} onClick={onScan}>
          {scanning ? <LoaderCircle size={17} className="spin" /> : <RefreshCw size={17} />}
          {scanning ? "Queueing…" : "Scan now"}
        </button>
      </PageHeader>
      <div className="connector-list" role="table" aria-label="Connector health">
        {connectors.map((connector) => (
          <ConnectorRow
            connector={connector}
            key={connector.name}
            testing={connector.name === "ntfy" ? testingNtfy : testingDiscord}
            onTest={connector.name === "Discord" ? testWebhook : connector.name === "ntfy" ? testNtfy : undefined}
            onOpenSettings={onOpenSettings}
          />
        ))}
      </div>
      <div className="connector-runs">
        <div className="section-heading-row">
          <h2>Recent runs</h2>
          <div className="search-results-actions">
            <div className="segmented" role="group" aria-label="Runs shown">
              <button type="button" aria-pressed={problemsOnly} className={problemsOnly ? "segmented-option segmented-option--active" : "segmented-option"} onClick={() => setProblemsOnly(true)}>Problems</button>
              <button type="button" aria-pressed={!problemsOnly} className={!problemsOnly ? "segmented-option segmented-option--active" : "segmented-option"} onClick={() => setProblemsOnly(false)}>All runs</button>
            </div>
            <button
              className="icon-button"
              aria-label="Refresh connector runs"
              title="Refresh runs"
              onClick={() => {
                setLoadingRuns(true);
                void loadRuns();
              }}
            >
              <RefreshCw size={16} className={loadingRuns ? "spin" : ""} />
            </button>
          </div>
        </div>
        <div className="run-table">
          <div className="run-head">
            <span>Source</span>
            <span>Result</span>
            <span>Started</span>
            <span>Details</span>
          </div>
          {loadingRuns ? (
            <div className="table-loading">
              <LoaderCircle size={18} className="spin" />
              Loading runs…
            </div>
          ) : shownRuns.length ? (
            <>
            {shownRuns.map((run) => (
              <div className="run-row" key={run.id}>
                <span className="connector-name">
                  <i style={{ background: connectorColor(run.source) }} />
                  {run.source}
                </span>
                <span className={`run-result run-result--${runHealth(run.status).toLowerCase()}`}>
                  <i />
                  {runHealth(run.status)}
                </span>
                <span title={`${run.startedAt} · took ${run.duration}`}>
                  {formatDate(monthDayTime, run.startedAt)}
                </span>
                <span className="run-message">{run.message || "—"}</span>
              </div>
            ))}
            {runsPagination?.hasNext ? <button className="link-button messages-load-more" disabled={loadingOlderRuns} onClick={async () => { setLoadingOlderRuns(true); try { const result = await api.connectorRuns({ page: (runsPagination.page ?? 1) + 1 }); setRuns((current) => [...current, ...result.runs]); setRunsPagination(result.pagination); } catch (error) { onToast(errorMessage(error), "error"); } finally { setLoadingOlderRuns(false); } }}>{loadingOlderRuns ? <LoaderCircle size={15} className="spin" /> : <ArrowRight size={15} />}{loadingOlderRuns ? "Loading…" : "Load older runs"}</button> : null}
            </>
          ) : (
            <div className="panel-empty">
              {runs.length ? "No failed or slow runs in the loaded history." : "No connector runs yet. Start a scan to test the sources."}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

/** One compact health row per source or notification channel. */
function ConnectorRow({
  connector,
  testing,
  onTest,
  onOpenSettings,
}: {
  connector: Connector;
  testing: boolean;
  onTest?: () => void;
  onOpenSettings: () => void;
}) {
  const configured =
    (connector.name !== "Discord" && connector.name !== "ntfy") ||
    !connector.detail.toLowerCase().includes("not configured");
  return (
    <div className="connector-row" role="row">
      <span className="connector-name" role="cell">
        <i style={{ background: connector.color }} />
        <strong>{connector.name}</strong>
      </span>
      <span className={`status-pill status-pill--${connector.status.toLowerCase()}`} role="cell">
        <i />
        {connector.status}
      </span>
      <span className="connector-detail" role="cell" title={`${connector.requests} runs · last took ${connector.latency}`}>{connector.detail}</span>
      <span className="connector-last" role="cell">{connector.lastSuccess}</span>
      <span className="connector-action" role="cell">
        {onTest ? (
          configured ? (
            <button className="outline-button" disabled={testing} onClick={onTest}>
              {testing ? <LoaderCircle size={14} className="spin" /> : <Send size={14} />}
              {testing ? "Sending…" : "Send test"}
            </button>
          ) : (
            <button className="link-button" onClick={onOpenSettings}>Set up</button>
          )
        ) : null}
      </span>
    </div>
  );
}
