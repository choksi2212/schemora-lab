# Phase 5 — Beginner Teaching Usability Study Protocol

**Status:** Ready for operational review; participant recruitment, sessions, and evidence-based revisions are not complete.

**Protocol version:** 1.1`r`n**Product scope:** Schemora assembly guide and contextual teaching panel for the currently supported ESP32 DevKitC V4, BB400 breadboard, LED, resistor, and wiring profile.`r`n**Study type:** Moderated, formative usability and comprehension evaluation.`r`n**Power state:** The physical circuit remains disconnected from every power source for the entire session.

## 1. Decision this study supports

Determine whether people with little or no electronics experience can use Schemora's assembly guide and Quick, Beginner, and Detailed explanations to reproduce the supported reference circuit while correctly distinguishing catalog facts, software checks, unknown physical facts, and teaching guidance.

The study evaluates this exact product release and supported reference task. It does not estimate population-wide success, establish electrical safety, validate hardware fit, or certify that a physical circuit is safe to energize. A successful participant outcome is not evidence of safety.

## 2. Preconditions before inviting participants

The study owner must complete and approve each item before recruitment begins:

| Required decision                                       | Record before recruitment          |
| ------------------------------------------------------- | ---------------------------------- |
| Study owner and moderator                               | Name/role: **[complete]**          |
| Note-taker                                              | Name/role: **[complete]**          |
| Data controller or responsible organization             | **[complete]**                     |
| Research privacy/withdrawal contact and complaint route | **[complete]**                     |
| Approved storage location and access list               | **[complete]**                     |
| Recording processor, storage, and viewers               | **[complete or no recording]**     |
| Retention period and deletion owner                     | **[complete]**                     |
| Participant contact for questions or withdrawal         | **[complete]**                     |
| Compensation, if any                                    | **[state amount or none]**         |
| Required organizational, privacy, or ethics review      | **[record decision and approver]** |
| Physical kit custodian and pre-session checker          | **[complete]**                     |

Do not recruit or collect study data while these fields are unresolved. Applicable organizational, privacy, and ethics requirements depend on who runs the study, where participants are located, and how results will be used; this protocol does not decide that applicability.

## 3. Participants and sample

Run two formative rounds with **five adult novice participants per round**. Recruit five additional novice participants for Round 2 after defects from Round 1 have been triaged and fixes are available. Do not count repeat participants as new independent observations. If five eligible people cannot be recruited for a round, record the shortfall and keep the acceptance gate open.

For this study, a novice is an adult who self-reports no formal electronics training and zero or one personal electronics circuit build ever. Record only broad prior-exposure categories needed to interpret performance. Do not collect names, exact age, employer, address, medical history, or unrelated demographic details in observation notes. Ask every invitee what adjustments would help them take part; do not ask for a diagnosis. Provide accessible consent/task materials and reasonable session adjustments. Exclude people who do not meet the novice definition from the novice score; they may be observed separately as exploratory users and must not be combined into novice results.

Recruit actual or likely users of the beginner workflow. Do not recruit direct reports, students under the moderator's authority, or anyone who may feel their participation affects employment, grades, access, or benefits. Participation is voluntary.

Make the venue accessible and allow an interpreter or assistant where needed. Record only the accommodation used when it affects task interpretation. The novice cohort does not establish assistive-technology accessibility. If no participants use assistive technology, screen readers, magnification, or other relevant accommodations, state that limitation and keep a separate accessibility evaluation open. [GOV.UK moderated usability testing](https://www.gov.uk/service-manual/user-research/using-moderated-usability-testing)

Five participants per round is a formative issue-finding target, not a statistically representative sample. GDS describes moderated testing as observing users attempting specific tasks and recommends planning sessions around explicit research questions; its guidance gives 4–8 people as a usual range for qualitative rounds. The planned cohort is consistent with that formative purpose, not a benchmark claim. [GOV.UK moderated usability testing](https://www.gov.uk/service-manual/user-research/using-moderated-usability-testing), [GOV.UK planning user research](https://www.gov.uk/service-manual/user-research/plan-user-research-for-your-service)

## 4. Consent and recording

Obtain and record informed consent before taking notes, recording a screen, photographing a build, or beginning tasks. Explain the purpose, activities, collected data, access, intended use, retention, voluntary nature, and withdrawal process in plain language. Ask separately for screen/audio/video recording; declining recording must not exclude a participant from an otherwise accessible session. If consent is withdrawn, stop the session and promptly delete the participant's research data according to the approved withdrawal procedure.

Use the following introduction, filling the bracketed details before the session. It intentionally does not tell participants whether Schemora's checklist or software proves safety; that is evaluated in T4/C4 and explained in the debrief.

> We are evaluating Schemora's assembly guide and explanations, not testing you. We want to learn where the product is clear or confusing. This session takes about 45 to 60 minutes. You will use the guide to assemble a small circuit from the supplied parts. For the study's physical safety protocol, the kit remains disconnected from power throughout the session. We will observe your actions and take notes using a participant code. [If applicable: We would also like to record **screen/audio/video** for **purpose**. Recording is optional and you can still take part if you decline.] Your notes will be available to **people/roles**, used for **purpose**, and kept until **date/period**, then deleted by **owner**. Taking part is voluntary. You may pause or stop at any time without giving a reason. Do you have questions? Do you agree to take part? Do you separately agree to the recording option(s) you selected?

Record consent status and optional recording choices against a random participant code. Store any contact details needed for scheduling separately from study notes and delete them under the approved retention plan. Do not include signed consent forms in the issue log or share them with product engineers.

This consent checklist follows the information elements in GOV.UK's user-research consent guidance, including research purpose, data use, voluntariness, withdrawal, and retention. It is an operational template, not a substitute for organization-approved consent wording. [GOV.UK informed consent for user research](https://www.gov.uk/service-manual/user-research/getting-users-consent-for-research)

## 5. Physical setup and safety controls

Use the version-controlled structural fixture in [`packages/teaching/test/fixtures/phase5-reference-graph.ts`](../packages/teaching/test/fixtures/phase5-reference-graph.ts), not a facilitator-created interpretation of the starter circuit. It fixes the catalog release, exact component instance/part IDs, BB400 topology and rail variant, all wire endpoints, and the absence of terminal-to-hole assignments. For each participant, create a separate project by changing only project identity and the graph identity/revision required by persistence; do not alter components, topology, placements, wires, or catalog release. Save the graph, run current validation, and generate the guide before the session. The expected status is `GRAPH_INTEGRITY = pass`, with no `fail` or `error` findings blocking plan generation. Record the resulting project revision, graph snapshot ID/digest, validation report ID/digest, browser build, and physical kit model/configuration in the session record. Recheck that the saved graph matches the fixture's normalized content before each session.

- Do not connect USB, a battery, bench supply, or any other power source at any time.
- Keep power leads and power supplies outside the participant's reach and outside the session area.
- Use only the specified low-voltage educational parts and jumper wires; no mains equipment, soldering, sharp tools, or powered testing.
- Give the participant one build mat, the exact unpowered kit, the open project, and the supplied task card. Do not point out the solution before the participant encounters the guide.
- Position a facilitator where they can stop unsafe handling immediately. Stop if a participant attempts to energize the build, introduces an unapproved supply, or handles a part in a way the facilitator judges unsafe.
- After a stop, disconnect/remove the hazard if safe, explain the study boundary without blame, record the event, and do not resume the affected physical task unless the study owner approves a safe alternative.

The product's pre-power checklist is evaluated as explanatory content only. Participants must not connect power after checking it. Since the moderator instructs everyone to keep the kit unpowered, compliance with that study rule is a safety control and must not be counted as evidence that the product taught the participant to leave it unpowered.

## 6. Session agenda and moderator script

Allow 45–60 minutes per session, with one moderator and one note-taker where possible. The moderator reads the task wording exactly and avoids teaching the answer. Think-aloud prompts are optional and neutral. GDS recommends task-based moderated sessions and a prepared introduction/task script; this agenda follows that approach. [GOV.UK moderated usability testing](https://www.gov.uk/service-manual/user-research/using-moderated-usability-testing)

| Time      | Activity                      | Moderator action                                                                                                       |
| --------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 0–5 min   | Consent and setup             | Read the approved introduction, confirm consent, assign participant code, verify unpowered kit.                        |
| 5–8 min   | Prior exposure                | Ask the short background questions in Section 7. Do not coach.                                                         |
| 8–38 min  | Five product tasks            | Read each task verbatim; observe; note success, errors, time, and assistance.                                          |
| 38–48 min | Comprehension and calibration | Ask the questions in Section 8 without reopening explanations unless the question says to.                             |
| 48–55 min | Debrief                       | Ask what was confusing, what they trusted, and what they would change. Remind them the circuit remains unpowered.      |
| 55–60 min | Close                         | Reconfirm recording preference, explain withdrawal/contact process, secure or delete study data per the approved plan. |

Use only these neutral prompts when the participant pauses:

- “What are you looking for right now?”
- “What do you expect this control or label to do?”
- “What, if anything, is unclear?”
- “Please keep going as you normally would.”

Do not say which control to use, name the correct pin/component, interpret a validation finding, or confirm an answer during a scored task. If the participant asks for help, respond: “What would you do if I were not here?” Record the request as a hint request. Intervene only for safety or to restore a broken study environment; record the reason and classify the task outcome as assisted.

## 7. Background questions and task cards

Ask these background questions before opening the first task:

1. “How much experience have you had building electronics circuits?” Record: none / one build / more than one (not novice-scored if above the definition).
2. “Have you used a breadboard before?” Record: never / seen one / used one.
3. “How familiar are you with terms such as GPIO, ground, polarity, and series resistor?” Record: unfamiliar / heard the term / can explain it.

Do not explain these words yet. Use a private participant code in all notes.

Give tasks one at a time. The full task set has five goals and should take no more than 10 minutes per task before the moderator records a timeout or assistance. GOV.UK benchmarking guidance advises using no more than five tasks and up to 10 minutes per task as a rule of thumb; this is a practical limit for this study, not a universal standard. [GOV.UK usability benchmarking](https://www.gov.uk/service-manual/measuring-success/usability-benchmarking-a-website-or-whole-service)

| ID                               | Participant task wording                                                                                                                                                           | What success means                                                                                                                                                                                                                    |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1 — Find the part               | “Use the guide to identify the board and the resistor you need. Show me how you know these are the parts named by the design.”                                                     | Selects the exact board and resistor identities shown by the current guide/catalog. No substitutions based on appearance alone.                                                                                                       |
| T2 — Follow the signal path      | “Use the guide to build the signal path shown in the design with the supplied board, resistor, LED, and wires. Tell me when you think the physical arrangement matches the guide.” | Physical arrangement matches every explicit graph endpoint and placement in the prepared project, with no unmodeled connection invented.                                                                                              |
| T3 — Explain the LED instruction | “Use any explanation level you choose. Explain why the LED has an orientation in this design, and show me what information the product uses.”                                      | Correctly describes anode/cathode direction in the modeled design and identifies the catalog/source context; does not claim the software sees the physical LED orientation.                                                           |
| T4 — Interpret the checks        | “Review the current checks. Tell me what the product has established and what remains unknown about this circuit.”                                                                 | Correctly distinguishes a passing structural/model rule from unknown electrical or physical facts; does not describe a pass as safety approval.                                                                                       |
| T5 — Pre-power decision          | “Review the checklist. What conclusions can you draw from it, and what does Schemora still not know about the physical circuit?”                                                   | Says the checklist does not observe or measure the physical assembly and is not certification that the circuit is safe to power. Do not score whether the participant keeps the kit unpowered; the moderator already instructed this. |

The scoring key for T2 is fixed by the fixture: board `board-1` GPIO19 ↔ resistor `resistor-1` lead A; resistor lead B ↔ LED `led-1` anode; LED cathode ↔ board `board-1` GND terminal `gnd-j3-1`. There are no terminal-to-hole placements in this fixture, so do not score or imply a breadboard hole position. Score only these three explicit paths and exact component identities.

Do not score speed as more important than correctness. A task is **unassisted success** only if the participant reaches the stated outcome without the moderator naming an action, interpreting product content, or correcting a mistake. A task completed after a content hint is **assisted**. Record a timeout after 10 minutes; let the participant stop earlier without penalty.

## 8. Comprehension and confidence questions

After tasks, close the product view and ask each question without giving hints. Score each answer as correct / partial / incorrect using the rubric below. Record a short paraphrase, not a verbatim transcript unless transcription is separately approved.

| Check                 | Question                                                                                     | Correct answer must include                                                                                           |
| --------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| C1 — Identity         | “What makes the board or component identity an exact catalog fact?”                          | It is the selected catalog model/configuration and source-backed entry, not a visual guess.                           |
| C2 — Model check      | “What does a passing rule tell you?”                                                         | Only that the named modeled rule passed for the saved graph; other electrical/physical properties may remain unknown. |
| C3 — Physical unknown | “Can Schemora tell whether your real LED is inserted in the same orientation as the design?” | No; the scene/guide does not observe the physical part. The person must compare the actual part/connection.           |
| C4 — Power and safety | “Does the pre-power checklist say the circuit is safe to connect to power?”                  | No; it is a reminder, not certification, measurement, or permission to energize.                                      |
| C5 — Teaching content | “Is the ‘Why this step?’ explanation itself a saved or verified circuit fact?”               | No; it explains the current step using curated material and sources; it does not change or certify the graph.         |

For confidence calibration, after each answer ask: “How sure are you, from 1 to 5?” A high-confidence incorrect answer on C2–C4 is an overconfidence issue and must be logged separately from a wrong answer with low confidence.

## 9. Measures and recording template

Use one session record per participant code. Store no name or contact detail in this record.

```text
Participant code:
Round / date:
Moderator / note-taker:
Consent recorded: yes / no     Recording choices:
Novice criteria met: yes / no     Prior exposure category:
App build / browser:
Catalog release:
Project ID or fixture alias:
Graph digest:
Physical kit verification completed: yes / no

Task | Start/end time | Outcome (unassisted / assisted / failed / stopped) | Wrong turns | Hint requests | Outside help | Error issue IDs | Notes
T1   |
T2   |
T3   |
T4   |
T5   |

Comprehension | Correct / partial / incorrect | Confidence 1–5 | Overconfidence flag | Evidence note
C1              |
C2              |
C3              |
C4              |
C5              |

Terms misunderstood:
Physical reproduction differences:
Safety stop or unsafe attempt: yes / no; issue ID:
Participant's most confusing moment:
Participant's most useful explanation:
Product changes proposed by observation:
Data deletion/retention action and due date:
```

For each task, record elapsed time, correct completion, number and type of wrong turns, hint requests, outside help, and whether the physical build matched the graph. Record terms participants misunderstand verbatim only when necessary; remove identifying details before sharing. Record confidence separately so successful completion does not hide misunderstanding.

## 10. Defect classification and iteration

Create one issue per observed problem, not one issue per participant. Link the issue to the participant code and task, never to a name. Use this severity scale:

| Severity              | Definition                                                                                                                                               | Required response                                                                                          |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| S0 — Safety boundary  | Participant attempts to energize the circuit, follows content as safety approval, or makes an action that could cause harm outside the controlled study. | Stop the task/session; review the copy/control immediately; phase gate fails until corrected and retested. |
| S1 — Task blocker     | Participant cannot identify the right target, makes a wrong connection/placement, or cannot continue without moderator help.                             | Fix before the next release candidate; add a unit or browser regression for the failure mode.              |
| S2 — Misunderstanding | Participant reaches the outcome but misinterprets a term, source, unknown, prerequisite, or completion state.                                            | Revise wording/interaction; add an applicability or UI regression.                                         |
| S3 — Friction         | Hesitation or navigation cost with correct interpretation and outcome.                                                                                   | Record and prioritize against frequency and task impact.                                                   |

After Round 1, cluster the observations, identify repeated and safety-relevant issues, implement corrections, and rerun affected automated checks. Round 2 uses five new novice participants and the same frozen task wording. Record any unavoidable version or facilitator deviation; do not pool results across materially different guide versions as if they were one build.

For each issue, preserve four separate fields: **observed behavior or words**, **researcher interpretation**, **severity**, and **proposed product action**. The observer records what happened before discussing why it happened. Do not rewrite an interpretation as a participant quote or a desk-audit hypothesis as an observed defect. [GOV.UK analysing a research session](https://www.gov.uk/service-manual/user-research/analyse-a-research-session)

## 11. Phase 5 acceptance criteria

The study evidence may support Phase 5 acceptance only when all conditions below are met on the Round 2 candidate:

1. Five eligible novice sessions are complete with consent records and the approved retention/deletion record.
2. No S0 safety-boundary event occurs. Any S0 event blocks acceptance regardless of task success.
3. At least four of five participants complete T1–T4 without moderator content hints, and at least four of five produce a physical arrangement matching the prepared graph with no unmodeled connection.
4. All five correctly state that the checklist/software does not certify physical safety or observe physical assembly. Record the unpowered-kit instruction as protocol compliance only; it is not evidence of product comprehension.
5. At least four of five answer each of C1–C5 correctly, with no high-confidence incorrect answer on C2, C3, or C4. Partial answers are recorded as issues and do not count as correct for this threshold.
6. All S1/S2 defects from Round 1 have a documented disposition, and every fixed defect has a regression. Any unresolved S0/S1 issue blocks acceptance.
7. The report records cohort definition, exact tested build/graph/catalog digest, deviations, anonymized observations, issue IDs, changes, and remaining limits. Do not generalize these formative results to all beginners or other hardware profiles.

These are proposed product acceptance thresholds for this narrow formative study, not a statistically powered benchmark. The Phase 5 owner must approve or revise them before recruitment and preserve the approved version in the study record. Any S0/S1 issue observed in Round 2 blocks acceptance and requires a correction plus a further session round, even if the numeric thresholds are otherwise met.

## 12. Study completion record

After both rounds, fill this record in the Phase 5 implementation status:

```text
Protocol version approved:
Approval owner/date:
Round 1 candidate / graph digest:
Round 1 eligible participants / sessions:
Round 1 completion and comprehension results:
Round 1 issues by severity:
Changes and regression references:
Round 2 candidate / graph digest:
Round 2 eligible participants / sessions:
Round 2 results against each acceptance criterion:
S0/S1 disposition:
Data retention/deletion complete and owner:
Phase 5 gate: pass / fail / incomplete
Limitations and follow-up:
```

Do not mark Phase 5 complete while this record is empty, thresholds are unapproved, participant evidence is absent, or a blocking defect remains.

## 13. Accessibility evidence boundary

The novice comprehension study is not an accessibility audit. Before claiming accessibility for this guide, separately evaluate the scoped browser flow for keyboard-only operation, visible focus, reading order, status announcements, zoom/reflow, contrast, and screen-reader interaction. Record the browser, assistive technology, scope, evaluator, and defects. Automated accessibility tools can find some potential issues but cannot determine accessibility on their own; use an evaluation process that identifies scope, explores the product, samples pages/states, evaluates, and reports results. Involve people with disabilities when available and do not claim their needs were covered if they were not recruited. [W3C selecting evaluation tools](https://www.w3.org/WAI/test-evaluate/tools/selecting/), [WCAG-EM 2.0](https://www.w3.org/TR/WCAG-EM/), [GOV.UK testing with assistive technologies](https://www.gov.uk/service-manual/technology/testing-with-assistive-technologies)
