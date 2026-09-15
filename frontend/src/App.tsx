import { Check, Columns2, Copy, Eye, FilePenLine, ListTree, PanelLeftClose, PencilLine, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, api } from "./api";
import { EditorPane } from "./components/EditorPane";
import { LoginView } from "./components/LoginView";
import { NameTooltip } from "./components/NameTooltip";
import { NewNoteDialog } from "./components/NewNoteDialog";
import { NewFolderDialog } from "./components/NewFolderDialog";
import { OrganizeNoteDialog } from "./components/OrganizeNoteDialog";
import { Outline } from "./components/Outline";
import { PreviewPane } from "./components/PreviewPane";
import { RenameFolderDialog } from "./components/RenameFolderDialog";
import { SearchDialog } from "./components/SearchDialog";
import { SettingsView } from "./components/SettingsView";
import { Sidebar, type SidebarMode } from "./components/Sidebar";
import { TopBar } from "./components/TopBar";
import { TrashDocument } from "./components/TrashDocument";
import { useLocale } from "./LocaleContext";
import { useAutosave } from "./hooks/useAutosave";
import { flattenNotes, folderContainsFolder } from "./folderUtils";
import { applyTheme, persistTheme, readStoredTheme, type Theme } from "./theme";
import type { AppStatus, FolderNode, Note, NoteSummary, TrashedNote, TrashedNoteSummary } from "./types";
import { WELCOME_DEFAULTS } from "./workspaceDefaults";
import "./styles.css";

type ViewMode = "edit" | "split" | "preview";
const OUTLINE_STORAGE_KEY = "aonote:outline-visible:v1";

function initialOutlineVisible() {
  try { return window.localStorage.getItem(OUTLINE_STORAGE_KEY) !== "false"; }
  catch { return true; }
}

export default function App() {
  const { locale, text: uiText } = useLocale();
  const initialLocale = useRef(locale).current;
  const welcomeDefaults = WELCOME_DEFAULTS[initialLocale];
  const [tree, setTree] = useState<FolderNode[]>([]);
  const [recent, setRecent] = useState<NoteSummary[]>([]);
  const [trash, setTrash] = useState<TrashedNoteSummary[]>([]);
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [note, setNote] = useState<Note | null>(null);
  const [trashedNote, setTrashedNote] = useState<TrashedNote | null>(null);
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [view, setView] = useState<ViewMode>("preview");
  const [theme, setTheme] = useState<Theme>(readStoredTheme);
  const [sidebarMode, setSidebarMode] = useState<SidebarMode>("files");
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
  const [outlineVisible, setOutlineVisible] = useState(initialOutlineVisible);
  const [compactOutline, setCompactOutline] = useState(() => window.matchMedia("(max-width: 1180px)").matches);
  const [trashBusy, setTrashBusy] = useState(false);
  const [trashMessage, setTrashMessage] = useState("");
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [restoreError, setRestoreError] = useState("");
  const [revealTree, setRevealTree] = useState(0);
  const [authRequired, setAuthRequired] = useState(false);
  const [loading, setLoading] = useState(true);
  const [startupError, setStartupError] = useState<{ status: number | null } | null>(null);
  const [documentBusy, setDocumentBusy] = useState(false);
  const [documentError, setDocumentError] = useState("");
  const documentQueueRef = useRef<Promise<void>>(Promise.resolve());
  const pendingDocumentActions = useRef(0);
  const saveErrorTextRef = useRef(uiText.app.errors);
  const copyResetTimer = useRef<number | null>(null);
  const sidebarModeRef = useRef<SidebarMode>("files");
  const navigationRevisionRef = useRef(0);

  const updateSidebarMode = useCallback((mode: SidebarMode) => {
    sidebarModeRef.current = mode;
    navigationRevisionRef.current += 1;
    setSidebarMode(mode);
  }, []);

  const refreshNavigation = useCallback(async () => {
    const [nextTree, nextRecent] = await Promise.all([api.tree(), api.recent()]);
    setTree(nextTree);
    setRecent(nextRecent);
    return nextTree;
  }, []);

  const refreshTrash = useCallback(async () => {
    const nextTrash = await api.trash();
    setTrash(nextTrash);
    return nextTrash;
  }, []);

  const onSaved = useCallback((updated: Note) => {
    setNote((current) => current?.id === updated.id ? updated : current);
    setDocumentError("");
    // A navigation refresh failure is not a failed document save.
    void refreshNavigation().catch(() => {});
  }, [refreshNavigation]);
  const { state: saveState, edit: editAutosave, flush: flushAutosave, reset: resetAutosave } = useAutosave(onSaved);

  const showNote = useCallback((selected: Note | null) => {
    resetAutosave(selected);
    setNote(selected);
    setContent(selected?.content ?? "");
  }, [resetAutosave]);

  useEffect(() => { saveErrorTextRef.current = uiText.app.errors; }, [uiText]);

  // Every operation that replaces the editor first drains autosave. Serialize
  // these operations and lock input until their reads/writes finish as well.
  const withSavedNote = useCallback((action: (saved: Note | null) => Promise<void>) => {
    pendingDocumentActions.current += 1;
    setDocumentBusy(true);
    const task = documentQueueRef.current.then(async () => {
      setDocumentError("");
      let saved: Note | null;
      try { saved = await flushAutosave(); }
      catch (error) {
        throw new Error(error instanceof ApiError && error.status === 409
          ? saveErrorTextRef.current.saveConflict
          : saveErrorTextRef.current.unsavedChanges);
      }
      await action(saved);
    }).catch((error: unknown) => {
      setDocumentError(error instanceof Error ? error.message : String(error));
      throw error;
    }).finally(() => {
      pendingDocumentActions.current -= 1;
      setDocumentBusy(pendingDocumentActions.current > 0);
    });
    documentQueueRef.current = task.catch(() => {});
    return task;
  }, [flushAutosave]);

  const changeContent = (next: string) => {
    if (pendingDocumentActions.current) return;
    editAutosave(next);
    setContent(next);
  };

  const selectById = useCallback(async (id: string, propagateError = false) => {
    updateSidebarMode("files");
    setDesktopSidebar(true);
    setMobileSidebar(false);
    setOutlineOpen(false);
    const navigationRevision = ++navigationRevisionRef.current;
    await withSavedNote(async () => {
      if (navigationRevision !== navigationRevisionRef.current) return;
      const selected = await api.note(id);
      if (navigationRevision !== navigationRevisionRef.current) return;
      showNote(selected);
      setTrashedNote(null);
      setRestoreError("");
      setSelectedFolderId(selected.folder_id ?? "unfiled");
      setRevealTree((value) => value + 1);
    }).catch((error: unknown) => {
      // Normal navigation keeps the draft and displays documentError; startup
      // must also surface a failed initial note read in the retryable screen.
      if (propagateError) throw error;
    });
  }, [updateSidebarMode, withSavedNote, showNote]);

  const loadApp = useCallback(async () => {
    setLoading(true);
    setStartupError(null);
    try {
      const [nextStatus, nextTree, nextRecent, nextTrash] = await Promise.all([api.status(), api.tree(), api.recent(), api.trash()]);
      setStatus(nextStatus); setTree(nextTree); setRecent(nextRecent); setTrash(nextTrash); setAuthRequired(false);
      const notes = flattenNotes(nextTree);
      const welcomeFolder = nextTree.find((folder) => folder.name === welcomeDefaults.folderName);
      const preferred = welcomeFolder?.notes.find((item) => item.filename === welcomeDefaults.noteFilename) ?? notes[0];
      if (preferred) await selectById(preferred.id, true);
      else setSelectedFolderId(welcomeFolder?.id ?? nextTree.find((folder) => folder.id !== "unfiled")?.id ?? "unfiled");
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) setAuthRequired(true);
      else {
        setAuthRequired(false);
        setStartupError({ status: error instanceof ApiError ? error.status : null });
      }
    } finally { setLoading(false); }
  }, [selectById, welcomeDefaults.folderName, welcomeDefaults.noteFilename]);

  useEffect(() => { void loadApp(); }, [loadApp]);
  useEffect(() => {
    applyTheme(theme);
    persistTheme(theme);
  }, [theme]);
  useEffect(() => {
    try { window.localStorage.setItem(OUTLINE_STORAGE_KEY, String(outlineVisible)); }
    catch { /* Continue rendering when localStorage is unavailable. */ }
  }, [outlineVisible]);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 1180px)");
    const onChange = (event: MediaQueryListEvent) => setCompactOutline(event.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); setSearchOpen(true); }
      if (event.key === "Escape") { setSearchOpen(false); setNewOpen(false); setNewFolderOpen(false); setFolderToRename(null); setOrganizeOpen(false); setOutlineOpen(false); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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
  if (loading) return <div className="loading-screen"><span className="loading-mark" />{uiText.app.loading}</div>;
  if (startupError) return <main className="startup-error">
    <section role="alert" aria-labelledby="startup-error-title">
      <h1 id="startup-error-title">{uiText.app.startupError.title}</h1>
      <p>{uiText.app.startupError.description}</p>
      <p>{startupError.status === null ? uiText.app.startupError.network : uiText.app.startupError.http(startupError.status)}</p>
      <button className="primary-button" onClick={() => void loadApp()}><RefreshCw size={16} />{uiText.app.startupError.retry}</button>
    </section>
  </main>;

  const selectSummary = (summary: NoteSummary) => { void selectById(summary.id); };
  const selectTrashedSummary = async (summary: TrashedNoteSummary) => {
    updateSidebarMode("trash");
    const navigationRevision = ++navigationRevisionRef.current;
    try {
      const selected = await api.trashedNote(summary.id);
      if (navigationRevision !== navigationRevisionRef.current) return;
      setTrashedNote(selected);
      setRestoreError("");
      setView("preview");
      setMobileSidebar(false);
      setOutlineOpen(false);
    } catch (error) {
      if (navigationRevision !== navigationRevisionRef.current) return;
      setTrashMessage(error instanceof Error ? error.message : uiText.app.errors.openTrash);
    }
  };
  const changeSidebarMode = (mode: SidebarMode) => {
    updateSidebarMode(mode);
    if (mode !== "trash") {
      setTrashedNote(null);
      setRestoreError("");
    }
    if (mode === "settings") {
      setMobileSidebar(false);
      setOutlineOpen(false);
    }
  };
  const createNote = async (filename: string, folderId: string | null) => {
    await withSavedNote(async () => {
      const title = filename.replace(/\.md$/i, "");
      const created = await api.createNote({ filename, folder_id: folderId, content: `# ${title}\n\n` });
      await refreshNavigation();
      setTrashedNote(null); showNote(created);
      setSelectedFolderId(created.folder_id ?? "unfiled");
      updateSidebarMode("files"); setDesktopSidebar(true);
    });
  };
  const createFolder = async (name: string, parentId: string | null) => {
    await api.createFolder({ name, parent_id: parentId });
    await refreshNavigation();
    setTrashedNote(null);
    updateSidebarMode("files"); setDesktopSidebar(true);
  };
  const renameSelectedFolder = async (name: string) => {
    if (!folderToRename) return;
    const folderId = folderToRename.id;
    await withSavedNote(async (saved) => {
      await api.renameFolder(folderId, name);
      const [, selected] = await Promise.all([
        refreshNavigation(),
        saved ? api.note(saved.id) : Promise.resolve(null),
      ]);
      if (selected) showNote(selected);
      setRevealTree((value) => value + 1);
    });
  };
  const deleteSelectedFolder = async (folder: FolderNode) => {
    const noteCount = flattenNotes([folder]).length;
    const removesSelectedFolder = folderContainsFolder(folder, selectedFolderId);
    const message = uiText.app.deleteFolderConfirmation(folder.name, noteCount);
    if (!window.confirm(message)) return;
    await withSavedNote(async (saved) => {
      await api.deleteFolder(folder.id);
      const [, selected] = await Promise.all([
        refreshNavigation(),
        saved ? api.note(saved.id) : Promise.resolve(null),
      ]);
      if (selected) showNote(selected);
      if (removesSelectedFolder) setSelectedFolderId(selected?.folder_id ?? "unfiled");
      setRevealTree((value) => value + 1);
    }).catch(() => {});
  };
  const organizeCurrent = async (filename: string, folderId: string | null) => {
    if (!note) return;
    const noteId = note.id;
    await withSavedNote(async (saved) => {
      if (!saved || saved.id !== noteId) return;
      const updated = await api.relocateNote(saved.id, { filename, folder_id: folderId, version: saved.version });
      showNote(updated);
      setSelectedFolderId(updated.folder_id ?? "unfiled");
      await refreshNavigation();
      updateSidebarMode("files"); setDesktopSidebar(true);
    });
  };
  const reloadWorkspace = async () => {
    setReloadBusy(true);
    try {
      await withSavedNote(async (saved) => {
        const [, selected] = await Promise.all([
          refreshNavigation(),
          saved ? api.note(saved.id) : Promise.resolve(null),
        ]);
        if (selected) showNote(selected);
      }).catch(() => {});
    } finally { setReloadBusy(false); }
  };
  const toggleWorkspace = () => {
    if (window.matchMedia("(max-width: 900px)").matches) setMobileSidebar((value) => !value);
    else setDesktopSidebar((value) => !value);
  };
  const deleteCurrent = async () => {
    if (!note || !window.confirm(uiText.app.deleteNoteConfirmation(note.title))) return;
    const noteId = note.id;
    await withSavedNote(async (saved) => {
      if (!saved || saved.id !== noteId) return;
      await api.deleteNote(noteId);
      showNote(null);
      const [nextTree] = await Promise.all([refreshNavigation(), refreshTrash()]);
      const next = flattenNotes(nextTree)[0];
      if (next && sidebarModeRef.current === "files") void selectById(next.id);
    }).catch(() => {});
  };
  const restoreCurrent = async () => {
    if (!trashedNote) return;
    setRestoreBusy(true); setRestoreError("");
    try {
      await withSavedNote(async () => {
        const restored = await api.restoreNote(trashedNote.id);
        await Promise.all([refreshNavigation(), refreshTrash()]);
        setTrashedNote(null); showNote(restored);
        setSelectedFolderId(restored.folder_id ?? "unfiled");
        updateSidebarMode("files"); setDesktopSidebar(true); setRevealTree((value) => value + 1);
      });
    } catch (error) {
      setRestoreError(error instanceof Error ? error.message : uiText.app.errors.restoreNote);
    } finally { setRestoreBusy(false); }
  };
  const purgeTrash = async (days: number) => {
    const confirmed = window.confirm(uiText.app.purgeTrashConfirmation(days));
    if (!confirmed) return;
    setTrashBusy(true); setTrashMessage("");
    try {
      const result = await api.purgeTrash(days);
      const nextTrash = await refreshTrash();
      if (trashedNote && !nextTrash.some((item) => item.id === trashedNote.id)) setTrashedNote(null);
      setTrashMessage(uiText.app.trashPurged(result.deleted));
    } catch (error) {
      setTrashMessage(error instanceof Error ? error.message : uiText.app.errors.purgeTrash);
    } finally { setTrashBusy(false); }
  };
  const toggleOutline = () => {
    if (compactOutline) setOutlineOpen((value) => !value);
    else setOutlineVisible((value) => !value);
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
  const outlineExpanded = compactOutline ? outlineOpen : outlineVisible;

  return (
    <div className="app-shell">
      <NameTooltip />
      <TopBar onMenu={toggleWorkspace} onSearch={() => setSearchOpen(true)} onCreate={() => setNewOpen(true)} onCreateFolder={() => setNewFolderOpen(true)} sidebarOpen={window.matchMedia("(max-width: 900px)").matches ? mobileSidebar : desktopSidebar} />
      <div className="workspace">
        <Sidebar tree={tree} recent={recent} trash={trash} selectedId={trashedNote ? null : note?.id ?? null} selectedTrashId={trashedNote?.id ?? null} selectedFolderId={selectedFolderId} revealKey={revealTree} mode={sidebarMode} mobileOpen={mobileSidebar} desktopOpen={desktopSidebar} onMode={changeSidebarMode} onSelect={selectSummary} onSelectTrash={(item) => void selectTrashedSummary(item)} onSelectFolder={setSelectedFolderId} onSearch={() => setSearchOpen(true)} onRenameFolder={setFolderToRename} onDeleteFolder={(folder) => void deleteSelectedFolder(folder)} onPurgeTrash={(days) => void purgeTrash(days)} trashBusy={trashBusy} trashMessage={trashMessage} />
        {mobileSidebar ? <button className="sidebar-scrim" aria-label={uiText.app.sidebarClose} onClick={() => setMobileSidebar(false)} /> : null}
        <main className="document-shell">
          {documentError ? <div className="document-error" role="alert"><span>{documentError}</span>{saveState === "error" || saveState === "conflict" ? <button onClick={() => void withSavedNote(async () => {}).catch(() => {})} disabled={documentBusy}>{uiText.app.retrySave}</button> : null}</div> : null}
          {sidebarMode === "settings" ? <SettingsView theme={theme} onTheme={setTheme} onClose={() => updateSidebarMode("files")} /> : trashedNote ? <TrashDocument note={trashedNote} compactOutline={compactOutline} outlineDrawerOpen={outlineOpen} outlineVisible={outlineVisible} restoreBusy={restoreBusy} restoreError={restoreError} onToggleOutline={toggleOutline} onCloseOutline={() => setOutlineOpen(false)} onRestore={() => void restoreCurrent()} /> : sidebarMode === "trash" ? <div className="empty-document"><Trash2 size={28} /><h1>{uiText.app.trashEmpty.title}</h1><p>{uiText.app.trashEmpty.description}</p></div> : note ? <>
            <header className="document-bar">
              <div className="breadcrumb-group">
                <div className="breadcrumb">{note.folder_path.length ? note.folder_path.map((folder) => <span key={folder.id} data-full-name={folder.name} tabIndex={0}>{folder.name}<b>/</b></span>) : <span>{uiText.common.unfiled}<b>/</b></span>}<strong data-full-name={note.filename} tabIndex={0}>{note.filename}</strong></div>
                <button className={`icon-button copy-path-button ${pathCopied ? "copied" : ""}`} onClick={() => void copyCurrentPath()} aria-label={pathCopied ? uiText.app.toolbar.copiedPath : uiText.app.toolbar.copyPath} title={pathCopied ? uiText.app.toolbar.copied : notePath}>{pathCopied ? <Check size={16} /> : <Copy size={16} />}</button>
              </div>
              <div className={`save-state ${saveState}`}><i />{uiText.app.saveState[saveState]}</div>
              <button className={`icon-button reload-button ${reloadBusy ? "spinning" : ""}`} onClick={() => void reloadWorkspace()} disabled={documentBusy || reloadBusy || saveState === "dirty" || saveState === "saving"} aria-label={uiText.app.toolbar.reload} title={uiText.app.toolbar.reload}><RefreshCw size={17} /></button>
              <button className="icon-button organize-button" onClick={() => setOrganizeOpen(true)} disabled={documentBusy || saveState === "dirty" || saveState === "saving"} aria-label={uiText.app.toolbar.organize} title={uiText.app.toolbar.organizeShort}><PencilLine size={17} /></button>
              <div className="view-switch" aria-label={uiText.app.toolbar.viewMode}>
                <button className={view === "edit" ? "active" : ""} onClick={() => setView("edit")} title={uiText.app.toolbar.edit}><FilePenLine size={17} /></button>
                <button className={view === "split" ? "active" : ""} onClick={() => setView("split")} title={uiText.app.toolbar.split}><Columns2 size={17} /></button>
                <button className={view === "preview" ? "active" : ""} onClick={() => setView("preview")} title={uiText.app.toolbar.preview}><Eye size={17} /></button>
              </div>
              <button className="icon-button delete-button" onClick={deleteCurrent} disabled={documentBusy} aria-label={uiText.app.toolbar.deleteNote}><Trash2 size={17} /></button>
              <button className={`icon-button outline-toggle ${outlineExpanded ? "active" : ""}`} onClick={toggleOutline} aria-label={outlineExpanded ? uiText.app.toolbar.closeOutline : uiText.app.toolbar.showOutline} aria-expanded={outlineExpanded} aria-controls="note-outline" title={uiText.app.toolbar.outline}><ListTree size={18} /></button>
            </header>
            <div className="mobile-tabs"><button className={view !== "preview" ? "active" : ""} onClick={() => setView("edit")}>{uiText.app.toolbar.edit}</button><button className={view === "preview" ? "active" : ""} onClick={() => setView("preview")}>{uiText.app.toolbar.preview}</button></div>
            <div className={`document-workarea view-${view} ${outlineVisible ? "" : "outline-hidden"}`} id="preview">
              {view !== "preview" ? <EditorPane content={content} onChange={changeContent} readOnly={documentBusy} /> : null}
              {view !== "edit" ? <PreviewPane content={content} links={note.links} onWikilink={selectById} /> : null}
              {outlineOpen ? <button className="outline-scrim" aria-label={uiText.app.toolbar.closeOutlineOutside} onClick={() => setOutlineOpen(false)} /> : null}
              <Outline note={{ ...note, content }} drawerOpen={outlineOpen} desktopVisible={outlineVisible} onClose={() => setOutlineOpen(false)} onBacklink={(id) => void selectById(id)} />
            </div>
            <footer className="statusbar">
              <span className="mcp-status"><i />{status?.mcp_ready ? uiText.app.mcpReady : uiText.app.mcpStopped}</span>
              <span className="status-spacer" />
              <span>{uiText.common.markdown}</span><b /><span>{uiText.app.encoding}</span><b /><span>{uiText.app.cursor(cursor.line, cursor.column)}</span>
            </footer>
          </> : <div className="empty-document"><PanelLeftClose size={28} /><h1>{uiText.app.emptyDocument.title}</h1><p>{uiText.app.emptyDocument.description}</p></div>}
        </main>
      </div>
      <SearchDialog open={searchOpen} onClose={() => setSearchOpen(false)} onSelect={(id) => void selectById(id)} />
      <NewNoteDialog open={newOpen} folders={tree} defaultFolderId={selectedFolderId === "unfiled" ? null : selectedFolderId} onClose={() => setNewOpen(false)} onCreate={createNote} />
      <NewFolderDialog open={newFolderOpen} folders={tree} maxDepth={status?.max_folder_depth ?? 3} defaultParentId={selectedFolderId === "unfiled" ? null : selectedFolderId} onClose={() => setNewFolderOpen(false)} onCreate={createFolder} />
      <RenameFolderDialog folder={folderToRename} onClose={() => setFolderToRename(null)} onSave={renameSelectedFolder} />
      <OrganizeNoteDialog open={organizeOpen} note={note} folders={tree} onClose={() => setOrganizeOpen(false)} onSave={organizeCurrent} />
    </div>
  );
}
