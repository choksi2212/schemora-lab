import { createPrivateKey, sign } from 'node:crypto';
import {
  firmwareBuildAttestationClaimsSchema,
  firmwareBuildAttestationSchema,
  firmwareBuildAttestationSigningMessage,
} from '@schemora/simulation';

/** Sign normalized claims only after the caller has verified result and artifact hashes. */
export function signFirmwareBuildAttestation(input: { claims: unknown; privateKey: string }) {
  const claims = firmwareBuildAttestationClaimsSchema.parse(input.claims);
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
