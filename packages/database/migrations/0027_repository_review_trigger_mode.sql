ALTER TABLE repositories
  ADD COLUMN review_trigger_mode text NOT NULL DEFAULT 'manual',
  ADD CONSTRAINT repository_review_trigger_mode
    CHECK (review_trigger_mode IN ('manual', 'opt_in_continuous', 'automatic'));
--> statement-breakpoint
-- Existing Forgejo hooks need the separate pull_request_sync subscription.
UPDATE repository_webhooks AS hook
SET setup = 'pending', updated_at = now()
FROM repositories AS repo
JOIN forge_instances AS forge ON forge.id = repo.forge_id
WHERE hook.repository_id = repo.id AND repo.status = 'active' AND forge.type = 'forgejo'
  AND hook.enabled AND hook.mode = 'managed' AND hook.setup = 'ready';
