CREATE TABLE assembly_plan_snapshots (
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  graph_snapshot_id uuid NOT NULL,
  validation_report_id uuid NOT NULL,
  project_revision integer NOT NULL,
  plan_digest text NOT NULL CHECK (plan_digest ~ '^[a-f0-9]{64}$'),
  plan jsonb NOT NULL,
  actor_id text NOT NULL REFERENCES principals(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, id),
  UNIQUE (project_id, plan_digest),
  FOREIGN KEY (project_id, graph_snapshot_id)
    REFERENCES circuit_graph_snapshots(project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, validation_report_id)
    REFERENCES validation_reports(project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, project_revision)
    REFERENCES revisions(project_id, revision) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX assembly_plan_snapshots_latest
  ON assembly_plan_snapshots(project_id, created_at DESC, id);
CREATE TRIGGER assembly_plan_snapshots_immutable
  BEFORE UPDATE ON assembly_plan_snapshots
  FOR EACH ROW EXECUTE FUNCTION reject_schemora_snapshot_update();

CREATE TABLE assembly_plan_progress_events (
  event_sequence bigserial NOT NULL UNIQUE,
  project_id uuid NOT NULL,
  id uuid NOT NULL,
  plan_id uuid NOT NULL,
  actor_id text NOT NULL REFERENCES principals(id),
  idempotency_key uuid NOT NULL,
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  target text NOT NULL CHECK (target IN ('step', 'pre_power_check')),
  target_id text NOT NULL CHECK (length(target_id) BETWEEN 1 AND 240),
  state text NOT NULL CHECK (state IN ('confirmed', 'skipped', 'not_started', 'checked', 'unchecked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, id),
  UNIQUE (project_id, idempotency_key),
  FOREIGN KEY (project_id, plan_id)
    REFERENCES assembly_plan_snapshots(project_id, id) ON DELETE CASCADE,
  CHECK ((target = 'step' AND state IN ('confirmed', 'skipped', 'not_started')) OR
         (target = 'pre_power_check' AND state IN ('checked', 'unchecked')))
);
CREATE INDEX assembly_plan_progress_latest
  ON assembly_plan_progress_events(project_id, plan_id, target, target_id, event_sequence DESC);
CREATE TRIGGER assembly_plan_progress_events_immutable
  BEFORE UPDATE ON assembly_plan_progress_events
  FOR EACH ROW EXECUTE FUNCTION reject_schemora_snapshot_update();
