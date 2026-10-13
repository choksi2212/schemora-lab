import { getCatalogRelease } from '@schemora/catalog';
import type { CircuitGraph } from '@schemora/circuit-model';
import { describe, expect, it } from 'vitest';
import { validateCircuit } from '../src/validate.js';

const catalog = getCatalogRelease();
const topology = catalog.breadboardTopologies[0]!;
const board = 'board.espressif.esp32-devkitc-v4.wroom-32e.male';
const led = 'led.kingbright.wp7113id';
const resistor = 'resistor.yageo.cfr-25jb-52-220r';

function circuit(): CircuitGraph {
  return {
    schemaVersion: 1,
    id: 'graph_validation',
    projectId: 'project_validation',
    projectRevision: 2,
    catalogReleaseId: catalog.releaseId,
    components: [
      { id: 'board_1', catalogPartId: board },
      { id: 'led_1', catalogPartId: led },
      { id: 'resistor_1', catalogPartId: resistor },
    ],
    breadboards: [
      {
        id: 'breadboard_1',
        topologyId: topology.id,
        topologyVersion: topology.version,
        railVariants: topology.railGroups.map((rail) => ({
          railGroupId: rail.id,
          variantId: rail.connectivityVariants[0]!.id,
        })),
      },
    ],
    terminalPlacements: [
      {
        terminal: { componentInstanceId: 'led_1', catalogTerminalId: 'anode' },
        hole: { breadboardInstanceId: 'breadboard_1', holeId: 'B1' },
      },
      {
        terminal: { componentInstanceId: 'led_1', catalogTerminalId: 'cathode' },
        hole: { breadboardInstanceId: 'breadboard_1', holeId: 'A2' },
      },
      {
        terminal: { componentInstanceId: 'resistor_1', catalogTerminalId: 'lead-a' },
        hole: { breadboardInstanceId: 'breadboard_1', holeId: 'B2' },
      },
      {
        terminal: { componentInstanceId: 'resistor_1', catalogTerminalId: 'lead-b' },
        hole: { breadboardInstanceId: 'breadboard_1', holeId: 'A3' },
      },
    ],
    wires: [
      {
        id: 'wire_gpio',
        source: {
          kind: 'terminal',
          terminal: { componentInstanceId: 'board_1', catalogTerminalId: 'gpio19' },
        },
        target: { kind: 'hole', hole: { breadboardInstanceId: 'breadboard_1', holeId: 'A1' } },
      },
      {
        id: 'wire_ground',
        source: {
          kind: 'terminal',
          terminal: { componentInstanceId: 'board_1', catalogTerminalId: 'gnd-j3-1' },
        },
        target: { kind: 'hole', hole: { breadboardInstanceId: 'breadboard_1', holeId: 'B3' } },
      },
    ],
  };
}

function status(graph: CircuitGraph, rule: string) {
  return validateCircuit({ graph, catalog }).findings.find((finding) => finding.ruleId === rule)
    ?.status;
}

describe('Phase 2 deterministic validation', () => {
  it('repeats with stable report and finding identifiers', () => {
    const graph = circuit();
    expect(validateCircuit({ graph, catalog })).toEqual(validateCircuit({ graph, catalog }));
  });

  it('recognizes correct LED orientation and a resistor on the whole modeled return path', () => {
    const graph = circuit();
    expect(status(graph, 'GRAPH_INTEGRITY')).toBe('pass');
    expect(status(graph, 'LED_POLARITY')).toBe('pass');
    expect(status(graph, 'LED_SERIES_RESISTOR')).toBe('pass');
    expect(validateCircuit({ graph, catalog }).status).toBe('unknown');
  });

  it('fails an LED with a modeled source-to-ground path that bypasses the resistor', () => {
    const graph = circuit();
    graph.wires.push({
      id: 'wire_bypass',
      source: { kind: 'hole', hole: { breadboardInstanceId: 'breadboard_1', holeId: 'C2' } },
      target: {
        kind: 'terminal',
        terminal: { componentInstanceId: 'board_1', catalogTerminalId: 'gnd-j3-1' },
      },
    });
    expect(status(graph, 'LED_SERIES_RESISTOR')).toBe('fail');
  });

  it('detects a direct modeled power-to-ground net and keeps electrical limits unknown', () => {
    const graph = circuit();
    graph.wires.push({
      id: 'wire_direct_short',
      source: {
        kind: 'terminal',
        terminal: { componentInstanceId: 'board_1', catalogTerminalId: '3v3-j2-1' },
      },
      target: {
        kind: 'terminal',
        terminal: { componentInstanceId: 'board_1', catalogTerminalId: 'gnd-j3-7' },
      },
    });
    const report = validateCircuit({ graph, catalog });
    expect(report.findings.find((finding) => finding.ruleId === 'POWER_GROUND_SHORT')?.status).toBe(
      'fail',
    );
    expect(
      report.findings.find((finding) => finding.ruleId === 'ELECTRICAL_SCOPE_LIMIT')?.status,
    ).toBe('unknown');
    expect(report.status).toBe('fail');
  });

  it('uses unknown when the source-to-ground loop has no complete modeled return path', () => {
    const graph = circuit();
    graph.wires = graph.wires.filter((wire) => wire.id !== 'wire_ground');
    expect(status(graph, 'LED_SERIES_RESISTOR')).toBe('unknown');
  });

  it('does not treat a board terminal disabled for this scenario as a modeled source', () => {
    const graph = circuit();
    const gpioWire = graph.wires.find((wire) => wire.id === 'wire_gpio')!;
    gpioWire.source = {
      kind: 'terminal',
      terminal: { componentInstanceId: 'board_1', catalogTerminalId: '3v3-j2-1' },
    };
    expect(status(graph, 'LED_POLARITY')).toBe('unknown');
    expect(status(graph, 'LED_SERIES_RESISTOR')).toBe('unknown');
  });
});
