ALTER TABLE console_users ALTER COLUMN password_hash DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE console_users ADD COLUMN oidc_issuer text;
--> statement-breakpoint
ALTER TABLE console_users ADD COLUMN oidc_subject text;
--> statement-breakpoint
ALTER TABLE console_users ADD CONSTRAINT console_user_authentication CHECK (
  (oidc_issuer IS NULL AND oidc_subject IS NULL AND password_hash IS NOT NULL)
  OR
  (oidc_issuer IS NOT NULL AND oidc_subject IS NOT NULL AND password_hash IS NULL AND must_change_password = false)
);
--> statement-breakpoint
CREATE UNIQUE INDEX console_users_oidc_identity_unique ON console_users(oidc_issuer, oidc_subject);
