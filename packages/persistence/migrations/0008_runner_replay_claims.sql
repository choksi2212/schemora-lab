-- Replay claims are scoped by protocol token class, issuer namespace, signing
-- key ID, and token ID. Keeping every dimension in the key prevents IDs from
-- one issuer, key rotation, or token class from shadowing another claim.
CREATE TABLE runner_replay_claims (
  token_class text NOT NULL CHECK (token_class IN ('capability','response')),
  issuer_namespace text NOT NULL CHECK (length(issuer_namespace) BETWEEN 1 AND 160),
  key_id text NOT NULL CHECK (length(key_id) BETWEEN 1 AND 160),
  jti text NOT NULL CHECK (length(jti) BETWEEN 1 AND 200),
  expires_at timestamptz NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (token_class, issuer_namespace, key_id, jti)
);

-- The janitor can remove expired claims without scanning active replay state.
CREATE INDEX runner_replay_claims_expiry ON runner_replay_claims (expires_at);
