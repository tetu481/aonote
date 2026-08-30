import { useEffect, useMemo, useRef, useState } from "react";
import { flattenFolders } from "../folderUtils";
import { uiText } from "../locales";
import type { FolderNode } from "../types";

type Props = {
  open: boolean;
  folders: FolderNode[];
  maxDepth: number;
  defaultParentId: string | null;
  onClose: () => void;
  onCreate: (name: string, parentId: string | null) => Promise<void>;
};

export function NewFolderDialog({ open, folders, maxDepth, defaultParentId, onClose, onCreate }: Props) {
  const [name, setName] = useState("");
  const [parentId, setParentId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const wasOpenRef = useRef(false);
  const parents = useMemo(() => flattenFolders(folders).filter((folder) => folder.depth < maxDepth), [folders, maxDepth]);

  useEffect(() => {
    let focusTimer: number | undefined;
    if (open && !wasOpenRef.current) {
      setName("");
      setParentId(parents.some((folder) => folder.id === defaultParentId) ? defaultParentId : null);
      setError("");
      focusTimer = window.setTimeout(() => inputRef.current?.focus(), 20);
    }
    wasOpenRef.current = open;
    return () => { if (focusTimer !== undefined) window.clearTimeout(focusTimer); };
  }, [open, defaultParentId, parents]);

  if (!open) return null;
  return <div className="dialog-backdrop" onMouseDown={onClose}>
    <form className="new-note-dialog" onMouseDown={(event) => event.stopPropagation()} onSubmit={async (event) => {
      event.preventDefault(); setBusy(true); setError("");
      try { await onCreate(name, parentId); onClose(); }
      catch (reason) { setError(reason instanceof Error ? reason.message : uiText.dialogs.newFolder.error); }
      finally { setBusy(false); }
    }}>
      <h2>{uiText.dialogs.newFolder.title}</h2><p>{uiText.dialogs.newFolder.description(maxDepth)}</p>
      <label>{uiText.dialogs.newFolder.name}<input ref={inputRef} value={name} onChange={(event) => setName(event.target.value)} placeholder={uiText.dialogs.newFolder.namePlaceholder} required /></label>
      <label>{uiText.dialogs.newFolder.destination}<select value={parentId ?? ""} onChange={(event) => setParentId(event.target.value || null)}><option value="">{uiText.dialogs.newFolder.workspaceRoot}</option>{parents.map((folder) => <option key={folder.id} value={folder.id}>{folder.label}</option>)}</select></label>
      {error ? <div className="dialog-error">{error}</div> : null}
      <div className="dialog-actions"><button type="button" onClick={onClose}>{uiText.common.cancel}</button><button className="primary-button" disabled={busy || !name.trim()}>{busy ? uiText.common.creating : uiText.common.create}</button></div>
    </form>
  </div>;
}
