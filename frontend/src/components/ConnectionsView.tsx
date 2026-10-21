import { useEffect, useRef, useState, type FormEvent } from "react";
import { ChevronDown, Pencil, Plug, RefreshCw, ShieldCheck, Unplug } from "lucide-react";
import { api, ApiError } from "../api";
import { useUiText } from "../LocaleContext";
import type { AIConnection, OAuthScope } from "../types";

const SCOPES: OAuthScope[] = ["notes:read", "notes:search", "notes:write"];
type ErrorKey = "load" | "save" | "disconnect" | "session" | "conflict";

function errorKey(error: unknown, fallback: ErrorKey): ErrorKey {
  if (error instanceof ApiError) {
    if (error.status === 401 || error.status === 403) return "session";
    if (error.status === 409 || error.status === 404) return "conflict";
  }
  return fallback;
}

function ConnectionEditor({ connection, onSave, onCancel }: {
  connection: AIConnection;
  onSave: (actorName: string, scopes: OAuthScope[]) => Promise<void>;
  onCancel: () => void;
}) {
  const ui = useUiText();
  const text = ui.connections;
  const [name, setName] = useState(connection.actor_name);
  const [scopes, setScopes] = useState<OAuthScope[]>(connection.scopes);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorKey | null>(null);
  const validName = name.trim().length > 0 && [...name.trim()].length <= 80 && !/[\x00-\x1f\x7f]/.test(name);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || !validName || !scopes.length) return;
    setBusy(true); setError(null);
    try { await onSave(name.trim(), scopes); }
    catch (reason) { setError(errorKey(reason, "save")); }
    finally { setBusy(false); }
  }

  return <form className="connection-editor" onSubmit={submit} aria-label={text.edit}>
    <label className="connection-name-label">{text.displayName}
      <input value={name} maxLength={80} required autoFocus disabled={busy} onChange={(event) => setName(event.target.value)} aria-describedby={`name-hint-${connection.id}`} />
    </label>
    <p id={`name-hint-${connection.id}`} className="connection-hint">{text.nameHint}</p>
    <fieldset disabled={busy}>
      <legend>{text.permissions}</legend>
      <div className="connection-scope-options">{SCOPES.map((scope) => <label key={scope}>
        <input type="checkbox" checked={scopes.includes(scope)} disabled={!connection.approved_scopes.includes(scope)} onChange={(event) => {
          const checked = event.target.checked;
          setScopes((current) => checked ? [...current, scope] : current.filter((item) => item !== scope));
        }} />
        <span>{text.scopes[scope]}<code>{scope}</code></span>
      </label>)}</div>
    </fieldset>
    <p className="connection-hint">{text.scopeHint}</p>
    {!validName ? <p role="alert" className="connection-error">{text.invalidName}</p> : !scopes.length ? <p role="alert" className="connection-error">{text.selectScope}</p> : null}
    {error ? <p role="alert" className="connection-error">{text.errors[error]}</p> : null}
    <div className="connection-actions">
      <button type="button" className="secondary-button" disabled={busy} onClick={onCancel}>{ui.common.cancel}</button>
      <button type="submit" className="primary-button" disabled={busy || !validName || !scopes.length}>{busy ? text.saving : ui.common.saveChanges}</button>
    </div>
  </form>;
}

export function ConnectionsView() {
  const ui = useUiText();
  const text = ui.connections;
  const [items, setItems] = useState<AIConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<ErrorKey | null>(null);
  const [message, setMessage] = useState<"saved" | "disconnected" | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState<string | null>(null);
  const sequence = useRef(0);
  const dateFormat = new Intl.DateTimeFormat(ui.meta.locale, { dateStyle: "medium", timeStyle: "short" });
  const date = (stamp: number | null) => stamp === null ? text.unknown : dateFormat.format(new Date(stamp * 1000));

  async function load(signal?: AbortSignal) {
    const requestId = ++sequence.current;
    setLoading(true); setError(null);
    try {
      const connections = await api.connections(signal);
      if (requestId !== sequence.current || signal?.aborted) return;
      setItems(connections); setLoaded(true);
    } catch (reason) {
      if (requestId === sequence.current && !signal?.aborted) setError(errorKey(reason, "load"));
    } finally {
      if (requestId === sequence.current && !signal?.aborted) setLoading(false);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => { controller.abort(); sequence.current++; };
  }, []);

  async function save(item: AIConnection, actor_name: string, scopes: OAuthScope[]) {
    const updated = await api.updateConnection(item.id, { actor_name, scopes, version: item.version });
    sequence.current++;
    setItems((current) => current.map((row) => row.id === item.id ? updated : row));
    setEditing(null); setError(null); setMessage("saved");
  }

  async function disconnect(item: AIConnection) {
    if (!window.confirm(text.confirmation(item.actor_name, item.client_name))) return;
    setDisconnecting(item.id); setError(null); setMessage(null);
    try {
      await api.disconnect(item.id);
      // Update the confirmed state locally; a failed list refresh must never
      // make a successful disconnect look as though it failed.
      sequence.current++;
      setItems((current) => current.map((row) => row.id === item.id ? { ...row, status: "revoked", revoked_at: Math.floor(Date.now() / 1000), expires_at: null } : row));
      setMessage("disconnected");
    } catch (reason) { setError(errorKey(reason, "disconnect")); }
    finally { setDisconnecting(null); }
  }

  return <section className="connections-panel" aria-labelledby="connections-heading" aria-busy={loading}>
    <div className="connections-heading">
      <div><h2 id="connections-heading"><ShieldCheck size={21} />{text.title}</h2><p>{text.description}</p></div>
      <button className="secondary-button" disabled={loading || editing !== null || disconnecting !== null} onClick={() => { setMessage(null); void load(); }}><RefreshCw size={15} /><span>{text.refresh}</span></button>
    </div>
    <p className="connection-hint">{text.activityHint}</p>
    {loaded ? <p className="connection-count">{text.count(items.length)}</p> : null}
    {loading ? <p role="status">{text.loading}</p> : null}
    {error ? <p role="alert" className="connection-error">{text.errors[error]}</p> : null}
    {message ? <p role="status" className="connection-success">{text[message]}</p> : null}
    {loaded && !items.length ? <div className="connections-empty"><Plug size={30} /><h3>{text.empty}</h3><p>{text.emptyHint}</p></div> : null}
    <div className="connection-list">{items.map((item) => <article className={`connection-card ${item.status}`} key={item.id} aria-label={`${item.actor_name} (${item.client_name})`}>
      <div className="connection-card-heading">
        <span className="connection-icon"><Plug size={21} /></span>
        <div className="connection-identity"><h3>{item.actor_name}</h3><p><span>{text.appName}: </span>{item.client_name}</p></div>
        <span className={`connection-status ${item.status}`}>{text.status[item.status]}</span>
      </div>
      <div className="connection-scopes" aria-label={text.permissions}>{item.scopes.map((scope) => <span key={scope}>{text.scopes[scope]}</span>)}</div>
      <dl className="connection-dates"><div><dt>{text.connectedAt}</dt><dd>{date(item.created_at)}</dd></div><div><dt>{text.lastUsed}</dt><dd>{date(item.last_used_at)}</dd></div></dl>
      {item.legacy ? <p className="connection-legacy"><strong>{text.legacy}</strong>{text.legacyHint}</p> : null}
      {item.status === "expired" ? <p className="connection-hint">{text.expiredHint}</p> : null}
      <details className="connection-details"><summary>{text.details}<ChevronDown size={14} /></summary>
        <dl>
          <div><dt>{text.clientId}</dt><dd><code>{item.client_id}</code></dd></div>
          <div><dt>{text.connectionId}</dt><dd><code>{item.id}</code></dd></div>
          <div><dt>{text.resource}</dt><dd><code>{item.resource}</code></dd></div>
          <div><dt>{text.redirects}</dt><dd>{item.redirect_uris.map((uri, index) => <code key={index}>{uri}</code>)}</dd></div>
          {item.status === "revoked" ? <div><dt>{text.revokedAt}</dt><dd>{date(item.revoked_at)}</dd></div> : <div><dt>{text.expiresAt}</dt><dd>{date(item.expires_at)}</dd></div>}
        </dl>
      </details>
      {editing === item.id ? <ConnectionEditor key={item.version} connection={item} onSave={(name, scopes) => save(item, name, scopes)} onCancel={() => setEditing(null)} /> : item.status !== "revoked" ? <div className="connection-actions">
        <button className="secondary-button" disabled={loading || editing !== null || disconnecting !== null} onClick={() => { setEditing(item.id); setMessage(null); }}><Pencil size={14} />{text.edit}</button>
        <button className="secondary-button connection-disconnect" disabled={loading || editing !== null || disconnecting !== null} onClick={() => void disconnect(item)}><Unplug size={14} />{disconnecting === item.id ? text.disconnecting : text.disconnect}</button>
      </div> : null}
    </article>)}</div>
  </section>;
}
