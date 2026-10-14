import type { PoolClient, QueryResultRow } from 'pg';
import { createHash } from 'node:crypto';
import { claimRunnerReplayToken } from './runner-replay-store.js';

export interface VerifiedRunnerResponseEnvelope {
  protocolVersion: string;
  keyId: string;
  requestJti: string;
  responseJti: string;
  issuedAt: string;
  responseDigest: string;
  signature: string;
  response: {
    protocolVersion: string;
    runId: string;
    attemptId: string;
    payloadDigest: string;
    executionProfileId: string;
    imageDigest: string;
    status: 'accepted' | 'running' | 'completed' | 'failed' | 'cancelled';
    startedAt: string | null;
    finishedAt: string | null;
    terminationReason: string | null;
    run: Record<string, unknown> | null;
    outputManifest: unknown[];
    totalOutputBytes: number;
    cleanupReceipt: unknown;
  };
}

export interface SimulationAttemptIdentity {
  projectId: string;
  runId: string;
  jobId: string;
  attemptNumber: number;
  attemptId: string;
  payloadDigest: string;
  executionProfileId: string;
  imageDigest: string;
  bindingDigest: string;
  requestJti: string;
  requestedAt: Date | string;
  notBefore: Date | string;
  deadlineAt: Date | string;
}

export interface SimulationRunLease {
  projectId: string;
  jobId: string;
  leaseToken: string;
}

export type RunnerResponseAcceptance =
  | { accepted: true; runStatus: string; attemptState: string }
  | {
      accepted: false;
      reason: 'stale_lease' | 'stale_attempt' | 'invalid_transition' | 'replayed';
    };

export interface CurrentSimulationRunAttempt extends SimulationAttemptIdentity {
  state: 'dispatched' | 'accepted' | 'running';
  runStatus: string;
  stopRequestedAt: Date | null;
}

interface LockedRun extends QueryResultRow {
  status: string;
  run: Record<string, unknown>;
  binding: Record<string, unknown>;
}

/**
 * Create the durable fence for a claimed simulation job. Call while the
 * worker owns the job lease, before dispatch. The project -> job -> run lock
 * order matches Repository.jobScope and project mutation transactions.
 */
export async function createSimulationRunAttempt(
  client: PoolClient,
  lease: SimulationRunLease,
  attempt: SimulationAttemptIdentity,
): Promise<boolean> {
  const scoped = await lockSimulationLease(client, lease);
  if (!scoped || scoped.job.attempts !== attempt.attemptNumber) return false;
  if (
    scoped.job.project_id !== attempt.projectId ||
    scoped.job.payload?.runId !== attempt.runId ||
    scoped.project.status !== 'active'
  )
    return false;
  const runs = await client.query<LockedRun>(
    'SELECT status,run,binding FROM simulation_runs WHERE project_id=$1 AND id=$2 FOR UPDATE',
    [attempt.projectId, attempt.runId],
  );
  const run = runs.rows[0];
  // Stopping is active for response verification, but never a dispatchable
  // state. A retry must not replace an attempt after its stop intent exists.
  if (!run || !['queued', 'preparing', 'running'].includes(run.status)) return false;
  const stopRequest = await client.query(
    `SELECT 1 FROM simulation_run_attempts
      WHERE project_id=$1 AND run_id=$2 AND stop_requested_at IS NOT NULL
      LIMIT 1 FOR UPDATE`,
    [attempt.projectId, attempt.runId],
  );
  if (stopRequest.rowCount) return false;

  // A lease reclaim makes every prior attempt ineligible before a replacement
  // is inserted. Terminal attempts retain their audit state.
  await client.query(
    `UPDATE simulation_run_attempts SET state='superseded'
     WHERE project_id=$1 AND run_id=$2 AND state IN ('dispatched','accepted','running')`,
    [attempt.projectId, attempt.runId],
  );
  const inserted = await client.query(
    `INSERT INTO simulation_run_attempts
       (project_id,run_id,job_id,attempt_number,attempt_id,payload_digest,
        execution_profile_id,image_digest,binding_digest,request_jti,requested_at,
        not_before,deadline_at,state)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'dispatched')
     ON CONFLICT DO NOTHING RETURNING attempt_id`,
    [
      attempt.projectId,
      attempt.runId,
      attempt.jobId,
      attempt.attemptNumber,
      attempt.attemptId,
      attempt.payloadDigest,
      attempt.executionProfileId,
      attempt.imageDigest,
      attempt.bindingDigest,
      attempt.requestJti,
      attempt.requestedAt,
      attempt.notBefore,
      attempt.deadlineAt,
    ],
  );
  return inserted.rowCount === 1;
}

/** Load the current attempt under project, job, and run locks for response verification. */
export async function loadCurrentSimulationRunAttempt(
  client: PoolClient,
  lease: SimulationRunLease,
  runId: string,
): Promise<CurrentSimulationRunAttempt | null> {
  const scoped = await lockSimulationLease(client, lease);
  if (!scoped || scoped.job.payload?.runId !== runId || scoped.project.status !== 'active')
    return null;
  const runs = await client.query<LockedRun>(
    'SELECT status,run,binding FROM simulation_runs WHERE project_id=$1 AND id=$2 FOR UPDATE',
    [lease.projectId, runId],
  );
  if (!runs.rows[0] || !isActiveRunStatus(runs.rows[0].status)) return null;
  const result = await client.query<{
    project_id: string;
    run_id: string;
    job_id: string;
    attempt_number: number;
    attempt_id: string;
    payload_digest: string;
    execution_profile_id: string;
    image_digest: string;
    binding_digest: string;
    request_jti: string;
    requested_at: Date;
    not_before: Date;
    deadline_at: Date;
    state: string;
    stop_requested_at: Date | null;
  }>(
    `SELECT project_id,run_id,job_id,attempt_number,attempt_id,payload_digest,
            execution_profile_id,image_digest,binding_digest,request_jti,
            requested_at,not_before,deadline_at,state,stop_requested_at
       FROM simulation_run_attempts
      WHERE project_id=$1 AND run_id=$2 AND job_id=$3 AND attempt_number=$4
      FOR UPDATE`,
    [lease.projectId, runId, lease.jobId, scoped.job.attempts],
  );
  const attempt = result.rows[0];
  if (!attempt || !['dispatched', 'accepted', 'running'].includes(attempt.state)) return null;
  return {
    projectId: attempt.project_id,
    runId: attempt.run_id,
    jobId: attempt.job_id,
    attemptNumber: attempt.attempt_number,
    attemptId: attempt.attempt_id,
    payloadDigest: attempt.payload_digest,
    executionProfileId: attempt.execution_profile_id,
    imageDigest: attempt.image_digest,
    bindingDigest: attempt.binding_digest,
    requestJti: attempt.request_jti,
    requestedAt: attempt.requested_at,
    notBefore: attempt.not_before,
    deadlineAt: attempt.deadline_at,
    state: attempt.state as CurrentSimulationRunAttempt['state'],
    runStatus: runs.rows[0].status,
    stopRequestedAt: attempt.stop_requested_at,
  };
}

/** Record a one-way stop request against the current active attempt. */
export async function requestSimulationRunStop(
  client: PoolClient,
  projectId: string,
  runId: string,
): Promise<Date | null> {
  const selected = await client.query<{
    job_id: string;
    attempt_number: number;
    stop_requested_at: Date | null;
  }>(
    `SELECT job_id,attempt_number,stop_requested_at FROM simulation_run_attempts
      WHERE project_id=$1 AND run_id=$2 AND state IN ('dispatched','accepted','running')
      ORDER BY attempt_number DESC LIMIT 1 FOR UPDATE`,
    [projectId, runId],
  );
  const attempt = selected.rows[0];
  if (!attempt) return null;
  if (attempt.stop_requested_at) return attempt.stop_requested_at;
  const updated = await client.query<{ stop_requested_at: Date }>(
    `UPDATE simulation_run_attempts SET stop_requested_at=clock_timestamp()
      WHERE project_id=$1 AND run_id=$2 AND job_id=$3 AND attempt_number=$4
        AND state IN ('dispatched','accepted','running')
        AND stop_requested_at IS NULL
      RETURNING stop_requested_at`,
    [projectId, runId, attempt.job_id, attempt.attempt_number],
  );
  return updated.rows[0]?.stop_requested_at ?? null;
}

/**
 * Accept an envelope only after the caller has verified its signature,
 * strict protocol schema, request/profile binding, digest, and timestamp
 * window. Replay claiming is deliberately repeated here on the transaction
 * client so claim and run update commit or roll back as one unit.
 */
export async function acceptVerifiedRunnerResponse(
  client: PoolClient,
  lease: SimulationRunLease,
  expected: SimulationAttemptIdentity,
  envelope: VerifiedRunnerResponseEnvelope,
): Promise<RunnerResponseAcceptance> {
  const response = envelope.response;
  if (!validResponseShape(envelope) || !sameIdentity(expected, envelope))
    return { accepted: false, reason: 'stale_attempt' };

  const scoped = await lockSimulationLease(client, lease);
  if (
    !scoped ||
    scoped.job.project_id !== expected.projectId ||
    scoped.job.payload?.runId !== expected.runId
  )
    return { accepted: false, reason: 'stale_lease' };
  if (scoped.project.status !== 'active') return { accepted: false, reason: 'stale_lease' };

  const runs = await client.query<LockedRun>(
    'SELECT status,run,binding FROM simulation_runs WHERE project_id=$1 AND id=$2 FOR UPDATE',
    [expected.projectId, expected.runId],
  );
  const currentRun = runs.rows[0];
  const attempts = await client.query<{
    attempt_id: string;
    attempt_number: number;
    payload_digest: string;
    execution_profile_id: string;
    image_digest: string;
    binding_digest: string;
    request_jti: string;
    not_before: Date;
    deadline_at: Date;
    state: string;
  }>(
    `SELECT attempt_id,attempt_number,payload_digest,execution_profile_id,image_digest,
            binding_digest,request_jti,not_before,deadline_at,state
       FROM simulation_run_attempts
      WHERE project_id=$1 AND run_id=$2 AND job_id=$3 AND attempt_number=$4
      FOR UPDATE`,
    [expected.projectId, expected.runId, expected.jobId, expected.attemptNumber],
  );
  const currentAttempt = attempts.rows[0];
  if (!currentRun || !currentAttempt || !isActiveRunStatus(currentRun.status))
    return { accepted: false, reason: 'stale_attempt' };
  if (
    scoped.job.attempts !== expected.attemptNumber ||
    currentAttempt.attempt_id !== expected.attemptId ||
    currentAttempt.payload_digest !== expected.payloadDigest ||
    currentAttempt.execution_profile_id !== expected.executionProfileId ||
    currentAttempt.image_digest !== expected.imageDigest ||
    currentAttempt.binding_digest !== expected.bindingDigest ||
    canonicalDigest(currentRun.binding) !== expected.bindingDigest ||
    currentAttempt.request_jti !== expected.requestJti ||
    currentAttempt.state === 'superseded' ||
    currentAttempt.state === 'completed' ||
    currentAttempt.state === 'failed' ||
    currentAttempt.state === 'cancelled' ||
    envelope.requestJti !== currentAttempt.request_jti ||
    Date.parse(envelope.issuedAt) < currentAttempt.not_before.getTime() - 15_000 ||
    Date.parse(envelope.issuedAt) > currentAttempt.deadline_at.getTime() + 135_000 ||
    (response.finishedAt === null &&
      Date.parse(envelope.issuedAt) > currentAttempt.deadline_at.getTime() + 15_000) ||
    Date.parse(envelope.issuedAt) > Date.now() + 15_000 ||
    (response.run !== null &&
      canonicalJson(response.run.binding) !== canonicalJson(currentRun.binding))
  )
    return { accepted: false, reason: 'stale_attempt' };

  const next = responseStatusForRun(response);
  if (!transitionAllowed(currentRun.status, response.status, currentAttempt.state, next))
    return { accepted: false, reason: 'invalid_transition' };

  // On rejected post-claim persistence, roll back only the claim and work
  // performed below it. The caller controls the surrounding transaction.
  await client.query('SAVEPOINT schemora_runner_response_accept');
  const claimed = await claimRunnerReplayToken(client, {
    tokenClass: 'response',
    issuerNamespace: 'schemora-sandbox-runner',
    keyId: envelope.keyId,
    jti: envelope.responseJti,
    expiresAt: new Date(currentAttempt.deadline_at.getTime() + 135_000),
  });
  if (!claimed) {
    await client.query('ROLLBACK TO SAVEPOINT schemora_runner_response_accept');
    await client.query('RELEASE SAVEPOINT schemora_runner_response_accept');
    return { accepted: false, reason: 'replayed' };
  }

  const runValue = response.run ?? {
    ...currentRun.run,
    status: next,
    ...(response.startedAt ? { startedAt: response.startedAt } : {}),
  };
  const updatedRun = await client.query(
    `UPDATE simulation_runs
        SET status=$3,run=$4::jsonb
      WHERE project_id=$1 AND id=$2 AND status=$5
        AND EXISTS (SELECT 1 FROM jobs
          WHERE id=$6 AND project_id=$1 AND lease_token=$7 AND status='running'
            AND attempts=$8 AND lease_until>clock_timestamp())
      RETURNING id`,
    [
      expected.projectId,
      expected.runId,
      next,
      JSON.stringify({ ...runValue, status: next }),
      currentRun.status,
      lease.jobId,
      lease.leaseToken,
      expected.attemptNumber,
    ],
  );
  if (updatedRun.rowCount !== 1) {
    await client.query('ROLLBACK TO SAVEPOINT schemora_runner_response_accept');
    await client.query('RELEASE SAVEPOINT schemora_runner_response_accept');
    return { accepted: false, reason: 'stale_attempt' };
  }
  const attemptState = response.status;
  const updatedAttempt = await client.query(
    `UPDATE simulation_run_attempts
        SET state=$5,response_jti=$6,response_digest=$7,response_issued_at=$8
      WHERE project_id=$1 AND run_id=$2 AND job_id=$3 AND attempt_number=$4
        AND attempt_id=$9 AND state IN ('dispatched','accepted','running')
      RETURNING attempt_id`,
    [
      expected.projectId,
      expected.runId,
      expected.jobId,
      expected.attemptNumber,
      attemptState,
      envelope.responseJti,
      envelope.responseDigest,
      envelope.issuedAt,
      expected.attemptId,
    ],
  );
  if (updatedAttempt.rowCount !== 1) {
    await client.query('ROLLBACK TO SAVEPOINT schemora_runner_response_accept');
    await client.query('RELEASE SAVEPOINT schemora_runner_response_accept');
    return { accepted: false, reason: 'stale_attempt' };
  }
  if (['completed', 'failed', 'cancelled'].includes(response.status)) {
    const jobStatus = response.status === 'completed' ? 'completed' : response.status;
    const updatedJob = await client.query(
      `UPDATE jobs SET status=$4,lease_until=NULL,lease_token=NULL,payload='{}'::jsonb
        WHERE id=$1 AND project_id=$2 AND lease_token=$3 AND status='running'
          AND attempts=$5 AND lease_until>clock_timestamp()
        RETURNING id`,
      [lease.jobId, expected.projectId, lease.leaseToken, jobStatus, expected.attemptNumber],
    );
    if (updatedJob.rowCount !== 1) {
      await client.query('ROLLBACK TO SAVEPOINT schemora_runner_response_accept');
      await client.query('RELEASE SAVEPOINT schemora_runner_response_accept');
      return { accepted: false, reason: 'stale_lease' };
    }
  }
  await client.query('RELEASE SAVEPOINT schemora_runner_response_accept');
  return { accepted: true, runStatus: next, attemptState };
}

async function lockSimulationLease(client: PoolClient, lease: SimulationRunLease) {
  const projects = await client.query<{ id: string; status: string }>(
    'SELECT id,status FROM projects WHERE id=$1 FOR UPDATE',
    [lease.projectId],
  );
  const project = projects.rows[0];
  if (!project) return null;
  const jobs = await client.query<{
    id: string;
    project_id: string;
    payload: { runId?: string };
    attempts: number;
  }>(
    `SELECT id,project_id,payload,attempts FROM jobs
      WHERE id=$1 AND project_id=$2 AND lease_token=$3 AND status='running'
        AND lease_until>clock_timestamp()
      FOR UPDATE`,
    [lease.jobId, lease.projectId, lease.leaseToken],
  );
  const job = jobs.rows[0];
  return job ? { project, job } : null;
}

function sameIdentity(
  expected: SimulationAttemptIdentity,
  envelope: VerifiedRunnerResponseEnvelope,
) {
  const response = envelope.response;
  return (
    response.runId === expected.runId &&
    response.attemptId === expected.attemptId &&
    response.payloadDigest === expected.payloadDigest &&
    response.executionProfileId === expected.executionProfileId &&
    response.imageDigest === expected.imageDigest &&
    envelope.requestJti === expected.requestJti &&
    /^[a-f0-9]{64}$/.test(envelope.responseDigest)
  );
}

function validResponseShape(envelope: VerifiedRunnerResponseEnvelope) {
  return (
    envelope.protocolVersion === '1.0.0' &&
    /^[0-9a-f-]{36}$/i.test(envelope.responseJti) &&
    /^[0-9a-f-]{36}$/i.test(envelope.requestJti) &&
    typeof envelope.keyId === 'string' &&
    envelope.keyId.length > 0 &&
    envelope.keyId.length <= 100 &&
    Number.isFinite(Date.parse(envelope.issuedAt)) &&
    /^[a-f0-9]{64}$/.test(envelope.responseDigest) &&
    ['accepted', 'running', 'completed', 'failed', 'cancelled'].includes(envelope.response.status)
  );
}

function responseStatusForRun(response: VerifiedRunnerResponseEnvelope['response']) {
  if (response.status === 'accepted') return 'preparing';
  if (response.status === 'running') return 'running';
  if (!response.run || typeof response.run.status !== 'string') return 'failed';
  return response.run.status;
}

function transitionAllowed(run: string, response: string, attempt: string, next: string) {
  if (response === 'accepted')
    return ['queued', 'preparing'].includes(run) && attempt === 'dispatched';
  if (response === 'running')
    return (
      ['queued', 'preparing', 'running'].includes(run) &&
      ['dispatched', 'accepted', 'running'].includes(attempt)
    );
  if (!['completed', 'failed', 'cancelled'].includes(response)) return false;
  if (!['queued', 'preparing', 'running', 'stopping'].includes(run)) return false;
  if (response === 'completed')
    return ['running', 'stopping'].includes(run) && next === 'completed';
  if (response === 'cancelled') return next === 'cancelled';
  return ['failed', 'timed_out'].includes(next);
}

function isActiveRunStatus(status: string) {
  return ['queued', 'preparing', 'running', 'stopping'].includes(status);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  throw new Error('Invalid JSON value');
}

function canonicalDigest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}
