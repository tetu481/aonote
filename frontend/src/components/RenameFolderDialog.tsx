import { useEffect, useRef, useState } from "react";
import type { FolderNode } from "../types";

type Props = {
  folder: FolderNode | null;
  onClose: () => void;
  onSave: (name: string) => Promise<void>;
};

export function RenameFolderDialog({ folder, onClose, onSave }: Props) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!folder) return;
    setName(folder.name);
    setError("");
    window.setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 20);
  }, [folder]);

  if (!folder) return null;
  return <div className="dialog-backdrop" onMouseDown={onClose}>
    <form className="new-note-dialog" onMouseDown={(event) => event.stopPropagation()} onSubmit={async (event) => {
      event.preventDefault(); setBusy(true); setError("");
      try { await onSave(name); onClose(); }
      catch (reason) { setError(reason instanceof Error ? reason.message : "フォルダ名を変更できませんでした"); }
      finally { setBusy(false); }
    }}>
      <h2>フォルダ名を変更</h2><p>配下のフォルダとノートはそのまま維持されます。</p>
      <label>フォルダ名<input ref={inputRef} value={name} onChange={(event) => setName(event.target.value)} required /></label>
      {error ? <div className="dialog-error">{error}</div> : null}
      <div className="dialog-actions"><button type="button" onClick={onClose}>キャンセル</button><button className="primary-button" disabled={busy || !name.trim()}>{busy ? "変更中…" : "変更を保存"}</button></div>
    </form>
  </div>;
}
