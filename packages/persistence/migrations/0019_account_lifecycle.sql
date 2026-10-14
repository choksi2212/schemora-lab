ALTER TABLE principals
  ADD COLUMN display_name text,
  ADD COLUMN lifecycle_status text NOT NULL DEFAULT 'active'
    CHECK (lifecycle_status IN ('active','closing','closed')),
  ADD COLUMN deletion_requested_at timestamptz,
  ADD COLUMN closed_at timestamptz,
  ADD CONSTRAINT principals_display_name_length
    CHECK (display_name IS NULL OR length(display_name) BETWEEN 1 AND 39),
  ADD CONSTRAINT principals_lifecycle_timestamps
    CHECK (
      (lifecycle_status = 'active' AND closed_at IS NULL) OR
      (lifecycle_status = 'closing' AND deletion_requested_at IS NOT NULL AND closed_at IS NULL) OR
      (lifecycle_status = 'closed' AND deletion_requested_at IS NOT NULL AND closed_at IS NOT NULL)
    );

CREATE INDEX projects_owner_lifecycle ON projects(owner_id, status, created_at);
