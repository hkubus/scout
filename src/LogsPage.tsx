import { useEffect, useMemo, useState } from "react";
import { Download, LoaderCircle, RefreshCw, ScrollText } from "lucide-react";
import { api } from "./api";
import type { LogEntry } from "./types";

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "Something went wrong";

type LevelFilter = "all" | "info" | "error";
type ScopeFilter = "all" | "watch" | "research";

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

const timeOnly = (value: string) =>
  new Date(value).toLocaleTimeString("pl-PL", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

export default function LogsPage({ refreshKey, onToast }: { refreshKey: number; onToast: (message: string, type?: "success" | "error" | "info") => void }) {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [level, setLevel] = useState<LevelFilter>("all");
  const [scope, setScope] = useState<ScopeFilter>("all");

  const loadLogs = async () => {
    try {
      const result = await api.logs();
      setLogs(result.logs);
    } catch (error) {
      onToast(errorMessage(error), "error");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadLogs();
  }, [refreshKey]);

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
          {(["all", "watch", "research"] as ScopeFilter[]).map((value) => (
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
            onClick={() => void loadLogs()}
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
          filtered.map((log) => (
            <div
              className={`log-row ${log.level === "error" ? "log-row--error" : ""}`}
              key={log.id}
            >
              <span className="log-time" title={log.at}>
                {timeOnly(log.at)}
              </span>
              <span className={`log-scope log-scope--${log.scope}`}>
                {log.scope}
              </span>
              <span className="log-message">{log.message}</span>
            </div>
          ))
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
