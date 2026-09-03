import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  Check,
  Clock3,
  Database,
  Info,
  LoaderCircle,
  Moon,
  Send,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Sun,
  Trash2,
  Zap,
} from "lucide-react";
import { api } from "./api";
import type { Marketplace, NotificationPriority, SettingsData, Theme } from "./types";

type Toast = { type: "success" | "error" | "info" };

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "Something went wrong";

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
  const [autoNegotiationEnabled, setAutoNegotiationEnabled] = useState(false);
  const [autoNegotiationMaxTotal, setAutoNegotiationMaxTotal] = useState("");
  const [autoNegotiationShipping, setAutoNegotiationShipping] = useState("0");
  const [autoNegotiationOtherCosts, setAutoNegotiationOtherCosts] = useState("0");
  const [autoNegotiationMinimumDiscount, setAutoNegotiationMinimumDiscount] = useState("18");
  const [autoNegotiationOpeningDiscount, setAutoNegotiationOpeningDiscount] = useState("12");
  const [autoNegotiationDailyLimit, setAutoNegotiationDailyLimit] = useState("3");
  const [negotiationUseBand, setNegotiationUseBand] = useState(false);
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
  const [sessionMarketplace, setSessionMarketplace] = useState<Marketplace>("OLX");
  const [sessionLabel, setSessionLabel] = useState("");
  const [storageStateInput, setStorageStateInput] = useState("");
  const [storageStateFile, setStorageStateFile] = useState("");
  const [savingSession, setSavingSession] = useState(false);
  const [recoveryBusy, setRecoveryBusy] = useState(false);
  const loadSettings = useCallback(async () => {
    try {
      const result = await api.settings();
      setSettings(result);
      setIntervalValue(String(result.defaultInterval));
      setNightInterval(String(result.nightInterval));
      setAiModel(result.ai?.model ?? "");
      setAutoNegotiationEnabled(result.autoNegotiation?.enabled ?? false);
      setNegotiationUseBand(result.negotiationUseBand ?? false);
      setAutoNegotiationMaxTotal(result.autoNegotiation?.maxTotalCost === null || result.autoNegotiation?.maxTotalCost === undefined ? "" : String(result.autoNegotiation.maxTotalCost));
      setAutoNegotiationShipping(String(result.autoNegotiation?.shippingCost ?? 0));
      setAutoNegotiationOtherCosts(String(result.autoNegotiation?.otherCosts ?? 0));
      setAutoNegotiationMinimumDiscount(String(result.autoNegotiation?.minimumDiscountPercent ?? 18));
      setAutoNegotiationOpeningDiscount(String(result.autoNegotiation?.openingDiscountPercent ?? 12));
      setAutoNegotiationDailyLimit(String(result.autoNegotiation?.dailyLimit ?? 3));
      setDiscordMinimumPriority(result.discordMinimumPriority);
      setDailyDigestEnabled(result.dailyDigest?.enabled ?? false);
      setDailyDigestTime(result.dailyDigest?.time ?? "08:00");
      setDailyDigestDiscord(result.dailyDigest?.discord ?? true);
      setDailyDigestNtfy(result.dailyDigest?.ntfy ?? false);
      setNtfyServerUrl(result.ntfy?.serverUrl ?? "https://ntfy.sh");
      setNtfyMinimumPriority(result.ntfy?.minimumPriority ?? "exceptional");
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
    const autoMaxTotal = autoNegotiationMaxTotal.trim() === "" ? null : Number(autoNegotiationMaxTotal);
    const autoShipping = autoNegotiationShipping.trim() === "" ? 0 : Number(autoNegotiationShipping);
    const autoOtherCosts = autoNegotiationOtherCosts.trim() === "" ? 0 : Number(autoNegotiationOtherCosts);
    const autoMinimumDiscount = Number(autoNegotiationMinimumDiscount);
    const autoOpeningDiscount = Number(autoNegotiationOpeningDiscount);
    const autoDailyLimit = Number(autoNegotiationDailyLimit);
    if (autoNegotiationEnabled && (autoMaxTotal === null || !Number.isFinite(autoMaxTotal) || autoMaxTotal <= 0)) {
      onToast("Set a positive maximum total cost before enabling automatic negotiation.", "error");
      return;
    }
    if (![autoShipping, autoOtherCosts].every((value) => Number.isFinite(value) && value >= 0)) {
      onToast("Automatic negotiation known costs must be zero or positive.", "error");
      return;
    }
    if (!Number.isFinite(autoMinimumDiscount) || autoMinimumDiscount < 18 || autoMinimumDiscount > 80) {
      onToast("Minimum deal discount must be between 18% and 80%.", "error");
      return;
    }
    if (!Number.isFinite(autoOpeningDiscount) || autoOpeningDiscount < 1 || autoOpeningDiscount > 50) {
      onToast("Opening discount must be between 1% and 50%.", "error");
      return;
    }
    if (!Number.isInteger(autoDailyLimit) || autoDailyLimit < 1 || autoDailyLimit > 50) {
      onToast("Daily attempt limit must be between 1 and 50.", "error");
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
        negotiationUseBand,
        autoNegotiation: {
          enabled: autoNegotiationEnabled,
          maxTotalCost: autoMaxTotal,
          shippingCost: autoShipping,
          otherCosts: autoOtherCosts,
          minimumDiscountPercent: autoMinimumDiscount,
          openingDiscountPercent: autoOpeningDiscount,
          dailyLimit: autoDailyLimit,
        },
        ntfy: ntfyTouched
          ? {
              serverUrl: ntfyServerUrl.trim() || undefined,
              topic: ntfyTopic.trim() || undefined,
              token: ntfyToken.trim() || undefined,
              minimumPriority: ntfyMinimumPriority,
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
      setAutoNegotiationEnabled(result.autoNegotiation?.enabled ?? false);
      setNegotiationUseBand(result.negotiationUseBand ?? false);
      setAutoNegotiationMaxTotal(result.autoNegotiation?.maxTotalCost === null || result.autoNegotiation?.maxTotalCost === undefined ? "" : String(result.autoNegotiation.maxTotalCost));
      setAutoNegotiationShipping(String(result.autoNegotiation?.shippingCost ?? 0));
      setAutoNegotiationOtherCosts(String(result.autoNegotiation?.otherCosts ?? 0));
      setAutoNegotiationMinimumDiscount(String(result.autoNegotiation?.minimumDiscountPercent ?? 18));
      setAutoNegotiationOpeningDiscount(String(result.autoNegotiation?.openingDiscountPercent ?? 12));
      setAutoNegotiationDailyLimit(String(result.autoNegotiation?.dailyLimit ?? 3));
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
  const configured = settings?.webhookConfigured ?? false;
  const ntfyConfigured = settings?.ntfy?.configured ?? false;
  const aiConfigured = settings?.ai?.configured ?? false;
  const autoNegotiation = settings?.autoNegotiation;
  const olxSessionConnected = settings?.marketplaceSessions.find((session) => session.marketplace === "OLX")?.connected ?? false;
  const allegroSessionConnected = settings?.marketplaceSessions.find((session) => session.marketplace === "Allegro Lokalnie")?.connected ?? false;
  const settingsLoaded = settings !== null;
  return (
    <>
      <PageHeader
        title="Settings"
        description="Keep Scout quiet, safe, and easy to operate on your home server."
      />
      <div className="settings-grid">
        <section className="settings-section">
          <div className="settings-section-heading">
            <div className="settings-symbol">
              <Sun size={18} />
            </div>
            <div>
              <h2>Appearance</h2>
              <p>Choose how the dashboard looks on this device.</p>
            </div>
          </div>
          <div className="theme-options">
            {(["light", "dark", "system"] as Theme[]).map((choice) => (
              <button
                key={choice}
                className={`theme-option ${theme === choice ? "theme-option--selected" : ""}`}
                onClick={() => onTheme(choice)}
              >
                {choice === "light" ? (
                  <Sun size={18} />
                ) : choice === "dark" ? (
                  <Moon size={18} />
                ) : (
                  <Settings2 size={18} />
                )}
                <span>{choice[0].toUpperCase() + choice.slice(1)}</span>
                {theme === choice ? <Check size={16} /> : null}
              </button>
            ))}
          </div>
        </section>
        <section className="settings-section">
          <div className="settings-section-heading">
            <div className="settings-symbol">
              <SlidersHorizontal size={18} />
            </div>
            <div>
              <h2>Scan defaults</h2>
              <p>New watches use these values unless overridden.</p>
            </div>
          </div>
          <div className="field-row">
            <label className="field-label">
              Default polling interval <span>minutes</span>
              <input
                type="number"
                min="5"
                max="1440"
                value={interval}
                onChange={(event) => setIntervalValue(event.target.value)}
              />
            </label>
            <label className="field-label">
              Night polling interval <span>22:00–08:00 · server local time</span>
              <input
                type="number"
                min="5"
                max="1440"
                value={nightInterval}
                onChange={(event) => setNightInterval(event.target.value)}
              />
            </label>
          </div>
          <div className="field-help">
            <Info size={15} />
            Night polling is a floor: watches that already run slower will not
            be accelerated. The default is 30 minutes overnight.
          </div>
        </section>
        <section className="settings-section settings-section--wide">
          <div className="settings-section-heading">
            <div className="settings-symbol settings-symbol--blue">
              <Zap size={18} />
            </div>
            <div>
              <h2>AI listing intelligence</h2>
              <p>Use a DeepSeek model through OpenRouter to filter out accessories, parts, and unrelated matches. Listing normalization stays manual and is off by default.</p>
            </div>
            <span className={`settings-status ${aiConfigured ? "" : "settings-status--idle"}`}>
              <i />
              {settingsLoaded ? aiConfigured ? (settings?.ai?.source === "environment" ? "Environment" : "Configured") : "Not configured" : "Loading…"}
            </span>
          </div>
          <div className="field-row">
            <label className="field-label">
              OpenRouter model <span>uses JSON output</span>
              <input
                autoComplete="off"
                disabled={!settingsLoaded}
                value={aiModel}
                onChange={(event) => setAiModel(event.target.value)}
                placeholder="deepseek/deepseek-v4-flash"
              />
            </label>
            <label className="field-label">
              API token <span>{settings?.ai?.source === "environment" ? "environment token is active" : "encrypted at rest"}</span>
              <input
                type="password"
                autoComplete="new-password"
                disabled={!settingsLoaded}
                value={aiApiKey}
                onChange={(event) => setAiApiKey(event.target.value)}
                placeholder={settings?.ai?.source === "settings" ? "Saved token" : "sk-or-v1-…"}
              />
            </label>
          </div>
          <div className="settings-actions">
            {settings?.ai?.source === "settings" ? <button className="outline-button danger-outline" disabled={saving} onClick={() => void clearAiApiKey()}><Trash2 size={15} />Remove saved token</button> : null}
            <span className="settings-inline-note">Normalization is manual from a listing drawer and never runs automatically.</span>
          </div>
          <div className="security-note">
            <ShieldCheck size={17} />
            <span>The token is encrypted with SCOUT_SECRET and never returned to the browser. Headless deployments can use SCOUT_OPENROUTER_API_KEY and SCOUT_OPENROUTER_MODEL instead.</span>
          </div>
        </section>
        <section className={`settings-section settings-section--wide ${autoNegotiationEnabled ? "auto-negotiation-section--active" : ""}`}>
          <div className="settings-section-heading">
            <div className="settings-symbol settings-symbol--blue">
              <Send size={18} />
            </div>
            <div>
              <h2>Automatic marketplace negotiation</h2>
              <p>Send one AI-written opening message when a saved OLX or Allegro Lokalnie listing becomes a qualifying deal.</p>
            </div>
            <span className={`settings-status ${autoNegotiationEnabled ? "" : "settings-status--idle"}`}>
              <i />
              {settingsLoaded ? autoNegotiationEnabled ? "Enabled" : "Off" : "Loading…"}
            </span>
          </div>
          <label className="auto-negotiation-toggle">
            <input type="checkbox" checked={autoNegotiationEnabled} disabled={!settingsLoaded || saving} onChange={(event) => setAutoNegotiationEnabled(event.target.checked)} />
            <span>
              <strong>Enable automatic seller messages</strong>
              <small>Opt in only after checking the budget, session, and message limit below.</small>
            </span>
          </label>
          <label className="auto-negotiation-toggle">
            <input type="checkbox" checked={negotiationUseBand} disabled={!settingsLoaded || saving} onChange={(event) => setNegotiationUseBand(event.target.checked)} />
            <span>
              <strong>Cap offers with a reference series band</strong>
              <small>When a watch uses a research series as its fallback baseline, probable-sale band highs can only tighten the offer ceiling — including bounded automatic negotiation. It never loosens it.</small>
            </span>
          </label>
          <div className="field-row">
            <label className="field-label">
              Maximum total cost <span>required · PLN</span>
              <input type="number" min="1" step="1" value={autoNegotiationMaxTotal} disabled={!settingsLoaded || saving} onChange={(event) => setAutoNegotiationMaxTotal(event.target.value)} placeholder="e.g. 2100" />
            </label>
            <label className="field-label">
              Delivery and fees <span>optional · PLN</span>
              <input type="number" min="0" step="1" value={autoNegotiationShipping} disabled={!settingsLoaded || saving} onChange={(event) => setAutoNegotiationShipping(event.target.value)} placeholder="0" />
            </label>
          </div>
          <div className="field-row">
            <label className="field-label">
              Other known costs <span>optional · PLN</span>
              <input type="number" min="0" step="1" value={autoNegotiationOtherCosts} disabled={!settingsLoaded || saving} onChange={(event) => setAutoNegotiationOtherCosts(event.target.value)} placeholder="0" />
            </label>
            <label className="field-label">
              Minimum deal discount <span>18–80% below typical</span>
              <input type="number" min="18" max="80" step="1" value={autoNegotiationMinimumDiscount} disabled={!settingsLoaded || saving} onChange={(event) => setAutoNegotiationMinimumDiscount(event.target.value)} />
            </label>
          </div>
          <div className="field-row">
            <label className="field-label">
              Opening discount <span>1–50% below current ask</span>
              <input type="number" min="1" max="50" step="1" value={autoNegotiationOpeningDiscount} disabled={!settingsLoaded || saving} onChange={(event) => setAutoNegotiationOpeningDiscount(event.target.value)} />
            </label>
            <label className="field-label">
              Daily attempt limit <span>1–50 listings</span>
              <input type="number" min="1" max="50" step="1" value={autoNegotiationDailyLimit} disabled={!settingsLoaded || saving} onChange={(event) => setAutoNegotiationDailyLimit(event.target.value)} />
            </label>
          </div>
          <div className="field-help">
            <Info size={15} />
            Automatic messages require OpenRouter with a DeepSeek model, an authenticated OLX or Allegro Lokalnie session, an explicit negotiable-price signal, and a qualifying deal. Fixed or unspecified prices are never contacted automatically.
          </div>
          <div className="auto-negotiation-status">
            <span>Today: <strong>{autoNegotiation?.attemptedToday ?? 0}/{autoNegotiation?.dailyLimit ?? autoNegotiationDailyLimit} attempts</strong></span>
            <span><strong>{autoNegotiation?.sentToday ?? 0}</strong> sent</span>
            <span className={aiConfigured ? "auto-negotiation-status--ready" : ""}>{aiConfigured ? "OpenRouter ready" : "OpenRouter not configured"}</span>
            <span className={olxSessionConnected ? "auto-negotiation-status--ready" : ""}>{olxSessionConnected ? "OLX session ready" : "OLX session missing"}</span>
            <span className={allegroSessionConnected ? "auto-negotiation-status--ready" : ""}>{allegroSessionConnected ? "Allegro Lokalnie session ready" : "Allegro Lokalnie session missing"}</span>
          </div>
        </section>
        <section className="settings-section settings-section--wide">
          <div className="settings-section-heading">
            <div className="settings-symbol settings-symbol--blue">
              <ShieldCheck size={18} />
            </div>
            <div>
              <h2>Marketplace accounts</h2>
              <p>
                Use a session from your own logged-in browser to keep requests
                associated with your account.
              </p>
            </div>
          </div>
          <div className="session-status-list">
            {(settings?.marketplaceSessions ?? []).map((session) => (
              <div className="session-status-row" key={session.marketplace}>
                <i className={session.connected ? "session-dot session-dot--connected" : "session-dot"} />
                <div>
                  <strong>{session.marketplace}{session.label ? ` · ${session.label}` : ""}</strong>
                  <span>{session.detail}</span>
                </div>
                {session.createdAt ? (
                  <button
                    className="link-button danger-link"
                    disabled={savingSession}
                    onClick={() => void removeMarketplaceSession(session.marketplace)}
                  >
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
              Label <span>optional</span>
              <input value={sessionLabel} onChange={(event) => setSessionLabel(event.target.value)} placeholder="e.g. personal account" maxLength={80} />
            </label>
          </div>
          <label className="field-label">
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
            <button className="primary-button" disabled={savingSession || !settingsLoaded} onClick={() => void saveMarketplaceSession()}>
              {savingSession ? <LoaderCircle size={16} className="spin" /> : <ShieldCheck size={16} />}
              {savingSession ? "Saving…" : "Save session"}
            </button>
          </div>
          <div className="security-note">
            <ShieldCheck size={17} />
            <span>
              Log in manually, export Playwright storage state, and import it
              here. Scout encrypts it with SCOUT_SECRET and never returns it.
              Do not paste a raw Cookie header or share the JSON.
            </span>
          </div>
        </section>
        <section className={`settings-section settings-section--wide ${dailyDigestEnabled ? "auto-negotiation-section--active" : ""}`}>
          <div className="settings-section-heading">
            <div className="settings-symbol settings-symbol--blue">
              <Clock3 size={18} />
            </div>
            <div>
              <h2>Daily deal digest</h2>
              <p>Bundle Strong and Very strong deals into one quiet daily summary. Exceptional deals remain immediate.</p>
            </div>
            <span className={`settings-status ${dailyDigestEnabled ? "" : "settings-status--idle"}`}>
              <i />
              {settingsLoaded ? dailyDigestEnabled ? "Enabled" : "Off" : "Loading…"}
            </span>
          </div>
          <label className="auto-negotiation-toggle">
            <input type="checkbox" checked={dailyDigestEnabled} disabled={!settingsLoaded || saving} onChange={(event) => setDailyDigestEnabled(event.target.checked)} />
            <span>
              <strong>Send a daily digest</strong>
              <small>Empty digests are suppressed. Delivery uses the server's local timezone.</small>
            </span>
          </label>
          <div className="field-row">
            <label className="field-label">
              Delivery time <span>server local time</span>
              <input type="time" value={dailyDigestTime} disabled={!settingsLoaded || saving} onChange={(event) => setDailyDigestTime(event.target.value)} />
            </label>
            <div className="field-label">
              <span>Delivery channels</span>
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
          <div className="field-help">
            <Info size={15} />
            Each channel keeps its own minimum-priority filter. A meaningful price drop or priority increase can add a listing to a later digest; unchanged repeats are suppressed.
          </div>
          {settings?.dailyDigest?.lastSentAt ? (
            <div className="settings-inline-note">Last digest delivered {new Date(settings.dailyDigest.lastSentAt).toLocaleString("pl-PL")}.</div>
          ) : null}
        </section>
        <section className="settings-section settings-section--wide">
          <div className="settings-section-heading">
            <div className="settings-symbol settings-symbol--blue">
              <Send size={18} />
            </div>
            <div>
              <h2>Discord notifications</h2>
              <p>
                One idempotent embed per qualifying listing. The webhook is
                encrypted at rest.
              </p>
            </div>
            <span
              className={`settings-status ${configured ? "" : "settings-status--idle"}`}
            >
              <i />
              {settingsLoaded
                ? configured
                  ? "Configured"
                  : "Not configured"
                : "Loading…"}
            </span>
          </div>
          <label className="field-label">
            Webhook URL
            <input
              type="url"
              autoComplete="off"
              disabled={!settingsLoaded}
              placeholder={
                configured
                  ? (settings?.webhookMasked ?? "Saved webhook")
                  : "https://discord.com/api/webhooks/…"
              }
              value={webhook}
              onChange={(event) => setWebhook(event.target.value)}
            />
          </label>
          <label className="field-label">
            Minimum deal priority <span>Discord channel filter</span>
            <select value={discordMinimumPriority} onChange={(event) => setDiscordMinimumPriority(event.target.value as NotificationPriority)}>
              <option value="strong">Strong and above</option>
              <option value="very-strong">Very strong and above</option>
              <option value="exceptional">Exceptional only</option>
            </select>
          </label>
          <div className="settings-actions">
            <button
              className="outline-button"
              disabled={testing || !configured}
              onClick={testWebhook}
            >
              {testing ? (
                <LoaderCircle size={15} className="spin" />
              ) : (
                <Send size={15} />
              )}
              {testing ? "Sending…" : "Send test notification"}
            </button>
            {configured ? (
              <button
                className="outline-button danger-outline"
                disabled={saving}
                onClick={clearWebhook}
              >
                <Trash2 size={15} />
                Remove webhook
              </button>
            ) : null}
            <button className="link-button" onClick={onHistory}>
              View notification history <ArrowRight size={16} />
            </button>
          </div>
          <div className="security-note">
            <ShieldCheck size={17} />
            <span>
              Secret encryption uses the deployment secret. The stored webhook
              is never returned to the browser.
            </span>
          </div>
        </section>
        <section className="settings-section settings-section--wide">
          <div className="settings-section-heading">
            <div className="settings-symbol settings-symbol--blue">
              <Send size={18} />
            </div>
            <div>
              <h2>ntfy notifications</h2>
              <p>
                Send only the priority tier you choose to an ntfy topic. The
                default is Exceptional only, keeping this channel quiet.
              </p>
            </div>
            <span className={`settings-status ${ntfyConfigured ? "" : "settings-status--idle"}`}>
              <i />
              {settingsLoaded ? ntfyConfigured ? "Configured" : "Not configured" : "Loading…"}
            </span>
          </div>
          <div className="field-row">
            <label className="field-label">
              Server URL
              <input
                type="url"
                autoComplete="off"
                disabled={!settingsLoaded}
                value={ntfyServerUrl}
                onChange={(event) => setNtfyServerUrl(event.target.value)}
                placeholder="https://ntfy.sh"
              />
            </label>
            <label className="field-label">
              Topic
              <input
                autoComplete="off"
                disabled={!settingsLoaded}
                value={ntfyTopic}
                onChange={(event) => setNtfyTopic(event.target.value)}
                placeholder={ntfyConfigured ? (settings?.ntfy?.topicMasked ?? "Saved topic") : "e.g. scout-deals"}
              />
            </label>
          </div>
          <div className="field-row">
            <label className="field-label">
              Access token <span>optional</span>
              <input
                type="password"
                autoComplete="new-password"
                disabled={!settingsLoaded}
                value={ntfyToken}
                onChange={(event) => setNtfyToken(event.target.value)}
                placeholder={settings?.ntfy?.tokenConfigured ? "Saved token" : "tk_…"}
              />
            </label>
            <label className="field-label">
              Minimum deal priority <span>ntfy channel filter</span>
              <select value={ntfyMinimumPriority} onChange={(event) => setNtfyMinimumPriority(event.target.value as NotificationPriority)}>
                <option value="strong">Strong and above</option>
                <option value="very-strong">Very strong and above</option>
                <option value="exceptional">Exceptional only</option>
              </select>
            </label>
          </div>
          <div className="settings-actions">
            <button className="outline-button" disabled={testingNtfy || !ntfyConfigured} onClick={testNtfy}>
              {testingNtfy ? <LoaderCircle size={15} className="spin" /> : <Send size={15} />}
              {testingNtfy ? "Sending…" : "Send test notification"}
            </button>
            {ntfyConfigured ? (
              <button className="outline-button danger-outline" disabled={saving} onClick={clearNtfy}>
                <Trash2 size={15} />
                Remove ntfy
              </button>
            ) : null}
          </div>
          <div className="security-note">
            <ShieldCheck size={17} />
            <span>
              The topic and optional access token are encrypted at rest. Topic
              names behave like passwords, so avoid sharing them publicly.
            </span>
          </div>
        </section>
        <section
          className="settings-section settings-section--wide"
        >
          <div className="settings-section-heading">
            <div className="settings-symbol settings-symbol--blue"><Database size={18} /></div>
            <div><h2>Data recovery</h2><p>Export readable history or create a WAL-aware SQLite restore point.</p></div>
          </div>
          <div className="settings-actions">
            <button className="outline-button" disabled={recoveryBusy || !settingsLoaded} onClick={() => void exportData()}><Database size={15} />Download safe export</button>
            <button className="outline-button" disabled={recoveryBusy || !settingsLoaded} onClick={() => void createBackup()}><ShieldCheck size={15} />Create database backup</button>
          </div>
          <div className="security-note"><ShieldCheck size={17} /><span>Exports omit encrypted credentials and marketplace sessions. Backups include the encrypted database and should be stored with the deployment secret.</span></div>
        </section>
        <section
          className={`settings-section warning-section ${settings?.publicExposureWarning ? "warning-section--active" : ""}`}
        >
          <div className="settings-section-heading">
            <div className="settings-symbol settings-symbol--amber">
              <AlertTriangle size={18} />
            </div>
            <div>
              <h2>LAN/VPN access only</h2>
              <p>
                {!settingsLoaded
                  ? "Checking exposure configuration…"
                  : settings.publicExposureWarning
                    ? "Scout is listening beyond loopback. Authentication is required for API access."
                    : "Scout reports a loopback-only listening address."}
              </p>
            </div>
          </div>
          <div className="warning-copy">
            Keep Scout behind your trusted LAN or VPN. Scout has no built-in
            authentication, so do not expose it to the public internet.
          </div>
        </section>
      </div>
      <div className="settings-footer">
        <span>Changes are stored locally on this server.</span>
        <button
          className="primary-button"
          disabled={saving || !settings}
          onClick={save}
        >
          {saving ? (
            <LoaderCircle size={18} className="spin" />
          ) : (
            <Check size={18} />
          )}
          {saving ? "Saving…" : "Save settings"}
        </button>
      </div>
    </>
  );
}


