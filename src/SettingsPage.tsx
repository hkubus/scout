import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  ArrowRight,
  Check,
  Database,
  LoaderCircle,
  LogOut,
  Moon,
  Send,
  Settings2,
  ShieldCheck,
  RefreshCw,
  Sun,
  Trash2,
} from "lucide-react";
import { api } from "./api";
import type { Marketplace, NotificationPriority, SettingsData, Theme } from "./types";
import { PageHeader } from "./ui";

type Toast = { type: "success" | "error" | "info" };

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "Something went wrong";

/** A settings card: a one-line title, an optional status, and its fields. */
function Section({ title, status, wide = false, children }: { title: string; status?: { on: boolean; label: string }; wide?: boolean; children: ReactNode }) {
  return (
    <section className={`settings-section${wide ? " settings-section--wide" : ""}`}>
      <div className="settings-section-heading">
        <h2>{title}</h2>
        {status ? <span className={`settings-status ${status.on ? "" : "settings-status--idle"}`}><i />{status.label}</span> : null}
      </div>
      {children}
    </section>
  );
}

export default function SettingsPage({
  theme,
  onTheme,
  onToast,
  onHistory,
}: {
  theme: Theme;
  onTheme: (theme: Theme) => void;
  onToast: (message: string, type?: Toast["type"]) => void;
  onHistory: () => void;
}) {
  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [webhook, setWebhook] = useState("");
  const [interval, setIntervalValue] = useState("5");
  const [nightInterval, setNightInterval] = useState("30");
  const [aiModel, setAiModel] = useState("");
  const [aiApiKey, setAiApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testingNtfy, setTestingNtfy] = useState(false);
  const [discordMinimumPriority, setDiscordMinimumPriority] = useState<NotificationPriority>("strong");
  const [dailyDigestEnabled, setDailyDigestEnabled] = useState(false);
  const [dailyDigestTime, setDailyDigestTime] = useState("08:00");
  const [dailyDigestDiscord, setDailyDigestDiscord] = useState(true);
  const [dailyDigestNtfy, setDailyDigestNtfy] = useState(false);
  const [ntfyServerUrl, setNtfyServerUrl] = useState("https://ntfy.sh");
  const [ntfyTopic, setNtfyTopic] = useState("");
  const [ntfyToken, setNtfyToken] = useState("");
  const [ntfyMinimumPriority, setNtfyMinimumPriority] = useState<NotificationPriority>("exceptional");
  const [ntfyOpenInApp, setNtfyOpenInApp] = useState(false);
  const [sessionMarketplace, setSessionMarketplace] = useState<Marketplace>("OLX");
  const [sessionLabel, setSessionLabel] = useState("");
  const [storageStateInput, setStorageStateInput] = useState("");
  const [storageStateFile, setStorageStateFile] = useState("");
  const [savingSession, setSavingSession] = useState(false);
  const [recoveryBusy, setRecoveryBusy] = useState(false);
  const [resettingAi, setResettingAi] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [updateOutput, setUpdateOutput] = useState<string | null>(null);
  const loadSettings = useCallback(async () => {
    try {
      const result = await api.settings();
      setSettings(result);
      setIntervalValue(String(result.defaultInterval));
      setNightInterval(String(result.nightInterval));
      setAiModel(result.ai?.model ?? "");
      setDiscordMinimumPriority(result.discordMinimumPriority);
      setDailyDigestEnabled(result.dailyDigest?.enabled ?? false);
      setDailyDigestTime(result.dailyDigest?.time ?? "08:00");
      setDailyDigestDiscord(result.dailyDigest?.discord ?? true);
      setDailyDigestNtfy(result.dailyDigest?.ntfy ?? false);
      setNtfyServerUrl(result.ntfy?.serverUrl ?? "https://ntfy.sh");
      setNtfyMinimumPriority(result.ntfy?.minimumPriority ?? "exceptional");
      setNtfyOpenInApp(result.ntfy?.openInApp ?? false);
    } catch (error) {
      onToast(errorMessage(error), "error");
    }
  }, [onToast]);
  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);
  const save = async () => {
    const numericInterval = Number(interval);
    const numericNightInterval = Number(nightInterval);
    if (
      !Number.isInteger(numericInterval) ||
      numericInterval < 5 ||
      numericInterval > 1440
    ) {
      onToast("Polling interval must be between 5 and 1440 minutes.", "error");
      return;
    }
    if (
      !Number.isInteger(numericNightInterval) ||
      numericNightInterval < 5 ||
      numericNightInterval > 1440
    ) {
      onToast("Night polling interval must be between 5 and 1440 minutes.", "error");
      return;
    }
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(dailyDigestTime)) {
      onToast("Choose a valid daily digest time.", "error");
      return;
    }
    if (dailyDigestEnabled && !dailyDigestDiscord && !dailyDigestNtfy) {
      onToast("Select Discord, ntfy, or both for daily digests.", "error");
      return;
    }
    setSaving(true);
    try {
      const ntfyTouched = Boolean(
        settings?.ntfy?.configured ||
        ntfyTopic.trim() ||
        ntfyToken.trim() ||
        ntfyServerUrl.trim() !== "https://ntfy.sh" ||
        ntfyMinimumPriority !== (settings?.ntfy?.minimumPriority ?? "exceptional"),
      );
      const result = await api.saveSettings({
        interval: numericInterval,
        nightInterval: numericNightInterval,
        webhook: webhook.trim() || undefined,
        discordMinimumPriority,
        dailyDigest: {
          enabled: dailyDigestEnabled,
          time: dailyDigestTime,
          discord: dailyDigestDiscord,
          ntfy: dailyDigestNtfy,
        },
        ai: {
          model: aiModel.trim() || undefined,
          apiKey: aiApiKey.trim() || undefined,
        },
        ntfy: ntfyTouched
          ? {
              serverUrl: ntfyServerUrl.trim() || undefined,
              topic: ntfyTopic.trim() || undefined,
              token: ntfyToken.trim() || undefined,
              minimumPriority: ntfyMinimumPriority,
              // Only meaningful once ntfy has a topic; the checkbox is disabled until then.
              openInApp: ntfyCanOpenInApp ? ntfyOpenInApp : undefined,
            }
          : undefined,
      });
      setSettings(result);
      setIntervalValue(String(result.defaultInterval));
      setNightInterval(String(result.nightInterval));
      setWebhook("");
      setAiApiKey("");
      setAiModel(result.ai?.model ?? "");
      setDailyDigestEnabled(result.dailyDigest?.enabled ?? false);
      setDailyDigestTime(result.dailyDigest?.time ?? "08:00");
      setDailyDigestDiscord(result.dailyDigest?.discord ?? true);
      setDailyDigestNtfy(result.dailyDigest?.ntfy ?? false);
      setNtfyTopic("");
      setNtfyToken("");
      setNtfyServerUrl(result.ntfy?.serverUrl ?? "https://ntfy.sh");
      onToast("Settings saved securely.");
    } catch (error) {
      onToast(errorMessage(error), "error");
    } finally {
      setSaving(false);
    }
  };
  const clearWebhook = async () => {
    if (!window.confirm("Remove the saved Discord webhook?")) return;
    const numericInterval = Number(interval);
    if (!Number.isInteger(numericInterval) || numericInterval < 5) {
      onToast("Polling interval must be at least 5 minutes.", "error");
      return;
    }
    setSaving(true);
    try {
      setSettings(
        await api.saveSettings({
          interval: numericInterval,
          clearWebhook: true,
        }),
      );
      onToast("Discord webhook removed.");
    } catch (error) {
      onToast(errorMessage(error), "error");
    } finally {
      setSaving(false);
    }
  };
  const testWebhook = async () => {
    setTesting(true);
    try {
      await api.testWebhook();
      onToast("Discord test delivered.");
    } catch (error) {
      onToast(errorMessage(error), "error");
    } finally {
      setTesting(false);
    }
  };
  const clearNtfy = async () => {
    if (!window.confirm("Remove the saved ntfy configuration?")) return;
    const numericInterval = Number(interval);
    if (!Number.isInteger(numericInterval) || numericInterval < 5) {
      onToast("Polling interval must be at least 5 minutes.", "error");
      return;
    }
    setSaving(true);
    try {
      const result = await api.saveSettings({
        interval: numericInterval,
        clearNtfy: true,
      });
      setSettings(result);
      setNtfyServerUrl("https://ntfy.sh");
      setNtfyTopic("");
      setNtfyToken("");
      setNtfyMinimumPriority(result.ntfy?.minimumPriority ?? "exceptional");
      setNtfyOpenInApp(result.ntfy?.openInApp ?? false);
      onToast("ntfy configuration removed.");
    } catch (error) {
      onToast(errorMessage(error), "error");
    } finally {
      setSaving(false);
    }
  };
  const clearAiApiKey = async () => {
    if (!window.confirm("Remove the saved OpenRouter API key?")) return;
    const numericInterval = Number(interval);
    if (!Number.isInteger(numericInterval) || numericInterval < 5) {
      onToast("Polling interval must be at least 5 minutes.", "error");
      return;
    }
    setSaving(true);
    try {
      const result = await api.saveSettings({
        interval: numericInterval,
        ai: { clearApiKey: true },
      });
      setSettings(result);
      setAiApiKey("");
      onToast("Saved OpenRouter API key removed.");
    } catch (error) {
      onToast(errorMessage(error), "error");
    } finally {
      setSaving(false);
    }
  };
  const testNtfy = async () => {
    setTestingNtfy(true);
    try {
      await api.testNtfy();
      onToast("ntfy test delivered.");
    } catch (error) {
      onToast(errorMessage(error), "error");
    } finally {
      setTestingNtfy(false);
    }
  };
  const saveMarketplaceSession = async () => {
    if (!storageStateInput.trim()) {
      onToast("Choose a storage-state JSON file or paste its contents.", "error");
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(storageStateInput);
    } catch {
      onToast("Storage-state input must be valid JSON.", "error");
      return;
    }
    setSavingSession(true);
    try {
      setSettings(await api.saveMarketplaceSession(sessionMarketplace, sessionLabel, parsed));
      setStorageStateInput("");
      setStorageStateFile("");
      onToast(`${sessionMarketplace} session saved securely.`);
    } catch (error) {
      onToast(errorMessage(error), "error");
    } finally {
      setSavingSession(false);
    }
  };
  const removeMarketplaceSession = async (marketplace: Marketplace) => {
    if (!window.confirm(`Remove the saved ${marketplace} session?`)) return;
    setSavingSession(true);
    try {
      setSettings(await api.deleteMarketplaceSession(marketplace));
      if (marketplace === sessionMarketplace) {
        setStorageStateInput("");
        setStorageStateFile("");
      }
      onToast(`${marketplace} session removed.`);
    } catch (error) {
      onToast(errorMessage(error), "error");
    } finally {
      setSavingSession(false);
    }
  };
  const exportData = async () => {
    setRecoveryBusy(true);
    try {
      const payload = await api.exportData();
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `scout-export-${new Date().toISOString().slice(0, 10)}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
      onToast("Safe data export downloaded.");
    } catch (error) {
      onToast(errorMessage(error), "error");
    } finally {
      setRecoveryBusy(false);
    }
  };
  const createBackup = async () => {
    if (!window.confirm("Create a SQLite backup beside the configured database?")) return;
    setRecoveryBusy(true);
    try {
      const result = await api.backup();
      onToast(`Backup created: ${result.backup}`);
    } catch (error) {
      onToast(errorMessage(error), "error");
    } finally {
      setRecoveryBusy(false);
    }
  };
  const resetAiResults = async () => {
    if (!window.confirm("Delete all cached AI results (relevance, description verification, shadow log)? The next scan re-runs every AI check. This cannot be undone.")) return;
    setResettingAi(true);
    try {
      const result = await api.resetAiResults();
      const { relevance, verification, shadowLog } = result.cleared;
      onToast(`AI results cleared: ${relevance} relevance, ${verification} verification, ${shadowLog} shadow rows.`);
    } catch (error) {
      onToast(errorMessage(error), "error");
    } finally {
      setResettingAi(false);
    }
  };
  const runSystemUpdate = async () => {
    if (!window.confirm("Pull latest code, rebuild, and restart Scout? The page will go down for a moment.")) return;
    setUpdating(true);
    setUpdateOutput(null);
    try {
      const result = await api.systemUpdate();
      const log = result.steps.map((step) => `$ ${step.command}\n${step.output}`).join("\n\n");
      setUpdateOutput(log);
      onToast("Updated. Scout is restarting…");
    } catch (error) {
      onToast(errorMessage(error), "error");
    } finally {
      setUpdating(false);
    }
  };
  const configured = settings?.webhookConfigured ?? false;
  const ntfyConfigured = settings?.ntfy?.configured ?? false;
  const ntfyCanOpenInApp = ntfyConfigured || ntfyTopic.trim() !== "";
  const aiConfigured = settings?.ai?.configured ?? false;
  const settingsLoaded = settings !== null;
  return (
    <>
      <PageHeader title="Settings" />
      <div className="settings-grid">
        <Section title="Appearance">
          <div className="theme-options">
            {(["light", "dark", "system"] as Theme[]).map((choice) => (
              <button
                key={choice}
                className={`theme-option ${theme === choice ? "theme-option--selected" : ""}`}
                onClick={() => onTheme(choice)}
              >
                {choice === "light" ? <Sun size={17} /> : choice === "dark" ? <Moon size={17} /> : <Settings2 size={17} />}
                <span>{choice[0].toUpperCase() + choice.slice(1)}</span>
                {theme === choice ? <Check size={15} /> : null}
              </button>
            ))}
          </div>
        </Section>
        <Section title="Scanning">
          <div className="field-row">
            <label className="field-label">
              New watches check every (min)
              <input type="number" min="5" max="1440" value={interval} onChange={(event) => setIntervalValue(event.target.value)} />
            </label>
            <label className="field-label" title="22:00–08:00, server local time. A floor: watches that already run slower are not sped up.">
              At night, at most every (min)
              <input type="number" min="5" max="1440" value={nightInterval} onChange={(event) => setNightInterval(event.target.value)} />
            </label>
          </div>
        </Section>
        <Section title="Notifications" wide>
          <div className="settings-subsection">
            <label className="settings-toggle">
              <input type="checkbox" checked={dailyDigestEnabled} disabled={!settingsLoaded || saving} onChange={(event) => setDailyDigestEnabled(event.target.checked)} />
              <span>
                <strong>Daily digest</strong>
                <small>Strong and Very strong deals arrive once a day; Exceptional deals stay immediate. Empty digests are skipped.</small>
              </span>
            </label>
            {dailyDigestEnabled ? (
              <div className="field-row">
                <label className="field-label">
                  Delivery time <span className="field-hint-inline">server time</span>
                  <input type="time" value={dailyDigestTime} disabled={!settingsLoaded || saving} onChange={(event) => setDailyDigestTime(event.target.value)} />
                </label>
                <div className="field-label">
                  <span>Send to</span>
                  <div className="source-options">
                    <button type="button" aria-pressed={dailyDigestDiscord} className={`source-option ${dailyDigestDiscord ? "source-option--selected" : ""}`} disabled={!settingsLoaded || saving} onClick={() => setDailyDigestDiscord((value) => !value)}>
                      <i style={{ background: "#5865f2" }} />Discord{dailyDigestDiscord ? <Check size={15} /> : null}
                    </button>
                    <button type="button" aria-pressed={dailyDigestNtfy} className={`source-option ${dailyDigestNtfy ? "source-option--selected" : ""}`} disabled={!settingsLoaded || saving} onClick={() => setDailyDigestNtfy((value) => !value)}>
                      <i style={{ background: "#4f9da6" }} />ntfy{dailyDigestNtfy ? <Check size={15} /> : null}
                    </button>
                  </div>
                </div>
              </div>
            ) : null}
            {settings?.dailyDigest?.lastSentAt ? (
              <div className="settings-inline-note">Last digest delivered {new Date(settings.dailyDigest.lastSentAt).toLocaleString("pl-PL")}.</div>
            ) : null}
          </div>
          <div className="settings-subsection">
            <div className="settings-subsection-heading">
              <h3>Discord</h3>
              <span className={`settings-status ${configured ? "" : "settings-status--idle"}`}><i />{settingsLoaded ? configured ? "Configured" : "Not configured" : "Loading…"}</span>
            </div>
            <div className="field-row">
              <label className="field-label" title="Encrypted at rest and never returned to the browser">
                Webhook URL
                <input
                  type="url"
                  autoComplete="off"
                  disabled={!settingsLoaded}
                  placeholder={configured ? (settings?.webhookMasked ?? "Saved webhook") : "https://discord.com/api/webhooks/…"}
                  value={webhook}
                  onChange={(event) => setWebhook(event.target.value)}
                />
              </label>
              <label className="field-label">
                Send deals from
                <select value={discordMinimumPriority} onChange={(event) => setDiscordMinimumPriority(event.target.value as NotificationPriority)}>
                  <option value="strong">Strong and above</option>
                  <option value="very-strong">Very strong and above</option>
                  <option value="exceptional">Exceptional only</option>
                </select>
              </label>
            </div>
            <div className="settings-actions">
              <button className="outline-button" disabled={testing || !configured} onClick={testWebhook}>
                {testing ? <LoaderCircle size={15} className="spin" /> : <Send size={15} />}
                {testing ? "Sending…" : "Send test"}
              </button>
              {configured ? (
                <button className="outline-button danger-outline" disabled={saving} onClick={clearWebhook}>
                  <Trash2 size={15} />
                  Remove webhook
                </button>
              ) : null}
            </div>
          </div>
          <div className="settings-subsection">
            <div className="settings-subsection-heading">
              <h3>ntfy</h3>
              <span className={`settings-status ${ntfyConfigured ? "" : "settings-status--idle"}`}><i />{settingsLoaded ? ntfyConfigured ? "Configured" : "Not configured" : "Loading…"}</span>
            </div>
            <div className="field-row">
              <label className="field-label">
                Server URL
                <input type="url" autoComplete="off" disabled={!settingsLoaded} value={ntfyServerUrl} onChange={(event) => setNtfyServerUrl(event.target.value)} placeholder="https://ntfy.sh" />
              </label>
              <label className="field-label" title="Topic names behave like passwords; the topic and token are encrypted at rest">
                Topic
                <input autoComplete="off" disabled={!settingsLoaded} value={ntfyTopic} onChange={(event) => setNtfyTopic(event.target.value)} placeholder={ntfyConfigured ? (settings?.ntfy?.topicMasked ?? "Saved topic") : "e.g. scout-deals"} />
              </label>
            </div>
            <div className="field-row">
              <label className="field-label">
                Access token <span className="field-hint-inline">optional</span>
                <input type="password" autoComplete="new-password" disabled={!settingsLoaded} value={ntfyToken} onChange={(event) => setNtfyToken(event.target.value)} placeholder={settings?.ntfy?.tokenConfigured ? "Saved token" : "tk_…"} />
              </label>
              <label className="field-label">
                Send deals from
                <select value={ntfyMinimumPriority} onChange={(event) => setNtfyMinimumPriority(event.target.value as NotificationPriority)}>
                  <option value="strong">Strong and above</option>
                  <option value="very-strong">Very strong and above</option>
                  <option value="exceptional">Exceptional only</option>
                </select>
              </label>
            </div>
            <label className="check-option settings-check" title="Tapping an alert opens the listing in the Scout iOS app; its Open listing button still goes to the marketplace. Leave off if you read ntfy on desktop or Android.">
              <input type="checkbox" disabled={!settingsLoaded || !ntfyCanOpenInApp} checked={ntfyOpenInApp} onChange={(event) => setNtfyOpenInApp(event.target.checked)} />
              <strong>Open alerts in the Scout iOS app</strong>
            </label>
            <div className="settings-actions">
              <button className="outline-button" disabled={testingNtfy || !ntfyConfigured} onClick={testNtfy}>
                {testingNtfy ? <LoaderCircle size={15} className="spin" /> : <Send size={15} />}
                {testingNtfy ? "Sending…" : "Send test"}
              </button>
              {ntfyConfigured ? (
                <button className="outline-button danger-outline" disabled={saving} onClick={clearNtfy}>
                  <Trash2 size={15} />
                  Remove ntfy
                </button>
              ) : null}
              <button className="link-button" onClick={onHistory}>
                Notification history <ArrowRight size={16} />
              </button>
            </div>
          </div>
        </Section>
      </div>
      {settings?.publicExposureWarning ? (
        <div className="form-error settings-warning" role="alert">
          <AlertTriangle size={15} />
          Scout is listening beyond loopback with sign-in turned off (SCOUT_AUTH=off). Keep it behind a trusted LAN or VPN.
        </div>
      ) : null}
      <details className="settings-setup">
        <summary>Server setup: AI, marketplace accounts, backups, updates and access</summary>
        <div className="settings-grid">
          <Section title="AI listing checks" wide status={{ on: aiConfigured, label: settingsLoaded ? aiConfigured ? (settings?.ai?.source === "environment" ? "From environment" : "Configured") : "Not configured" : "Loading…" }}>
            <div className="field-row">
              <label className="field-label">
                OpenRouter model
                <input autoComplete="off" disabled={!settingsLoaded} value={aiModel} onChange={(event) => setAiModel(event.target.value)} placeholder="deepseek/deepseek-v4-flash" />
              </label>
              <label className="field-label" title="Encrypted with SCOUT_SECRET and never returned to the browser. Headless deployments can set SCOUT_OPENROUTER_API_KEY and SCOUT_OPENROUTER_MODEL instead.">
                API token <span className="field-hint-inline">{settings?.ai?.source === "environment" ? "environment token active" : "encrypted"}</span>
                <input type="password" autoComplete="new-password" disabled={!settingsLoaded} value={aiApiKey} onChange={(event) => setAiApiKey(event.target.value)} placeholder={settings?.ai?.source === "settings" ? "Saved token" : "sk-or-v1-…"} />
              </label>
            </div>
            {settings?.ai?.source === "settings" ? <div className="settings-actions"><button className="outline-button danger-outline" disabled={saving} onClick={() => void clearAiApiKey()}><Trash2 size={15} />Remove saved token</button></div> : null}
          </Section>
          <Section title="Marketplace accounts" wide>
            <div className="session-status-list">
              {(settings?.marketplaceSessions ?? []).map((session) => (
                <div className="session-status-row" key={session.marketplace}>
                  <i className={session.connected ? "session-dot session-dot--connected" : "session-dot"} />
                  <div>
                    <strong>{session.marketplace}{session.label ? ` · ${session.label}` : ""}</strong>
                    <span>{session.detail}</span>
                  </div>
                  {session.createdAt ? (
                    <button className="link-button danger-link" disabled={savingSession} onClick={() => void removeMarketplaceSession(session.marketplace)}>
                      Remove
                    </button>
                  ) : null}
                </div>
              ))}
            </div>
            <div className="field-row">
              <label className="field-label">
                Marketplace
                <select value={sessionMarketplace} onChange={(event) => setSessionMarketplace(event.target.value as Marketplace)}>
                  {(["OLX", "Allegro Lokalnie", "Vinted"] as Marketplace[]).map((marketplace) => <option key={marketplace}>{marketplace}</option>)}
                </select>
              </label>
              <label className="field-label">
                Label <span className="field-hint-inline">optional</span>
                <input value={sessionLabel} onChange={(event) => setSessionLabel(event.target.value)} placeholder="e.g. personal account" maxLength={80} />
              </label>
            </div>
            <label className="field-label" title="Log in manually, export Playwright storage state and import it here. Scout encrypts it with SCOUT_SECRET and never returns it. Do not paste a raw Cookie header.">
              Playwright storage-state JSON
              <textarea
                value={storageStateInput}
                onChange={(event) => { setStorageStateInput(event.target.value); setStorageStateFile(""); }}
                placeholder={'{"cookies":[...],"origins":[...]}' }
                spellCheck={false}
                autoComplete="off"
              />
            </label>
            <div className="settings-actions">
              <label className="outline-button file-button">
                <input
                  type="file"
                  accept="application/json,.json"
                  onChange={async (event) => {
                    const file = event.currentTarget.files?.[0];
                    if (!file) return;
                    try {
                      setStorageStateInput(await file.text());
                      setStorageStateFile(file.name);
                    } catch {
                      onToast("Could not read the storage-state file.", "error");
                    }
                  }}
                />
                {storageStateFile || "Choose JSON file"}
              </label>
              <button className="outline-button" disabled={savingSession || !settingsLoaded} onClick={() => void saveMarketplaceSession()}>
                {savingSession ? <LoaderCircle size={16} className="spin" /> : <ShieldCheck size={16} />}
                {savingSession ? "Saving…" : "Save session"}
              </button>
            </div>
          </Section>
          <Section title="Data">
            <div className="settings-actions settings-actions--stack">
              <button className="outline-button" title="Readable history without credentials or marketplace sessions" disabled={recoveryBusy || resettingAi || !settingsLoaded} onClick={() => void exportData()}><Database size={15} />Download export</button>
              <button className="outline-button" title="A WAL-aware SQLite copy beside the database; store it with the deployment secret" disabled={recoveryBusy || resettingAi || !settingsLoaded} onClick={() => void createBackup()}><ShieldCheck size={15} />Create database backup</button>
              <button className="outline-button danger-outline" disabled={recoveryBusy || resettingAi || !settingsLoaded} onClick={() => void resetAiResults()}>{resettingAi ? <LoaderCircle size={15} className="spin" /> : <Trash2 size={15} />}Reset AI results</button>
            </div>
          </Section>
          <Section title="Update and access">
            <div className="settings-actions settings-actions--stack">
              <button className="outline-button" title="Runs git pull, npm run build, then systemctl restart scout" disabled={updating || !settingsLoaded} onClick={() => void runSystemUpdate()}>{updating ? <LoaderCircle size={15} className="spin" /> : <RefreshCw size={15} />}{updating ? "Updating…" : "Update Scout"}</button>
              {settings?.authEnabled ? (
                <button
                  className="outline-button danger-outline"
                  onClick={() => {
                    if (!window.confirm("Sign out every browser session, including this one?")) return;
                    void api.logoutAll().finally(() => window.location.reload());
                  }}
                >
                  <LogOut size={15} />Sign out everywhere
                </button>
              ) : null}
            </div>
            {updateOutput ? <pre className="settings-update-output">{updateOutput}</pre> : null}
            <p className="settings-inline-note">
              {!settingsLoaded
                ? "Checking access…"
                : settings.authEnabled
                  ? "Sign-in is required. Serve Scout over HTTPS so cookies and tokens never travel in clear text."
                  : "Sign-in is off. Keep Scout on a trusted LAN or VPN, or set SCOUT_PASSWORD_HASH / SCOUT_API_TOKENS before exposing it."}
            </p>
          </Section>
        </div>
      </details>
      {/* Sticky, so the one Save button stays in reach from every section. */}
      <div className="settings-footer">
        <span>Theme and the marketplace, data and update buttons apply at once.</span>
        <button className="primary-button" disabled={saving || !settings} onClick={save}>
          {saving ? <LoaderCircle size={17} className="spin" /> : <Check size={17} />}
          {saving ? "Saving…" : "Save settings"}
        </button>
      </div>
    </>
  );
}
