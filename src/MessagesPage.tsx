import { useEffect, useState } from "react";
import { AlertTriangle, ArrowRight, ExternalLink, LoaderCircle, MessageSquare, ShieldCheck } from "lucide-react";
import { api } from "./api";
import type { SellerMessage } from "./types";

const formatPln = (value: number | null) =>
  value === null ? "Learning" : `${value.toLocaleString("pl-PL")} zł`;

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

export default function MessagesPage({ refreshKey }: { refreshKey: number }) {
  const [messages, setMessages] = useState<SellerMessage[]>([]);
  const [pagination, setPagination] = useState<{ page: number; pageSize: number; total: number; hasNext: boolean } | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    api.messages()
      .then((result) => {
        if (!active) return;
        setMessages(result.messages);
        setPagination(result.pagination);
        setSelectedId((current) => current && result.messages.some((message) => message.id === current) ? current : result.messages[0]?.id ?? null);
        setError(null);
      })
      .catch((loadError) => {
        if (active) setError(errorMessage(loadError));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [refreshKey]);

  const selected = messages.find((message) => message.id === selectedId) ?? null;
  const sentCount = pagination?.total ?? messages.filter((message) => message.status === "sent").length;
  return (
    <>
      <PageHeader
        title="Messages"
        description="Review the seller messages Scout has sent from your account."
      />
      <div className="messages-explainer">
        <div className="messages-explainer-icon" aria-hidden="true">
          <MessageSquare size={22} />
        </div>
        <div>
          <strong>AI-assisted marketplace messaging is ready.</strong>
          <span>
            OpenRouter asks the configured DeepSeek model for one concise Polish
            negotiation message, then Scout sends it through your authenticated OLX
            or Allegro Lokalnie session. Automatic sends are opt-in and bounded in
            Settings.
          </span>
        </div>
        <span className="messages-status">OLX + Allegro Lokalnie</span>
      </div>
      <section className="messages-layout" aria-label="Seller messages">
        <div className="messages-panel messages-inbox">
          <div className="messages-panel-heading">
            <div>
              <span className="messages-kicker">Outbound</span>
              <h2>Sent messages</h2>
            </div>
            <span className="messages-count">{sentCount}</span>
          </div>
          <div className="messages-filter-row" aria-label="Conversation filters">
            <span className="messages-filter messages-filter--active">All</span>
            <span className="messages-filter">OLX · Allegro Lokalnie</span>
          </div>
          {loading ? <div className="messages-empty"><LoaderCircle size={22} className="spin" /><span>Loading message history…</span></div> : error ? <div className="messages-empty"><AlertTriangle size={22} /><strong>Could not load messages</strong><span>{error}</span></div> : messages.length ? <><div className="messages-thread-list">{messages.map((message) => <button key={message.id} className={`messages-thread ${selectedId === message.id ? "messages-thread--active" : ""}`} type="button" onClick={() => setSelectedId(message.id)}><i className={`messages-thread-dot messages-thread-dot--${message.status}`} /><div><strong>{message.listingTitle}</strong><span>{message.marketplace} · {message.source === "automatic" ? "Automatic · " : "Manual · "}{new Date(message.createdAt).toLocaleString("pl-PL", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}</span><small>{message.message}</small></div><b>{message.status === "sent" ? "Sent" : "Failed"}</b></button>)}</div>{pagination?.hasNext ? <button className="link-button messages-load-more" disabled={loadingOlder} onClick={async () => { setLoadingOlder(true); try { const result = await api.messages({ page: (pagination.page ?? 1) + 1 }); setMessages((current) => [...current, ...result.messages]); setPagination(result.pagination); } catch (loadError) { setError(errorMessage(loadError)); } finally { setLoadingOlder(false); } }}>{loadingOlder ? <LoaderCircle size={15} className="spin" /> : <ArrowRight size={15} />}{loadingOlder ? "Loading…" : "Load older messages"}</button> : null}</> : <div className="messages-empty"><div className="messages-empty-icon" aria-hidden="true"><MessageSquare size={24} /></div><strong>No messages yet</strong><span>Open a saved OLX or Allegro Lokalnie listing or enable automatic negotiation in Settings to start a seller conversation.</span></div>}
        </div>
        <aside className="messages-panel messages-detail">
          {selected ? <><div className="messages-panel-heading"><div><span className="messages-kicker">Message detail</span><h2>{selected.listingTitle}</h2></div><MessageSquare size={18} aria-hidden="true" /></div><div className="messages-detail-body"><div className="messages-detail-meta"><span>{selected.marketplace} · {selected.source === "automatic" ? "Automatic" : "Manual"} · {new Date(selected.createdAt).toLocaleString("pl-PL", { dateStyle: "medium", timeStyle: "short" })}</span><strong className={`messages-delivery messages-delivery--${selected.status}`}>{selected.status === "sent" ? "Sent" : "Failed"}</strong></div><div className="messages-bubble"><span>You</span><p>{selected.message}</p></div>{selected.offerPrice !== null ? <div className="messages-offer"><span>Opening offer</span><strong>{formatPln(selected.offerPrice)}</strong></div> : null}{selected.error ? <div className="messages-error"><AlertTriangle size={15} />{selected.error}</div> : null}<a className="outline-button messages-listing-link" href={selected.listingUrl} target="_blank" rel="noreferrer"><ExternalLink size={15} />Open {selected.marketplace} listing</a></div></> : <><div className="messages-panel-heading"><div><span className="messages-kicker">Message detail</span><h2>Nothing selected</h2></div><MessageSquare size={18} aria-hidden="true" /></div><div className="messages-detail-empty"><MessageSquare size={28} aria-hidden="true" /><strong>Select a sent message to review it</strong><span>Replies are not imported yet. Continue the conversation on the marketplace.</span></div></>}
        </aside>
      </section>
      <div className="soft-note messages-note">
        <ShieldCheck size={17} />
        <span>
          Scout sends at most one automatic attempt per listing; manual
          messages still require an explicit confirmation. Seller replies
          remain in OLX for now.
        </span>
      </div>
    </>
  );
}
