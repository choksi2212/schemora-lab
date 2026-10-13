import type { KeyObject } from 'node:crypto';
import {
  acceptVerifiedRunnerResponse,
  loadCurrentSimulationRunAttempt,
  type Repository,
  type RunnerResponseAcceptance,
  type SimulationRunLease,
} from '@schemora/persistence';
import { verifyRunnerExecutionResponsePure } from '@schemora/sandbox-runner';
import { runnerExecutionProfileSchema } from '@schemora/simulation';

export type RunnerResponseAcceptanceResult =
  | RunnerResponseAcceptance
  | {
      accepted: false;
      reason:
        | 'missing_attempt'
        | 'unapproved_profile'
        | 'invalid_response'
        | 'unknown_key'
        | 'invalid_signature'
        | 'expired'
        | 'replayed'
        | 'response_mismatch';
    };

/**
 * Authenticate and persist one runner response against the current leased
 * attempt. Profile and signing-key maps must come from trusted worker config.
 * Verification uses the pure signature path; the response JTI is claimed by
 * acceptVerifiedRunnerResponse on the same transaction as lifecycle updates.
 */
export async function acceptRunnerResponse(input: {
  repository: Repository;
  lease: SimulationRunLease;
  runId: string;
  authenticatedResponse: unknown;
  profiles: Readonly<Record<string, unknown>>;
  publicKeys: Readonly<Record<string, string | KeyObject>>;
  now?: number;
}): Promise<RunnerResponseAcceptanceResult> {
  const attempt = await input.repository.transaction((client) =>
    loadCurrentSimulationRunAttempt(client, input.lease, input.runId),
  );
  if (!attempt) return { accepted: false, reason: 'missing_attempt' };

  const profile = runnerExecutionProfileSchema.safeParse(
    input.profiles[attempt.executionProfileId],
  );
  if (
    !profile.success ||
    profile.data.profileId !== attempt.executionProfileId ||
    profile.data.imageDigest !== attempt.imageDigest
  )
    return { accepted: false, reason: 'unapproved_profile' };

  const verified = await verifyRunnerExecutionResponsePure({
    authenticatedResponse: input.authenticatedResponse,
    expected: {
      requestJti: attempt.requestJti,
      runId: attempt.runId,
      attemptId: attempt.attemptId,
      payloadDigest: attempt.payloadDigest,
      executionProfileId: attempt.executionProfileId,
      imageDigest: attempt.imageDigest,
      bindingDigest: attempt.bindingDigest,
      notBefore: asIsoString(attempt.notBefore),
      deadlineAt: asIsoString(attempt.deadlineAt),
    },
    publicKeys: input.publicKeys,
    now: input.now,
  });
  if (!verified.valid) return { accepted: false, reason: verified.reason };

  return input.repository.transaction((client) =>
    acceptVerifiedRunnerResponse(client, input.lease, attempt, verified.authenticated),
  );
}

function asIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
