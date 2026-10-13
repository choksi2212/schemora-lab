import { describe, expect, it } from 'vitest';
import { getCatalogRelease } from '@schemora/catalog';
import { validateCircuit } from '@schemora/validation';
import { canonicalDigest, generateAssemblyPlan } from '../src/index.js';

const catalog = getCatalogRelease();
const graph = {
  schemaVersion: 1 as const,
  id: 'assembly_graph_1',
  projectId: 'assembly_project_1',
  projectRevision: 4,
  catalogReleaseId: catalog.releaseId,
  components: [
    { id: 'board_1', catalogPartId: 'board.espressif.esp32-devkitc-v4.wroom-32e.male' },
    { id: 'resistor_1', catalogPartId: 'resistor.yageo.cfr-25jb-52-220r' },
  ],
  breadboards: [],
  terminalPlacements: [],
  wires: [
    {
      id: 'wire_1',
      source: {
        kind: 'terminal' as const,
        terminal: { componentInstanceId: 'board_1', catalogTerminalId: 'gpio19' },
      },
      target: {
        kind: 'terminal' as const,
        terminal: { componentInstanceId: 'resistor_1', catalogTerminalId: 'lead-a' },
      },
    },
  ],
};
const report = validateCircuit({ graph, catalog });
const generate = (input: { graph?: unknown; report?: unknown; reportIsCurrent?: boolean } = {}) => {
  const sourceReport = input.report ?? report;
  return generateAssemblyPlan({
    graph: input.graph ?? graph,
    catalog,
    report: sourceReport,
    reportIsCurrent: input.reportIsCurrent ?? true,
    validationReportId: 'validation_report_1',
    validationReportDigest: canonicalDigest(sourceReport),
  });
};

describe('deterministic assembly planner', () => {
  it('creates a repeatable dependency-ordered procedure from exact graph endpoints', () => {
    const first = generate();
    const second = generate();
    expect(second).toEqual(first);
    expect(first.steps.map((step) => step.order)).toEqual(first.steps.map((_, index) => index + 1));
    const wire = first.steps.find((step) => step.action === 'connect_wire')!;
    expect(wire.instruction).toContain('GPIO19');
    expect(wire.instruction).toContain('Lead A');
    expect(wire.prerequisites).toHaveLength(2);
    expect(first.steps.at(-1)?.action).toBe('pre_power_checklist');
    expect(first.planDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('requires a current report whose complete input identity matches the saved graph', () => {
    expect(() => generate({ graph: { ...graph, id: 'changed' } })).toThrow(
      /current validation report/,
    );
    expect(() => generate({ reportIsCurrent: false })).toThrow(/current validation report/);
  });

  it('blocks failing findings while retaining unknown scope warnings for user review', () => {
    const blocked = {
      ...report,
      findings: report.findings.map((finding) =>
        finding.ruleId === 'GRAPH_INTEGRITY' ? { ...finding, status: 'fail' as const } : finding,
      ),
    };
    expect(() => generate({ report: blocked })).toThrow(/Graph integrity/);
    const plan = generate();
    expect(plan.warnings.some((warning) => warning.includes('remain unverified'))).toBe(true);
  });
});
