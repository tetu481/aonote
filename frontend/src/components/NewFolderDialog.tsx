import { useEffect, useMemo, useRef, useState } from "react";
import { flattenFolders } from "../folderUtils";
import type { FolderNode } from "../types";

type Props = {
  open: boolean;
  folders: FolderNode[];
  maxDepth: number;
  onClose: () => void;
  onCreate: (name: string, parentId: string | null) => Promise<void>;
};

export function NewFolderDialog({ open, folders, maxDepth, onClose, onCreate }: Props) {
  const [name, setName] = useState("");
  const [parentId, setParentId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const parents = useMemo(() => flattenFolders(folders).filter((folder) => folder.depth < maxDepth), [folders, maxDepth]);

  useEffect(() => {
    if (!open) return;
    setName("");
    setParentId(null);
    setError("");
    window.setTimeout(() => inputRef.current?.focus(), 20);
  }, [open]);

  if (!open) return null;
  return <div className="dialog-backdrop" onMouseDown={onClose}>
    <form className="new-note-dialog" onMouseDown={(event) => event.stopPropagation()} onSubmit={async (event) => {
      event.preventDefault(); setBusy(true); setError("");
      try { await onCreate(name, parentId); onClose(); }
      catch (reason) { setError(reason instanceof Error ? reason.message : "フォルダを作成できませんでした"); }
      finally { setBusy(false); }
    }}>
      <h2>新しいフォルダ</h2><p>最大{maxDepth}階層まで作成できます。</p>
      <label>フォルダ名<input ref={inputRef} value={name} onChange={(event) => setName(event.target.value)} placeholder="新しいフォルダ" required /></label>
      <label>作成先<select value={parentId ?? ""} onChange={(event) => setParentId(event.target.value || null)}><option value="">ワークスペース直下</option>{parents.map((folder) => <option key={folder.id} value={folder.id}>{folder.label}</option>)}</select></label>
      {error ? <div className="dialog-error">{error}</div> : null}
      <div className="dialog-actions"><button type="button" onClick={onClose}>キャンセル</button><button className="primary-button" disabled={busy || !name.trim()}>{busy ? "作成中…" : "作成"}</button></div>
    </form>
  </div>;
}
