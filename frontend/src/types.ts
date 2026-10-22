export type NoteSummary = {
  id: string;
  folder_id: string | null;
  filename: string;
  title: string;
  version: number;
  created_at: number;
  updated_at: number;
  created_by: string;
  created_via: string | null;
  updated_by: string;
  updated_via: string | null;
};

export type Note = NoteSummary & {
  content: string;
  folder_name: string | null;
  folder_path: Array<{ id: string; name: string }>;
  links: Array<{ target: string; id: string | null }>;
  backlinks: Array<Pick<NoteSummary, "id" | "title" | "filename">>;
};

export type TrashedNoteSummary = NoteSummary & {
  deleted_at: number;
  deleted_path: string;
};

export type TrashedNote = Note & TrashedNoteSummary;

export type FolderNode = {
  id: string;
  name: string;
  parent_id?: string | null;
  folders: FolderNode[];
  notes: NoteSummary[];
};

export type SearchResult = {
  id: string;
  title: string;
  filename: string;
  snippet: string;
  snippet_parts?: Array<{ text: string; highlight: boolean }>;
  rank: number;
  updated_at: number;
};

export type AppStatus = {
  name: string;
  notes: number;
  folders: number;
  search: string;
  mcp_endpoint: string;
  mcp_ready: boolean;
  auth_bypassed: boolean;
  max_folder_depth: number;
  workspace_session_hours: number;
};

export type SaveState = "idle" | "dirty" | "saving" | "saved" | "conflict" | "error";

export type SettingsSection = "preferences" | "behavior" | "connections";

export type OAuthScope = "notes:read" | "notes:search" | "notes:write";
export type AIConnection = {
  id: string;
  client_id: string;
  client_name: string;
  actor_name: string;
  scopes: OAuthScope[];
  approved_scopes: OAuthScope[];
  resource: string;
  redirect_uris: string[];
  created_at: number | null;
  updated_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
  expires_at: number | null;
  legacy: boolean;
  version: number;
  status: "active" | "pending" | "expired" | "revoked";
};
