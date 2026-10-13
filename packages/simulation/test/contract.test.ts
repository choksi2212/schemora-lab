import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { canonicalDigest } from '@schemora/assembly-plan';
import { getCatalogRelease } from '@schemora/catalog';
import { validateCircuit } from '@schemora/validation';
import {
  assessSimulationEligibility,
  firmwareArtifactRefSchema,
  mapEsp32Gpio19ToLedState,
  normalizeQemuReferenceCallbacks,
  RUNNER_PROTOCOL_VERSION,
  runnerExecutionRequestSchema,
  runnerExecutionResponseSchema,
  runnerExecutionPayloadSchema,
  runnerExecutionProfileSchema,
  runnerPayloadMatchesProfile,
  runnerRequestMatchesProfile,
  runnerResponseTransitionAllowed,
  verifyRunnerFirmwareDigest,
  validateRunnerExecutionResponseForRequest,
  simulationRunSchema,
  unavailableSimulationRun,
  validateSimulationRunAgainstDesign,
} from '../src/index.js';

const catalog = getCatalogRelease();
const graph = {
  schemaVersion: 1 as const,
  id: 'simulation_graph_1',
  projectId: 'simulation_project_1',
  projectRevision: 3,
  catalogReleaseId: catalog.releaseId,
  components: [
    { id: 'board_1', catalogPartId: 'board.espressif.esp32-devkitc-v4.wroom-32e.male' },
    { id: 'resistor_1', catalogPartId: 'resistor.yageo.cfr-25jb-52-220r' },
    { id: 'led_1', catalogPartId: 'led.kingbright.wp7113id' },
  ],
  breadboards: [],
  terminalPlacements: [],
  wires: [
    {
      id: 'wire_gpio_resistor',
      source: {
        kind: 'terminal' as const,
        terminal: { componentInstanceId: 'board_1', catalogTerminalId: 'gpio19' },
      },
      target: {
        kind: 'terminal' as const,
        terminal: { componentInstanceId: 'resistor_1', catalogTerminalId: 'lead-a' },
      },
    },
    {
      id: 'wire_resistor_led',
      source: {
        kind: 'terminal' as const,
        terminal: { componentInstanceId: 'resistor_1', catalogTerminalId: 'lead-b' },
      },
      target: {
        kind: 'terminal' as const,
        terminal: { componentInstanceId: 'led_1', catalogTerminalId: 'anode' },
      },
    },
    {
      id: 'wire_led_ground',
      source: {
        kind: 'terminal' as const,
        terminal: { componentInstanceId: 'led_1', catalogTerminalId: 'cathode' },
      },
      target: {
        kind: 'terminal' as const,
        terminal: { componentInstanceId: 'board_1', catalogTerminalId: 'gnd-j3-1' },
      },
    },
  ],
};
const report = validateCircuit({ graph, catalog });
const capturedGpio19Trace = readFileSync(
  new URL('../../../examples/phase6-qemu-gpio-probe/expected-gpio19.jsonl', import.meta.url),
  'utf8',
)
  .trim()
  .split('\n')
  .map(
    (line) => JSON.parse(line) as { sequence: number; type: string; gpio: number; level: 0 | 1 },
  );
const capturedQemuCallbackTrace = readFileSync(
  new URL('../../../examples/phase6-qemu-gpio-probe/expected-events.jsonl', import.meta.url),
  'utf8',
)
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line) as Record<string, unknown>);
const firmware = firmwareArtifactRefSchema.parse({
  schemaVersion: 1,
  artifactId: 'firmware_v1',
  projectId: graph.projectId,
  projectRevision: graph.projectRevision,
  sha256: 'a'.repeat(64),
  byteLength: 128,
  language: 'arduino-cpp',
  entrypoint: 'src/main.cpp',
  boardPartId: graph.components[0]!.catalogPartId,
  catalogReleaseId: catalog.releaseId,
  reviewStatus: 'accepted',
});
const capability = {
  providerId: 'test-provider',
  providerVersion: '1.0.0',
  engineId: 'test-engine',
  engineVersion: '1.0.0',
  boardPartIds: [graph.components[0]!.catalogPartId],
  componentPartIds: graph.components.slice(1).map((component) => component.catalogPartId),
  topologies: [],
  firmwareLanguages: ['arduino-cpp' as const],
};
const binding = {
  projectId: graph.projectId,
  projectRevision: graph.projectRevision,
  graphId: graph.id,
  graphDigest: canonicalDigest(graph),
  catalogReleaseId: catalog.releaseId,
  catalogDigest: canonicalDigest(catalog),
  firmwareArtifactId: firmware.artifactId,
  firmwareDigest: firmware.sha256,
  adapterId: 'test-provider',
  adapterVersion: '1.0.0',
  engineId: 'test-engine',
  engineVersion: '1.0.0',
};

const runnerFirmwareBytes = Buffer.alloc(firmware.byteLength);
const runnerFirmwareDigest = createHash('sha256').update(runnerFirmwareBytes).digest('hex');
const runnerFirmware = { ...firmware, sha256: runnerFirmwareDigest };
const runnerBinding = { ...binding, firmwareDigest: runnerFirmwareDigest };
const runnerPayload = {
  runId: '6fb8f60e-ec9a-4d29-9122-4d2bf13e9c43',
  attemptId: 'a0359097-8a38-4650-a34d-61c039800d47',
  binding: runnerBinding,
  graph,
  catalog,
  validation: report,
  validationReportId: 'defa8605-9f6b-41e0-bb18-311d861ce3b4',
  validationReportDigest: canonicalDigest(report),
  firmware: runnerFirmware,
  firmwareReviewRevision: 3,
  firmwareBase64: runnerFirmwareBytes.toString('base64'),
  executionProfileId: 'test-reference-profile-v1',
  deadlineAt: new Date(Date.now() + 120_000).toISOString(),
};

function makeRunnerRequest(payload = runnerPayload) {
  const parsed = runnerExecutionPayloadSchema.parse({
    ...payload,
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
  });
  const payloadDigest = canonicalDigest(parsed);
  const notBefore = new Date(Date.now() - 1_000).toISOString();
  const expiresAt = new Date(Date.now() + 50_000).toISOString();
  return runnerExecutionRequestSchema.parse({
    protocolVersion: RUNNER_PROTOCOL_VERSION,
    payload: parsed,
    payloadDigest,
    capability: {
      keyId: 'worker-2026-10',
      audience: 'schemora-sandbox-runner',
      runId: parsed.runId,
      attemptId: parsed.attemptId,
      jti: '8a748297-16b7-4451-9f4f-813d1ee86c31',
      payloadDigest,
      notBefore,
      expiresAt,
      signature: 'A'.repeat(86),
    },
  });
}

function makeRunnerProfile() {
  return runnerExecutionProfileSchema.parse({
    profileId: runnerPayload.executionProfileId,
    adapterId: runnerBinding.adapterId,
    adapterVersion: runnerBinding.adapterVersion,
    engineId: runnerBinding.engineId,
    engineVersion: runnerBinding.engineVersion,
    imageDigest: `sha256:${'c'.repeat(64)}`,
    limits: {
      wallTimeoutMs: 60_000,
      memoryBytes: 128 * 1024 * 1024,
      cpuCount: 1,
      pids: 64,
      outputBytes: 1_000_000,
      stdoutBytes: 32_000,
    },
    firmwareLanguages: [runnerFirmware.language],
    boardPartIds: [runnerFirmware.boardPartId],
    componentPartIds: graph.components
      .filter((component) => component.catalogPartId !== runnerFirmware.boardPartId)
      .map((component) => component.catalogPartId),
    topologyIds: [],
  });
}

describe('simulation contracts', () => {
  it('allows only forward runner response transitions from the locked run state', () => {
    expect(runnerResponseTransitionAllowed('queued', 'accepted')).toBe(true);
    expect(runnerResponseTransitionAllowed('preparing', 'running')).toBe(true);
    expect(runnerResponseTransitionAllowed('running', 'running')).toBe(true);
    expect(runnerResponseTransitionAllowed('stopping', 'cancelled')).toBe(true);
    expect(runnerResponseTransitionAllowed('running', 'completed')).toBe(true);
    expect(runnerResponseTransitionAllowed('running', 'accepted')).toBe(false);
    expect(runnerResponseTransitionAllowed('stopping', 'running')).toBe(false);
    expect(runnerResponseTransitionAllowed('stopping', 'completed')).toBe(false);
    expect(runnerResponseTransitionAllowed('queued', 'completed')).toBe(false);
    expect(runnerResponseTransitionAllowed('completed', 'failed')).toBe(false);
    expect(runnerResponseTransitionAllowed('cancelled', 'cancelled')).toBe(false);
  });

  it('accepts only a versioned runner request bound to immutable design and firmware inputs', () => {
    const request = makeRunnerRequest();
    expect(request.payload.binding.graphDigest).toBe(canonicalDigest(graph));
    expect(
      runnerExecutionRequestSchema.safeParse({ ...request, injectedCommand: 'sh -c id' }).success,
    ).toBe(false);
    expect(
      runnerExecutionRequestSchema.safeParse({
        ...request,
        payload: { ...request.payload, firmwareBase64: 'not base64' },
      }).success,
    ).toBe(false);
  });

  it('rejects runner requests whose capability, binding, or frozen graph differs', () => {
    const request = makeRunnerRequest();
    expect(
      runnerExecutionRequestSchema.safeParse({
        ...request,
        capability: { ...request.capability, runId: 'f20d4748-979e-48cf-b76e-c4e0564d2ce4' },
      }).success,
    ).toBe(false);
    expect(
      runnerExecutionRequestSchema.safeParse({
        ...request,
        payload: {
          ...request.payload,
          graph: { ...graph, projectRevision: graph.projectRevision + 1 },
        },
      }).success,
    ).toBe(false);
  });

  it('verifies firmware bytes against the accepted artifact digest and profile allowlist', async () => {
    expect(await verifyRunnerFirmwareDigest(runnerPayload)).toBe(true);
    const changedBytes = Buffer.alloc(firmware.byteLength, 1).toString('base64');
    expect(
      await verifyRunnerFirmwareDigest({ ...runnerPayload, firmwareBase64: changedBytes }),
    ).toBe(false);
    const profile = makeRunnerProfile();
    expect(runnerPayloadMatchesProfile(runnerPayload, profile)).toBe(true);
    expect(runnerRequestMatchesProfile(makeRunnerRequest(), profile)).toBe(true);
    expect(
      runnerRequestMatchesProfile(
        makeRunnerRequest({ ...runnerPayload, executionProfileId: 'unknown-profile' }),
        profile,
      ),
    ).toBe(false);
    expect(
      runnerPayloadMatchesProfile(runnerPayload, { ...profile, engineId: 'unapproved-engine' }),
    ).toBe(false);
    const extraBoardGraph = {
      ...graph,
      components: [
        ...graph.components,
        { id: 'board_2', catalogPartId: runnerFirmware.boardPartId },
      ],
    };
    expect(
      runnerPayloadMatchesProfile(
        {
          ...runnerPayload,
          graph: extraBoardGraph,
          binding: { ...runnerPayload.binding, graphDigest: canonicalDigest(extraBoardGraph) },
        },
        profile,
      ),
    ).toBe(false);
  });

  it('requires terminal runner responses to include cleanup evidence and bounded result state', () => {
    const request = makeRunnerRequest();
    const accepted = {
      protocolVersion: RUNNER_PROTOCOL_VERSION,
      runId: request.payload.runId,
      attemptId: request.payload.attemptId,
      payloadDigest: request.payloadDigest,
      executionProfileId: request.payload.executionProfileId,
      imageDigest: `sha256:${'c'.repeat(64)}`,
      status: 'accepted',
      startedAt: null,
      finishedAt: null,
      terminationReason: null,
      run: null,
      outputManifest: [],
      totalOutputBytes: 0,
      cleanupReceipt: null,
    };
    expect(runnerExecutionResponseSchema.parse(accepted).status).toBe('accepted');
    const profile = makeRunnerProfile();
    expect(validateRunnerExecutionResponseForRequest(accepted, request, profile).valid).toBe(true);
    expect(
      validateRunnerExecutionResponseForRequest(
        { ...accepted, payloadDigest: 'b'.repeat(64) },
        request,
        profile,
      ).valid,
    ).toBe(false);
    expect(runnerExecutionResponseSchema.safeParse({ ...accepted, status: 'failed' }).success).toBe(
      false,
    );
    expect(
      runnerExecutionResponseSchema.safeParse({
        ...accepted,
        status: 'completed',
        finishedAt: new Date().toISOString(),
        terminationReason: 'completed',
        cleanupReceipt: {
          operationId: 'f76e3fd2-4b3c-40b2-8cb8-f9f9ca55fdf2',
          completedAt: new Date(Date.now() + 1000).toISOString(),
          executionStopped: true,
          runtimeObjectAbsent: true,
          workspaceRemoved: true,
        },
      }).success,
    ).toBe(false);
  });

  it('normalizes the captured ordered callback golden without inventing firmware provenance or time', () => {
    const normalized = normalizeQemuReferenceCallbacks({
      trace: capturedQemuCallbackTrace,
      graph,
      catalog,
    });

    expect(normalized.supported).toBe(true);
    if (!normalized.supported) return;
    expect(normalized.events).toHaveLength(327);
    expect(normalized.events.map((event) => event.sequence)).toEqual(
      Array.from({ length: 327 }, (_, index) => index + 1),
    );
    expect(normalized.events.filter((event) => event.kind === 'led_state')).toMatchObject([
      { kind: 'led_state', sequence: 1, state: 'off', componentInstanceId: 'led_1' },
      { kind: 'led_state', sequence: 59, state: 'on', componentInstanceId: 'led_1' },
      { kind: 'led_state', sequence: 106, state: 'off', componentInstanceId: 'led_1' },
      { kind: 'led_state', sequence: 153, state: 'on', componentInstanceId: 'led_1' },
      { kind: 'led_state', sequence: 200, state: 'off', componentInstanceId: 'led_1' },
      { kind: 'led_state', sequence: 247, state: 'on', componentInstanceId: 'led_1' },
    ]);
    expect(
      normalized.events
        .filter((event) => event.kind === 'serial')
        .map((event) => event.text)
        .join('')
        .replaceAll('\r', ''),
    ).toBe(
      [
        'SCHEMORA_GPIO19_SETUP=OK',
        'SCHEMORA_QEMU_REFERENCE_START',
        'SCHEMORA_GPIO19_REQUESTED=1,RESULT=OK,TICK=0',
        'SCHEMORA_GPIO19_REQUESTED=0,RESULT=OK,TICK=1',
        'SCHEMORA_GPIO19_REQUESTED=1,RESULT=OK,TICK=2',
        'SCHEMORA_GPIO19_REQUESTED=0,RESULT=OK,TICK=3',
        'SCHEMORA_GPIO19_REQUESTED=1,RESULT=OK,TICK=4',
        'SCHEMORA_QEMU_REFERENCE_COMPLETE',
        '',
      ].join('\n'),
    );
    expect(normalized.events.every((event) => event.simulationTimeMs === 0)).toBe(true);
    expect(normalized.limitations.join(' ')).toContain('does not prove which firmware binary');
  });

  it('rejects unsupported callback channels, values, and sequence order', () => {
    expect(
      normalizeQemuReferenceCallbacks({
        trace: [{ sequence: 1, type: 'gpio_level', gpio: 18, level: 1 }],
        graph,
        catalog,
      }),
    ).toMatchObject({ supported: false, reason: expect.stringContaining('GPIO19') });
    expect(
      normalizeQemuReferenceCallbacks({
        trace: [{ sequence: 1, type: 'uart_byte', uart: 1, value: 65 }],
        graph,
        catalog,
      }),
    ).toMatchObject({ supported: false, reason: expect.stringContaining('UART0') });
    expect(
      normalizeQemuReferenceCallbacks({
        trace: [{ sequence: 1, type: 'uart_byte', uart: 0, value: 27 }],
        graph,
        catalog,
      }),
    ).toMatchObject({ supported: false, reason: expect.stringContaining('printable ASCII') });
    expect(
      normalizeQemuReferenceCallbacks({
        trace: [{ sequence: 1, type: 'uart_byte', uart: 0, value: 127 }],
        graph,
        catalog,
      }),
    ).toMatchObject({ supported: false, reason: expect.stringContaining('printable ASCII') });
    expect(
      normalizeQemuReferenceCallbacks({
        trace: [{ sequence: Number.MAX_SAFE_INTEGER + 1, type: 'uart_byte', uart: 0, value: 65 }],
        graph,
        catalog,
      }),
    ).toMatchObject({ supported: false, reason: 'Callback trace is invalid.' });
    expect(
      normalizeQemuReferenceCallbacks({
        trace: [
          { sequence: 2, type: 'gpio_level', gpio: 19, level: 1 },
          { sequence: 2, type: 'uart_byte', uart: 0, value: 65 },
        ],
        graph,
        catalog,
      }),
    ).toMatchObject({ supported: false, reason: expect.stringContaining('strictly increasing') });
  });

  it('replays the captured QEMU callback trace into the exact graph-connected LED state', () => {
    expect(
      capturedGpio19Trace.every((event) => event.type === 'gpio_level' && event.gpio === 19),
    ).toBe(true);
    const mapped = mapEsp32Gpio19ToLedState({
      graph,
      catalog,
      signals: capturedGpio19Trace.map((event) => ({
        sequence: event.sequence,
        // The current QEMU callback ABI exposes levels, not simulated timestamps.
        simulationTimeMs: 0,
        pin: 19,
        enabled: true,
        level: event.level,
      })),
    });

    expect(mapped).toMatchObject({
      supported: true,
      componentInstanceId: 'led_1',
      events: [
        { kind: 'led_state', sequence: 1, state: 'off', componentInstanceId: 'led_1' },
        { kind: 'led_state', sequence: 2, state: 'on', componentInstanceId: 'led_1' },
        { kind: 'led_state', sequence: 3, state: 'off', componentInstanceId: 'led_1' },
        { kind: 'led_state', sequence: 4, state: 'on', componentInstanceId: 'led_1' },
        { kind: 'led_state', sequence: 5, state: 'off', componentInstanceId: 'led_1' },
        { kind: 'led_state', sequence: 6, state: 'on', componentInstanceId: 'led_1' },
      ],
    });
    if (mapped.supported)
      expect(mapped.limitations.join(' ')).toContain('does not calculate LED current');
  });

  it('rejects reversed LED polarity, malformed pin signals, and out-of-order observations', () => {
    const reversedGraph = {
      ...graph,
      wires: graph.wires.map((wire) => {
        if (wire.id === 'wire_resistor_led') {
          return {
            ...wire,
            target: {
              kind: 'terminal' as const,
              terminal: { componentInstanceId: 'led_1', catalogTerminalId: 'cathode' },
            },
          };
        }
        if (wire.id === 'wire_led_ground') {
          return {
            ...wire,
            source: {
              kind: 'terminal' as const,
              terminal: { componentInstanceId: 'led_1', catalogTerminalId: 'anode' },
            },
          };
        }
        return wire;
      }),
    };
    const signal = {
      sequence: 0,
      simulationTimeMs: 0,
      pin: 19 as const,
      enabled: true as const,
      level: 1 as const,
    };

    expect(
      mapEsp32Gpio19ToLedState({ graph: reversedGraph, catalog, signals: [signal] }),
    ).toMatchObject({
      supported: false,
      reason: expect.stringContaining('supported GPIO19-to-resistor'),
    });
    expect(
      mapEsp32Gpio19ToLedState({ graph, catalog, signals: [{ ...signal, pin: 18 as never }] }),
    ).toMatchObject({ supported: false, reason: expect.stringContaining('malformed') });
    expect(
      mapEsp32Gpio19ToLedState({
        graph,
        catalog,
        signals: [
          signal,
          { ...signal, sequence: 1, simulationTimeMs: 100, level: 0 },
          { ...signal, sequence: 2, simulationTimeMs: 50 },
        ],
      }),
    ).toMatchObject({ supported: false, reason: expect.stringContaining('ordered') });
  });

  it('accepts an exact current project binding only when the provider declares all modeled parts', () => {
    expect(report.status).toBe('unknown');
    expect(
      assessSimulationEligibility({
        graph,
        catalog,
        report,
        firmware,
        reportIsCurrent: true,
        capability,
      }),
    ).toEqual({
      eligible: true,
      binding: {
        projectId: graph.projectId,
        projectRevision: graph.projectRevision,
        graphId: graph.id,
        graphDigest: canonicalDigest(graph),
        catalogReleaseId: catalog.releaseId,
        catalogDigest: canonicalDigest(catalog),
        firmwareArtifactId: firmware.artifactId,
        firmwareDigest: firmware.sha256,
        adapterId: capability.providerId,
        adapterVersion: capability.providerVersion,
        engineId: capability.engineId,
        engineVersion: capability.engineVersion,
      },
    });
  });

  it('keeps artifact provenance revision separate from the graph revision used by a run', () => {
    const firmwareCreatedAfterGraph = {
      ...firmware,
      projectRevision: graph.projectRevision + 3,
    };
    expect(
      assessSimulationEligibility({
        graph,
        catalog,
        report,
        firmware: firmwareCreatedAfterGraph,
        reportIsCurrent: true,
        capability,
      }),
    ).toMatchObject({ eligible: true, binding: { projectRevision: graph.projectRevision } });
    const completedRun = {
      schemaVersion: 1 as const,
      contractVersion: '1.0.0' as const,
      runId: 'run_artifact_revision_independence',
      status: 'completed' as const,
      binding,
      events: [],
      unsupportedFeatures: [],
      limitations: [],
      failure: null,
      simulatedDurationMs: 0,
    };
    expect(
      validateSimulationRunAgainstDesign({
        run: completedRun,
        graph,
        catalog,
        firmware: firmwareCreatedAfterGraph,
        expectedBinding: binding,
      }),
    ).toMatchObject({ valid: true });
  });

  it('fails closed for unavailable providers, stale reports, unreviewed firmware and unsupported components', () => {
    expect(
      assessSimulationEligibility({
        graph,
        catalog,
        report,
        firmware,
        reportIsCurrent: true,
        capability: null,
      }),
    ).toMatchObject({ eligible: false, code: 'SIMULATOR_UNAVAILABLE' });
    expect(
      assessSimulationEligibility({
        graph,
        catalog,
        report,
        firmware,
        reportIsCurrent: false,
        capability,
      }),
    ).toMatchObject({ eligible: false, code: 'STALE_INPUT' });
    const shortGraph = {
      ...graph,
      wires: [
        {
          id: 'wire_power_ground_short',
          source: {
            kind: 'terminal' as const,
            terminal: { componentInstanceId: 'board_1', catalogTerminalId: '3v3-j2-1' },
          },
          target: {
            kind: 'terminal' as const,
            terminal: { componentInstanceId: 'board_1', catalogTerminalId: 'gnd-j3-1' },
          },
        },
      ],
    };
    expect(
      assessSimulationEligibility({
        graph: shortGraph,
        catalog,
        report: validateCircuit({ graph: shortGraph, catalog }),
        firmware,
        reportIsCurrent: true,
        capability,
      }),
    ).toMatchObject({ eligible: false, code: 'VALIDATION_NOT_PASSED' });
    expect(
      assessSimulationEligibility({
        graph,
        catalog,
        report,
        firmware: { ...firmware, reviewStatus: 'pending' },
        reportIsCurrent: true,
        capability,
      }),
    ).toMatchObject({ eligible: false });
    expect(
      assessSimulationEligibility({
        graph,
        catalog,
        report,
        firmware,
        reportIsCurrent: true,
        capability: { ...capability, componentPartIds: [] },
      }),
    ).toMatchObject({ eligible: false, code: 'UNSUPPORTED_COMPONENT' });
    expect(
      assessSimulationEligibility({
        graph,
        catalog,
        report,
        firmware,
        reportIsCurrent: true,
        capability: { ...capability, boardPartIds: [] },
      }),
    ).toMatchObject({ eligible: false, code: 'UNSUPPORTED_BOARD' });
    expect(
      assessSimulationEligibility({
        graph,
        catalog,
        report: { ...report, status: 'pass' },
        firmware,
        reportIsCurrent: true,
        capability,
      }),
    ).toMatchObject({ eligible: false, code: 'STALE_INPUT' });
    expect(
      assessSimulationEligibility({
        graph,
        catalog,
        report,
        firmware,
        reportIsCurrent: true,
        capability: { ...capability, engineId: '' },
      }),
    ).toMatchObject({ eligible: false, code: 'SIMULATOR_UNAVAILABLE' });
  });

  it('represents unavailable execution without emitting simulated output', () => {
    const result = unavailableSimulationRun({ runId: 'run_unavailable', binding });
    expect(result.status).toBe('unsupported');
    expect(result.events).toEqual([]);
    expect(result.failure?.code).toBe('SIMULATOR_UNAVAILABLE');
    expect(result.limitations.join(' ')).toContain('No firmware was compiled or executed');
    expect(simulationRunSchema.parse(result)).toEqual(result);
  });

  it('rejects non-monotonic provider events and false completed-with-error results', () => {
    const valid = unavailableSimulationRun({ runId: 'run_event_validation', binding });
    const event = {
      kind: 'serial' as const,
      sequence: 1,
      simulationTimeMs: 10,
      text: 'boot',
      stream: 'stdout' as const,
    };
    expect(
      simulationRunSchema.safeParse({
        ...valid,
        status: 'running',
        failure: null,
        events: [event, { ...event, sequence: 1 }],
      }).success,
    ).toBe(false);
    expect(
      simulationRunSchema.safeParse({
        ...valid,
        status: 'completed',
        failure: { code: 'ENGINE_FAILED', message: 'failed' },
      }).success,
    ).toBe(false);
  });

  it('rejects aggregate output that exceeds the persisted result quota', () => {
    const seed = unavailableSimulationRun({ runId: 'run_output_quota', binding });
    const result = simulationRunSchema.safeParse({
      ...seed,
      status: 'completed',
      failure: null,
      simulatedDurationMs: 2_000,
      events: Array.from({ length: 2_000 }, (_, sequence) => ({
        kind: 'serial' as const,
        sequence,
        simulationTimeMs: sequence,
        text: 'x'.repeat(1_024),
        stream: 'stdout' as const,
      })),
    });
    expect(result.success).toBe(false);
  });

  it('requires component output events to identify an instance of the right catalog category', () => {
    const runningRun = {
      schemaVersion: 1 as const,
      contractVersion: '1.0.0' as const,
      runId: 'run_valid_led',
      status: 'completed' as const,
      binding,
      events: [
        {
          kind: 'led_state' as const,
          sequence: 0,
          simulationTimeMs: 1,
          componentInstanceId: 'led_1',
          state: 'on' as const,
        },
      ],
      unsupportedFeatures: [],
      limitations: [],
      failure: null,
      simulatedDurationMs: 1,
    };
    expect(
      validateSimulationRunAgainstDesign({
        run: runningRun,
        graph,
        catalog,
        firmware,
        expectedBinding: binding,
      }),
    ).toMatchObject({ valid: true });
    expect(
      validateSimulationRunAgainstDesign({
        run: {
          ...runningRun,
          events: [{ ...runningRun.events[0], componentInstanceId: 'resistor_1' }],
        },
        graph,
        catalog,
        firmware,
        expectedBinding: binding,
      }),
    ).toMatchObject({ valid: false });
    expect(
      validateSimulationRunAgainstDesign({
        run: {
          ...runningRun,
          events: [{ ...runningRun.events[0], componentInstanceId: 'missing_led' }],
        },
        graph,
        catalog,
        firmware,
        expectedBinding: binding,
      }),
    ).toMatchObject({ valid: false });
  });
});
