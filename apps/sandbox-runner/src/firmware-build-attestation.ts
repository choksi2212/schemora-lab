import { createHash, createPrivateKey, sign } from 'node:crypto';
import { canonicalDigest } from '@schemora/assembly-plan';
import {
  firmwareBuildAttestationClaimsSchema,
  firmwareBuildRequestDigest,
  firmwareCompileResultSchema,
  firmwareBuildAttestationSchema,
  firmwareBuildAttestationSigningMessage,
} from '@schemora/simulation';

/** Verify the exact normalized compiler result and bytes before signing its claims. */
export function signFirmwareBuildAttestation(input: {
  claims: unknown;
  result: unknown;
  artifacts: Record<string, Uint8Array>;
  privateKey: string;
}) {
  const claims = firmwareBuildAttestationClaimsSchema.parse(input.claims);
  const result = firmwareCompileResultSchema.parse(input.result);
  if (
    claims.requestDigest !==
      firmwareBuildRequestDigest({
        sourceArtifactId: claims.sourceArtifactId,
        sourceManifestDigest: claims.sourceManifestDigest,
        compilerProfileDigest: claims.compilerProfileDigest,
      }) ||
    claims.resultDigest !== canonicalDigest(result) ||
    claims.artifactManifestDigest !== canonicalDigest(result.artifacts) ||
    claims.sourceManifestDigest !== result.sourceManifestDigest ||
    claims.compilerProfileDigest !== result.profileDigest ||
    claims.compilerVersion !== result.compilerVersion ||
    claims.imageDigest !== result.imageDigest
  )
    throw new Error('FIRMWARE_BUILD_SIGNING_CLAIMS_MISMATCH');

  const artifacts = Object.entries(input.artifacts);
  if (result.status !== 'succeeded') {
    if (artifacts.length !== 0) throw new Error('FIRMWARE_BUILD_SIGNING_ARTIFACTS_UNEXPECTED');
  } else {
    if (artifacts.length !== result.artifacts.length)
      throw new Error('FIRMWARE_BUILD_SIGNING_ARTIFACTS_INCOMPLETE');
    for (const manifest of result.artifacts) {
      const bytes = input.artifacts[manifest.path];
      if (
        !(bytes instanceof Uint8Array) ||
        bytes.byteLength !== manifest.byteLength ||
        createHash('sha256').update(bytes).digest('hex') !== manifest.sha256
      )
        throw new Error('FIRMWARE_BUILD_SIGNING_ARTIFACT_MISMATCH');
    }
  }
  const privateKey = createPrivateKey(input.privateKey);
  if (privateKey.asymmetricKeyType !== 'ed25519')
    throw new Error('FIRMWARE_BUILD_SIGNING_KEY_INVALID');
  const signature = sign(
    null,
    Buffer.from(firmwareBuildAttestationSigningMessage(claims), 'utf8'),
    privateKey,
  ).toString('base64url');
  return firmwareBuildAttestationSchema.parse({ ...claims, signature });
}
