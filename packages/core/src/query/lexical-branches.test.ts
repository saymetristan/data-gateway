import { describe, expect, it } from 'vitest';
import {
  buildLexicalBranches,
  computeDistinctiveTermCoverage,
  extractDistinctiveTerms,
} from './lexical-branches.js';

describe('buildLexicalBranches', () => {
  it('splits long craft queries into full, phrase and distinctive branches', () => {
    const branches = buildLexicalBranches(
      'tela para bordar punto de cruz, Aida o canevá, manualidades',
    );

    expect(branches.some((branch) => branch.kind === 'full')).toBe(true);
    expect(
      branches.some((branch) => branch.kind === 'distinctive' && /^aida$/i.test(branch.text)),
    ).toBe(true);
    expect(
      branches.some((branch) => branch.kind === 'distinctive' && /canev/i.test(branch.text)),
    ).toBe(true);
    // Generic intent words should not dominate as distinctive branches.
    expect(
      branches.some(
        (branch) => branch.kind === 'distinctive' && /^manualidades$/i.test(branch.text),
      ),
    ).toBe(false);
  });

  it('adds synonym alternatives as separate branches instead of concatenating', () => {
    const branches = buildLexicalBranches('necesito aida', {
      aida: ['cuadrille aida', 'cuadrille'],
    });
    const synonymBranches = branches.filter((branch) => branch.kind === 'synonym_alt');
    expect(synonymBranches.map((branch) => branch.text.toLowerCase())).toEqual(
      expect.arrayContaining(['cuadrille aida', 'cuadrille']),
    );
    expect(branches.every((branch) => !/\baida\b.+\bcuadrille\b/i.test(branch.text))).toBe(true);
  });

  it('keeps short unique queries searchable', () => {
    const branches = buildLexicalBranches('Aida');
    expect(branches.some((branch) => /aida/i.test(branch.text))).toBe(true);
  });
});

describe('computeDistinctiveTermCoverage', () => {
  it('scores coverage of distinctive terms in top hit text', () => {
    const terms = extractDistinctiveTerms('tela Aida o canevá');
    expect(computeDistinctiveTermCoverage(terms, 'Cuadrille Aida Blanco / #14')).toBeGreaterThan(0);
    expect(computeDistinctiveTermCoverage(['Aida'], 'Algodón Navidad Digital')).toBe(0);
    expect(computeDistinctiveTermCoverage([], 'anything')).toBe(1);
  });
});
