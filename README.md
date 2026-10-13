# Schemora

Give hardware ideas structure and form.

Schemora turns an existing hardware conversation into a reviewable design and, for supported hardware, a visual assembly guide.

Active development lives on the `dev` branch. `main` contains the project introduction only.

## Phase 1

Import a supported hardware conversation, choose its thread, inspect the normalized transcript, and review sourced board, component, connection, and firmware proposals. Unknown details, conflicting claims, and superseded instructions remain visible. Corrections and review actions are saved as project revisions.

Supported inputs: UTF-8 TXT/Markdown, static HTML, recognized JSON exports, text PDFs, and restricted ZIP bundles. Maximum upload: 10 MiB. Image-only PDF OCR, universal export compatibility, catalog verification, 3D assembly, and electrical simulation are later capabilities.

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

| Path                    | Responsibility                                                             |
| ----------------------- | -------------------------------------------------------------------------- |
| `apps/web`              | Desktop UI, GitHub session, server-only API proxy                          |
| `apps/api`              | Authenticated project/import/review HTTP API                               |
| `apps/worker`           | Durable import/extraction and deletion processing                          |
| `packages/contracts`    | Strict versioned conversation and candidate schemas                        |
| `packages/intelligence` | Safe parsers, conservative extraction, provider adapter, benchmark         |
| `packages/persistence`  | PostgreSQL/Drizzle, immutable artifacts/revisions, outbox/jobs, migrations |
| `packages/storage`      | Private development filesystem and S3 adapters                             |
| `docs`                  | PRD, TRD, delivery plans, system design, Phase 1 evidence                  |

See [Phase 1 scope and research](docs/Phase-1-Implementation.md), [parser research](packages/intelligence/RESEARCH.md), and [synthetic benchmark results](packages/intelligence/BENCHMARK.md).
