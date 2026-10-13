import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { canonicalDigest } from '@schemora/assembly-plan';
import { getCatalogRelease } from '@schemora/catalog';
import { mapEsp32Gpio19ToLedState, validateSimulationRunAgainstDesign } from '@schemora/simulation';
import type { CircuitWorkbenchGraph } from './circuit-scene';
import { resolveSimulationLedStates, type SceneSimulationRun } from './simulation-scene-state';

const graph: CircuitWorkbenchGraph = {
  schemaVersion: 1,
  id: 'graph_1',
  projectId: 'project_1',
  projectRevision: 4,
  catalogReleaseId: 'catalog_1',
  components: [
    { id: 'board_1', catalogPartId: 'board.espressif.esp32-devkitc-v4.wroom-32e.male' },
    { id: 'resistor_1', catalogPartId: 'resistor.yageo.cfr-25jb-52-220r' },
    { id: 'led_1', catalogPartId: 'led.kingbright.wp7113id' },
  ],
  breadboards: [],
  terminalPlacements: [],
  wires: [],
};
const graphDigest = 'a'.repeat(64);
const firmwareDigest = 'b'.repeat(64);

const referenceGraph = {
  schemaVersion: 1 as const,
  id: graph.id,
  projectId: graph.projectId,
  projectRevision: graph.projectRevision,
  catalogReleaseId: graph.catalogReleaseId,
  components: graph.components,
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

function run(events: unknown[]): SceneSimulationRun {
  return {
    status: 'completed',
    binding: {
      projectId: graph.projectId,
      projectRevision: graph.projectRevision,
      graphId: graph.id,
      graphDigest,
      catalogReleaseId: graph.catalogReleaseId,
      firmwareDigest,
    },
    events,
  };
}

describe('simulation scene state', () => {
  it('carries the pinned GPIO trace through graph mapping, run validation, and scene state', () => {
    const catalog = getCatalogRelease();
    const boundGraph = { ...referenceGraph, catalogReleaseId: catalog.releaseId };
    const trace = readFileSync(
      new URL('../../../../examples/phase6-qemu-gpio-probe/expected-gpio19.jsonl', import.meta.url),
      'utf8',
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { sequence: number; gpio: number; level: 0 | 1 });
    const mapped = mapEsp32Gpio19ToLedState({
      graph: boundGraph,
      catalog,
      signals: trace.map((event) => ({
        sequence: event.sequence,
        // The pinned callback reports order and level, not simulation time.
        simulationTimeMs: 0,
        pin: event.gpio as 19,
        enabled: true,
        level: event.level,
      })),
    });
    expect(mapped.supported).toBe(true);
    if (!mapped.supported) return;

    const firmware = {
      schemaVersion: 1 as const,
      artifactId: 'firmware_reference_v1',
      projectId: graph.projectId,
      projectRevision: graph.projectRevision,
      sha256: firmwareDigest,
      byteLength: 128,
      language: 'esp-idf-c' as const,
      entrypoint: 'main/main.c',
      boardPartId: graph.components[0]!.catalogPartId,
      reviewStatus: 'accepted' as const,
    };
    const binding = {
      projectId: graph.projectId,
      projectRevision: graph.projectRevision,
      graphId: graph.id,
      graphDigest: canonicalDigest(boundGraph),
      catalogReleaseId: catalog.releaseId,
      catalogDigest: canonicalDigest(catalog),
      firmwareArtifactId: firmware.artifactId,
      firmwareDigest,
      adapterId: 'picsimlab-gpio-callback-replay',
      adapterVersion: '1.0.0',
      engineId: 'qemu-picsimlab-fork',
      engineVersion: '9.2.2',
    };
    const validation = validateSimulationRunAgainstDesign({
      run: {
        schemaVersion: 1,
        contractVersion: '1.0.0',
        runId: 'run_gpio_reference',
        status: 'completed',
        binding,
        events: mapped.events,
        unsupportedFeatures: [],
        limitations: mapped.limitations,
        failure: null,
        // Callback timestamps are unavailable; zero is a placeholder, not a timing claim.
        simulatedDurationMs: 0,
      },
      graph: boundGraph,
      catalog,
      firmware,
      expectedBinding: binding,
    });
    expect(validation.valid).toBe(true);
    if (!validation.valid) return;

    const sceneRun: SceneSimulationRun = {
      status: validation.run.status,
      binding: {
        projectId: validation.run.binding.projectId,
        projectRevision: validation.run.binding.projectRevision,
        graphId: validation.run.binding.graphId,
        graphDigest: validation.run.binding.graphDigest,
        catalogReleaseId: validation.run.binding.catalogReleaseId,
        firmwareDigest: validation.run.binding.firmwareDigest,
      },
      events: validation.run.events,
    };
    expect(
      resolveSimulationLedStates({
        graph: { ...graph, catalogReleaseId: catalog.releaseId },
        run: sceneRun,
        currentGraphDigest: binding.graphDigest,
        currentFirmwareDigest: firmwareDigest,
      }),
    ).toEqual({ led_1: 'on' });
  });

  it('applies the latest allowlisted LED event for a current completed run', () => {
    expect(
      resolveSimulationLedStates({
        graph,
        run: run([
          {
            kind: 'serial',
            sequence: 1,
            simulationTimeMs: 0,
            text: 'boot',
            stream: 'stdout',
          },
          {
            kind: 'led_state',
            sequence: 2,
            simulationTimeMs: 1,
            componentInstanceId: 'led_1',
            state: 'on',
          },
          {
            kind: 'led_state',
            sequence: 3,
            simulationTimeMs: 2,
            componentInstanceId: 'led_1',
            state: 'off',
          },
        ]),
        currentGraphDigest: graphDigest,
        currentFirmwareDigest: firmwareDigest,
      }),
    ).toEqual({ led_1: 'off' });
  });

  it('clears visual state when graph or firmware identity is stale or unavailable', () => {
    const currentRun = run([
      {
        kind: 'led_state',
        sequence: 1,
        simulationTimeMs: 1,
        componentInstanceId: 'led_1',
        state: 'on',
      },
    ]);
    expect(
      resolveSimulationLedStates({
        graph,
        run: currentRun,
        currentGraphDigest: 'c'.repeat(64),
        currentFirmwareDigest: firmwareDigest,
      }),
    ).toEqual({});
    expect(
      resolveSimulationLedStates({
        graph,
        run: currentRun,
        currentGraphDigest: graphDigest,
        currentFirmwareDigest: 'd'.repeat(64),
      }),
    ).toEqual({});
    expect(
      resolveSimulationLedStates({
        graph,
        run: currentRun,
        currentGraphDigest: null,
        currentFirmwareDigest: firmwareDigest,
      }),
    ).toEqual({});
    expect(
      resolveSimulationLedStates({
        graph: { ...graph, projectRevision: graph.projectRevision + 1 },
        run: currentRun,
        currentGraphDigest: graphDigest,
        currentFirmwareDigest: firmwareDigest,
      }),
    ).toEqual({});
  });

  it('fails closed for malformed ordering and non-LED component targets', () => {
    const outOfOrder = run([
      {
        kind: 'led_state',
        sequence: 2,
        simulationTimeMs: 2,
        componentInstanceId: 'led_1',
        state: 'on',
      },
      {
        kind: 'led_state',
        sequence: 1,
        simulationTimeMs: 1,
        componentInstanceId: 'led_1',
        state: 'off',
      },
    ]);
    const wrongTarget = run([
      {
        kind: 'led_state',
        sequence: 1,
        simulationTimeMs: 1,
        componentInstanceId: 'resistor_1',
        state: 'on',
      },
    ]);
    for (const candidate of [outOfOrder, wrongTarget]) {
      expect(
        resolveSimulationLedStates({
          graph,
          run: candidate,
          currentGraphDigest: graphDigest,
          currentFirmwareDigest: firmwareDigest,
        }),
      ).toEqual({});
    }
  });

  it('does not apply events from a run that is not completed', () => {
    const candidate = { ...run([]), status: 'running' };
    expect(
      resolveSimulationLedStates({
        graph,
        run: candidate,
        currentGraphDigest: graphDigest,
        currentFirmwareDigest: firmwareDigest,
      }),
    ).toEqual({});
  });
});
