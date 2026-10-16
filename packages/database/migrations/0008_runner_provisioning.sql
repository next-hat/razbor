ALTER TABLE runners
  ADD COLUMN provisioning_key text UNIQUE,
  ADD COLUMN provisioning_hash text,
  ADD CONSTRAINT runner_provisioning_key_format CHECK (provisioning_key ~ '^[A-Za-z0-9_-]{1,64}$'),
  ADD CONSTRAINT runner_provisioning_hash_format CHECK (provisioning_hash ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT runner_provisioning_binding CHECK ((provisioning_key IS NULL) = (provisioning_hash IS NULL));
