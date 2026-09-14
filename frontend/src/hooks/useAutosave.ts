import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ApiError, api } from "../api";
import type { Note, SaveState } from "../types";

type SaveSession = {
  note: Note;
  draft: string;
  timer: number | null;
  saving: Promise<void> | null;
};

function clearTimer(session: SaveSession) {
  if (session.timer !== null) window.clearTimeout(session.timer);
  session.timer = null;
}

export function useAutosave(onSaved: (note: Note) => void) {
  const [state, setState] = useState<SaveState>("idle");
  const sessionRef = useRef<SaveSession | null>(null);
  const onSavedRef = useRef(onSaved);

  useLayoutEffect(() => { onSavedRef.current = onSaved; }, [onSaved]);

  const save = useCallback((session: SaveSession): Promise<void> => {
    clearTimer(session);
    if (session.saving) return session.saving;
    const run = async () => {
      try {
        // Bind each request to its note and serialize changes using the returned
        // version. Edits made during the request are saved by the next iteration.
        while (session.draft !== session.note.content) {
          if (sessionRef.current === session) setState("saving");
          const content = session.draft;
          const updated = await api.updateNote(session.note.id, { content, version: session.note.version });
          session.note = updated;
          if (sessionRef.current === session) onSavedRef.current(updated);
        }
        if (sessionRef.current === session) setState("saved");
      } catch (error) {
        if (sessionRef.current === session) {
          setState(error instanceof ApiError && error.status === 409 ? "conflict" : "error");
        }
        throw error;
      }
    };
    session.saving = run().finally(() => { session.saving = null; });
    return session.saving;
  }, []);

  // Record input synchronously, not in an effect: a navigation click must see
  // the latest keystroke even before the debounce timer has fired.
  const edit = useCallback((content: string) => {
    const session = sessionRef.current;
    if (!session) return;
    session.draft = content;
    clearTimer(session);
    if (session.saving) return;
    if (content === session.note.content) { setState("saved"); return; }
    setState("dirty");
    session.timer = window.setTimeout(() => { void save(session).catch(() => {}); }, 700);
  }, [save]);

  const flush = useCallback(async (): Promise<Note | null> => {
    const session = sessionRef.current;
    if (!session) return null;
    await save(session);
    return session.note;
  }, [save]);

  // Call only after flush succeeds, before replacing the document on screen.
  const reset = useCallback((next: Note | null) => {
    const previous = sessionRef.current;
    if (previous && (previous.saving || previous.draft !== previous.note.content)) {
      throw new Error("Cannot replace a note with unsaved changes");
    }
    if (previous) clearTimer(previous);
    sessionRef.current = next ? { note: next, draft: next.content, timer: null, saving: null } : null;
    setState(next ? "saved" : "idle");
  }, []);

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      const session = sessionRef.current;
      if (session && (session.saving || session.draft !== session.note.content)) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      if (sessionRef.current) clearTimer(sessionRef.current);
    };
  }, []);

  return { state, edit, flush, reset };
}
