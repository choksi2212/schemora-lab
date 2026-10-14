CREATE TABLE hardware_photos (
  id uuid NOT NULL,
  project_id uuid NOT NULL REFERENCES projects(id),
  project_revision integer NOT NULL,
  actor_id text NOT NULL REFERENCES principals(id),
  object_key uuid NOT NULL UNIQUE,
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  byte_length integer NOT NULL CHECK (byte_length BETWEEN 1 AND 5242880),
  format text NOT NULL CHECK (format IN ('jpeg','png','webp')),
  width integer NOT NULL CHECK (width BETWEEN 1 AND 25000),
  height integer NOT NULL CHECK (height BETWEEN 1 AND 25000),
  shot_role text NOT NULL CHECK (shot_role IN ('board-top','board-back','pin-labels','module-top','markings','other')),
  consent_version text NOT NULL CHECK (consent_version = 'photo-evidence-v1'),
  status text NOT NULL DEFAULT 'manual_review' CHECK (status = 'manual_review'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, id),
  FOREIGN KEY (project_id, project_revision)
    REFERENCES revisions(project_id, revision) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX hardware_photos_project_latest
  ON hardware_photos(project_id, created_at DESC, id);

CREATE FUNCTION reject_schemora_hardware_photo_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Schemora hardware photo evidence is immutable';
END;
$$;
CREATE TRIGGER hardware_photos_immutable
  BEFORE UPDATE ON hardware_photos
  FOR EACH ROW EXECUTE FUNCTION reject_schemora_hardware_photo_update();
