import { parseConversation, extractCandidates } from '../src/index.js';
import { benchmarkCases } from './fixtures.js';

const metrics = new Map<
  string,
  { truePositive: number; falsePositive: number; falseNegative: number }
>();
let spanCount = 0;
let validSpans = 0;
let correctConflictCases = 0;
let conflictCases = 0;
let expectedDecisionStates = 0;
let correctDecisionStates = 0;
let expectedSupersessionEdges = 0;
let correctSupersessionEdges = 0;
for (const fixture of benchmarkCases) {
  const conversation = (
    await parseConversation({
      filename: `${fixture.name}.txt`,
      bytes: new TextEncoder().encode(fixture.text),
    })
  ).conversations[0]!;
  const result = extractCandidates(conversation);
  const matched = new Set<number>();
  for (const expected of fixture.expected.filter((e) => e.kind === 'connection')) {
    expectedDecisionStates++;
    const actual = result.candidates.find(
      (c) => c.kind === expected.kind && c.value.includes(expected.includes),
    );
    if (actual?.status === (expected.status ?? 'candidate')) correctDecisionStates++;
    if (expected.supersedesIncludes) {
      expectedSupersessionEdges++;
      if (
        actual?.supersedes.some((id) =>
          result.candidates.find((c) => c.id === id)?.value.includes(expected.supersedesIncludes!),
        )
      )
        correctSupersessionEdges++;
    }
  }
  for (const candidate of result.candidates) {
    const metric = metrics.get(candidate.kind) ?? {
      truePositive: 0,
      falsePositive: 0,
      falseNegative: 0,
    };
    metrics.set(candidate.kind, metric);
    const index = fixture.expected.findIndex(
      (e, i) =>
        !matched.has(i) &&
        e.kind === candidate.kind &&
        candidate.value.includes(e.includes) &&
        candidate.status === (e.status ?? 'candidate'),
    );
    if (index >= 0) {
      matched.add(index);
      metric.truePositive++;
    } else metric.falsePositive++;
    for (const e of candidate.evidence) {
      spanCount++;
      if (
        conversation.messages.find((m) => m.id === e.messageId)?.content.slice(e.start, e.end) ===
        e.quote
      )
        validSpans++;
    }
  }
  for (let i = 0; i < fixture.expected.length; i++)
    if (!matched.has(i)) {
      const kind = fixture.expected[i]!.kind;
      const metric = metrics.get(kind) ?? { truePositive: 0, falsePositive: 0, falseNegative: 0 };
      metric.falseNegative++;
      metrics.set(kind, metric);
    }
  if (fixture.conflicts !== undefined) {
    conflictCases++;
    if (result.conflicts.length === fixture.conflicts) correctConflictCases++;
  }
}
console.log(
  JSON.stringify(
    {
      fixtureCount: benchmarkCases.length,
      scope:
        'Synthetic deterministic local rules only; no live provider or arbitrary conversation accuracy claim.',
      perKind: Object.fromEntries(
        [...metrics].map(([kind, m]) => [
          kind,
          {
            ...m,
            precision: m.truePositive / (m.truePositive + m.falsePositive || 1),
            recall: m.truePositive / (m.truePositive + m.falseNegative || 1),
          },
        ]),
      ),
      provenance: { validSpans, spanCount },
      conflictCases: { correctConflictCases, conflictCases },
      finalDecisionStates: { correctDecisionStates, expectedDecisionStates },
      explicitSupersessionEdges: { correctSupersessionEdges, expectedSupersessionEdges },
    },
    null,
    2,
  ),
);
if (
  [...metrics.values()].some((m) => m.falsePositive || m.falseNegative) ||
  validSpans !== spanCount ||
  correctConflictCases !== conflictCases ||
  correctDecisionStates !== expectedDecisionStates ||
  correctSupersessionEdges !== expectedSupersessionEdges
)
  process.exitCode = 1;
