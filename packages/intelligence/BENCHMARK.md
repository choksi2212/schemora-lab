# Phase 1 conversation intelligence benchmark

Measured 2026-10-13 using `pnpm exec tsx packages/intelligence/test/benchmark.ts` and the committed fixture set in test/fixtures.ts. This evaluates the deterministic local extractor on 28 synthetic conversations. It does not evaluate a live provider or claim accuracy on arbitrary user conversations.

Every fixture specifies its complete expected candidate set for the supported rule scope. Predictions match on kind, independently stated source value, and candidate/superseded status. Unmatched predictions are false positives; unmatched gold facts are false negatives. Precision is TP/(TP+FP); recall is TP/(TP+FN).

| Kind        |  TP |  FP |  FN | Precision | Recall |
| ----------- | --: | --: | --: | --------: | -----: |
| Board       |   7 |   0 |   0 |      1.00 |   1.00 |
| Component   |  24 |   0 |   0 |      1.00 |   1.00 |
| Connection  |  11 |   0 |   0 |      1.00 |   1.00 |
| Requirement |   1 |   0 |   0 |      1.00 |   1.00 |
| Firmware    |   4 |   0 |   0 |      1.00 |   1.00 |

All 49 candidate evidence spans match their source message exactly. All 11 labeled connection decision states match; the one labeled explicit correction links to the expected superseded instruction. All three labeled conflict-count cases match. A selected ChatGPT branch fixture also ensures alternative sibling wiring is excluded rather than silently combined.

The accompanying 58 tests cover these fixtures plus source normalization, valid text PDF extraction and empty-text refusal, role boundaries inside code, static HTML safety, malformed/unsupported exports, bounded ZIP behavior, traversal, nested archives, symlinks, encryption, expanded-byte limits, extension aliases, file policies, incomplete providers, forged provenance, structured null fields, units, and unknown endpoints. Long-conversation regressions preserve all 101 repeated messages while bounding evidence to 100 spans, preserve 2,001 source instructions while capping derived candidates at 2,000, cap conflicts at 200, and report oversized firmware as omitted from extraction while retaining the original code. Every partial output explicitly warns the reviewer. Unit tests use synthetic files and a fake provider transport. No real conversation or provider credentials are used.

The sample is intentionally small and represents the implemented rules. The single supersession edge is insufficient to establish general final-design reconstruction quality. Before production extraction claims, evaluate the approved model against a separate labeled corpus with varied phrasing, named parts, board revisions, multiple simultaneous circuits, superseded designs, changed firmware/dependencies, and deliberately missing facts. Keep parser reliability, source integrity, semantic fact accuracy, and electrical validation as separate measures.
