ALTER TABLE outbox DROP CONSTRAINT outbox_kind_check;
ALTER TABLE outbox ADD CONSTRAINT outbox_kind_check
  CHECK (kind IN ('process_import','delete_project','simulate_run'));

ALTER TABLE jobs DROP CONSTRAINT jobs_kind_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_kind_check
  CHECK (kind IN ('process_import','delete_project','simulate_run'));

ALTER TABLE validation_reports
  ADD CONSTRAINT validation_reports_project_id_graph_unique
  UNIQUE (project_id, id, graph_snapshot_id);

CREATE TABLE simulation_runs (
  id uuid NOT NULL,
  project_id uuid NOT NULL REFERENCES projects(id),
  actor_id text NOT NULL REFERENCES principals(id),
  project_revision integer NOT NULL CHECK (project_revision > 0),
  graph_snapshot_id uuid NOT NULL,
  validation_report_id uuid NOT NULL,
  firmware_artifact_id uuid NOT NULL,
  firmware_review_revision integer NOT NULL,
  binding jsonb NOT NULL,
  binding_digest text NOT NULL CHECK (binding_digest ~ '^[a-f0-9]{64}$'),
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  status text NOT NULL CHECK (status IN (
    'unsupported','queued','preparing','running','stopping',
    'completed','stopped','failed','timed_out','cancelled'
  )),
  run jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, id),
  UNIQUE (project_id, idempotency_key),
  CHECK (jsonb_typeof(binding) = 'object'),
  CHECK (jsonb_typeof(run) = 'object'),
  CHECK (run->>'runId' = id::text),
  CHECK (run->>'status' = status),
  CHECK (run->'binding' = binding),
  CHECK (octet_length(run::text) <= 2000000),
  FOREIGN KEY (project_id, graph_snapshot_id)
    REFERENCES circuit_graph_snapshots(project_id, id),
  FOREIGN KEY (project_id, project_revision)
    REFERENCES revisions(project_id, revision),
  FOREIGN KEY (project_id, validation_report_id, graph_snapshot_id)
    REFERENCES validation_reports(project_id, id, graph_snapshot_id),
  FOREIGN KEY (project_id, firmware_artifact_id)
    REFERENCES firmware_artifacts(project_id, id),
  FOREIGN KEY (project_id, firmware_artifact_id, firmware_review_revision)
    REFERENCES firmware_reviews(project_id, artifact_id, project_revision)
);

CREATE INDEX simulation_runs_project_latest
  ON simulation_runs(project_id, created_at DESC, id DESC);
CREATE INDEX simulation_runs_active
  ON simulation_runs(project_id, status, created_at)
  WHERE status IN ('queued','preparing','running','stopping');

CREATE FUNCTION guard_schemora_simulation_run_update() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  graph_record circuit_graph_snapshots%ROWTYPE;
  firmware_record firmware_artifacts%ROWTYPE;
  review_decision text;
BEGIN
  IF OLD.status IN ('unsupported','completed','stopped','failed','timed_out','cancelled') THEN
    RAISE EXCEPTION 'Schemora terminal simulation runs are immutable';
  END IF;

  IF ROW(
    NEW.id, NEW.project_id, NEW.actor_id, NEW.project_revision, NEW.graph_snapshot_id,
    NEW.validation_report_id, NEW.firmware_artifact_id,
    NEW.firmware_review_revision, NEW.binding, NEW.binding_digest,
    NEW.request_digest, NEW.idempotency_key, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.id, OLD.project_id, OLD.actor_id, OLD.project_revision, OLD.graph_snapshot_id,
    OLD.validation_report_id, OLD.firmware_artifact_id,
    OLD.firmware_review_revision, OLD.binding, OLD.binding_digest,
    OLD.request_digest, OLD.idempotency_key, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'Schemora simulation run identity and input binding are immutable';
  END IF;

  IF NOT (
    (OLD.status = 'queued' AND NEW.status IN ('preparing','running','unsupported','failed','cancelled')) OR
    (OLD.status = 'preparing' AND NEW.status IN ('running','stopping','failed','timed_out','cancelled')) OR
    (OLD.status = 'running' AND NEW.status IN ('stopping','completed','stopped','failed','timed_out','cancelled')) OR
    (OLD.status = 'stopping' AND NEW.status IN ('stopped','failed','timed_out','cancelled')) OR
    (OLD.status = NEW.status AND OLD.status IN ('queued','preparing','running','stopping'))
  ) THEN
    RAISE EXCEPTION 'Invalid Schemora simulation run state transition: % -> %', OLD.status, NEW.status;
  END IF;

  SELECT * INTO graph_record FROM circuit_graph_snapshots
    WHERE project_id=NEW.project_id AND id=NEW.graph_snapshot_id;
  SELECT * INTO firmware_record FROM firmware_artifacts
    WHERE project_id=NEW.project_id AND id=NEW.firmware_artifact_id;
  SELECT decision INTO review_decision FROM firmware_reviews
    WHERE project_id=NEW.project_id AND artifact_id=NEW.firmware_artifact_id
      AND project_revision=NEW.firmware_review_revision;

  IF graph_record.id IS NULL OR firmware_record.id IS NULL OR review_decision IS DISTINCT FROM 'accepted' THEN
    RAISE EXCEPTION 'Schemora simulation run references invalid or unaccepted inputs';
  END IF;
  IF NEW.project_revision IS DISTINCT FROM graph_record.project_revision THEN
    RAISE EXCEPTION 'Schemora simulation project revision does not match its graph snapshot';
  END IF;
  IF NEW.binding->>'projectId' IS DISTINCT FROM NEW.project_id::text OR
     NEW.binding->>'graphId' IS DISTINCT FROM NEW.graph_snapshot_id::text OR
     NEW.binding->>'graphDigest' IS DISTINCT FROM graph_record.graph_digest OR
     NEW.binding->>'projectRevision' IS DISTINCT FROM graph_record.project_revision::text OR
     NEW.binding->>'firmwareArtifactId' IS DISTINCT FROM NEW.firmware_artifact_id::text OR
     NEW.binding->>'firmwareDigest' IS DISTINCT FROM firmware_record.sha256 OR
     NEW.binding->>'catalogReleaseId' IS DISTINCT FROM firmware_record.catalog_release_id THEN
    RAISE EXCEPTION 'Schemora simulation binding does not match referenced inputs';
  END IF;

  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER simulation_runs_guard_update
  BEFORE UPDATE ON simulation_runs
  FOR EACH ROW EXECUTE FUNCTION guard_schemora_simulation_run_update();

CREATE FUNCTION guard_schemora_simulation_run_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  graph_record circuit_graph_snapshots%ROWTYPE;
  firmware_record firmware_artifacts%ROWTYPE;
  review_decision text;
BEGIN
  SELECT * INTO graph_record FROM circuit_graph_snapshots
    WHERE project_id=NEW.project_id AND id=NEW.graph_snapshot_id;
  SELECT * INTO firmware_record FROM firmware_artifacts
    WHERE project_id=NEW.project_id AND id=NEW.firmware_artifact_id;
  SELECT decision INTO review_decision FROM firmware_reviews
    WHERE project_id=NEW.project_id AND artifact_id=NEW.firmware_artifact_id
      AND project_revision=NEW.firmware_review_revision;
  IF graph_record.id IS NULL OR firmware_record.id IS NULL OR review_decision IS DISTINCT FROM 'accepted' THEN
    RAISE EXCEPTION 'Schemora simulation runs require valid inputs and an accepted firmware review';
  END IF;
  IF NEW.project_revision IS DISTINCT FROM graph_record.project_revision THEN
    RAISE EXCEPTION 'Schemora simulation project revision does not match its graph snapshot';
  END IF;
  IF NEW.binding->>'projectId' IS DISTINCT FROM NEW.project_id::text OR
     NEW.binding->>'graphId' IS DISTINCT FROM NEW.graph_snapshot_id::text OR
     NEW.binding->>'graphDigest' IS DISTINCT FROM graph_record.graph_digest OR
     NEW.binding->>'projectRevision' IS DISTINCT FROM graph_record.project_revision::text OR
     NEW.binding->>'firmwareArtifactId' IS DISTINCT FROM NEW.firmware_artifact_id::text OR
     NEW.binding->>'firmwareDigest' IS DISTINCT FROM firmware_record.sha256 OR
     NEW.binding->>'catalogReleaseId' IS DISTINCT FROM firmware_record.catalog_release_id THEN
    RAISE EXCEPTION 'Schemora simulation binding does not match referenced inputs';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER simulation_runs_guard_insert
  BEFORE INSERT ON simulation_runs
  FOR EACH ROW EXECUTE FUNCTION guard_schemora_simulation_run_insert();
