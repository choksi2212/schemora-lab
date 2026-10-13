import { describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import {
  claimRunnerReplayToken,
  deleteExpiredRunnerReplayClaims,
  type RunnerReplayQueryable,
  type RunnerReplayQueryResult,
} from '../src/runner-replay-store.js';

function queryable(
  behavior: (
    text: string,
    values?: unknown[],
  ) => Promise<{ rows: RunnerReplayQueryResult[]; rowCount: number | null }>,
) {
  return { query: behavior } as RunnerReplayQueryable;
}

const activeClaim = {
  tokenClass: 'capability' as const,
  issuerNamespace: 'schemora-sandbox-runner',
  keyId: 'runner-key-2026-10',
  jti: '019a-test-claim-01',
  expiresAt: '2030-01-01T00:00:00.000Z',
};

describe('claimRunnerReplayToken', () => {
  it('claims only when PostgreSQL returns an inserted or expired-reclaimed row', async () => {
    const calls: Array<{ text: string; values?: unknown[] }> = [];
    const database = queryable(async (text, values) => {
      calls.push({ text, values });
      return { rows: [{ claimed: true }], rowCount: 1 };
    });

    await expect(claimRunnerReplayToken(database, activeClaim)).resolves.toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toContain('ON CONFLICT (token_class, issuer_namespace, key_id, jti)');
    expect(calls[0]?.text).toContain('clock_timestamp()');
    expect(calls[0]?.text).toContain('WHERE runner_replay_claims.expires_at <= clock_timestamp()');
    expect(calls[0]?.values).toEqual([
      'capability',
      'schemora-sandbox-runner',
      'runner-key-2026-10',
      '019a-test-claim-01',
      activeClaim.expiresAt,
    ]);
  });

  it('rejects duplicate and expired claims when PostgreSQL returns no row', async () => {
    const database = queryable(async () => ({ rows: [], rowCount: 0 }));
    await expect(claimRunnerReplayToken(database, activeClaim)).resolves.toBe(false);
  });

  it('keeps token classes, issuer namespaces, and rotated key IDs in separate claim keys', async () => {
    const values: unknown[][] = [];
    const database = queryable(async (_text, parameters) => {
      values.push(parameters ?? []);
      return { rows: [{ claimed: true }], rowCount: 1 };
    });

    await expect(claimRunnerReplayToken(database, activeClaim)).resolves.toBe(true);
    await expect(
      claimRunnerReplayToken(database, { ...activeClaim, tokenClass: 'response' }),
    ).resolves.toBe(true);
    await expect(
      claimRunnerReplayToken(database, { ...activeClaim, issuerNamespace: 'another-issuer' }),
    ).resolves.toBe(true);
    await expect(
      claimRunnerReplayToken(database, { ...activeClaim, keyId: 'runner-key-2027-01' }),
    ).resolves.toBe(true);

    expect(values.map((parameters) => parameters.slice(0, 4))).toEqual([
      ['capability', 'schemora-sandbox-runner', 'runner-key-2026-10', activeClaim.jti],
      ['response', 'schemora-sandbox-runner', 'runner-key-2026-10', activeClaim.jti],
      ['capability', 'another-issuer', 'runner-key-2026-10', activeClaim.jti],
      ['capability', 'schemora-sandbox-runner', 'runner-key-2027-01', activeClaim.jti],
    ]);
  });

  it('rejects malformed claims without querying and fails closed on database errors', async () => {
    let queryCount = 0;
    const healthyDatabase = queryable(async () => {
      queryCount += 1;
      return { rows: [{ claimed: true }], rowCount: 1 };
    });
    await expect(
      claimRunnerReplayToken(healthyDatabase, { ...activeClaim, keyId: '' }),
    ).resolves.toBe(false);
    expect(queryCount).toBe(0);

    const unavailableDatabase = queryable(async () => {
      throw new Error('database unavailable');
    });
    await expect(claimRunnerReplayToken(unavailableDatabase, activeClaim)).resolves.toBe(false);
  });

  it('deletes expired claims in a bounded batch using PostgreSQL time', async () => {
    let statement = '';
    const database = queryable(async (text, parameters) => {
      statement = text;
      expect(parameters).toEqual([25]);
      return { rows: [], rowCount: 25 };
    });
    await expect(deleteExpiredRunnerReplayClaims(database, 25)).resolves.toBe(25);
    expect(statement).toContain('expires_at <= clock_timestamp()');
    expect(statement).toContain('LIMIT $1');
    expect(statement).toContain('FOR UPDATE SKIP LOCKED');
    await expect(deleteExpiredRunnerReplayClaims(database, 0)).resolves.toBe(0);
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)(
  'runner replay store PostgreSQL integration',
  () => {
    it('allows exactly one simultaneous claim and permits reclaim after database-time expiry', async () => {
      const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4 });
      const namespace = `integration-${crypto.randomUUID()}`;
      const claim = {
        tokenClass: 'capability' as const,
        issuerNamespace: namespace,
        keyId: 'integration-key',
        jti: 'simultaneous-claim',
        expiresAt: '2099-01-01T00:00:00.000Z',
      };
      try {
        const results = await Promise.all(
          Array.from({ length: 12 }, () => claimRunnerReplayToken(pool, claim)),
        );
        expect(results.filter(Boolean)).toHaveLength(1);

        await pool.query(
          `UPDATE runner_replay_claims
         SET expires_at = clock_timestamp() - interval '1 second'
         WHERE token_class=$1 AND issuer_namespace=$2 AND key_id=$3 AND jti=$4`,
          [claim.tokenClass, claim.issuerNamespace, claim.keyId, claim.jti],
        );
        await expect(claimRunnerReplayToken(pool, claim)).resolves.toBe(true);
      } finally {
        await pool.query('DELETE FROM runner_replay_claims WHERE issuer_namespace=$1', [namespace]);
        await pool.end();
      }
    });
  },
);
