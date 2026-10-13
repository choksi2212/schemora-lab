-- A job lease can be reclaimed after expiry. Persist the identity and immutable
-- dispatch inputs for each claim so responses from an earlier claim cannot
-- update the run after a retry takes ownership.
CREATE TABLE simulation_run_attempts (
  project_id uuid NOT NULL,
  run_id uuid NOT NULL,
  job_id uuid NOT NULL REFERENCES jobs(id),
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  attempt_id uuid NOT NULL,
  payload_digest text NOT NULL CHECK (payload_digest ~ '^[a-f0-9]{64}$'),
  execution_profile_id text NOT NULL CHECK (length(execution_profile_id) BETWEEN 1 AND 100),
  image_digest text NOT NULL CHECK (image_digest ~ '^sha256:[a-f0-9]{64}$'),
  binding_digest text NOT NULL CHECK (binding_digest ~ '^[a-f0-9]{64}$'),
  request_jti uuid NOT NULL,
  requested_at timestamptz NOT NULL,
  not_before timestamptz NOT NULL,
  deadline_at timestamptz NOT NULL,
  state text NOT NULL CHECK (state IN ('dispatched','accepted','running','completed','failed','cancelled','superseded')),
  response_jti uuid,
  response_digest text CHECK (response_digest IS NULL OR response_digest ~ '^[a-f0-9]{64}$'),
  response_issued_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (project_id, run_id, attempt_number),
  UNIQUE (project_id, job_id, attempt_number),
  UNIQUE (attempt_id),
  FOREIGN KEY (project_id, run_id) REFERENCES simulation_runs(project_id, id),
  CHECK (not_before <= deadline_at),
  CHECK ((response_jti IS NULL) = (response_digest IS NULL)),
  CHECK ((response_jti IS NULL) = (response_issued_at IS NULL))
);

CREATE INDEX simulation_run_attempts_job_current
  ON simulation_run_attempts(project_id, job_id, attempt_number DESC);
CREATE INDEX simulation_run_attempts_response_jti
  ON simulation_run_attempts(response_jti) WHERE response_jti IS NOT NULL;

CREATE FUNCTION guard_schemora_simulation_run_attempt_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.project_id, NEW.run_id, NEW.job_id, NEW.attempt_number, NEW.attempt_id,
         NEW.payload_digest, NEW.execution_profile_id, NEW.image_digest, NEW.binding_digest,
         NEW.request_jti, NEW.requested_at, NEW.not_before, NEW.deadline_at, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.project_id, OLD.run_id, OLD.job_id, OLD.attempt_number, OLD.attempt_id,
         OLD.payload_digest, OLD.execution_profile_id, OLD.image_digest, OLD.binding_digest,
         OLD.request_jti, OLD.requested_at, OLD.not_before, OLD.deadline_at, OLD.created_at) THEN
    RAISE EXCEPTION 'Schemora simulation attempt identity is immutable';
  END IF;
  IF OLD.state IN ('completed','failed','cancelled','superseded') AND NEW.state <> OLD.state THEN
    RAISE EXCEPTION 'Schemora terminal simulation attempts are immutable';
  END IF;
  IF NOT ((OLD.state='dispatched' AND NEW.state IN ('accepted','running','completed','failed','cancelled','superseded')) OR
          (OLD.state='accepted' AND NEW.state IN ('running','completed','failed','cancelled','superseded')) OR
          (OLD.state='running' AND NEW.state IN ('running','completed','failed','cancelled','superseded')) OR
          OLD.state=NEW.state) THEN
    RAISE EXCEPTION 'Invalid Schemora simulation attempt transition: % -> %', OLD.state, NEW.state;
  END IF;
  NEW.updated_at = clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER simulation_run_attempts_guard_update
  BEFORE UPDATE ON simulation_run_attempts
  FOR EACH ROW EXECUTE FUNCTION guard_schemora_simulation_run_attempt_update();
