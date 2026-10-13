import { describe, expect, it } from 'vitest';
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
