import { useEffect, useMemo, useRef, useState } from "react";
import { flattenFolders } from "../folderUtils";
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
      catch (reason) { setError(reason instanceof Error ? reason.message : "ノートを変更できませんでした"); }
      finally { setBusy(false); }
    }}>
      <h2>名前と保存先</h2><p>ノートのファイル名を変更し、別のフォルダへ移動できます。</p>
      <label>ファイル名<input ref={inputRef} value={filename} onChange={(event) => setFilename(event.target.value)} required /></label>
      <label>保存先<select value={folderId ?? ""} onChange={(event) => setFolderId(event.target.value || null)}><option value="">未整理</option>{options.map((folder) => <option key={folder.id} value={folder.id}>{folder.label}</option>)}</select></label>
      {error ? <div className="dialog-error">{error}</div> : null}
      <div className="dialog-actions"><button type="button" onClick={onClose}>キャンセル</button><button className="primary-button" disabled={busy || !filename.trim()}>{busy ? "変更中…" : "変更を保存"}</button></div>
    </form>
  </div>;
}
