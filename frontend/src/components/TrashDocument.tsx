import { ListTree, RotateCcw } from "lucide-react";
import type { TrashedNote } from "../types";
import { Outline } from "./Outline";
import { PreviewPane } from "./PreviewPane";

type Props = {
  note: TrashedNote;
  compactOutline: boolean;
  outlineDrawerOpen: boolean;
  outlineVisible: boolean;
  restoreBusy: boolean;
  restoreError: string;
  onToggleOutline: () => void;
  onCloseOutline: () => void;
  onRestore: () => void;
};

export function TrashDocument({ note, compactOutline, outlineDrawerOpen, outlineVisible, restoreBusy, restoreError, onToggleOutline, onCloseOutline, onRestore }: Props) {
  const outlineExpanded = compactOutline ? outlineDrawerOpen : outlineVisible;

  return <>
    <header className="document-bar trash-document-bar">
      <div className="breadcrumb"><span>ゴミ箱<b>/</b></span><strong title={note.deleted_path}>{note.deleted_path}</strong></div>
      <span className="readonly-state">読み取り専用</span>
      <button className="secondary-button restore-note-button" onClick={onRestore} disabled={restoreBusy} aria-label={restoreBusy ? "復元中" : "元に戻す"}><RotateCcw size={16} /><span>{restoreBusy ? "復元中…" : "元に戻す"}</span></button>
      <button className={`icon-button outline-toggle ${outlineExpanded ? "active" : ""}`} onClick={onToggleOutline} aria-label={outlineExpanded ? "目次を閉じる" : "目次を表示"} aria-expanded={outlineExpanded} aria-controls="note-outline" title="目次"><ListTree size={18} /></button>
    </header>
    {restoreError ? <div className="trash-error" role="alert">{restoreError}</div> : null}
    <div className={`document-workarea view-preview ${outlineVisible ? "" : "outline-hidden"}`} id="preview">
      <PreviewPane content={note.content} links={[]} onWikilink={() => undefined} />
      {outlineDrawerOpen ? <button className="outline-scrim" aria-label="目次の外側を閉じる" onClick={onCloseOutline} /> : null}
      <Outline note={note} drawerOpen={outlineDrawerOpen} desktopVisible={outlineVisible} onClose={onCloseOutline} onBacklink={() => undefined} />
    </div>
    <footer className="statusbar"><span className="trash-status"><TrashStatusDot />ゴミ箱のプレビュー</span><span className="status-spacer" /><span>Markdown</span><b /><span>読み取り専用</span></footer>
  </>;
}

function TrashStatusDot() {
  return <i aria-hidden="true" />;
}
