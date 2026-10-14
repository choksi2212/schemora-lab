import type { CatalogRelease } from '@schemora/catalog';
import type { CircuitGraph } from '@schemora/circuit-model';

export type ExportProject = {
  id: string;
  title: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

export type ExportValidation = {
  rulesetId: string;
  rulesetVersion: string;
  validatorVersion: string;
  findings: { ruleId: string; status: string; severity: string; message: string }[];
};

export function buildProjectSpecification(input: {
  project: ExportProject;
  graph: CircuitGraph | null;
  graphDigest: string | null;
  catalog: CatalogRelease | null;
  catalogDigest: string | null;
  validation: ExportValidation | null;
  validationDigest: string | null;
}) {
  return {
    format: 'schemora-project-specification',
    schemaVersion: 1,
    project: input.project,
    circuit: input.graph
      ? {
          graph: input.graph,
          catalogReleaseId: input.graph.catalogReleaseId,
          catalogParts: input.graph.components.map((component) => {
            const part = input.catalog?.parts.find(
              (candidate) => candidate.id === component.catalogPartId,
            );
            return {
              instanceId: component.id,
              partId: component.catalogPartId,
              manufacturer: part?.manufacturer ?? null,
              model: part?.model ?? null,
              terminals: part?.terminals ?? [],
            };
          }),
          breadboardTopologies: input.graph.breadboards.map((board) => {
            const topology = input.catalog?.breadboardTopologies.find(
              (candidate) => candidate.id === board.topologyId,
            );
            return {
              instanceId: board.id,
              topologyId: board.topologyId,
              name: topology?.name ?? null,
            };
          }),
        }
      : null,
    validation: input.validation,
    integrity: {
      circuitGraphSha256: input.graphDigest,
      catalogReleaseSha256: input.catalogDigest,
      validationReportSha256: input.validationDigest,
    },
    includedData: [
      'project metadata',
      'saved circuit graph',
      'catalog identities',
      'validation summary',
    ],
    excludedPrivateData: [
      'conversation source bytes and transcripts',
      'firmware source and build artifacts',
      'hardware photo bytes',
      'provider credentials and private storage keys',
      'simulation execution output',
    ],
    limitations: [
      'A validation finding is not an electrical safety certification.',
      'Illustrative component geometry does not establish physical fit.',
      'Only the exact catalog release referenced by the graph defines its part identities.',
    ],
  };
}

function markdownCell(value: string) {
  return value.replace(/[\\`*_{}\[\]()#+.!|>~-]/g, '\\$&').replace(/[\r\n]+/g, ' ');
}

function endpointLabel(
  endpoint: CircuitGraph['wires'][number]['source'],
  graph: CircuitGraph,
  catalog: CatalogRelease,
) {
  if (endpoint.kind === 'hole') {
    const board = graph.breadboards.find(
      (candidate) => candidate.id === endpoint.hole.breadboardInstanceId,
    );
    const topology =
      board && catalog.breadboardTopologies.find((candidate) => candidate.id === board.topologyId);
    return `${topology?.name ?? endpoint.hole.breadboardInstanceId} hole ${endpoint.hole.holeId}`;
  }
  const component = graph.components.find(
    (candidate) => candidate.id === endpoint.terminal.componentInstanceId,
  );
  const part =
    component && catalog.parts.find((candidate) => candidate.id === component.catalogPartId);
  const terminal = part?.terminals.find(
    (candidate) => candidate.id === endpoint.terminal.catalogTerminalId,
  );
  return `${part?.model ?? endpoint.terminal.componentInstanceId} ${terminal?.label ?? endpoint.terminal.catalogTerminalId}`;
}

export function buildWiringChecklist(input: {
  project: ExportProject;
  graph: CircuitGraph | null;
  catalog: CatalogRelease | null;
}) {
  const lines = [
    `# Wiring checklist — ${markdownCell(input.project.title)}`,
    '',
    `Project revision: ${input.project.revision}`,
    `Project ID: ${input.project.id}`,
    '',
    '> This checklist reflects the saved graph. Confirm each connection against the exact part documentation before powering hardware.',
    '',
  ];
  if (!input.graph || !input.catalog) {
    lines.push('No saved circuit graph is available for this project.', '');
    return lines.join('\n');
  }
  lines.push(`Catalog release: ${input.graph.catalogReleaseId}`, '', '## Components', '');
  if (input.graph.components.length === 0) lines.push('- No components in the saved graph.');
  for (const component of input.graph.components) {
    const part = input.catalog.parts.find((candidate) => candidate.id === component.catalogPartId);
    lines.push(
      `- [ ] ${markdownCell(part ? `${part.manufacturer} ${part.model}` : component.catalogPartId)} (instance \`${markdownCell(component.id)}\`)`,
    );
  }
  lines.push('', '## Connections', '', '| Check | From | To |', '| --- | --- | --- |');
  const connections = [
    ...input.graph.terminalPlacements.map((placement) => ({
      source: { kind: 'terminal' as const, terminal: placement.terminal },
      target: { kind: 'hole' as const, hole: placement.hole },
    })),
    ...input.graph.wires.map((wire) => ({ source: wire.source, target: wire.target })),
  ];
  if (connections.length === 0) lines.push('| — | No saved connections | — |');
  for (const connection of connections) {
    lines.push(
      `| [ ] | ${markdownCell(endpointLabel(connection.source, input.graph, input.catalog))} | ${markdownCell(endpointLabel(connection.target, input.graph, input.catalog))} |`,
    );
  }
  lines.push(
    '',
    '## Limitations',
    '',
    '- This list does not verify electrical ratings, wire quality, physical fit, or safe operation.',
  );
  return lines.join('\n');
}
