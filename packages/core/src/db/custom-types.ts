import { customType } from 'drizzle-orm/pg-core';

export const tsvector = customType<{ data: string }>({
  dataType() {
    return 'tsvector';
  },
});

export const vector1024 = customType<{ data: number[] }>({
  dataType() {
    return 'vector(1024)';
  },
});
