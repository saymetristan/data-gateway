import type { MappingField } from '../schemas/mapping.js';
import { getFieldRetrieval } from '../schemas/mapping.js';
import { normalizeText } from './text-utils.js';

export type QueryConcept = {
  term: string;
  alternatives: string[];
};

export type HitRelevanceInput = {
  retrievalScore: number;
  maxRetrievalScore: number;
  vectorDistance?: number;
  exactIdentifier?: boolean;
  data: Record<string, unknown>;
  fields: MappingField[];
  concepts: QueryConcept[];
};

export type HitRelevance = {
  score: number;
  termCoverage: number;
  primaryFieldCoverage: number;
  vectorSimilarity?: number;
  constraintConflict: boolean;
};

const TOKEN_STOPWORDS = new Set([
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
  'para',
  'por',
  'un',
  'una',
  'y',
]);

const SEARCH_WEIGHT: Record<'A' | 'B' | 'C' | 'D', number> = {
  A: 1,
  B: 0.75,
  C: 0.5,
  D: 0.25,
};

export function buildQueryConcepts(
  text: string,
  dictionary: Record<string, string[]> = {},
): QueryConcept[] {
  const normalizedQuery = normalizeText(text);
  if (!normalizedQuery) return [];

  const concepts: QueryConcept[] = [];
  const consumedTokens = new Set<string>();
  const entries = Object.entries(dictionary).sort(
    ([left], [right]) => normalizeText(right).length - normalizeText(left).length,
  );

  for (const [term, aliases] of entries) {
    const normalizedTerm = normalizeText(term);
    if (!normalizedTerm || !containsTerm(normalizedQuery, normalizedTerm)) continue;
    const alternatives = [...new Set([term, ...aliases].map(normalizeText).filter(Boolean))];
    concepts.push({ term: normalizedTerm, alternatives });
    for (const token of tokenize(normalizedTerm)) consumedTokens.add(token);
  }

  for (const token of tokenize(normalizedQuery)) {
    if (consumedTokens.has(token) || TOKEN_STOPWORDS.has(token) || /^\d+$/.test(token)) {
      continue;
    }
    if (token.length < 2) continue;
    concepts.push({ term: token, alternatives: [token] });
  }

  const unique = new Map<string, QueryConcept>();
  for (const concept of concepts) {
    const key = concept.alternatives.join('|');
    if (!unique.has(key)) unique.set(key, concept);
  }
  return [...unique.values()];
}

export function computeHitRelevance(input: HitRelevanceInput): HitRelevance {
  if (input.exactIdentifier) {
    return {
      score: 1,
      termCoverage: 1,
      primaryFieldCoverage: 1,
      constraintConflict: false,
    };
  }

  const searchable = input.fields.filter(
    (field) => field.searchable && !field.sensitive,
  );
  const weightedTexts = searchable.flatMap((field) => {
    const value = input.data[field.name];
    const text = valueToSearchText(value);
    if (!text) return [];
    const tier = getFieldRetrieval(field).searchWeight;
    return [{ text: normalizeText(text), weight: SEARCH_WEIGHT[tier], tier }];
  });
  const primaryTexts = weightedTexts
    .filter((field) => field.tier === 'A')
    .map((field) => field.text);

  const termCoverage = coverage(input.concepts, (concept) => {
    let strongest = 0;
    for (const field of weightedTexts) {
      if (matchesConcept(field.text, concept)) strongest = Math.max(strongest, field.weight);
    }
    return strongest;
  });
  const primaryFieldCoverage = coverage(input.concepts, (concept) =>
    primaryTexts.some((text) => matchesConcept(text, concept)) ? 1 : 0,
  );
  const normalizedRetrieval =
    input.maxRetrievalScore > 0
      ? clamp01(input.retrievalScore / input.maxRetrievalScore)
      : 0;
  const vectorSimilarity =
    input.vectorDistance === undefined
      ? undefined
      : clamp01(1 - input.vectorDistance);
  const queryConstraints = extractQuantifiedConstraints(
    input.concepts.flatMap((concept) => concept.alternatives).join(' '),
  );
  const candidateConstraints = extractQuantifiedConstraints(
    weightedTexts.map((field) => field.text).join(' '),
  );
  const constraintConflict = queryConstraints.some((expected) => {
    const candidates = candidateConstraints.filter(
      (candidate) => candidate.family === expected.family,
    );
    return (
      candidates.length > 0 &&
      candidates.every((candidate) => candidate.value !== expected.value)
    );
  });

  const weightedSignals: Array<{ value: number; weight: number }> = [
    { value: normalizedRetrieval, weight: 0.35 },
    { value: termCoverage, weight: 0.4 },
    { value: primaryFieldCoverage, weight: 0.2 },
  ];
  if (vectorSimilarity !== undefined) {
    weightedSignals.push({ value: vectorSimilarity, weight: 0.05 });
  }
  const totalWeight = weightedSignals.reduce((sum, signal) => sum + signal.weight, 0);
  const blendedScore =
    totalWeight === 0
      ? 0
      : weightedSignals.reduce(
          (sum, signal) => sum + signal.value * signal.weight,
          0,
        ) / totalWeight;
  const score = constraintConflict ? blendedScore * 0.35 : blendedScore;

  return {
    score: round4(clamp01(score)),
    termCoverage: round4(termCoverage),
    primaryFieldCoverage: round4(primaryFieldCoverage),
    constraintConflict,
    ...(vectorSimilarity !== undefined
      ? { vectorSimilarity: round4(vectorSimilarity) }
      : {}),
  };
}

type QuantifiedConstraint = {
  family: 'liters' | 'strokes';
  value: number;
};

function extractQuantifiedConstraints(text: string): QuantifiedConstraint[] {
  const normalized = normalizeText(text);
  const constraints: QuantifiedConstraint[] = [];
  for (const match of normalized.matchAll(
    /\b(\d+(?:[.,]\d+)?)\s*(?:l|lt|lts|litro|litros)\b/g,
  )) {
    const value = Number(match[1]?.replace(',', '.'));
    if (Number.isFinite(value)) constraints.push({ family: 'liters', value });
  }
  for (const match of normalized.matchAll(
    /\b([24])\s*(?:t|tiempo|tiempos)\b/g,
  )) {
    const value = Number(match[1]);
    if (Number.isFinite(value)) constraints.push({ family: 'strokes', value });
  }
  return constraints;
}

function coverage(
  concepts: QueryConcept[],
  strength: (concept: QueryConcept) => number,
): number {
  if (concepts.length === 0) return 1;
  return clamp01(
    concepts.reduce((sum, concept) => sum + clamp01(strength(concept)), 0) /
      concepts.length,
  );
}

function matchesConcept(text: string, concept: QueryConcept): boolean {
  return concept.alternatives.some((alternative) => containsTerm(text, alternative));
}

function containsTerm(text: string, term: string): boolean {
  if (!text || !term) return false;
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(text);
}

function tokenize(text: string): string[] {
  return normalizeText(text).match(/[a-z0-9]+/g) ?? [];
}

function valueToSearchText(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string | number => typeof item === 'string' || typeof item === 'number')
      .join(' ');
  }
  return '';
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function round4(value: number): number {
  return Number(value.toFixed(4));
}
