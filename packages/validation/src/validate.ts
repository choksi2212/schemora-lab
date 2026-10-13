import { createHash } from 'node:crypto';
import { catalogReleaseSchema, type CatalogPart, type CatalogRelease } from '@schemora/catalog';
import {
  circuitGraphSchema,
  deriveNets,
  validateCircuitGraph,
  type CircuitGraph,
  type TerminalRef,
} from '@schemora/circuit-model';
import { validationReportSchema, type ValidationFinding, type ValidationReport } from './schema.js';

const RULESET_ID = 'schemora-phase2-basic-circuit' as const;
const RULESET_VERSION = '1.0.0' as const;
const VALIDATOR_VERSION = '0.1.0' as const;

export type ValidateCircuitInput = {
  graph: unknown;
  catalog: unknown;
};

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function terminalKey(ref: TerminalRef): string {
  return `${ref.componentInstanceId}\u0000${ref.catalogTerminalId}`;
}

function makeFinding(
  ruleId: string,
  status: ValidationFinding['status'],
  severity: ValidationFinding['severity'],
  message: string,
  affectedEntityIds: string[],
  sourceIds: string[] = [],
): ValidationFinding {
  const identity = `${ruleId}\u0000${status}\u0000${[...affectedEntityIds].sort().join('\u0000')}`;
  return {
    id: createHash('sha256').update(identity).digest('hex').slice(0, 24),
    ruleId,
    ruleVersion: RULESET_VERSION,
    status,
    severity,
    message,
    affectedEntityIds: [...new Set(affectedEntityIds)].sort(),
    sourceIds: [...new Set(sourceIds)].sort(),
  };
}

function overallStatus(findings: ValidationFinding[]): ValidationReport['status'] {
  if (findings.some((finding) => finding.status === 'error')) return 'error';
  if (findings.some((finding) => finding.status === 'fail')) return 'fail';
  if (findings.some((finding) => finding.status === 'unknown')) return 'unknown';
  if (findings.every((finding) => finding.status === 'not_applicable')) return 'not_applicable';
  return 'pass';
}

function partSources(part: CatalogPart | undefined): string[] {
  return part?.sourceIds ?? [];
}

type ElectricalEdge = { from: string; to: string; kind: 'resistor' | 'led'; entityId: string };

function hasResistorPath(
  sourceNets: string[],
  targetNets: string[],
  edges: ElectricalEdge[],
): boolean {
  const targets = new Set(targetNets);
  const adjacent = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.kind !== 'resistor') continue;
    adjacent.set(edge.from, [...(adjacent.get(edge.from) ?? []), edge.to]);
    adjacent.set(edge.to, [...(adjacent.get(edge.to) ?? []), edge.from]);
  }
  const pending = [...sourceNets];
  const visited = new Set(pending);
  for (let cursor = 0; cursor < pending.length; cursor += 1) {
    const current = pending[cursor]!;
    if (targets.has(current)) return true;
    for (const next of adjacent.get(current) ?? []) {
      if (visited.has(next)) continue;
      visited.add(next);
      pending.push(next);
    }
  }
  return false;
}

function pathWithLedAndResistor(
  sourceNets: string[],
  groundNets: string[],
  ledId: string,
  edges: ElectricalEdge[],
): { withResistor: boolean; withoutResistor: boolean } {
  const adjacency = new Map<string, ElectricalEdge[]>();
  for (const edge of edges) {
    const from = adjacency.get(edge.from) ?? [];
    from.push(edge);
    adjacency.set(edge.from, from);
    if (edge.kind === 'resistor') {
      const to = adjacency.get(edge.to) ?? [];
      to.push({ ...edge, from: edge.to, to: edge.from });
      adjacency.set(edge.to, to);
    }
  }
  const queue: Array<{ net: string; sawTargetLed: boolean; sawResistor: boolean }> = sourceNets.map(
    (net) => ({ net, sawTargetLed: false, sawResistor: false }),
  );
  const visited = new Set<string>();
  let withResistor = false;
  let withoutResistor = false;
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const state = queue[cursor]!;
    const key = `${state.net}\u0000${state.sawTargetLed}\u0000${state.sawResistor}`;
    if (visited.has(key)) continue;
    visited.add(key);
    if (groundNets.includes(state.net) && state.sawTargetLed) {
      if (state.sawResistor) {
        // Keep searching: a second route can bypass the resistor even when
        // another source-to-ground route contains one.
        withResistor = true;
      } else {
        withoutResistor = true;
      }
      continue;
    }
    for (const edge of adjacency.get(state.net) ?? []) {
      queue.push({
        net: edge.to,
        sawTargetLed: state.sawTargetLed || (edge.kind === 'led' && edge.entityId === ledId),
        sawResistor: state.sawResistor || edge.kind === 'resistor',
      });
    }
  }
  return { withResistor, withoutResistor };
}

/**
 * Deterministic, source-linked checks for the deliberately narrow Phase 2
 * circuit profile. A passing supported rule never implies that the whole
 * electrical design is safe or that an unmodelled fact is acceptable.
 */
export function validateCircuit(input: ValidateCircuitInput): ValidationReport {
  const catalogResult = catalogReleaseSchema.safeParse(input.catalog);
  if (!catalogResult.success) throw new Error('The pinned catalog release is invalid.');
  const catalog = catalogResult.data as CatalogRelease & {
    breadboardTopologies: NonNullable<CatalogRelease['breadboardTopologies']>;
  };
  const graphResult = circuitGraphSchema.safeParse(input.graph);
  if (!graphResult.success) throw new Error('The circuit graph is invalid.');
  const graph: CircuitGraph = graphResult.data;
  const graphValidation = validateCircuitGraph(graph, {
    release: catalog,
  });
  const catalogDigest = digest(catalog);
  const graphDigest = digest(graph);
  const findings: ValidationFinding[] = [];

  if (!graphValidation.valid) {
    findings.push(
      makeFinding(
        'GRAPH_INTEGRITY',
        'fail',
        'error',
        graphValidation.issues.map((issue) => `${issue.path}: ${issue.message}`).join(' '),
        [graph.id, ...graphValidation.issues.map((issue) => issue.path)],
      ),
    );
  } else {
    findings.push(
      makeFinding(
        'GRAPH_INTEGRITY',
        'pass',
        'info',
        'All graph references resolve against the pinned catalog release and declared breadboard topology.',
        [graph.id],
      ),
    );

    const parts = new Map(catalog.parts.map((part) => [part.id, part]));
    const nets = deriveNets(graph, {
      release: catalog,
    });
    const netForTerminal = new Map<string, string>();
    const terminalsByNet = new Map<
      string,
      Array<{ ref: TerminalRef; role: string; availableForScenario: boolean }>
    >();
    for (const net of nets) {
      for (const ref of net.terminalRefs) {
        netForTerminal.set(terminalKey(ref), net.id);
        const instance = graph.components.find(
          (candidate) => candidate.id === ref.componentInstanceId,
        );
        const part = instance ? parts.get(instance.catalogPartId) : undefined;
        const role = part?.terminals.find(
          (terminal) => terminal.id === ref.catalogTerminalId,
        )?.electricalRole;
        const availableForScenario =
          part?.category !== 'development-board' ||
          part.pins.find((pin) => pin.terminalId === ref.catalogTerminalId)
            ?.availableForScenario === true;
        const list = terminalsByNet.get(net.id) ?? [];
        list.push({ ref, role: role ?? 'unknown', availableForScenario });
        terminalsByNet.set(net.id, list);
      }
    }

    for (const net of nets) {
      const terminals = terminalsByNet.get(net.id) ?? [];
      const hasPower = terminals.some((terminal) => terminal.role === 'power');
      const grounds = terminals.filter((terminal) => terminal.role === 'ground');
      if (hasPower && grounds.length) {
        findings.push(
          makeFinding(
            'POWER_GROUND_SHORT',
            'fail',
            'error',
            'A modeled power terminal and ground terminal share the same conductive net.',
            terminals.map(({ ref }) => ref.componentInstanceId),
            terminals.flatMap(({ ref }) => {
              const instance = graph.components.find(
                (candidate) => candidate.id === ref.componentInstanceId,
              );
              return partSources(instance ? parts.get(instance.catalogPartId) : undefined);
            }),
          ),
        );
      }
    }
    if (!findings.some((finding) => finding.ruleId === 'POWER_GROUND_SHORT')) {
      findings.push(
        makeFinding(
          'POWER_GROUND_SHORT',
          'pass',
          'info',
          'No net joins a catalog-modeled power terminal directly to a catalog-modeled ground terminal.',
          [graph.id],
        ),
      );
    }

    const electricalEdges: ElectricalEdge[] = [];
    for (const instance of graph.components) {
      const part = parts.get(instance.catalogPartId);
      if (!part || part.category === 'development-board') continue;
      const terminalA =
        part.category === 'led'
          ? part.terminals.find((terminal) => terminal.id === part.anodeTerminalId)
          : part.terminals[0];
      const terminalB =
        part.category === 'led'
          ? part.terminals.find((terminal) => terminal.id === part.cathodeTerminalId)
          : part.terminals[1];
      if (!terminalA || !terminalB) continue;
      const a = netForTerminal.get(
        terminalKey({ componentInstanceId: instance.id, catalogTerminalId: terminalA.id }),
      );
      const b = netForTerminal.get(
        terminalKey({ componentInstanceId: instance.id, catalogTerminalId: terminalB.id }),
      );
      if (!a || !b || a === b) continue;
      if (part.category === 'resistor')
        electricalEdges.push({ from: a, to: b, kind: 'resistor', entityId: instance.id });
      if (part.category === 'led')
        electricalEdges.push({ from: a, to: b, kind: 'led', entityId: instance.id });
    }

    const leds = graph.components.flatMap((instance) => {
      const part = parts.get(instance.catalogPartId);
      if (!part || part.category !== 'led') return [];
      const anode = netForTerminal.get(
        terminalKey({ componentInstanceId: instance.id, catalogTerminalId: part.anodeTerminalId }),
      );
      const cathode = netForTerminal.get(
        terminalKey({
          componentInstanceId: instance.id,
          catalogTerminalId: part.cathodeTerminalId,
        }),
      );
      if (!anode || !cathode) return [];
      return [{ instance, part, anode, cathode }];
    });

    const sourceNets = nets.flatMap((net) => {
      const terminals = terminalsByNet.get(net.id) ?? [];
      return terminals.some(
        ({ role, availableForScenario }) =>
          availableForScenario && (role === 'power' || role === 'gpio'),
      )
        ? [net.id]
        : [];
    });
    const groundNets = nets.flatMap((net) =>
      (terminalsByNet.get(net.id) ?? []).some(({ role }) => role === 'ground') ? [net.id] : [],
    );

    for (const { instance, part, anode, cathode } of leds) {
      const anodeGrounded = hasResistorPath([anode], groundNets, electricalEdges);
      const cathodeGrounded = hasResistorPath([cathode], groundNets, electricalEdges);
      const sourceAtAnode = hasResistorPath(sourceNets, [anode], electricalEdges);
      const sourceAtCathode = hasResistorPath(sourceNets, [cathode], electricalEdges);
      const reversed = sourceAtCathode && anodeGrounded;
      const shorted = anode === cathode;
      const correctlyPolarized = sourceAtAnode && cathodeGrounded;
      findings.push(
        makeFinding(
          'LED_POLARITY',
          shorted || reversed ? 'fail' : correctlyPolarized ? 'pass' : 'unknown',
          shorted || reversed ? 'error' : correctlyPolarized ? 'info' : 'warning',
          shorted
            ? 'The LED anode and cathode are connected to the same modeled net.'
            : reversed
              ? 'The LED anode is connected to ground while its cathode is connected to a modeled source.'
              : correctlyPolarized
                ? 'The LED is oriented from a modeled source toward ground.'
                : 'LED polarity cannot be resolved because the graph does not identify both a source side and a ground return.',
          [instance.id],
          part.sourceIds,
        ),
      );

      if (sourceNets.length && groundNets.length) {
        const path = pathWithLedAndResistor(sourceNets, groundNets, instance.id, electricalEdges);
        findings.push(
          makeFinding(
            'LED_SERIES_RESISTOR',
            path.withoutResistor ? 'fail' : path.withResistor ? 'pass' : 'unknown',
            path.withoutResistor ? 'error' : path.withResistor ? 'info' : 'warning',
            path.withoutResistor
              ? 'At least one conductive source-to-ground path through the LED bypasses every modeled series resistor.'
              : path.withResistor
                ? 'Every modeled conductive source-to-ground path through the LED contains a modeled resistor.'
                : 'The graph does not establish a complete source-to-ground path through this LED.',
            [
              instance.id,
              ...electricalEdges
                .filter((edge) => edge.kind === 'resistor')
                .map((edge) => edge.entityId),
            ],
            part.sourceIds,
          ),
        );
      } else {
        findings.push(
          makeFinding(
            'LED_SERIES_RESISTOR',
            'unknown',
            'warning',
            'A source-to-ground path cannot be established from the modeled terminals.',
            [instance.id],
            part.sourceIds,
          ),
        );
      }
    }

    if (leds.length === 0) {
      findings.push(
        makeFinding(
          'LED_POLARITY',
          'not_applicable',
          'info',
          'No supported LED instance is present in this graph.',
          [graph.id],
        ),
      );
    }
  }

  findings.push(
    makeFinding(
      'ELECTRICAL_SCOPE_LIMIT',
      'unknown',
      'warning',
      'This ruleset checks only explicitly modeled connectivity, selected shorts, LED polarity, and a series resistor. GPIO current budgets, analog behavior, thermal margins, transient conditions, component authenticity, wiring quality, and unmodeled parts remain unverified.',
      [graph.id],
      catalog.sources.map((source) => source.id),
    ),
  );
  findings.sort(
    (left, right) => left.ruleId.localeCompare(right.ruleId) || left.id.localeCompare(right.id),
  );
  return validationReportSchema.parse({
    schemaVersion: 1,
    projectId: graph.projectId,
    projectRevision: graph.projectRevision,
    graphId: graph.id,
    graphDigest,
    catalogReleaseId: catalog.releaseId,
    catalogDigest,
    rulesetId: RULESET_ID,
    rulesetVersion: RULESET_VERSION,
    validatorVersion: VALIDATOR_VERSION,
    status: overallStatus(findings),
    findings,
  });
}
