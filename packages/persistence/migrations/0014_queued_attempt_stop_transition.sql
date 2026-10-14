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
    (OLD.status = 'queued' AND NEW.status = 'stopping' AND EXISTS (
      SELECT 1 FROM simulation_run_attempts a
       WHERE a.project_id=OLD.project_id AND a.run_id=OLD.id
         AND a.stop_requested_at IS NOT NULL AND a.state IN ('dispatched','accepted','running')
    )) OR
    (OLD.status = 'preparing' AND NEW.status IN ('running','stopping','failed','timed_out','cancelled')) OR
    (OLD.status = 'running' AND NEW.status IN ('stopping','completed','stopped','failed','timed_out','cancelled')) OR
    (OLD.status = 'stopping' AND NEW.status IN ('completed','stopped','failed','timed_out','cancelled')) OR
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
