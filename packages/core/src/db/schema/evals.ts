import { pgTable, uuid, text, jsonb, doublePrecision, timestamp, index } from 'drizzle-orm/pg-core';
import { workspaces } from './workspaces.js';
import { sources } from './sources.js';

export const evalSets = pgTable(
  'eval_sets',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    sourceId: uuid('source_id').references(() => sources.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    threshold: doublePrecision('threshold').notNull().default(0.8),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('eval_sets_workspace_id_idx').on(table.workspaceId),
    index('eval_sets_source_id_idx').on(table.sourceId),
  ],
);

export const evalCases = pgTable(
  'eval_cases',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    evalSetId: uuid('eval_set_id')
      .notNull()
      .references(() => evalSets.id, { onDelete: 'cascade' }),
    query: text('query').notNull(),
    expectedResultIds: jsonb('expected_result_ids'),
    mustApplyFilters: jsonb('must_apply_filters'),
    mustNotContainFields: jsonb('must_not_contain_fields'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('eval_cases_eval_set_id_idx').on(table.evalSetId)],
);

export const evalRuns = pgTable(
  'eval_runs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    evalSetId: uuid('eval_set_id')
      .notNull()
      .references(() => evalSets.id, { onDelete: 'cascade' }),
    status: text('status').notNull(),
    metrics: jsonb('metrics').notNull().default({}),
    passed: jsonb('passed'),
    failed: jsonb('failed'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (table) => [index('eval_runs_eval_set_id_idx').on(table.evalSetId)],
);

export type EvalSet = typeof evalSets.$inferSelect;
export type EvalCase = typeof evalCases.$inferSelect;
export type EvalRun = typeof evalRuns.$inferSelect;
