import { getCatalogRelease } from '@schemora/catalog';
import { describe, expect, it } from 'vitest';
import {
  deriveNets,
  mapReviewedConnectionCandidate,
  validateCircuitGraph,
  type CircuitCatalog,
  type CircuitGraph,
} from '../src/index.js';
import { deriveStableId } from '../src/stable-id.js';

const release = getCatalogRelease();
const topology = release.breadboardTopologies[0]!;
const catalog: CircuitCatalog = { release };
const continuousRails = topology.railGroups.map((rail) => ({
  railGroupId: rail.id,
  variantId: rail.connectivityVariants[0]!.id,
}));

const graph: CircuitGraph = {
  schemaVersion: 1,
  id: 'graph_demo',
  projectId: 'project_demo',
  projectRevision: 3,
  catalogReleaseId: release.releaseId,
  components: [
    { id: 'board_1', catalogPartId: 'board.espressif.esp32-devkitc-v4.wroom-32e.male' },
    { id: 'led_1', catalogPartId: 'led.kingbright.wp7113id' },
  ],
  breadboards: [
    {
      id: 'breadboard_1',
      topologyId: topology.id,
      topologyVersion: topology.version,
      railVariants: continuousRails,
    },
  ],
  terminalPlacements: [
    {
      terminal: { componentInstanceId: 'led_1', catalogTerminalId: 'anode' },
      hole: { breadboardInstanceId: 'breadboard_1', holeId: 'A1' },
    },
    {
      terminal: { componentInstanceId: 'led_1', catalogTerminalId: 'cathode' },
      hole: { breadboardInstanceId: 'breadboard_1', holeId: 'F1' },
    },
  ],
  wires: [
    {
      id: 'wire_gpio',
      source: {
        kind: 'terminal',
        terminal: { componentInstanceId: 'board_1', catalogTerminalId: 'gpio19' },
      },
      target: { kind: 'hole', hole: { breadboardInstanceId: 'breadboard_1', holeId: 'B1' } },
    },
  ],
};

describe('circuit model', () => {
  it('maps a reviewed Phase 1 connection only through an explicit endpoint resolver', () => {
    const candidate = {
      id: 'candidate_connection_1',
      kind: 'connection' as const,
      value: 'Connect GPIO19 to the LED anode.',
      evidence: [
        { messageId: 'message_1', quote: 'Connect GPIO19 to the LED anode.', start: 0, end: 33 },
      ],
      status: 'candidate' as const,
      supersedes: [],
      uncertainty: null,
      details: {
        from: { label: 'GPIO19', componentRef: 'board_1' },
        to: { label: 'LED anode', componentRef: 'led_1' },
      },
    };
    const decision = {
      candidateId: candidate.id,
      decisionId: 'review_3',
      disposition: 'confirmed' as const,
      reviewRevision: 3,
    };
    const resolver = (endpoint: { label: string; componentRef: string | null }) => {
      if (endpoint.componentRef === 'board_1' && endpoint.label === 'GPIO19') {
        return {
          kind: 'terminal' as const,
          terminal: { componentInstanceId: 'board_1', catalogTerminalId: 'gpio19' },
        };
      }
      if (endpoint.componentRef === 'led_1' && endpoint.label === 'LED anode') {
        return {
          kind: 'terminal' as const,
          terminal: { componentInstanceId: 'led_1', catalogTerminalId: 'anode' },
        };
      }
      return null;
    };
    const edge = mapReviewedConnectionCandidate(candidate, decision, resolver);
    expect(edge?.source).toEqual({
      kind: 'terminal',
      terminal: { componentInstanceId: 'board_1', catalogTerminalId: 'gpio19' },
    });
    expect(mapReviewedConnectionCandidate(candidate, decision, () => null)).toBeNull();
    expect(() =>
      mapReviewedConnectionCandidate(candidate, { ...decision, candidateId: 'other' }, resolver),
    ).toThrow();
    expect(() =>
      mapReviewedConnectionCandidate({ ...candidate, status: 'superseded' }, decision, resolver),
    ).toThrow();
  });

  it('uses deterministic namespaced IDs', () => {
    expect(deriveStableId('test', 1)).toBe(
      'test_625b2f00bbe1ec1a3893bcb61d442f65ee83fbf04c69b4e494bdb329532c86be',
    );
    expect(deriveStableId('component', ['project-1', 'source-7'])).toBe(
      deriveStableId('component', ['project-1', 'source-7']),
    );
    expect(deriveStableId('component', ['project-1', 'source-7'])).not.toBe(
      deriveStableId('terminal', ['project-1', 'source-7']),
    );
  });

  it('derives nets from explicit wire edges and catalog terminal-strip groups', () => {
    expect(validateCircuitGraph(graph, catalog)).toEqual({ valid: true, issues: [] });
    const nets = deriveNets(graph, catalog);
    const ledAnodeNet = nets.find((net) =>
      net.terminalRefs.some(
        (ref) => ref.componentInstanceId === 'led_1' && ref.catalogTerminalId === 'anode',
      ),
    );
    expect(ledAnodeNet?.terminalRefs).toContainEqual({
      componentInstanceId: 'board_1',
      catalogTerminalId: 'gpio19',
    });
    expect(ledAnodeNet?.holeRefs).toContainEqual({
      breadboardInstanceId: 'breadboard_1',
      holeId: 'B1',
    });
    expect(ledAnodeNet?.connectivityGroupRefs).toContainEqual({
      breadboardInstanceId: 'breadboard_1',
      connectivityGroupId: 'terminal-upper-01',
      source: 'terminal-strip',
      railGroupId: null,
      variantId: null,
    });
    const cathodeNet = nets.find((net) =>
      net.terminalRefs.some(
        (ref) => ref.componentInstanceId === 'led_1' && ref.catalogTerminalId === 'cathode',
      ),
    );
    expect(cathodeNet?.id).not.toBe(ledAnodeNet?.id);
    expect(
      nets.find((net) => net.terminalRefs.some((ref) => ref.catalogTerminalId === 'gnd-j3-1')),
    ).toBeDefined();
  });

  it('validates a bounded, versioned visual layout independently of connectivity', () => {
    const arranged: CircuitGraph = {
      ...graph,
      visualLayout: {
        schemaVersion: 1,
        componentPlacements: [
          { componentInstanceId: 'board_1', x: 0, z: 0.5, rotationY: 0 },
          { componentInstanceId: 'led_1', x: 1.25, z: -0.25, rotationY: 90 },
        ],
      },
    };
    expect(validateCircuitGraph(arranged, catalog)).toEqual({ valid: true, issues: [] });
    expect(
      validateCircuitGraph(
        {
          ...arranged,
          visualLayout: {
            schemaVersion: 1,
            componentPlacements: [
              { componentInstanceId: 'missing', x: 0, z: 0, rotationY: 0 },
              { componentInstanceId: 'led_1', x: 0, z: 0, rotationY: 45 },
            ],
          },
        },
        catalog,
      ).valid,
    ).toBe(false);
  });

  it('honors separate five-hole columns and continuous named rail groups', () => {
    const railGraph: CircuitGraph = {
      ...graph,
      terminalPlacements: [
        {
          terminal: { componentInstanceId: 'led_1', catalogTerminalId: 'anode' },
          hole: { breadboardInstanceId: 'breadboard_1', holeId: 'rail-1:1' },
        },
      ],
      wires: [],
    };
    const ledNet = deriveNets(railGraph, catalog).find((net) =>
      net.terminalRefs.some(
        (ref) => ref.componentInstanceId === 'led_1' && ref.catalogTerminalId === 'anode',
      ),
    );
    expect(ledNet?.holeRefs.map((ref) => ref.holeId)).toHaveLength(25);
    expect(ledNet?.connectivityGroupRefs).toContainEqual({
      breadboardInstanceId: 'breadboard_1',
      connectivityGroupId: 'rail-1:continuous:1',
      source: 'rail',
      railGroupId: 'rail-1',
      variantId: 'continuous',
    });
    expect(ledNet?.holeRefs).not.toContainEqual({
      breadboardInstanceId: 'breadboard_1',
      holeId: 'rail-2:1',
    });
  });

  it('rejects unknown terminals and holes, duplicate physical occupancy, and absent topology versions', () => {
    const unknownTerminal = structuredClone(graph);
    if (unknownTerminal.wires[0]!.source.kind === 'terminal') {
      unknownTerminal.wires[0]!.source.terminal.catalogTerminalId = 'GPIO999';
    }
    expect(
      validateCircuitGraph(unknownTerminal, catalog).issues.map((entry) => entry.code),
    ).toContain('UNKNOWN_CATALOG_TERMINAL');

    const occupied = structuredClone(graph);
    occupied.wires[0]!.target.kind === 'hole' && (occupied.wires[0]!.target.hole.holeId = 'A1');
    expect(validateCircuitGraph(occupied, catalog).issues.map((entry) => entry.code)).toContain(
      'HOLE_OCCUPIED',
    );

    const unknownHole = structuredClone(graph);
    if (unknownHole.terminalPlacements[0]) unknownHole.terminalPlacements[0].hole.holeId = 'K99';
    expect(validateCircuitGraph(unknownHole, catalog).issues.map((entry) => entry.code)).toContain(
      'UNKNOWN_BREADBOARD_HOLE',
    );

    const stale = structuredClone(graph);
    const staleInput = stale as unknown as { breadboards: Array<{ topologyVersion: number }> };
    staleInput.breadboards[0]!.topologyVersion = 2;
    expect(validateCircuitGraph(staleInput, catalog).issues.map((entry) => entry.code)).toContain(
      'UNKNOWN_BREADBOARD_TOPOLOGY',
    );
  });

  it('requires an explicit valid rail connectivity variant for each modeled rail', () => {
    const missingVariant = structuredClone(graph);
    missingVariant.breadboards[0]!.railVariants.pop();
    expect(
      validateCircuitGraph(missingVariant, catalog).issues.map((entry) => entry.code),
    ).toContain('INVALID_RAIL_VARIANT');

    const inventedVariant = structuredClone(graph);
    inventedVariant.breadboards[0]!.railVariants[0]!.variantId = 'unverified-split';
    expect(
      validateCircuitGraph(inventedVariant, catalog).issues.map((entry) => entry.code),
    ).toContain('INVALID_RAIL_VARIANT');
  });
});
