import { getCatalogRelease } from '@schemora/catalog';
import { compareCircuitDesigns, type CircuitGraph } from '@schemora/circuit-model';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { validateCircuit } from '../src/validate.js';

const catalog = getCatalogRelease();
const topology = catalog.breadboardTopologies[0]!;
const board = 'board.espressif.esp32-devkitc-v4.wroom-32e.male';
const led = 'led.kingbright.wp7113id';
const resistor = 'resistor.yageo.cfr-25jb-52-220r';
type Phase8Fixture = {
  fixtureSchemaVersion: number;
  rulesetId: string;
  rulesetVersion: string;
  validatorVersion: string;
  catalogReleaseId: string;
  fixtures: Array<{
    id: string;
    ruleId: string;
    status: string;
    affectedEntityIds: string[];
  }>;
  comparisonFixtures: Array<{ id: string; expectedDifferenceKinds: string[] }>;
};
const phase8Fixtures = JSON.parse(
  readFileSync(new URL('./fixtures/phase8/v1/manifest.json', import.meta.url), 'utf8'),
) as Phase8Fixture;

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
  it('pins Phase 8 golden fixture metadata to the ruleset, validator, and catalog release', () => {
    expect(phase8Fixtures).toMatchObject({
      fixtureSchemaVersion: 1,
      rulesetId: 'schemora-phase2-basic-circuit',
      rulesetVersion: '1.0.0',
      validatorVersion: '0.1.0',
      catalogReleaseId: catalog.releaseId,
    });
    expect(phase8Fixtures.fixtures.map((fixture) => fixture.id)).toEqual([
      'direct-short',
      'reversed-led',
      'led-same-net',
      'missing-return',
      'invalid-topology',
    ]);
    expect(phase8Fixtures.comparisonFixtures.map((fixture) => fixture.id)).toEqual([
      'missing-return-wire',
      'wrong-destination',
    ]);
    for (const fixture of phase8Fixtures.fixtures)
      expect(fixture.affectedEntityIds).toEqual([...fixture.affectedEntityIds].sort());
  });

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
    const shortFinding = report.findings.find(
      (finding) => finding.ruleId === 'POWER_GROUND_SHORT',
    )!;
    expect(shortFinding.status).toBe(
      phase8Fixtures.fixtures.find((item) => item.id === 'direct-short')!.status,
    );
    expect(shortFinding.affectedEntityIds).toEqual(
      phase8Fixtures.fixtures.find((item) => item.id === 'direct-short')!.affectedEntityIds,
    );
    expect(shortFinding.sourceIds).toEqual(
      catalog.parts
        .find((part) => part.id === board)!
        .sourceIds.slice()
        .sort(),
    );
    expect(
      report.findings.find((finding) => finding.ruleId === 'ELECTRICAL_SCOPE_LIMIT')?.status,
    ).toBe('unknown');
    expect(report.status).toBe('fail');
  });

  it('uses unknown when the source-to-ground loop has no complete modeled return path', () => {
    const graph = circuit();
    graph.wires = graph.wires.filter((wire) => wire.id !== 'wire_ground');
    const finding = validateCircuit({ graph, catalog }).findings.find(
      (item) => item.ruleId === 'LED_SERIES_RESISTOR',
    )!;
    const fixture = phase8Fixtures.fixtures.find((item) => item.id === 'missing-return')!;
    expect(finding.status).toBe(fixture.status);
    expect(finding.affectedEntityIds).toEqual(fixture.affectedEntityIds);
    expect(finding.affectedEntityIds.some((id) => id.startsWith('wire:'))).toBe(false);
  });

  it('identifies exact modeled wire endpoints for reversed and same-net LED faults', () => {
    const reversed = circuit();
    reversed.wires = [
      {
        id: 'wire_source_cathode',
        source: {
          kind: 'terminal',
          terminal: { componentInstanceId: 'board_1', catalogTerminalId: 'gpio19' },
        },
        target: {
          kind: 'terminal',
          terminal: { componentInstanceId: 'led_1', catalogTerminalId: 'cathode' },
        },
      },
      {
        id: 'wire_anode_ground',
        source: {
          kind: 'terminal',
          terminal: { componentInstanceId: 'led_1', catalogTerminalId: 'anode' },
        },
        target: {
          kind: 'terminal',
          terminal: { componentInstanceId: 'board_1', catalogTerminalId: 'gnd-j3-1' },
        },
      },
    ];
    const reversedFinding = validateCircuit({ graph: reversed, catalog }).findings.find(
      (finding) => finding.ruleId === 'LED_POLARITY',
    )!;
    const reversedFixture = phase8Fixtures.fixtures.find((item) => item.id === 'reversed-led')!;
    expect(reversedFinding.status).toBe(reversedFixture.status);
    expect(reversedFinding.affectedEntityIds).toEqual(reversedFixture.affectedEntityIds);

    const sameNet = circuit();
    sameNet.wires = [
      {
        id: 'wire_led_same_net',
        source: {
          kind: 'terminal',
          terminal: { componentInstanceId: 'led_1', catalogTerminalId: 'anode' },
        },
        target: {
          kind: 'terminal',
          terminal: { componentInstanceId: 'led_1', catalogTerminalId: 'cathode' },
        },
      },
    ];
    const sameNetFinding = validateCircuit({ graph: sameNet, catalog }).findings.find(
      (finding) => finding.ruleId === 'LED_POLARITY',
    )!;
    const sameNetFixture = phase8Fixtures.fixtures.find((item) => item.id === 'led-same-net')!;
    expect(sameNetFinding.status).toBe(sameNetFixture.status);
    expect(sameNetFinding.affectedEntityIds).toEqual(sameNetFixture.affectedEntityIds);
  });

  it('reports the exact invalid topology path without inventing affected wires', () => {
    const graph = circuit();
    graph.breadboards[0]!.topologyVersion += 99;
    const finding = validateCircuit({ graph, catalog }).findings.find(
      (item) => item.ruleId === 'GRAPH_INTEGRITY',
    )!;
    const fixture = phase8Fixtures.fixtures.find((item) => item.id === 'invalid-topology')!;
    expect(finding.status).toBe(fixture.status);
    expect(finding.affectedEntityIds).toEqual(fixture.affectedEntityIds);
  });

  it('compares a missing required wire with exact target and working endpoint records', () => {
    const intended = circuit();
    const working = circuit();
    working.wires = working.wires.filter((wire) => wire.id !== 'wire_ground');
    const differences = compareCircuitDesigns(intended, working);
    const fixture = phase8Fixtures.comparisonFixtures.find(
      (item) => item.id === 'missing-return-wire',
    )!;
    expect(differences.map((item) => item.kind)).toEqual(fixture.expectedDifferenceKinds);
    expect(differences).toEqual([
      expect.objectContaining({
        kind: 'wire-removed',
        intended: intended.wires.find((wire) => wire.id === 'wire_ground'),
        working: null,
      }),
    ]);
  });

  it('compares a wrong destination as the exact missing and added modeled connections', () => {
    const intended = circuit();
    const working = circuit();
    working.wires[0]!.target = {
      kind: 'hole',
      hole: { breadboardInstanceId: 'breadboard_1', holeId: 'J24' },
    };
    const differences = compareCircuitDesigns(intended, working);
    const fixture = phase8Fixtures.comparisonFixtures.find(
      (item) => item.id === 'wrong-destination',
    )!;
    expect(differences.map((item) => item.kind)).toEqual(fixture.expectedDifferenceKinds);
    expect(differences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'wire-removed',
          intended: intended.wires[0],
          working: null,
        }),
        expect.objectContaining({
          kind: 'wire-added',
          intended: null,
          working: working.wires[0],
        }),
      ]),
    );
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
