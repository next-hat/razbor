ALTER TABLE "agents" ADD COLUMN "provider" text NOT NULL DEFAULT 'openai';
--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agent_provider" CHECK ("provider" IN ('openai', 'anthropic'));
