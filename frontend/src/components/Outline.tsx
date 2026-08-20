import { Link2, X } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import { extractOutlineHeadings, headingId } from "../remarkHeadingIds";
import type { Note } from "../types";

const dateFormatter = new Intl.DateTimeFormat("ja-JP", {
  dateStyle: "medium",
  timeStyle: "short",
});

function ActorName({ name, via }: { name: string; via: string | null }) {
  const tooltip = via ? `${via}経由` : undefined;
  return <span className="actor-name" data-tooltip={tooltip} tabIndex={via ? 0 : undefined}>{name}</span>;
}

type Props = {
  note: Note;
  drawerOpen: boolean;
  desktopVisible: boolean;
  onClose: () => void;
  onBacklink: (id: string) => void;
};

export function Outline({ note, drawerOpen, desktopVisible, onClose, onBacklink }: Props) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const headings = useMemo(() => extractOutlineHeadings(note.content), [note.content]);
  useEffect(() => {
    if (drawerOpen) closeRef.current?.focus();
  }, [drawerOpen]);
  return (
    <aside className={`outline-panel ${desktopVisible ? "" : "desktop-hidden"} ${drawerOpen ? "drawer-open" : ""}`} id="note-outline" aria-label="ノートの目次と情報">
      <div className="outline-heading"><h2>目次</h2><button ref={closeRef} className="outline-close" onClick={onClose} aria-label="目次を閉じる"><X size={17} /></button></div>
      <nav>{headings.map((heading, index) => {
        const targetId = headingId(index);
        return <a key={`${heading.label}-${index}`} className={`level-${heading.level}`} href={`#${targetId}`} onClick={(event) => {
          event.preventDefault();
          document.getElementById(targetId)?.scrollIntoView({ behavior: "auto", block: "start" });
          onClose();
        }}>{heading.label}</a>;
      })}</nav>
      {note.backlinks.length ? (
        <div className="backlinks"><h2><Link2 size={14} />バックリンク</h2>{note.backlinks.map((item) => <button key={item.id} onClick={() => { onClose(); onBacklink(item.id); }}>{item.title}</button>)}</div>
      ) : null}
      <dl className="note-metadata">
        <div><dt>作成者</dt><dd><ActorName name={note.created_by} via={note.created_via} /></dd></div>
        <div><dt>修正者</dt><dd><ActorName name={note.updated_by} via={note.updated_via} /></dd></div>
        <div><dt>作成日時</dt><dd>{dateFormatter.format(new Date(note.created_at * 1000))}</dd></div>
        <div><dt>変更日時</dt><dd>{dateFormatter.format(new Date(note.updated_at * 1000))}</dd></div>
      </dl>
    </aside>
  );
}
