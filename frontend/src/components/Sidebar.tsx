import { ChevronDown, ChevronRight, Clock3, FileText, Folder, FolderOpen, Palette, Pencil, Search, Settings2, Trash2 } from "lucide-react";
import { memo, useEffect, useState } from "react";
import { folderContainsNote, flattenNotes } from "../folderUtils";
import { uiText } from "../locales";
import type { FolderNode, NoteSummary, TrashedNoteSummary } from "../types";
import { DEFAULT_WELCOME_FOLDER_NAME } from "../workspaceDefaults";

export type SidebarMode = "files" | "recent" | "trash" | "settings";

const deletedAtFormatter = new Intl.DateTimeFormat(uiText.meta.locale, {
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
  const [open, setOpen] = useState(folder.name === DEFAULT_WELCOME_FOLDER_NAME);
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
          <button onClick={() => onRename(folder)} aria-label={uiText.sidebar.renameFolder(folder.name)} title={uiText.sidebar.rename}><Pencil size={13} /></button>
          <button className="folder-delete" onClick={() => onDelete(folder)} aria-label={uiText.sidebar.deleteFolder(folder.name)} title={uiText.sidebar.delete}><Trash2 size={13} /></button>
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
      <nav className="activity-rail" aria-label={uiText.sidebar.navigationLabel}>
        <button className={mode === "files" ? "active" : ""} onClick={() => onMode("files")} aria-label={uiText.sidebar.files}><FileText size={20} /></button>
        <button onClick={onSearch} aria-label={uiText.sidebar.search}><Search size={20} /></button>
        <button className={mode === "recent" ? "active" : ""} onClick={() => onMode("recent")} aria-label={uiText.sidebar.recent}><Clock3 size={19} /></button>
        <button className={mode === "trash" ? "active" : ""} onClick={() => onMode("trash")} aria-label={uiText.sidebar.trash}><Trash2 size={19} /></button>
        <button className={`rail-bottom ${mode === "settings" ? "active" : ""}`} onClick={() => onMode("settings")} aria-label={uiText.sidebar.settings}><Settings2 size={19} /></button>
      </nav>
      <div className="sidebar-panel">
        <div className="sidebar-heading">
          <span>{uiText.sidebar.headings[mode]}</span>
        </div>
        {mode === "trash" ? <div className="trash-purge-controls">
          <label><input aria-label={uiText.sidebar.purgeDaysLabel} type="number" min="0" max="36500" step="1" value={trashDays} onChange={(event) => setTrashDays(event.target.value)} /><span>{uiText.sidebar.purgeDescription}</span></label>
          <button disabled={trashBusy || !validPurgeDays} onClick={() => onPurgeTrash(purgeDays)}>{trashBusy ? uiText.sidebar.purging : uiText.sidebar.purge}</button>
          {trashMessage ? <p role="status">{trashMessage}</p> : null}
        </div> : null}
        <div className="tree-scroll">
          {mode === "files" ? tree.map((folder) => (
            <FolderTree key={folder.id} folder={folder} selectedId={selectedId} selectedFolderId={selectedFolderId} revealKey={revealKey} onSelect={onSelect} onSelectFolder={onSelectFolder} onRename={onRenameFolder} onDelete={onDeleteFolder} />
          )) : mode === "recent" ? recent.map((note) => (
            <button key={note.id} className={`recent-row ${selectedId === note.id ? "selected" : ""}`} onClick={() => onSelect(note)}>
              <FileText size={16} /><span><strong>{note.title}</strong><small>{note.filename}</small></span>
            </button>
          )) : mode === "trash" && trash.length ? trash.map((item) => (
            <button key={item.id} className={`trash-row ${selectedTrashId === item.id ? "selected" : ""}`} onClick={() => onSelectTrash(item)}>
              <Trash2 size={16} /><span><strong>{item.filename}</strong><small title={item.deleted_path}>{item.deleted_path}</small><time>{deletedAtFormatter.format(new Date(item.deleted_at * 1000))}</time></span>
            </button>
          )) : mode === "trash" ? <div className="trash-empty"><Trash2 size={22} /><span>{uiText.sidebar.emptyTrash}</span></div> : <button className="settings-nav-row selected" onClick={() => onMode("settings")}><Palette size={17} /><span><strong>{uiText.sidebar.appearance}</strong><small>{uiText.sidebar.appearanceDescription}</small></span></button>}
        </div>
        <div className="sidebar-foot"><span>{mode === "trash" ? uiText.sidebar.trashCount(trash.length) : mode === "settings" ? uiText.sidebar.preferences : uiText.sidebar.noteCount(flattenNotes(tree).length)}</span><span>{mode === "settings" ? "aonote" : uiText.sidebar.database}</span></div>
      </div>
    </aside>
  );
}
