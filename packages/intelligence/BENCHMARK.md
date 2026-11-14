# Phase 1 conversation-intelligence regression benchmark

## Purpose and limits

This benchmark is a deterministic regression instrument for parser snapshots and explicitly supported local extraction rules. It is not a measure of arbitrary-language understanding, live model quality, user satisfaction, electrical correctness, or product accuracy in the wild. The checked-in corpus is authored synthetic material. It contains no real user export and no copied third-party conversation. Labels currently have one author; there is no independent annotator or adjudication. Those limitations are machine-readable in [`test/benchmark/manifest.json`](./test/benchmark/manifest.json).

The “heldout” split means that authored examples were separated by conversation/project lineage from development examples. It does not mean independently collected, independently labeled, or representative of users. A perfect score on nine synthetic held-out examples is not strong evidence of production reliability. Confidence intervals below make small denominators visible; they do not remove selection or annotation bias.

## Reproduce

From the repository root, run:

```sh
pnpm benchmark:intelligence
```

The command exits non-zero if fixture and manifest inventories disagree, a lineage appears in more than one split, parser snapshots drift, exact candidate values/status/details differ, evidence spans do not point to exact source text, or declared conflict, connection-decision, supersession, precision, or recall regression thresholds fail. It prints a JSON report containing the corpus SHA-256, split totals, counts, Wilson 95% intervals, provenance results, and failure messages. The digest is calculated from ordered case content and labels at execution time; it changes when benchmark material changes.

## Scoring contract

For extraction, a predicted fact matches a gold fact only when kind, exact normalized display value, candidate/superseded status, and any labeled structured details match. An unmatched prediction is a false positive; an unmatched gold fact is a false negative. Precision is TP/(TP+FP), recall is TP/(TP+FN). Structured details are exact-checked when the fixture labels them. Evidence is scored separately: every emitted span must resolve to a message and its UTF-16 slice must equal the exact quote. The benchmark compares complete normalized transcript snapshots, including message count, sequence, role, and content. It also checks expected missing-information signals, conflict counts, connection decision states, and explicit supersession edges.

Thresholds are predeclared in the manifest and currently equal 1.0 for this narrow regression contract. They are regression tripwires, not a statistical acceptance bar for deployment. The benchmark intentionally does not tune thresholds against a production corpus that does not yet exist.

## Current run

Executed on 2026-11-14 with `pnpm benchmark:intelligence`:

| Measure                               |                                                                     Result |
| ------------------------------------- | -------------------------------------------------------------------------: |
| Corpus                                |                             29 authored synthetic cases; 22 lineage groups |
| Split                                 |                                                20 development / 9 held-out |
| Exact normalized transcript snapshots |                                            20/20 development; 9/9 held-out |
| Extraction exact-match                | Zero false positives and zero false negatives for every labeled kind/split |
| Evidence spans                        |                                                   50/50 exact source spans |
| Conflict-count cases                  |                                                                        3/3 |
| Labeled connection decision states    |                                                                      11/11 |
| Labeled supersession edges            |                                                                        1/1 |
| Benchmark failures                    |                                                                          0 |

Every point estimate of precision and recall is 1.0 in this bounded corpus. Read that beside its denominators: the 95% Wilson interval for 1/1 is approximately 0.207–1.000; for 2/2 it is 0.342–1.000; for 4/4 it is 0.510–1.000. Even the largest category has a lower bound below 0.84. This corpus is useful for catching regressions in known rules and source preservation, but cannot justify a broad accuracy claim.

## Coverage inventory

Fixtures exercise board-family mentions, explicit/unknown component values, quantities, resistor units, exact GPIO wiring, correction and ambiguous correction, negative instructions, conflicting board choices, I2C and sensor endpoints, firmware mention/change, missing wiring/polarity, unsupported identity, code role-marker injection, instruction-like imported data, Unicode evidence offsets/units, and a stop/removal instruction pending review. Several fixture pairs share a lineage; the benchmark enforces that each lineage belongs to only one split.

The package unit suite extends beyond these text benchmark cases. It includes JSON/provider-shaped exports, static HTML, text PDFs and refusal paths, ZIP limits and unsafe archives, malformed data, parser resource ceilings, provider response schema/provenance enforcement, and secret redaction. Those are parser/security contract tests, not an equivalent cross-format gold benchmark. Exact format-specific parser accuracy over independently authored representative exports remains unmeasured.

## Required evidence before Phase 1 can claim broad quality

1. Define and approve an annotation guide with explicit rules for facts, relations, correction, negation, uncertainty, missing values, source spans, and conversation branch selection.
2. Add a second annotator who labels cases independently; publish disagreements and adjudication decisions. Do not retrofit labels silently after looking at model results.
3. Obtain a rights-cleared and consented corpus representative of intended exports, or define a licensed alternative. Record source, allowed use, retention, de-identification, and deletion terms for each source class.
4. Freeze development and held-out partitions by project lineage before tuning. Keep held-out material inaccessible to rule/model authors during iteration and record corpus/version hashes.
5. Expand separate parser and semantic evaluation: formats/export variants, source ordering/roles/code/timestamps, multi-conversation branch selection, multilingual/noisy text if in scope, facts/relations, correction chains, negation, abstention, and missing information.
6. Set acceptance criteria with product and hardware reviewers, report per-category precision/recall and confidence intervals, inspect false positives/negatives, and run controlled provider/retention/cost checks for any remote model.

Until that evidence exists, Phase 1 should describe local rules as conservative review assistance and require human confirmation. A source span proves where a claim came from; it does not prove the claim is true or electrically safe.
