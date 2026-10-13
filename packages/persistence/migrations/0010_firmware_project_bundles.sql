-- Multi-file firmware snapshots preserve the original artifact columns as the
-- immutable entrypoint object's digest and byte count for legacy clients.
ALTER TABLE firmware_artifacts
  ADD COLUMN bundle_digest text CHECK (bundle_digest IS NULL OR bundle_digest ~ '^[a-f0-9]{64}$'),
  ADD COLUMN total_byte_length integer,
  ADD COLUMN build_system text CHECK (build_system IS NULL OR build_system IN ('arduino-cli','esp-idf')),
  ADD COLUMN target jsonb;

UPDATE firmware_artifacts SET total_byte_length=byte_length;
ALTER TABLE firmware_artifacts ALTER COLUMN total_byte_length SET NOT NULL;
ALTER TABLE firmware_artifacts ADD CONSTRAINT firmware_artifact_total_length_check
  CHECK (total_byte_length BETWEEN 1 AND 8000000);
ALTER TABLE firmware_artifacts ADD CONSTRAINT firmware_artifact_bundle_identity_check
  CHECK ((build_system IS NULL AND target IS NULL AND bundle_digest IS NULL)
      OR (build_system IS NOT NULL AND target IS NOT NULL AND bundle_digest IS NOT NULL));
ALTER TABLE firmware_artifacts ADD CONSTRAINT firmware_artifact_target_build_system_check
  CHECK (build_system IS NULL OR
    (build_system='arduino-cli' AND target->>'kind'='arduino-fqbn' AND language='arduino-cpp') OR
    (build_system='esp-idf' AND target->>'kind'='esp-idf-target' AND language IN ('esp-idf-c','cpp')));
ALTER TABLE firmware_artifacts DROP CONSTRAINT firmware_artifacts_entrypoint_check;
ALTER TABLE firmware_artifacts ADD CONSTRAINT firmware_artifacts_entrypoint_check
  CHECK (length(entrypoint) BETWEEN 1 AND 240);

CREATE TABLE firmware_artifact_files (
  project_id uuid NOT NULL,
  artifact_id uuid NOT NULL,
  path text NOT NULL CHECK (length(path) BETWEEN 1 AND 240),
  object_key uuid NOT NULL UNIQUE,
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  byte_length integer NOT NULL CHECK (byte_length BETWEEN 1 AND 2000000),
  is_entrypoint boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, artifact_id, path),
  FOREIGN KEY (project_id, artifact_id)
    REFERENCES firmware_artifacts(project_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX firmware_artifact_files_one_entrypoint
  ON firmware_artifact_files(project_id, artifact_id) WHERE is_entrypoint;
CREATE INDEX firmware_artifact_files_object_key ON firmware_artifact_files(object_key);
INSERT INTO firmware_artifact_files(
  project_id,artifact_id,path,object_key,sha256,byte_length,is_entrypoint
)
SELECT project_id,id,entrypoint,object_key,sha256,byte_length,true FROM firmware_artifacts;
CREATE UNIQUE INDEX firmware_artifact_files_casefolded_path
  ON firmware_artifact_files(project_id, artifact_id, lower(path));
ALTER TABLE firmware_artifacts ADD CONSTRAINT firmware_artifact_target_object_check
  CHECK (target IS NULL OR jsonb_typeof(target) = 'object');

CREATE FUNCTION verify_schemora_firmware_bundle_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  artifact firmware_artifacts%ROWTYPE;
  artifact_identity uuid;
  files_count integer;
  total_bytes bigint;
  entrypoint_record firmware_artifact_files%ROWTYPE;
BEGIN
  artifact_identity := coalesce(to_jsonb(NEW)->>'id',to_jsonb(NEW)->>'artifact_id')::uuid;
  SELECT * INTO artifact FROM firmware_artifacts
    WHERE project_id=NEW.project_id AND id=artifact_identity;
  IF artifact.id IS NULL THEN RETURN NULL; END IF;
  SELECT count(*)::int,coalesce(sum(byte_length),0)
    INTO files_count,total_bytes FROM firmware_artifact_files
    WHERE project_id=artifact.project_id AND artifact_id=artifact.id;
  SELECT * INTO entrypoint_record FROM firmware_artifact_files
    WHERE project_id=artifact.project_id AND artifact_id=artifact.id
      AND path=artifact.entrypoint AND is_entrypoint;
  IF files_count < 1 OR files_count > CASE WHEN artifact.bundle_digest IS NULL THEN 1 ELSE 128 END OR
     total_bytes <> artifact.total_byte_length OR
     entrypoint_record.path IS NULL OR entrypoint_record.object_key <> artifact.object_key OR
     entrypoint_record.sha256 <> artifact.sha256 OR entrypoint_record.byte_length <> artifact.byte_length OR
     (SELECT count(*) FROM firmware_artifact_files
       WHERE project_id=artifact.project_id AND artifact_id=artifact.id AND is_entrypoint) <> 1 OR
     (artifact.bundle_digest IS NULL AND files_count <> 1) THEN
    RAISE EXCEPTION 'Schemora firmware bundle rows do not match the immutable manifest metadata';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER firmware_bundle_artifact_complete
  AFTER INSERT ON firmware_artifacts DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION verify_schemora_firmware_bundle_snapshot();
CREATE CONSTRAINT TRIGGER firmware_bundle_files_complete
  AFTER INSERT ON firmware_artifact_files DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION verify_schemora_firmware_bundle_snapshot();

CREATE FUNCTION guard_schemora_firmware_artifact_file_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'Schemora firmware artifact file records are immutable';
  END IF;
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 AND EXISTS (
    SELECT 1 FROM projects WHERE id=OLD.project_id AND status='deleting'
  ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Schemora firmware artifact files may only be removed by project purge';
END;
$$;
CREATE TRIGGER firmware_artifact_files_immutable
  BEFORE UPDATE OR DELETE ON firmware_artifact_files
  FOR EACH ROW EXECUTE FUNCTION guard_schemora_firmware_artifact_file_mutation();

-- The existing SHA field remains the entrypoint object hash. Bundle-backed
-- runs bind the canonical whole-manifest digest and aggregate source length.
CREATE OR REPLACE FUNCTION guard_schemora_simulation_run_update() RETURNS trigger LANGUAGE plpgsql AS $$
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
    NEW.validation_report_id, NEW.firmware_artifact_id, NEW.firmware_review_revision,
    NEW.binding, NEW.binding_digest, NEW.request_digest, NEW.idempotency_key, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.id, OLD.project_id, OLD.actor_id, OLD.project_revision, OLD.graph_snapshot_id,
    OLD.validation_report_id, OLD.firmware_artifact_id, OLD.firmware_review_revision,
    OLD.binding, OLD.binding_digest, OLD.request_digest, OLD.idempotency_key, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'Schemora simulation run identity and input binding are immutable';
  END IF;
  IF NOT (
    (OLD.status = 'queued' AND NEW.status IN ('preparing','running','unsupported','failed','cancelled')) OR
    (OLD.status = 'preparing' AND NEW.status IN ('running','stopping','failed','timed_out','cancelled')) OR
    (OLD.status = 'running' AND NEW.status IN ('stopping','completed','stopped','failed','timed_out','cancelled')) OR
    (OLD.status = 'stopping' AND NEW.status IN ('stopped','failed','timed_out','cancelled')) OR
    (OLD.status = NEW.status AND OLD.status IN ('queued','preparing','running','stopping'))
  ) THEN RAISE EXCEPTION 'Invalid Schemora simulation run state transition: % -> %', OLD.status, NEW.status; END IF;
  SELECT * INTO graph_record FROM circuit_graph_snapshots WHERE project_id=NEW.project_id AND id=NEW.graph_snapshot_id;
  SELECT * INTO firmware_record FROM firmware_artifacts WHERE project_id=NEW.project_id AND id=NEW.firmware_artifact_id;
  SELECT decision INTO review_decision FROM firmware_reviews
    WHERE project_id=NEW.project_id AND artifact_id=NEW.firmware_artifact_id AND project_revision=NEW.firmware_review_revision;
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
     NEW.binding->>'firmwareDigest' IS DISTINCT FROM coalesce(firmware_record.bundle_digest,firmware_record.sha256) OR
     coalesce(NEW.binding->>'firmwareByteLength',firmware_record.byte_length::text) IS DISTINCT FROM firmware_record.total_byte_length::text OR
     NEW.binding->>'catalogReleaseId' IS DISTINCT FROM firmware_record.catalog_release_id THEN
    RAISE EXCEPTION 'Schemora simulation binding does not match referenced inputs';
  END IF;
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION guard_schemora_simulation_run_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  graph_record circuit_graph_snapshots%ROWTYPE;
  firmware_record firmware_artifacts%ROWTYPE;
  review_decision text;
BEGIN
  SELECT * INTO graph_record FROM circuit_graph_snapshots WHERE project_id=NEW.project_id AND id=NEW.graph_snapshot_id;
  SELECT * INTO firmware_record FROM firmware_artifacts WHERE project_id=NEW.project_id AND id=NEW.firmware_artifact_id;
  SELECT decision INTO review_decision FROM firmware_reviews
    WHERE project_id=NEW.project_id AND artifact_id=NEW.firmware_artifact_id AND project_revision=NEW.firmware_review_revision;
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
     NEW.binding->>'firmwareDigest' IS DISTINCT FROM coalesce(firmware_record.bundle_digest,firmware_record.sha256) OR
     coalesce(NEW.binding->>'firmwareByteLength',firmware_record.byte_length::text) IS DISTINCT FROM firmware_record.total_byte_length::text OR
     NEW.binding->>'catalogReleaseId' IS DISTINCT FROM firmware_record.catalog_release_id THEN
    RAISE EXCEPTION 'Schemora simulation binding does not match referenced inputs';
  END IF;
  RETURN NEW;
END;
$$;
