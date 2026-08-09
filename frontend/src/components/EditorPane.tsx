import { useMemo, useRef, useState } from "react";

type Props = { content: string; onChange: (content: string) => void };

export function EditorPane({ content, onChange }: Props) {
  const lines = useMemo(() => content.split("\n"), [content]);
  const lineRef = useRef<HTMLDivElement>(null);
  const [cursorLine, setCursorLine] = useState(1);

  const updateCursor = (element: HTMLTextAreaElement) => {
    setCursorLine(element.value.slice(0, element.selectionStart).split("\n").length);
  };

  return (
    <section className="editor-pane" aria-label="Markdownエディタ">
      <div className="line-numbers" ref={lineRef} aria-hidden="true">
        {lines.map((_, index) => <span key={index} className={cursorLine === index + 1 ? "current" : ""}>{index + 1}</span>)}
      </div>
      <textarea
        value={content}
        onChange={(event) => { onChange(event.target.value); updateCursor(event.target); }}
        onClick={(event) => updateCursor(event.currentTarget)}
        onKeyUp={(event) => updateCursor(event.currentTarget)}
        onScroll={(event) => { if (lineRef.current) lineRef.current.scrollTop = event.currentTarget.scrollTop; }}
        spellCheck={false}
        aria-label="Markdown本文"
      />
    </section>
  );
}
