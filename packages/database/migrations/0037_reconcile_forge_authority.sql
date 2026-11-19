-- Revisit votes from the preview even if its dry run stopped polling before
-- a policy change or escalation. Preserve operation receipts for reconciliation.
UPDATE pull_requests p SET merge_after = now()
WHERE EXISTS (
  SELECT 1 FROM reviews r WHERE r.merge_pull_request_id = p.id
    AND (r.forge_approval->>'status' IN ('approved', 'uncertain')
      OR r.merge_action IN ('writing', 'scheduled', 'uncertain')
      OR (r.merge_action = 'dry_run' AND p.state = 'open' AND EXISTS (
        SELECT 1 FROM repositories repo JOIN forge_instances f ON f.id = repo.forge_id
        WHERE repo.id = p.repository_id AND f.type = 'github'
      )))
);
