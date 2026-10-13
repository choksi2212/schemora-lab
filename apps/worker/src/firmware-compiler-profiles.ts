import { firmwareCompilerProfileSchema, type FirmwareCompilerProfile } from '@schemora/simulation';

export const MAX_FIRMWARE_COMPILER_PROFILES = 16;
export const MAX_FIRMWARE_COMPILER_PROFILES_JSON_BYTES = 65_536;

export interface FirmwareCompilerProfileRegistry {
  resolve(profileId: string): FirmwareCompilerProfile;
}

function freezeProfile(profile: FirmwareCompilerProfile): FirmwareCompilerProfile {
  Object.freeze(profile.target);
  Object.freeze(profile.limits);
  return Object.freeze(profile);
}

/**
 * Build a trusted worker-owned allowlist. The input must come from deployment
 * configuration or reviewed source, never from a request or queue payload.
 * An empty registry intentionally leaves compilation disabled.
 */
export function createFirmwareCompilerProfileRegistry(
  profileInputs: readonly unknown[],
): FirmwareCompilerProfileRegistry {
  if (profileInputs.length > MAX_FIRMWARE_COMPILER_PROFILES)
    throw new Error('FIRMWARE_COMPILER_PROFILE_LIMIT');
  const profiles = new Map<string, FirmwareCompilerProfile>();
  for (const input of profileInputs) {
    const parsed = firmwareCompilerProfileSchema.safeParse(input);
    if (!parsed.success) throw new Error('FIRMWARE_COMPILER_PROFILE_INVALID');
    if (profiles.has(parsed.data.profileId)) throw new Error('FIRMWARE_COMPILER_PROFILE_DUPLICATE');
    profiles.set(parsed.data.profileId, freezeProfile(parsed.data));
  }
  return Object.freeze({
    resolve(profileId: string) {
      const profile = profiles.get(profileId);
      if (!profile) throw new Error('FIRMWARE_COMPILER_PROFILE_UNAVAILABLE');
      return profile;
    },
  });
}

/** Parse deployment-owned worker configuration; never parse profiles from jobs or API input. */
export function parseFirmwareCompilerProfileRegistryJson(
  serialized: string,
): FirmwareCompilerProfileRegistry {
  if (Buffer.byteLength(serialized, 'utf8') > MAX_FIRMWARE_COMPILER_PROFILES_JSON_BYTES)
    throw new Error('FIRMWARE_COMPILER_PROFILE_CONFIG_TOO_LARGE');
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new Error('FIRMWARE_COMPILER_PROFILE_CONFIG_INVALID');
  }
  if (!Array.isArray(parsed)) throw new Error('FIRMWARE_COMPILER_PROFILE_CONFIG_INVALID');
  return createFirmwareCompilerProfileRegistry(parsed);
}
