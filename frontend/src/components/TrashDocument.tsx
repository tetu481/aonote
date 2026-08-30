import { ListTree, RotateCcw } from "lucide-react";
import { uiText } from "../locales";
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
      <div className="breadcrumb"><span>{uiText.trashDocument.breadcrumb}<b>/</b></span><strong title={note.deleted_path}>{note.deleted_path}</strong></div>
      <span className="readonly-state">{uiText.trashDocument.readOnly}</span>
      <button className="secondary-button restore-note-button" onClick={onRestore} disabled={restoreBusy} aria-label={restoreBusy ? uiText.trashDocument.restoring : uiText.trashDocument.restore}><RotateCcw size={16} /><span>{restoreBusy ? uiText.trashDocument.restoringProgress : uiText.trashDocument.restore}</span></button>
      <button className={`icon-button outline-toggle ${outlineExpanded ? "active" : ""}`} onClick={onToggleOutline} aria-label={outlineExpanded ? uiText.app.toolbar.closeOutline : uiText.app.toolbar.showOutline} aria-expanded={outlineExpanded} aria-controls="note-outline" title={uiText.app.toolbar.outline}><ListTree size={18} /></button>
    </header>
    {restoreError ? <div className="trash-error" role="alert">{restoreError}</div> : null}
    <div className={`document-workarea view-preview ${outlineVisible ? "" : "outline-hidden"}`} id="preview">
      <PreviewPane content={note.content} links={[]} onWikilink={() => undefined} />
      {outlineDrawerOpen ? <button className="outline-scrim" aria-label={uiText.app.toolbar.closeOutlineOutside} onClick={onCloseOutline} /> : null}
      <Outline note={note} drawerOpen={outlineDrawerOpen} desktopVisible={outlineVisible} onClose={onCloseOutline} onBacklink={() => undefined} />
    </div>
    <footer className="statusbar"><span className="trash-status"><TrashStatusDot />{uiText.trashDocument.previewStatus}</span><span className="status-spacer" /><span>{uiText.common.markdown}</span><b /><span>{uiText.trashDocument.readOnly}</span></footer>
  </>;
}

function TrashStatusDot() {
  return <i aria-hidden="true" />;
}
