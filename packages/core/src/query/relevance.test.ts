import { describe, expect, it } from 'vitest';
import type { MappingField } from '../schemas/mapping.js';
import { buildQueryConcepts, computeHitRelevance } from './relevance.js';

const fields: MappingField[] = [
  {
    name: 'item_code',
    sourceColumn: 'item_code',
    type: 'string',
    searchable: true,
    filterable: true,
    visible: true,
    sensitive: false,
    identifier: true,
    retrieval: {
      cardinality: 'one',
      match: 'eq',
      inferredBehavior: 'filter',
      boost: 0.2,
      searchWeight: 'A',
    },
  },
  {
    name: 'item_name',
    sourceColumn: 'item_name',
    type: 'string',
    searchable: true,
    filterable: false,
    visible: true,
    sensitive: false,
    retrieval: {
      cardinality: 'one',
      match: 'eq',
      inferredBehavior: 'search',
      boost: 0,
      searchWeight: 'A',
    },
  },
  {
    name: 'description',
    sourceColumn: 'description',
    type: 'string',
    searchable: true,
    filterable: false,
    visible: true,
    sensitive: false,
    retrieval: {
      cardinality: 'one',
      match: 'eq',
      inferredBehavior: 'search',
      boost: 0,
      searchWeight: 'B',
    },
  },
];

describe('descriptive hit relevance', () => {
  it('separa el sensor correcto de reparaciones que solo comparten modelos', () => {
    const concepts = buildQueryConcepts('Sensor presión ambiente L10 M11 N14');
    const correct = score(
      {
        item_code: '4902720',
        item_name: 'SENSOR PRESION AMBIENTE L10 M11 N14',
      },
      concepts,
    );
    const repair = score(
      {
        item_code: 'IFM11E1M',
        item_name: 'MEDIA REPARACION CUMMINS L10 M11',
      },
      concepts,
    );

    expect(correct.score).toBeGreaterThan(repair.score);
    expect(correct.primaryFieldCoverage).toBe(1);
    expect(repair.primaryFieldCoverage).toBeLessThan(0.5);
  });

  it('agrupa aliases de presentación sin inflar el denominador', () => {
    const concepts = buildQueryConcepts(
      'aceite Mobil tapa amarilla cubeta 19 litros',
      {
        cubeta: ['cub'],
        '19 litros': ['19 lts', '19 lt', '19l'],
      },
    );
    const nineteenLiters = score(
      {
        item_code: '1300',
        item_name: 'ACEITE MOBIL DIESEL 15W40 CK-4 19 LTS',
      },
      concepts,
    );
    const fiveLiters = score(
      {
        item_code: '1300-5',
        item_name: 'ACEITE MOBIL DIESEL 15W40 CK-4 5 LTS',
      },
      concepts,
    );
    const superficial = score(
      {
        item_code: '64195-N',
        item_name: 'TAPA EJE FRUEHAUF PARA ACEITE',
      },
      concepts,
    );
    const twoHundredLiters = score(
      {
        item_code: '122746',
        item_name: 'TAMBOR DE ACEITE MOBIL 15W40 DE 200 LITROS',
      },
      concepts,
    );

    expect(nineteenLiters.score).toBeGreaterThan(fiveLiters.score);
    expect(nineteenLiters.score).toBeGreaterThan(superficial.score);
    expect(twoHundredLiters.constraintConflict).toBe(true);
    expect(nineteenLiters.score).toBeGreaterThan(twoHundredLiters.score);
  });

  it('rechaza evidencia exclusiva de una descripción contaminada', () => {
    const concepts = buildQueryConcepts('aceite para motocicleta 4 tiempos', {
      motocicleta: ['moto', 'motos'],
      '4 tiempos': ['4t'],
    });
    const contaminated = score(
      {
        item_code: '06416',
        item_name: 'JERGA SARGA LIGERA AZUL',
        description: 'ACEITE CASTROL 10W40 MOTOS 4T',
      },
      concepts,
    );
    const twoStroke = score(
      {
        item_code: 'O00087-001',
        item_name: 'ACEITE AFOSA 2 TIEMPOS',
      },
      concepts,
    );

    expect(contaminated.termCoverage).toBeGreaterThan(0.5);
    expect(contaminated.primaryFieldCoverage).toBe(0);
    expect(twoStroke.constraintConflict).toBe(true);
    expect(twoStroke.score).toBeLessThan(contaminated.score);
  });

  it('reserva score uno para identificadores exactos', () => {
    const relevance = computeHitRelevance({
      retrievalScore: 0.01,
      maxRetrievalScore: 0.02,
      exactIdentifier: true,
      data: { item_code: '4902720' },
      fields,
      concepts: buildQueryConcepts('codigo 4902720'),
    });
    expect(relevance.score).toBe(1);
  });
});

function score(
  data: Record<string, unknown>,
  concepts: ReturnType<typeof buildQueryConcepts>,
) {
  return computeHitRelevance({
    retrievalScore: 0.03,
    maxRetrievalScore: 0.03,
    vectorDistance: 0.25,
    data,
    fields,
    concepts,
  });
}
