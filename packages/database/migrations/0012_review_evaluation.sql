ALTER TABLE reviews ADD COLUMN evaluation jsonb NOT NULL DEFAULT '{"included":false,"findings":{}}'::jsonb;
--> statement-breakpoint
ALTER TABLE reviews ADD CONSTRAINT review_evaluation_object CHECK (jsonb_typeof(evaluation) = 'object');
