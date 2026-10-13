import type { CatalogRelease } from '@schemora/catalog';
import type { CircuitGraph } from '@schemora/circuit-model';
import type { AssemblyStep } from '@schemora/assembly-plan';
import type { ValidationFinding, ValidationReport } from '@schemora/validation';
import { z } from 'zod';

export const TEACHING_CONTENT_VERSION = '2026.10.1';
export const explanationLevelSchema = z.enum(['quick', 'beginner', 'detailed']);
export type ExplanationLevel = z.infer<typeof explanationLevelSchema>;

const educationalSources = [
  {
    id: 'openstax-college-physics-ohms-law',
    title: 'OpenStax College Physics: Ohm’s Law—Resistance and Simple Circuits',
    url: 'https://openstax.org/books/college-physics/pages/20-2-ohms-law-resistance-and-simple-circuits',
    publisher: 'OpenStax',
  },
  {
    id: 'openstax-college-physics-glossary',
    title: 'OpenStax College Physics: Glossary',
    url: 'https://openstax.org/books/college-physics/pages/20-glossary',
    publisher: 'OpenStax',
  },
  {
    id: 'espressif-esp-idf-gpio',
    title: 'Espressif ESP-IDF Programming Guide: GPIO',
    url: 'https://docs.espressif.com/projects/esp-idf/en/stable/esp32/api-reference/peripherals/gpio.html',
    publisher: 'Espressif Systems',
  },
] as const;

const lessonSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    topics: z.array(z.string().min(1)).min(1),
    levels: z
      .object({
        quick: z.string().min(1),
        beginner: z.string().min(1),
        detailed: z.string().min(1),
      })
      .strict(),
    exactPartIds: z.array(z.string()),
    sourceIds: z.array(z.string().min(1)),
    sourceLocators: z.record(z.string(), z.string()).optional(),
    claims: z.array(
      z.object({ subjectId: z.string(), property: z.string(), sourceId: z.string() }).strict(),
    ),
    limitations: z.array(z.string()),
    ruleIds: z.array(z.string()),
  })
  .strict();

const lessons = lessonSchema.array().parse([
  {
    id: 'validation-basics',
    title: 'Reading circuit-check results',
    topics: ['validation', 'finding', 'check'],
    levels: {
      quick: 'Read the result state and affected item before moving on.',
      beginner:
        'A graph-integrity check verifies that the saved component, terminal, hole, and topology references resolve. A failed check points to a reference problem; a passing check does not prove electrical safety.',
      detailed:
        'The graph-integrity rule validates graph references against the pinned catalog release and declared breadboard topology. Findings remain limited to modeled references; electrical behavior outside other implemented rules is not inferred.',
    },
    exactPartIds: [],
    sourceIds: [],
    claims: [],
    limitations: ['A passing structural check is not an electrical or physical safety assessment.'],
    ruleIds: ['GRAPH_INTEGRITY'],
  },
  {
    id: 'gpio-signal',
    title: 'GPIO: a controllable signal pin',
    topics: ['gpio', 'pin', 'board-label'],
    levels: {
      quick: 'Use the exact GPIO label shown in this step.',
      beginner:
        'GPIO means general-purpose input/output. A GPIO pin is a controller connection that firmware can read or drive; the pin name identifies the physical connection.',
      detailed:
        'This project’s exact ESP32-DevKitC V4 with ESP32-WROOM-32E maps the selected GPIO19 signal to J3 position 8. The ESP32 module documentation defines electrical behavior and limits; this assembly guide does not establish the pin’s safe current for a particular load.',
    },
    exactPartIds: ['board.espressif.esp32-devkitc-v4.wroom-32e.male'],
    sourceIds: ['espressif-devkitc-v4-guide', 'openstax-college-physics-glossary'],
    claims: [
      {
        subjectId: 'board.espressif.esp32-devkitc-v4.wroom-32e.male',
        property: 'model/configuration/pin-functions/supply-options',
        sourceId: 'espressif-devkitc-v4-guide',
      },
    ],
    limitations: [
      'The pin mapping applies only to the exact cataloged board configuration; verify the physical board and printed label.',
    ],
    ruleIds: [],
  },
  {
    id: 'voltage-current',
    title: 'Voltage and current',
    topics: ['voltage', 'current', 'resistor'],
    levels: {
      quick:
        'Voltage is the electrical potential difference; current is charge moving through a path.',
      beginner:
        'Voltage describes a difference in electrical potential between two points. Current is the rate at which electric charge flows through a path.',
      detailed:
        'Current is charge flow per unit time (I = ΔQ/Δt). In a simple resistive circuit, Ohm’s law relates voltage, current, and resistance (V = IR); it is not a universal model for every component or operating condition.',
    },
    exactPartIds: [],
    sourceIds: ['openstax-college-physics-glossary', 'openstax-college-physics-ohms-law'],
    claims: [],
    limitations: [
      'This explanation is conceptual and does not calculate a safe operating point for the assembled circuit.',
    ],
    ruleIds: [],
  },
  {
    id: 'input-output',
    title: 'Input and output',
    topics: ['input', 'output', 'gpio'],
    levels: {
      quick:
        'Input reads a signal; output sends a signal. This graph does not identify firmware mode.',
      beginner:
        'A GPIO configured as an input reads a digital level from another device. A GPIO configured as an output sets a digital level for another device. The pin’s mode comes from firmware.',
      detailed:
        'Espressif documents GPIO input, output, and combined modes for ESP32. The current Schemora circuit graph contains wiring, but no firmware configuration, so it cannot determine how this project configures a pin.',
    },
    exactPartIds: ['board.espressif.esp32-devkitc-v4.wroom-32e.male'],
    sourceIds: ['espressif-esp-idf-gpio'],
    claims: [],
    limitations: [
      'No firmware is attached to this project graph; do not label the selected pin as configured input or output.',
    ],
    ruleIds: [],
  },
  {
    id: 'ground-reference',
    title: 'Ground as a circuit reference',
    topics: ['ground', 'return-path', 'wire'],
    levels: {
      quick: 'Connect to the exact GND terminal named in the step.',
      beginner:
        'In this circuit, ground is the shared reference and return connection used by the modeled circuit. A GND label does not, by itself, prove that a device is connected to building earth.',
      detailed:
        'The graph treats terminals cataloged with the ground role as connectivity endpoints. The validator can detect selected modeled connections, but it does not certify grounding, isolation, protection, or physical wiring quality.',
    },
    exactPartIds: [],
    sourceIds: ['openstax-college-physics-glossary'],
    claims: [],
    limitations: ['Do not interpret a circuit GND label as a mains protective-earth instruction.'],
    ruleIds: ['POWER_GROUND_SHORT'],
  },
  {
    id: 'led-polarity',
    title: 'LED polarity',
    topics: ['led', 'anode', 'cathode', 'polarity'],
    levels: {
      quick: 'Match the LED anode and cathode labels to the highlighted terminals.',
      beginner:
        'An LED has direction. Its anode and cathode are different terminals, so reversing which side faces the source can prevent the intended operation.',
      detailed:
        'For the cataloged Kingbright WP7113ID, the catalog identifies separate anode and cathode terminals and records the manufacturer’s forward-voltage values at a stated test current. Those values describe the specified test condition, not a complete design or safety guarantee.',
    },
    exactPartIds: ['led.kingbright.wp7113id'],
    sourceIds: ['kingbright-wp7113id-datasheet'],
    claims: [
      {
        subjectId: 'led.kingbright.wp7113id',
        property:
          'model/package/color/forwardVoltage/maximumDcForwardCurrentMilliamp/powerDissipationMilliwatt',
        sourceId: 'kingbright-wp7113id-datasheet',
      },
    ],
    limitations: [
      'The modeled polarity check does not simulate light output, temperature, transients, or physical orientation.',
    ],
    ruleIds: ['LED_POLARITY'],
  },
  {
    id: 'led-series-resistor',
    title: 'Why the LED path includes a resistor',
    topics: ['resistor', 'led', 'current', 'series'],
    levels: {
      quick: 'Keep the resistor in the highlighted LED path.',
      beginner:
        'A resistor in series with an LED helps limit current in a simple circuit. The resistor must be selected for the actual supply, LED, and design conditions.',
      detailed:
        'The starter graph uses the exact YAGEO CFR-25JB-52-220R part (220 Ω, ±5%) in series with the LED. Ohm’s law can estimate current for a simple resistive model, but this package does not prove current, power, GPIO loading, or thermal margin for the physical setup.',
    },
    exactPartIds: ['resistor.yageo.cfr-25jb-52-220r'],
    sourceIds: ['yageo-cfr-exact-part', 'yageo-cfr-datasheet', 'openstax-college-physics-ohms-law'],
    claims: [
      {
        subjectId: 'resistor.yageo.cfr-25jb-52-220r',
        property: 'model/resistanceOhm/tolerancePercent',
        sourceId: 'yageo-cfr-exact-part',
      },
      {
        subjectId: 'resistor.yageo.cfr-25jb-52-220r',
        property: 'ratedPowerWatt/construction/mounting',
        sourceId: 'yageo-cfr-datasheet',
      },
    ],
    limitations: [
      'Presence of a modeled resistor is not proof that its value is appropriate or that the real circuit is safe.',
    ],
    ruleIds: ['LED_SERIES_RESISTOR'],
  },
  {
    id: 'breadboard-connectivity',
    title: 'How breadboard holes connect',
    topics: ['breadboard', 'hole', 'terminal-strip'],
    levels: {
      quick:
        'Use the exact highlighted hole; neighboring holes are not assumed connected unless the topology says so.',
      beginner:
        'A solderless breadboard joins some holes underneath with metal contacts. A component lead and a wire can share a connected group without touching above the board.',
      detailed:
        'Schemora derives connectivity from the selected catalog topology and its declared connectivity variant. For the modeled BusBoard BB400 release, the documented terminal strips and rails—not visual proximity—define which holes are electrically grouped.',
    },
    exactPartIds: [],
    sourceIds: ['busboard-bb400-datasheet', 'busboard-bb400-rev6-internal-connections'],
    claims: [
      {
        subjectId: 'breadboard.busboard.bb400',
        property: 'tiePointCount/variants/dimensions/holePitch/terminalStripGroups/railGroups',
        sourceId: 'busboard-bb400-datasheet',
      },
      {
        subjectId: 'breadboard.busboard.bb400',
        property: 'terminalStripGroups/railGroups/connectivityVariants',
        sourceId: 'busboard-bb400-rev6-internal-connections',
      },
    ],
    limitations: [
      'Verify the physical breadboard model and rail configuration; visually similar boards can have different internal connections.',
    ],
    ruleIds: [],
  },
  {
    id: 'breadboard-rails',
    title: 'Breadboard power rails',
    topics: ['breadboard', 'rail', 'power'],
    levels: {
      quick: 'Treat each rail according to the selected board topology and rail variant.',
      beginner:
        'Power rails are long groups of connected holes often used to distribute a supply and its return. Their internal connection pattern depends on the exact breadboard.',
      detailed:
        'The catalog models rail groups and connectivity variants explicitly. This prevents the workspace from assuming every rail is continuous or split in the same way; the selected variant must match the physical board.',
    },
    exactPartIds: [],
    sourceIds: ['busboard-bb400-datasheet', 'busboard-bb400-rev6-internal-connections'],
    claims: [
      {
        subjectId: 'breadboard.busboard.bb400',
        property: 'terminalStripGroups/railGroups/connectivityVariants',
        sourceId: 'busboard-bb400-rev6-internal-connections',
      },
    ],
    limitations: ['Do not infer a rail’s continuity from color or appearance alone.'],
    ruleIds: [],
  },
  {
    id: 'restricted-pins',
    title: 'Pin restrictions and board labels',
    topics: ['pin', 'board-label', 'restriction'],
    levels: {
      quick: 'Use the documented pin selected by the project, not a similar-looking label.',
      beginner:
        'A board’s printed pin name helps identify a connection, but not every pin is interchangeable. Some pins have dedicated hardware functions or restrictions.',
      detailed:
        'The ESP32-DevKitC V4 guide documents the board header mapping and warns against using module GPIO6–GPIO11, which are connected to SPI flash. Schemora’s exact catalog mapping is configuration-specific; always check the board guide and the physical revision.',
    },
    exactPartIds: ['board.espressif.esp32-devkitc-v4.wroom-32e.male'],
    sourceIds: ['espressif-devkitc-v4-guide'],
    sourceLocators: {
      'espressif-devkitc-v4-guide':
        'Header Block J2/J3, note [2]: D0–D3, CMD and CLK are used for SPI flash; avoid using these pins.',
    },
    claims: [
      {
        subjectId: 'board.espressif.esp32-devkitc-v4.wroom-32e.male',
        property: 'model/configuration/pin-functions/supply-options',
        sourceId: 'espressif-devkitc-v4-guide',
      },
    ],
    limitations: [
      'This lesson does not provide a full GPIO capability, boot-strapping, or current-budget analysis.',
    ],
    ruleIds: ['ELECTRICAL_SCOPE_LIMIT'],
  },
  {
    id: 'pre-power-review',
    title: 'Before powering a physical circuit',
    topics: ['pre-power', 'safety', 'validation'],
    levels: {
      quick:
        'Keep power disconnected while you compare every physical connection with the current guide.',
      beginner:
        'Check the exact board, component orientation, and each wire against the saved design before connecting power. A software pass cannot inspect your physical build.',
      detailed:
        'The current ruleset validates only explicitly modeled connectivity and selected conditions. It does not verify component authenticity, GPIO current budgets, thermal or transient behavior, wiring quality, supply setup, or safe operation.',
    },
    exactPartIds: [],
    sourceIds: ['espressif-devkitc-v4-guide'],
    claims: [],
    limitations: ['The checklist and digital validation are not a safety certification.'],
    ruleIds: ['ELECTRICAL_SCOPE_LIMIT'],
  },
  {
    id: 'workbench-orientation',
    title: 'Orient the virtual workbench',
    topics: ['orientation', 'rotate', 'view'],
    levels: {
      quick:
        'Drag the scene to rotate the view; use the selected component’s rotate controls to change its placement.',
      beginner:
        'Rotating the view changes where you look from. Rotating a selected component changes its saved visual placement. Neither action changes the circuit’s electrical connections.',
      detailed:
        'The workbench provides separate scene-orbit and component-rotation interactions. Component rotation is part of visual layout state; the electrical graph and validation findings remain based on circuit connections.',
    },
    exactPartIds: [],
    sourceIds: [],
    claims: [],
    limitations: [
      'The 3D scene is illustrative and does not guarantee physical fit or pin visibility for a real board.',
    ],
    ruleIds: [],
  },
]);

export type TeachingLesson = z.infer<typeof lessonSchema>;
export type TeachingSource = {
  id: string;
  title: string;
  url: string;
  publisher: string;
  locator?: string;
};
export type TeachingExplanation = {
  level: ExplanationLevel;
  lessons: Array<{
    id: string;
    title: string;
    text: string;
    sources: TeachingSource[];
    limitations: string[];
  }>;
  findings: Array<{ ruleId: string; status: string; message: string; explanation: string }>;
};

function sourceIndex(catalog: CatalogRelease) {
  return new Map([...catalog.sources, ...educationalSources].map((source) => [source.id, source]));
}

/** Fail closed when curated statements, source IDs, or claim locators no longer match this release. */
export function validateTeachingContent(catalogInput: unknown): void {
  const catalog = catalogInput as CatalogRelease;
  if (
    !catalog ||
    !Array.isArray(catalog.sources) ||
    !Array.isArray(catalog.claims) ||
    !Array.isArray(catalog.parts)
  )
    throw new Error('Teaching content requires a resolved catalog release.');
  const sources = sourceIndex(catalog);
  for (const lesson of lessons) {
    for (const id of lesson.sourceIds)
      if (!sources.has(id)) throw new Error(`Unknown teaching source ${id} in ${lesson.id}.`);
    for (const claim of lesson.claims) {
      const resolved = catalog.claims.some(
        (item) =>
          item.subjectId === claim.subjectId &&
          item.property === claim.property &&
          item.sourceId === claim.sourceId,
      );
      if (!resolved)
        throw new Error(`Teaching claim does not resolve to a catalog claim in ${lesson.id}.`);
    }
    for (const partId of lesson.exactPartIds)
      if (!catalog.parts.some((part) => part.id === partId))
        throw new Error(`Unknown exact part ${partId} in ${lesson.id}.`);
  }
}

const ruleExplanations: Record<string, (finding: ValidationFinding) => string> = {
  GRAPH_INTEGRITY: (finding) =>
    finding.status === 'pass'
      ? 'The saved graph references resolve against the pinned catalog and declared breadboard topology.'
      : 'The saved design contains a reference or topology issue. Use the finding details to locate the affected item, then correct it and validate the saved graph again.',
  POWER_GROUND_SHORT: (finding) =>
    finding.status === 'fail'
      ? 'A modeled supply terminal and a modeled ground terminal share one conductive connection group. Compare the listed affected components and separate the unintended connection before continuing.'
      : 'This check looks for a direct modeled connection between a supply terminal and ground; it does not analyze every possible electrical fault.',
  LED_POLARITY: (finding) =>
    finding.status === 'fail'
      ? 'The modeled LED anode and cathode are reversed or share the same net. Compare the LED terminal labels with the current graph.'
      : finding.status === 'unknown'
        ? 'The graph does not identify both a modeled source side and ground return, so the validator cannot determine LED orientation.'
        : 'The modeled LED is oriented from a modeled source toward ground. This is a connectivity result, not proof of physical operation.',
  LED_SERIES_RESISTOR: (finding) =>
    finding.status === 'fail'
      ? 'At least one modeled source-to-ground path through this LED bypasses every modeled series resistor. Compare the resistor path and the exact endpoints in the graph.'
      : finding.status === 'unknown'
        ? 'The graph does not establish a complete source-to-ground path through the LED, so the resistor check is inconclusive.'
        : 'Each modeled source-to-ground path through this LED contains a modeled resistor. This does not establish that the resistor value is suitable.',
  ELECTRICAL_SCOPE_LIMIT: () =>
    'This ruleset checks selected modeled connections only. GPIO current budgets, analog behavior, thermal margins, transient conditions, physical authenticity, wiring quality, and unmodeled components remain unverified.',
};

function matchesTopics(
  step: AssemblyStep,
  lesson: TeachingLesson,
  graph: CircuitGraph,
  catalog: CatalogRelease,
) {
  if (lesson.id === 'workbench-orientation' && step.action === 'identify_component') return true;
  if (step.action === 'pre_power_checklist' && lesson.id === 'pre-power-review') return true;
  if (step.action === 'review_checks' && lesson.ruleIds.length > 0) return true;
  const text =
    `${step.title} ${step.instruction} ${step.explanation} ${step.anchors.map((anchor) => (anchor.kind === 'terminal' ? anchor.catalogTerminalId : anchor.kind)).join(' ')}`.toLowerCase();
  const exactParts = new Set(
    step.componentIds.flatMap((instanceId) => {
      const component = graph.components.find((item) => item.id === instanceId);
      return component ? [component.catalogPartId] : [];
    }),
  );
  if (
    lesson.id === 'led-series-resistor' &&
    exactParts.has('led.kingbright.wp7113id') &&
    exactParts.has('resistor.yageo.cfr-25jb-52-220r')
  )
    return true;
  if (lesson.exactPartIds.length) {
    if (!lesson.exactPartIds.some((id) => exactParts.has(id))) return false;
    if (step.action === 'identify_component') return true;
    return lesson.topics.some((topic) => text.includes(topic));
  }
  if (lesson.topics.some((topic) => text.includes(topic))) return true;
  if (lesson.id === 'breadboard-connectivity' || lesson.id === 'breadboard-rails')
    return (
      step.action === 'place_terminal' &&
      graph.breadboards.some(
        (breadboard) => breadboard.topologyId === 'breadboard.busboard.bb400',
      ) &&
      catalog.breadboardTopologies.some((topology) => topology.id === 'breadboard.busboard.bb400')
    );
  if (lesson.id === 'voltage-current')
    return (
      step.action === 'connect_wire' &&
      (text.includes('gpio') || text.includes('resistor') || text.includes('led'))
    );
  return false;
}

/** Return only curated context relevant to the exact active step and current project graph. */
export async function explainAssemblyStep(input: {
  step: unknown;
  graph: unknown;
  catalog: unknown;
  report: unknown;
  level: ExplanationLevel;
  expectedGraphDigest: string;
}): Promise<TeachingExplanation> {
  const step = z
    .object({
      action: z.enum([
        'identify_component',
        'place_terminal',
        'connect_wire',
        'review_checks',
        'pre_power_checklist',
      ]),
      title: z.string(),
      instruction: z.string(),
      explanation: z.string(),
      componentIds: z.array(z.string()),
      anchors: z.array(
        z.object({ kind: z.string(), catalogTerminalId: z.string().optional() }).passthrough(),
      ),
    })
    .passthrough()
    .parse(input.step) as AssemblyStep;
  const graph = input.graph as CircuitGraph;
  const catalog = input.catalog as CatalogRelease;
  const report = input.report as ValidationReport;
  if (
    !graph?.components ||
    !Array.isArray(graph.breadboards) ||
    !report?.findings ||
    !Array.isArray(report.findings)
  )
    throw new Error('Teaching context is incomplete.');
  validateTeachingContent(catalog);
  if (
    graph.projectId !== report.projectId ||
    graph.id !== report.graphId ||
    graph.projectRevision !== report.projectRevision ||
    graph.catalogReleaseId !== report.catalogReleaseId ||
    catalog.releaseId !== graph.catalogReleaseId ||
    report.graphDigest !== input.expectedGraphDigest
  )
    throw new Error(
      'Teaching context requires a validation report for the same current graph and catalog release.',
    );
  if ((await digestGraph(graph)) !== input.expectedGraphDigest)
    throw new Error('Teaching context graph contents do not match the current assembly plan.');
  const sources = sourceIndex(catalog);
  const selected = lessons.filter((lesson) => matchesTopics(step, lesson, graph, catalog));
  const contextual = selected.map((lesson) => ({
    id: lesson.id,
    title: lesson.title,
    text: lesson.levels[input.level],
    sources: lesson.sourceIds.flatMap((id) => {
      const source = sources.get(id);
      if (!source) return [];
      const claim = lesson.claims.find((item) => item.sourceId === id);
      const catalogClaim = claim
        ? catalog.claims.find(
            (item) =>
              item.subjectId === claim.subjectId &&
              item.property === claim.property &&
              item.sourceId === claim.sourceId,
          )
        : undefined;
      const locator = lesson.sourceLocators?.[id] ?? catalogClaim?.locator;
      return [{ ...source, ...(locator ? { locator } : {}) }];
    }),
    limitations: lesson.limitations,
  }));
  const applicableRuleIds = new Set(selected.flatMap((lesson) => lesson.ruleIds));
  const broadFindingReview =
    step.action === 'review_checks' || step.action === 'pre_power_checklist';
  if (broadFindingReview) applicableRuleIds.add('ELECTRICAL_SCOPE_LIMIT');
  const activeEntities = new Set(step.componentIds);
  const findings = report.findings
    .filter(
      (finding) =>
        applicableRuleIds.has(finding.ruleId) &&
        (broadFindingReview || finding.affectedEntityIds.some((id) => activeEntities.has(id))),
    )
    .map((finding) => ({
      ruleId: finding.ruleId,
      status: finding.status,
      message: finding.message,
      explanation: (
        ruleExplanations[finding.ruleId] ??
        (() => 'No curated explanation is available for this validation rule.')
      )(finding),
    }));
  return { level: input.level, lessons: contextual, findings };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) as string;
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

async function digestGraph(graph: CircuitGraph): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(graph));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function listTeachingLessons(): readonly TeachingLesson[] {
  return lessons;
}
