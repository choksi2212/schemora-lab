# Schemora — UI/UX Implementation Plan

**Document status:** Working delivery baseline for design and frontend implementation  
**Version:** 1.0  
**Last reviewed:** 13 October 2026  
**Product surface:** Desktop-first web application  
**Product authority:** [PRD.md](PRD.md)  
**Technical authority:** [TRD.md](TRD.md)  
**System deployment and scale strategy:** [System-Design.md](System-Design.md)  
**Backend delivery plan:** [Backend-DB-Implementation-Plan.md](Backend-DB-Implementation-Plan.md)

## Document control

| Field | Value |
|---|---|
| Owner | Product design and frontend engineering (named owners to be assigned) |
| Audience | Product, design, frontend, backend, hardware catalog, QA, and support |
| Status | Implementation baseline; open decisions are called out explicitly |
| Change rule | Product behavior changes are reconciled with the PRD; API and data changes with the TRD |
| Review cadence | At each phase exit and when a core workflow or trust state changes |

## Contents

1. [Purpose and boundaries](#1-purpose-and-boundaries)
2. [Experience outcomes and design principles](#2-experience-outcomes-and-design-principles)
3. [Users, tasks, and evidence](#3-users-tasks-and-evidence)
4. [Information architecture](#4-information-architecture)
5. [End-to-end journey](#5-end-to-end-journey)
6. [Screen inventory and specifications](#6-screen-inventory-and-specifications)
7. [Workbench interaction model](#7-workbench-interaction-model)
8. [State, feedback, and recovery](#8-state-feedback-and-recovery)
9. [Visual system and reusable components](#9-visual-system-and-reusable-components)
10. [Accessibility and input alternatives](#10-accessibility-and-input-alternatives)
11. [Frontend architecture and data flow](#11-frontend-architecture-and-data-flow)
12. [Content and instructional voice](#12-content-and-instructional-voice)
13. [Responsive behavior and browser fallback](#13-responsive-behavior-and-browser-fallback)
14. [Usability and interface verification](#14-usability-and-interface-verification)
15. [Implementation phases and exit criteria](#15-implementation-phases-and-exit-criteria)
16. [Release gates and traceability](#16-release-gates-and-traceability)
17. [Open decisions](#17-open-decisions)

## 1. Purpose and boundaries

This plan turns the product and technical baselines into a practical design and frontend delivery sequence. It defines the information users need, the screens that carry the core workflow, the interactions that move a project from imported conversation to reviewed circuit, and the visible behavior required when facts are uncertain or operations fail.

The product workflow begins with an existing hardware conversation. The application imports it, reconstructs the proposed design with source evidence, lets the user resolve ambiguity, maps the confirmed design onto exact supported hardware, and guides the user through virtual assembly and a physical pre-power review. The first complete experience is intentionally bounded to a supported ESP32 development board and LED circuit.

This plan owns presentation, interaction, navigation, feedback, accessibility, and frontend integration. The PRD remains authoritative for product scope and user outcomes. The TRD owns API contracts, domain states, canonical graph and versioning, persistence, and technical architecture. The backend plan owns backend implementation order. If the UI needs a new state or field, the owning contract must be updated before the UI invents one.

### 1.1 Experience boundary

The interface can help a person understand and inspect supported circuit guidance. It cannot establish that an arbitrary physical design is safe, infer an exact hardware model from an ambiguous family name, or claim that a 3D representation proves electrical correctness. Visual confidence must never exceed the verification state represented by the system.

The first release is desktop-first. A semantic, keyboard-usable path must preserve core work even if 3D rendering is unavailable. Mobile optimization, photo-based recognition, broad simulation, and unrestricted hardware coverage are outside this plan unless separately authorized by product scope.

### 1.2 Source-of-truth relationship

| Concern | Authority | UI/UX responsibility |
|---|---|---|
| User problem, promise, scope, product requirements | PRD.md | Make the required outcomes understandable and achievable |
| API, graph, job, validation, catalog, and persistence contracts | TRD.md | Render contract states accurately; request changes through owning team |
| Deployment topology, reliability, and scale-out strategy | System-Design.md | Keep user-facing behavior coherent with service and data boundaries |
| Backend sequence and migration evidence | Backend-DB-Implementation-Plan.md | Coordinate screen dependencies with available capabilities |
| Layout, navigation, interaction, copy, and visual hierarchy | This document | Define and validate the interface implementation |

## 2. Experience outcomes and design principles

The interface succeeds when a novice can move from a conversation to a reproducible, supported build without having to guess what the product understood. Experienced makers should be able to inspect precise pins, provenance, and validation detail without being slowed by introductory explanations.

### 2.1 Principles

| Principle | Product behavior |
|---|---|
| Show what is known and how it is known | Candidate facts show source excerpts or user confirmation; catalog-verified facts carry an explicit verified status |
| Make correction local | A user can fix one component, pin, or connection without restarting the whole import |
| Keep the design and the scene in agreement | The 3D scene is a view of the selected graph revision, not an independent drawing surface |
| Explain actionable errors | Every blocking finding names the affected item, why it matters, and the next available correction |
| Let users choose explanation depth | Short guidance is the default; definitions and technical detail are available in context |
| Preserve user agency | Destructive or ambiguous changes are previewed, undoable where possible, and explicit about their effect |
| Use consistent terms | A pin, terminal, wire, breadboard row, and board model retain the same name across review, workbench, and assembly |
| Prefer useful clarity to realism | Scene styling supports orientation and connection reading; decorative detail never obscures terminals or state |

### 2.2 Experience measures

The team will establish baseline values through moderated sessions before treating a numeric threshold as a product promise. Instrumentation and research should measure completion and understanding together; a user who clicks through while misunderstanding a warning has not succeeded.

| Measure | Capture method | Segment or interpretation |
|---|---|---|
| Supported import completion | Product event plus session observation | Break down by file format and parser outcome |
| Correction effort | Count edited facts and connections before build readiness | Separate harmless naming edits from electrical corrections |
| Provenance comprehension | Ask participants to locate evidence for a selected extracted fact | Required before guidance depends on that fact |
| Build task completion | Observe a reference LED circuit task | Report novice and experienced users separately |
| Fault recovery | Introduce a wrong pin or missing wire and observe recovery | Report by known supported fault type |
| Confidence calibration | Ask how certain the user is and compare with system state | High confidence on unresolved facts is a failure signal |
| Accessibility task completion | Keyboard and assistive-technology task walkthroughs | Record barriers by task, not only automated scan totals |

## 3. Users, tasks, and evidence

The UI must support the different levels of confidence and vocabulary in the PRD’s user groups. The primary journey is designed for a beginner who has an AI-generated design but does not yet know how to translate it to a board. Experienced builders can use the same journey with compact explanations and direct access to technical details.

### 3.1 Primary tasks

| User need | User task | Evidence the UI must provide |
|---|---|---|
| Bring in a prior design | Select a supported export and start import | Accepted formats, privacy handling, processing progress, and retry route |
| Understand extraction | Compare proposed parts and connections with the conversation | Source message, candidate/confirmed state, conflicts, and editable values |
| Resolve ambiguity | Choose or supply a missing exact board or component | Why the choice is needed, supported candidates, and consequence of unresolved choice |
| Build virtually | Place and connect supported components | Exact endpoints, preview before commit, selected item identity, and graph status |
| Learn a step | Follow an ordered assembly instruction | One action, a visible target, plain-language reason, and optional terminology help |
| Repair a design | Find and correct a reported issue | Location in scene/list, severity, actionable remedy, and revalidation state |
| Transition to physical work | Review the completed circuit before touching hardware | Exact hardware identity, unresolved findings, and a deliberate pre-power checklist |

### 3.2 Representative acceptance scenarios

1. **Clean supported conversation:** User imports a conversation that specifies a supported exact board, LED, resistor, and pin. They review source-backed extracted facts, confirm the design, assemble the circuit, and reach the physical review with no hidden unresolved facts.
2. **Conflicting instructions:** Conversation contains an earlier pin and a later replacement. The UI shows both claims with their source positions, proposes the later claim as a candidate only when the extraction contract marks it as superseding, and requires user confirmation if the interpretation remains uncertain.
3. **Board family only:** Conversation says “ESP32” without an exact board. User sees why physical pin placement cannot yet be generated, selects from supported models using visible distinguishing information, or saves the project as unresolved.
4. **Incorrect connection:** User connects to the wrong GPIO. Validation links the finding to the wire and pin in both the list and scene, explains the correction, and reruns against the changed graph revision.
5. **3D unavailable:** Browser cannot render the scene or user prefers a semantic list. They can inspect and operate the circuit using a structured component and connection view and complete all non-3D core tasks.

## 4. Information architecture

Navigation follows the project’s lifecycle rather than exposing internal services. The persistent project shell provides orientation and recovery; each workflow stage owns a clear primary action and displays what is blocking the next stage.

~~~mermaid
flowchart TD
  Home[Projects home] --> New[New project / import]
  New --> Progress[Import status]
  Progress --> Review[Conversation and extraction review]
  Review --> Resolve[Resolve design facts]
  Resolve --> Model[Select exact supported hardware]
  Model --> Bench[Workbench]
  Bench --> Check[Validation review]
  Check --> Bench
  Check --> Steps[Assembly steps]
  Steps --> Ready[Physical pre-power review]
  Review --> History[Project revisions]
  Bench --> History
  Ready --> History
~~~

### 4.1 Navigation rules

- **Projects home** lists recent projects, current stage, last saved time, and any blocking status. The primary action is “New project” or “Continue project,” depending on context.
- **Project navigation** shows the lifecycle stages and marks each as not started, in progress, ready, blocked, or complete. It does not present a future stage as complete just because it has been visited.
- **Stage navigation** allows return to prior stages. Returning to a design review that changes graph-defining facts must visibly invalidate downstream validation and assembly state according to the domain contract.
- **Global utilities** include help, account/session controls, and accessibility/appearance preferences if supported. These remain outside the workbench canvas.
- **No orphan screens:** Errors, unsupported formats, empty states, and interrupted jobs always provide a route back to the project or a meaningful recovery action.

## 5. End-to-end journey

The interface presents progress in user terms. Technical job status may exist in system events, but the user sees the current activity and the next meaningful action. Processing is asynchronous; users can leave and return without losing the project.

~~~mermaid
sequenceDiagram
  actor User
  participant UI as Web interface
  participant API as Project API
  participant Worker as Import and extraction workers
  participant Catalog as Hardware catalog
  User->>UI: Choose conversation file
  UI->>API: Create import and upload
  API-->>UI: Project and processing state
  API->>Worker: Parse and extract
  Worker-->>API: Normalized conversation and candidates
  API-->>UI: Review is ready / needs attention
  User->>UI: Inspect evidence and confirm or edit facts
  UI->>API: Save reviewed design revision
  UI->>Catalog: Request supported exact model choices
  User->>UI: Confirm hardware and inspect workbench
  UI->>API: Apply graph commands and request validation
  API-->>UI: Current graph and validation revision
  User->>UI: Follow assembly and pre-power review
~~~

### 5.1 Stage transition contract

Each stage has: a concise purpose, a visible completion condition, a blocker explanation, and a safe way to return. The stage header should state “what you are doing” and “what is needed to continue.” Avoid percentage-complete displays unless the underlying operation has a meaningful measurable denominator.

| Transition | Required user understanding | Continue condition |
|---|---|---|
| Import → review | The file was accepted and the system found content to review | Parsing completed with a readable conversation or a recoverable failure |
| Review → hardware selection | Extracted facts and unresolved questions are visible | Required design facts confirmed or explicitly left unresolved |
| Hardware selection → workbench | Exact model identity and supported status are known | Model is catalog-supported and required asset/terminal mapping is available |
| Workbench → validation | Current graph revision is saved or clearly marked unsaved | Validation can run against a stable revision |
| Validation → assembly | Blocking findings are resolved or the product explicitly permits a limited review state | Required graph and catalog conditions pass |
| Assembly → physical review | Steps completed or intentionally skipped are visible | Physical handoff checklist presented with all unresolved state retained |

## 6. Screen inventory and specifications

The inventory is the minimum screen set for the initial release. A screen may be a route or a state within a route; routing is an implementation decision so long as browser history, deep links, and return behavior remain predictable.

| ID | Screen | Main user decision/action | Required states |
|---|---|---|---|
| UI-S01 | Projects home | Start or resume a project | Empty, loading, populated, load error |
| UI-S02 | Import setup | Choose a file and understand processing | Empty selection, unsupported file, upload progress, upload failure |
| UI-S03 | Import progress | Wait, leave, or retry | Queued, parsing, extracting, needs attention, complete, failed, cancelled |
| UI-S04 | Conversation and design review | Confirm, edit, or question extracted facts | Candidate, confirmed, conflict, missing evidence, unsupported |
| UI-S05 | Hardware selection | Select an exact catalog model | Search, no results, candidate comparison, selected, unavailable |
| UI-S06 | Workbench | Inspect and edit supported circuit | Loading, ready, unsaved, saving, validation stale, render fallback, error |
| UI-S07 | Validation review | Understand and resolve findings | No findings, advisory, blocking, stale, service failure |
| UI-S08 | Assembly guide | Complete or revisit ordered actions | Ready, active, complete, blocked, skipped, stale after graph change |
| UI-S09 | Physical review | Verify conditions before physical assembly | Checklist incomplete, review ready, unresolved caveat |
| UI-S10 | Revision/history | Compare or restore project versions | Empty, current revision, prior revisions, restore confirmation |
| UI-S11 | Account/preferences/help | Adjust supported preferences and get help | Signed out/in, save failure, accessible help |

### 6.1 UI-S01 — Projects home

The home screen helps the user resume work, not interpret backend machinery. Each project row or card includes its name, stage, last saved time in user-local format, and a concise blocker or next action. A new user sees the supported import formats and one clear start action. A returning user sees the most recent project first while retaining access to all projects.

Empty state copy explains that a conversation can be imported and that only supported hardware receives exact assembly guidance. A project that needs attention surfaces the reason in plain language; the user should not need to open each card to find a failed import.

### 6.2 UI-S02 and UI-S03 — Import setup and progress

The setup screen names supported formats, size limits, and what is done with the uploaded file using the privacy language approved by the product. Drag and drop may supplement a standard file picker, never replace it. Before upload, the user can see the selected file name and remove it.

Progress identifies the current human-readable activity, such as “Reading conversation” or “Finding parts and connections.” The screen supports navigation away and return. When processing needs attention, it states whether the file is unreadable, empty, unsupported, or only partially understood. Retry does not silently create duplicate projects.

### 6.3 UI-S04 — Conversation and design review

This screen is the trust checkpoint between probabilistic extraction and a versioned design. Use a two-pane layout on wide displays: conversation evidence on one side and structured design facts on the other. Selecting a fact highlights its source message or says plainly that no source evidence was found. The conversation remains readable and searchable; large transcripts should not be collapsed into a tiny preview.

Facts are grouped by role: board, components, connections, firmware references, and unresolved questions. Each fact shows its current status, value, provenance, and edit affordance. The UI distinguishes candidate, user-confirmed, catalog-verified, and rule-checked states as defined by the TRD. Do not use one generic green “verified” badge for these different meanings.

Conflicting claims appear together with source order and enough surrounding text to understand the difference. If the system cannot determine whether a later message supersedes an earlier one, ask the user to choose or leave it unresolved. A user can save a partial review and return later. Continue to hardware selection is disabled only when a contract-defined required fact is missing; the reason and resolution path remain visible.

### 6.4 UI-S05 — Hardware selection

When the conversation names a family rather than an exact model, explain the practical consequence: pin positions and board outline vary, so the guide needs the exact board. Search results show manufacturer, exact model name, and distinguishing visual/technical attributes supplied by the catalog. Board images are aids, not sole identifiers. The user can compare candidates and return to the extracted evidence.

Only catalog-published supported models can proceed to exact physical guidance. Unsupported or unavailable results remain searchable as information where the product contract permits, but they cannot be selected as if support existed. Any manual selection is recorded as user-confirmed and remains distinct from an extracted claim.

### 6.5 UI-S06 — Workbench

The workbench is the primary construction surface. It combines a 3D scene, project/design context, connection or assembly information, and validation summary without forcing the user to memorize hidden panel state. The active design revision and save state remain visible. Users can switch to the semantic connection list at any time.

Initial layout proposal for wide desktop:

~~~text
+-----------------------------------------------------------------------+
| Project / stage trail                 Save state     Help / account   |
+------------------+-----------------------------------+----------------+
| Design and parts |                                   | Inspector      |
|                  |          3D workbench             | selected item  |
| Components       |    board / breadboard / wires      | pin details    |
| Connections      |                                   | actions        |
| Assembly steps   |                                   |                |
+------------------+-----------------------------------+----------------+
| Validation summary / actionable findings                             |
+-----------------------------------------------------------------------+
~~~

Panel widths, collapse behavior, and default pane selection must be validated at the supported desktop viewport. The scene cannot be squeezed until connection endpoints become hard to target. On smaller supported widths, secondary panels become drawers or tabs and maintain a visible indication of findings and unsaved work.

### 6.6 UI-S07 — Validation review

Findings are grouped by blocking status and then affected object. Each finding includes: a short title, what was observed, why it matters, the object or endpoints involved, and an available action. “Fix” must not imply an automatic safe repair if the correct answer depends on user intent. A result is tied to a graph revision; any graph change marks it stale until rerun.

The screen distinguishes a rule check from a physical safety guarantee. The user sees what the validator covers and can inspect unsupported or unmodeled conditions. A service error is not shown as “passed” or “no issues.”

### 6.7 UI-S08 — Assembly guide

Show one primary action per step, with a clear position in the sequence, a close visual target, endpoint names, and a short reason. Provide previous/next controls and a step list for orientation. Completing a step changes its state only after the user marks it complete or the product receives an explicit supported completion signal; merely viewing a step does not count.

When a step is blocked, say which prior condition is missing. If a graph edit invalidates steps, mark affected steps stale and explain that the sequence needs review. Users can return to the workbench without losing their place when the design remains unchanged.

### 6.8 UI-S09 — Physical pre-power review

This screen is a deliberate handoff from a virtual guide to physical work. It repeats the exact board and relevant component identities, summarizes the latest validation revision, and presents the product-defined checklist from the PRD. Unresolved facts and advisory findings remain visible. Completion means the user acknowledged the listed checks; it is not a certification of safety.

### 6.9 UI-S10 and UI-S11 — History, preferences, help

Revision history shows when the design changed and which downstream results became stale. Restoration is explicit and explains that it creates or activates a prior revision according to the domain contract. Preferences do not hide critical state or remove accessible alternatives. Help is contextual: terminology opens definitions near the current pin, component, or finding, with a route to fuller learning material if available.

## 7. Workbench interaction model

The workbench provides discoverable operations with pointer, keyboard, and semantic-list paths. Exact gestures must be tested with target users; users should not be required to discover a hidden modifier-key combination to complete the core build.

### 7.1 Core operations

| Operation | Interaction contract | Required feedback |
|---|---|---|
| Select component | Click/tap target or choose it from the component list | Selection highlight, exact identity, inspector content, keyboard equivalent |
| Inspect pin/terminal | Select a visible endpoint or its semantic list entry | Pin name, capability if relevant, owning component, focus remains predictable |
| Create wire | Start from a valid endpoint, preview destination, select valid endpoint, review and commit | Live endpoint labels, preview distinct from saved wire, invalid destination explanation |
| Move/place part | Use explicit move mode or handle; preview position before committing | Placement preview, collision/constraint feedback if modeled, cancel and undo |
| Remove connection | Select wire, invoke remove, confirm when consequence is material | Affected endpoints named; operation undoable where supported |
| Navigate scene | Orbit, pan, zoom through visible controls and documented pointer gestures | Reset view and focus/selection remain available |
| Undo/redo | Visible controls and standard keyboard shortcut where safe | Action label and state updates; unavailable states disabled with accessible name |
| Switch representation | Choose 3D scene or connection list | Same graph revision and selection reflected in both views |

### 7.2 Wire creation and editing

The interaction must distinguish a preview from a committed connection. During creation, the start endpoint remains labeled, the pointer line is visibly provisional, and valid targets are presented without relying only on color. On commit, the connection appears in the list and scene under the same graph revision. If the command fails, restore the previous state and explain whether the graph remained unchanged.

Users must be able to create or inspect a connection through a form/list-based alternative. That alternative uses endpoint selectors with exact component and terminal names. It is not a reduced “text mode” that hides constraints or validation findings.

### 7.3 Selection and inspector behavior

Selection is shared between scene, component list, connection list, assembly guide, and validation findings. Selecting a finding selects or focuses the associated object when possible. The inspector always names the selected object and offers relevant actions; it should not repurpose a generic panel without a heading. Closing or changing a panel does not silently discard a draft operation.

### 7.4 Camera and scene controls

Provide visible orbit, pan, zoom, fit-to-design, and reset controls, with sensible defaults that keep the selected board and connections in frame. Avoid camera movement on selection unless the user explicitly asks to focus. Reduced-motion preference disables nonessential animated transitions. A reset view must not reset circuit state.

## 8. State, feedback, and recovery

All visible states derive from domain state or explicitly transient interaction state. The design must not create a locally convenient status that disagrees with server state. Label saves as saving, saved, unsaved, or failed; do not use a generic spinner as the only indication.

### 8.1 State presentation map

| Domain state | UI treatment | User action |
|---|---|---|
| Candidate fact | Neutral label; source and confidence context visible | Confirm, edit, or leave unresolved |
| User-confirmed fact | Confirmed by user, with edit history where relevant | Review or change |
| Catalog-verified fact | Catalog source/release indicated | Inspect detail; do not imply physical testing |
| Rule-checked result | Rule-check label and revision/time context | Inspect findings or rerun after change |
| Unknown or unsupported | Plain-language explanation and affected task | Provide information, choose supported option, or save unresolved |
| Stale validation/assembly | State the design changed since result was produced | Revalidate or regenerate affected work |
| Unsaved graph mutation | Persistent unsaved indicator and pending action context | Save, undo, or resolve conflict |
| Failed request | Preserve recoverable input and identify retry/edit path | Retry or return safely |

### 8.2 Save, concurrency, and job feedback

The frontend must display the current project revision and handle a server conflict as a user-visible decision, not an opaque retry loop. When a save is rejected because the base revision changed, preserve the local edit and show the conflicting state with options defined by the API contract. Never silently overwrite another saved revision.

For asynchronous work, keep the job state visible after navigation. Provide a refresh/reconnect path if event delivery is interrupted and obtain authoritative current state from the API. A lost event connection must not be represented as completed processing.

### 8.3 Error language

Error messages follow a compact structure: what failed, what the user can do, and whether their work is safe. Avoid provider, database, parser stack, and raw API details in user-facing text. Support diagnostics can expose a correlation identifier without exposing private conversation content.

## 9. Visual system and reusable components

Build a small token set before screen-specific styling. The initial visual direction is a calm engineering workspace: strong hierarchy, readable surfaces, clear object selection, and restrained color reserved for meaningful status. This is a direction to validate, not an approved brand palette.

### 9.1 Token decisions to define

| Token family | Required variants | Usage rule |
|---|---|---|
| Color | Surface, text, border, focus, selected, success, warning, error, informational | Status always has text/icon or shape in addition to color |
| Typography | Display, page title, section title, body, label, code/value, helper | Pin names and code retain legibility at default zoom |
| Spacing | Base spacing scale and panel gutters | Consistent alignment across review, workbench, and lists |
| Shape | Control, card, panel, overlay radii | Avoid excessive rounding that weakens dense technical layouts |
| Elevation | Base surface, floating panel, modal | Use to clarify layering, not decoration |
| Motion | Duration and easing tokens plus reduced-motion behavior | No motion required to understand a status or complete a task |
| Focus | Visible keyboard focus ring for every interactive control | Never remove browser focus without equivalent treatment |

### 9.2 Component inventory

Implement reusable components for project stage navigation, status chip with label, evidence reference, fact editor, conflict resolver, exact hardware result card, connection row, pin/terminal selector, validation finding, assembly step, save state, upload drop zone, empty/error state, accessible dialog, tooltip/help disclosure, and scene fallback selector. Components should consume typed domain view models and avoid embedding API calls in visual primitives.

The shared design system should use accessible primitives from the selected UI stack where practical. Any custom control that behaves like a standard checkbox, tab, combobox, tree, or dialog must match the expected keyboard and assistive-technology behavior.

## 10. Accessibility and input alternatives

Accessibility is part of each task path, not a separate page. The team should target WCAG 2.2 AA behavior for the supported application scope and verify that target against the current standard during implementation. Automated scans support but do not replace keyboard, screen-reader, zoom, and task-based review.

### 10.1 Required behavior

- All workflows are operable by keyboard, including file choice, review, model selection, workbench editing, validation, and assembly progression.
- Focus order follows the visual task order. Modal dialogs manage focus on open and restore it on close. Async results are announced without moving focus unexpectedly.
- Status and selection use labels, icons, patterns, or text as well as color. Contrast and focus visibility are checked in all status variants.
- The 3D canvas has an accessible name, concise instructions, and a semantic equivalent that exposes components, endpoints, connections, and findings.
- Screen-reader users can locate the same connection endpoints and validation associations available visually. Dynamic updates announce the affected item and result succinctly.
- Text remains usable under browser zoom and increased text spacing; critical actions do not disappear behind fixed panels.
- Motion respects the user’s reduced-motion setting. The interface does not use flashing or scene animation as the only way to communicate a change.
- Help content defines domain language at point of use and can be dismissed without losing task context.

### 10.2 Semantic alternative to the canvas

The connection list is a first-class representation backed by the same graph. It exposes a hierarchical or tabular view of components, terminals, wires, and validation state. Selecting an item updates scene selection when available. Editing in either view updates the same design revision. If 3D fails, the list remains fully usable and the user receives a clear explanation and recovery option.

## 11. Frontend architecture and data flow

Use the TRD baseline: Next.js, React, TypeScript, Tailwind/shadcn UI, Three.js through React Three Fiber/Drei, Zustand for transient interface state, and Zod/shared types at data boundaries. This plan does not alter the backend’s modular monolith or canonical domain model.

### 11.1 Ownership boundaries

| Data/state | Owner | Examples |
|---|---|---|
| Canonical project and design | API/domain | Confirmed facts, graph revision, catalog release, validation, assembly plan |
| Transient interaction | Browser | Hover, selection, camera pose, open panel, active tool, provisional wire |
| Pending mutation | Browser until accepted | Command payload, optimistic render, retry state, conflict resolution context |
| Derived presentation | Frontend selectors | Grouped findings, labels, stage readiness, visible scene objects |
| Hardware geometry and anchors | Versioned catalog asset | Mesh, terminal anchor, asset release metadata |

### 11.2 Mutation lifecycle

1. User performs an explicit operation and the UI builds a typed domain command.
2. The client validates shape and local interaction constraints for immediate feedback; this is not authoritative electrical validation.
3. UI marks the affected object pending and sends the command with the base revision/idempotency data required by the API contract.
4. On success, replace or reconcile optimistic state with the canonical response and its new revision.
5. On rejection, restore the prior canonical view, preserve user input where possible, and show a specific correction path.
6. Validation and assembly outputs are invalidated or refreshed only according to server version semantics.

### 11.3 3D rendering boundary

The rendering layer maps catalog component IDs, terminal IDs, and asset anchors to visible geometry. It does not determine connectivity based on mesh overlap or wire appearance. The scene subscribes to a normalized view model keyed to a graph revision. Missing assets produce a labeled placeholder and semantic-list access, not a guessed model.

## 12. Content and instructional voice

Use direct, concrete language. Address the user as “you.” Define technical terms briefly at first relevant use and allow experienced users to dismiss or collapse explanation. Keep labels stable across the transcript, design review, workbench, findings, and assembly guide.

### 12.1 Copy patterns

| Situation | Recommended pattern | Avoid |
|---|---|---|
| Missing exact board | “Choose the exact ESP32 board so we can show the correct pin locations.” | “Invalid device” |
| Candidate fact | “The conversation suggests GPIO 18. Confirm this pin before continuing.” | “GPIO 18 verified” |
| Validation issue | “This wire ends at GPIO 19, while the reviewed design uses GPIO 18.” | “Circuit failed” |
| Stale check | “The design changed after this check. Run validation again.” | “Validation complete” |
| Unsupported detail | “We don’t have a reviewed model for this board yet. You can keep the design saved, but exact placement steps are unavailable.” | A generic unsupported error |
| Physical handoff | “Review these connections before powering the board.” | “Your circuit is safe” |

Avoid declaring “correct,” “safe,” “verified,” or “complete” without a precisely defined domain state. Where space is limited, preserve the object and action; place background explanation in an expandable detail.

## 13. Responsive behavior and browser fallback

The initial supported experience targets laptop and desktop widths. At wide widths, the workbench shows scene and two side panels. At narrower supported desktop widths, the inspector and design panel can collapse into tabbed drawers, while stage, save state, and issue count remain visible. The exact minimum viewport is a release decision tied to browser support and usability evidence.

If WebGL or asset loading fails, preserve the project shell and switch the central region to the semantic connection view. Explain the condition and provide retry. Do not block import review, fact correction, validation reading, or assembly steps merely because the 3D canvas is unavailable. Browser compatibility guidance is limited to the supported browser matrix in the PRD/TRD.

## 14. Usability and interface verification

Research and QA should verify whether people understand the interface and the system’s limits. Use realistic conversation files and exact catalog hardware. Test a novice user without prior prompting; separately test an experienced user’s ability to inspect detailed facts efficiently.

### 14.1 Formative study tasks

1. Import a supplied conversation and identify what the system believes the design contains.
2. Find the source of a pin assignment and decide whether to confirm it.
3. Resolve a board-family ambiguity using catalog model details.
4. Add a wire in the workbench and find it in the semantic list.
5. Correct an injected wrong-pin issue after reading the finding.
6. Continue through assembly and explain what the pre-power review does and does not claim.
7. Complete the equivalent tasks with keyboard and the non-3D representation.

### 14.2 Evidence and defect handling

Record task completion, hesitation, wrong turns, requests for help, interpretation of trust labels, and observed recovery. Attach each issue to a screen, state, user impact, and reproducible fixture. Prioritize defects that cause silent misunderstanding, unsafe overconfidence, data loss, blocked core task, or inaccessible operation before visual polish issues.

Automated component checks and end-to-end browser flows should cover every acceptance scenario. Manual review includes keyboard-only use, screen-reader spot checks, zoom/reflow, contrast, reduced motion, and WebGL failure. The test approach belongs in the TRD verification strategy; this section defines what interface behaviors must be evidenced.

## 15. Implementation phases and exit criteria

Phases align to the PRD journey and backend plan. Work can overlap where contracts are stable, but screen implementation must use agreed API/domain shapes. Each phase produces reviewable artifacts and a tested user path.

| Phase | Scope | Deliverables | Exit evidence |
|---|---|---|---|
| UI-0: Workflow and design foundation | Confirm terms, stage model, viewport, wireframes, tokens, content rules | Journey map, screen flows, design tokens, component foundations, interaction prototypes | Product/design/engineering review resolves blocking interaction questions |
| UI-1: Project shell and import | Home, import setup, progress, recoverable job states | Responsive shell, upload states, job status, empty/error patterns | User can start import, leave, return, and recover from supported failures |
| UI-2: Evidence and design review | Transcript, candidate facts, provenance, conflicts, partial save | Review screens, fact editing, source navigation, ambiguity handling | Acceptance scenarios for clean and conflicting conversations complete |
| UI-3: Catalog and workbench | Exact model choice, scene, semantic list, selection, wire editing | Catalog cards, workbench layout, 3D asset mapping, fallback | A reference circuit can be inspected and edited in both representations |
| UI-4: Validation and assembly | Findings, stale state, step guide, pre-power review | Validation panel, assembly progression, physical review | Injected fault is understood and recoverable; unsupported claims are absent |
| UI-5: Accessibility and release hardening | Keyboard, assistive technology, responsive, failure and performance review | Audit evidence, defect closure, help content, release checklist | All blocking UI gates in §16 have evidence and named owner signoff |

### 15.1 Design and engineering handoff package

Before implementation of each stage, provide: user goal, entry conditions, screen/state map, responsive behavior, interaction notes, copy for primary/error/empty states, accessibility notes, source contract fields, acceptance scenarios, and unresolved decisions. Handoff is complete when frontend can implement without inventing domain semantics and QA can determine pass/fail from observable behavior.

## 16. Release gates and traceability

Release readiness is demonstrated with evidence tied to the product requirements and technical contracts. A screen that renders successfully is not sufficient when its trust state, recovery path, or accessible alternative is absent.

### 16.1 UI acceptance gates

| Gate | Pass condition | Evidence |
|---|---|---|
| UI-G1 Journey continuity | User can move from project creation through physical review without an orphan state | End-to-end supported reference task |
| UI-G2 Provenance | Every extracted fact used in assembly can be traced to source evidence or user confirmation | Review fixture audit and user task observation |
| UI-G3 Exact hardware | Physical guidance is unavailable until an exact supported model is selected | Family-only and unsupported-model scenarios |
| UI-G4 Revision honesty | Validation and assembly identify stale outputs after design change | Graph mutation walkthrough and API revision evidence |
| UI-G5 Recovery | Failed upload, job, save, and render paths preserve user context and offer recovery | Failure injection walkthrough |
| UI-G6 Semantic parity | Core inspection/editing tasks work without 3D rendering | WebGL-disabled task completion |
| UI-G7 Accessible operation | Core tasks work by keyboard and expose equivalent structure to assistive technology | Manual accessibility task record and automated findings |
| UI-G8 Physical boundary | Interface does not present validation as a safety certification | Copy review and release screen audit |
| UI-G9 User comprehension | Participants can explain candidate, confirmed, catalog, and rule-check distinctions | Moderated comprehension evidence |

### 16.2 Traceability

| Product requirement area | UI coverage |
|---|---|
| PRD core journey and workflow states | §§4–8 |
| PRD import, review, ambiguity, and recovery | §§5–6, §8 |
| PRD desktop workbench and interaction | §§6–7, §13 |
| PRD progressive explanation and accessibility | §§2, 9–10, 12 |
| PRD trust, correctness, and safety boundary | §§1, 6, 8, 12, 16 |
| TRD graph/versioning and API state | §§8, 11 |
| TRD catalog assets and rendering | §§6, 7, 11 |
| TRD verification and performance | §§13–16 |

## 17. Open decisions

These decisions require product or engineering evidence before the affected UI is treated as final. Owners should record the resolution in the source document that governs the decision and then update this plan.

| ID | Decision | Needed before | Suggested evidence |
|---|---|---|---|
| UX-D1 | Minimum supported desktop viewport and browser matrix | UI-0 completion | Target user device data and browser support policy |
| UX-D2 | Initial visual brand palette and typography | Token implementation | Brand input and contrast review |
| UX-D3 | Default workbench panel widths and collapsed behavior | UI-3 implementation | Prototype sessions at laptop and large desktop sizes |
| UX-D4 | Exact input gestures and keyboard shortcuts for wire editing | UI-3 implementation | Prototype tests with novice and keyboard users |
| UX-D5 | Which import and processing events are exposed in user copy | UI-1 completion | Backend job states and comprehension test |
| UX-D6 | Whether users can share/export a project in the first release | Scope freeze | PRD decision and privacy review |
| UX-D7 | Numeric usability and rendering thresholds | Release candidate | Baseline study and TRD performance evidence |
| UX-D8 | Final physical pre-power checklist wording | UI-4 completion | Product/hardware review and PRD acceptance criteria |

## Change record

| Version | Date | Change |
|---|---|---|
| 1.0 | 13 October 2026 | Initial UI/UX implementation baseline aligned with PRD v1.0 and TRD v1.0 |
