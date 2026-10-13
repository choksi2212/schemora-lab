CREATE TABLE firmware_artifacts (
  id uuid NOT NULL,
  project_id uuid NOT NULL REFERENCES projects(id),
  project_revision integer NOT NULL,
  actor_id text NOT NULL REFERENCES principals(id),
  object_key uuid NOT NULL UNIQUE,
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  byte_length integer NOT NULL CHECK (byte_length BETWEEN 1 AND 2000000),
  language text NOT NULL CHECK (language IN ('c','cpp','arduino-cpp','esp-idf-c')),
  entrypoint text NOT NULL CHECK (length(entrypoint) BETWEEN 1 AND 200),
  board_part_id text NOT NULL CHECK (length(board_part_id) BETWEEN 1 AND 200),
  catalog_release_id text NOT NULL CHECK (length(catalog_release_id) BETWEEN 1 AND 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, id),
  FOREIGN KEY (project_id, project_revision)
    REFERENCES revisions(project_id, revision) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX firmware_artifacts_project_latest
  ON firmware_artifacts(project_id, created_at DESC, id);

CREATE TABLE firmware_reviews (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  artifact_id uuid NOT NULL,
  project_revision integer NOT NULL,
  actor_id text NOT NULL REFERENCES principals(id),
  decision text NOT NULL CHECK (decision IN ('accepted','rejected')),
  reason text CHECK (reason IS NULL OR length(reason) <= 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, artifact_id, project_revision),
  FOREIGN KEY (project_id, artifact_id)
    REFERENCES firmware_artifacts(project_id, id),
  FOREIGN KEY (project_id, project_revision)
    REFERENCES revisions(project_id, revision) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX firmware_reviews_latest
  ON firmware_reviews(project_id, artifact_id, project_revision DESC);

CREATE FUNCTION reject_schemora_firmware_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Schemora firmware artifacts and review decisions are immutable';
END;
$$;
CREATE TRIGGER firmware_artifacts_immutable
  BEFORE UPDATE ON firmware_artifacts
  FOR EACH ROW EXECUTE FUNCTION reject_schemora_firmware_update();
CREATE TRIGGER firmware_reviews_immutable
  BEFORE UPDATE ON firmware_reviews
  FOR EACH ROW EXECUTE FUNCTION reject_schemora_firmware_update();
