CREATE TABLE circuit_graph_snapshots (
  id uuid NOT NULL,
  project_id uuid NOT NULL REFERENCES projects(id),
  project_revision integer NOT NULL,
  actor_id text NOT NULL REFERENCES principals(id),
  graph jsonb NOT NULL,
  graph_digest text NOT NULL CHECK (graph_digest ~ '^[a-f0-9]{64}$'),
  idempotency_key text NOT NULL,
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, id),
  UNIQUE (project_id, project_revision),
  UNIQUE (project_id, idempotency_key),
  FOREIGN KEY (project_id, project_revision)
    REFERENCES revisions(project_id, revision) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX circuit_graph_project_latest ON circuit_graph_snapshots(project_id, project_revision DESC);

CREATE FUNCTION reject_schemora_snapshot_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Schemora graph snapshots and validation reports are immutable';
END;
$$;
CREATE TRIGGER circuit_graph_snapshots_immutable
  BEFORE UPDATE ON circuit_graph_snapshots
  FOR EACH ROW EXECUTE FUNCTION reject_schemora_snapshot_update();

CREATE TABLE validation_reports (
  id uuid NOT NULL,
  project_id uuid NOT NULL,
  graph_snapshot_id uuid NOT NULL,
  expected_project_revision integer NOT NULL,
  actor_id text NOT NULL REFERENCES principals(id),
  input_identity jsonb NOT NULL,
  input_identity_digest text NOT NULL CHECK (input_identity_digest ~ '^[a-f0-9]{64}$'),
  report jsonb NOT NULL,
  report_digest text NOT NULL CHECK (report_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, id),
  UNIQUE (project_id, graph_snapshot_id, input_identity_digest),
  FOREIGN KEY (project_id, graph_snapshot_id)
    REFERENCES circuit_graph_snapshots(project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, expected_project_revision)
    REFERENCES revisions(project_id, revision) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX validation_reports_project_latest ON validation_reports(project_id, created_at DESC, id);
CREATE TRIGGER validation_reports_immutable
  BEFORE UPDATE ON validation_reports
  FOR EACH ROW EXECUTE FUNCTION reject_schemora_snapshot_update();
