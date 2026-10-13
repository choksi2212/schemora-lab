# Schemora — Phase 2 Implementation

| Document field       | Value                                                   |
| -------------------- | ------------------------------------------------------- |
| Phase                | Hardware knowledge and deterministic circuit validation |
| Status               | Implemented vertical slice on `dev`                     |
| Reviewed             | 13 October 2026                                         |
| Product context      | [context.md](context.md)                                |
| Product requirements | [PRD.md](PRD.md)                                        |
| Technical contracts  | [TRD.md](TRD.md)                                        |
| System architecture  | [System-Design.md](System-Design.md)                    |
| Previous delivery    | [Phase-1-Implementation.md](Phase-1-Implementation.md)  |

## 1. Purpose and delivery status

Phase 2 turns the reviewed, versioned design from Phase 1 into a catalog-bound circuit graph with reproducible connectivity and a deliberately narrow set of electrical findings. A catalog entry is evidence about a manufacturer configuration; it does not identify hardware lying on a user's table. A graph is the electrical state; a rendered diagram cannot create or override its connections. A passing supported rule is not a safety certification.

The implementation establishes five connected capabilities: immutable source-linked hardware data, a strict graph and breadboard connectivity model, graph/validation HTTP and persistence contracts, deterministic validation, and a beginner-facing catalog/circuit workspace. The catalog browser exposes evidence and the modeled BB400 topology. The project circuit workspace starts with a named exact-catalog LED/resistor example, lets the user edit the three circuit wire endpoints and optional component-to-hole placements, saves graph revisions, and runs the backend rules against the saved graph.

### 1.1 Delivery boundary

| Included in this phase                                                                               | Explicitly not included                                                                                               |
| ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| One exact ESP32-DevKitC V4 + WROOM-32E + male-header configuration                                   | Automatic identification of a user's physical board or module                                                         |
| One exact Kingbright LED, one exact YAGEO resistor, and one exact BB400/BB400T breadboard topology   | Universal ESP32, LED, resistor, or breadboard compatibility                                                           |
| Source-linked immutable catalog release and content digest                                           | Catalog authoring UI, external catalog marketplace, or automatic catalog migration                                    |
| Strict typed component, terminal, hole, placement, and wire graph                                    | Three-dimensional scene, geometry, camera state, wire animation, or photo recognition                                 |
| Deterministic modeled net derivation from explicit wires and catalog topology                        | Firmware execution, analog circuit simulation, transient analysis, thermal simulation, or arbitrary physics           |
| Structural integrity, direct modeled power/ground short, LED direction, and LED resistor-path checks | Whole-board power budget, GPIO current certification, component authenticity, workmanship, or a general “safe” result |
| Immutable graph snapshots and immutable validation reports tied to graph/catalog/ruleset identity    | Collaboration, sharing, general generated assembly instructions, or manufacturing outputs                             |

## 2. Architecture

```mermaid
flowchart LR
  Browser[Authenticated browser] -->|catalog GET| BFF[Next.js server proxy]
  Browser -->|project graph commands| BFF
  BFF -->|signed user identity| API[Fastify API]
  API --> Catalog[Immutable @schemora/catalog release]
  API --> Graph[@schemora/circuit-model]
  API --> Rules[@schemora/validation]
  API -->|project-scoped transactions| DB[(PostgreSQL)]
  DB --> GraphSnapshot[Immutable graph snapshot]
  DB --> Report[Immutable validation report]
```

The web tier obtains catalog content through the existing authenticated BFF. Project graph operations pass through the same signed-identity boundary as Phase 1. The API is authoritative for project ownership, current revisions, catalog release, graph structure, ruleset identity, and stored report digest. The browser may submit graph input, but it cannot submit trusted derived nets or validation findings.

The implementation remains a modular monolith. Catalog, graph, and validation are independently typed workspace packages, not network services. This keeps rule execution and graph writes transactionally close to the project revision while leaving package seams available for later service extraction. PostgreSQL stores immutable snapshots and stable digests; catalog releases ship with the application and are identified by their release ID and canonical SHA-256 digest.

### 2.1 Save and validate sequence

```mermaid
sequenceDiagram
  actor User
  participant Web as Web editor
  participant API as Fastify API
  participant Catalog as Pinned catalog package
  participant DB as PostgreSQL
  User->>Web: Edit terminals, placements, or wires
  Web->>API: PUT circuit + expected project revision + idempotency key
  API->>Catalog: Resolve release, terminals, holes, and rail variants
  API->>API: Validate graph structure; derive no submitted facts
  API->>DB: Lock project; check owner/revision; append graph snapshot and revision
  DB-->>API: Snapshot id, digest, committed revision
  API-->>Web: Saved snapshot and current project state
  User->>Web: Run checks
  Web->>API: POST validate + expected current revision
  API->>DB: Read latest graph snapshot and lock/check current revision
  API->>Catalog: Load exact immutable catalog release
  API->>API: Derive nets and deterministic findings
  API->>DB: Append immutable report tied to graph, catalog, ruleset, validator
  DB-->>API: Report digest and current flag
  API-->>Web: Findings, sources, status, and current flag
```

The validation request has no graph body: it evaluates the latest persisted graph for the project. The expected project revision is checked both before rule execution and under the persistence transaction when saving. This prevents a graph or report computed from an old project revision from being committed as current after a concurrent project mutation. Reports from a graph that is no longer current remain inspectable and are marked `current: false`.

## 3. Catalog release

The current release ID is `schemora-hw-2026.10`, status `curated`, publication date `2026-10-13`. Releases are parsed against strict Zod schemas and the catalog digest is computed from canonical JSON (object keys sorted recursively; arrays retain order). A change to a source fact creates a release change and a new digest; existing graph snapshots continue to name their original release ID.

### 3.1 Supported identities

| Catalog ID                                        | Exact identity                                                          | Modeled facts                                                                                                                    | Important boundary                                                                                                                                   |
| ------------------------------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `board.espressif.esp32-devkitc-v4.wroom-32e.male` | Espressif ESP32-DevKitC V4 fitted with ESP32-WROOM-32E and male headers | GPIO19 / printed `IO19` at J3 position 8; GND at J3-1 and J3-7; 3V3 at J2-1; documented supply input alternatives                | Other module configurations, WROOM-32UE, WROVER, clones, revisions, header styles, GPIO design current, and full board power budget are not inferred |
| `led.kingbright.wp7113id`                         | Kingbright WP7113ID, 5 mm high-efficiency red through-hole LED          | Stable anode/cathode terminal IDs; forward-voltage figures at 10 mA; maximum DC current and dissipation values as catalog facts  | No complete I–V curve, thermal design, lead-length inference, flat-side heuristic, or authenticity test                                              |
| `resistor.yageo.cfr-25jb-52-220r`                 | YAGEO CFR-25JB-52-220R axial carbon-film resistor                       | 220 Ω, ±5%, 0.25 W; two non-polarized terminals                                                                                  | Rating alone does not prove circuit suitability; working voltage, derating, and operating conditions remain unmodeled                                |
| `breadboard.busboard.bb400` topology v1           | BusBoard BB400 white or BB400T transparent physical variants            | 400 tie points: 60 five-hole terminal groups and four continuous 25-hole rail groups; hole naming, pitch, and outline dimensions | Only this topology is resolved. The user must confirm the exact board and rail identity; split rails and lookalike boards are unsupported.           |

### 3.2 Manufacturer provenance

| Source ID                                  | Publisher and document                                              | URL                                                                                                                 |
| ------------------------------------------ | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `espressif-devkitc-v4-guide`               | Espressif Systems, ESP32-DevKitC V4 User Guide                      | [Official guide](https://docs.espressif.com/projects/esp-dev-kits/en/latest/esp32/esp32-devkitc/user_guide.html)    |
| `espressif-wroom-32e-datasheet`            | Espressif Systems, ESP32-WROOM-32E / WROOM-32UE datasheet           | [Official module datasheet](https://documentation.espressif.com/esp32-wroom-32e_esp32-wroom-32ue_datasheet_en.html) |
| `kingbright-wp7113id-datasheet`            | Kingbright, WP7113ID product specification, V.14A                   | [Manufacturer datasheet](https://www.kingbrightusa.com/images/catalog/SPEC/WP7113ID.pdf)                            |
| `yageo-cfr-exact-part`                     | YAGEO, CFR-25JB-52-220R part specification                          | [Exact part specification](https://www.yageogroup.com/component-documentation/download/specsheet/CFR-25JB-52-220R)  |
| `yageo-cfr-datasheet`                      | YAGEO, CFR carbon-film resistor specification                       | [Series specification](https://yageogroup.com/content/datasheet/asset/file/YAGEO-CFR_DATASHEET)                     |
| `busboard-bb400-datasheet`                 | BusBoard Prototype Systems Ltd., BB400 product datasheet            | [Product datasheet](https://www.busboard.com/documents/datasheets/BPS-DAT-%28BB400%29-Datasheet.pdf)                |
| `busboard-bb400-rev6-internal-connections` | BusBoard Prototype Systems Ltd., BB400 internal connections drawing | [Manufacturer documentation](https://www.busboard.com/documents/datasheets/BPS-DAT-%28BB400%29-Datasheet.pdf)       |

The catalog detail screen shows source records and claim locators alongside the affected facts and lists the scope limitations. Source availability is not proof that a user's physical part is genuine or that their board matches the selected identity. The catalog page is an information view, not an automatic hardware detector.

### 3.3 Claim contract

Each catalog claim carries a subject ID, property, source ID, source locator, and qualification note; the supported value is represented on the strict subject record itself. Every `sourceId` must resolve inside the same release. Part records also carry source IDs and human-readable limitations. Where catalog facts do not support a rule, the rule returns `unknown`; it must not substitute a typical value or a generic part-family fact.

This first release is a single bundled release, not a multi-release registry. The API returns the bundled release and returns not found for any other ID. The graph and report contracts pin release identity and digest, but retaining and serving superseded release content is an explicit gate before publishing a second catalog release or upgrading a project pinned to an older release.

## 4. Circuit graph and connectivity

The graph schema version is `1`. A graph names a project, the project revision at which it is intended to be committed, a catalog release, component instances, breadboard instances with topology versions and rail variants, terminal-to-hole placements, and explicit wire edges. IDs are semantic and stable within a graph. Display strings and unverified labels do not serve as terminal or hole identities.

```json
{
  "schemaVersion": 1,
  "id": "graph-id",
  "projectId": "project-uuid",
  "projectRevision": 8,
  "catalogReleaseId": "schemora-hw-2026.10",
  "components": [
    { "id": "board-1", "catalogPartId": "board.espressif.esp32-devkitc-v4.wroom-32e.male" },
    { "id": "led-1", "catalogPartId": "led.kingbright.wp7113id" },
    { "id": "resistor-1", "catalogPartId": "resistor.yageo.cfr-25jb-52-220r" }
  ],
  "breadboards": [
    {
      "id": "breadboard-1",
      "topologyId": "breadboard.busboard.bb400",
      "topologyVersion": 1,
      "railVariants": [{ "railGroupId": "rail-id", "variantId": "continuous" }]
    }
  ],
  "terminalPlacements": [],
  "wires": []
}
```

This is a contract example, not a complete electrically connected circuit. Production requests must include each required rail group variant from the pinned topology. The complete Zod schema rejects undeclared fields, malformed IDs, unsupported graph schema versions, impossible revisions, and oversized arrays. The graph validator additionally rejects duplicate IDs, missing catalog parts or terminals, unsupported topology/version pairs, unknown holes, duplicate terminal placements, occupied wire holes, invalid rail selections, and endpoint references to unknown components or breadboards. The optional Phase 3 `visualLayout` field stores bounded presentation-only X/Z positions and quarter-turn rotations; it does not participate in connectivity or electrical findings.

### 4.1 Net derivation

The graph package uses deterministic union-find over component terminals and breadboard holes. It joins only:

1. A terminal to its explicitly placed hole.
2. The two declared endpoints of a wire.
3. Holes in one catalog-defined five-hole terminal-strip group.
4. Holes in a selected catalog-defined rail connectivity set.

It does not use image pixels, physical proximity, overlap, wire color, coordinate distance, the web canvas, or a client-computed net list. Isolated catalog terminals remain explicit isolated nets. Each output net includes a deterministic ID, member terminal/hole references, wire IDs, and the catalog connectivity group references that caused breadboard joins.

### 4.2 Phase 1 review handoff

`mapReviewedConnectionCandidate` accepts only a confirmed review decision whose candidate identity matches the decision. Rejected, obsolete, superseded, unconfirmed, or mismatched candidates cannot be compiled. The adapter resolves each endpoint through a caller-supplied exact terminal/hole resolver; if either endpoint is unresolved it returns no wire. It never maps free-form labels directly to physical terminals or silently picks a similar part.

## 5. Deterministic validation contract

Ruleset ID is `schemora-phase2-basic-circuit`, ruleset version `1.0.0`; validator version is `0.1.0`. Each report records graph ID/revision/digest, project ID, catalog release ID/digest, ruleset and validator versions, overall status, and ordered findings. Each finding has a stable ID, rule ID/version, status, severity, message, affected entity IDs, and source IDs. Results are deterministically sorted and use canonical SHA-256 graph/catalog digests.

### 5.1 Supported checks

| Rule                     | Meaning                                                                                          | `pass` means                                                                                                                   | `fail` means                                                                                      | `unknown` means                                                                               |
| ------------------------ | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `GRAPH_INTEGRITY`        | Resolve the graph against the pinned catalog release and topology                                | Every structural reference resolves and declared topology rules hold                                                           | At least one structural reference or constraint is invalid                                        | The rule itself is deterministic; malformed request data is rejected before report creation   |
| `POWER_GROUND_SHORT`     | Detect one modeled conductive net containing a catalog-role power terminal and a ground terminal | No such modeled net is present                                                                                                 | A direct conductive net joins the modeled roles                                                   | The narrow model cannot detect unmodeled board internals or every indirect electrical fault   |
| `LED_POLARITY`           | Compare the LED's catalog-defined anode/cathode with a modeled source-to-ground orientation      | A scenario-enabled modeled source can reach the anode and the cathode can reach a ground through modeled resistor connectivity | The LED terminals share a net, or modeled source/ground routing demonstrates reversed orientation | The graph lacks complete orientation context or uses a terminal not enabled for this scenario |
| `LED_SERIES_RESISTOR`    | Examine directed modeled source-to-ground paths through the LED                                  | Every discovered modeled path through the LED contains a resistor                                                              | At least one modeled path through the LED bypasses all modeled resistors                          | No complete modeled source-to-ground path through that LED can be established                 |
| `ELECTRICAL_SCOPE_LIMIT` | Report the coverage boundary                                                                     | Never returns pass                                                                                                             | Never asserts a failure                                                                           | Always unknown, with warning severity                                                         |

Electrical graph failures are not rejected by the graph-save endpoint; they are durable design state that the validation report should explain. Structural graph errors are rejected because a report against unresolved terminal or hole identities would be misleading. A report with unsupported safety limits remains `unknown` even when all selected checks pass.

### 5.2 Non-claims and known limits

The ruleset does not calculate current, voltage drop, power, resistor derating, LED current from a GPIO, aggregate GPIO load, supply regulator margin, AC response, capacitance/inductance, thermal behavior, transient conditions, ESD, reverse breakdown, component tolerance propagation, motor/load behavior, source authenticity, physical insertion, solder quality, or compliance. A role named `gpio` can represent an intended drive endpoint, but the graph does not prove firmware configures it as output or establish its current capability. The ESP32 module operating supply is not a development-board power budget. `pass` means only the exact rule wording passed for the modeled graph.

## 6. API and persistence

All routes are behind the existing authenticated API and project-ownership checks. The web BFF forwards only explicit catalog and project operations, including graph writes through `PUT`; it does not expose arbitrary API paths.

| Method and path                                  | Purpose                                                        | Revision/idempotency behavior                                                                                                                      |
| ------------------------------------------------ | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/catalog`                                | List published release metadata and part summaries             | No mutation; authenticated                                                                                                                         |
| `GET /v1/catalog/:releaseId`                     | Return one full immutable release, claims, sources, and digest | Unknown release returns not found                                                                                                                  |
| `GET /v1/projects/:projectId/circuit`            | Read latest graph snapshot and project state                   | Owner-scoped; returns `graphSnapshot: null` before the first graph is saved                                                                        |
| `PUT /v1/projects/:projectId/circuit`            | Save graph snapshot                                            | Requires idempotency key and expected revision; graph revision must be expected revision + 1; release, project, and structure must resolve         |
| `POST /v1/projects/:projectId/circuit/validate`  | Validate latest persisted graph                                | Requires current expected project revision; deterministic report identity includes graph snapshot, catalog digest, ruleset, and validator versions |
| `GET /v1/projects/:projectId/circuit/validation` | Read latest report for current graph                           | Returns report and `current` state; an older graph report is never presented as current                                                            |

Migration `0005_circuit_graphs.sql` introduces `circuit_graph_snapshots` and `validation_reports`. Graph snapshots carry the canonical graph JSON/digest, actor, project revision, idempotency key, and request digest. Validation reports carry graph snapshot identity, expected project revision, actor, full input identity and digest, report JSON/digest. Both tables are update-protected by database triggers, use project-scoped foreign keys, and cascade consistently with project deletion. Uniqueness protects one graph per committed project revision and one report per graph/input identity.

Graph save locks the owner-scoped project, replays an identical idempotency request, rejects key reuse with a different request, verifies the expected revision, inserts an immutable graph snapshot, increments the project revision once, and records revision metadata. Validation persistence locks the project and checks the current expected revision plus graph identity in the same transaction. An identical validation identity/report can be replayed by its unique graph/input identity; a changed report for the same deterministic identity is rejected as an idempotency conflict.

## 7. Browser experience

The `/catalog` route provides search and category filters for exact board/component records, a detail panel, source citations/claim locators, warnings and limitations, board pin index, release identity/digest, and a visual representation of the BB400 internal connectivity. Exact model details are explicitly distinguished from user-owned hardware identification. The UI does not display a green “safe” state.

The `/projects/:projectId/circuit` route reads the saved graph and latest report, offers catalog terminal selectors and optional BB400 hole placement, handles optimistic revision conflicts, and renders rule findings with sources and current/stale state. It displays a scope warning before a user runs rules. The Phase 3 3D workbench adds graph wire and illustrative layout controls over this semantic editor; it does not add arbitrary component authoring, firmware execution, or analog simulation.

## 8. Security and operational behavior

- Catalog reads pass through the existing BFF session and API signed principal; no API signing secret enters browser JavaScript.
- Every graph/report access is scoped to the authenticated project owner in persistence.
- Circuit payloads are strict schemas with bounded object counts and a bounded API body size.
- Catalog and report digests use canonical JSON, not client-provided hashes.
- Graph writes and report writes use project-row locking, optimistic revision checks, and idempotency keys.
- Immutable graph/report rows preserve what was checked and prevent silent mutation of historical evidence.
- Catalog source URLs are data links rendered with safe anchor attributes; no remote document content is executed or treated as instructions.
- API responses contain rule messages and IDs, not source conversation bodies or private object-storage URLs.
- Operational logs contain route, response status, timing, and request ID; circuit contents should not be added to logs.

## 9. Verification and handoff

Package test coverage checks catalog schema cross-references and sources; exact topology groups and rail variants; graph structural integrity, ID determinism, terminal/hole mapping, candidate-review gating; deterministic validation; LED polarity; series-resistor presence and bypass; power/ground shorts; scope-limited unknown state; API project authorization; idempotent graph save; stale revision rejection; stale report current-state behavior; and catalog API digest/details.

Run the relevant checks from repository root:

```sh
pnpm --filter @schemora/catalog typecheck
pnpm --filter @schemora/catalog test
pnpm --filter @schemora/circuit-model typecheck
pnpm --filter @schemora/circuit-model test
pnpm --filter @schemora/validation typecheck
pnpm --filter @schemora/validation test
pnpm --filter @schemora/api typecheck
pnpm --filter @schemora/web typecheck
```

Database-backed API and repository tests run through `pnpm test` with a separate `TEST_DATABASE_URL`; the bootstrap requires database-create permission and rejects a database that is not isolated with a `_test` name. The migration is additive and must be applied with `pnpm db:migrate` before starting an API instance using the new routes.

### 9.1 Executed verification

| Check               | Result                                                                                                                  |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `pnpm test`         | Passed: catalog 7, graph 6, validation 6, API/security/integration 31, web authentication 12, and intelligence 58 tests |
| `pnpm test:e2e`     | Passed: all 3 existing Chromium workspace workflows                                                                     |
| `pnpm typecheck`    | Passed across the root and workspace packages                                                                           |
| `pnpm build`        | Passed; `/catalog` and `/projects/[projectId]/circuit` compiled                                                         |
| `pnpm format:check` | Passed                                                                                                                  |
| `pnpm db:migrate`   | Applied `0005_circuit_graphs.sql` to the configured local development database                                          |

The first browser attempt ran before applying migration 0005 to the local development database. That attempt failed when Phase 1 project mutations encountered the not-yet-created circuit snapshot table. The migration was applied and the complete browser suite then passed; development setup now requires the migration step stated above.

### 9.2 Exit criteria for this implementation slice

1. All catalog facts used by a rule map to a source and exact catalog identity.
2. A graph can be saved only against the supported immutable release and current project revision.
3. Breadboard connectivity derives exclusively from explicit catalog topology and user-selected variants.
4. Validation is deterministic for equal graph, catalog, ruleset, and validator versions.
5. Electrical errors remain reviewable and are not mistaken for structural request rejection.
6. Unsupported electrical analysis remains explicitly unknown in every report.
7. A report for an older graph is never labelled current after the graph changes.
8. The browser exposes catalog provenance and supports saving/editing the starter graph and running its latest validation report.
9. `main` remains README-only; implementation and migration history remain on `dev`.

## 10. Change and release rules

Do not edit a published release in place after it has been consumed by a saved graph. Add a release with new identity and digest, keep the previous release available for historical resolution, and provide an explicit migration only when identity mappings have been reviewed. Changes to graph fields require a graph schema version or a backwards-compatible additive contract. Any change to rule semantics increments the ruleset version; any validator behavior build change increments the validator version. Tests must assert both expected findings and expected `unknown` boundaries so future expansions cannot silently imply certification.
