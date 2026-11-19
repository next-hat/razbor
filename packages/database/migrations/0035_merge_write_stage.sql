-- NULL on existing actions preserves uncertainty about which provider writes were dispatched.
-- A pre-restack development install may already have the same constrained column.
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS merge_write_stage text
  CHECK (merge_write_stage IN ('prepared','creating_check','submitting','armed','releasing','acknowledged'));
