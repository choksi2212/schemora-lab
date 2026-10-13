import { canonicalDigest } from '@schemora/assembly-plan';
import {
  firmwareProjectBundleSchema,
  verifyFirmwareProjectBundleSources,
  type FirmwareProjectBundle,
} from './firmware-project-bundle.js';
import {
  firmwareCompileResultMatchesProfile,
  firmwareCompileResultSchema,
  firmwareCompilerProfileSchema,
  type FirmwareCompileResult,
  type FirmwareCompilerProfile,
} from './firmware-compiler-profile.js';

export interface FirmwareCompilerSandboxOutput {
  /** Untrusted structured result; verified again against the selected profile below. */
  result: unknown;
  /** Binary contents keyed by their normalized output-relative paths. */
  artifacts: Record<string, Uint8Array>;
}

/** Implementations belong only in the separately isolated runner deployment. */
export interface FirmwareCompilerSandbox {
  compile(input: {
    profile: FirmwareCompilerProfile;
    bundle: FirmwareProjectBundle;
  }): Promise<FirmwareCompilerSandboxOutput>;
}

export interface FirmwareCompileArtifacts {
  result: FirmwareCompileResult;
  artifacts: Record<string, Uint8Array>;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const input = Uint8Array.from(bytes);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', input.buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Validate a source bundle, invoke only an injected isolated compiler, then
 * authenticate the bounded result and every returned binary before persistence.
 * This function never starts a subprocess or container itself.
 */
export async function compileFirmwareProject(
  bundleInput: unknown,
  profileInput: unknown,
  sandbox: FirmwareCompilerSandbox,
): Promise<FirmwareCompileArtifacts> {
  const bundle = firmwareProjectBundleSchema.safeParse(bundleInput);
  const profile = firmwareCompilerProfileSchema.safeParse(profileInput);
  if (!bundle.success || !profile.success) throw new Error('FIRMWARE_COMPILE_INPUT_INVALID');
  const source = bundle.data;
  const compilerProfile = profile.data;
  if (
    source.buildSystem !== compilerProfile.buildSystem ||
    canonicalDigest(source.target) !== canonicalDigest(compilerProfile.target)
  )
    throw new Error('FIRMWARE_COMPILER_PROFILE_MISMATCH');
  if (!(await verifyFirmwareProjectBundleSources(source)))
    throw new Error('FIRMWARE_SOURCE_INTEGRITY_FAILED');

  let output: FirmwareCompilerSandboxOutput;
  try {
    output = await sandbox.compile({ profile: compilerProfile, bundle: source });
  } catch {
    throw new Error('FIRMWARE_COMPILER_UNAVAILABLE');
  }
  if (
    !output ||
    typeof output !== 'object' ||
    !output.artifacts ||
    typeof output.artifacts !== 'object' ||
    Array.isArray(output.artifacts)
  )
    throw new Error('FIRMWARE_COMPILER_OUTPUT_INVALID');

  if (!firmwareCompileResultMatchesProfile(output.result, compilerProfile, source.manifestDigest))
    throw new Error('FIRMWARE_COMPILE_RESULT_MISMATCH');
  const result = firmwareCompileResultSchema.parse(output.result);
  const sourcePaths = new Set(source.files.map((file) => file.path));
  if (
    result.diagnostics.some(
      (diagnostic) => diagnostic.sourcePath !== null && !sourcePaths.has(diagnostic.sourcePath),
    )
  )
    throw new Error('FIRMWARE_COMPILE_DIAGNOSTIC_PATH_INVALID');
  const returnedFiles = Object.entries(output.artifacts);
  if (result.status !== 'succeeded') {
    if (returnedFiles.length !== 0) throw new Error('FIRMWARE_COMPILE_ARTIFACTS_UNEXPECTED');
    return { result, artifacts: {} };
  }

  if (returnedFiles.length !== result.artifacts.length)
    throw new Error('FIRMWARE_COMPILE_ARTIFACTS_INCOMPLETE');
  const verified: Record<string, Uint8Array> = Object.create(null) as Record<string, Uint8Array>;
  let aggregateBytes = 0;
  for (const manifest of result.artifacts) {
    const bytes = output.artifacts[manifest.path];
    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== manifest.byteLength)
      throw new Error('FIRMWARE_COMPILE_ARTIFACT_LENGTH_MISMATCH');
    aggregateBytes += bytes.byteLength;
    if (aggregateBytes > compilerProfile.limits.outputBytes)
      throw new Error('FIRMWARE_COMPILE_OUTPUT_LIMIT');
    if ((await sha256(bytes)) !== manifest.sha256)
      throw new Error('FIRMWARE_COMPILE_ARTIFACT_DIGEST_MISMATCH');
    verified[manifest.path] = Uint8Array.from(bytes);
  }
  return { result, artifacts: verified };
}
