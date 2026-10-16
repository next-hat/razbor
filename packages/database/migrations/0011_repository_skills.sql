CREATE TABLE skills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id text COLLATE "C" NOT NULL CONSTRAINT skills_public_id_unique UNIQUE,
  name text NOT NULL,
  description text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  files jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT skill_public_id_format CHECK (public_id ~ '^skl_[A-Za-z0-9]{16}$'),
  CONSTRAINT skill_name CHECK (length(name) BETWEEN 1 AND 64 AND name ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  CONSTRAINT skill_description CHECK (length(description) BETWEEN 1 AND 1000),
  CONSTRAINT skill_version CHECK (version > 0),
  CONSTRAINT skill_files_object CHECK (jsonb_typeof(files) = 'object')
);
--> statement-breakpoint
CREATE UNIQUE INDEX skills_name_unique ON skills(name);
--> statement-breakpoint
CREATE TRIGGER immutable_identity BEFORE UPDATE ON skills FOR EACH ROW EXECUTE FUNCTION razbor_immutable_identity();
--> statement-breakpoint
ALTER TABLE repositories ADD COLUMN guidance jsonb;
--> statement-breakpoint
ALTER TABLE repositories ADD CONSTRAINT repository_guidance_object CHECK (guidance IS NULL OR jsonb_typeof(guidance) = 'object');
