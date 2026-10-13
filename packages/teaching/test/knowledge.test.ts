import { describe, expect, it } from 'vitest';
import { getCatalogRelease } from '@schemora/catalog';
import { validateCircuit } from '@schemora/validation';
import { generateAssemblyPlan, canonicalDigest } from '@schemora/assembly-plan';
import { explainAssemblyStep, listTeachingLessons, validateTeachingContent } from '../src/index.js';

const catalog = getCatalogRelease();
const graph = {
  schemaVersion: 1 as const,
  id: 'teaching_graph_1',
  projectId: 'teaching_project_1',
  projectRevision: 2,
  catalogReleaseId: catalog.releaseId,
  components: [
    { id: 'board_1', catalogPartId: 'board.espressif.esp32-devkitc-v4.wroom-32e.male' },
    { id: 'resistor_1', catalogPartId: 'resistor.yageo.cfr-25jb-52-220r' },
    { id: 'led_1', catalogPartId: 'led.kingbright.wp7113id' },
  ],
  breadboards: [
    {
      id: 'breadboard_1',
      topologyId: 'breadboard.busboard.bb400',
      topologyVersion: 1,
      railVariants: catalog.breadboardTopologies[0]!.railGroups.map((rail) => ({
        railGroupId: rail.id,
        variantId: rail.connectivityVariants[0]!.id,
      })),
    },
  ],
  terminalPlacements: [],
  wires: [
    {
      id: 'wire_gpio',
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
      id: 'wire_led',
      source: {
        kind: 'terminal' as const,
        terminal: { componentInstanceId: 'resistor_1', catalogTerminalId: 'lead-b' },
      },
      target: {
        kind: 'terminal' as const,
        terminal: { componentInstanceId: 'led_1', catalogTerminalId: 'anode' },
      },
    },
  ],
};
const report = validateCircuit({ graph, catalog });
const plan = generateAssemblyPlan({
  graph,
  catalog,
  report,
  reportIsCurrent: true,
  validationReportId: 'validation_1',
  validationReportDigest: canonicalDigest(report),
});

describe('curated beginner teaching engine', () => {
  it('validates every source, exact part and catalog claim against the selected release', () => {
    expect(() => validateTeachingContent(catalog)).not.toThrow();
    for (const lesson of listTeachingLessons()) {
      expect(lesson.levels.quick).toBeTruthy();
      expect(lesson.levels.beginner).toBeTruthy();
      expect(lesson.levels.detailed).toBeTruthy();
    }
  });

  it('provides deterministic lessons and sources for only the active step context', async () => {
    const step = plan.steps.find(
      (item) => item.action === 'connect_wire' && item.componentIds.includes('board_1'),
    )!;
    const input = {
      step,
      graph,
      catalog,
      report,
      level: 'detailed' as const,
      expectedGraphDigest: plan.graphDigest,
    };
    const explanation = await explainAssemblyStep(input);
    expect(await explainAssemblyStep(input)).toEqual(explanation);
    expect(explanation.lessons.some((lesson) => lesson.id === 'gpio-signal')).toBe(true);
    expect(
      explanation.lessons.find((lesson) => lesson.id === 'gpio-signal')?.sources[0]?.locator,
    ).toContain('Header Block J2 and J3');
    expect(explanation.lessons.some((lesson) => lesson.id === 'restricted-pins')).toBe(false);
  });

  it('shows only exact-model LED facts when the exact LED is part of the step graph', async () => {
    const step = plan.steps.find(
      (item) => item.action === 'connect_wire' && item.componentIds.includes('led_1'),
    )!;
    const explanation = await explainAssemblyStep({
      step,
      graph,
      catalog,
      report,
      level: 'detailed',
      expectedGraphDigest: plan.graphDigest,
    });
    expect(explanation.lessons.some((lesson) => lesson.id === 'led-polarity')).toBe(true);
    expect(explanation.lessons.some((lesson) => lesson.id === 'led-series-resistor')).toBe(true);
    expect(explanation.lessons.find((lesson) => lesson.id === 'led-polarity')?.text).toContain(
      'test current',
    );
  });

  it('fails closed for mismatched graph and report identity and explains common checks deterministically', async () => {
    const step = plan.steps.find((item) => item.action === 'review_checks')!;
    await expect(
      explainAssemblyStep({
        step,
        graph: { ...graph, id: 'different_graph' },
        catalog,
        report,
        level: 'beginner',
        expectedGraphDigest: plan.graphDigest,
      }),
    ).rejects.toThrow(/same current graph/);
    await expect(
      explainAssemblyStep({
        step,
        graph,
        catalog,
        report,
        level: 'beginner',
        expectedGraphDigest: '0'.repeat(64),
      }),
    ).rejects.toThrow(/same current graph/);
    await expect(
      explainAssemblyStep({
        step,
        graph: { ...graph, wires: graph.wires.slice(0, 1) },
        catalog,
        report,
        level: 'beginner',
        expectedGraphDigest: plan.graphDigest,
      }),
    ).rejects.toThrow(/graph contents do not match/);
    const explanation = await explainAssemblyStep({
      step,
      graph,
      catalog,
      report,
      level: 'beginner',
      expectedGraphDigest: plan.graphDigest,
    });
    expect(
      explanation.findings.some(
        (finding) => finding.ruleId === 'GRAPH_INTEGRITY' && finding.status === 'pass',
      ),
    ).toBe(true);
    expect(
      explanation.findings.some(
        (finding) =>
          finding.ruleId === 'ELECTRICAL_SCOPE_LIMIT' &&
          finding.explanation.includes('remain unverified'),
      ),
    ).toBe(true);
  });
});
