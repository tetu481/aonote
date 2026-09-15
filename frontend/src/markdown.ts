// Keep preview rendering and outline parsing on the same Markdown input.
export function normalizeWikilinks(markdown: string) {
  return markdown.replace(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g, (_match, target: string, alias?: string) => {
    const label = alias || target.trim();
    return `[${label}](#wikilink-${encodeURIComponent(target.trim())})`;
  });
}
