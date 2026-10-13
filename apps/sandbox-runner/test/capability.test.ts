import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  runnerCapabilitySchema,
  runnerCapabilitySigningMessage,
  runnerAuthenticatedResponseSchema,
  runnerResponseDigest,
  runnerResponseSigningMessage,
  type RunnerCapability,
} from '@schemora/simulation';
import { verifyRunnerCapability, verifyRunnerExecutionResponse } from '../src/capability.js';

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

function createAuthenticatedResponse(overrides: Record<string, unknown> = {}) {
  const response = {
    protocolVersion: '1.0.0',
    runId,
    attemptId,
    payloadDigest,
    executionProfileId: 'profile-test-v1',
    imageDigest: `sha256:${'c'.repeat(64)}`,
    status: 'accepted',
    startedAt: null,
    finishedAt: null,
    terminationReason: null,
    run: null,
    outputManifest: [],
    totalOutputBytes: 0,
    cleanupReceipt: null,
  };
  const unsigned = runnerAuthenticatedResponseSchema.parse({
    protocolVersion: '1.0.0',
    keyId: 'worker-test',
    requestJti: '8a748297-16b7-4451-9f4f-813d1ee86c31',
    responseJti: 'f6e4915d-3b5d-44e9-bd2e-2b5d6e41cbbb',
    issuedAt: new Date(now).toISOString(),
    responseDigest: runnerResponseDigest(response as never),
    response,
    signature: 'A'.repeat(86),
    ...overrides,
  });
  const { signature: _signature, ...signingInput } = unsigned;
  return runnerAuthenticatedResponseSchema.parse({
    ...unsigned,
    signature: sign(
      null,
      Buffer.from(runnerResponseSigningMessage(signingInput)),
      privateKey,
    ).toString('base64url'),
  });
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

describe('authenticated runner responses', () => {
  it('verifies signed response integrity, request binding, key identity, and one-use response IDs', async () => {
    const authenticatedResponse = createAuthenticatedResponse();
    const guard = replayGuard();
    const expected = {
      requestJti: authenticatedResponse.requestJti,
      runId,
      attemptId,
      payloadDigest,
      executionProfileId: authenticatedResponse.response.executionProfileId,
      imageDigest: authenticatedResponse.response.imageDigest,
      bindingDigest: 'b'.repeat(64),
      notBefore: new Date(now - 1_000).toISOString(),
      deadlineAt,
    };
    const input = {
      authenticatedResponse,
      expected,
      publicKeys,
      replayGuard: guard,
      now,
    };
    expect(await verifyRunnerExecutionResponse(input)).toMatchObject({ valid: true });
    expect(await verifyRunnerExecutionResponse(input)).toMatchObject({
      valid: false,
      reason: 'replayed',
    });
    expect(
      await verifyRunnerExecutionResponse({
        ...input,
        authenticatedResponse: {
          ...authenticatedResponse,
          response: { ...authenticatedResponse.response, imageDigest: `sha256:${'d'.repeat(64)}` },
        },
        replayGuard: replayGuard(),
      }),
    ).toMatchObject({ valid: false, reason: 'response_mismatch' });
    expect(
      await verifyRunnerExecutionResponse({
        ...input,
        expected: { ...expected, requestJti: '8a748297-16b7-4451-9f4f-813d1ee86c32' },
        replayGuard: replayGuard(),
      }),
    ).toMatchObject({ valid: false, reason: 'response_mismatch' });
    expect(
      await verifyRunnerExecutionResponse({
        ...input,
        authenticatedResponse: {
          ...authenticatedResponse,
          signature: 'B'.repeat(86),
        },
        replayGuard: replayGuard(),
      }),
    ).toMatchObject({ valid: false, reason: 'invalid_signature' });
    expect(
      await verifyRunnerExecutionResponse({
        ...input,
        authenticatedResponse: {
          ...authenticatedResponse,
          issuedAt: new Date(now + 200_000).toISOString(),
        },
        replayGuard: replayGuard(),
      }),
    ).toMatchObject({ valid: false, reason: 'expired' });
  });
});
