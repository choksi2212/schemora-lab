import type { QueryResultRow } from 'pg';

export type RunnerReplayTokenClass = 'capability' | 'response' | 'firmware_build_attestation';

export interface RunnerReplayClaim {
  tokenClass: RunnerReplayTokenClass;
  issuerNamespace: string;
  keyId: string;
  jti: string;
  expiresAt: Date | string;
}

export interface RunnerReplayQueryResult extends QueryResultRow {
  claimed: boolean;
}

export interface RunnerReplayQueryable {
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Row[]; rowCount: number | null }>;
}

const CLAIM_SQL = `
  INSERT INTO runner_replay_claims
    (token_class, issuer_namespace, key_id, jti, expires_at)
  SELECT $1, $2, $3, $4, $5::timestamptz
  WHERE $5::timestamptz > clock_timestamp()
  ON CONFLICT (token_class, issuer_namespace, key_id, jti)
  DO UPDATE SET expires_at = EXCLUDED.expires_at,
                claimed_at = clock_timestamp()
  WHERE runner_replay_claims.expires_at <= clock_timestamp()
  RETURNING true AS claimed
`;

const CLEANUP_SQL = `
  WITH expired AS (
    SELECT ctid
    FROM runner_replay_claims
    WHERE expires_at <= clock_timestamp()
    ORDER BY expires_at
    LIMIT $1
    FOR UPDATE SKIP LOCKED
  )
  DELETE FROM runner_replay_claims AS claims
  USING expired
  WHERE claims.ctid = expired.ctid
`;

/**
 * Atomically claims a runner token ID until its signed expiry.
 *
 * The database clock decides whether a token is still live and whether a
 * previous claim has expired. A false result means either the token was
 * already claimed, expired before arrival, malformed, or the database could
 * not establish the claim. Callers must reject every false result.
 */
export async function claimRunnerReplayToken(
  database: RunnerReplayQueryable,
  claim: RunnerReplayClaim,
): Promise<boolean> {
  if (
    !['capability', 'response', 'firmware_build_attestation'].includes(claim.tokenClass) ||
    !isBoundedString(claim.issuerNamespace, 160) ||
    !isBoundedString(claim.keyId, 160) ||
    !isBoundedString(claim.jti, 200) ||
    !(claim.expiresAt instanceof Date || typeof claim.expiresAt === 'string') ||
    !Number.isFinite(Date.parse(String(claim.expiresAt)))
  )
    return false;

  try {
    const result = await database.query<RunnerReplayQueryResult>(CLAIM_SQL, [
      claim.tokenClass,
      claim.issuerNamespace,
      claim.keyId,
      claim.jti,
      claim.expiresAt instanceof Date ? claim.expiresAt.toISOString() : claim.expiresAt,
    ]);
    return result.rows.length === 1 && result.rows[0]?.claimed === true;
  } catch {
    // Replay admission is a security boundary: database uncertainty rejects.
    return false;
  }
}

/** Deletes at most one bounded batch of expired replay claims. */
export async function deleteExpiredRunnerReplayClaims(
  database: RunnerReplayQueryable,
  batchSize = 500,
): Promise<number> {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 10_000) return 0;
  const result = await database.query(CLEANUP_SQL, [batchSize]);
  return result.rowCount ?? 0;
}

function isBoundedString(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum;
}
