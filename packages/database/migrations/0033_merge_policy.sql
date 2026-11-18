-- PR #5 and the original PR #6 recorded different SQL at the same timestamp.
-- Preserve the published preview's policy data by applying only its missing PR #5 DDL.
DO $stacked_migration$
BEGIN
  IF EXISTS (SELECT 1 FROM drizzle.__drizzle_migrations WHERE created_at = 1790000000031
             AND hash = '7708f6b258ac9c27160054b61e554311e97110557368b43f2475f208d96d7dbd') THEN
    ALTER TABLE webhook_deliveries ADD COLUMN pending_open jsonb, ADD COLUMN open_retry_after timestamptz;
    CREATE INDEX delivery_due_open ON webhook_deliveries (open_retry_after) WHERE open_retry_after IS NOT NULL;
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM drizzle.__drizzle_migrations WHERE created_at = 1790000000031
                 AND hash = '7c8b78c4b7a11fd6160bdba64cf0c63f1e954c1195a0f1515184290346f90d01') THEN
    RAISE EXCEPTION 'Unrecognized migration history at 0031. Preserve the database and verify the installed migration before retrying.';
  END IF;

ALTER TABLE repositories
  ADD COLUMN merge_policy jsonb NOT NULL DEFAULT '{"enabled":false,"dryRun":true,"minimumConfidence":90,"mergeMethod":"squash","requirePassingChecks":true,"defaultBranchOnly":true,"policyMarkdown":"","humanReviewers":[]}' CHECK (jsonb_typeof(merge_policy) = 'object'),
  ADD COLUMN merge_policy_version integer NOT NULL DEFAULT 1 CHECK (merge_policy_version > 0);
ALTER TABLE pull_requests
  ADD COLUMN merge_revision integer NOT NULL DEFAULT 1,
  ADD COLUMN merge_after timestamptz,
  ADD COLUMN human_escalated boolean NOT NULL DEFAULT false,
  ADD COLUMN escalation_comment jsonb;
ALTER TABLE reviews
  ADD COLUMN merge_pull_request_id uuid REFERENCES pull_requests(id) ON DELETE SET NULL,
  ADD COLUMN merge_decision jsonb,
  ADD COLUMN merge_action text CHECK (merge_action IN ('dry_run','writing','scheduled','merged','uncertain','refused'));
-- Link old code reviews for history only. They have no trusted policy snapshot.
UPDATE reviews r SET merge_pull_request_id = p.id FROM pull_requests p
WHERE r.repository_id = p.repository_id AND r.source->>'conversation' IS NULL
  AND (r.source->'pullRequest'->>'number' = p.number::text OR EXISTS (
    SELECT 1 FROM review_triggers t WHERE t.review_id = r.id AND t.repository_id = p.repository_id
      AND t.change->>'number' = p.number::text));
CREATE INDEX reviews_merge_pr_latest ON reviews(merge_pull_request_id, created_at DESC, public_id DESC) WHERE merge_pull_request_id IS NOT NULL;
CREATE INDEX pull_requests_merge_due ON pull_requests(merge_after) WHERE merge_after IS NOT NULL;
CREATE TABLE merge_decision_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id uuid NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  decided_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  decision jsonb NOT NULL,
  action text
);
CREATE INDEX merge_decision_history_review ON merge_decision_history(review_id, decided_at);
-- Capture observed revision transitions, including an ABA head change or reopening.
CREATE FUNCTION razbor_merge_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.head_sha, NEW.base_sha, NEW.head_branch, NEW.base_branch, NEW.merge_base,
         NEW.start_sha, NEW.state, NEW.draft)
     IS DISTINCT FROM ROW(OLD.head_sha, OLD.base_sha, OLD.head_branch, OLD.base_branch,
                          OLD.merge_base, OLD.start_sha, OLD.state, OLD.draft) THEN
    NEW.merge_revision := OLD.merge_revision + 1;
    NEW.merge_after := now();
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER merge_revision BEFORE UPDATE OF head_sha, base_sha, head_branch, base_branch, merge_base, start_sha, state, draft
ON pull_requests FOR EACH ROW EXECUTE FUNCTION razbor_merge_revision();
CREATE FUNCTION razbor_queue_merge_review() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE pull_requests SET merge_after = now() WHERE id = NEW.merge_pull_request_id;
  RETURN NEW;
END $$;
CREATE TRIGGER queue_merge_review AFTER INSERT OR UPDATE OF source ON reviews
FOR EACH ROW WHEN (NEW.merge_pull_request_id IS NOT NULL) EXECUTE FUNCTION razbor_queue_merge_review();
CREATE FUNCTION razbor_record_merge_decision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO merge_decision_history(review_id, decision, action)
    VALUES (NEW.id, NEW.merge_decision, NEW.merge_action);
  RETURN NEW;
END $$;
CREATE TRIGGER record_merge_decision AFTER UPDATE OF merge_decision,merge_action ON reviews
FOR EACH ROW WHEN (NEW.merge_decision IS NOT NULL AND (OLD.merge_decision IS DISTINCT FROM NEW.merge_decision OR OLD.merge_action IS DISTINCT FROM NEW.merge_action))
EXECUTE FUNCTION razbor_record_merge_decision();
UPDATE pull_requests p SET merge_after = now()
WHERE p.state = 'open' AND EXISTS (SELECT 1 FROM reviews r WHERE r.merge_pull_request_id = p.id);
CREATE TABLE merge_escalation_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pull_request_id uuid NOT NULL REFERENCES pull_requests(id) ON DELETE CASCADE,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  remote_id text NOT NULL,
  body text NOT NULL
);
CREATE FUNCTION razbor_record_escalation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO merge_escalation_history(pull_request_id, remote_id, body)
    VALUES (NEW.id, NEW.escalation_comment->>'remoteId', NEW.escalation_comment->>'shownBody');
  RETURN NEW;
END $$;
CREATE TRIGGER record_escalation AFTER UPDATE OF escalation_comment ON pull_requests
FOR EACH ROW WHEN (NEW.escalation_comment->>'shownBody' IS NOT NULL AND
  OLD.escalation_comment->>'shownBody' IS DISTINCT FROM NEW.escalation_comment->>'shownBody')
EXECUTE FUNCTION razbor_record_escalation();
END $stacked_migration$;
