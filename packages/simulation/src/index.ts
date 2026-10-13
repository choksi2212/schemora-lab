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

export const SIMULATION_CONTRACT_VERSION = '1.0.0';
export const MAX_SIMULATION_RESULT_BYTES = 2_000_000;
export const MAX_SIMULATION_EVENTS = 5_000;

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
    firmware.projectRevision !== graph.projectRevision ||
    firmwareBoard?.category !== 'development-board' ||
    !graph.components.some((component) => component.catalogPartId === firmware.boardPartId)
  )
    reasons.push('The accepted firmware artifact is not bound to this project revision and board.');
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
      firmwareDigest: firmware.sha256,
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
    run.binding.firmwareDigest !== firmware.sha256 ||
    firmware.projectId !== graph.projectId ||
    firmware.projectRevision !== graph.projectRevision ||
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
