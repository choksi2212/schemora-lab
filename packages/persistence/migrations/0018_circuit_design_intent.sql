CREATE TABLE circuit_design_intent_versions (
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version_id uuid NOT NULL,
  graph_snapshot_id uuid NOT NULL,
  confirmed_by text NOT NULL REFERENCES principals(id),
  confirmed_project_revision integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, version_id),
  FOREIGN KEY (project_id, graph_snapshot_id)
    REFERENCES circuit_graph_snapshots(project_id, id),
  FOREIGN KEY (project_id, confirmed_project_revision)
    REFERENCES revisions(project_id, revision) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE project_circuit_design_intents (
  project_id uuid PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  version_id uuid NOT NULL,
  FOREIGN KEY (project_id, version_id)
    REFERENCES circuit_design_intent_versions(project_id, version_id)
);
