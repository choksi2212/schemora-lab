import { canonicalDigest } from '@schemora/assembly-plan';
import { catalogReleaseSchema, type CatalogRelease } from '@schemora/catalog';
import {
  circuitGraphSchema,
  validateCircuitGraph,
  type CircuitGraph,
} from '@schemora/circuit-model';
import {
  validateCircuit,
  validationReportSchema,
  type ValidationReport,
} from '@schemora/validation';
import { z } from 'zod';
import {
  firmwareProjectBuildSystemSchema,
  firmwareProjectBundleSchema,
  firmwareProjectTargetSchema,
  verifyFirmwareProjectBundleSources,
} from './firmware-project-bundle.js';
export {
  firmwareCompileArtifactSchema,
  firmwareCompileDiagnosticSchema,
  firmwareCompileResultSchema,
  firmwareCompilerProfileDigest,
  firmwareCompilerProfileSchema,
  firmwareCompileResultMatchesProfile,
  type FirmwareCompileArtifact,
  type FirmwareCompileDiagnostic,
  type FirmwareCompileResult,
  type FirmwareCompilerProfile,
} from './firmware-compiler-profile.js';
export {
  compileFirmwareProject,
  type FirmwareCompileArtifacts,
  type FirmwareCompilerSandbox,
  type FirmwareCompilerSandboxOutput,
} from './firmware-compiler.js';

export { mapEsp32Gpio19ToLedState } from './adapters/esp32-gpio19-led.js';
export type { Esp32Gpio19Signal, LedStateMapping } from './adapters/esp32-gpio19-led.js';
export {
  createFirmwareProjectBundle,
  firmwareProjectBuildSystemSchema,
  firmwareProjectBundleSchema,
  firmwareProjectPathSchema,
  firmwareProjectTargetSchema,
  verifyFirmwareProjectBundleSources,
  FIRMWARE_BUNDLE_MAX_FILES,
  FIRMWARE_BUNDLE_MAX_FILE_BYTES,
  FIRMWARE_BUNDLE_MAX_PATH_BYTES,
  FIRMWARE_BUNDLE_MAX_TOTAL_BYTES,
  type FirmwareProjectBuildSystem,
  type FirmwareProjectBundle,
  type FirmwareProjectBundleFile,
  type FirmwareProjectBundleInput,
  type FirmwareProjectTarget,
} from './firmware-project-bundle.js';
export {
  normalizeQemuReferenceCallbacks,
  type QemuCallbackNormalization,
} from './adapters/qemu-callback-normalizer.js';

export const SIMULATION_CONTRACT_VERSION = '1.0.0';
export const MAX_SIMULATION_RESULT_BYTES = 2_000_000;
export const MAX_SIMULATION_EVENTS = 5_000;
export const MAX_FIRMWARE_ARTIFACT_BYTES = 2_000_000;

export const firmwareArtifactRefSchema = z
  .object({
    schemaVersion: z.literal(1),
    artifactId: z.string().min(1).max(200),
    projectId: z.string().min(1).max(200),
    // Revision when this immutable source artifact was created or attached.
    // A run separately binds the exact current graph revision and digest.
    projectRevision: z.number().int().positive(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    byteLength: z.number().int().positive().max(MAX_FIRMWARE_ARTIFACT_BYTES),
    bundleDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    totalByteLength: z.number().int().positive().max(8_000_000).optional(),
    buildSystem: firmwareProjectBuildSystemSchema.optional(),
    target: firmwareProjectTargetSchema.optional(),
    language: z.enum(['c', 'cpp', 'arduino-cpp', 'esp-idf-c']),
    entrypoint: z.string().min(1).max(240),
    boardPartId: z.string().min(1).max(200),
    catalogReleaseId: z.string().min(1).max(100),
    reviewStatus: z.literal('accepted'),
  })
  .strict()
  .superRefine((artifact, ctx) => {
    if ((artifact.bundleDigest === undefined) !== (artifact.totalByteLength === undefined))
      ctx.addIssue({
        code: 'custom',
        path: ['bundleDigest'],
        message: 'Bundle digest and aggregate byte length must be supplied together.',
      });
    if (
      artifact.bundleDigest !== undefined &&
      (artifact.buildSystem === undefined || artifact.target === undefined)
    )
      ctx.addIssue({
        code: 'custom',
        path: ['buildSystem'],
        message: 'Bundle references must identify their build system and target.',
      });
    if (
      (artifact.buildSystem === undefined) !== (artifact.target === undefined) ||
      (artifact.buildSystem === 'arduino-cli' && artifact.target?.kind !== 'arduino-fqbn') ||
      (artifact.buildSystem === 'esp-idf' && artifact.target?.kind !== 'esp-idf-target')
    )
      ctx.addIssue({
        code: 'custom',
        path: ['target'],
        message: 'Build system and target identity must be supplied as a compatible pair.',
      });
  });

function firmwareBindingDigest(firmware: FirmwareArtifactRef) {
  return firmware.bundleDigest ?? firmware.sha256;
}

export const simulationBindingSchema = z
  .object({
    projectId: z.string().min(1),
    projectRevision: z.number().int().positive(),
    graphId: z.string().min(1),
    graphDigest: z.string().regex(/^[a-f0-9]{64}$/),
    catalogReleaseId: z.string().min(1),
    catalogDigest: z.string().regex(/^[a-f0-9]{64}$/),
    firmwareArtifactId: z.string().min(1),
    firmwareDigest: z.string().regex(/^[a-f0-9]{64}$/),
    firmwareByteLength: z.number().int().positive().max(8_000_000).optional(),
    adapterId: z.string().min(1),
    adapterVersion: z.string().min(1),
    engineId: z.string().min(1),
    engineVersion: z.string().min(1),
  })
  .strict();

export const simulationEventSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('serial'),
      sequence: z.number().int().nonnegative(),
      simulationTimeMs: z.number().finite().nonnegative(),
      text: z.string().max(1_024),
      stream: z.enum(['stdout', 'stderr']),
    })
    .strict(),
  z
    .object({
      kind: z.literal('led_state'),
      sequence: z.number().int().nonnegative(),
      simulationTimeMs: z.number().finite().nonnegative(),
      componentInstanceId: z.string().min(1),
      state: z.enum(['on', 'off']),
    })
    .strict(),
  z
    .object({
      kind: z.literal('sensor_reading'),
      sequence: z.number().int().nonnegative(),
      simulationTimeMs: z.number().finite().nonnegative(),
      componentInstanceId: z.string().min(1),
      sensorId: z.string().min(1),
      value: z.number().finite(),
      unit: z.string().min(1).max(40),
    })
    .strict(),
]);

export const simulationFailureCodeSchema = z.enum([
  'SIMULATOR_UNAVAILABLE',
  'UNSUPPORTED_BOARD',
  'UNSUPPORTED_COMPONENT',
  'UNSUPPORTED_TOPOLOGY',
  'UNSUPPORTED_FIRMWARE',
  'STALE_INPUT',
  'VALIDATION_NOT_PASSED',
  'COMPILATION_FAILED',
  'ENGINE_FAILED',
  'OUTPUT_INVALID',
  'TIME_LIMIT',
  'CANCELLED',
  'STOPPED',
]);

export const simulationRunStatusSchema = z.enum([
  'unsupported',
  'queued',
  'preparing',
  'running',
  'stopping',
  'completed',
  'stopped',
  'failed',
  'timed_out',
  'cancelled',
]);

export const simulationRunSchema = z
  .object({
    schemaVersion: z.literal(1),
    contractVersion: z.literal(SIMULATION_CONTRACT_VERSION),
    runId: z.string().min(1),
    status: simulationRunStatusSchema,
    binding: simulationBindingSchema,
    events: z.array(simulationEventSchema).max(MAX_SIMULATION_EVENTS),
    unsupportedFeatures: z.array(z.string().min(1).max(300)).max(500),
    limitations: z.array(z.string().min(1).max(500)).max(500),
    failure: z
      .object({ code: simulationFailureCodeSchema, message: z.string().min(1).max(2_000) })
      .strict()
      .nullable(),
    simulatedDurationMs: z.number().finite().nonnegative().nullable(),
  })
  .strict()
  .superRefine((run, ctx) => {
    const terminal = ['completed', 'stopped', 'failed', 'timed_out', 'cancelled'].includes(
      run.status,
    );
    let previousSequence = -1;
    let previousTime = -1;
    for (const [index, event] of run.events.entries()) {
      if (event.sequence <= previousSequence)
        ctx.addIssue({
          code: 'custom',
          path: ['events', index, 'sequence'],
          message: 'Event sequence must be strictly increasing.',
        });
      if (event.simulationTimeMs < previousTime)
        ctx.addIssue({
          code: 'custom',
          path: ['events', index, 'simulationTimeMs'],
          message: 'Simulation time must be monotonic.',
        });
      previousSequence = event.sequence;
      previousTime = event.simulationTimeMs;
    }
    if (run.status === 'completed' && run.failure !== null)
      ctx.addIssue({
        code: 'custom',
        path: ['failure'],
        message: 'A completed run cannot contain a failure.',
      });
    if (run.status === 'completed' && run.simulatedDurationMs === null)
      ctx.addIssue({
        code: 'custom',
        path: ['simulatedDurationMs'],
        message: 'A completed run must include its simulated duration.',
      });
    if (
      (run.status === 'failed' || run.status === 'timed_out' || run.status === 'cancelled') &&
      run.failure === null
    )
      ctx.addIssue({
        code: 'custom',
        path: ['failure'],
        message: 'A failed, timed-out, or cancelled run must explain its terminal result.',
      });
    if (
      run.status === 'unsupported' &&
      run.failure?.code !== 'SIMULATOR_UNAVAILABLE' &&
      !run.unsupportedFeatures.length
    )
      ctx.addIssue({
        code: 'custom',
        path: ['unsupportedFeatures'],
        message: 'An unsupported run must identify a capability gap.',
      });
    if (run.status === 'unsupported' && run.failure === null)
      ctx.addIssue({
        code: 'custom',
        path: ['failure'],
        message: 'An unsupported run must include an actionable failure code.',
      });
    if (
      run.status === 'unsupported' &&
      run.failure !== null &&
      ![
        'SIMULATOR_UNAVAILABLE',
        'UNSUPPORTED_BOARD',
        'UNSUPPORTED_COMPONENT',
        'UNSUPPORTED_TOPOLOGY',
        'UNSUPPORTED_FIRMWARE',
      ].includes(run.failure.code)
    )
      ctx.addIssue({
        code: 'custom',
        path: ['failure', 'code'],
        message: 'Unsupported runs must use an availability or coverage error code.',
      });
    if (['queued', 'preparing', 'unsupported'].includes(run.status) && run.events.length > 0)
      ctx.addIssue({
        code: 'custom',
        path: ['events'],
        message: 'Queued, preparing, and unsupported runs cannot contain simulator events.',
      });
    if (['queued', 'preparing', 'running', 'stopping'].includes(run.status) && run.failure !== null)
      ctx.addIssue({
        code: 'custom',
        path: ['failure'],
        message: 'A non-terminal run cannot contain a terminal failure.',
      });
    if (terminal !== (run.simulatedDurationMs !== null))
      ctx.addIssue({
        code: 'custom',
        path: ['simulatedDurationMs'],
        message: 'Only terminal runs may include a simulated duration.',
      });
    if (run.status === 'stopped' && run.failure?.code !== 'STOPPED')
      ctx.addIssue({
        code: 'custom',
        path: ['failure', 'code'],
        message: 'A stopped run must use the STOPPED result code.',
      });
    if (run.status === 'timed_out' && run.failure?.code !== 'TIME_LIMIT')
      ctx.addIssue({
        code: 'custom',
        path: ['failure', 'code'],
        message: 'A timed-out run must use the TIME_LIMIT result code.',
      });
    if (run.status === 'cancelled' && run.failure?.code !== 'CANCELLED')
      ctx.addIssue({
        code: 'custom',
        path: ['failure', 'code'],
        message: 'A cancelled run must use the CANCELLED result code.',
      });
    if (new TextEncoder().encode(JSON.stringify(run)).byteLength > MAX_SIMULATION_RESULT_BYTES)
      ctx.addIssue({
        code: 'custom',
        path: [],
        message: `Serialized simulation output exceeds ${MAX_SIMULATION_RESULT_BYTES} bytes.`,
      });
  });

export type FirmwareArtifactRef = z.infer<typeof firmwareArtifactRefSchema>;
export type SimulationBinding = z.infer<typeof simulationBindingSchema>;
export type SimulationEvent = z.infer<typeof simulationEventSchema>;
export type SimulationFailureCode = z.infer<typeof simulationFailureCodeSchema>;
export type SimulationRun = z.infer<typeof simulationRunSchema>;

export const RUNNER_PROTOCOL_VERSION = '1.0.0';
// An 8 MB source bundle expands to at most 10,666,668 base64 characters.
// The request also contains graph, catalog, validation, and signed bindings.
export const MAX_RUNNER_REQUEST_BYTES = 16_000_000;
export const MAX_RUNNER_CAPABILITY_TTL_MS = 120_000;
export const MAX_RUNNER_FIRMWARE_BASE64_CHARS = Math.ceil(MAX_FIRMWARE_ARTIFACT_BYTES / 3) * 4;
export const runnerExecutionProfileSchema = z
  .object({
    profileId: z.string().min(1).max(100),
    adapterId: z.string().min(1).max(100),
    adapterVersion: z.string().min(1).max(100),
    engineId: z.string().min(1).max(100),
    engineVersion: z.string().min(1).max(100),
    imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    // Optional for compatibility with existing single-file profiles. A bundle
    // is eligible only when this administrator-owned list includes its exact target.
    firmwareProjectTargets: z
      .array(
        z
          .object({
            buildSystem: firmwareProjectBuildSystemSchema,
            target: firmwareProjectTargetSchema,
          })
          .strict(),
      )
      .max(100)
      .optional(),
    limits: z
      .object({
        wallTimeoutMs: z.number().int().min(1_000).max(120_000),
        memoryBytes: z
          .number()
          .int()
          .min(64 * 1024 * 1024)
          .max(2 * 1024 ** 3),
        cpuCount: z.number().positive().max(2),
        pids: z.number().int().min(16).max(256),
        outputBytes: z.number().int().min(1024).max(MAX_SIMULATION_RESULT_BYTES),
        stdoutBytes: z.number().int().min(1024).max(1_000_000),
      })
      .strict(),
    firmwareLanguages: z.array(firmwareArtifactRefSchema.shape.language).min(1).max(4),
    boardPartIds: z.array(z.string().min(1).max(200)).min(1).max(100),
    componentPartIds: z.array(z.string().min(1).max(200)).max(1_000),
    // Values use the stable key `${topologyId}@${topologyVersion}`.
    topologyIds: z.array(z.string().min(1).max(220)).max(100),
  })
  .strict();

const runnerFirmwareSourceSchema = z
  .string()
  .min(4)
  .max(MAX_RUNNER_FIRMWARE_BASE64_CHARS)
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);

export const runnerExecutionPayloadSchema = z
  .object({
    runId: z.string().uuid(),
    attemptId: z.string().uuid(),
    binding: simulationBindingSchema,
    graph: circuitGraphSchema,
    catalog: catalogReleaseSchema,
    validation: validationReportSchema,
    validationReportId: z.string().uuid(),
    validationReportDigest: z.string().regex(/^[a-f0-9]{64}$/),
    firmware: firmwareArtifactRefSchema,
    firmwareReviewRevision: z.number().int().positive(),
    firmwareBase64: runnerFirmwareSourceSchema.optional(),
    firmwareProjectBundle: firmwareProjectBundleSchema.optional(),
    executionProfileId: z.string().min(1).max(100),
    deadlineAt: z.iso.datetime(),
  })
  .strict()
  .superRefine((payload, ctx) => {
    const hasSingleFile = payload.firmwareBase64 !== undefined;
    const hasBundle = payload.firmwareProjectBundle !== undefined;
    if (hasSingleFile === hasBundle)
      ctx.addIssue({
        code: 'custom',
        path: ['firmwareBase64'],
        message: 'Supply exactly one of firmwareBase64 or firmwareProjectBundle.',
      });
    const binding = payload.binding;
    if (
      payload.graph.id !== binding.graphId ||
      payload.graph.projectId !== binding.projectId ||
      payload.graph.projectRevision !== binding.projectRevision ||
      payload.graph.catalogReleaseId !== binding.catalogReleaseId ||
      canonicalDigest(payload.graph) !== binding.graphDigest
    )
      ctx.addIssue({
        code: 'custom',
        path: ['graph'],
        message: 'Graph does not match run binding.',
      });
    if (
      payload.catalog.releaseId !== binding.catalogReleaseId ||
      canonicalDigest(payload.catalog) !== binding.catalogDigest
    )
      ctx.addIssue({
        code: 'custom',
        path: ['catalog'],
        message: 'Catalog does not match run binding.',
      });
    if (!validateCircuitGraph(payload.graph, { release: payload.catalog }).valid)
      ctx.addIssue({
        code: 'custom',
        path: ['graph'],
        message: 'Graph is not structurally valid for the supplied catalog snapshot.',
      });
    if (
      payload.validation.projectId !== binding.projectId ||
      payload.validation.projectRevision !== binding.projectRevision ||
      payload.validation.graphId !== binding.graphId ||
      payload.validation.graphDigest !== binding.graphDigest ||
      payload.validation.catalogReleaseId !== binding.catalogReleaseId ||
      payload.validation.catalogDigest !== binding.catalogDigest ||
      canonicalDigest(payload.validation) !== payload.validationReportDigest ||
      payload.validation.status === 'fail' ||
      payload.validation.status === 'error'
    )
      ctx.addIssue({
        code: 'custom',
        path: ['validation'],
        message: 'A failed or errored validation report cannot be executed.',
      });
    if (
      payload.firmware.projectId !== binding.projectId ||
      payload.firmware.artifactId !== binding.firmwareArtifactId ||
      firmwareBindingDigest(payload.firmware) !== binding.firmwareDigest ||
      (binding.firmwareByteLength !== undefined &&
        binding.firmwareByteLength !==
          (payload.firmware.totalByteLength ?? payload.firmware.byteLength)) ||
      payload.firmware.catalogReleaseId !== binding.catalogReleaseId
    )
      ctx.addIssue({
        code: 'custom',
        path: ['firmware'],
        message: 'Firmware does not match run binding.',
      });
    if (hasSingleFile && payload.firmwareBase64 !== undefined) {
      const encodedLength = payload.firmwareBase64.length;
      const padding = payload.firmwareBase64.endsWith('==')
        ? 2
        : payload.firmwareBase64.endsWith('=')
          ? 1
          : 0;
      const decodedLength = (encodedLength / 4) * 3 - padding;
      if (
        decodedLength !== payload.firmware.byteLength ||
        payload.firmware.bundleDigest !== undefined
      )
        ctx.addIssue({
          code: 'custom',
          path: ['firmwareBase64'],
          message: 'Single-file firmware length or immutable reference is inconsistent.',
        });
    }
    if (hasBundle && payload.firmwareProjectBundle !== undefined) {
      const bundle = payload.firmwareProjectBundle;
      if (
        payload.firmware.bundleDigest !== bundle.manifestDigest ||
        payload.firmware.totalByteLength !== bundle.totalByteLength ||
        payload.firmware.buildSystem !== bundle.buildSystem ||
        payload.firmware.target === undefined ||
        canonicalDigest(payload.firmware.target) !== canonicalDigest(bundle.target) ||
        payload.firmware.entrypoint !== bundle.entrypoint ||
        payload.firmware.byteLength !==
          (bundle.files.find((file) => file.path === bundle.entrypoint)?.byteLength ?? -1)
      )
        ctx.addIssue({
          code: 'custom',
          path: ['firmwareProjectBundle'],
          message: 'Bundle manifest does not match its immutable firmware reference.',
        });
    }
  });

export const runnerCapabilitySchema = z
  .object({
    keyId: z.string().min(1).max(100),
    audience: z.literal('schemora-sandbox-runner'),
    runId: z.string().uuid(),
    attemptId: z.string().uuid(),
    jti: z.string().uuid(),
    payloadDigest: z.string().regex(/^[a-f0-9]{64}$/),
    notBefore: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    signature: z
      .string()
      .length(86)
      .regex(/^[A-Za-z0-9_-]{86}$/),
  })
  .strict();

export const runnerExecutionRequestSchema = z
  .object({
    protocolVersion: z.literal(RUNNER_PROTOCOL_VERSION),
    payload: runnerExecutionPayloadSchema,
    payloadDigest: z.string().regex(/^[a-f0-9]{64}$/),
    capability: runnerCapabilitySchema,
  })
  .strict()
  .superRefine((request, ctx) => {
    const digest = canonicalDigest(request.payload);
    if (request.payloadDigest !== digest || request.capability.payloadDigest !== digest)
      ctx.addIssue({
        code: 'custom',
        path: ['payloadDigest'],
        message: 'Execution payload digest is invalid.',
      });
    if (
      request.capability.runId !== request.payload.runId ||
      request.capability.attemptId !== request.payload.attemptId
    )
      ctx.addIssue({
        code: 'custom',
        path: ['capability'],
        message: 'Capability is bound to another execution.',
      });
    if (Date.parse(request.capability.expiresAt) > Date.parse(request.payload.deadlineAt))
      ctx.addIssue({
        code: 'custom',
        path: ['capability', 'expiresAt'],
        message: 'Capability cannot outlive the execution deadline.',
      });
    const notBefore = Date.parse(request.capability.notBefore);
    const expiresAt = Date.parse(request.capability.expiresAt);
    if (expiresAt <= notBefore || expiresAt - notBefore > MAX_RUNNER_CAPABILITY_TTL_MS)
      ctx.addIssue({
        code: 'custom',
        path: ['capability'],
        message: 'Capability validity window is expired, premature, or too long.',
      });
    if (new TextEncoder().encode(JSON.stringify(request)).byteLength > MAX_RUNNER_REQUEST_BYTES)
      ctx.addIssue({ code: 'custom', path: [], message: 'Runner request exceeds the byte limit.' });
  });

export const runnerCleanupReceiptSchema = z
  .object({
    operationId: z.string().uuid(),
    completedAt: z.iso.datetime(),
    executionStopped: z.literal(true),
    runtimeObjectAbsent: z.literal(true),
    workspaceRemoved: z.literal(true),
  })
  .strict();

export const runnerOutputManifestEntrySchema = z
  .object({
    path: z
      .string()
      .min(1)
      .max(240)
      .refine(
        (path) =>
          !path.startsWith('/') &&
          !path.includes('\\') &&
          path.split('/').length <= 8 &&
          path
            .split('/')
            .every(
              (part) =>
                part.length > 0 &&
                part !== '.' &&
                part !== '..' &&
                part !== '__proto__' &&
                part !== 'constructor' &&
                part !== 'prototype',
            ),
      ),
    byteLength: z.number().int().nonnegative().max(MAX_SIMULATION_RESULT_BYTES),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export const runnerExecutionResponseSchema = z
  .object({
    protocolVersion: z.literal(RUNNER_PROTOCOL_VERSION),
    runId: z.string().uuid(),
    attemptId: z.string().uuid(),
    payloadDigest: z.string().regex(/^[a-f0-9]{64}$/),
    executionProfileId: z.string().min(1).max(100),
    imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    status: z.enum(['accepted', 'running', 'completed', 'failed', 'cancelled']),
    startedAt: z.iso.datetime().nullable(),
    finishedAt: z.iso.datetime().nullable(),
    terminationReason: z
      .enum(['completed', 'failed', 'time_limit', 'cancelled', 'runtime_error'])
      .nullable(),
    run: simulationRunSchema.nullable(),
    outputManifest: z.array(runnerOutputManifestEntrySchema).max(256),
    totalOutputBytes: z.number().int().nonnegative().max(MAX_SIMULATION_RESULT_BYTES),
    cleanupReceipt: runnerCleanupReceiptSchema.nullable(),
  })
  .strict()
  .superRefine((response, ctx) => {
    const terminal = ['completed', 'failed', 'cancelled'].includes(response.status);
    if (terminal !== (response.cleanupReceipt !== null))
      ctx.addIssue({
        code: 'custom',
        path: ['cleanupReceipt'],
        message: 'Terminal responses require a cleanup receipt.',
      });
    if (
      terminal !== (response.finishedAt !== null) ||
      terminal !== (response.terminationReason !== null)
    )
      ctx.addIssue({
        code: 'custom',
        path: ['finishedAt'],
        message: 'Terminal status, finish time, and termination reason must agree.',
      });
    if (response.status === 'running' && response.startedAt === null)
      ctx.addIssue({
        code: 'custom',
        path: ['startedAt'],
        message: 'Running response requires a start time.',
      });
    const expectedRunStatus =
      response.status === 'completed'
        ? ['completed']
        : response.status === 'failed'
          ? ['failed', 'timed_out']
          : response.status === 'cancelled'
            ? ['cancelled']
            : [];
    if (terminal && (!response.run || !expectedRunStatus?.includes(response.run.status)))
      ctx.addIssue({
        code: 'custom',
        path: ['run'],
        message: 'Terminal response status must match its terminal run result.',
      });
    if (!terminal && response.run !== null)
      ctx.addIssue({
        code: 'custom',
        path: ['run'],
        message: 'Non-terminal runner responses cannot include a final run result.',
      });
    if (response.status === 'completed' && response.terminationReason !== 'completed')
      ctx.addIssue({
        code: 'custom',
        path: ['terminationReason'],
        message: 'Completed response requires normal termination.',
      });
    if (
      response.status === 'failed' &&
      !['failed', 'time_limit', 'runtime_error'].includes(response.terminationReason ?? '')
    )
      ctx.addIssue({
        code: 'custom',
        path: ['terminationReason'],
        message: 'Failed response requires a failure termination reason.',
      });
    if (response.status === 'cancelled' && response.terminationReason !== 'cancelled')
      ctx.addIssue({
        code: 'custom',
        path: ['terminationReason'],
        message: 'Cancelled response requires cancellation termination.',
      });
    const paths = new Set<string>();
    let manifestBytes = 0;
    for (const [index, entry] of response.outputManifest.entries()) {
      if (paths.has(entry.path))
        ctx.addIssue({
          code: 'custom',
          path: ['outputManifest', index, 'path'],
          message: 'Output paths must be unique.',
        });
      paths.add(entry.path);
      manifestBytes += entry.byteLength;
    }
    if (manifestBytes !== response.totalOutputBytes)
      ctx.addIssue({
        code: 'custom',
        path: ['totalOutputBytes'],
        message: 'Manifest sizes do not match total output bytes.',
      });
    if (response.run && response.run.runId !== response.runId)
      ctx.addIssue({
        code: 'custom',
        path: ['run', 'runId'],
        message: 'Result run ID does not match response.',
      });
    if (new TextEncoder().encode(JSON.stringify(response)).byteLength > MAX_SIMULATION_RESULT_BYTES)
      ctx.addIssue({
        code: 'custom',
        path: [],
        message: 'Runner response exceeds the byte limit.',
      });
  });

export type RunnerExecutionPayload = z.infer<typeof runnerExecutionPayloadSchema>;
export type RunnerExecutionRequest = z.infer<typeof runnerExecutionRequestSchema>;
export type RunnerExecutionResponse = z.infer<typeof runnerExecutionResponseSchema>;
export type RunnerExecutionProfile = z.infer<typeof runnerExecutionProfileSchema>;
export type RunnerCapability = RunnerExecutionRequest['capability'];

/** Fence a signed runner response against the locked run status before persisting it. */
export function runnerResponseTransitionAllowed(
  currentStatus: SimulationRun['status'],
  responseStatus: RunnerExecutionResponse['status'],
): boolean {
  if (!['queued', 'preparing', 'running', 'stopping'].includes(currentStatus)) return false;
  if (responseStatus === 'accepted') return ['queued', 'preparing'].includes(currentStatus);
  if (responseStatus === 'running')
    return ['queued', 'preparing', 'running'].includes(currentStatus);
  if (responseStatus === 'completed') return currentStatus === 'running';
  return ['completed', 'failed', 'cancelled'].includes(responseStatus);
}

export const RUNNER_RESPONSE_AUTH_VERSION = '1.0.0' as const;
export const runnerAuthenticatedResponseSchema = z
  .object({
    protocolVersion: z.literal(RUNNER_RESPONSE_AUTH_VERSION),
    keyId: z.string().min(1).max(100),
    requestJti: z.string().uuid(),
    responseJti: z.string().uuid(),
    issuedAt: z.iso.datetime(),
    responseDigest: z.string().regex(/^[a-f0-9]{64}$/),
    response: runnerExecutionResponseSchema,
    signature: z
      .string()
      .length(86)
      .regex(/^[A-Za-z0-9_-]{86}$/),
  })
  .strict();
export type RunnerAuthenticatedResponse = z.infer<typeof runnerAuthenticatedResponseSchema>;

export function runnerResponseDigest(response: RunnerExecutionResponse): string {
  return canonicalDigest(response);
}

export function runnerSimulationBindingDigest(binding: SimulationBinding): string {
  return canonicalDigest(binding);
}

/** Fixed-order, domain-separated UTF-8 message for signing an exact response digest. */
export function runnerResponseSigningMessage(
  response: Omit<RunnerAuthenticatedResponse, 'signature'>,
): string {
  return JSON.stringify({
    domain: 'schemora.runner.response.v1',
    protocolVersion: response.protocolVersion,
    keyId: response.keyId,
    requestJti: response.requestJti,
    responseJti: response.responseJti,
    issuedAt: response.issuedAt,
    responseDigest: response.responseDigest,
  });
}

export function validateRunnerExecutionResponseForRequest(
  responseInput: unknown,
  requestInput: unknown,
  profileInput: unknown,
): { valid: true; response: RunnerExecutionResponse } | { valid: false; issues: string[] } {
  const response = runnerExecutionResponseSchema.safeParse(responseInput);
  const request = runnerExecutionRequestSchema.safeParse(requestInput);
  const profile = runnerExecutionProfileSchema.safeParse(profileInput);
  if (!response.success || !request.success || !profile.success)
    return {
      valid: false,
      issues: ['Runner response or request failed protocol schema validation.'],
    };
  const value = response.data;
  const dispatched = request.data;
  const issues: string[] = [];
  if (
    value.runId !== dispatched.payload.runId ||
    value.attemptId !== dispatched.payload.attemptId ||
    value.payloadDigest !== dispatched.payloadDigest ||
    value.executionProfileId !== dispatched.payload.executionProfileId
  )
    issues.push('Runner response does not match the dispatched run, attempt, digest, or profile.');
  if (
    !runnerRequestMatchesProfile(dispatched, profile.data) ||
    value.imageDigest !== profile.data.imageDigest
  )
    issues.push('Runner response image or execution profile is not administrator-approved.');
  if (
    value.run &&
    canonicalDigest(value.run.binding) !== canonicalDigest(dispatched.payload.binding)
  )
    issues.push('Runner result binding differs from the dispatched immutable binding.');
  if (
    value.cleanupReceipt &&
    value.finishedAt &&
    Date.parse(value.cleanupReceipt.completedAt) < Date.parse(value.finishedAt)
  )
    issues.push('Cleanup receipt predates execution completion.');
  if (
    value.startedAt &&
    value.finishedAt &&
    Date.parse(value.startedAt) > Date.parse(value.finishedAt)
  )
    issues.push('Runner execution finished before it started.');
  return issues.length ? { valid: false, issues } : { valid: true, response: value };
}

/** Canonical signed bytes. Sign these UTF-8 bytes with Ed25519; verify keyId and replay state separately. */
export function runnerCapabilitySigningMessage(capability: RunnerCapability): string {
  return JSON.stringify({
    protocolVersion: RUNNER_PROTOCOL_VERSION,
    audience: capability.audience,
    runId: capability.runId,
    attemptId: capability.attemptId,
    payloadDigest: capability.payloadDigest,
    jti: capability.jti,
    notBefore: capability.notBefore,
    expiresAt: capability.expiresAt,
    keyId: capability.keyId,
  });
}

/** Apply the runner's administrator-owned profile allowlist to a structurally valid request. */
export function runnerPayloadMatchesProfile(
  input: unknown,
  profileInput: unknown,
): input is RunnerExecutionPayload {
  const payload = runnerExecutionPayloadSchema.safeParse(input);
  const profile = runnerExecutionProfileSchema.safeParse(profileInput);
  if (!payload.success || !profile.success) return false;
  const value = payload.data;
  const allowed = profile.data;
  const boards = new Set(allowed.boardPartIds);
  const parts = new Set(allowed.componentPartIds);
  const topologies = new Set(allowed.topologyIds);
  const catalogParts = new Map(value.catalog.parts.map((part) => [part.id, part]));
  const boardComponents = value.graph.components.filter(
    (component) => catalogParts.get(component.catalogPartId)?.category === 'development-board',
  );
  return (
    value.executionProfileId === allowed.profileId &&
    value.binding.adapterId === allowed.adapterId &&
    value.binding.adapterVersion === allowed.adapterVersion &&
    value.binding.engineId === allowed.engineId &&
    value.binding.engineVersion === allowed.engineVersion &&
    allowed.firmwareLanguages.includes(value.firmware.language) &&
    (value.firmwareProjectBundle === undefined ||
      allowed.firmwareProjectTargets?.some(
        (approved) =>
          approved.buildSystem === value.firmwareProjectBundle!.buildSystem &&
          canonicalDigest(approved.target) === canonicalDigest(value.firmwareProjectBundle!.target),
      ) === true) &&
    boards.has(value.firmware.boardPartId) &&
    boardComponents.length === 1 &&
    boardComponents[0]?.catalogPartId === value.firmware.boardPartId &&
    value.graph.components.every((component) => {
      const part = catalogParts.get(component.catalogPartId);
      if (!part) return false;
      return part.category === 'development-board' ? boards.has(part.id) : parts.has(part.id);
    }) &&
    value.graph.breadboards.every((breadboard) =>
      topologies.has(`${breadboard.topologyId}@${breadboard.topologyVersion}`),
    )
  );
}

/** Validate request timing against the runner's configured hard wall-time limit. */
export function runnerRequestMatchesProfile(input: unknown, profileInput: unknown): boolean {
  const request = runnerExecutionRequestSchema.safeParse(input);
  const profile = runnerExecutionProfileSchema.safeParse(profileInput);
  if (
    !request.success ||
    !profile.success ||
    !runnerPayloadMatchesProfile(request.data.payload, profile.data)
  )
    return false;
  const allowedWindow = profile.data.limits.wallTimeoutMs + 15_000;
  return (
    Date.parse(request.data.payload.deadlineAt) - Date.parse(request.data.capability.notBefore) <=
    allowedWindow
  );
}

/** Verify source bytes at the runner trust boundary; schema shape checks alone are insufficient. */
export async function verifyRunnerFirmwareDigest(input: unknown): Promise<boolean> {
  const parsed = runnerExecutionPayloadSchema.safeParse(input);
  if (!parsed.success) return false;
  try {
    if (parsed.data.firmwareProjectBundle !== undefined) {
      const bundle = parsed.data.firmwareProjectBundle;
      return (
        (await verifyFirmwareProjectBundleSources(bundle)) &&
        bundle.manifestDigest === parsed.data.firmware.bundleDigest &&
        bundle.totalByteLength === parsed.data.firmware.totalByteLength &&
        bundle.buildSystem === parsed.data.firmware.buildSystem &&
        parsed.data.firmware.target !== undefined &&
        canonicalDigest(bundle.target) === canonicalDigest(parsed.data.firmware.target) &&
        bundle.entrypoint === parsed.data.firmware.entrypoint &&
        parsed.data.binding.firmwareDigest === bundle.manifestDigest &&
        parsed.data.binding.firmwareByteLength === bundle.totalByteLength
      );
    }
    if (parsed.data.firmwareBase64 === undefined) return false;
    const encoded = parsed.data.firmwareBase64;
    const binary = atob(encoded);
    if (btoa(binary) !== encoded) return false;
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    const actual = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('');
    return (
      actual === parsed.data.firmware.sha256 &&
      parsed.data.firmware.bundleDigest === undefined &&
      actual === parsed.data.binding.firmwareDigest
    );
  } catch {
    return false;
  }
}

export type SimulationCapability = {
  providerId: string;
  providerVersion: string;
  engineId: string;
  engineVersion: string;
  boardPartIds: string[];
  componentPartIds: string[];
  topologies: { topologyId: string; topologyVersion: number }[];
  firmwareLanguages: FirmwareArtifactRef['language'][];
};

export const simulationCapabilitySchema = z
  .object({
    providerId: z.string().min(1),
    providerVersion: z.string().min(1),
    engineId: z.string().min(1),
    engineVersion: z.string().min(1),
    boardPartIds: z.array(z.string().min(1)).max(100),
    componentPartIds: z.array(z.string().min(1)).max(1_000),
    topologies: z
      .array(
        z
          .object({ topologyId: z.string().min(1), topologyVersion: z.number().int().positive() })
          .strict(),
      )
      .max(100),
    firmwareLanguages: z.array(firmwareArtifactRefSchema.shape.language).max(10),
  })
  .strict()
  .superRefine((capability, ctx) => {
    for (const key of ['boardPartIds', 'componentPartIds', 'firmwareLanguages'] as const) {
      if (new Set(capability[key]).size !== capability[key].length)
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: 'Capability entries must be unique.',
        });
    }
    const topologyKeys = capability.topologies.map(
      (topology) => `${topology.topologyId}\u0000${topology.topologyVersion}`,
    );
    if (new Set(topologyKeys).size !== topologyKeys.length)
      ctx.addIssue({
        code: 'custom',
        path: ['topologies'],
        message: 'Topology identity/version pairs must be unique.',
      });
  });

export type SimulationEligibility =
  | {
      eligible: true;
      binding: SimulationBinding;
    }
  | { eligible: false; code: SimulationFailureCode; reasons: string[] };

/**
 * Fail-closed boundary used before a provider adapter may receive a simulation job.
 * It never interprets unsupported inputs as simulated behavior.
 */
export function assessSimulationEligibility(input: {
  graph: unknown;
  catalog: unknown;
  report: unknown;
  firmware: unknown;
  reportIsCurrent: boolean;
  capability: unknown | null;
}): SimulationEligibility {
  const graphResult = circuitGraphSchema.safeParse(input.graph);
  const catalogResult = catalogReleaseSchema.safeParse(input.catalog);
  const reportResult = validationReportSchema.safeParse(input.report);
  const firmwareResult = firmwareArtifactRefSchema.safeParse(input.firmware);
  const capabilityResult = input.capability
    ? simulationCapabilitySchema.safeParse(input.capability)
    : null;
  if (
    !graphResult.success ||
    !catalogResult.success ||
    !reportResult.success ||
    !firmwareResult.success
  )
    return {
      eligible: false,
      code: 'STALE_INPUT',
      reasons: ['Simulation inputs failed schema validation.'],
    };

  const graph: CircuitGraph = graphResult.data;
  const catalog: CatalogRelease = catalogResult.data;
  const report: ValidationReport = reportResult.data;
  const firmware: FirmwareArtifactRef = firmwareResult.data;
  const capability: SimulationCapability | null = capabilityResult?.success
    ? capabilityResult.data
    : null;
  const graphDigest = canonicalDigest(graph);
  const catalogDigest = canonicalDigest(catalog);
  const reasons: string[] = [];
  let failureCode: SimulationFailureCode | null = null;
  if (
    !input.reportIsCurrent ||
    report.projectId !== graph.projectId ||
    report.projectRevision !== graph.projectRevision ||
    report.graphId !== graph.id ||
    report.graphDigest !== graphDigest ||
    report.catalogReleaseId !== graph.catalogReleaseId ||
    report.catalogDigest !== catalogDigest ||
    catalog.releaseId !== graph.catalogReleaseId
  )
    reasons.push(
      'The validation report, graph, and catalog do not describe the same current inputs.',
    );
  if (!validateCircuitGraph(graph, { release: catalog }).valid)
    reasons.push('The circuit graph does not resolve against the pinned catalog release.');
  const recomputedReport = validateCircuit({ graph, catalog });
  if (canonicalDigest(report) !== canonicalDigest(recomputedReport))
    reasons.push('The validation report does not match a fresh validation of the supplied graph.');
  if (
    report.status === 'fail' ||
    report.status === 'error' ||
    report.findings.some((finding) => finding.status === 'fail' || finding.status === 'error')
  )
    reasons.push('A current report with no failed or errored rule is required to run firmware.');
  const firmwareBoard = catalog.parts.find((part) => part.id === firmware.boardPartId);
  if (
    firmware.projectId !== graph.projectId ||
    firmware.catalogReleaseId !== catalog.releaseId ||
    firmwareBoard?.category !== 'development-board' ||
    !graph.components.some((component) => component.catalogPartId === firmware.boardPartId)
  )
    reasons.push('The accepted firmware artifact is not bound to this project and board.');
  const projectBoards = graph.components.filter((component) =>
    catalog.parts.some(
      (part) => part.id === component.catalogPartId && part.category === 'development-board',
    ),
  );
  if (projectBoards.length !== 1 || projectBoards[0]?.catalogPartId !== firmware.boardPartId)
    reasons.push('The simulation requires exactly one board matching the firmware target.');
  if (input.capability != null && !capabilityResult?.success)
    reasons.push('The simulator capability declaration failed schema validation.');
  if (input.capability == null)
    reasons.push('No approved simulator provider is configured for this deployment.');
  else if (capability) {
    const boards = graph.components.filter((component) =>
      catalog.parts.some(
        (part) => part.id === component.catalogPartId && part.category === 'development-board',
      ),
    );
    const unsupportedBoard = boards.some(
      (board) => !capability.boardPartIds.includes(board.catalogPartId),
    );
    const unsupportedPart = graph.components.some(
      (component) =>
        !capability.componentPartIds.includes(component.catalogPartId) &&
        !boards.some((board) => board.id === component.id),
    );
    const unsupportedTopology = graph.breadboards.some(
      (board) =>
        !capability.topologies.some(
          (topology) =>
            topology.topologyId === board.topologyId &&
            topology.topologyVersion === board.topologyVersion,
        ),
    );
    if (unsupportedBoard) {
      failureCode ??= 'UNSUPPORTED_BOARD';
      reasons.push('The exact development-board catalog identity is not supported.');
    }
    if (unsupportedPart) {
      failureCode ??= 'UNSUPPORTED_COMPONENT';
      reasons.push('One or more exact component catalog identities are not supported.');
    }
    if (unsupportedTopology) {
      failureCode ??= 'UNSUPPORTED_TOPOLOGY';
      reasons.push('One or more breadboard topologies are not supported.');
    }
    if (!capability.firmwareLanguages.includes(firmware.language)) {
      failureCode ??= 'UNSUPPORTED_FIRMWARE';
      reasons.push('The firmware language is not supported by this provider.');
    }
    const knownBoardIds = new Set(
      catalog.parts.filter((part) => part.category === 'development-board').map((part) => part.id),
    );
    const knownComponentIds = new Set(
      catalog.parts.filter((part) => part.category !== 'development-board').map((part) => part.id),
    );
    const knownTopologies = new Set(
      catalog.breadboardTopologies.map((topology) => `${topology.id}\u0000${topology.version}`),
    );
    if (
      capability.boardPartIds.some((id) => !knownBoardIds.has(id)) ||
      capability.componentPartIds.some((id) => !knownComponentIds.has(id)) ||
      capability.topologies.some(
        (topology) =>
          !knownTopologies.has(`${topology.topologyId}\u0000${topology.topologyVersion}`),
      )
    )
      reasons.push('The provider capability claims identities absent from this catalog release.');
  }
  if (reasons.length) {
    const code: SimulationFailureCode = reasons.some((reason) =>
      /current inputs|pinned catalog|fresh validation/.test(reason),
    )
      ? 'STALE_INPUT'
      : reasons.some((reason) => reason.includes('failed or errored rule'))
        ? 'VALIDATION_NOT_PASSED'
        : !capability || reasons.some((reason) => reason.includes('capability declaration'))
          ? 'SIMULATOR_UNAVAILABLE'
          : (failureCode ?? 'SIMULATOR_UNAVAILABLE');
    return { eligible: false, code, reasons };
  }
  return {
    eligible: true,
    binding: {
      projectId: graph.projectId,
      projectRevision: graph.projectRevision,
      graphId: graph.id,
      graphDigest,
      catalogReleaseId: catalog.releaseId,
      catalogDigest,
      firmwareArtifactId: firmware.artifactId,
      firmwareDigest: firmwareBindingDigest(firmware),
      firmwareByteLength: firmware.totalByteLength ?? firmware.byteLength,
      adapterId: capability!.providerId,
      adapterVersion: capability!.providerVersion,
      engineId: capability!.engineId,
      engineVersion: capability!.engineVersion,
    },
  };
}

/** Verify provider events against the immutable graph and exact catalog snapshot. */
export function validateSimulationRunAgainstDesign(input: {
  run: unknown;
  graph: unknown;
  catalog: unknown;
  firmware: unknown;
  expectedBinding: unknown;
}): { valid: true; run: SimulationRun } | { valid: false; issues: string[] } {
  const runResult = simulationRunSchema.safeParse(input.run);
  const graphResult = circuitGraphSchema.safeParse(input.graph);
  const catalogResult = catalogReleaseSchema.safeParse(input.catalog);
  const firmwareResult = firmwareArtifactRefSchema.safeParse(input.firmware);
  const expectedBindingResult = simulationBindingSchema.safeParse(input.expectedBinding);
  if (
    !runResult.success ||
    !graphResult.success ||
    !catalogResult.success ||
    !firmwareResult.success ||
    !expectedBindingResult.success
  )
    return {
      valid: false,
      issues: ['Run, design, firmware, or expected binding failed schema validation.'],
    };
  const run = runResult.data;
  const graph = graphResult.data;
  const catalog = catalogResult.data;
  const firmware = firmwareResult.data;
  const expectedBinding = expectedBindingResult.data;
  const issues: string[] = [];
  if (
    run.binding.projectId !== graph.projectId ||
    run.binding.projectRevision !== graph.projectRevision ||
    run.binding.graphId !== graph.id ||
    run.binding.graphDigest !== canonicalDigest(graph) ||
    run.binding.catalogReleaseId !== catalog.releaseId ||
    run.binding.catalogReleaseId !== graph.catalogReleaseId ||
    run.binding.catalogDigest !== canonicalDigest(catalog)
  )
    issues.push('Run binding does not match the supplied immutable design snapshot.');
  if (canonicalDigest(run.binding) !== canonicalDigest(expectedBinding))
    issues.push(
      'Run binding differs from the provider and firmware binding approved for this run.',
    );
  if (
    run.binding.firmwareArtifactId !== firmware.artifactId ||
    run.binding.firmwareDigest !== firmwareBindingDigest(firmware) ||
    (firmware.totalByteLength !== undefined &&
      run.binding.firmwareByteLength !== firmware.totalByteLength) ||
    firmware.projectId !== graph.projectId ||
    firmware.catalogReleaseId !== catalog.releaseId ||
    !graph.components.some((component) => component.catalogPartId === firmware.boardPartId)
  )
    issues.push('Run firmware reference does not match the accepted artifact for this design.');
  const instances = new Map(graph.components.map((component) => [component.id, component]));
  const parts = new Map(catalog.parts.map((part) => [part.id, part]));
  for (const event of run.events) {
    if (event.kind === 'serial') continue;
    const component = instances.get(event.componentInstanceId);
    const part = component ? parts.get(component.catalogPartId) : null;
    if (!part) {
      issues.push(`Output references unknown component instance ${event.componentInstanceId}.`);
      continue;
    }
    if (event.kind === 'led_state' && part.category !== 'led')
      issues.push(`LED state targets non-LED component instance ${event.componentInstanceId}.`);
    if (event.kind === 'sensor_reading')
      issues.push(
        `Sensor output is not supported for catalog component ${event.componentInstanceId}.`,
      );
  }
  return issues.length ? { valid: false, issues } : { valid: true, run };
}

export type SimulationAdapter = {
  readonly capability: SimulationCapability;
  prepare(input: {
    binding: SimulationBinding;
    firmwareArtifactId: string;
  }): Promise<SimulationRun>;
  start(runId: string): Promise<SimulationRun>;
  stop(runId: string): Promise<SimulationRun>;
  reset(runId: string): Promise<SimulationRun>;
  read(runId: string, afterSequence?: number): Promise<SimulationRun>;
};

/** Deliberately available as a safe default until a provider has passed approval gates. */
export function unavailableSimulationRun(input: {
  runId: string;
  binding: SimulationBinding;
  reason?: string;
}): SimulationRun {
  return simulationRunSchema.parse({
    schemaVersion: 1,
    contractVersion: SIMULATION_CONTRACT_VERSION,
    runId: input.runId,
    status: 'unsupported',
    binding: input.binding,
    events: [],
    unsupportedFeatures: ['No approved simulation provider is configured.'],
    limitations: [
      'No firmware was compiled or executed; no simulated component state is available.',
    ],
    failure: {
      code: 'SIMULATOR_UNAVAILABLE',
      message:
        input.reason ??
        'Simulation is unavailable until provider compatibility and usage rights are established.',
    },
    simulatedDurationMs: null,
  });
}
