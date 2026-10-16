ALTER TABLE "agents" ADD COLUMN "reasoning_effort" text NOT NULL DEFAULT 'high';
--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agent_reasoning_effort" CHECK ("reasoning_effort" IN ('low', 'medium', 'high'));
