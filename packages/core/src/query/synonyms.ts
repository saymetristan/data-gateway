import { buildLexicalBranches, type LexicalBranch } from './lexical-branches.js';

/**
 * Expand free-text with a mapping-provided synonym dictionary.
 *
 * Prefer {@link expandSynonymBranches}: appending synonyms to a single
 * websearch query makes FTS more conjunctive and can reduce recall.
 * Expansion never changes embedding text (caller responsibility).
 */
export function expandQueryWithSynonyms(
  text: string,
  dictionary: Record<string, string[]> = {},
): { expanded: string; addedTerms: string[] } {
  const branches = expandSynonymBranches(text, dictionary);
  const addedTerms = branches
    .filter((branch) => branch.kind === 'synonym_alt')
    .map((branch) => branch.text)
    .sort((a, b) => a.localeCompare(b));

  // Keep expanded as original text for backward-compatible callers.
  // Lexical retrieval should use expandSynonymBranches / buildLexicalBranches.
  return {
    expanded: text.trim(),
    addedTerms,
  };
}

/**
 * Build lexical branches including synonym alternatives as independent OR lists.
 */
export function expandSynonymBranches(
  text: string,
  dictionary: Record<string, string[]> = {},
): LexicalBranch[] {
  return buildLexicalBranches(text, dictionary);
}
