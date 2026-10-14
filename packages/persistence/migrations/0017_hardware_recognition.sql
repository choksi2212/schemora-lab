ALTER TABLE outbox DROP CONSTRAINT outbox_kind_check;
ALTER TABLE outbox ADD CONSTRAINT outbox_kind_check
  CHECK (kind IN ('process_import','delete_project','simulate_run','delete_hardware_photo','process_hardware_recognition'));

ALTER TABLE jobs DROP CONSTRAINT jobs_kind_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_kind_check
  CHECK (kind IN ('process_import','delete_project','simulate_run','delete_hardware_photo','process_hardware_recognition'));

CREATE TABLE hardware_recognition_requests (
  id uuid NOT NULL,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  photo_id uuid NOT NULL,
  project_revision integer NOT NULL,
  actor_id text NOT NULL REFERENCES principals(id),
  consent_version text NOT NULL CHECK (consent_version='photo-recognition-remote-v1'),
  provider_id text NOT NULL CHECK (provider_id='vultr-inference'),
  model_id text NOT NULL CHECK (model_id='qwen3.8-27b'),
  catalog_release_id text NOT NULL,
  notice_revision text NOT NULL CHECK (length(notice_revision) BETWEEN 1 AND 64),
  image_sha256 text NOT NULL CHECK (image_sha256 ~ '^[a-f0-9]{64}$'),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','completed','failed','cancelled')),
  outcome text CHECK (outcome IN ('exact-candidate','ambiguous','unknown','unsupported','unclear')),
  proposal jsonb,
  error_code text CHECK (error_code IS NULL OR error_code ~ '^[A-Z_]{1,64}$'),
  consented_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (project_id,id),
  FOREIGN KEY (project_id,photo_id) REFERENCES hardware_photos(project_id,id) ON DELETE CASCADE,
  FOREIGN KEY (project_id,project_revision) REFERENCES revisions(project_id,revision) DEFERRABLE INITIALLY DEFERRED,
  CHECK ((status='completed') = (proposal IS NOT NULL AND outcome IS NOT NULL)),
  CHECK (status='completed' OR (proposal IS NULL AND outcome IS NULL)),
  CHECK (status <> 'failed' OR error_code IS NOT NULL),
  CHECK (status <> 'cancelled' OR proposal IS NULL)
);
CREATE INDEX hardware_recognition_project_latest
  ON hardware_recognition_requests(project_id,created_at DESC,id);
CREATE INDEX hardware_recognition_photo
  ON hardware_recognition_requests(project_id,photo_id);

CREATE TABLE hardware_inventory (
  id uuid NOT NULL,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  project_revision integer NOT NULL,
  actor_id text NOT NULL REFERENCES principals(id),
  catalog_release_id text NOT NULL,
  catalog_part_id text NOT NULL,
  recognition_id uuid,
  label text NOT NULL CHECK (length(label) BETWEEN 1 AND 120),
  linked_component_id text,
  linked_graph_snapshot_id uuid,
  confirmed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id,id),
  FOREIGN KEY (project_id,project_revision) REFERENCES revisions(project_id,revision) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (project_id,linked_graph_snapshot_id) REFERENCES circuit_graph_snapshots(project_id,id),
  CHECK ((linked_component_id IS NULL) = (linked_graph_snapshot_id IS NULL))
  -- Keep the request UUID as provenance even after photo deletion purges its proposal row.
  -- The confirmed inventory remains a user-owned assertion independent of provider evidence.
);
CREATE UNIQUE INDEX hardware_inventory_recognition_once
  ON hardware_inventory(project_id,recognition_id) WHERE recognition_id IS NOT NULL;
CREATE UNIQUE INDEX hardware_inventory_component_once
  ON hardware_inventory(project_id,linked_component_id) WHERE linked_component_id IS NOT NULL;
CREATE INDEX hardware_inventory_project_latest
  ON hardware_inventory(project_id,confirmed_at DESC,id);
