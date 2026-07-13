/**
 * Versioned synonym dictionary for fabric/textile domain (Bayon).
 * Expansion is applied before lexical search only — never changes embedding text.
 */
export const FABRIC_SYNONYM_DICT_VERSION = 'fabrics-v1';

const FABRIC_SYNONYMS: Record<string, string[]> = {
  vinipiel: ['piel sintetica', 'cuero sintetico', 'vinilo'],
  visillo: ['translucido', 'cortina ligera', 'tergal'],
  retapizar: ['tapiceria', 'tapizar'],
  tapiceria: ['retapizar', 'tapizar'],
  blackout: ['oscurante', 'bloqueo luz'],
  lino: ['linen'],
  terciopelo: ['velvet'],
  microfibra: ['micro fibra'],
  jacquard: ['jacar'],
  pana: ['corduroy'],
};

/**
 * Expand free-text with domain synonyms. Deterministic, no LLM.
 * Only expands whole-word matches of dictionary keys.
 */
export function expandQueryWithSynonyms(
  text: string,
  dictionary: Record<string, string[]> = FABRIC_SYNONYMS,
): { expanded: string; addedTerms: string[] } {
  const trimmed = text.trim();
  if (!trimmed) return { expanded: trimmed, addedTerms: [] };

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
