-- Compiler results are immutable snapshots of a source manifest and a pinned
-- compiler profile. Binary contents remain private objects; PostgreSQL stores
-- only bounded integrity metadata and the normalized result contract.
CREATE TABLE firmware_builds (
  project_id uuid NOT NULL REFERENCES projects(id),
  id uuid NOT NULL,
  source_artifact_id uuid NOT NULL,
  source_manifest_digest text NOT NULL CHECK (source_manifest_digest ~ '^[a-f0-9]{64}$'),
  compiler_profile_id text NOT NULL CHECK (length(compiler_profile_id) BETWEEN 1 AND 100),
  compiler_profile_digest text NOT NULL CHECK (compiler_profile_digest ~ '^[a-f0-9]{64}$'),
  image_digest text NOT NULL CHECK (image_digest ~ '^sha256:[a-f0-9]{64}$'),
  status text NOT NULL CHECK (status IN ('succeeded','failed','timed_out','rejected')),
  result jsonb NOT NULL CHECK (jsonb_typeof(result)='object'),
  result_digest text NOT NULL CHECK (result_digest ~ '^[a-f0-9]{64}$'),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id,id),
  UNIQUE (project_id,idempotency_key),
  FOREIGN KEY (project_id,source_artifact_id)
    REFERENCES firmware_artifacts(project_id,id),
  CHECK (result->>'schemaVersion'='1'),
  CHECK (jsonb_typeof(result->'artifacts')='array'),
  CHECK (result->>'status'=status),
  CHECK (result->>'sourceManifestDigest'=source_manifest_digest),
  CHECK (result->>'profileDigest'=compiler_profile_digest),
  CHECK (result->>'imageDigest'=image_digest)
);
CREATE INDEX firmware_builds_source_latest
  ON firmware_builds(project_id,source_artifact_id,created_at DESC,id DESC);

CREATE TABLE firmware_build_artifacts (
  project_id uuid NOT NULL,
  build_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('application','bootloader','partition_table')),
  path text NOT NULL CHECK (length(path) BETWEEN 1 AND 240),
  object_key uuid NOT NULL,
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  byte_length integer NOT NULL CHECK (byte_length BETWEEN 1 AND 67108864),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id,build_id,role),
  UNIQUE (project_id,build_id,path),
  FOREIGN KEY (project_id,build_id)
    REFERENCES firmware_builds(project_id,id) ON DELETE CASCADE,
  CHECK (path !~ '^/' AND position(chr(92) in path)=0
    AND path !~ '(^|/)[.][.]?(/|$)'
    AND path !~ '(^|/)(__proto__|constructor|prototype)(/|$)')
);
CREATE UNIQUE INDEX firmware_build_artifacts_object_key ON firmware_build_artifacts(object_key);

CREATE FUNCTION guard_schemora_firmware_build() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  project_status text;
  source_record firmware_artifacts%ROWTYPE;
BEGIN
  IF TG_OP='DELETE' THEN
    SELECT status INTO project_status FROM projects WHERE id=OLD.project_id FOR UPDATE;
    IF project_status IS DISTINCT FROM 'deleting' THEN
      RAISE EXCEPTION 'Schemora firmware build deletion requires project purge';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP='UPDATE' THEN
    RAISE EXCEPTION 'Schemora firmware build records are immutable';
  END IF;
  SELECT status INTO project_status FROM projects WHERE id=NEW.project_id FOR UPDATE;
  IF project_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'Schemora firmware builds require an active project';
  END IF;
  SELECT * INTO source_record FROM firmware_artifacts
    WHERE project_id=NEW.project_id AND id=NEW.source_artifact_id;
  IF source_record.id IS NULL OR
     coalesce(source_record.bundle_digest,source_record.sha256) <> NEW.source_manifest_digest OR
     source_record.build_system IS DISTINCT FROM 'esp-idf' OR
     source_record.target->>'kind' IS DISTINCT FROM 'esp-idf-target' OR
     source_record.target->>'target' IS DISTINCT FROM 'esp32' THEN
    RAISE EXCEPTION 'Schemora firmware build source does not match the supported immutable bundle';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER firmware_builds_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON firmware_builds
  FOR EACH ROW EXECUTE FUNCTION guard_schemora_firmware_build();

CREATE FUNCTION guard_schemora_firmware_build_artifact() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  project_status text;
BEGIN
  IF TG_OP='DELETE' THEN
    SELECT status INTO project_status FROM projects WHERE id=OLD.project_id FOR UPDATE;
    IF project_status IS DISTINCT FROM 'deleting' THEN
      RAISE EXCEPTION 'Schemora firmware build artifact deletion requires project purge';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP='UPDATE' THEN
    RAISE EXCEPTION 'Schemora firmware build artifacts are immutable';
  END IF;
  SELECT status INTO project_status FROM projects WHERE id=NEW.project_id FOR UPDATE;
  IF project_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'Schemora firmware build artifacts require an active project';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER firmware_build_artifacts_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON firmware_build_artifacts
  FOR EACH ROW EXECUTE FUNCTION guard_schemora_firmware_build_artifact();

CREATE FUNCTION verify_schemora_firmware_build_outputs() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  build_project uuid;
  build_identity uuid;
  build_record firmware_builds%ROWTYPE;
  output_count integer;
  output_bytes bigint;
BEGIN
  IF TG_TABLE_NAME='firmware_builds' THEN
    IF TG_OP='DELETE' THEN
      build_project := OLD.project_id;
      build_identity := OLD.id;
    ELSE
      build_project := NEW.project_id;
      build_identity := NEW.id;
    END IF;
  ELSE
    IF TG_OP='DELETE' THEN
      build_project := OLD.project_id;
      build_identity := OLD.build_id;
    ELSE
      build_project := NEW.project_id;
      build_identity := NEW.build_id;
    END IF;
  END IF;
  SELECT * INTO build_record FROM firmware_builds
    WHERE project_id=build_project AND id=build_identity;
  IF build_record.id IS NULL THEN RETURN NULL; END IF;
  SELECT count(*)::int,coalesce(sum(byte_length),0)
    INTO output_count,output_bytes FROM firmware_build_artifacts
    WHERE project_id=build_project AND build_id=build_identity;
  IF jsonb_typeof(build_record.result->'artifacts') IS DISTINCT FROM 'array' OR
     output_bytes > 67108864 OR
     (build_record.status='succeeded' AND output_count <> 3) OR
     (build_record.status<>'succeeded' AND output_count <> 0) OR
     output_count <> jsonb_array_length(build_record.result->'artifacts') OR
     EXISTS (
       SELECT 1 FROM jsonb_array_elements(build_record.result->'artifacts') AS expected(item)
       WHERE NOT EXISTS (
         SELECT 1 FROM firmware_build_artifacts actual
         WHERE actual.project_id=build_project AND actual.build_id=build_identity
           AND actual.role=expected.item->>'role'
           AND actual.path=expected.item->>'path'
           AND actual.sha256=expected.item->>'sha256'
           AND actual.byte_length=(expected.item->>'byteLength')::integer
       )
     ) THEN
    RAISE EXCEPTION 'Schemora compiler output rows do not match the immutable result manifest';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER firmware_build_manifest_integrity
  AFTER INSERT OR UPDATE ON firmware_builds
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION verify_schemora_firmware_build_outputs();
CREATE CONSTRAINT TRIGGER firmware_build_output_integrity
  AFTER INSERT OR UPDATE OR DELETE ON firmware_build_artifacts
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION verify_schemora_firmware_build_outputs();
