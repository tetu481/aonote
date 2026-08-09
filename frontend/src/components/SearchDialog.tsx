import { FileText, Search, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { SearchResult } from "../types";

export function SearchDialog({ open, onClose, onSelect }: { open: boolean; onClose: () => void; onSelect: (id: string) => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    window.setTimeout(() => inputRef.current?.focus(), 20);
  }, [open]);

  useEffect(() => {
    if (!open || !query.trim()) { setResults([]); return; }
    let active = true;
    const timer = window.setTimeout(() => {
      api.search(query).then((data) => { if (active) setResults(data.results); }).catch(() => { if (active) setResults([]); });
    }, 180);
    return () => { active = false; window.clearTimeout(timer); };
  }, [open, query]);

  if (!open) return null;
  return (
    <div className="dialog-backdrop" onMouseDown={onClose} role="presentation">
      <section className="search-dialog" role="dialog" aria-modal="true" aria-label="ノートを検索" onMouseDown={(event) => event.stopPropagation()}>
        <div className="search-input"><Search size={20} /><input ref={inputRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="タイトルと本文を検索…" /><button onClick={onClose} aria-label="閉じる"><X size={18} /></button></div>
        <div className="search-results">
          {query && results.length === 0 ? <p className="empty-search">一致するノートはありません</p> : null}
          {results.map((item) => (
            <button key={item.id} onClick={() => { onSelect(item.id); onClose(); }}>
              <FileText size={18} /><span><strong>{item.title}</strong><small dangerouslySetInnerHTML={{ __html: item.snippet }} /></span><kbd>↵</kbd>
            </button>
          ))}
          {!query ? <div className="search-hint"><span>SQLite FTS5でノート全体を検索します</span><kbd>esc</kbd><span>で閉じる</span></div> : null}
        </div>
      </section>
    </div>
  );
}
