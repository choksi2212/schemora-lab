# Phase 8 — Debugging and physical verification

**Branch:** `dev`  
**Status:** Engineering implementation delivered for saved-virtual-graph comparison, bounded rule guidance, and server-persisted pre-power acknowledgements. Product completion remains pending Phase 7 exit criteria, hardware/product review, browser/accessibility review, and beginner usability evidence.

## 1. Purpose

Phase 8 helps a learner understand supported digital findings, correct a modeled fault, and inspect a real assembly before connecting power. The saved circuit graph remains the digital design under review. A software report can reason only about facts represented by that graph, the selected catalog release, and the named validator rules.

The product must keep three states distinct:

1. **Intended virtual design:** an immutable saved graph snapshot explicitly confirmed by a project user.
2. **Working virtual design:** the current immutable saved graph snapshot.
3. **Digital rule result:** an immutable report for one graph and catalog identity.
4. **Physical inspection:** user-reported checks against physical parts and wires; the application cannot observe or certify the assembly.

## 2. User workflow

```mermaid
flowchart TD
  A[Edit virtual circuit] --> B[Save a new graph revision]
  B --> T{Intended graph confirmed?}
  T -->|No| U[Explicitly confirm saved graph as intent]
  T -->|Yes| D[Compare saved virtual graphs]
  U --> D
  D --> C[Run deterministic validation]
  C --> D{Current report contains a supported failure?}
  D -->|Yes| E[Show rule explanation and affected modeled wires]
  E --> F[User changes graph]
  F --> B
  D -->|No blocking failure| G[Generate revision-bound assembly guide]
  G --> H[Follow ordered virtual steps]
  H --> I[Inspect physical circuit item by item]
  I --> J[Record owner-scoped checklist acknowledgement]
  J --> K[Retain current report identity and unknown limits]
```

The checklist uses the exact graph and report already bound to the assembly plan. Editing the circuit makes the plan stale; a new saved revision and validation are required before a current checklist can be generated. The pre-power step cannot be skipped; each generated checklist item must be acknowledged before the step can be marked complete. Checked/unchecked acknowledgements are submitted to the owner-scoped assembly-progress API and follow that project account across signed-in devices. If a write fails, the UI does not adopt the unpersisted checkbox state and shows a retry/reconnect warning. Persisting an acknowledgement still does not observe the physical assembly or attest that a check was actually performed.

## 3. Supported correction behavior

| Rule                  | Proven observation                                                                   | Current correction guidance                                                                                                                       | Boundary                                                                       |
| --------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `POWER_GROUND_SHORT`  | A catalog-modeled supply and ground share a conductive net                           | The report identifies affected modeled wire endpoints; the user keeps power disconnected, checks that bridge, corrects the graph, and revalidates | Does not detect every physical short or an unmodeled path                      |
| `LED_POLARITY`        | The modeled LED has reversed source/ground orientation or both terminals share a net | The report identifies wires on the LED terminal nets and asks the user to compare named anode/cathode endpoints with the physical marking         | Does not infer physical LED polarity from an image or prove operation          |
| `LED_SERIES_RESISTOR` | A modeled source-to-ground path through the LED bypasses all modeled resistors       | The report names affected component instances and adjacent modeled wires; the user inspects the path and revalidates                              | Does not prove a resistor value, current limit, GPIO budget, or thermal margin |
| `GRAPH_INTEGRITY`     | A graph reference or topology invariant is invalid                                   | The finding reports the failing graph path and message; the user corrects the saved graph                                                         | The rule cannot infer a user's unstated intended design                        |

Corrections are instructions, not automatic graph edits. The UI never marks a fault repaired until the user saves the changed graph and obtains a current new report. Failed digital checks block assembly-plan generation. Unknown results remain visible and are never converted to pass by checklist acknowledgement.

## 4. Physical inspection checklist

The pre-power step is generated from the current graph, catalog, and report. It includes:

- Keep the physical assembly disconnected from USB, batteries, and external power while inspecting it.
- Match every physical component to the exact catalog model/configuration in the graph.
- Check the board supply requirements and polarity against the manufacturer documentation.
- Inspect every modeled wire using its graph endpoint labels.
- Inspect each modeled terminal-to-breadboard-hole placement.
- Verify the selected breadboard topology, split rails, and physical labels.
- For a modeled LED, compare the physical marking to its graph anode/cathode endpoints.
- Read and account for failed or unknown report findings when present.

The UI requires every displayed item to be checked before the user can mark the pre-power assembly step complete. Completion means only that the signed-in project owner recorded those acknowledgements for an exact assembly-plan digest. Progress is an append-only project event history and is restored across devices. It is not a verified audit of physical work, safety approval, sensor measurement, or proof of physical correctness. Plan/project deletion removes the associated progress under the plan/project foreign-key cascade; there is no separate checklist retention period.

## 5. Data and implementation boundaries

- Validation reports are stored by the existing persistence layer and carry graph digest, graph revision, catalog release/digest, ruleset version, and validator version.
- Fault findings include stable affected component identities. Wire IDs are added to the affected set only when the rule can derive those wires from the modeled conductive net.
- The browser resolves those IDs to human-readable catalog terminal labels from the current saved graph.
- The assembly plan already includes review and pre-power actions. The API validates and stores itemized checked/unchecked acknowledgements as append-only progress events bound to a current plan digest, project revision, actor, and idempotency key. Project deletion removes the associated plan and event history.
- No vision model, free-form language model, or simulation output is used to invent a correction.
- No physical connection is inferred from the user checking an item or from a saved virtual wire.

## 6. Known coverage gaps

The data model has a separate, user-confirmed intended graph pointer backed by append-only intent versions referencing immutable graph snapshots. Comparison reports component, breadboard topology, terminal placement, and wire deltas between that target and the current saved virtual graph. Wire identity is based on its unordered endpoint pair, so renaming or reversing an edge does not create a false delta. Comparisons stop when catalog release identities differ. This representation is **not** a physical as-built graph and the UI says so. It does not provide detection coverage for every missing source pin, wrong destination pin, breadboard row, jumper placement, supply condition, or physical fault.

Correction support is intentionally bounded to findings with deterministic rule evidence. Checklist acknowledgements synchronize through project-scoped persistence, but remain user-reported statements and are not an auditable physical-verification record. More complex circuits must remain unsupported until their catalog facts and rules have reviewed coverage.

## 7.1 Supported fault coverage matrix

This matrix describes the current tested digital cases. A row with an intended-graph comparator requires the user to confirm a saved virtual graph first. It never compares the virtual design with the physical circuit.

| Fault or discrepancy                                                                                   | Current evidence path                          | Expected result                                                           | Explicit limit                                                                                                               |
| ------------------------------------------------------------------------------------------------------ | ---------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Modeled supply and ground directly share one net                                                       | `direct-short` validation fixture              | `POWER_GROUND_SHORT = fail`; affected board/wire identities are pinned    | Does not find a hidden physical bridge, unmodeled supply, or every electrical short class                                    |
| Modeled LED source/return orientation is reversed                                                      | `reversed-led` validation fixture              | `LED_POLARITY = fail`; LED and implicated wires are pinned                | Does not inspect the physical LED or its inserted orientation                                                                |
| Modeled LED terminals share one net                                                                    | `led-same-net` validation fixture              | `LED_POLARITY = fail`; LED and wire are pinned                            | Does not infer whether a visually plausible physical arrangement is electrically connected                                   |
| Source-to-ground LED path lacks a proven return                                                        | `missing-return` validation fixture            | `LED_SERIES_RESISTOR = unknown`; no pass is inferred                      | Unknown does not identify whether the physical cause is a missing wire, wrong hole, or component contact                     |
| A modeled source-to-ground path through an LED bypasses every modeled series resistor                  | `resistor-bypass` validation fixture           | `LED_SERIES_RESISTOR = fail`; status and affected LED identity are pinned | This is limited to conductive paths represented in the graph and catalog; it does not measure current or physical resistance |
| Graph contains an invalid topology/hole relationship                                                   | `invalid-topology` validation fixture          | `GRAPH_INTEGRITY = fail` with exact graph paths                           | Only cataloged topology invariants are covered                                                                               |
| A wire is absent from the current virtual graph relative to confirmed intent                           | `missing-return-wire` graph comparison fixture | `wire-removed` difference                                                 | Requires confirmed intent; does not prove the wire is physically absent                                                      |
| Wire connects to a different modeled destination than confirmed intent                                 | `wrong-destination` comparison fixture         | `wire-removed` plus `wire-added` differences                              | Does not label the replacement as an electrical fault without rule evidence and does not see real wires                      |
| Terminal or hole differs from confirmed intent                                                         | Graph comparison                               | Typed component/placement delta when both snapshots are comparable        | A legally represented alternate terminal/hole may not fail validation; comparison only says the saved virtual designs differ |
| Unsupported catalog release or topology                                                                | Graph/schema and comparison guards             | Rejected or non-comparable; no cross-release delta is claimed             | No fallback mapping or inferred physical equivalent                                                                          |
| Physical-only fault, wrong real part, unmodeled jumper, damaged part, supply error, or contact failure | No digital detector                            | Remains unobserved/unknown                                                | Requires suitable human or instrumented physical evaluation outside this feature                                             |

The fixtures pin expected outcomes; they are not a representative labeled fault corpus. No false-positive/false-negative rates or population-level coverage claims have been measured. The manifest is [`packages/validation/test/fixtures/phase8/v1/manifest.json`](../packages/validation/test/fixtures/phase8/v1/manifest.json).

## 8. Verification and exit criteria

The versioned Phase 8 fixture manifest pins the catalog, ruleset, and validator versions and asserts exact affected IDs for a direct modeled short, reversed/same-net LED, an unknown missing return, and an invalid topology. Its graph-comparison fixtures assert exact records for a missing wire and wrong destination. Circuit-model tests also cover component changes, placements, breadboard changes, duplicate edges, order stability, and catalog mismatch. The API integration test covers intent confirmation, append-only progress, idempotency, owner authorization, invalid checklist target, stale-plan rejection, and a later graph delta. In the current workspace, PostgreSQL at `127.0.0.1:55432` refused the connection, so those database tests could not be rerun in this increment. No Phase 8 browser flow or assistive-technology review has been performed; hardware-owner review and beginner usability evidence still require human participants.

Phase 8 remains open until all of the following are evidenced:

1. **Implemented:** a separately represented, explicitly confirmed intended graph compares with the current saved virtual graph. Physical state is not claimed.
2. **Implemented for the current supported set:** a versioned, catalog/ruleset/validator-pinned fixture corpus checks exact affected IDs for supported short/polarity/topology findings and exact graph records for missing/wrong connections. It does not claim comprehensive coverage of every physical fault or unsupported circuit family.
3. **Implemented for current supported blocking rules:** the UI provides rule-specific corrective guidance and requires a newly saved graph and current report to establish updated digital results. Coverage remains limited to the listed deterministic rules.
4. **Pending external evidence:** hardware safety/product owners must review the checklist, including unsupported and unknown cases.
5. **Pending external evidence:** beginner sessions must establish that users can identify/correct supported faults and understand physical uncertainty.
6. **Implemented:** checklist acknowledgements are owner-scoped append-only events bound to the plan digest and project revision, restored across devices, and deleted with the project/plan. The UI calls them user acknowledgements and does not present them as physical verification. The existing API regression covers authorization, idempotency, invalid targets, and stale plans; rerun it against an available local test database before release.

Phase 8 remains open because Phase 7's documented exit criteria, browser/accessibility evidence, hardware-owner review, and beginner usability evidence are outstanding. A green digital report or persisted checklist alone does not complete the phase. The current bounded digital implementation and persistence decision are documented; the fault matrix is a map of tested scope, not broad coverage approval.
