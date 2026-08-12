import type { FolderNode, NoteSummary } from "./types";

export type FolderOption = {
  id: string;
  name: string;
  label: string;
  depth: number;
};

export function flattenFolders(nodes: FolderNode[], depth = 1): FolderOption[] {
  return nodes.flatMap((node) => {
    if (node.id === "unfiled") return [];
    const option = { id: node.id, name: node.name, label: `${"　".repeat(depth - 1)}${node.name}`, depth };
    return [option, ...flattenFolders(node.folders, depth + 1)];
  });
}

export function flattenNotes(nodes: FolderNode[]): NoteSummary[] {
  return nodes.flatMap((node) => [...node.notes, ...flattenNotes(node.folders)]);
}

export function folderContainsNote(folder: FolderNode, noteId: string | null): boolean {
  if (!noteId) return false;
  return folder.notes.some((note) => note.id === noteId)
    || folder.folders.some((child) => folderContainsNote(child, noteId));
}

export function folderContainsFolder(folder: FolderNode, folderId: string | null): boolean {
  if (!folderId) return false;
  return folder.id === folderId
    || folder.folders.some((child) => folderContainsFolder(child, folderId));
}
