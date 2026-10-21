import type { AIConnection, OAuthScope, AppStatus, FolderNode, Note, NoteSummary, SearchResult, TrashedNote, TrashedNoteSummary } from "./types";
import { getUiText, readStoredLocale } from "./locales";

export class ApiError extends Error {
  status: number;
  body: unknown;
  retryAfter: number | undefined;

  constructor(status: number, body: unknown, retryAfter?: number) {
    super(typeof body === "object" && body && "detail" in body ? String((body as { detail: unknown }).detail) : getUiText(readStoredLocale()).api.error(status));
    this.status = status;
    this.body = body;
    this.retryAfter = retryAfter;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...init,
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  if (!response.ok) {
    let body: unknown = null;
    const raw = await response.text();
    try {
      body = JSON.parse(raw);
    } catch {
      body = raw;
    }
    const retryAfter = Number(response.headers.get("Retry-After"));
    throw new ApiError(response.status, body, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export const api = {
  connections: (signal?: AbortSignal) => request<AIConnection[]>("/api/connections", { signal }),
  updateConnection: (id: string, payload: { actor_name: string; scopes: OAuthScope[]; version: number }) =>
    request<AIConnection>(`/api/connections/${encodeURIComponent(id)}`, { method: "PATCH", headers: { "X-Aonote-Request": "connections" }, body: JSON.stringify(payload) }),
  disconnect: (id: string) => request<void>(`/api/connections/${encodeURIComponent(id)}`, { method: "DELETE", headers: { "X-Aonote-Request": "connections" } }),
  login: (password: string) => request<{ authenticated: boolean }>("/api/session", { method: "POST", body: JSON.stringify({ password }) }),
  status: () => request<AppStatus>("/api/status"),
  tree: () => request<FolderNode[]>("/api/tree"),
  recent: () => request<NoteSummary[]>("/api/recent"),
  note: (id: string) => request<Note>(`/api/notes/${id}`),
  search: (query: string) => request<{ query: string; results: SearchResult[] }>(`/api/search?q=${encodeURIComponent(query)}`),
  createNote: (payload: { filename: string; content: string; folder_id: string | null }) =>
    request<Note>("/api/notes", { method: "POST", body: JSON.stringify(payload) }),
  updateNote: (id: string, payload: { content: string; version: number }) =>
    request<Note>(`/api/notes/${id}`, { method: "PATCH", body: JSON.stringify(payload) }),
  relocateNote: (id: string, payload: { filename: string; folder_id: string | null; version: number }) =>
    request<Note>(`/api/notes/${id}/location`, { method: "PATCH", body: JSON.stringify(payload) }),
  deleteNote: (id: string) => request<void>(`/api/notes/${id}`, { method: "DELETE" }),
  trash: () => request<TrashedNoteSummary[]>("/api/trash"),
  trashedNote: (id: string) => request<TrashedNote>(`/api/trash/${id}`),
  restoreNote: (id: string) => request<Note>(`/api/trash/${id}/restore`, { method: "POST" }),
  purgeTrash: (olderThanDays: number) =>
    request<{ deleted: number }>(`/api/trash?older_than_days=${encodeURIComponent(olderThanDays)}`, { method: "DELETE" }),
  createFolder: (payload: { name: string; parent_id: string | null }) =>
    request<{ id: string; name: string; parent_id: string | null; depth: number }>("/api/folders", { method: "POST", body: JSON.stringify(payload) }),
  renameFolder: (id: string, name: string) =>
    request<{ id: string; name: string; parent_id: string | null; depth: number }>(`/api/folders/${id}`, { method: "PATCH", body: JSON.stringify({ name }) }),
  deleteFolder: (id: string) => request<void>(`/api/folders/${id}`, { method: "DELETE" }),
};
