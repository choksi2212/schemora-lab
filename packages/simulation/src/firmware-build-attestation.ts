import { canonicalDigest } from '@schemora/assembly-plan';
import { z } from 'zod';

export const firmwareBuildAttestationClaimsSchema = z
  .object({
    schemaVersion: z.literal(1),
    keyId: z.string().min(1).max(160),
    jti: z.string().uuid(),
    issuedAt: z.string().datetime({ offset: true }),
    requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
    resultDigest: z.string().regex(/^[a-f0-9]{64}$/),
    artifactManifestDigest: z.string().regex(/^[a-f0-9]{64}$/),
    sourceArtifactId: z.string().uuid(),
    sourceManifestDigest: z.string().regex(/^[a-f0-9]{64}$/),
    compilerProfileId: z.string().min(1).max(100),
    compilerProfileDigest: z.string().regex(/^[a-f0-9]{64}$/),
    compilerVersion: z.string().min(1).max(40),
    imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  })
  .strict();

export const firmwareBuildAttestationSchema = firmwareBuildAttestationClaimsSchema
  .extend({
    signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
  })
  .strict();

export type FirmwareBuildAttestationClaims = z.infer<typeof firmwareBuildAttestationClaimsSchema>;
export type FirmwareBuildAttestation = z.infer<typeof firmwareBuildAttestationSchema>;

/** Domain separation prevents a build signature from authenticating another protocol. */
export function firmwareBuildAttestationSigningMessage(claimsInput: unknown): string {
  const claims = firmwareBuildAttestationClaimsSchema.parse(claimsInput);
  return `schemora.firmware-build.attestation.v1\n${canonicalDigest(claims)}`;
}

export function firmwareBuildAttestationDigest(attestationInput: unknown): string {
  const attestation = firmwareBuildAttestationSchema.parse(attestationInput);
  return canonicalDigest(attestation);
}
