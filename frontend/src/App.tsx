import { Check, Columns2, Copy, Eye, FilePenLine, ListTree, PanelLeftClose, PencilLine, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, api } from "./api";
import { EditorPane } from "./components/EditorPane";
import { LoginView } from "./components/LoginView";
import { NewNoteDialog } from "./components/NewNoteDialog";
import { NewFolderDialog } from "./components/NewFolderDialog";
import { OrganizeNoteDialog } from "./components/OrganizeNoteDialog";
import { Outline } from "./components/Outline";
import { PreviewPane } from "./components/PreviewPane";
import { RenameFolderDialog } from "./components/RenameFolderDialog";
import { SearchDialog } from "./components/SearchDialog";
import { Sidebar } from "./components/Sidebar";
import { TopBar } from "./components/TopBar";
import { useAutosave } from "./hooks/useAutosave";
import { flattenNotes } from "./folderUtils";
import type { AppStatus, FolderNode, Note, NoteSummary, SaveState } from "./types";
import "./styles.css";

type ViewMode = "edit" | "split" | "preview";

const saveLabels: Record<SaveState, string> = {
  idle: "",
  dirty: "未保存",
  saving: "保存中…",
  saved: "保存済み",
  conflict: "更新の競合",
  error: "保存エラー",
};

export default function App() {
  const [tree, setTree] = useState<FolderNode[]>([]);
  const [recent, setRecent] = useState<NoteSummary[]>([]);
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [note, setNote] = useState<Note | null>(null);
  const [content, setContent] = useState("");
  const [view, setView] = useState<ViewMode>("preview");
  const [sidebarMode, setSidebarMode] = useState<"files" | "recent">("files");
  const [mobileSidebar, setMobileSidebar] = useState(false);
  const [desktopSidebar, setDesktopSidebar] = useState(true);
  const [searchOpen, setSearchOpen] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [folderToRename, setFolderToRename] = useState<FolderNode | null>(null);
  const [organizeOpen, setOrganizeOpen] = useState(false);
  const [reloadBusy, setReloadBusy] = useState(false);
  const [pathCopied, setPathCopied] = useState(false);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [revealTree, setRevealTree] = useState(0);
  const [authRequired, setAuthRequired] = useState(false);
  const [loading, setLoading] = useState(true);
  const copyResetTimer = useRef<number | null>(null);

  const refreshNavigation = useCallback(async () => {
    const [nextTree, nextRecent] = await Promise.all([api.tree(), api.recent()]);
    setTree(nextTree);
    setRecent(nextRecent);
    return nextTree;
  }, []);

  const selectById = useCallback(async (id: string) => {
    const selected = await api.note(id);
    setNote(selected);
    setContent(selected.content);
    setSidebarMode("files");
    setDesktopSidebar(true);
    setRevealTree((value) => value + 1);
    setMobileSidebar(false);
    setOutlineOpen(false);
  }, []);

  const loadApp = useCallback(async () => {
    setLoading(true);
    try {
      const [nextStatus, nextTree, nextRecent] = await Promise.all([api.status(), api.tree(), api.recent()]);
      setStatus(nextStatus); setTree(nextTree); setRecent(nextRecent); setAuthRequired(false);
      const notes = flattenNotes(nextTree);
      const preferred = notes.find((item) => item.filename === "MCP連携.md") ?? notes[0];
      if (preferred) await selectById(preferred.id);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) setAuthRequired(true);
    } finally { setLoading(false); }
  }, [selectById]);

  useEffect(() => { void loadApp(); }, [loadApp]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); setSearchOpen(true); }
      if (event.key === "Escape") { setSearchOpen(false); setNewOpen(false); setNewFolderOpen(false); setFolderToRename(null); setOrganizeOpen(false); setOutlineOpen(false); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const onSaved = useCallback((updated: Note) => {
    setNote(updated);
    void refreshNavigation();
  }, [refreshNavigation]);
  const { state: saveState, reset: resetAutosave } = useAutosave(note, content, onSaved);

  const cursor = useMemo(() => {
    const lines = content.split("\n");
    return { line: lines.length, column: (lines[lines.length - 1]?.length ?? 0) + 1 };
  }, [content]);
  const notePath = useMemo(() => note ? [...note.folder_path.map((folder) => folder.name), note.filename].join("/") : "", [note]);
  useEffect(() => {
    setPathCopied(false);
    return () => {
      if (copyResetTimer.current !== null) window.clearTimeout(copyResetTimer.current);
    };
  }, [notePath]);

  if (authRequired) return <LoginView onLogin={loadApp} />;
  if (loading) return <div className="loading-screen"><span className="loading-mark" />aonoteを開いています</div>;

  const selectSummary = (summary: NoteSummary) => { void selectById(summary.id); };
  const createNote = async (filename: string, folderId: string | null) => {
    const title = filename.replace(/\.md$/i, "");
    const created = await api.createNote({ filename, folder_id: folderId, content: `# ${title}\n\n` });
    await refreshNavigation();
    setNote(created); setContent(created.content);
    setSidebarMode("files"); setDesktopSidebar(true);
  };
  const createFolder = async (name: string, parentId: string | null) => {
    await api.createFolder({ name, parent_id: parentId });
    await refreshNavigation();
    setSidebarMode("files"); setDesktopSidebar(true);
  };
  const renameSelectedFolder = async (name: string) => {
    if (!folderToRename) return;
    await api.renameFolder(folderToRename.id, name);
    const [, selected] = await Promise.all([
      refreshNavigation(),
      note ? api.note(note.id) : Promise.resolve(null),
    ]);
    if (selected) { setNote(selected); setContent(selected.content); resetAutosave(selected); }
    setRevealTree((value) => value + 1);
  };
  const deleteSelectedFolder = async (folder: FolderNode) => {
    const noteCount = flattenNotes([folder]).length;
    const message = `「${folder.name}」と配下のフォルダを削除しますか？\n配下のノート${noteCount}件は削除せず「未整理」へ移動します。`;
    if (!window.confirm(message)) return;
    await api.deleteFolder(folder.id);
    const [, selected] = await Promise.all([
      refreshNavigation(),
      note ? api.note(note.id) : Promise.resolve(null),
    ]);
    if (selected) { setNote(selected); setContent(selected.content); resetAutosave(selected); }
    setRevealTree((value) => value + 1);
  };
  const organizeCurrent = async (filename: string, folderId: string | null) => {
    if (!note) return;
    const updated = await api.relocateNote(note.id, { filename, folder_id: folderId, version: note.version });
    setNote(updated); setContent(updated.content); resetAutosave(updated);
    await refreshNavigation();
    setSidebarMode("files"); setDesktopSidebar(true);
  };
  const reloadWorkspace = async () => {
    setReloadBusy(true);
    try {
      const [, selected] = await Promise.all([
        refreshNavigation(),
        note ? api.note(note.id) : Promise.resolve(null),
      ]);
      if (selected) { setNote(selected); setContent(selected.content); resetAutosave(selected); }
    } finally { setReloadBusy(false); }
  };
  const toggleWorkspace = () => {
    if (window.matchMedia("(max-width: 900px)").matches) setMobileSidebar((value) => !value);
    else setDesktopSidebar((value) => !value);
  };
  const deleteCurrent = async () => {
    if (!note || !window.confirm(`「${note.title}」を削除しますか？`)) return;
    await api.deleteNote(note.id);
    const nextTree = await refreshNavigation();
    const next = flattenNotes(nextTree)[0];
    if (next) void selectById(next.id); else { setNote(null); setContent(""); }
  };
  const copyCurrentPath = async () => {
    if (!notePath) return;
    try {
      await navigator.clipboard.writeText(notePath);
    } catch {
      const input = document.createElement("textarea");
      input.value = notePath;
      input.style.position = "fixed";
      input.style.opacity = "0";
      document.body.appendChild(input);
      input.select();
      document.execCommand("copy");
      input.remove();
    }
    setPathCopied(true);
    if (copyResetTimer.current !== null) window.clearTimeout(copyResetTimer.current);
    copyResetTimer.current = window.setTimeout(() => setPathCopied(false), 1800);
  };

  return (
    <div className="app-shell">
      <TopBar onMenu={toggleWorkspace} onSearch={() => setSearchOpen(true)} onCreate={() => setNewOpen(true)} onCreateFolder={() => setNewFolderOpen(true)} sidebarOpen={window.matchMedia("(max-width: 900px)").matches ? mobileSidebar : desktopSidebar} />
      <div className="workspace">
        <Sidebar tree={tree} recent={recent} selectedId={note?.id ?? null} revealKey={revealTree} mode={sidebarMode} mobileOpen={mobileSidebar} desktopOpen={desktopSidebar} onMode={setSidebarMode} onSelect={selectSummary} onSearch={() => setSearchOpen(true)} onRenameFolder={setFolderToRename} onDeleteFolder={(folder) => void deleteSelectedFolder(folder)} />
        {mobileSidebar ? <button className="sidebar-scrim" aria-label="サイドバーを閉じる" onClick={() => setMobileSidebar(false)} /> : null}
        <main className="document-shell">
          {note ? <>
            <header className="document-bar">
              <div className="breadcrumb-group">
                <div className="breadcrumb">{note.folder_path.length ? note.folder_path.map((folder) => <span key={folder.id}>{folder.name}<b>/</b></span>) : <span>未整理<b>/</b></span>}<strong>{note.filename}</strong></div>
                <button className={`icon-button copy-path-button ${pathCopied ? "copied" : ""}`} onClick={() => void copyCurrentPath()} aria-label={pathCopied ? "パスをコピーしました" : "パスをコピー"} title={pathCopied ? "コピーしました" : notePath}>{pathCopied ? <Check size={16} /> : <Copy size={16} />}</button>
              </div>
              <div className={`save-state ${saveState}`}><i />{saveLabels[saveState]}</div>
              <button className={`icon-button reload-button ${reloadBusy ? "spinning" : ""}`} onClick={() => void reloadWorkspace()} disabled={reloadBusy || saveState === "dirty" || saveState === "saving"} aria-label="ツリーとノートを再読み込み" title="ツリーとノートを再読み込み"><RefreshCw size={17} /></button>
              <button className="icon-button organize-button" onClick={() => setOrganizeOpen(true)} disabled={saveState === "dirty" || saveState === "saving"} aria-label="ノートの名前と保存先を変更" title="名前変更・移動"><PencilLine size={17} /></button>
              <div className="view-switch" aria-label="表示モード">
                <button className={view === "edit" ? "active" : ""} onClick={() => setView("edit")} title="編集"><FilePenLine size={17} /></button>
                <button className={view === "split" ? "active" : ""} onClick={() => setView("split")} title="分割"><Columns2 size={17} /></button>
                <button className={view === "preview" ? "active" : ""} onClick={() => setView("preview")} title="プレビュー"><Eye size={17} /></button>
              </div>
              <button className="icon-button delete-button" onClick={deleteCurrent} aria-label="ノートを削除"><Trash2 size={17} /></button>
              <button className={`icon-button outline-toggle ${outlineOpen ? "active" : ""}`} onClick={() => setOutlineOpen((value) => !value)} aria-label={outlineOpen ? "目次を閉じる" : "目次を表示"} aria-expanded={outlineOpen} aria-controls="note-outline" title="目次"><ListTree size={18} /></button>
            </header>
            <div className="mobile-tabs"><button className={view !== "preview" ? "active" : ""} onClick={() => setView("edit")}>編集</button><button className={view === "preview" ? "active" : ""} onClick={() => setView("preview")}>プレビュー</button></div>
            <div className={`document-workarea view-${view}`} id="preview">
              {view !== "preview" ? <EditorPane content={content} onChange={setContent} /> : null}
              {view !== "edit" ? <PreviewPane content={content} /> : null}
              {outlineOpen ? <button className="outline-scrim" aria-label="目次の外側を閉じる" onClick={() => setOutlineOpen(false)} /> : null}
              <Outline note={{ ...note, content }} drawerOpen={outlineOpen} onClose={() => setOutlineOpen(false)} onBacklink={(id) => void selectById(id)} />
            </div>
            <footer className="statusbar">
              <span className="mcp-status"><i />{status?.mcp_ready ? "MCP 接続可能" : "MCP 停止中"}</span>
              <span className="status-spacer" />
              <span>Markdown</span><b /><span>UTF-8</span><b /><span>行 {cursor.line}, 列 {cursor.column}</span>
            </footer>
          </> : <div className="empty-document"><PanelLeftClose size={28} /><h1>ノートを選択してください</h1><p>左のワークスペースからMarkdownファイルを開きます。</p></div>}
        </main>
      </div>
      <SearchDialog open={searchOpen} onClose={() => setSearchOpen(false)} onSelect={(id) => void selectById(id)} />
      <NewNoteDialog open={newOpen} folders={tree} onClose={() => setNewOpen(false)} onCreate={createNote} />
      <NewFolderDialog open={newFolderOpen} folders={tree} maxDepth={status?.max_folder_depth ?? 3} onClose={() => setNewFolderOpen(false)} onCreate={createFolder} />
      <RenameFolderDialog folder={folderToRename} onClose={() => setFolderToRename(null)} onSave={renameSelectedFolder} />
      <OrganizeNoteDialog open={organizeOpen} note={note} folders={tree} onClose={() => setOrganizeOpen(false)} onSave={organizeCurrent} />
    </div>
  );
}
