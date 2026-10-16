ALTER TABLE repositories ADD COLUMN agent_id uuid REFERENCES agents(id) ON DELETE RESTRICT;
