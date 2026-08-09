import { ChevronDown, ChevronRight, Clock3, FileText, Folder, FolderOpen, Pencil, Search, Settings2, Tag, Trash2 } from "lucide-react";
import { memo, useEffect, useState } from "react";
import { folderContainsNote, flattenNotes } from "../folderUtils";
import type { FolderNode, NoteSummary } from "../types";

type FolderProps = {
  folder: FolderNode;
  selectedId: string | null;
  onSelect: (note: NoteSummary) => void;
  onRename: (folder: FolderNode) => void;
  onDelete: (folder: FolderNode) => void;
  revealKey: number;
};

const FolderTree = memo(function FolderTree({ folder, selectedId, onSelect, onRename, onDelete, revealKey }: FolderProps) {
  const [open, setOpen] = useState(folder.name === "Projects" || folder.name === "Inbox");
  const containsSelection = folderContainsNote(folder, selectedId);
  useEffect(() => {
    if (containsSelection) setOpen(true);
  }, [containsSelection, revealKey]);
  return (
    <div className="folder-group">
      <div className="tree-row folder-row">
        <button className="folder-toggle" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
          {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
          {open ? <FolderOpen size={17} /> : <Folder size={17} />}
          <span>{folder.name}</span>
        </button>
        {folder.id !== "unfiled" ? <div className="folder-actions">
          <button onClick={() => onRename(folder)} aria-label={`「${folder.name}」の名前を変更`} title="名前を変更"><Pencil size={13} /></button>
          <button className="folder-delete" onClick={() => onDelete(folder)} aria-label={`「${folder.name}」を削除`} title="削除"><Trash2 size={13} /></button>
        </div> : null}
      </div>
      {open ? (
        <div className="tree-children">
          {folder.folders.map((child) => <FolderTree key={child.id} folder={child} selectedId={selectedId} revealKey={revealKey} onSelect={onSelect} onRename={onRename} onDelete={onDelete} />)}
          {folder.notes.map((note) => (
            <button
              key={note.id}
              className={`tree-row note-row ${note.id === selectedId ? "selected" : ""}`}
              onClick={() => onSelect(note)}
            >
              <FileText size={16} />
              <span>{note.filename}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
});

type Props = {
  tree: FolderNode[];
  recent: NoteSummary[];
  selectedId: string | null;
  revealKey: number;
  mode: "files" | "recent";
  mobileOpen: boolean;
  desktopOpen: boolean;
  onMode: (mode: "files" | "recent") => void;
  onSelect: (note: NoteSummary) => void;
  onSearch: () => void;
  onRenameFolder: (folder: FolderNode) => void;
  onDeleteFolder: (folder: FolderNode) => void;
};

export function Sidebar({ tree, recent, selectedId, revealKey, mode, mobileOpen, desktopOpen, onMode, onSelect, onSearch, onRenameFolder, onDeleteFolder }: Props) {
  return (
    <aside className={`sidebar-shell ${mobileOpen ? "mobile-open" : ""} ${desktopOpen ? "" : "desktop-collapsed"}`}>
      <nav className="activity-rail" aria-label="ワークスペースのナビゲーション">
        <button className={mode === "files" ? "active" : ""} onClick={() => onMode("files")} aria-label="ファイル"><FileText size={20} /></button>
        <button onClick={onSearch} aria-label="検索"><Search size={20} /></button>
        <button className={mode === "recent" ? "active" : ""} onClick={() => onMode("recent")} aria-label="最近のノート"><Clock3 size={19} /></button>
        <button aria-label="タグ" disabled><Tag size={19} /></button>
        <button className="rail-bottom" aria-label="設定" disabled><Settings2 size={19} /></button>
      </nav>
      <div className="sidebar-panel">
        <div className="sidebar-heading">
          <span>{mode === "files" ? "ワークスペース" : "最近のノート"}</span>
        </div>
        <div className="tree-scroll">
          {mode === "files" ? tree.map((folder) => (
            <FolderTree key={folder.id} folder={folder} selectedId={selectedId} revealKey={revealKey} onSelect={onSelect} onRename={onRenameFolder} onDelete={onDeleteFolder} />
          )) : recent.map((note) => (
            <button key={note.id} className={`recent-row ${selectedId === note.id ? "selected" : ""}`} onClick={() => onSelect(note)}>
              <FileText size={16} /><span><strong>{note.title}</strong><small>{note.filename}</small></span>
            </button>
          ))}
        </div>
        <div className="sidebar-foot"><span>{flattenNotes(tree).length} ノート</span><span>SQLite</span></div>
      </div>
    </aside>
  );
}
