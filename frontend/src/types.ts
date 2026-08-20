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
};

export type SaveState = "idle" | "dirty" | "saving" | "saved" | "conflict" | "error";
