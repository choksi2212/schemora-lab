import { createHash } from 'node:crypto';
import { circuitGraphSchema, type CircuitGraph, type WireEndpoint } from '@schemora/circuit-model';
import { catalogReleaseSchema, type CatalogPart, type CatalogRelease } from '@schemora/catalog';
import { validationReportSchema } from '@schemora/validation';
import { z } from 'zod';

export const ASSEMBLY_PLANNER_ID = 'schemora-deterministic-assembly';
export const ASSEMBLY_PLANNER_VERSION = '0.1.0';

const componentAnchor = z
  .object({ kind: z.literal('component'), componentInstanceId: z.string().min(1) })
  .strict();
const terminalAnchor = z
  .object({
    kind: z.literal('terminal'),
    componentInstanceId: z.string().min(1),
    catalogTerminalId: z.string().min(1),
  })
  .strict();
const holeAnchor = z
  .object({
    kind: z.literal('hole'),
    breadboardInstanceId: z.string().min(1),
    holeId: z.string().min(1),
  })
  .strict();
const anchorSchema = z.discriminatedUnion('kind', [componentAnchor, terminalAnchor, holeAnchor]);
const predicateSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user_confirmation') }).strict(),
  z
    .object({ kind: z.literal('terminal_at_hole'), terminal: terminalAnchor, hole: holeAnchor })
    .strict(),
  z.object({ kind: z.literal('wire_present'), wireId: z.string().min(1) }).strict(),
  z
    .object({ kind: z.literal('validation_current'), requiredRuleIds: z.array(z.string()) })
    .strict(),
]);

export const assemblyStepSchema = z
  .object({
    id: z.string().min(1),
    order: z.number().int().positive(),
    action: z.enum([
      'identify_component',
      'place_terminal',
      'connect_wire',
      'review_checks',
      'pre_power_checklist',
    ]),
    title: z.string().min(1),
    instruction: z.string().min(1),
    explanation: z.string().min(1),
    componentIds: z.array(z.string()),
    anchors: z.array(anchorSchema),
    prerequisites: z.array(z.string()),
    cameraTarget: anchorSchema.nullable(),
    highlightTargets: z.array(anchorSchema),
    completion: predicateSchema,
    requiredValidationRuleIds: z.array(z.string()),
    warnings: z.array(z.string()),
    animationKey: z.string().nullable(),
  })
  .strict();

export const assemblyPlanSchema = z
  .object({
    schemaVersion: z.literal(1),
    plannerId: z.literal(ASSEMBLY_PLANNER_ID),
    plannerVersion: z.literal(ASSEMBLY_PLANNER_VERSION),
    projectId: z.string().min(1),
    projectRevision: z.number().int().positive(),
    graphId: z.string().min(1),
    graphDigest: z.string().regex(/^[a-f0-9]{64}$/),
    catalogReleaseId: z.string().min(1),
    catalogDigest: z.string().regex(/^[a-f0-9]{64}$/),
    validationReportId: z.string().min(1),
    validationReportDigest: z.string().regex(/^[a-f0-9]{64}$/),
    validationGraphDigest: z.string().regex(/^[a-f0-9]{64}$/),
    rulesetId: z.string().min(1),
    rulesetVersion: z.string().min(1),
    validatorVersion: z.string().min(1),
    assemblyRulesVersion: z.literal('1.0.0'),
    warnings: z.array(z.string()),
    steps: z.array(assemblyStepSchema).min(1).max(20_000),
    planDigest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export type AssemblyStep = z.infer<typeof assemblyStepSchema>;
export type AssemblyPlan = z.infer<typeof assemblyPlanSchema>;
export class AssemblyPlanBlockedError extends Error {
  constructor(
    public readonly reason: 'VALIDATION_REQUIRED' | 'CHECKS_FAILED',
    message: string,
  ) {
    super(message);
    this.name = 'AssemblyPlanBlockedError';
  }
}

export function canonicalDigest(value: unknown): string {
  const canonical = (item: unknown): string => {
    if (item === null || typeof item !== 'object') return JSON.stringify(item);
    if (Array.isArray(item)) return `[${item.map(canonical).join(',')}]`;
    const record = item as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(',')}}`;
  };
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function stableStepId(action: AssemblyStep['action'], entityId: string) {
  return `${action}:${createHash('sha256').update(entityId).digest('hex').slice(0, 16)}`;
}

function endpointAnchor(endpoint: WireEndpoint) {
  return endpoint.kind === 'terminal'
    ? { kind: 'terminal' as const, ...endpoint.terminal }
    : { kind: 'hole' as const, ...endpoint.hole };
}

function endpointName(
  endpoint: WireEndpoint,
  graph: CircuitGraph,
  parts: Map<string, CatalogPart>,
) {
  if (endpoint.kind === 'hole')
    return `breadboard ${endpoint.hole.breadboardInstanceId}, hole ${endpoint.hole.holeId}`;
  const component = graph.components.find(
    (item) => item.id === endpoint.terminal.componentInstanceId,
  );
  const part = component ? parts.get(component.catalogPartId) : undefined;
  const terminal = part?.terminals.find((item) => item.id === endpoint.terminal.catalogTerminalId);
  return `${part?.model ?? component?.catalogPartId ?? endpoint.terminal.componentInstanceId}, ${terminal?.label ?? endpoint.terminal.catalogTerminalId}`;
}

export function generateAssemblyPlan(input: {
  graph: unknown;
  catalog: unknown;
  report: unknown;
  reportIsCurrent: boolean;
  validationReportId: string;
  validationReportDigest: string;
}): AssemblyPlan {
  const graph = circuitGraphSchema.parse(input.graph);
  const catalog = catalogReleaseSchema.parse(input.catalog) as CatalogRelease;
  const report = validationReportSchema.parse(input.report);
  const graphDigest = canonicalDigest(graph);
  if (
    !input.reportIsCurrent ||
    report.projectId !== graph.projectId ||
    report.projectRevision !== graph.projectRevision ||
    report.graphId !== graph.id ||
    report.graphDigest !== graphDigest ||
    report.catalogReleaseId !== catalog.releaseId ||
    input.validationReportDigest !== canonicalDigest(report)
  )
    throw new AssemblyPlanBlockedError(
      'VALIDATION_REQUIRED',
      'A current validation report for this exact saved graph is required.',
    );
  if (catalog.releaseId !== graph.catalogReleaseId)
    throw new AssemblyPlanBlockedError(
      'VALIDATION_REQUIRED',
      'The circuit and catalog release do not match.',
    );
  if (
    report.findings.some(
      (finding) => finding.ruleId === 'GRAPH_INTEGRITY' && finding.status !== 'pass',
    )
  )
    throw new AssemblyPlanBlockedError(
      'CHECKS_FAILED',
      'Graph integrity must pass before an assembly plan can be generated.',
    );
  if (report.findings.some((finding) => finding.status === 'fail' || finding.status === 'error'))
    throw new AssemblyPlanBlockedError(
      'CHECKS_FAILED',
      'Resolve failing circuit checks before generating an assembly plan.',
    );

  const parts = new Map(catalog.parts.map((part) => [part.id, part]));
  const componentSteps = new Map<string, string>();
  const steps: AssemblyStep[] = [];
  const board = graph.components
    .filter((component) => parts.get(component.catalogPartId)?.category === 'development-board')
    .sort((a, b) => a.id.localeCompare(b.id));
  const otherComponents = graph.components
    .filter((component) => parts.get(component.catalogPartId)?.category !== 'development-board')
    .sort((a, b) => a.id.localeCompare(b.id));
  for (const component of [...board, ...otherComponents]) {
    const part = parts.get(component.catalogPartId);
    const id = stableStepId('identify_component', component.id);
    componentSteps.set(component.id, id);
    steps.push({
      id,
      order: 0,
      action: 'identify_component',
      title: `Identify ${part?.model ?? component.catalogPartId}`,
      instruction: `Confirm the physical item is ${part?.manufacturer ?? 'the catalog'} ${part?.model ?? component.catalogPartId} before using the pin names in later steps.`,
      explanation:
        'The pin labels and physical arrangement depend on the exact catalog configuration.',
      componentIds: [component.id],
      anchors: [{ kind: 'component', componentInstanceId: component.id }],
      prerequisites: [],
      cameraTarget: null,
      highlightTargets: [],
      completion: { kind: 'user_confirmation' },
      requiredValidationRuleIds: ['GRAPH_INTEGRITY'],
      warnings: part?.limitations ?? [],
      animationKey: null,
    });
  }

  const placementSteps = new Map<string, string>();
  for (const placement of [...graph.terminalPlacements].sort((a, b) =>
    `${a.terminal.componentInstanceId}/${a.terminal.catalogTerminalId}`.localeCompare(
      `${b.terminal.componentInstanceId}/${b.terminal.catalogTerminalId}`,
    ),
  )) {
    const terminalKey = `${placement.terminal.componentInstanceId}/${placement.terminal.catalogTerminalId}`;
    const id = stableStepId('place_terminal', terminalKey);
    placementSteps.set(terminalKey, id);
    const anchor = { kind: 'terminal' as const, ...placement.terminal };
    const hole = { kind: 'hole' as const, ...placement.hole };
    steps.push({
      id,
      order: 0,
      action: 'place_terminal',
      title: `Place terminal at ${placement.hole.holeId}`,
      instruction: `Place ${endpointName({ kind: 'terminal', terminal: placement.terminal }, graph, parts)} at ${placement.hole.holeId} on breadboard ${placement.hole.breadboardInstanceId}.`,
      explanation:
        'This location comes from the saved graph. Confirm that the physical board orientation and printed hole label match before inserting the lead.',
      componentIds: [placement.terminal.componentInstanceId],
      anchors: [anchor, hole],
      prerequisites: [componentSteps.get(placement.terminal.componentInstanceId)!],
      cameraTarget: hole,
      highlightTargets: [anchor, hole],
      completion: { kind: 'terminal_at_hole', terminal: anchor, hole },
      requiredValidationRuleIds: ['GRAPH_INTEGRITY'],
      warnings: [],
      animationKey: 'terminal-placement',
    });
  }

  for (const wire of [...graph.wires].sort((a, b) => a.id.localeCompare(b.id))) {
    const source = endpointAnchor(wire.source);
    const target = endpointAnchor(wire.target);
    const id = stableStepId('connect_wire', wire.id);
    const endpointPrerequisites = [wire.source, wire.target].flatMap((endpoint) =>
      endpoint.kind === 'terminal'
        ? [
            componentSteps.get(endpoint.terminal.componentInstanceId)!,
            ...(placementSteps.has(
              `${endpoint.terminal.componentInstanceId}/${endpoint.terminal.catalogTerminalId}`,
            )
              ? [
                  placementSteps.get(
                    `${endpoint.terminal.componentInstanceId}/${endpoint.terminal.catalogTerminalId}`,
                  )!,
                ]
              : []),
          ]
        : [],
    );
    steps.push({
      id,
      order: 0,
      action: 'connect_wire',
      title: `Connect ${endpointName(wire.source, graph, parts)} to ${endpointName(wire.target, graph, parts)}`,
      instruction: `Connect the exact endpoints shown: ${endpointName(wire.source, graph, parts)} → ${endpointName(wire.target, graph, parts)}.`,
      explanation:
        'Follow the saved graph endpoints and verify both labels. This instruction does not establish physical safety or fit.',
      componentIds: [
        ...new Set(
          [wire.source, wire.target].flatMap((endpoint) =>
            endpoint.kind === 'terminal' ? [endpoint.terminal.componentInstanceId] : [],
          ),
        ),
      ].sort(),
      anchors: [source, target],
      prerequisites: [...new Set(endpointPrerequisites)].sort(),
      cameraTarget: source,
      highlightTargets: [source, target],
      completion: { kind: 'wire_present', wireId: wire.id },
      requiredValidationRuleIds: ['GRAPH_INTEGRITY'],
      warnings: [],
      animationKey: 'wire-connection',
    });
  }

  const constructionIds = steps.map((step) => step.id);
  const checksId = stableStepId('review_checks', graph.id);
  steps.push({
    id: checksId,
    order: 0,
    action: 'review_checks',
    title: 'Review the current circuit checks',
    instruction:
      'Read each current finding, including warnings and unknown results, before continuing.',
    explanation: 'An unknown result means this catalog or ruleset cannot establish that behavior.',
    componentIds: graph.components.map((component) => component.id).sort(),
    anchors: [],
    prerequisites: constructionIds,
    cameraTarget: null,
    highlightTargets: [],
    completion: { kind: 'validation_current', requiredRuleIds: ['GRAPH_INTEGRITY'] },
    requiredValidationRuleIds: ['GRAPH_INTEGRITY'],
    warnings: report.findings
      .filter((finding) => finding.status === 'unknown' || finding.severity === 'warning')
      .map((finding) => finding.message),
    animationKey: null,
  });
  steps.push({
    id: stableStepId('pre_power_checklist', graph.id),
    order: 0,
    action: 'pre_power_checklist',
    title: 'Pre-power inspection',
    instruction:
      'Keep power disconnected while checking the exact board, polarity, and every connection against the saved design.',
    explanation:
      'Confirm each item only after you inspect the physical hardware. A completed checklist is not a safety certification.',
    componentIds: graph.components.map((component) => component.id).sort(),
    anchors: [],
    prerequisites: [checksId],
    cameraTarget: null,
    highlightTargets: [],
    completion: { kind: 'user_confirmation' },
    requiredValidationRuleIds: ['GRAPH_INTEGRITY'],
    warnings: [
      'This plan does not verify real hardware identity, electrical limits, wiring quality, or safe operation.',
    ],
    animationKey: null,
  });

  const index = new Map(steps.map((step, i) => [step.id, i]));
  const ordered: AssemblyStep[] = [];
  const remaining = new Set(steps.map((step) => step.id));
  while (remaining.size) {
    const ready = [...remaining]
      .filter((id) =>
        steps[index.get(id)!]!.prerequisites.every((prerequisite) => !remaining.has(prerequisite)),
      )
      .sort();
    if (!ready.length) throw new Error('Assembly dependencies contain a cycle.');
    for (const id of ready) {
      remaining.delete(id);
      ordered.push({ ...steps[index.get(id)!]!, order: ordered.length + 1 });
    }
  }
  const warnings = report.findings
    .filter((finding) => finding.status === 'unknown' || finding.severity === 'warning')
    .map((finding) => finding.message);
  if (report.findings.some((finding) => finding.status === 'unknown')) {
    warnings.push(
      'One or more modeled behaviors remain unverified; review the unknown validation findings before assembly.',
    );
  }
  const withoutDigest = {
    schemaVersion: 1 as const,
    plannerId: ASSEMBLY_PLANNER_ID,
    plannerVersion: ASSEMBLY_PLANNER_VERSION,
    projectId: graph.projectId,
    projectRevision: graph.projectRevision,
    graphId: graph.id,
    graphDigest,
    catalogReleaseId: catalog.releaseId,
    catalogDigest: report.catalogDigest,
    validationReportId: input.validationReportId,
    validationReportDigest: input.validationReportDigest,
    validationGraphDigest: report.graphDigest,
    rulesetId: report.rulesetId,
    rulesetVersion: report.rulesetVersion,
    validatorVersion: report.validatorVersion,
    assemblyRulesVersion: '1.0.0' as const,
    warnings,
    steps: ordered,
  };
  return assemblyPlanSchema.parse({ ...withoutDigest, planDigest: canonicalDigest(withoutDigest) });
}
