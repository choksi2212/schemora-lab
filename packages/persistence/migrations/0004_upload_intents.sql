CREATE TABLE upload_intents (
  object_key uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now()+interval '15 minutes'
);
CREATE INDEX upload_intents_expiry ON upload_intents(expires_at);
CREATE INDEX upload_intents_project ON upload_intents(project_id);
