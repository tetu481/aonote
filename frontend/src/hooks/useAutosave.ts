import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api } from "../api";
import type { Note, SaveState } from "../types";

export function useAutosave(note: Note | null, content: string, onSaved: (note: Note) => void) {
  const [state, setState] = useState<SaveState>("idle");
  const savedContent = useRef("");
  const noteRef = useRef<Note | null>(note);

  useEffect(() => {
    noteRef.current = note;
    savedContent.current = note?.content ?? "";
    setState(note ? "saved" : "idle");
  }, [note?.id]);

  useEffect(() => {
    if (!note || content === savedContent.current) return;
    setState("dirty");
    const timer = window.setTimeout(async () => {
      const current = noteRef.current;
      if (!current) return;
      setState("saving");
      try {
        const updated = await api.updateNote(current.id, { content, version: current.version });
        savedContent.current = content;
        noteRef.current = updated;
        onSaved(updated);
        setState("saved");
      } catch (error) {
        setState(error instanceof ApiError && error.status === 409 ? "conflict" : "error");
      }
    }, 700);
    return () => window.clearTimeout(timer);
  }, [content, note, onSaved]);

  const reset = useCallback((next: Note) => {
    noteRef.current = next;
    savedContent.current = next.content;
    setState("saved");
  }, []);

  return { state, reset };
}
