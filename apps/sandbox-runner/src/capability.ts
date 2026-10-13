import { createPublicKey, verify as verifySignature, type KeyObject } from 'node:crypto';
import {
  MAX_RUNNER_CAPABILITY_TTL_MS,
  runnerCapabilitySchema,
  runnerCapabilitySigningMessage,
  runnerExecutionRequestSchema,
  runnerRequestMatchesProfile,
  runnerExecutionProfileSchema,
  verifyRunnerFirmwareDigest,
  type RunnerExecutionProfile,
  type RunnerExecutionRequest,
  type RunnerCapability,
} from '@schemora/simulation';

export interface RunnerCapabilityReplayGuard {
  /** Atomically claim keyId+jti until expiresAt; return false if it was already claimed. */
  claim(keyId: string, jti: string, expiresAt: number): Promise<boolean>;
}

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
