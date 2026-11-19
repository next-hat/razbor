-- Approval and native merge are separate provider operations. Existing reviews
-- have no approval intent or evidence of a forge approval.
ALTER TABLE reviews ADD COLUMN forge_approval jsonb
  CHECK (jsonb_typeof(forge_approval) = 'object');
--> statement-breakpoint
ALTER TABLE repositories ALTER COLUMN merge_policy SET DEFAULT
  '{"enabled":false,"dryRun":true,"autoApprove":false,"minimumConfidence":90,"mergeMethod":"squash","requirePassingChecks":true,"defaultBranchOnly":true,"policyMarkdown":"","humanReviewers":[]}'::jsonb;
--> statement-breakpoint
-- Materialize the existing default without changing policy versions or review snapshots.
UPDATE repositories SET merge_policy = merge_policy || '{"autoApprove":false}'::jsonb
  WHERE NOT (merge_policy ? 'autoApprove');
