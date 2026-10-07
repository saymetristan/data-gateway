import { sql, type SQL } from 'drizzle-orm';

// ECMAScript \s, including Unicode spaces, translated to a PostgreSQL ARE class.
const whitespace =
  '\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff';
export const NR_ITEM_NAME_PATTERN = `^[${whitespace}]*N\\.R(\\.|[${whitespace}]|$)`;

/**
 * Server-owned visibility: independent of mapping defaults and request filters.
 * The inventory SKU set is uncorrelated so PostgreSQL can hash it once, without
 * scanning the product catalog for every inventory row. Missing SKUs stay visible.
 */
export function buildCatalogVisibilityCondition(workspaceId: string): SQL {
  return sql`NOT (
    EXISTS (
      SELECT 1 FROM workspaces visibility_workspace
      WHERE visibility_workspace.id = r.workspace_id
        AND visibility_workspace.slug = ${'tractodiesel'}
    )
    AND (
      (r.entity = 'product' AND coalesce(r.data->>'item_name', '') ~* ${NR_ITEM_NAME_PATTERN})
      OR (
        r.entity = 'inventory' AND coalesce((r.source_id, r.data->>'item_code') IN (
          SELECT visibility_product.source_id, visibility_product.data->>'item_code'
          FROM records visibility_product
          WHERE visibility_product.workspace_id = ${workspaceId}
            AND visibility_product.entity = 'product'
            AND coalesce(visibility_product.data->>'item_name', '') ~* ${NR_ITEM_NAME_PATTERN}
        ), false)
      )
    )
  )`;
}
