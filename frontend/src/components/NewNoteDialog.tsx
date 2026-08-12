import { useEffect, useMemo, useRef, useState } from "react";
import { flattenFolders } from "../folderUtils";
import type { FolderNode } from "../types";

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
      setFolder(validDefault ? defaultFolderId : options.find((item) => item.name === "ようこそ")?.id ?? options[0]?.id ?? null);
      focusTimer = window.setTimeout(() => inputRef.current?.focus(), 20);
    }
    wasOpenRef.current = open;
    return () => { if (focusTimer !== undefined) window.clearTimeout(focusTimer); };
  }, [open, defaultFolderId, options]);
  if (!open) return null;
  return <div className="dialog-backdrop" onMouseDown={onClose}><form className="new-note-dialog" onMouseDown={(event) => event.stopPropagation()} onSubmit={async (event) => { event.preventDefault(); setBusy(true); setError(""); try { await onCreate(name, folder); onClose(); } catch (reason) { setError(reason instanceof Error ? reason.message : "ノートを作成できませんでした"); } finally { setBusy(false); } }}>
    <h2>新しいノート</h2><p>Markdownファイルをワークスペースに追加します。</p>
    <label>ファイル名<input ref={inputRef} value={name} onChange={(event) => setName(event.target.value)} placeholder="新しいノート.md" required /></label>
    <label>保存先<select value={folder ?? ""} onChange={(event) => setFolder(event.target.value || null)}><option value="">未整理</option>{options.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
    {error ? <div className="dialog-error">{error}</div> : null}
    <div className="dialog-actions"><button type="button" onClick={onClose}>キャンセル</button><button className="primary-button" disabled={busy || !name.trim()}>{busy ? "作成中…" : "作成"}</button></div>
  </form></div>;
}
