# Schemora — Phase 1 implementation

Phase 1 implements conversation ingestion and intelligence through editable design review, as described in the original product context. It includes the project, authentication, persistence, and job foundations needed for that workflow. The backend plan's numbered tranches 0–3 support this product phase; their numbers are not separate product releases.

## User workflow

Create a project, upload a supported conversation file, wait for durable processing, select one conversation if the file contains several, and review extracted hardware facts beside the source transcript. Confirm, reject, correct, or mark a proposal obsolete. Every accepted review creates a revision and records the actor; the original proposal and evidence stay inspectable. Return to the project later without losing its saved state.

## Delivery boundaries

The local environment uses an explicit development identity, private filesystem storage, and conservative rule extraction. The UI labels that mode. Rules expose source mentions and explicit wiring instructions; they are not a general language model and are not a verified electrical specification. A server-configured compatible model endpoint is available behind a provider approval gate. Live provider quality must be benchmarked after a provider is chosen.

Production requires GitHub OAuth credentials, private signing secrets, TLS-protected PostgreSQL, and private S3 storage. Parser process resource limits reduce risk but do not replace an operating-system network/filesystem sandbox. Infrastructure isolation, provider privacy terms, quantitative service objectives, backup recovery, and incident runbooks require deployment evidence before a public production launch.

## Source formats

| Format          | Implemented support                                                                    | Explicit limit                                                                     |
| --------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Text / Markdown | UTF-8, role headers, fenced code, order and source locators                            | Unrecognized speaker structure remains unknown                                     |
| HTML            | Static server-side DOM parsing and text/code/attachment references                     | Imported HTML never executes; arbitrary export layouts may yield partial structure |
| JSON            | Recognized generic messages, Claude-like messages, ChatGPT mapping/current-node shapes | No claim that provider export schemas are stable or universally supported          |
| PDF             | PDF.js text extraction with page provenance                                            | Image-only PDFs require OCR elsewhere; exact code spacing cannot be guaranteed     |
| ZIP             | Sequential in-memory processing with path/type/count/size/ratio limits                 | Nested, encrypted, symlink, and unsafe entries rejected; no filesystem extraction  |

Account exports are never merged into one hardware design. A picker selects the target conversation. Earlier or alternate branch content is not silently combined with the selected conversation path.

## Architecture decisions implemented

| Decision                                       | Implementation rationale                                                                                                                               |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Separate stateless API and worker entry points | Interactive requests do not wait for parsing or providers; worker concurrency scales separately                                                        |
| PostgreSQL transport for Phase 1 durable queue | Transactional outbox, leased jobs, SKIP LOCKED claiming, and durable status avoid a second production infrastructure dependency during the first slice |
| Storage port with local/S3 implementations     | Source bytes stay private; generated keys and checksums prevent user-controlled paths and accidental overwrite                                         |
| Signed BFF identity                            | Browser does not supply a trusted identity or receive API secrets; short-lived server-signed tokens bind the verified web identity to API scope        |
| GitHub OAuth with PKCE and state               | Stable provider subject; authorization flow protects code interception and callback forgery                                                            |
| Strict source spans                            | Candidate evidence must match an actual message substring; schema validity alone does not imply semantic accuracy                                      |
| Immutable revision references                  | Review history retains versions without duplicating complete conversation bodies on each action                                                        |

The PostgreSQL queue is an implementation of the durable transport boundary in System-Design.md. It is replaced through that boundary if queue age, throughput, scheduling, or operational evidence justifies a dedicated queue provider. It is not an unbounded task array in API memory.

## Research record

The implementation uses the following primary documentation, with installed versions locked in pnpm-lock.yaml and behavior verified by tests:

- [Next.js installation and runtime requirements](https://nextjs.org/docs/app/getting-started/installation) and [async cookie API](https://nextjs.org/docs/app/api-reference/functions/cookies).
- [Next.js type generation](https://nextjs.org/docs/app/api-reference/cli/next): generate route types before type checking and exclude generated next-env.d.ts from version control.
- [pnpm workspace protocol](https://pnpm.io/workspaces) and [pnpm 11 build permission changes](https://pnpm.io/blog/releases/11.0).
- [GitHub OAuth authorization, PKCE, and state](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps).
- [PostgreSQL locking clauses](https://www.postgresql.org/docs/17/sql-select.html) and [transaction isolation](https://www.postgresql.org/docs/17/transaction-iso.html).
- [OpenAI export formats and split conversation JSON](https://help.openai.com/en/articles/9106926-transfer-exported-conversations-between-chatgpt-accounts) and [Claude data exports](https://support.claude.com/en/articles/9450526-export-your-claude-data).
- Parser-specific dependency research and limits: [intelligence research](../packages/intelligence/RESEARCH.md).
- Backend infrastructure sources and operational details: the backend package runbook.

## Verification record

Final executed checks and remaining external deployment gates are recorded at handoff in this file. Synthetic fixtures are used for regression and provenance testing; their score must not be presented as accuracy on real user exports or a live model.

| Check                                        | Executed result                                                                                                                                                         |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Frozen dependency installation               | Passed with pnpm 11.5.2                                                                                                                                                 |
| Strict type checking                         | Passed for root tooling and all workspace packages; generated Next.js route types first                                                                                 |
| Parser, extraction, and resource-limit suite | 58 tests passed                                                                                                                                                         |
| Authentication, BFF, and client error suite  | 12 tests passed, including mocked PKCE callback exchange and domain-specific conflict messages                                                                          |
| API, database, storage, and worker suite     | 27 tests passed against isolated PostgreSQL, including concurrent edits, lease fencing, active cancellation/deletion, upload-intent cleanup, and 201-message pagination |
| Browser workflow                             | 3 tests passed with automatic clean stack startup; no uncaught browser exceptions                                                                                       |
| Production web compilation                   | Passed with Next.js 16.4.0                                                                                                                                              |
| Formatting                                   | Passed                                                                                                                                                                  |
| Synthetic extraction benchmark               | 28 fixture conversations; complete expected sets and source spans checked; detailed scope in BENCHMARK.md                                                               |

The browser harness sets a noninteractive CI environment and disables API/worker watch reloads. Development watchers exclude runtime data and generated scene/web output; writing a source upload must not restart a running job process. Parser time/memory limits and strict output budgets remain active in both modes.

Live GitHub OAuth credentials, actual S3 account/bucket policy, chosen model accuracy/retention, an operating-system parser sandbox, and production restore/service objectives require external deployment evidence. They were not simulated as completed cloud integrations. The original planning conversation is retained verbatim in context.md; current implementation choices are recorded here and in the revised technical documents.

The implemented candidate schema preserves a display value alongside typed board identity, component quantity/resistance, connection endpoint labels, and firmware language/content. Missing values remain null. User review is a separate immutable action; a textual correction does not silently rewrite the original source's structured metadata or certify electrical correctness. Catalog mapping and graph compilation consume reviewed intent in Phase 2.
