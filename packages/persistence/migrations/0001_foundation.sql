CREATE TABLE principals (
  id text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE projects (
  id uuid PRIMARY KEY,
  owner_id text NOT NULL REFERENCES principals(id),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  status text NOT NULL CHECK (status IN ('active','archived','deleting','deleted')),
  revision integer NOT NULL CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX projects_owner_page ON projects(owner_id, created_at DESC, id);
CREATE TABLE revisions (
  project_id uuid NOT NULL REFERENCES projects(id),
  revision integer NOT NULL,
  kind text NOT NULL,
  actor_id text NOT NULL REFERENCES principals(id),
  snapshot jsonb NOT NULL,
  digest text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, revision)
);
CREATE TABLE imports (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id),
  filename text NOT NULL,
  object_key uuid NOT NULL UNIQUE,
  source_digest text NOT NULL,
  status text NOT NULL CHECK (status IN ('queued','processing','awaiting_selection','ready','failed','cancelled')),
  selected_conversation_id text,
  bundle jsonb,
  extraction jsonb,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX imports_project ON imports(project_id, created_at DESC);
CREATE TABLE reviews (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id),
  import_id uuid NOT NULL REFERENCES imports(id),
  candidate_id text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('accept','reject','correct','obsolete')),
  value text,
  reason text,
  actor_id text NOT NULL REFERENCES principals(id),
  revision integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reviews_project_import ON reviews(project_id, import_id, revision);
CREATE TABLE idempotency (
  owner_id text NOT NULL REFERENCES principals(id),
  scope text NOT NULL,
  key text NOT NULL,
  request_digest text NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(owner_id, scope, key)
);
CREATE TABLE outbox (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id),
  kind text NOT NULL CHECK (kind IN ('process_import','delete_project')),
  payload jsonb NOT NULL,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX outbox_pending ON outbox(created_at) WHERE delivered_at IS NULL;
CREATE TABLE jobs (
  id uuid PRIMARY KEY REFERENCES outbox(id),
  project_id uuid NOT NULL REFERENCES projects(id),
  kind text NOT NULL CHECK (kind IN ('process_import','delete_project')),
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','completed','failed','cancelled')),
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  lease_token uuid,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jobs_claim ON jobs(kind,status,available_at,created_at);
