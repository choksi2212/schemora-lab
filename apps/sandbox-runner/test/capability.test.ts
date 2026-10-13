import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  runnerCapabilitySchema,
  runnerCapabilitySigningMessage,
  type RunnerCapability,
} from '@schemora/simulation';
import { verifyRunnerCapability } from '../src/capability.js';

const now = Date.parse('2026-10-14T10:00:00.000Z');
const runId = '6fb8f60e-ec9a-4d29-9122-4d2bf13e9c43';
const attemptId = 'a0359097-8a38-4650-a34d-61c039800d47';
const payloadDigest = 'a'.repeat(64);
const deadlineAt = new Date(now + 90_000).toISOString();
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const publicKeys = { 'worker-test': publicKey };

function createCapability(overrides: Partial<RunnerCapability> = {}): RunnerCapability {
  const unsigned = runnerCapabilitySchema.parse({
    keyId: 'worker-test',
    audience: 'schemora-sandbox-runner',
    runId,
    attemptId,
    jti: '8a748297-16b7-4451-9f4f-813d1ee86c31',
    payloadDigest,
    notBefore: new Date(now - 1_000).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString(),
    signature: 'A'.repeat(86),
    ...overrides,
  });
  const signature = sign(
    null,
    Buffer.from(runnerCapabilitySigningMessage(unsigned)),
    privateKey,
  ).toString('base64url');
  return runnerCapabilitySchema.parse({ ...unsigned, signature });
}

function replayGuard() {
  const claimed = new Set<string>();
  return {
    claim: async (keyId: string, jti: string) => {
      const key = `${keyId}:${jti}`;
      if (claimed.has(key)) return false;
      claimed.add(key);
      return true;
    },
  };
}

describe('runner execution capability', () => {
  it('verifies an Ed25519 capability bound to run, attempt, payload, audience, and deadline', async () => {
    const guard = replayGuard();
    const capability = createCapability();
    const verified = await verifyRunnerCapability({
      capability,
      payloadDigest,
      runId,
      attemptId,
      deadlineAt,
      publicKeys,
      replayGuard: guard,
      now,
    });
    expect(verified.valid).toBe(true);
    expect(
      await verifyRunnerCapability({
        capability,
        payloadDigest,
        runId,
        attemptId,
        deadlineAt,
        publicKeys,
        replayGuard: guard,
        now,
      }),
    ).toMatchObject({ valid: false, reason: 'replayed' });
  });

  it('rejects invalid signatures, wrong bindings, unknown keys, and expired capabilities', async () => {
    const capability = createCapability();
    const base = { runId, attemptId, deadlineAt, publicKeys, replayGuard: replayGuard(), now };
    expect(
      await verifyRunnerCapability({
        ...base,
        capability: { ...capability, signature: 'B'.repeat(86) },
        payloadDigest,
      }),
    ).toMatchObject({ valid: false, reason: 'invalid_signature' });
    expect(
      await verifyRunnerCapability({ ...base, capability, payloadDigest: 'b'.repeat(64) }),
    ).toMatchObject({ valid: false, reason: 'invalid_capability' });
    expect(
      await verifyRunnerCapability({ ...base, capability, payloadDigest, publicKeys: {} }),
    ).toMatchObject({ valid: false, reason: 'unknown_key' });

    const expired = createCapability({
      notBefore: new Date(now - 120_000).toISOString(),
      expiresAt: new Date(now - 1).toISOString(),
    });
    expect(
      await verifyRunnerCapability({ ...base, capability: expired, payloadDigest }),
    ).toMatchObject({ valid: false, reason: 'expired' });
  });
});
