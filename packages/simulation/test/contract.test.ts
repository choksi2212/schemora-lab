import { describe, expect, it } from 'vitest';
import { canonicalDigest } from '@schemora/assembly-plan';
import { getCatalogRelease } from '@schemora/catalog';
import { validateCircuit } from '@schemora/validation';
import {
  assessSimulationEligibility,
  firmwareArtifactRefSchema,
  simulationRunSchema,
  unavailableSimulationRun,
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
  topologyIds: [],
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
    expect(
      assessSimulationEligibility({
        graph,
        catalog,
        report: { ...report, status: 'fail' },
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
});
