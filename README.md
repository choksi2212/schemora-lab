# Schemora

Give hardware ideas structure and form.

Schemora turns an existing hardware conversation into a reviewable design and, for supported hardware, a visual assembly guide.

Active development lives on the `dev` branch. `main` contains the project introduction only.

## Phase 1 — Conversation to reviewed design

Import a supported hardware conversation, choose its thread, inspect the normalized transcript, and review sourced board, component, connection, and firmware proposals. Unknown details, conflicting claims, and superseded instructions remain visible. Corrections and review actions are saved as project revisions.

Supported inputs: UTF-8 TXT/Markdown, static HTML, recognized JSON exports, text PDFs, and restricted ZIP bundles. Maximum upload: 10 MiB. Image-only PDF OCR and universal export compatibility remain unsupported.

## Phase 2 — Hardware knowledge and circuit validation

The catalog exposes an exact ESP32-DevKitC V4 / WROOM-32E / male-header configuration, a Kingbright WP7113ID LED, a YAGEO 220 Ω resistor, and a source-backed BusBoard BB400/BB400T connectivity topology. Circuits are represented by versioned terminal/hole graphs, persisted as immutable project revisions, and checked with deterministic structural and limited electrical rules. Reports preserve unknown electrical limits; a pass is not a safety certification.

See [Phase 2 implementation details and limits](docs/Phase-2-Implementation.md) for catalog sources, graph contracts, rules, APIs, persistence, and verification.

## Phase 3 — Interactive 3D workbench (in progress)

The circuit workspace now renders the saved graph in a browser 3D scene with camera orbit, zoom, and reset controls. Users can move and rotate selected components, add a wire by choosing two exact terminals, remove wires, and undo or redo edits before saving. Component poses are stored in a bounded visual-layout contract separate from electrical connectivity. The existing editor remains available for optional breadboard-hole assignments. Geometry is illustrative and is not dimension-accurate CAD, a physical-fit guarantee, or electrical validation. Firmware simulation and photo recognition remain later, separately gated work.

See [Phase 3 implementation status and remaining work](docs/Phase-3-Implementation.md).

## Run locally

Requirements: Node.js 24, pnpm 11.5.2, and Docker with Compose.

```sh
git clone https://github.com/choksi2212/schemora-lab.git
cd schemora-lab
git switch dev
pnpm install --frozen-lockfile
```

Copy `.env.example` to `.env` using your file manager or shell, then:

```sh
docker compose up -d postgres
pnpm db:migrate
pnpm dev
```

Open [localhost:3010](http://localhost:3010). The API binds to loopback port 4001; PostgreSQL uses loopback port 55432. The development launcher starts the UI, API, and worker together. Change `WEB_ORIGIN` to use another web port. Local source files live in the ignored `.schemora/objects` directory shared by the API and worker.

The local development identity and deterministic extraction mode are visibly labeled. No external model request is made by default. Try [the sample conversation](examples/esp32-led.md), then use “Show source,” mark the earlier pin instruction obsolete, and confirm or correct the remaining facts.

## Verify

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm exec playwright install chromium
pnpm test:e2e
pnpm format:check
```

The full unit/integration suite creates and migrates a separate database ending in `_test`; it never uses the live development database for test jobs. The local PostgreSQL role needs database-creation permission for that bootstrap. CI runs the same checks and browser workflow on `dev`. Test scores use synthetic fixtures and do not establish live model accuracy.

## Configure remote services

Production mode rejects filesystem storage, development identity, weak/example signing secrets, an HTTP web origin, and a PostgreSQL URL without `sslmode=verify-full`. Use private S3 storage and least-privilege service credentials, configure `AUTH_GITHUB_ID` and `AUTH_GITHUB_SECRET` for callback `/api/auth/callback`, and provision independent private `AUTH_SECRET` and `SESSION_SECRET` values. The GitHub OAuth flow uses state and PKCE; the browser receives an HttpOnly session cookie and never receives provider or API signing credentials.

Optional model extraction uses `EXTRACTION_MODE=provider`, `EXTRACTION_ENDPOINT`, `EXTRACTION_API_KEY`, and `EXTRACTION_MODEL`. `PROVIDER_REVIEW_APPROVED=true` is required after reviewing the provider's user-data policy. The endpoint must support the documented compatible chat-completions protocol and JSON output; it is configured server-side. Invalid or unavailable model output falls back to clearly labeled local source review with a warning. A chosen live model still needs the representative accuracy benchmark before enabling it for real users.

Parser child processes have time and memory limits. Public production deployment also requires the network/filesystem sandbox, infrastructure, restoration, and security evidence described in the [backend runbook](apps/api/RUNBOOK.md) and [system design](docs/System-Design.md).

## Repository guide

| Path                        | Responsibility                                                                |
| --------------------------- | ----------------------------------------------------------------------------- |
| `apps/web`                  | Desktop UI, GitHub session, server-only API proxy, graph-derived 3D workbench |
| `apps/api`                  | Authenticated project/import/review/catalog/circuit HTTP API                  |
| `apps/worker`               | Durable import/extraction and deletion processing                             |
| `packages/contracts`        | Strict versioned conversation and candidate schemas                           |
| `packages/intelligence`     | Safe parsers, conservative extraction, provider adapter, benchmark            |
| `packages/persistence`      | PostgreSQL/Drizzle, immutable artifacts/revisions/graphs/reports, outbox/jobs |
| `packages/storage`          | Private development filesystem and S3 adapters                                |
| `packages/hardware-catalog` | Versioned source-linked component and breadboard catalog                      |
| `packages/circuit-model`    | Strict circuit graph, structural checks, deterministic breadboard nets        |
| `packages/validation`       | Versioned deterministic Phase 2 findings and report contracts                 |
| `docs`                      | PRD, TRD, delivery plans, system design, phase implementation evidence        |

See [Phase 1 scope and research](docs/Phase-1-Implementation.md), [Phase 2 implementation](docs/Phase-2-Implementation.md), [Phase 3 workbench](docs/Phase-3-Implementation.md), [parser research](packages/intelligence/RESEARCH.md), and [synthetic benchmark results](packages/intelligence/BENCHMARK.md).
