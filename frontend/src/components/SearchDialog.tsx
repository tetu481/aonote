import { FileText, Search, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { uiText } from "../locales";
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
      <section className="search-dialog" role="dialog" aria-modal="true" aria-label={uiText.search.dialogLabel} onMouseDown={(event) => event.stopPropagation()}>
        <div className="search-input"><Search size={20} /><input ref={inputRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={uiText.search.placeholder} /><button onClick={onClose} aria-label={uiText.search.close}><X size={18} /></button></div>
        <div className="search-results">
          {query && results.length === 0 ? <p className="empty-search">{uiText.search.noResults}</p> : null}
          {results.map((item) => (
            <button key={item.id} onClick={() => { onSelect(item.id); onClose(); }}>
              <FileText size={18} /><span><strong>{item.title}</strong><small dangerouslySetInnerHTML={{ __html: item.snippet }} /></span><kbd>{uiText.search.openResultKey}</kbd>
            </button>
          ))}
          {!query ? <div className="search-hint"><span>{uiText.search.hint}</span><kbd>{uiText.search.escapeKey}</kbd><span>{uiText.search.closeSuffix}</span></div> : null}
        </div>
      </section>
    </div>
  );
}
