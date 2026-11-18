ALTER TABLE repositories ADD COLUMN codebase_memory_enabled boolean NOT NULL DEFAULT true;
--> statement-breakpoint
ALTER TABLE review_attempts ADD COLUMN codebase_memory_enabled boolean NOT NULL DEFAULT true;
--> statement-breakpoint
-- A ready persistent workspace indexes its own checkout. An indexed temporary
-- workspace pins the PR head and a separately indexed branch, as in 0002.
-- A source-only temporary workspace pins the PR head and has no index SHA.
ALTER TABLE index_workspaces DROP CONSTRAINT workspace_revision_binding,
  ADD CONSTRAINT workspace_revision_binding CHECK (
    state <> 'ready' OR (
      head_sha IS NOT NULL AND (temporary OR (index_sha IS NOT NULL AND index_sha = head_sha))
    )
  );
--> statement-breakpoint
-- Update only pristine copies of the packaged, editable account guide. The
-- seed may disambiguate its name, so normalize that one line for comparison.
UPDATE skills
SET files = jsonb_set(files, '{SKILL.md}', to_jsonb(replace(replace(
      files->>'SKILL.md',
      ' Graph results locate evidence but do not establish current PR behavior or exhaustive coverage.', ''),
      'partial index coverage', 'incomplete inspection'))),
    version = version + 1, updated_at = now()
WHERE default_review_guide AND version = 1
  AND files - 'SKILL.md' = '{}'::jsonb
  AND sha256(convert_to(replace(files->>'SKILL.md', 'name: ' || name || chr(10),
    'name: razbor-core-review-guide' || chr(10)), 'UTF8')) =
    decode('b0681eb2f8ff5193f1adb44a9647a42889103b92e4c55f393b1665c44e38e34a', 'hex');
