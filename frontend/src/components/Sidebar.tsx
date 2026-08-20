import { ChevronDown, ChevronRight, Clock3, FileText, Folder, FolderOpen, Pencil, Search, Settings2, Trash2 } from "lucide-react";
import { memo, useEffect, useState } from "react";
import { folderContainsNote, flattenNotes } from "../folderUtils";
import type { FolderNode, NoteSummary, TrashedNoteSummary } from "../types";

export type SidebarMode = "files" | "recent" | "trash";

const deletedAtFormatter = new Intl.DateTimeFormat("ja-JP", {
  dateStyle: "short",
  timeStyle: "short",
});

type FolderProps = {
  folder: FolderNode;
  selectedId: string | null;
  selectedFolderId: string | null;
  onSelect: (note: NoteSummary) => void;
  onSelectFolder: (folderId: string) => void;
  onRename: (folder: FolderNode) => void;
  onDelete: (folder: FolderNode) => void;
  revealKey: number;
};

const FolderTree = memo(function FolderTree({ folder, selectedId, selectedFolderId, onSelect, onSelectFolder, onRename, onDelete, revealKey }: FolderProps) {
  const [open, setOpen] = useState(folder.name === "ようこそ");
  const containsSelection = folderContainsNote(folder, selectedId);
  useEffect(() => {
    if (containsSelection) setOpen(true);
  }, [containsSelection, revealKey]);
  return (
    <div className="folder-group">
      <div className={`tree-row folder-row ${folder.id === selectedFolderId ? "selected" : ""}`}>
        <button className="folder-toggle" onClick={() => { onSelectFolder(folder.id); setOpen((value) => !value); }} aria-expanded={open}>
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
          {folder.folders.map((child) => <FolderTree key={child.id} folder={child} selectedId={selectedId} selectedFolderId={selectedFolderId} revealKey={revealKey} onSelect={onSelect} onSelectFolder={onSelectFolder} onRename={onRename} onDelete={onDelete} />)}
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
  trash: TrashedNoteSummary[];
  selectedId: string | null;
  selectedTrashId: string | null;
  selectedFolderId: string | null;
  revealKey: number;
  mode: SidebarMode;
  mobileOpen: boolean;
  desktopOpen: boolean;
  onMode: (mode: SidebarMode) => void;
  onSelect: (note: NoteSummary) => void;
  onSelectTrash: (note: TrashedNoteSummary) => void;
  onSelectFolder: (folderId: string) => void;
  onSearch: () => void;
  onRenameFolder: (folder: FolderNode) => void;
  onDeleteFolder: (folder: FolderNode) => void;
  onPurgeTrash: (days: number) => void;
  trashBusy: boolean;
  trashMessage: string;
};

export function Sidebar({ tree, recent, trash, selectedId, selectedTrashId, selectedFolderId, revealKey, mode, mobileOpen, desktopOpen, onMode, onSelect, onSelectTrash, onSelectFolder, onSearch, onRenameFolder, onDeleteFolder, onPurgeTrash, trashBusy, trashMessage }: Props) {
  const [trashDays, setTrashDays] = useState("30");
  const purgeDays = Number(trashDays);
  const validPurgeDays = Number.isInteger(purgeDays) && purgeDays >= 0 && purgeDays <= 36500;
  return (
    <aside className={`sidebar-shell ${mobileOpen ? "mobile-open" : ""} ${desktopOpen ? "" : "desktop-collapsed"}`}>
      <nav className="activity-rail" aria-label="ワークスペースのナビゲーション">
        <button className={mode === "files" ? "active" : ""} onClick={() => onMode("files")} aria-label="ファイル"><FileText size={20} /></button>
        <button onClick={onSearch} aria-label="検索"><Search size={20} /></button>
        <button className={mode === "recent" ? "active" : ""} onClick={() => onMode("recent")} aria-label="最近のノート"><Clock3 size={19} /></button>
        <button className={mode === "trash" ? "active" : ""} onClick={() => onMode("trash")} aria-label="ゴミ箱"><Trash2 size={19} /></button>
        <button className="rail-bottom" aria-label="設定" disabled><Settings2 size={19} /></button>
      </nav>
      <div className="sidebar-panel">
        <div className="sidebar-heading">
          <span>{mode === "files" ? "ワークスペース" : mode === "recent" ? "最近のノート" : "ゴミ箱"}</span>
        </div>
        {mode === "trash" ? <div className="trash-purge-controls">
          <label><input aria-label="完全削除する経過日数" type="number" min="0" max="36500" step="1" value={trashDays} onChange={(event) => setTrashDays(event.target.value)} /><span>日以上前に削除したノート</span></label>
          <button disabled={trashBusy || !validPurgeDays} onClick={() => onPurgeTrash(purgeDays)}>{trashBusy ? "削除中…" : "完全削除"}</button>
          {trashMessage ? <p role="status">{trashMessage}</p> : null}
        </div> : null}
        <div className="tree-scroll">
          {mode === "files" ? tree.map((folder) => (
            <FolderTree key={folder.id} folder={folder} selectedId={selectedId} selectedFolderId={selectedFolderId} revealKey={revealKey} onSelect={onSelect} onSelectFolder={onSelectFolder} onRename={onRenameFolder} onDelete={onDeleteFolder} />
          )) : mode === "recent" ? recent.map((note) => (
            <button key={note.id} className={`recent-row ${selectedId === note.id ? "selected" : ""}`} onClick={() => onSelect(note)}>
              <FileText size={16} /><span><strong>{note.title}</strong><small>{note.filename}</small></span>
            </button>
          )) : trash.length ? trash.map((item) => (
            <button key={item.id} className={`trash-row ${selectedTrashId === item.id ? "selected" : ""}`} onClick={() => onSelectTrash(item)}>
              <Trash2 size={16} /><span><strong>{item.filename}</strong><small title={item.deleted_path}>{item.deleted_path}</small><time>{deletedAtFormatter.format(new Date(item.deleted_at * 1000))}</time></span>
            </button>
          )) : <div className="trash-empty"><Trash2 size={22} /><span>ゴミ箱は空です</span></div>}
        </div>
        <div className="sidebar-foot"><span>{mode === "trash" ? `${trash.length} 件` : `${flattenNotes(tree).length} ノート`}</span><span>SQLite</span></div>
      </div>
    </aside>
  );
}
