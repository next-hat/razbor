CREATE TABLE pull_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id text COLLATE "C" NOT NULL CONSTRAINT pull_requests_public_id_unique UNIQUE,
  repository_id uuid NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  number integer NOT NULL CHECK (number > 0),
  title text NOT NULL,
  url text NOT NULL,
  state text NOT NULL CHECK (state IN ('open', 'closed')),
  author text,
  head_sha text NOT NULL CHECK (head_sha ~ '^[a-f0-9]{40}([a-f0-9]{24})?$'),
  base_sha text NOT NULL CHECK (base_sha ~ '^[a-f0-9]{40}([a-f0-9]{24})?$'),
  head_branch text,
  base_branch text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  synced_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pull_request_public_id_format CHECK (public_id ~ '^pr_[A-Za-z0-9]{16}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX pull_requests_repository_number ON pull_requests(repository_id, number);
--> statement-breakpoint
CREATE INDEX pull_requests_updated ON pull_requests(updated_at);
--> statement-breakpoint
CREATE TRIGGER immutable_identity BEFORE UPDATE ON pull_requests FOR EACH ROW EXECUTE FUNCTION razbor_immutable_identity();
--> statement-breakpoint
-- Preserve captured PR history even when the provider is unavailable or the PR is closed.
-- An old review snapshot cannot establish that a PR is still open; refresh establishes that state.
INSERT INTO pull_requests (
  public_id, repository_id, number, title, url, state, author,
  head_sha, base_sha, head_branch, base_branch, created_at, updated_at, synced_at
)
SELECT DISTINCT ON (t.repository_id, (t.change->>'number')::integer)
  'pr_' || substring(r.public_id from 5), t.repository_id,
  (t.change->>'number')::integer, t.change->>'title', t.change->>'url', 'closed',
  t.change->>'author', t.change->>'headSha', t.change->>'baseSha',
  t.change->>'headBranch', t.change->>'baseBranch', r.created_at, r.created_at, r.created_at
FROM review_triggers t
JOIN reviews r ON r.id = t.review_id AND r.repository_id = t.repository_id
ORDER BY t.repository_id, (t.change->>'number')::integer, r.created_at DESC, r.public_id DESC;
