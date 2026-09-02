ALTER TABLE "eval_cases" ADD COLUMN "must_not_appear_in_top" jsonb;--> statement-breakpoint
ALTER TABLE "eval_cases" ADD COLUMN "max_result_count" integer;--> statement-breakpoint
ALTER TABLE "eval_cases" ADD COLUMN "max_confidence" double precision;--> statement-breakpoint
ALTER TABLE "eval_cases" ADD COLUMN "must_contain_fields" jsonb;