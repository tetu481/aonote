// Keep preview rendering and outline parsing on the same Markdown input.
export function prepareMarkdown(markdown: string) {
  const replacements: Array<{ start: number; end: number; sourceEnd: number }> = [];
  let delta = 0;
  const content = markdown.replace(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g, (match: string, target: string, alias: string | undefined, offset: number) => {
    const label = alias || target.trim();
    const replacement = `[${label}](#wikilink-${encodeURIComponent(target.trim())})`;
    replacements.push({ start: offset + delta, end: offset + delta + replacement.length, sourceEnd: offset + match.length });
    delta += replacement.length - match.length;
    return replacement;
  });
  return {
    content,
    sourceOffset(offset: number): number | null {
      let shift = 0;
      for (const replacement of replacements) {
        if (offset < replacement.start) break;
        // Generated Wiki-link markup must never become an editable task.
        if (offset < replacement.end) return null;
        shift = replacement.end - replacement.sourceEnd;
      }
      return offset - shift;
    },
  };
}

export function normalizeWikilinks(markdown: string) {
  return prepareMarkdown(markdown).content;
}
