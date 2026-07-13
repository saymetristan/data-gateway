/**
 * Expand free-text with a mapping-provided synonym dictionary.
 * Expansion is applied before lexical search only — never changes embedding text.
 */
export function expandQueryWithSynonyms(
  text: string,
  dictionary: Record<string, string[]> = {},
): { expanded: string; addedTerms: string[] } {
  const trimmed = text.trim();
  if (!trimmed || Object.keys(dictionary).length === 0) {
    return { expanded: trimmed, addedTerms: [] };
  }

  const lower = trimmed.toLowerCase();
  const added = new Set<string>();

  for (const [term, synonyms] of Object.entries(dictionary)) {
    const pattern = new RegExp(`(?:^|\\s)${escapeRegExp(term)}(?:$|\\s|[.,;:!?])`, 'i');
    if (!pattern.test(lower)) continue;
    for (const synonym of synonyms) {
      if (!lower.includes(synonym.toLowerCase())) {
        added.add(synonym);
      }
    }
  }

  if (added.size === 0) {
    return { expanded: trimmed, addedTerms: [] };
  }

  const addedTerms = [...added].sort((a, b) => a.localeCompare(b));
  return {
    expanded: `${trimmed} ${addedTerms.join(' ')}`,
    addedTerms,
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
