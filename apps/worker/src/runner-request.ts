import { createHash } from 'node:crypto';
import { canonicalDigest } from '@schemora/assembly-plan';
import {
  firmwareArtifactRefSchema,
  firmwareProjectBundleSchema,
  runnerExecutionPayloadSchema,
  runnerExecutionProfileSchema,
  runnerPayloadMatchesProfile,
  verifyFirmwareProjectBundleSources,
  type FirmwareProjectBundle,
  type RunnerExecutionPayload,
  type RunnerExecutionProfile,
  type SimulationBinding,
} from '@schemora/simulation';

/** Inputs read from immutable run snapshots, with all stores kept outside this pure builder. */
export type FrozenRunnerRunInputs = {
  readonly runId: string;
  readonly binding: SimulationBinding;
  readonly graph: unknown;
  readonly catalog: unknown;
  readonly validation: unknown;
  readonly validationReportId: string;
  readonly validationReportDigest: string;
};

export type VerifiedRunnerFirmwareSource =
  | { readonly kind: 'single-file'; readonly bytes: Uint8Array }
  | { readonly kind: 'bundle'; readonly bundle: FirmwareProjectBundle };

export type RunnerPayloadAssemblyFailure =
  | 'invalid_run_inputs'
  | 'invalid_firmware_reference'
  | 'firmware_integrity_mismatch'
  | 'invalid_firmware_source'
  | 'invalid_execution_profile'
  | 'profile_mismatch';

export type RunnerPayloadAssemblyResult =
  | { ok: true; payload: RunnerExecutionPayload }
  | { ok: false; reason: RunnerPayloadAssemblyFailure };

/**
 * Assemble and validate the immutable payload that a later dispatch layer may sign.
 * The caller must obtain `profile` from its trusted worker-owned registry and
 * frozen inputs from the run's immutable database snapshots. This function has
 * no side effects and does not make a run executable or create an attempt.
 */
export async function assembleRunnerExecutionPayload(input: {
  readonly run: FrozenRunnerRunInputs;
  readonly firmware: unknown;
  readonly firmwareReviewRevision: number;
  readonly source: VerifiedRunnerFirmwareSource;
  readonly profile: unknown;
  readonly attemptId: string;
  readonly deadlineAt: string;
}): Promise<RunnerPayloadAssemblyResult> {
  const firmware = firmwareArtifactRefSchema.safeParse(input.firmware);
  if (!firmware.success) return { ok: false, reason: 'invalid_firmware_reference' };

  const profile = runnerExecutionProfileSchema.safeParse(input.profile);
  if (!profile.success) return { ok: false, reason: 'invalid_execution_profile' };

  let firmwareBase64: string | undefined;
  let firmwareProjectBundle: FirmwareProjectBundle | undefined;
  if (input.source.kind === 'single-file') {
    const bytes = input.source.bytes;
    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== firmware.data.byteLength)
      return { ok: false, reason: 'firmware_integrity_mismatch' };
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== firmware.data.sha256 || firmware.data.bundleDigest !== undefined)
      return { ok: false, reason: 'firmware_integrity_mismatch' };
    firmwareBase64 = Buffer.from(bytes).toString('base64');
  } else if (input.source.kind === 'bundle') {
    const bundle = firmwareProjectBundleSchema.safeParse(input.source.bundle);
    if (!bundle.success) return { ok: false, reason: 'invalid_firmware_source' };
    if (
      !(await verifyFirmwareProjectBundleSources(bundle.data)) ||
      firmware.data.bundleDigest !== bundle.data.manifestDigest ||
      firmware.data.totalByteLength !== bundle.data.totalByteLength ||
      firmware.data.buildSystem !== bundle.data.buildSystem ||
      firmware.data.target === undefined ||
      canonicalDigest(firmware.data.target) !== canonicalDigest(bundle.data.target) ||
      firmware.data.entrypoint !== bundle.data.entrypoint ||
      firmware.data.byteLength !==
        (bundle.data.files.find((file) => file.path === bundle.data.entrypoint)?.byteLength ?? -1)
    )
      return { ok: false, reason: 'firmware_integrity_mismatch' };
    firmwareProjectBundle = bundle.data;
  } else {
    return { ok: false, reason: 'invalid_firmware_source' };
  }

  const payload = runnerExecutionPayloadSchema.safeParse({
    runId: input.run.runId,
    attemptId: input.attemptId,
    binding: input.run.binding,
    graph: input.run.graph,
    catalog: input.run.catalog,
    validation: input.run.validation,
    validationReportId: input.run.validationReportId,
    validationReportDigest: input.run.validationReportDigest,
    firmware: firmware.data,
    firmwareReviewRevision: input.firmwareReviewRevision,
    ...(firmwareBase64 === undefined ? {} : { firmwareBase64 }),
    ...(firmwareProjectBundle === undefined ? {} : { firmwareProjectBundle }),
    executionProfileId: profile.data.profileId,
    deadlineAt: input.deadlineAt,
  });
  if (!payload.success) return { ok: false, reason: 'invalid_run_inputs' };
  if (!runnerPayloadMatchesProfile(payload.data, profile.data))
    return { ok: false, reason: 'profile_mismatch' };
  return { ok: true, payload: payload.data };
}
