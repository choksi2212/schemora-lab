import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { parseConversation, extractCandidates } from '../src/index.js';
import { benchmarkCases } from './fixtures.js';

const manifest = JSON.parse(
  readFileSync(new URL('./benchmark/manifest.json', import.meta.url), 'utf8'),
) as {
  corpusVersion: string;
  caseCount: number;
  splits: Record<'development' | 'heldout', number>;
  source: { class: string };
  annotation: { status: string; independentSecondAnnotator: boolean };
  preregisteredRegressionThresholds: {
    exactNormalizedTranscriptRate: number;
    sourceEvidenceSpanValidity: number;
    exactExtractionPrecision: number;
    exactExtractionRecall: number;
    conflictAndSupersessionDecisionAccuracy: number;
  };
  cases: { id: string; name: string; lineage: string; split: string }[];
};

type Counts = { truePositive: number; falsePositive: number; falseNegative: number };
const counts = new Map<string, Counts>();
const parser = new Map<string, { exact: number; total: number }>();
const errors: string[] = [];
let spanCount = 0;
let validSpans = 0;
let correctConflictCases = 0;
let conflictCases = 0;
let expectedDecisionStates = 0;
let correctDecisionStates = 0;
let expectedSupersessionEdges = 0;
let correctSupersessionEdges = 0;

function metric(key: string): Counts {
  const current = counts.get(key) ?? { truePositive: 0, falsePositive: 0, falseNegative: 0 };
  counts.set(key, current);
  return current;
}

function wilson(successes: number, total: number): { lower: number; upper: number } | null {
  if (!total) return null;
  const z = 1.959963984540054;
  const p = successes / total;
  const z2 = z * z;
  const scale = 1 + z2 / total;
  const center = (p + z2 / (2 * total)) / scale;
  const radius = (z * Math.sqrt((p * (1 - p)) / total + z2 / (4 * total * total))) / scale;
  return { lower: Math.max(0, center - radius), upper: Math.min(1, center + radius) };
}

const lineages = new Map<string, string>();
const ids = new Set<string>();
const corpusDigest = createHash('sha256');
if (manifest.caseCount !== benchmarkCases.length)
  errors.push(
    `Manifest declares ${manifest.caseCount} cases; fixtures contain ${benchmarkCases.length}.`,
  );
if (manifest.cases.length !== benchmarkCases.length)
  errors.push('Manifest case inventory and fixture case inventory have different sizes.');
const manifestCases = new Map(manifest.cases.map((fixture) => [fixture.id, fixture]));
for (const fixture of benchmarkCases) {
  const recorded = manifestCases.get(fixture.id);
  if (
    !recorded ||
    recorded.name !== fixture.name ||
    recorded.lineage !== fixture.lineage ||
    recorded.split !== fixture.split
  )
    errors.push(`${fixture.id}: case identity/split differs from the checked-in corpus manifest.`);
}

for (const fixture of benchmarkCases) {
  if (ids.has(fixture.id)) errors.push(`${fixture.id}: duplicate corpus ID.`);
  ids.add(fixture.id);
  const priorSplit = lineages.get(fixture.lineage);
  if (priorSplit && priorSplit !== fixture.split)
    errors.push(`${fixture.id}: lineage ${fixture.lineage} leaks across corpus splits.`);
  lineages.set(fixture.lineage, fixture.split);
  corpusDigest.update(
    JSON.stringify({
      id: fixture.id,
      name: fixture.name,
      lineage: fixture.lineage,
      split: fixture.split,
      text: fixture.text,
      expectedMessages: fixture.expectedMessages,
      expected: fixture.expected,
      missing: fixture.missing ?? null,
      conflicts: fixture.conflicts ?? null,
    }) + '\n',
  );

  const conversations = await parseConversation({
    filename: `${fixture.id}.txt`,
    bytes: new TextEncoder().encode(fixture.text),
  });
  if (conversations.conversations.length !== 1) {
    errors.push(`${fixture.id}: expected one normalized conversation.`);
    continue;
  }
  const conversation = conversations.conversations[0]!;
  const exactTranscript =
    conversation.messages.length === fixture.expectedMessages.length &&
    conversation.messages.every(
      (message, index) =>
        message.sequence === index &&
        message.role === fixture.expectedMessages[index]!.role &&
        message.content === fixture.expectedMessages[index]!.content,
    );
  const parserKey = fixture.split;
  const parserCounts = parser.get(parserKey) ?? { exact: 0, total: 0 };
  parserCounts.total++;
  if (exactTranscript) parserCounts.exact++;
  else
    errors.push(
      `${fixture.id}: normalized message role, count, order, or content differs from gold.`,
    );
  parser.set(parserKey, parserCounts);

  const result = extractCandidates(conversation);
  const matchedExpected = new Set<number>();
  for (const candidate of result.candidates) {
    const key = `${fixture.split}:${candidate.kind}`;
    const row = metric(key);
    const expectedIndex = fixture.expected.findIndex(
      (expected, index) =>
        !matchedExpected.has(index) &&
        expected.kind === candidate.kind &&
        expected.value === candidate.value &&
        (expected.status ?? 'candidate') === candidate.status,
    );
    if (expectedIndex >= 0) {
      matchedExpected.add(expectedIndex);
      row.truePositive++;
      const expectedDetails = fixture.expected[expectedIndex]!.details;
      if (expectedDetails !== undefined && !isDeepStrictEqual(candidate.details, expectedDetails))
        errors.push(`${fixture.id}: structured details differ for ${candidate.value}.`);
    } else {
      row.falsePositive++;
      errors.push(
        `${fixture.id}: unexpected ${candidate.kind} candidate ${JSON.stringify(candidate.value)}.`,
      );
    }
    for (const evidence of candidate.evidence) {
      spanCount++;
      if (
        conversation.messages
          .find((message) => message.id === evidence.messageId)
          ?.content.slice(evidence.start, evidence.end) === evidence.quote
      )
        validSpans++;
      else
        errors.push(`${fixture.id}: evidence span does not match its normalized source message.`);
    }
  }
  for (let index = 0; index < fixture.expected.length; index++) {
    if (matchedExpected.has(index)) continue;
    const expected = fixture.expected[index]!;
    metric(`${fixture.split}:${expected.kind}`).falseNegative++;
    errors.push(
      `${fixture.id}: missing ${expected.kind} candidate ${JSON.stringify(expected.value)}.`,
    );
  }

  for (const expected of fixture.expected.filter((item) => item.kind === 'connection')) {
    expectedDecisionStates++;
    const actual = result.candidates.find(
      (candidate) => candidate.kind === 'connection' && candidate.value === expected.value,
    );
    if (actual?.status === (expected.status ?? 'candidate')) correctDecisionStates++;
    else errors.push(`${fixture.id}: incorrect final decision state for ${expected.value}.`);
    if (expected.supersedesValue) {
      expectedSupersessionEdges++;
      if (
        actual?.supersedes.some(
          (id) =>
            result.candidates.find((candidate) => candidate.id === id)?.value ===
            expected.supersedesValue,
        )
      )
        correctSupersessionEdges++;
      else
        errors.push(
          `${fixture.id}: missing explicit supersession edge to ${expected.supersedesValue}.`,
        );
    }
  }

  if (fixture.conflicts !== undefined) {
    conflictCases++;
    if (result.conflicts.length === fixture.conflicts) correctConflictCases++;
    else
      errors.push(
        `${fixture.id}: expected ${fixture.conflicts} conflicts, got ${result.conflicts.length}.`,
      );
  }
  if (fixture.missing && !result.missingInformation.some((item) => item.includes(fixture.missing!)))
    errors.push(
      `${fixture.id}: expected missing-information signal ${JSON.stringify(fixture.missing)}.`,
    );
}

const perSplitAndKind = Object.fromEntries(
  [...counts]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, row]) => {
      const precisionTotal = row.truePositive + row.falsePositive;
      const recallTotal = row.truePositive + row.falseNegative;
      return [
        key,
        {
          ...row,
          precision: precisionTotal ? row.truePositive / precisionTotal : null,
          precision95Wilson: wilson(row.truePositive, precisionTotal),
          recall: recallTotal ? row.truePositive / recallTotal : null,
          recall95Wilson: wilson(row.truePositive, recallTotal),
        },
      ];
    }),
);
const splitSizes = Object.fromEntries(
  ['development', 'heldout'].map((split) => [
    split,
    benchmarkCases.filter((fixture) => fixture.split === split).length,
  ]),
);
for (const split of ['development', 'heldout'] as const)
  if (splitSizes[split] !== manifest.splits[split])
    errors.push(
      `${split}: manifest declares ${manifest.splits[split]} cases; got ${splitSizes[split]}.`,
    );
for (const row of parser.values())
  if (
    row.total &&
    row.exact / row.total < manifest.preregisteredRegressionThresholds.exactNormalizedTranscriptRate
  )
    errors.push('Normalized transcript exact-match score is below the preregistered threshold.');
for (const row of counts.values()) {
  const precisionDenominator = row.truePositive + row.falsePositive;
  const recallDenominator = row.truePositive + row.falseNegative;
  if (
    (precisionDenominator &&
      row.truePositive / precisionDenominator <
        manifest.preregisteredRegressionThresholds.exactExtractionPrecision) ||
    (recallDenominator &&
      row.truePositive / recallDenominator <
        manifest.preregisteredRegressionThresholds.exactExtractionRecall)
  )
    errors.push('Exact extraction score is below the preregistered regression threshold.');
}
if (
  spanCount &&
  validSpans / spanCount < manifest.preregisteredRegressionThresholds.sourceEvidenceSpanValidity
)
  errors.push('Evidence span validity is below the preregistered regression threshold.');
if (
  expectedDecisionStates &&
  correctDecisionStates / expectedDecisionStates <
    manifest.preregisteredRegressionThresholds.conflictAndSupersessionDecisionAccuracy
)
  errors.push(
    'Connection decision-state accuracy is below the preregistered regression threshold.',
  );
if (
  expectedSupersessionEdges &&
  correctSupersessionEdges / expectedSupersessionEdges <
    manifest.preregisteredRegressionThresholds.conflictAndSupersessionDecisionAccuracy
)
  errors.push('Supersession-edge accuracy is below the preregistered regression threshold.');
if (
  conflictCases &&
  correctConflictCases / conflictCases <
    manifest.preregisteredRegressionThresholds.conflictAndSupersessionDecisionAccuracy
)
  errors.push('Conflict-count accuracy is below the preregistered regression threshold.');

const report = {
  corpus: {
    version: manifest.corpusVersion,
    digestSha256: corpusDigest.digest('hex'),
    cases: benchmarkCases.length,
    splitSizes,
    independentLineages: lineages.size,
    sourceClass: manifest.source.class,
    annotationStatus: manifest.annotation.status,
    independentSecondAnnotator: manifest.annotation.independentSecondAnnotator,
  },
  scope:
    'Parser snapshots and deterministic local-rule extraction only. Scores do not estimate accuracy on real conversations or an external model.',
  parserFidelity: Object.fromEntries(
    [...parser]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([split, row]) => [
        split,
        { ...row, exactRate: row.total ? row.exact / row.total : null },
      ]),
  ),
  extractionExactMatchBySplitAndKind: perSplitAndKind,
  sourceEvidence: { exactSpans: validSpans, totalSpans: spanCount },
  conflictCases: { correct: correctConflictCases, total: conflictCases },
  finalConnectionDecisionStates: { correct: correctDecisionStates, total: expectedDecisionStates },
  explicitSupersessionEdges: {
    correct: correctSupersessionEdges,
    total: expectedSupersessionEdges,
  },
  failures: errors,
};

console.log(JSON.stringify(report, null, 2));
if (
  errors.length ||
  validSpans !== spanCount ||
  correctConflictCases !== conflictCases ||
  correctDecisionStates !== expectedDecisionStates ||
  correctSupersessionEdges !== expectedSupersessionEdges
)
  process.exitCode = 1;
