CREATE TABLE import_artifacts (
  project_id uuid NOT NULL REFERENCES projects(id),
  digest text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('bundle','extraction')),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(project_id,digest)
);
ALTER TABLE imports ADD COLUMN bundle_digest text;
ALTER TABLE imports ADD COLUMN extraction_digest text;
ALTER TABLE imports ADD COLUMN extraction_mode text CHECK (extraction_mode IN ('deterministic','provider'));
CREATE INDEX reviews_latest_candidate ON reviews(project_id,import_id,candidate_id,revision DESC);
