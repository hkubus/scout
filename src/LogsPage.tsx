import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Download, LoaderCircle, RefreshCw, ScrollText } from "lucide-react";
import { api } from "./api";
import { subscribe, subscribeStatus } from "./events";
import { formatDate, timeWithSeconds } from "./format";
import { mergeLogs, prependLog } from "./logEntries";
import type { LogEntry } from "./types";

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "Something went wrong";

type LevelFilter = "all" | "info" | "error";
type ScopeFilter = "all" | "watch" | "research" | "diagnostics";

function PageHeader({ title, description }: { title: string; description?: string }) {
  return (
    <header className="page-header page-header--inner">
      <div>
        <h1>{title}</h1>
        {description ? <p>{description}</p> : null}
      </div>
    </header>
  );
}

const timeOnly = (value: string) => formatDate(timeWithSeconds, value);

const LogRow = memo(function LogRow({ log }: { log: LogEntry }) {
  return (
    <div className={`log-row ${log.level === "error" ? "log-row--error" : ""}`}>
      <span className="log-time" title={log.at}>
        {timeOnly(log.at)}
      </span>
      <span className={`log-scope log-scope--${log.scope}`}>
        {log.scope}
      </span>
      <span className="log-message">{log.message}</span>
    </div>
  );
});

export default function LogsPage({ onToast }: { onToast: (message: string, type?: "success" | "error" | "info") => void }) {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [level, setLevel] = useState<LevelFilter>("all");
  const [scope, setScope] = useState<ScopeFilter>("all");
  /** Live entries received while each GET /api/logs is in flight (newest first). */
  const liveDuringLoad = useRef(new Set<LogEntry[]>());

  // The spinner replaces the list only on the first load and on Refresh;
  // reconnect refetches keep the rows (and the scroll position) in place.
  const loadLogs = useCallback(async (showLoader: boolean) => {
    if (showLoader) setLoading(true);
    const live: LogEntry[] = [];
    liveDuringLoad.current.add(live);
    try {
      const result = await api.logs();
      setLogs(mergeLogs(live, result.logs));
    } catch (error) {
      onToast(errorMessage(error), "error");
    } finally {
      liveDuringLoad.current.delete(live);
      if (showLoader) setLoading(false);
    }
  }, [onToast]);

  useEffect(() => {
    void loadLogs(true);
  }, [loadLogs]);

  // Each 'log' event carries the whole entry, so new lines are prepended
  // (newest first, like GET /api/logs) instead of refetching the buffer.
  // A stream that reconnects may have missed lines, or the server restarted
  // and its ids started over, so it reconciles with one refetch.
  useEffect(() => {
    const unsubscribeLog = subscribe("log", (payload) => {
      const entry = payload as LogEntry;
      if (!entry || typeof entry.id !== "number") return;
      for (const live of liveDuringLoad.current) live.unshift(entry);
      setLogs((current) => prependLog(current, entry));
    });
    const unsubscribeStatus = subscribeStatus((_status, reconnected) => {
      if (reconnected) void loadLogs(false);
    });
    return () => {
      unsubscribeLog();
      unsubscribeStatus();
    };
  }, [loadLogs]);

  const filtered = useMemo(
    () =>
      logs.filter(
        (log) =>
          (level === "all" || log.level === level) &&
          (scope === "all" || log.scope === scope),
      ),
    [logs, level, scope],
  );

  const errorCount = logs.filter((log) => log.level === "error").length;

  const downloadLogs = () => {
    const text = logs
      .map((log) => `${log.at} [${log.level}] [${log.scope}] ${log.message}`)
      .join("\n");
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `scout-logs-${new Date().toISOString().slice(0, 10)}.txt`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <PageHeader
        title="Logs"
        description="Scan-path activity: which connector route each watch takes, skips, and failures."
      />
      <div className="log-toolbar">
        <div className="log-filters" role="group" aria-label="Log filters">
          {(["all", "info", "error"] as LevelFilter[]).map((value) => (
            <button
              key={value}
              className={`log-filter ${level === value ? "log-filter--active" : ""}`}
              onClick={() => setLevel(value)}
            >
              {value === "all" ? "All levels" : value}
              {value === "error" && errorCount > 0 ? (
                <span className="log-error-count">{errorCount}</span>
              ) : null}
            </button>
          ))}
          <span className="log-filter-divider" aria-hidden="true" />
          {(["all", "watch", "research", "diagnostics"] as ScopeFilter[]).map((value) => (
            <button
              key={value}
              className={`log-filter ${scope === value ? "log-filter--active" : ""}`}
              onClick={() => setScope(value)}
            >
              {value === "all" ? "All scopes" : value}
            </button>
          ))}
        </div>
        <div className="log-toolbar-actions">
          <button
            className="icon-button"
            aria-label="Refresh logs"
            onClick={() => void loadLogs(true)}
          >
            <RefreshCw size={16} className={loading ? "spin" : ""} />
          </button>
          <button
            className="icon-button"
            aria-label="Download logs"
            disabled={!logs.length}
            onClick={downloadLogs}
          >
            <Download size={16} />
          </button>
        </div>
      </div>
      <div className="log-panel" aria-live="polite">
        <div className="log-head">
          <span>Time</span>
          <span>Scope</span>
          <span>Message</span>
        </div>
        {loading ? (
          <div className="table-loading">
            <LoaderCircle size={18} className="spin" />
            Loading logs…
          </div>
        ) : filtered.length ? (
          filtered.map((log) => <LogRow key={log.id} log={log} />)
        ) : (
          <div className="panel-empty panel-empty--large">
            <ScrollText size={22} />
            No log entries yet. Logs appear as watches and market research scans run.
          </div>
        )}
      </div>
      {!loading && logs.length > 0 ? (
        <p className="log-footnote">
          Showing the latest {filtered.length} of {logs.length} in-memory entries.
          Logs are diagnostics only and reset when Scout restarts.
        </p>
      ) : null}
    </>
  );
}
