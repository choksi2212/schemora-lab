import { createPublicKey, verify as verifySignature, type KeyObject } from 'node:crypto';
import {
  firmwareBuildAttestationClaimsSchema,
  firmwareBuildAttestationSchema,
  firmwareBuildAttestationSigningMessage,
  type FirmwareBuildAttestation,
} from '@schemora/simulation';

export const FIRMWARE_BUILD_ATTESTATION_MAX_AGE_MS = 10 * 60_000;
const FUTURE_SKEW_MS = 15_000;
const FIRMWARE_ATTESTATION_KEY_LIMIT = 16;
const FIRMWARE_ATTESTATION_KEY_CONFIG_BYTES = 65_536;

export interface FirmwareBuildAttestationExpectation {
  requestDigest: string;
  resultDigest: string;
  artifactManifestDigest: string;
  sourceArtifactId: string;
  sourceManifestDigest: string;
  compilerProfileId: string;
  compilerProfileDigest: string;
  compilerVersion: string;
  imageDigest: string;
}

export type FirmwareBuildAttestationVerification =
  | { valid: true; attestation: FirmwareBuildAttestation; expiresAt: Date }
  | {
      valid: false;
      reason: 'invalid_attestation' | 'unknown_key' | 'invalid_signature' | 'expired';
    };

/** Parse a deployment-owned Ed25519 public-key ring. */
export function parseFirmwareBuildAttestationPublicKeysJson(
  serialized: string,
): Readonly<Record<string, KeyObject>> {
  if (Buffer.byteLength(serialized, 'utf8') > FIRMWARE_ATTESTATION_KEY_CONFIG_BYTES)
    throw new Error('FIRMWARE_BUILD_ATTESTATION_KEYS_TOO_LARGE');
  let raw: unknown;
  try {
    raw = JSON.parse(serialized);
  } catch {
    throw new Error('FIRMWARE_BUILD_ATTESTATION_KEYS_INVALID');
  }
  if (
    raw === null ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    Object.keys(raw).length > FIRMWARE_ATTESTATION_KEY_LIMIT
  )
    throw new Error('FIRMWARE_BUILD_ATTESTATION_KEYS_INVALID');
  const keys: Record<string, KeyObject> = Object.create(null) as Record<string, KeyObject>;
  for (const [keyId, encoded] of Object.entries(raw)) {
    if (
      keyId.length < 1 ||
      keyId.length > 160 ||
      typeof encoded !== 'string' ||
      encoded.length > 8192 ||
      !encoded.trim().startsWith('-----BEGIN PUBLIC KEY-----')
    )
      throw new Error('FIRMWARE_BUILD_ATTESTATION_KEY_INVALID');
    try {
      const key = createPublicKey(encoded);
      if (key.type !== 'public' || key.asymmetricKeyType !== 'ed25519')
        throw new Error('FIRMWARE_BUILD_ATTESTATION_KEY_INVALID');
      keys[keyId] = key;
    } catch {
      throw new Error('FIRMWARE_BUILD_ATTESTATION_KEY_INVALID');
    }
  }
  return Object.freeze(keys);
}

/**
 * Verify a runner-signed compiler claim. Replay prevention remains a separate
 * database transaction step so signature verification itself is side-effect free.
 */
export function verifyFirmwareBuildAttestation(input: {
  attestation: unknown;
  expected: FirmwareBuildAttestationExpectation;
  publicKeys: Readonly<Record<string, string | KeyObject>>;
  now?: number;
}): FirmwareBuildAttestationVerification {
  const parsed = firmwareBuildAttestationSchema.safeParse(input.attestation);
  if (!parsed.success) return { valid: false, reason: 'invalid_attestation' };
  const attestation = parsed.data;
  const claims = firmwareBuildAttestationClaimsSchema.parse({
    schemaVersion: attestation.schemaVersion,
    keyId: attestation.keyId,
    jti: attestation.jti,
    issuedAt: attestation.issuedAt,
    requestDigest: attestation.requestDigest,
    resultDigest: attestation.resultDigest,
    artifactManifestDigest: attestation.artifactManifestDigest,
    sourceArtifactId: attestation.sourceArtifactId,
    sourceManifestDigest: attestation.sourceManifestDigest,
    compilerProfileId: attestation.compilerProfileId,
    compilerProfileDigest: attestation.compilerProfileDigest,
    compilerVersion: attestation.compilerVersion,
    imageDigest: attestation.imageDigest,
  });
  if (
    Object.entries(input.expected).some(
      ([key, value]) => claims[key as keyof typeof claims] !== value,
    )
  )
    return { valid: false, reason: 'invalid_attestation' };

  const now = input.now ?? Date.now();
  const issuedAt = Date.parse(attestation.issuedAt);
  if (
    !Number.isFinite(issuedAt) ||
    issuedAt > now + FUTURE_SKEW_MS ||
    now - issuedAt > FIRMWARE_BUILD_ATTESTATION_MAX_AGE_MS
  )
    return { valid: false, reason: 'expired' };

  const configuredKey = input.publicKeys[attestation.keyId];
  if (!configuredKey) return { valid: false, reason: 'unknown_key' };
  let publicKey: KeyObject;
  try {
    if (
      typeof configuredKey === 'string' &&
      !configuredKey.trim().startsWith('-----BEGIN PUBLIC KEY-----')
    )
      return { valid: false, reason: 'unknown_key' };
    publicKey = typeof configuredKey === 'string' ? createPublicKey(configuredKey) : configuredKey;
    if (publicKey.type !== 'public' || publicKey.asymmetricKeyType !== 'ed25519')
      return { valid: false, reason: 'unknown_key' };
  } catch {
    return { valid: false, reason: 'unknown_key' };
  }

  const signature = Buffer.from(attestation.signature, 'base64url');
  if (
    signature.length !== 64 ||
    signature.toString('base64url') !== attestation.signature ||
    !verifySignature(
      null,
      Buffer.from(firmwareBuildAttestationSigningMessage(claims), 'utf8'),
      publicKey,
      signature,
    )
  )
    return { valid: false, reason: 'invalid_signature' };

  return {
    valid: true,
    attestation,
    expiresAt: new Date(issuedAt + FIRMWARE_BUILD_ATTESTATION_MAX_AGE_MS + FUTURE_SKEW_MS),
  };
}
