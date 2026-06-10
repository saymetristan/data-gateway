DO $$ BEGIN
  CREATE ROLE gateway_app NOINHERIT NOBYPASSRLS;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
GRANT gateway_app TO CURRENT_USER;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO gateway_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO gateway_app;--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO gateway_app;
