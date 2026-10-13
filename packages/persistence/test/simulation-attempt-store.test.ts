import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import {
  acceptVerifiedRunnerResponse,
  type SimulationAttemptIdentity,
  type VerifiedRunnerResponseEnvelope,
} from '../src/simulation-attempt-store.js';

const expected: SimulationAttemptIdentity = {
  projectId: '11111111-1111-4111-8111-111111111111',
  runId: '22222222-2222-4222-8222-222222222222',
  jobId: '33333333-3333-4333-8333-333333333333',
  attemptNumber: 1,
  attemptId: '44444444-4444-4444-8444-444444444444',
  payloadDigest: 'a'.repeat(64),
  executionProfileId: 'native-linux-v1',
  imageDigest: `sha256:${'b'.repeat(64)}`,
  bindingDigest: createHash('sha256')
    .update('{"projectId":"11111111-1111-4111-8111-111111111111"}')
    .digest('hex'),
  requestJti: '55555555-5555-4555-8555-555555555555',
  requestedAt: '2026-10-01T00:00:00.000Z',
  notBefore: '2026-10-01T00:00:00.000Z',
  deadlineAt: '2026-10-01T00:05:00.000Z',
};

const envelope: VerifiedRunnerResponseEnvelope = {
  protocolVersion: '1.0.0',
  keyId: 'runner-key-v1',
  requestJti: expected.requestJti,
  responseJti: '66666666-6666-4666-8666-666666666666',
  issuedAt: '2026-10-01T00:01:00.000Z',
  responseDigest: 'd'.repeat(64),
  signature: 'verified-outside-persistence',
  response: {
    protocolVersion: '1.0.0',
    runId: expected.runId,
    attemptId: expected.attemptId,
    payloadDigest: expected.payloadDigest,
    executionProfileId: expected.executionProfileId,
    imageDigest: expected.imageDigest,
    status: 'running',
    startedAt: '2026-10-01T00:00:30.000Z',
    finishedAt: null,
    terminationReason: null,
    run: null,
    outputManifest: [],
    totalOutputBytes: 0,
    cleanupReceipt: null,
  },
};

function client(
  options: {
    replay?: boolean;
    runStatus?: string;
    projectStatus?: string;
    leaseValid?: boolean;
  } = {},
) {
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  const fake = {
    async query<Row extends QueryResultRow = QueryResultRow>(sql: string, values?: unknown[]) {
      calls.push({ sql, values });
      if (sql.includes('FROM projects'))
        return {
          rows: [{ id: expected.projectId, status: options.projectStatus ?? 'active' }] as Row[],
          rowCount: 1,
        };
      if (sql.includes('FROM jobs'))
        return {
          rows:
            options.leaseValid === false
              ? []
              : ([
                  {
                    id: expected.jobId,
                    project_id: expected.projectId,
                    payload: { runId: expected.runId },
                    attempts: 1,
                  },
                ] as Row[]),
          rowCount: options.leaseValid === false ? 0 : 1,
        };
      if (sql.includes('FROM simulation_runs'))
        return {
          rows: [
            {
              status: options.runStatus ?? 'preparing',
              binding: { projectId: expected.projectId },
              run: { runId: expected.runId, status: 'preparing' },
            },
          ] as Row[],
          rowCount: 1,
        };
      if (sql.includes('FROM simulation_run_attempts'))
        return {
          rows: [
            {
              attempt_id: expected.attemptId,
              attempt_number: 1,
              payload_digest: expected.payloadDigest,
              execution_profile_id: expected.executionProfileId,
              image_digest: expected.imageDigest,
              binding_digest: expected.bindingDigest,
              request_jti: expected.requestJti,
              not_before: new Date(expected.notBefore),
              deadline_at: new Date(expected.deadlineAt),
              state: 'dispatched',
            },
          ] as Row[],
          rowCount: 1,
        };
      if (sql.includes('INSERT INTO runner_replay_claims'))
        return {
          rows: options.replay === false ? [] : ([{ claimed: true }] as Row[]),
          rowCount: options.replay === false ? 0 : 1,
        };
      if (sql.includes('UPDATE simulation_runs'))
        return { rows: [{ id: expected.runId }] as Row[], rowCount: 1 };
      if (sql.includes('UPDATE simulation_run_attempts'))
        return { rows: [{ attempt_id: expected.attemptId }] as Row[], rowCount: 1 };
      if (sql.includes('UPDATE jobs'))
        return { rows: [{ id: expected.jobId }] as Row[], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };
  return { fake: fake as unknown as PoolClient, calls };
}

describe('atomic runner response persistence', () => {
  it('claims the response replay ID on the caller transaction client before updating run and attempt', async () => {
    const { fake, calls } = client();
    await expect(
      acceptVerifiedRunnerResponse(
        fake,
        {
          projectId: expected.projectId,
          jobId: expected.jobId,
          leaseToken: 'lease-token',
        },
        expected,
        envelope,
      ),
    ).resolves.toEqual({ accepted: true, runStatus: 'running', attemptState: 'running' });
    const claimIndex = calls.findIndex((call) =>
      call.sql.includes('INSERT INTO runner_replay_claims'),
    );
    expect(claimIndex).toBeGreaterThan(-1);
    expect(calls.findIndex((call) => call.sql.includes('UPDATE simulation_runs'))).toBeGreaterThan(
      claimIndex,
    );
    expect(
      calls.findIndex((call) => call.sql.includes('UPDATE simulation_run_attempts')),
    ).toBeGreaterThan(claimIndex);
    expect(
      calls.some((call) => call.sql.includes('SAVEPOINT schemora_runner_response_accept')),
    ).toBe(true);
  });

  it('rejects a replay without persisting a run transition', async () => {
    const { fake, calls } = client({ replay: false });
    await expect(
      acceptVerifiedRunnerResponse(
        fake,
        {
          projectId: expected.projectId,
          jobId: expected.jobId,
          leaseToken: 'lease-token',
        },
        expected,
        envelope,
      ),
    ).resolves.toEqual({ accepted: false, reason: 'replayed' });
    expect(calls.some((call) => call.sql.includes('UPDATE simulation_runs'))).toBe(false);
    expect(calls.some((call) => call.sql.includes('ROLLBACK TO SAVEPOINT'))).toBe(true);
  });

  it('rejects an identity mismatch before claiming a response token', async () => {
    const { fake, calls } = client();
    await expect(
      acceptVerifiedRunnerResponse(
        fake,
        {
          projectId: expected.projectId,
          jobId: expected.jobId,
          leaseToken: 'lease-token',
        },
        expected,
        {
          ...envelope,
          response: { ...envelope.response, attemptId: '77777777-7777-4777-8777-777777777777' },
        },
      ),
    ).resolves.toEqual({ accepted: false, reason: 'stale_attempt' });
    expect(calls.some((call) => call.sql.includes('INSERT INTO runner_replay_claims'))).toBe(false);
  });

  it.each([
    ['expired or reclaimed job lease', { leaseValid: false }],
    ['archived project', { projectStatus: 'archived' }],
    ['stopping run receiving a stale running update', { runStatus: 'stopping' }],
    ['terminal run receiving another result', { runStatus: 'completed' }],
  ])('rejects %s before claiming replay state', async (_label, options) => {
    const { fake, calls } = client(options);
    await expect(
      acceptVerifiedRunnerResponse(
        fake,
        {
          projectId: expected.projectId,
          jobId: expected.jobId,
          leaseToken: 'lease-token',
        },
        expected,
        envelope,
      ),
    ).resolves.toMatchObject({ accepted: false });
    expect(calls.some((call) => call.sql.includes('INSERT INTO runner_replay_claims'))).toBe(false);
    expect(calls.some((call) => call.sql.includes('UPDATE simulation_runs'))).toBe(false);
  });

  it('rejects a fast completion until a running state has been recorded', async () => {
    const completed: VerifiedRunnerResponseEnvelope = {
      ...envelope,
      responseJti: '88888888-8888-4888-8888-888888888888',
      responseDigest: 'e'.repeat(64),
      response: {
        ...envelope.response,
        status: 'completed',
        finishedAt: '2026-10-01T00:00:45.000Z',
        terminationReason: 'completed',
        cleanupReceipt: {},
        run: {
          runId: expected.runId,
          status: 'completed',
          binding: { projectId: expected.projectId },
        },
      },
    };
    const { fake, calls } = client({ runStatus: 'preparing' });
    await expect(
      acceptVerifiedRunnerResponse(
        fake,
        { projectId: expected.projectId, jobId: expected.jobId, leaseToken: 'lease-token' },
        expected,
        completed,
      ),
    ).resolves.toEqual({ accepted: false, reason: 'invalid_transition' });
    expect(calls.some((call) => call.sql.includes('INSERT INTO runner_replay_claims'))).toBe(false);
  });

  it('settles and releases the leased job only for a terminal response', async () => {
    const terminal: VerifiedRunnerResponseEnvelope = {
      ...envelope,
      responseJti: '88888888-8888-4888-8888-888888888888',
      responseDigest: 'e'.repeat(64),
      response: {
        ...envelope.response,
        status: 'completed',
        finishedAt: '2026-10-01T00:00:45.000Z',
        terminationReason: 'completed',
        cleanupReceipt: {},
        run: {
          runId: expected.runId,
          status: 'completed',
          binding: { projectId: expected.projectId },
        },
      },
    };
    const { fake, calls } = client({ runStatus: 'running' });
    await expect(
      acceptVerifiedRunnerResponse(
        fake,
        {
          projectId: expected.projectId,
          jobId: expected.jobId,
          leaseToken: 'lease-token',
        },
        expected,
        terminal,
      ),
    ).resolves.toEqual({ accepted: true, runStatus: 'completed', attemptState: 'completed' });
    const update = calls.find((call) => call.sql.includes('UPDATE jobs'));
    expect(update?.sql).toContain('lease_token=NULL');
    expect(update?.sql).toContain("payload='{}'::jsonb");
    expect(update?.values?.[3]).toBe('completed');
  });
});
