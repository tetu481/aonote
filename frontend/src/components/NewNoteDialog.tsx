import { useEffect, useMemo, useRef, useState } from "react";
import { flattenFolders } from "../folderUtils";
import { uiText } from "../locales";
import type { FolderNode } from "../types";
import { DEFAULT_WELCOME_FOLDER_NAME } from "../workspaceDefaults";

export function NewNoteDialog({ open, folders, defaultFolderId, onClose, onCreate }: { open: boolean; folders: FolderNode[]; defaultFolderId: string | null; onClose: () => void; onCreate: (filename: string, folderId: string | null) => Promise<void> }) {
  const [name, setName] = useState("");
  const [folder, setFolder] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const wasOpenRef = useRef(false);
  const options = useMemo(() => flattenFolders(folders), [folders]);
  useEffect(() => {
    let focusTimer: number | undefined;
    if (open && !wasOpenRef.current) {
      const validDefault = defaultFolderId === null || options.some((item) => item.id === defaultFolderId);
      setName("");
      setError("");
      setFolder(validDefault ? defaultFolderId : options.find((item) => item.name === DEFAULT_WELCOME_FOLDER_NAME)?.id ?? options[0]?.id ?? null);
      focusTimer = window.setTimeout(() => inputRef.current?.focus(), 20);
    }
    wasOpenRef.current = open;
    return () => { if (focusTimer !== undefined) window.clearTimeout(focusTimer); };
  }, [open, defaultFolderId, options]);
  if (!open) return null;
  return <div className="dialog-backdrop" onMouseDown={onClose}><form className="new-note-dialog" onMouseDown={(event) => event.stopPropagation()} onSubmit={async (event) => { event.preventDefault(); setBusy(true); setError(""); try { await onCreate(name, folder); onClose(); } catch (reason) { setError(reason instanceof Error ? reason.message : uiText.dialogs.newNote.error); } finally { setBusy(false); } }}>
    <h2>{uiText.dialogs.newNote.title}</h2><p>{uiText.dialogs.newNote.description}</p>
    <label>{uiText.dialogs.newNote.filename}<input ref={inputRef} value={name} onChange={(event) => setName(event.target.value)} placeholder={uiText.dialogs.newNote.filenamePlaceholder} required /></label>
    <label>{uiText.dialogs.newNote.destination}<select value={folder ?? ""} onChange={(event) => setFolder(event.target.value || null)}><option value="">{uiText.common.unfiled}</option>{options.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
    {error ? <div className="dialog-error">{error}</div> : null}
    <div className="dialog-actions"><button type="button" onClick={onClose}>{uiText.common.cancel}</button><button className="primary-button" disabled={busy || !name.trim()}>{busy ? uiText.common.creating : uiText.common.create}</button></div>
  </form></div>;
}
