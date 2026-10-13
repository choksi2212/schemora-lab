import { canonicalDigest } from '@schemora/assembly-plan';
import { catalogReleaseSchema, type CatalogRelease } from '@schemora/catalog';
import { circuitGraphSchema, type CircuitGraph } from '@schemora/circuit-model';
import { validationReportSchema, type ValidationReport } from '@schemora/validation';
import { z } from 'zod';

export const SIMULATION_CONTRACT_VERSION = '1.0.0';

export const firmwareArtifactRefSchema = z
  .object({
    schemaVersion: z.literal(1),
    artifactId: z.string().min(1).max(200),
    projectId: z.string().min(1).max(200),
    projectRevision: z.number().int().positive(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    byteLength: z.number().int().positive().max(2_000_000),
    language: z.enum(['c', 'cpp', 'arduino-cpp', 'esp-idf-c']),
    entrypoint: z.string().min(1).max(200),
    boardPartId: z.string().min(1).max(200),
    reviewStatus: z.literal('accepted'),
  })
  .strict();

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
      text: z.string().max(4_096),
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
    events: z.array(simulationEventSchema).max(20_000),
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
  });

export type FirmwareArtifactRef = z.infer<typeof firmwareArtifactRefSchema>;
export type SimulationBinding = z.infer<typeof simulationBindingSchema>;
export type SimulationEvent = z.infer<typeof simulationEventSchema>;
export type SimulationFailureCode = z.infer<typeof simulationFailureCodeSchema>;
export type SimulationRun = z.infer<typeof simulationRunSchema>;

export type SimulationCapability = {
  providerId: string;
  providerVersion: string;
  engineId: string;
  engineVersion: string;
  boardPartIds: string[];
  componentPartIds: string[];
  topologyIds: string[];
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
    topologyIds: z.array(z.string().min(1)).max(100),
    firmwareLanguages: z.array(firmwareArtifactRefSchema.shape.language).max(10),
  })
  .strict();

export type SimulationEligibility =
  | {
      eligible: true;
      binding: Omit<
        SimulationBinding,
        'adapterId' | 'adapterVersion' | 'engineId' | 'engineVersion'
      >;
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
  capability: SimulationCapability | null;
}): SimulationEligibility {
  const graphResult = circuitGraphSchema.safeParse(input.graph);
  const catalogResult = catalogReleaseSchema.safeParse(input.catalog);
  const reportResult = validationReportSchema.safeParse(input.report);
  const firmwareResult = firmwareArtifactRefSchema.safeParse(input.firmware);
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
  const graphDigest = canonicalDigest(graph);
  const catalogDigest = canonicalDigest(catalog);
  const reasons: string[] = [];
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
  if (
    report.status === 'fail' ||
    report.status === 'error' ||
    report.findings.some((finding) => finding.status === 'fail' || finding.status === 'error')
  )
    reasons.push('A current report with no failed or errored rule is required to run firmware.');
  const firmwareBoard = catalog.parts.find((part) => part.id === firmware.boardPartId);
  if (
    firmware.projectId !== graph.projectId ||
    firmware.projectRevision !== graph.projectRevision ||
    firmwareBoard?.category !== 'development-board' ||
    !graph.components.some((component) => component.catalogPartId === firmware.boardPartId)
  )
    reasons.push('The accepted firmware artifact is not bound to this project revision and board.');
  if (!input.capability)
    reasons.push('No approved simulator provider is configured for this deployment.');
  else {
    const boards = graph.components.filter((component) =>
      catalog.parts.some(
        (part) => part.id === component.catalogPartId && part.category === 'development-board',
      ),
    );
    const unsupportedBoard = boards.some(
      (board) => !input.capability!.boardPartIds.includes(board.catalogPartId),
    );
    const unsupportedPart = graph.components.some(
      (component) =>
        !input.capability!.componentPartIds.includes(component.catalogPartId) &&
        !boards.some((board) => board.id === component.id),
    );
    const unsupportedTopology = graph.breadboards.some(
      (board) => !input.capability!.topologyIds.includes(board.topologyId),
    );
    if (unsupportedBoard)
      reasons.push('The exact development-board catalog identity is not supported.');
    if (unsupportedPart)
      reasons.push('One or more exact component catalog identities are not supported.');
    if (unsupportedTopology) reasons.push('One or more breadboard topologies are not supported.');
    if (!input.capability.firmwareLanguages.includes(firmware.language))
      reasons.push('The firmware language is not supported by this provider.');
  }
  if (reasons.length) {
    const code: SimulationFailureCode = !input.capability
      ? 'SIMULATOR_UNAVAILABLE'
      : reasons.some((reason) => reason.includes('failed or errored rule'))
        ? 'VALIDATION_NOT_PASSED'
        : reasons.some((reason) => reason.includes('not supported'))
          ? 'UNSUPPORTED_COMPONENT'
          : 'STALE_INPUT';
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
      firmwareDigest: firmware.sha256,
    },
  };
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
