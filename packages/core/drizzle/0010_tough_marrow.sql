CREATE INDEX IF NOT EXISTS "record_embeddings_model_version_idx"
ON "record_embeddings" USING btree ("embedding_model", "mapping_version");
