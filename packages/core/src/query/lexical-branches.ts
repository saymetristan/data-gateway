import { normalizeText } from './text-utils.js';

export type LexicalBranchKind = 'full' | 'phrase' | 'distinctive' | 'synonym_alt';

export type LexicalBranch = {
  text: string;
  weight: number;
  kind: LexicalBranchKind;
};

const CONNECTOR_STOPWORDS = new Set([
  'a',
  'al',
  'con',
  'de',
  'del',
  'el',
  'en',
  'la',
  'las',
  'los',
  'o',
  'ó',
  'or',
  'para',
  'por',
  'un',
  'una',
  'unos',
  'unas',
  'y',
  'e',
  'que',
  'se',
  'su',
  'sus',
  'mi',
  'mis',
  'tu',
  'tus',
  'como',
  'mas',
  'más',
  'muy',
  'sin',
  'sobre',
  'tipo',
  'the',
  'and',
  'for',
]);

/** Generic intent words that rarely identify a specific SKU alone. */
const GENERIC_INTENT_WORDS = new Set([
  'tela',
  'telas',
  'producto',
  'productos',
  'manualidades',
  'manualidad',
  'bordar',
  'bordado',
  'punto',
  'cruz',
  'costura',
  'confeccion',
  'confección',
  'disponible',
  'disponibles',
  'buscar',
  'necesito',
  'quiero',
  'tienen',
  'hay',
]);

const BRANCH_WEIGHTS: Record<LexicalBranchKind, number> = {
  full: 1,
  phrase: 1.15,
  distinctive: 1.5,
  synonym_alt: 1.25,
};

/**
 * Split a free-text query into weighted lexical branches so long conversational
 * queries do not require every stemmed token to match (websearch AND semantics).
 *
 * Branches:
 * - full phrase (original)
 * - comma/semicolon segments
 * - alternatives joined by " o " / " ó " / " or "
 * - distinctive tokens (capitalized / longer non-stopwords)
 * - synonym alternatives for matched dictionary keys (OR lists, not concat)
 */
export function buildLexicalBranches(
  text: string,
  dictionary: Record<string, string[]> = {},
): LexicalBranch[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  const byKey = new Map<string, LexicalBranch>();
  const add = (raw: string, kind: LexicalBranchKind) => {
    const cleaned = raw.replace(/\s+/g, ' ').trim();
    if (!cleaned) return;
    const key = normalizeText(cleaned);
    if (!key) return;
    const existing = byKey.get(key);
    const weight = BRANCH_WEIGHTS[kind];
    if (!existing || weight > existing.weight) {
      byKey.set(key, { text: cleaned, weight, kind });
    }
  };

  add(trimmed, 'full');

  const segments = trimmed
    .split(/[,;|/]+/)
    .map((part) => part.trim())
    .filter(Boolean);
  for (const segment of segments) {
    if (normalizeText(segment) === normalizeText(trimmed)) continue;
    add(segment, 'phrase');
    for (const alt of splitOrAlternatives(segment)) {
      add(alt, 'distinctive');
    }
  }

  for (const alt of splitOrAlternatives(trimmed)) {
    add(alt, 'distinctive');
  }

  for (const token of extractDistinctiveTokens(trimmed)) {
    add(token, 'distinctive');
  }

  const lower = ` ${normalizeText(trimmed)} `;
  for (const [term, synonyms] of Object.entries(dictionary)) {
    const normalizedTerm = normalizeText(term);
    if (!normalizedTerm) continue;
    const needle = ` ${normalizedTerm} `;
    if (!lower.includes(needle) && !normalizeText(trimmed).includes(normalizedTerm)) {
      continue;
    }
    for (const synonym of synonyms) {
      add(synonym, 'synonym_alt');
    }
  }

  return [...byKey.values()].sort(
    (a, b) => b.weight - a.weight || a.text.localeCompare(b.text),
  );
}

/** Distinctive tokens used for confidence coverage (excludes full phrase). */
export function extractDistinctiveTerms(
  text: string,
  dictionary: Record<string, string[]> = {},
): string[] {
  return buildLexicalBranches(text, dictionary)
    .filter((branch) => branch.kind === 'distinctive' || branch.kind === 'synonym_alt')
    .map((branch) => branch.text);
}

/**
 * Fraction of distinctive terms that appear in the top hit's searchable text.
 */
export function computeDistinctiveTermCoverage(
  distinctiveTerms: string[],
  topSearchText: string | undefined,
): number {
  if (distinctiveTerms.length === 0) return 1;
  if (!topSearchText) return 0;
  const haystack = normalizeText(topSearchText);
  const hits = distinctiveTerms.filter((term) => haystack.includes(normalizeText(term)));
  return hits.length / distinctiveTerms.length;
}

function splitOrAlternatives(text: string): string[] {
  return text
    .split(/\s+(?:o|ó|or)\s+/i)
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && normalizeText(part) !== normalizeText(text));
}

function extractDistinctiveTokens(text: string): string[] {
  const tokens: string[] = [];
  const seen = new Set<string>();

  // Prefer originally capitalized words (e.g. Aida) before lowercasing.
  for (const match of text.matchAll(/\b[\p{L}][\p{L}\p{N}'-]*/gu)) {
    const raw = match[0];
    const normalized = normalizeText(raw);
    if (!isDistinctiveToken(raw, normalized)) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    tokens.push(raw);
  }

  return tokens;
}

function isDistinctiveToken(raw: string, normalized: string): boolean {
  if (normalized.length < 3) return false;
  if (CONNECTOR_STOPWORDS.has(normalized)) return false;
  if (GENERIC_INTENT_WORDS.has(normalized)) return false;
  if (/^\d+$/.test(normalized)) return false;

  const startsUpper = /^\p{Lu}/u.test(raw);
  if (startsUpper && normalized.length >= 3) return true;
  // Longer tokens that look like product names / fabric types.
  return normalized.length >= 5;
}

