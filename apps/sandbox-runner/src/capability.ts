import { createPublicKey, verify as verifySignature, type KeyObject } from 'node:crypto';
import {
  MAX_RUNNER_CAPABILITY_TTL_MS,
  runnerCapabilitySchema,
  runnerCapabilitySigningMessage,
  runnerExecutionRequestSchema,
  runnerRequestMatchesProfile,
  runnerExecutionProfileSchema,
  runnerAuthenticatedResponseSchema,
  runnerResponseSigningMessage,
  runnerResponseDigest,
  runnerSimulationBindingDigest,
  verifyRunnerFirmwareDigest,
  type RunnerExecutionProfile,
  type RunnerExecutionRequest,
  type RunnerCapability,
  type RunnerAuthenticatedResponse,
} from '@schemora/simulation';

export interface RunnerCapabilityReplayGuard {
  /** Atomically claim keyId+jti until expiresAt; return false if it was already claimed. */
  claim(keyId: string, jti: string, expiresAt: number): Promise<boolean>;
}

export interface RunnerResponseReplayGuard {
  /** Atomically claim keyId+responseJti through the response and clock-skew grace window. */
  claim(keyId: string, responseJti: string, expiresAt: number): Promise<boolean>;
}

export const MAX_RUNNER_RESPONSE_GRACE_MS = 120_000;
const RUNNER_EXECUTION_CLOCK_SKEW_MS = 15_000;

export type CapabilityVerification =
  | { valid: true; capability: RunnerCapability }
  | {
      valid: false;
      reason: 'invalid_capability' | 'unknown_key' | 'invalid_signature' | 'expired' | 'replayed';
    };

/** Low-level signature primitive; callers must prefer admitRunnerExecutionRequest for requests. */
export async function verifyRunnerCapability(input: {
  capability: unknown;
  payloadDigest: string;
  runId: string;
  attemptId: string;
  deadlineAt: string;
  publicKeys: Readonly<Record<string, string | KeyObject>>;
  replayGuard: RunnerCapabilityReplayGuard;
  now?: number;
}): Promise<CapabilityVerification> {
  const parsed = runnerCapabilitySchema.safeParse(input.capability);
  if (
    !parsed.success ||
    parsed.data.payloadDigest !== input.payloadDigest ||
    parsed.data.runId !== input.runId ||
    parsed.data.attemptId !== input.attemptId
  )
    return { valid: false, reason: 'invalid_capability' };

  const capability = parsed.data;
  const now = input.now ?? Date.now();
  const notBefore = Date.parse(capability.notBefore);
  const expiresAt = Date.parse(capability.expiresAt);
  const deadlineAt = Date.parse(input.deadlineAt);
  if (
    !Number.isFinite(notBefore) ||
    !Number.isFinite(expiresAt) ||
    !Number.isFinite(deadlineAt) ||
    notBefore > now + 15_000 ||
    expiresAt <= now ||
    expiresAt <= notBefore ||
    expiresAt - notBefore > MAX_RUNNER_CAPABILITY_TTL_MS ||
    expiresAt > deadlineAt ||
    deadlineAt <= now ||
    deadlineAt - now > MAX_RUNNER_CAPABILITY_TTL_MS
  )
    return { valid: false, reason: 'expired' };

  const key = input.publicKeys[capability.keyId];
  if (!key) return { valid: false, reason: 'unknown_key' };
  let publicKey: KeyObject;
  try {
    publicKey = typeof key === 'string' ? createPublicKey(key) : key;
    if (publicKey.asymmetricKeyType !== 'ed25519') return { valid: false, reason: 'unknown_key' };
  } catch {
    return { valid: false, reason: 'unknown_key' };
  }

  const signature = Buffer.from(capability.signature, 'base64url');
  if (
    signature.length !== 64 ||
    signature.toString('base64url') !== capability.signature ||
    !verifySignature(
      null,
      Buffer.from(runnerCapabilitySigningMessage(capability), 'utf8'),
      publicKey,
      signature,
    )
  )
    return { valid: false, reason: 'invalid_signature' };

  if (!(await input.replayGuard.claim(capability.keyId, capability.jti, expiresAt)))
    return { valid: false, reason: 'replayed' };
  return { valid: true, capability };
}

export type RunnerAdmission =
  | { admitted: true; request: RunnerExecutionRequest; profile: RunnerExecutionProfile }
  | {
      admitted: false;
      reason:
        | 'invalid_request'
        | 'unapproved_profile'
        | 'firmware_digest_mismatch'
        | 'invalid_capability'
        | 'unknown_key'
        | 'invalid_signature'
        | 'expired'
        | 'replayed';
    };

/** The only admission entry point: schema, admin profile, source hash, signature, TTL, and replay. */
export async function admitRunnerExecutionRequest(input: {
  request: unknown;
  profile: unknown;
  publicKeys: Readonly<Record<string, string | KeyObject>>;
  replayGuard: RunnerCapabilityReplayGuard;
  now?: number;
}): Promise<RunnerAdmission> {
  const parsed = runnerExecutionRequestSchema.safeParse(input.request);
  const profile = runnerExecutionProfileSchema.safeParse(input.profile);
  if (!parsed.success || !profile.success) return { admitted: false, reason: 'invalid_request' };
  if (!runnerRequestMatchesProfile(parsed.data, profile.data))
    return { admitted: false, reason: 'unapproved_profile' };
  if (!(await verifyRunnerFirmwareDigest(parsed.data.payload)))
    return { admitted: false, reason: 'firmware_digest_mismatch' };
  const capability = await verifyRunnerCapability({
    capability: parsed.data.capability,
    payloadDigest: parsed.data.payloadDigest,
    runId: parsed.data.payload.runId,
    attemptId: parsed.data.payload.attemptId,
    deadlineAt: parsed.data.payload.deadlineAt,
    publicKeys: input.publicKeys,
    replayGuard: input.replayGuard,
    now: input.now,
  });
  if (!capability.valid) return { admitted: false, reason: capability.reason };
  return { admitted: true, request: parsed.data, profile: profile.data };
}

export type RunnerResponseVerification =
  | { valid: true; authenticated: RunnerAuthenticatedResponse }
  | {
      valid: false;
      reason:
        | 'invalid_response'
        | 'unknown_key'
        | 'invalid_signature'
        | 'expired'
        | 'replayed'
        | 'response_mismatch';
    };

export type RunnerResponseVerificationInput = {
  authenticatedResponse: unknown;
  expected: {
    requestJti: string;
    runId: string;
    attemptId: string;
    payloadDigest: string;
    executionProfileId: string;
    imageDigest: string;
    bindingDigest: string;
    notBefore: string;
    deadlineAt: string;
  };
  publicKeys: Readonly<Record<string, string | KeyObject>>;
  now?: number;
};

/** Validate the signed protocol envelope without consuming its one-use response ID. */
export async function verifyRunnerExecutionResponsePure(
  input: RunnerResponseVerificationInput,
): Promise<RunnerResponseVerification> {
  const parsed = runnerAuthenticatedResponseSchema.safeParse(input.authenticatedResponse);
  if (!parsed.success) return { valid: false, reason: 'invalid_response' };

  const authenticated = parsed.data;
  const response = authenticated.response;
  if (
    authenticated.requestJti !== input.expected.requestJti ||
    response.runId !== input.expected.runId ||
    response.attemptId !== input.expected.attemptId ||
    response.payloadDigest !== input.expected.payloadDigest ||
    response.executionProfileId !== input.expected.executionProfileId ||
    response.imageDigest !== input.expected.imageDigest ||
    (response.run !== null &&
      runnerSimulationBindingDigest(response.run.binding) !== input.expected.bindingDigest) ||
    runnerResponseDigest(response) !== authenticated.responseDigest
  )
    return { valid: false, reason: 'response_mismatch' };

  const now = input.now ?? Date.now();
  const issuedAt = Date.parse(authenticated.issuedAt);
  const requestNotBefore = Date.parse(input.expected.notBefore);
  const deadlineAt = Date.parse(input.expected.deadlineAt);
  const startedAt = response.startedAt ? Date.parse(response.startedAt) : null;
  const finishedAt = response.finishedAt ? Date.parse(response.finishedAt) : null;
  const cleanupAt = response.cleanupReceipt
    ? Date.parse(response.cleanupReceipt.completedAt)
    : null;
  if (
    !Number.isFinite(issuedAt) ||
    !Number.isFinite(requestNotBefore) ||
    !Number.isFinite(deadlineAt) ||
    issuedAt < requestNotBefore - 15_000 ||
    issuedAt > deadlineAt + MAX_RUNNER_RESPONSE_GRACE_MS ||
    (finishedAt === null && issuedAt > deadlineAt + RUNNER_EXECUTION_CLOCK_SKEW_MS) ||
    issuedAt > now + 15_000 ||
    now > deadlineAt + MAX_RUNNER_RESPONSE_GRACE_MS + RUNNER_EXECUTION_CLOCK_SKEW_MS ||
    (startedAt !== null && (!Number.isFinite(startedAt) || startedAt > deadlineAt)) ||
    (finishedAt !== null &&
      (!Number.isFinite(finishedAt) ||
        finishedAt > deadlineAt + RUNNER_EXECUTION_CLOCK_SKEW_MS ||
        (startedAt !== null && startedAt > finishedAt))) ||
    (cleanupAt !== null &&
      (!Number.isFinite(cleanupAt) ||
        cleanupAt < (finishedAt ?? Number.POSITIVE_INFINITY) ||
        cleanupAt > issuedAt))
  )
    return { valid: false, reason: 'expired' };

  const key = input.publicKeys[authenticated.keyId];
  if (!key) return { valid: false, reason: 'unknown_key' };
  let publicKey: KeyObject;
  try {
    publicKey = typeof key === 'string' ? createPublicKey(key) : key;
    if (publicKey.asymmetricKeyType !== 'ed25519') return { valid: false, reason: 'unknown_key' };
  } catch {
    return { valid: false, reason: 'unknown_key' };
  }

  const signature = Buffer.from(authenticated.signature, 'base64url');
  const { signature: _signature, ...unsigned } = authenticated;
  if (
    signature.length !== 64 ||
    signature.toString('base64url') !== authenticated.signature ||
    !verifySignature(
      null,
      Buffer.from(runnerResponseSigningMessage(unsigned), 'utf8'),
      publicKey,
      signature,
    )
  )
    return { valid: false, reason: 'invalid_signature' };

  return { valid: true, authenticated };
}

/** Authenticate a response and atomically consume its response ID before accepting it. */
export async function verifyRunnerExecutionResponse(
  input: RunnerResponseVerificationInput & { replayGuard: RunnerResponseReplayGuard },
): Promise<RunnerResponseVerification> {
  const verification = await verifyRunnerExecutionResponsePure(input);
  if (!verification.valid) return verification;

  const deadlineAt = Date.parse(input.expected.deadlineAt);
  if (
    !(await input.replayGuard.claim(
      verification.authenticated.keyId,
      verification.authenticated.responseJti,
      deadlineAt + MAX_RUNNER_RESPONSE_GRACE_MS + RUNNER_EXECUTION_CLOCK_SKEW_MS,
    ))
  )
    return { valid: false, reason: 'replayed' };
  return verification;
}
