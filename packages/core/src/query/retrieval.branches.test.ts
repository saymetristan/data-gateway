import { describe, expect, it } from 'vitest';
import { resolveLexicalFusionWeight } from '../services/query.js';
import { buildLexicalBranches } from './lexical-branches.js';
import { fuseLexicalAndVector, selectLexicalBranches } from './retrieval.js';
import { reciprocalRankFusion } from './rrf.js';

describe('selectLexicalBranches', () => {
  it('keeps the full branch and highest-weight distinctive/synonym branches', () => {
    const branches = buildLexicalBranches(
      'tela para bordar punto de cruz, Aida o canevá, manualidades',
      { aida: ['cuadrille aida', 'cuadrille'], caneva: ['etamina'] },
    );
    const selected = selectLexicalBranches(branches);
    expect(selected.length).toBeLessThanOrEqual(6);
    expect(selected.some((branch) => branch.kind === 'full')).toBe(true);
    expect(selected.some((branch) => /aida/i.test(branch.text))).toBe(true);
  });

  it('reserves branch budget for identifier-like policy aliases', () => {
    const branches = buildLexicalBranches(
      'aceite Mobil tapa amarilla cubeta 19 litros',
      {
        '19 litros': ['19 lts', '19l', '120035', 'MX15W40', '1300'],
      },
    );
    const selected = selectLexicalBranches(branches);
    const selectedTexts = selected.map((branch) => branch.text);

    expect(selected).toHaveLength(6);
    expect(selectedTexts).toEqual(
      expect.arrayContaining(['MX15W40', '120035', '1300']),
    );
  });
});

describe('multi-branch RRF preference for distinctive hits', () => {
  it('lets a distinctive-term ranking outrank a weak full-phrase empty/error path', () => {
    // Full phrase matched nothing; distinctive "Aida" matched catalog rows.
    const fused = reciprocalRankFusion([
      { ids: [], weight: 1 },
      { ids: ['aida-1', 'aida-2'], weight: 1.5 },
      { ids: ['aros-1', 'navidad-1'], weight: 1.1 },
    ]);
    expect(fused[0]?.id).toBe('aida-1');
  });

  it('boosts lexical fusion weight when distinctive terms hit', () => {
    const boosted = resolveLexicalFusionWeight(
      1,
      [{ search_source: 'Cuadrille Aida Blanco' }],
      ['Aida'],
    );
    expect(boosted).toBeGreaterThanOrEqual(1.45);

    const plain = resolveLexicalFusionWeight(
      1,
      [{ search_source: 'Algodón Navidad Digital' }],
      ['Aida'],
    );
    expect(plain).toBe(1);
  });

  it('keeps an exact identifier match ahead of vector neighbors', () => {
    const result = fuseLexicalAndVector({
      lexicalRows: [
        {
          id: 'exact',
          entity: 'product',
          source_id: 'source-1',
          data: { sku: 'FF-213' },
          search_source: 'Filtro FF-213',
          identifier_match: true,
        },
      ],
      vectorRows: [
        {
          id: 'semantic',
          entity: 'product',
          source_id: 'source-1',
          data: { sku: 'OTHER' },
          search_source: 'Filtro semánticamente cercano',
          distance: 0.01,
        },
      ],
      limit: 5,
    });

    expect(result.hits[0]?.id).toBe('exact');
    expect(result.hits[0]?.score).toBe(1);
  });
});
