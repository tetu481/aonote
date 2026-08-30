import { useEffect, useMemo, useRef, useState } from "react";
import { flattenFolders } from "../folderUtils";
import { uiText } from "../locales";
import type { FolderNode, Note } from "../types";

type Props = {
  open: boolean;
  note: Note | null;
  folders: FolderNode[];
  onClose: () => void;
  onSave: (filename: string, folderId: string | null) => Promise<void>;
};

export function OrganizeNoteDialog({ open, note, folders, onClose, onSave }: Props) {
  const [filename, setFilename] = useState("");
  const [folderId, setFolderId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const options = useMemo(() => flattenFolders(folders), [folders]);

  useEffect(() => {
    if (!open || !note) return;
    setFilename(note.filename); setFolderId(note.folder_id); setError("");
    window.setTimeout(() => inputRef.current?.focus(), 20);
  }, [open, note?.id]);

  if (!open || !note) return null;
  return <div className="dialog-backdrop" onMouseDown={onClose}>
    <form className="new-note-dialog" onMouseDown={(event) => event.stopPropagation()} onSubmit={async (event) => {
      event.preventDefault(); setBusy(true); setError("");
      try { await onSave(filename, folderId); onClose(); }
      catch (reason) { setError(reason instanceof Error ? reason.message : uiText.dialogs.organizeNote.error); }
      finally { setBusy(false); }
    }}>
      <h2>{uiText.dialogs.organizeNote.title}</h2><p>{uiText.dialogs.organizeNote.description}</p>
      <label>{uiText.dialogs.organizeNote.filename}<input ref={inputRef} value={filename} onChange={(event) => setFilename(event.target.value)} required /></label>
      <label>{uiText.dialogs.organizeNote.destination}<select value={folderId ?? ""} onChange={(event) => setFolderId(event.target.value || null)}><option value="">{uiText.common.unfiled}</option>{options.map((folder) => <option key={folder.id} value={folder.id}>{folder.label}</option>)}</select></label>
      {error ? <div className="dialog-error">{error}</div> : null}
      <div className="dialog-actions"><button type="button" onClick={onClose}>{uiText.common.cancel}</button><button className="primary-button" disabled={busy || !filename.trim()}>{busy ? uiText.common.changing : uiText.common.saveChanges}</button></div>
    </form>
  </div>;
}
