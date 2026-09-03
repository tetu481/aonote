import { Link2, X } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import { useUiText } from "../LocaleContext";
import { extractOutlineHeadings, headingId } from "../remarkHeadingIds";
import type { Note } from "../types";
import { DEFAULT_ADMIN_ACTOR_NAME } from "../workspaceDefaults";

function ActorName({ name, via }: { name: string; via: string | null }) {
  const uiText = useUiText();
  const tooltip = via ? uiText.outline.via(via) : undefined;
  const displayName = !via && name === DEFAULT_ADMIN_ACTOR_NAME ? uiText.outline.administrator : name;
  return <span className="actor-name" data-tooltip={tooltip} tabIndex={via ? 0 : undefined}>{displayName}</span>;
}

type Props = {
  note: Note;
  drawerOpen: boolean;
  desktopVisible: boolean;
  onClose: () => void;
  onBacklink: (id: string) => void;
};

export function Outline({ note, drawerOpen, desktopVisible, onClose, onBacklink }: Props) {
  const uiText = useUiText();
  const closeRef = useRef<HTMLButtonElement>(null);
  const headings = useMemo(() => extractOutlineHeadings(note.content), [note.content]);
  const dateFormatter = useMemo(() => new Intl.DateTimeFormat(uiText.meta.locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }), [uiText.meta.locale]);
  useEffect(() => {
    if (drawerOpen) closeRef.current?.focus();
  }, [drawerOpen]);
  return (
    <aside className={`outline-panel ${desktopVisible ? "" : "desktop-hidden"} ${drawerOpen ? "drawer-open" : ""}`} id="note-outline" aria-label={uiText.outline.regionLabel}>
      <div className="outline-heading"><h2>{uiText.outline.title}</h2><button ref={closeRef} className="outline-close" onClick={onClose} aria-label={uiText.outline.close}><X size={17} /></button></div>
      <nav>{headings.map((heading, index) => {
        const targetId = headingId(index);
        return <a key={`${heading.label}-${index}`} className={`level-${heading.level}`} href={`#${targetId}`} onClick={(event) => {
          event.preventDefault();
          document.getElementById(targetId)?.scrollIntoView({ behavior: "auto", block: "start" });
          onClose();
        }}>{heading.label}</a>;
      })}</nav>
      {note.backlinks.length ? (
        <div className="backlinks"><h2><Link2 size={14} />{uiText.outline.backlinks}</h2>{note.backlinks.map((item) => <button key={item.id} onClick={() => { onClose(); onBacklink(item.id); }}>{item.title}</button>)}</div>
      ) : null}
      <dl className="note-metadata">
        <div><dt>{uiText.outline.createdBy}</dt><dd><ActorName name={note.created_by} via={note.created_via} /></dd></div>
        <div><dt>{uiText.outline.updatedBy}</dt><dd><ActorName name={note.updated_by} via={note.updated_via} /></dd></div>
        <div><dt>{uiText.outline.createdAt}</dt><dd>{dateFormatter.format(new Date(note.created_at * 1000))}</dd></div>
        <div><dt>{uiText.outline.updatedAt}</dt><dd>{dateFormatter.format(new Date(note.updated_at * 1000))}</dd></div>
      </dl>
    </aside>
  );
}
