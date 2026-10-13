# Phase 1 API and worker operations

This service implements project ownership, immutable revision history, bounded private intake, asynchronous conversation normalization, thread selection and candidate review. It requires PostgreSQL and trusted short-lived bearer tokens signed by the web server. It does not accept a browser supplied user ID.

## Runtime boundaries

The web server signs an HS256 token for issuer schemora-web, audience schemora-api, stable subject and a maximum five minute lifetime. The API verifies signature, issuer, audience, issued time and expiry. Production accepts GitHub numeric subjects only. API project queries include the authenticated owner. Nested import and revision reads also include project scope. A guessed identifier returns the same unavailable response as a missing resource.

The API handles synchronous lifecycle commands. The separately scalable worker claims PostgreSQL jobs through SKIP LOCKED and uses a token fenced lease. API mutations insert the outbox intent in the same transaction as canonical state. Dispatch inserts a job and marks its outbox row delivered atomically. Duplicate dispatch does not insert a second job. Workers renew their lease without overlapping heartbeat queries; stale owners cannot apply results after another worker takes over.

Every canonical mutation includes an integer expectedRevision and a UUID Idempotency-Key header. Project head advancement, immutable revision insertion, review history and outbox writes commit in one database transaction. Reusing an idempotency key with another payload returns a conflict. Project creation uses a transaction advisory lock; subsequent writes lock only the target project. Authorized reads hold a shared project lock while loading related records.

## Configuration

| Variable                                                    | Meaning                                                                         |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------- |
| DATABASE_URL                                                | PostgreSQL URL; production must use sslmode=verify-full                         |
| SESSION_SECRET                                              | At least 32 characters, independently generated; only API/web need it           |
| STORAGE_DRIVER                                              | filesystem for local development/tests, s3 for production                       |
| STORAGE_DIRECTORY                                           | Absolute directory shared by local API and worker; never a public web directory |
| S3_BUCKET / AWS_REGION                                      | Private dedicated source bucket and region                                      |
| WEB_ORIGIN                                                  | Exact application origin; HTTPS required in production                          |
| API_HOST / API_PORT                                         | Bind interface and port; local default 127.0.0.1:4001                           |
| DATABASE_POOL_SIZE                                          | Maximum connections per process, default 10                                     |
| WORKER_POLL_MS                                              | Idle poll interval, default 1000 ms                                             |
| WORKER_LEASE_SECONDS                                        | Lease duration, default 120 seconds; minimum 120 through production entry point |
| WORKER_PROCESS_CONCURRENCY                                  | Bounded parser work per replica, default 1                                      |
| WORKER_DELETE_CONCURRENCY                                   | Independent deletion work per replica, default 1                                |
| JOB_MAX_ATTEMPTS                                            | Automatic retries including initial attempt, default 3                          |
| EXTRACTION_MODE                                             | rules or provider; rules is the default conservative source assistant           |
| EXTRACTION_ENDPOINT / EXTRACTION_API_KEY / EXTRACTION_MODEL | Reviewed HTTPS chat completions adapter configuration                           |
| PROVIDER_REVIEW_APPROVED                                    | Must be true to enable a configured provider                                    |

Environment values are validated before listening. Errors name invalid settings without printing their values. API handlers return stable safe errors and do not serialize object keys, source bytes, tokens, database diagnostics or exception stacks. Worker routine logs contain only an event and job type.

Production deployment requires a documented private bucket policy, public access block, restricted service IAM, encryption and retention behavior. The SDK obtains credentials through its normal provider chain. PutObject uses an immutable generated key, a server computed SHA256 checksum and an if-none-match condition. Reads verify byte count and digest. Deletion enumerates and purges matching object versions and delete markers before completing a project tombstone, so IAM must permit ListBucketVersions and DeleteObjectVersion. Object lock retention that prevents deletion must be reconciled with the product retention policy before enabling it.

## API contract

Success responses contain data and requestId. Errors contain error.code, error.message, error.retryable and error.requestId. Revision conflicts additionally return currentRevision. Timestamps are UTC. Project states are active, archived and deleting; deleted tombstones are unavailable through ordinary APIs.

| Method               | Path                                                           | Behavior                                                                                     |
| -------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| GET                  | /v1/projects?cursor=...                                        | At most 50 summaries; data.items and data.nextCursor                                         |
| POST                 | /v1/projects                                                   | Create title and revision 1                                                                  |
| GET / PATCH / DELETE | /v1/projects/:projectId                                        | Read summary, rename or request deletion                                                     |
| POST                 | /v1/projects/:projectId/archive                                | Make read only; cancel all unfinished imports and their active jobs                          |
| GET                  | /v1/projects/:projectId/revisions?before=...                   | At most 100 metadata records descending                                                      |
| GET                  | /v1/projects/:projectId/revisions/:revision                    | Single snapshot with immutable artifact references                                           |
| POST                 | /v1/projects/:projectId/imports                                | Verify and privately save filename/contentBase64, enqueue processing                         |
| GET                  | /v1/projects/:projectId/imports/:importId?messageOffset=...    | Active source extraction, latest reviews, at most 200 selected messages, nextMessageSequence |
| POST                 | /v1/projects/:projectId/imports/:importId/select               | Choose exactly one available conversation using conversationId                               |
| POST                 | /v1/projects/:projectId/imports/:importId/retry                | Queue a failed or cancelled source                                                           |
| POST                 | /v1/projects/:projectId/imports/:importId/cancel               | Fence pending processing and preserve source                                                 |
| POST                 | /v1/projects/:projectId/imports/:importId/reviews              | Append accept/reject/correct/obsolete decision with evidence retained                        |
| GET                  | /v1/projects/:projectId/imports/:importId/reviews?before=...   | At most 100 immutable historical review decisions                                            |
| POST                 | /v1/projects/:projectId/firmware-artifacts                     | Save at most 2,000,000 bytes of UTF-8 C/C++ source as an immutable private artifact          |
| GET                  | /v1/projects/:projectId/firmware-artifacts                     | List at most 100 authorized artifact metadata records; never exposes storage keys            |
| GET                  | /v1/projects/:projectId/firmware-artifacts/:artifactId         | Read one project-scoped artifact and its latest derived review status                        |
| GET                  | /v1/projects/:projectId/firmware-artifacts/:artifactId/content | Download source after private-storage SHA-256 and byte-length verification                   |
| GET                  | /v1/projects/:projectId/firmware-artifacts/:artifactId/reviews | At most 100 immutable accept/reject decisions, newest first                                  |
| POST                 | /v1/projects/:projectId/firmware-artifacts/:artifactId/reviews | Append an explicit accepted/rejected choice for this immutable source version                |

Uploads are at most 10 MiB of decoded bytes. The API accepts txt, md, html, pdf, json and zip names only, rejects noncanonical base64 and unsafe path names, and limits one project to 20 imports. Unsupported content fails during bounded inspection; acceptance of bytes does not imply successful parsing. Multiple conversations remain separate and require explicit thread selection. Bundle and selected conversation warnings are exposed. Only selected conversation messages reach extraction.

Firmware source has a separate 2,000,000-byte limit and accepts UTF-8 text only. Supported languages are C, C++, Arduino C++, and ESP-IDF C; the entrypoint extension must match the selected language. The API resolves exactly one development board from the saved graph and current catalog and ignores any client attempt to supply board, catalog, digest, byte length, review state, or storage location. New source is pending review. `accepted` means the project owner explicitly chose that version for future runs; it does not mean code passed a security review, compiled, or is safe. The metadata revision is the revision created by the upload mutation, while the artifact records the exact board and catalog release. Its source digest and artifact ID are later bound separately from the graph revision/digest in any run.

Project summaries omit full extraction content. The active import endpoint contains its bounded extraction. Transcript messages are paginated and latest review summaries are capped at the candidate limit of 2000; complete history uses its own descending revision cursor.

## Canonical records and reconstruction

The reviewed SQL migration files are the database schema authority. Drizzle declarations provide typed simple reads; parameterized PostgreSQL queries implement explicit locking, queue claiming and transaction boundaries. The migration runner acquires an advisory lock, applies each migration in a transaction and checks its SHA256 ledger. Editing an applied migration is rejected; add another migration.

Each revision contains project metadata, import source IDs/digests, selected thread, immutable bundle/extraction digests, processor metadata, firmware artifact metadata references, and a reviewThroughRevision boundary. Source bytes and accumulated review histories are not copied into every revision. To reconstruct a revision, resolve project-scoped import artifacts by digest, source artifacts by immutable ID/digest, and choose the latest immutable import or firmware review decision at or before that revision's boundary. Firmware artifact rows store source digest, byte length, language, entrypoint, exact board part, and catalog release; storage keys remain server-only. A new processing policy requires a new build/version identifier.

Candidate corrections remain independent review records. They do not overwrite the extracted evidence, candidate details or normalized source. Superseded candidates cannot be accepted as current. Review acceptance records the user's choice and does not certify hardware compatibility.

## Processing limits and production gate

A parser subprocess runs with a 256 MiB JavaScript heap and a 30 second parent deadline. Its environment omits database, session, storage and provider credentials. Parent validation limits normalized output to 25 MiB and validates bundle and extraction schemas before persistence. Archive entry, expansion, ratio, nesting and path limits are owned by the intelligence package.

The subprocess is resource isolation for local development. It is not an operating system sandbox, and its heap limit is not a total resident memory limit. It does not enforce network egress denial. Before exposing untrusted imports in production, deploy the parser role in a reviewed container or equivalent runtime with no network egress, read only root filesystem, bounded temporary disk, operating system memory and CPU limits, and an unprivileged identity. Provider extraction must run in a separate permitted application role or through a controlled gateway. This gate is unresolved until that deployment evidence exists; the local subprocess must not be described as proof of production isolation.

Rules extraction explicitly describes itself as conservative candidate generation and may miss facts. A configured provider is still untrusted and source grounded, with all output requiring review. If a provider fails, the worker preserves normalized content and exposes deterministic source assistance with an explicit warning and actual extractionMode; it does not label the result provider generated.

## Failure, cancellation and deletion

Retryable processing failures use bounded exponential delay. Unsupported or invalid content fails without automatic retries. Exhausted expired leases become failed; a newer retry job prevents an older failed attempt from invalidating current processing. Manual retry creates a new durable job. Cancellation and archive cancel active job tokens; in-flight output is discarded when project/source/job preconditions are checked again.

Deletion immediately revokes reads, cancels ordinary work and creates a purge job. Purge deletes private import and firmware objects, bundle/extraction artifacts, normalized content, import and firmware review history, revisions and cached idempotency responses, then preserves a minimal project tombstone. An incomplete object purge leaves the project deleting and unavailable; it cannot be reported successfully deleted. Failed deletion jobs need operator review and requeue through a controlled operation after correcting the storage failure. Backup expiry and deletion replay are deployment obligations.

Before writing any private bytes, the API registers an authorized, durable upload intent containing the generated key, project scope and a 15 minute expiry. Successful source persistence consumes the intent in the same transaction as the import and job outbox record. A confirmed upload followed by a persistence failure removes its bytes and intent; a cleanup failure preserves the intent for retry.

An uncertain storage acknowledgement may represent a put that finishes after a timeout. The API attempts immediate byte deletion and retains that intent until expiry, so a late storage completion remains tracked. Project purge also deletes staged bytes immediately while retaining fresh intents through the same grace interval. This prevents an already-running upload from creating an untracked object after project deletion. Normal project access is revoked throughout deletion.

Worker maintenance inspects at most 10 expired intents per pass, locks each with SKIP LOCKED, deletes tracked bytes and removes the intent only after successful cleanup. Accepted import objects are protected. Fresh intents are preserved, and source acceptance requires an unexpired intent consumed under its row lock. This cleanup needs no public bucket listing or full object inventory; it uses the exact private keys recorded before upload. Storage failure delays purge and leaves the durable intent available for the next pass. Backup expiry and deletion replay remain deployment obligations.

## Verification and research

Integration tests require an independently migrated TEST_DATABASE_URL. Do not share their database with a running development worker, because job transport is shared within a database while test source objects use isolated directories. Tests clean only their synthetic principals and project records.

The test suite covers trusted authentication, cross-user resource denial, idempotent replay/conflicts, concurrent writes, immutable snapshots, accepted format intake, source processing, thread selection, review correction preservation, archive/retry/cancel, stable pagination, duplicate delivery, lease fencing, exhausted lease handling, active deletion/cancellation, heartbeat renewal and provider outage fallback. Parser package fixtures separately prove supported formats and hostile input behavior.

Implementation decisions were researched against [Fastify v5 documentation](https://fastify.dev/docs/latest/Reference/), [Drizzle PostgreSQL integration](https://orm.drizzle.team/docs/get-started-postgresql), [Drizzle transactions](https://orm.drizzle.team/docs/transactions), [PostgreSQL locking clauses](https://www.postgresql.org/docs/current/sql-select.html), [S3 integrity checks](https://docs.aws.amazon.com/AmazonS3/latest/userguide/checking-object-integrity-upload.html) and [S3 versioned deletion](https://docs.aws.amazon.com/AmazonS3/latest/userguide/DeletingObjectVersions.html). Stable package versions are locked; the Drizzle documentation's RC installation example is not adopted implicitly.
