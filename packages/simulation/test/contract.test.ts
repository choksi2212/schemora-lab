import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { canonicalDigest } from '@schemora/assembly-plan';
import { getCatalogRelease } from '@schemora/catalog';
import { validateCircuit } from '@schemora/validation';
import {
  assessSimulationEligibility,
  firmwareArtifactRefSchema,
  mapEsp32Gpio19ToLedState,
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

describe('simulation contracts', () => {
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
