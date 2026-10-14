import {
  getHardwareFamilyContract,
  type BreadboardTopology,
  type CatalogPart,
  type CatalogRelease,
} from '@schemora/catalog';
import {
  circuitGraphSchema,
  type CircuitGraph,
  type HoleRef,
  type Net,
  type TerminalRef,
} from './schema.js';
import { deriveStableId } from './stable-id.js';

export type CircuitCatalog = { release: CatalogRelease };
export type CircuitGraphIssue = { path: string; code: string; message: string };
export type CircuitValidationResult = { valid: boolean; issues: CircuitGraphIssue[] };
export type TransientSwitchContact = { terminalAId: string; terminalBId: string };
export type TransientSwitchDefinition = {
  componentInstanceId: string;
  /** Intrinsic continuity present in both switch states (for multi-terminal packages). */
  alwaysConnectedPairs?: TransientSwitchContact[];
  /** Contacts that become connected only while the instance is closed. */
  contactPairs: TransientSwitchContact[];
};
/** Ephemeral ideal-contact states. This overlay is never persisted into CircuitGraph. */
export type TransientSwitchOverlay = {
  switches: TransientSwitchDefinition[];
  closedSwitchInstanceIds: string[];
};

type ResolvedGroup = {
  id: string;
  holes: string[];
  source: 'terminal-strip' | 'rail';
  railGroupId: string | null;
  variantId: string | null;
};

function terminalKey(ref: TerminalRef): string {
  return `${ref.componentInstanceId}\u0000${ref.catalogTerminalId}`;
}

function holeKey(ref: HoleRef): string {
  return `${ref.breadboardInstanceId}\u0000${ref.holeId}`;
}

function endpointKey(endpoint: CircuitGraph['wires'][number]['source']): string {
  return endpoint.kind === 'terminal'
    ? `t\u0000${terminalKey(endpoint.terminal)}`
    : `h\u0000${holeKey(endpoint.hole)}`;
}

class UnionFind {
  private readonly parent = new Map<string, string>();

  add(key: string): void {
    if (!this.parent.has(key)) this.parent.set(key, key);
  }

  find(key: string): string {
    const parent = this.parent.get(key);
    if (parent === undefined) throw new Error(`Unknown node ${key}.`);
    if (parent === key) return key;
    const root = this.find(parent);
    this.parent.set(key, root);
    return root;
  }

  join(left: string, right: string): void {
    this.add(left);
    this.add(right);
    const a = this.find(left);
    const b = this.find(right);
    if (a !== b) this.parent.set(a < b ? b : a, a < b ? a : b);
  }
}

function partMap(release: CatalogRelease): Map<string, CatalogPart> {
  return new Map(release.parts.map((part) => [part.id, part]));
}

function topologyMap(release: CatalogRelease): Map<string, BreadboardTopology> {
  return new Map(release.breadboardTopologies.map((topology) => [topology.id, topology]));
}

function selectedGroups(
  topology: BreadboardTopology,
  railVariants: CircuitGraph['breadboards'][number]['railVariants'],
): ResolvedGroup[] {
  const groups: ResolvedGroup[] = topology.terminalStripGroups.map((group) => ({
    id: group.id,
    holes: group.holes,
    source: 'terminal-strip',
    railGroupId: null,
    variantId: null,
  }));
  for (const rail of topology.railGroups) {
    const selected = railVariants.find((variant) => variant.railGroupId === rail.id);
    const variant = rail.connectivityVariants.find(
      (candidate) => candidate.id === selected?.variantId,
    );
    if (!variant) continue;
    variant.connectedHoleSets.forEach((holes, index) => {
      groups.push({
        id: `${rail.id}:${variant.id}:${index + 1}`,
        holes,
        source: 'rail',
        railGroupId: rail.id,
        variantId: variant.id,
      });
    });
  }
  return groups;
}

export function validateCircuitGraph(
  input: unknown,
  catalog: CircuitCatalog,
): CircuitValidationResult {
  const parsed = circuitGraphSchema.safeParse(input);
  if (!parsed.success) {
    return {
      valid: false,
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        code: 'SCHEMA_INVALID',
        message: issue.message,
      })),
    };
  }

  const graph = parsed.data;
  const issues: CircuitGraphIssue[] = [];
  const parts = partMap(catalog.release);
  const instances = new Map(graph.components.map((component) => [component.id, component]));
  const topologies = topologyMap(catalog.release);
  const holesByTopology = new Map<string, Set<string>>();
  const boards = new Map(graph.breadboards.map((board) => [board.id, board]));
  const boardTopology = new Map<string, BreadboardTopology>();
  const issue = (path: string, code: string, message: string) =>
    issues.push({ path, code, message });

  if (graph.catalogReleaseId !== catalog.release.releaseId) {
    issue('catalogReleaseId', 'CATALOG_RELEASE_MISMATCH', 'Graph and catalog release IDs differ.');
  }
  for (const [name, values] of [
    ['component', graph.components.map((entry) => entry.id)],
    ['breadboard', graph.breadboards.map((entry) => entry.id)],
    ['wire', graph.wires.map((entry) => entry.id)],
  ] as const) {
    if (new Set(values).size !== values.length)
      issue(`${name}s`, 'DUPLICATE_ID', `${name} IDs must be unique.`);
  }

  for (const [index, component] of graph.components.entries()) {
    if (!parts.has(component.catalogPartId)) {
      issue(
        `components.${index}.catalogPartId`,
        'UNKNOWN_CATALOG_PART',
        'Component part is absent from the pinned catalog release.',
      );
    }
  }

  for (const [index, board] of graph.breadboards.entries()) {
    const topology = topologies.get(board.topologyId);
    if (!topology || topology.version !== board.topologyVersion) {
      issue(
        `breadboards.${index}`,
        'UNKNOWN_BREADBOARD_TOPOLOGY',
        'Breadboard topology is absent from this catalog release or its version differs.',
      );
      continue;
    }
    const variantIds = board.railVariants.map((variant) => variant.railGroupId);
    if (new Set(variantIds).size !== variantIds.length) {
      issue(
        `breadboards.${index}.railVariants`,
        'DUPLICATE_RAIL_VARIANT',
        'Each rail group may have only one selected connectivity variant.',
      );
    }
    for (const rail of topology.railGroups) {
      const selected = board.railVariants.filter((variant) => variant.railGroupId === rail.id);
      if (
        selected.length !== 1 ||
        !rail.connectivityVariants.some((variant) => variant.id === selected[0]?.variantId)
      ) {
        issue(
          `breadboards.${index}.railVariants`,
          'INVALID_RAIL_VARIANT',
          `Rail ${rail.id} requires one catalog-defined connectivity variant.`,
        );
      }
    }
    for (const selected of board.railVariants) {
      if (!topology.railGroups.some((rail) => rail.id === selected.railGroupId)) {
        issue(
          `breadboards.${index}.railVariants`,
          'UNKNOWN_RAIL_GROUP',
          `Unknown rail group ${selected.railGroupId}.`,
        );
      }
    }
    boardTopology.set(board.id, topology);
  }

  const terminalExists = (ref: TerminalRef, path: string): boolean => {
    const component = instances.get(ref.componentInstanceId);
    if (!component) {
      issue(
        path,
        'UNKNOWN_COMPONENT_INSTANCE',
        `Unknown component instance ${ref.componentInstanceId}.`,
      );
      return false;
    }
    const part = parts.get(component.catalogPartId);
    if (!part?.terminals.some((terminal) => terminal.id === ref.catalogTerminalId)) {
      issue(
        path,
        'UNKNOWN_CATALOG_TERMINAL',
        `Terminal ${ref.catalogTerminalId} is not part of the referenced catalog component.`,
      );
      return false;
    }
    return true;
  };

  const holeExists = (ref: HoleRef, path: string): boolean => {
    const topology = boardTopology.get(ref.breadboardInstanceId);
    if (!boards.has(ref.breadboardInstanceId) || !topology) {
      issue(
        path,
        'UNKNOWN_BREADBOARD_INSTANCE',
        `Unknown or unsupported breadboard instance ${ref.breadboardInstanceId}.`,
      );
      return false;
    }
    let allHoles = holesByTopology.get(topology.id);
    if (!allHoles) {
      allHoles = new Set([
        ...topology.terminalStripGroups.flatMap((group) => group.holes),
        ...topology.railGroups.flatMap((rail) =>
          rail.connectivityVariants.flatMap((variant) => variant.connectedHoleSets.flat()),
        ),
      ]);
      holesByTopology.set(topology.id, allHoles);
    }
    if (!allHoles.has(ref.holeId)) {
      issue(
        path,
        'UNKNOWN_BREADBOARD_HOLE',
        `Hole ${ref.holeId} is absent from the declared topology.`,
      );
      return false;
    }
    return true;
  };

  const occupiedHoles = new Map<string, string>();
  const placedTerminals = new Set<string>();
  for (const [index, placement] of graph.terminalPlacements.entries()) {
    const terminalOk = terminalExists(placement.terminal, `terminalPlacements.${index}.terminal`);
    const holeOk = holeExists(placement.hole, `terminalPlacements.${index}.hole`);
    if (!terminalOk || !holeOk) continue;
    const key = holeKey(placement.hole);
    const terminalId = terminalKey(placement.terminal);
    if (placedTerminals.has(terminalId))
      issue(
        `terminalPlacements.${index}.terminal`,
        'TERMINAL_PLACED_TWICE',
        'A terminal may occupy only one breadboard hole.',
      );
    placedTerminals.add(terminalId);
    const previous = occupiedHoles.get(key);
    if (previous)
      issue(
        `terminalPlacements.${index}.hole`,
        'HOLE_OCCUPIED',
        `Hole is already occupied by ${previous}.`,
      );
    else occupiedHoles.set(key, terminalId);
  }

  for (const [index, wire] of graph.wires.entries()) {
    if (endpointKey(wire.source) === endpointKey(wire.target))
      issue(`wires.${index}`, 'WIRE_SELF_LOOP', 'Wire endpoints must be distinct.');
    for (const [side, endpoint] of [
      ['source', wire.source],
      ['target', wire.target],
    ] as const) {
      if (endpoint.kind === 'terminal') {
        terminalExists(endpoint.terminal, `wires.${index}.${side}`);
      } else if (holeExists(endpoint.hole, `wires.${index}.${side}`)) {
        const key = holeKey(endpoint.hole);
        if (occupiedHoles.has(key))
          issue(
            `wires.${index}.${side}`,
            'HOLE_OCCUPIED',
            'A wire endpoint cannot occupy a hole already used by another lead.',
          );
        else occupiedHoles.set(key, wire.id);
      }
    }
  }

  return { valid: issues.length === 0, issues };
}

export function validateTransientSwitchOverlay(
  input: unknown,
  catalog: CircuitCatalog,
  overlay: TransientSwitchOverlay,
): CircuitValidationResult {
  const graphResult = validateCircuitGraph(input, catalog);
  if (!graphResult.valid) return graphResult;
  const graph = circuitGraphSchema.parse(input);
  const parts = partMap(catalog.release);
  const instances = new Map(graph.components.map((component) => [component.id, component]));
  const issues: CircuitGraphIssue[] = [];
  const issue = (path: string, code: string, message: string) =>
    issues.push({ path, code, message });
  const switchByInstance = new Map<string, TransientSwitchDefinition>();
  for (const [index, definition] of overlay.switches.entries()) {
    const path = `switches.${index}`;
    if (switchByInstance.has(definition.componentInstanceId)) {
      issue(
        `${path}.componentInstanceId`,
        'DUPLICATE_SWITCH_INSTANCE',
        'A switch instance may be defined only once.',
      );
      continue;
    }
    switchByInstance.set(definition.componentInstanceId, definition);
    const component = instances.get(definition.componentInstanceId);
    const part = component ? parts.get(component.catalogPartId) : undefined;
    if (!component || !part) {
      issue(
        `${path}.componentInstanceId`,
        'UNKNOWN_SWITCH_INSTANCE',
        'Switch definition must refer to a component in the graph.',
      );
      continue;
    }
    if (definition.contactPairs.length === 0)
      issue(
        `${path}.contactPairs`,
        'EMPTY_SWITCH_CONTACTS',
        'A switch definition requires at least one contact pair.',
      );
    for (const [kind, pairs] of [
      ['alwaysConnectedPairs', definition.alwaysConnectedPairs ?? []],
      ['contactPairs', definition.contactPairs],
    ] as const) {
      for (const [pairIndex, pair] of pairs.entries()) {
        const pairPath = `${path}.${kind}.${pairIndex}`;
        if (pair.terminalAId === pair.terminalBId)
          issue(
            pairPath,
            'SWITCH_CONTACT_SELF_LOOP',
            'A contact pair must connect two distinct terminals.',
          );
        for (const terminalId of [pair.terminalAId, pair.terminalBId]) {
          if (!part.terminals.some((terminal) => terminal.id === terminalId))
            issue(
              pairPath,
              'UNKNOWN_SWITCH_TERMINAL',
              `Terminal ${terminalId} is not part of the switch component.`,
            );
        }
      }
    }
  }
  if (new Set(overlay.closedSwitchInstanceIds).size !== overlay.closedSwitchInstanceIds.length)
    issue(
      'closedSwitchInstanceIds',
      'DUPLICATE_SWITCH_STATE',
      'Each switch state may be specified only once.',
    );
  for (const [index, instanceId] of overlay.closedSwitchInstanceIds.entries()) {
    if (!switchByInstance.has(instanceId))
      issue(
        `closedSwitchInstanceIds.${index}`,
        'UNKNOWN_SWITCH_STATE',
        'Closed state must refer to a declared switch instance.',
      );
  }
  return { valid: issues.length === 0, issues };
}

/** Build an ideal-contact overlay directly from curated pushbutton catalog topology. */
export function createTransientSwitchOverlay(
  input: unknown,
  catalog: CircuitCatalog,
  closedSwitchInstanceIds: string[] = [],
): TransientSwitchOverlay {
  const graphResult = validateCircuitGraph(input, catalog);
  if (!graphResult.valid)
    throw new Error(
      `Cannot create switch overlay from invalid graph: ${graphResult.issues[0]?.message ?? 'invalid graph'}`,
    );
  const graph = circuitGraphSchema.parse(input);
  const parts = partMap(catalog.release);
  const switches: TransientSwitchDefinition[] = [];
  for (const component of graph.components) {
    const part = parts.get(component.catalogPartId);
    if (part?.category !== 'pushbutton') continue;
    const contract = getHardwareFamilyContract(part.id);
    if (
      !contract ||
      contract.terminals.stateModel !== 'discrete-interaction' ||
      contract.simulation.mode !== 'circuit-level'
    )
      throw new Error(
        `Pushbutton family ${part.id} has no compatible registered provider contract.`,
      );
    const groupById = new Map(part.terminalGroups.map((group) => [group.id, group]));
    const alwaysConnectedPairs = part.terminalGroups.flatMap((group) => {
      const [first, ...rest] = group.terminalIds;
      return rest.map((terminalBId) => ({ terminalAId: first, terminalBId }));
    });
    const [leftId, rightId] = part.pressedConnection;
    const leftTerminal = groupById.get(leftId)?.terminalIds[0];
    const rightTerminal = groupById.get(rightId)?.terminalIds[0];
    if (!leftTerminal || !rightTerminal)
      throw new Error(`Pushbutton ${part.id} has an invalid pressed connection in the catalog.`);
    switches.push({
      componentInstanceId: component.id,
      alwaysConnectedPairs,
      contactPairs: [{ terminalAId: leftTerminal, terminalBId: rightTerminal }],
    });
  }
  const overlay = { switches, closedSwitchInstanceIds };
  const result = validateTransientSwitchOverlay(graph, catalog, overlay);
  if (!result.valid)
    throw new Error(
      `Cannot create switch overlay: ${result.issues[0]?.message ?? 'invalid overlay'}`,
    );
  return overlay;
}

export function deriveNets(
  input: unknown,
  catalog: CircuitCatalog,
  overlay?: TransientSwitchOverlay,
): Net[] {
  const result = validateCircuitGraph(input, catalog);
  if (!result.valid)
    throw new Error(
      `Cannot derive nets from invalid graph: ${result.issues[0]?.message ?? 'invalid graph'}`,
    );
  const graph = circuitGraphSchema.parse(input);
  const switchOverlay = overlay ?? createTransientSwitchOverlay(graph, catalog);
  const overlayResult = validateTransientSwitchOverlay(graph, catalog, switchOverlay);
  if (!overlayResult.valid)
    throw new Error(
      `Cannot derive nets from invalid switch overlay: ${overlayResult.issues[0]?.message ?? 'invalid overlay'}`,
    );
  const union = new UnionFind();
  const terminalRefs = new Map<string, TerminalRef>();
  const holeRefs = new Map<string, HoleRef>();
  const groupByNode = new Map<string, Net['connectivityGroupRefs'][number]>();
  const parts = partMap(catalog.release);

  for (const component of graph.components) {
    const part = parts.get(component.catalogPartId);
    if (!part) continue;
    for (const terminal of part.terminals) {
      const ref = { componentInstanceId: component.id, catalogTerminalId: terminal.id };
      terminalRefs.set(terminalKey(ref), ref);
      union.add(`t\u0000${terminalKey(ref)}`);
    }
  }
  for (const placement of graph.terminalPlacements) {
    const terminal = `t\u0000${terminalKey(placement.terminal)}`;
    const hole = `h\u0000${holeKey(placement.hole)}`;
    terminalRefs.set(terminalKey(placement.terminal), placement.terminal);
    holeRefs.set(holeKey(placement.hole), placement.hole);
    union.join(terminal, hole);
  }
  for (const wire of graph.wires) {
    const source = endpointKey(wire.source);
    const target = endpointKey(wire.target);
    union.join(source, target);
    if (wire.source.kind === 'terminal')
      terminalRefs.set(terminalKey(wire.source.terminal), wire.source.terminal);
    else holeRefs.set(holeKey(wire.source.hole), wire.source.hole);
    if (wire.target.kind === 'terminal')
      terminalRefs.set(terminalKey(wire.target.terminal), wire.target.terminal);
    else holeRefs.set(holeKey(wire.target.hole), wire.target.hole);
  }

  const closed = new Set(switchOverlay.closedSwitchInstanceIds);
  for (const definition of switchOverlay.switches) {
    const pairs = [
      ...(definition.alwaysConnectedPairs ?? []),
      ...(closed.has(definition.componentInstanceId) ? definition.contactPairs : []),
    ];
    for (const pair of pairs) {
      union.join(
        `t\u0000${terminalKey({ componentInstanceId: definition.componentInstanceId, catalogTerminalId: pair.terminalAId })}`,
        `t\u0000${terminalKey({ componentInstanceId: definition.componentInstanceId, catalogTerminalId: pair.terminalBId })}`,
      );
    }
  }

  const topologyById = topologyMap(catalog.release);
  for (const board of graph.breadboards) {
    const topology = topologyById.get(board.topologyId);
    if (!topology || topology.version !== board.topologyVersion) continue;
    for (const group of selectedGroups(topology, board.railVariants)) {
      const groupRef = {
        breadboardInstanceId: board.id,
        connectivityGroupId: group.id,
        source: group.source,
        railGroupId: group.railGroupId,
        variantId: group.variantId,
      };
      const groupNodes = group.holes.map((holeId) => {
        const ref = { breadboardInstanceId: board.id, holeId };
        holeRefs.set(holeKey(ref), ref);
        return `h\u0000${holeKey(ref)}`;
      });
      const [first, ...rest] = groupNodes;
      if (first) {
        union.add(first);
        for (const other of rest) union.join(first, other);
        for (const node of groupNodes) groupByNode.set(node, groupRef);
      }
    }
  }

  const buckets = new Map<
    string,
    {
      terminals: Map<string, TerminalRef>;
      holes: Map<string, HoleRef>;
      wires: Set<string>;
      groups: Map<string, Net['connectivityGroupRefs'][number]>;
    }
  >();
  const bucketAt = (node: string) => {
    const root = union.find(node);
    const bucket = buckets.get(root) ?? {
      terminals: new Map(),
      holes: new Map(),
      wires: new Set(),
      groups: new Map(),
    };
    buckets.set(root, bucket);
    return bucket;
  };

  for (const [key, ref] of terminalRefs) bucketAt(`t\u0000${key}`).terminals.set(key, ref);
  for (const [key, ref] of holeRefs) bucketAt(`h\u0000${key}`).holes.set(key, ref);
  for (const wire of graph.wires) bucketAt(endpointKey(wire.source)).wires.add(wire.id);
  for (const [node, group] of groupByNode) {
    bucketAt(node).groups.set(
      `${group.breadboardInstanceId}\u0000${group.connectivityGroupId}`,
      group,
    );
  }

  return [...buckets.values()]
    .filter((bucket) => bucket.terminals.size > 0)
    .map((bucket) => {
      const terminalKeys = [...bucket.terminals.keys()].sort();
      const holes = [...bucket.holes.keys()].sort();
      const wires = [...bucket.wires].sort();
      return {
        id: deriveStableId('net', { terminals: terminalKeys, holes }),
        terminalRefs: [...bucket.terminals.values()].sort((a, b) =>
          terminalKey(a).localeCompare(terminalKey(b)),
        ),
        holeRefs: [...bucket.holes.values()].sort((a, b) => holeKey(a).localeCompare(holeKey(b))),
        wireIds: wires,
        connectivityGroupRefs: [...bucket.groups.values()].sort((a, b) =>
          `${a.breadboardInstanceId}/${a.connectivityGroupId}`.localeCompare(
            `${b.breadboardInstanceId}/${b.connectivityGroupId}`,
          ),
        ),
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}
