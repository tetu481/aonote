export type ViewMode = "edit" | "split" | "preview";
type WorkspaceSession = { noteId: string; view: ViewMode; updatedAt: number };

export const WORKSPACE_SESSION_KEY = "aonote:workspace-session:v1";

function isViewMode(value: unknown): value is ViewMode {
  return value === "edit" || value === "split" || value === "preview";
}

export function clearWorkspaceSession() {
  try { window.sessionStorage.removeItem(WORKSPACE_SESSION_KEY); }
  catch { /* The workspace remains usable when browser storage is disabled. */ }
}

export function readWorkspaceSession(maxAgeHours = 1): WorkspaceSession | null {
  try {
    const value = window.sessionStorage.getItem(WORKSPACE_SESSION_KEY);
    if (!value) return null;
    const stored = JSON.parse(value) as Partial<WorkspaceSession> | null;
    const hours = Number.isFinite(maxAgeHours) && maxAgeHours > 0 ? maxAgeHours : 1;
    const now = Date.now();
    if (stored && typeof stored === "object"
      && typeof stored.noteId === "string" && stored.noteId.length > 0
      && isViewMode(stored.view)
      && typeof stored.updatedAt === "number" && Number.isFinite(stored.updatedAt)
      && stored.updatedAt <= now && now - stored.updatedAt < hours * 3_600_000) {
      return { noteId: stored.noteId, view: stored.view, updatedAt: stored.updatedAt };
    }
  } catch { /* Ignore malformed or inaccessible session data. */ }
  clearWorkspaceSession();
  return null;
}

export function persistWorkspaceSession(noteId: string, view: ViewMode) {
  try {
    const session: WorkspaceSession = { noteId, view, updatedAt: Date.now() };
    window.sessionStorage.setItem(WORKSPACE_SESSION_KEY, JSON.stringify(session));
  } catch { /* Continue without persistence if storage is unavailable. */ }
}
