-- A persisted build is accepted only with a fresh signature from an
-- administrator-configured compiler runner key. Legacy rows remain readable.
ALTER TABLE runner_replay_claims
  DROP CONSTRAINT runner_replay_claims_token_class_check;
ALTER TABLE runner_replay_claims
  ADD CONSTRAINT runner_replay_claims_token_class_check
  CHECK (token_class IN ('capability','response','firmware_build_attestation'));

ALTER TABLE firmware_builds
  ADD COLUMN attestation jsonb,
  ADD COLUMN attestation_digest text,
  ADD COLUMN attestation_key_id text,
  ADD COLUMN attestation_jti text,
  ADD COLUMN attestation_issued_at timestamptz,
  ADD CONSTRAINT firmware_builds_attestation_digest_check
    CHECK (attestation_digest IS NULL OR attestation_digest ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT firmware_builds_attestation_identity_check
    CHECK (
      (attestation IS NULL AND attestation_digest IS NULL AND attestation_key_id IS NULL
        AND attestation_jti IS NULL AND attestation_issued_at IS NULL)
      OR
      (jsonb_typeof(attestation)='object'
        AND attestation_digest IS NOT NULL
        AND attestation_key_id IS NOT NULL AND length(attestation_key_id) BETWEEN 1 AND 160
        AND attestation_jti IS NOT NULL AND length(attestation_jti) BETWEEN 1 AND 200
        AND attestation_issued_at IS NOT NULL
        AND attestation->>'keyId'=attestation_key_id
        AND attestation->>'jti'=attestation_jti
        AND (attestation->>'issuedAt')::timestamptz=attestation_issued_at
        AND attestation->>'schemaVersion'='1'
        AND attestation->>'requestDigest'=request_digest
        AND attestation->>'resultDigest'=result_digest
        AND attestation->>'sourceArtifactId'=source_artifact_id::text
        AND attestation->>'sourceManifestDigest'=source_manifest_digest
        AND attestation->>'compilerProfileId'=compiler_profile_id
        AND attestation->>'compilerProfileDigest'=compiler_profile_digest
        AND attestation->>'compilerVersion'=result->>'compilerVersion'
        AND attestation->>'imageDigest'=image_digest
        AND attestation->>'signature' IS NOT NULL)
    );

CREATE UNIQUE INDEX firmware_builds_attestation_identity
  ON firmware_builds(attestation_key_id,attestation_jti)
  WHERE attestation_key_id IS NOT NULL AND attestation_jti IS NOT NULL;

CREATE FUNCTION require_schemora_firmware_build_attestation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.attestation IS NULL THEN
    RAISE EXCEPTION 'Schemora firmware build requires a verified runner attestation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER firmware_builds_require_attestation
  BEFORE INSERT ON firmware_builds
  FOR EACH ROW EXECUTE FUNCTION require_schemora_firmware_build_attestation();
