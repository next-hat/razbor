ALTER TABLE console_users ALTER COLUMN username DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE console_users ADD COLUMN display_name text;
--> statement-breakpoint
ALTER TABLE console_users ADD COLUMN email text;
--> statement-breakpoint
UPDATE console_users
SET display_name = substring(username FROM '^oidc-(.+)-[a-f0-9]{32}$'),
    username = NULL
WHERE oidc_issuer IS NOT NULL;
--> statement-breakpoint
ALTER TABLE console_users DROP CONSTRAINT console_user_authentication;
--> statement-breakpoint
ALTER TABLE console_users ADD CONSTRAINT console_user_authentication CHECK (
  (oidc_issuer IS NULL AND oidc_subject IS NULL AND password_hash IS NOT NULL AND username IS NOT NULL)
  OR
  (oidc_issuer IS NOT NULL AND oidc_subject IS NOT NULL AND password_hash IS NULL AND username IS NULL AND must_change_password = false)
);
