import { sql } from 'drizzle-orm';
import {
  pgTable,
  boolean,
  text,
  uuid,
  integer,
  timestamp,
  jsonb,
  primaryKey,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';

export const principals = pgTable('principals', {
  id: text('id').primaryKey(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
export const projects = pgTable('projects', {
  id: uuid('id').primaryKey(),
  ownerId: text('owner_id')
    .notNull()
    .references(() => principals.id),
  title: text('title').notNull(),
  status: text('status').notNull(),
  revision: integer('revision').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
export const revisions = pgTable(
  'revisions',
  {
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    revision: integer('revision').notNull(),
    kind: text('kind').notNull(),
    actorId: text('actor_id')
      .notNull()
      .references(() => principals.id),
    snapshot: jsonb('snapshot').notNull(),
    digest: text('digest').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.projectId, table.revision] })],
);
export const imports = pgTable('imports', {
  id: uuid('id').primaryKey(),
  projectId: uuid('project_id')
    .notNull()
    .references(() => projects.id),
  filename: text('filename').notNull(),
  objectKey: uuid('object_key').notNull(),
  sourceDigest: text('source_digest').notNull(),
  status: text('status').notNull(),
  selectedConversationId: text('selected_conversation_id'),
  bundle: jsonb('bundle'),
  extraction: jsonb('extraction'),
  errorCode: text('error_code'),
  bundleDigest: text('bundle_digest'),
  extractionDigest: text('extraction_digest'),
  extractionMode: text('extraction_mode'),
  parserVersion: text('parser_version'),
  normalizerSchema: integer('normalizer_schema'),
  extractorVersion: text('extractor_version'),
  providerModel: text('provider_model'),
  promptVersion: text('prompt_version'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
export const uploadIntents = pgTable('upload_intents', {
  objectKey: uuid('object_key').primaryKey(),
  projectId: uuid('project_id')
    .notNull()
    .references(() => projects.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});
export const circuitGraphSnapshots = pgTable(
  'circuit_graph_snapshots',
  {
    id: uuid('id').notNull(),
    projectId: uuid('project_id').notNull(),
    projectRevision: integer('project_revision').notNull(),
    actorId: text('actor_id').notNull(),
    graph: jsonb('graph').notNull(),
    graphDigest: text('graph_digest').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    requestDigest: text('request_digest').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.projectId, table.id] })],
);
export const validationReports = pgTable(
  'validation_reports',
  {
    id: uuid('id').notNull(),
    projectId: uuid('project_id').notNull(),
    graphSnapshotId: uuid('graph_snapshot_id').notNull(),
    expectedProjectRevision: integer('expected_project_revision').notNull(),
    actorId: text('actor_id').notNull(),
    inputIdentity: jsonb('input_identity').notNull(),
    inputIdentityDigest: text('input_identity_digest').notNull(),
    report: jsonb('report').notNull(),
    reportDigest: text('report_digest').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.projectId, table.id] })],
);
export const firmwareArtifacts = pgTable(
  'firmware_artifacts',
  {
    id: uuid('id').notNull(),
    projectId: uuid('project_id').notNull(),
    projectRevision: integer('project_revision').notNull(),
    actorId: text('actor_id').notNull(),
    objectKey: uuid('object_key').notNull(),
    sha256: text('sha256').notNull(),
    byteLength: integer('byte_length').notNull(),
    language: text('language').notNull(),
    entrypoint: text('entrypoint').notNull(),
    boardPartId: text('board_part_id').notNull(),
    catalogReleaseId: text('catalog_release_id').notNull(),
    bundleDigest: text('bundle_digest'),
    totalByteLength: integer('total_byte_length').notNull(),
    buildSystem: text('build_system'),
    target: jsonb('target'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.projectId, table.id] })],
);
export const firmwareArtifactFiles = pgTable(
  'firmware_artifact_files',
  {
    projectId: uuid('project_id').notNull(),
    artifactId: uuid('artifact_id').notNull(),
    path: text('path').notNull(),
    objectKey: uuid('object_key').notNull(),
    sha256: text('sha256').notNull(),
    byteLength: integer('byte_length').notNull(),
    isEntrypoint: boolean('is_entrypoint').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.projectId, table.artifactId, table.path] })],
);
export const firmwareBuilds = pgTable(
  'firmware_builds',
  {
    projectId: uuid('project_id').notNull(),
    id: uuid('id').notNull(),
    sourceArtifactId: uuid('source_artifact_id').notNull(),
    sourceManifestDigest: text('source_manifest_digest').notNull(),
    compilerProfileId: text('compiler_profile_id').notNull(),
    compilerProfileDigest: text('compiler_profile_digest').notNull(),
    imageDigest: text('image_digest').notNull(),
    status: text('status').notNull(),
    result: jsonb('result').notNull(),
    resultDigest: text('result_digest').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    requestDigest: text('request_digest').notNull(),
    attestation: jsonb('attestation'),
    attestationDigest: text('attestation_digest'),
    attestationKeyId: text('attestation_key_id'),
    attestationJti: text('attestation_jti'),
    attestationIssuedAt: timestamp('attestation_issued_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.id] }),
    uniqueIndex('firmware_builds_project_idempotency').on(table.projectId, table.idempotencyKey),
    index('firmware_builds_source_latest').on(
      table.projectId,
      table.sourceArtifactId,
      table.createdAt,
      table.id,
    ),
  ],
);
export const firmwareBuildArtifacts = pgTable(
  'firmware_build_artifacts',
  {
    projectId: uuid('project_id').notNull(),
    buildId: uuid('build_id').notNull(),
    role: text('role').notNull(),
    path: text('path').notNull(),
    objectKey: uuid('object_key').notNull(),
    sha256: text('sha256').notNull(),
    byteLength: integer('byte_length').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.buildId, table.role] }),
    uniqueIndex('firmware_build_artifacts_object_key').on(table.objectKey),
    uniqueIndex('firmware_build_artifacts_path').on(table.projectId, table.buildId, table.path),
  ],
);
export const firmwareReviews = pgTable('firmware_reviews', {
  id: uuid('id').primaryKey(),
  projectId: uuid('project_id').notNull(),
  artifactId: uuid('artifact_id').notNull(),
  projectRevision: integer('project_revision').notNull(),
  actorId: text('actor_id').notNull(),
  decision: text('decision').notNull(),
  reason: text('reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
});
export const simulationRuns = pgTable(
  'simulation_runs',
  {
    id: uuid('id').notNull(),
    projectId: uuid('project_id').notNull(),
    actorId: text('actor_id').notNull(),
    projectRevision: integer('project_revision').notNull(),
    graphSnapshotId: uuid('graph_snapshot_id').notNull(),
    validationReportId: uuid('validation_report_id').notNull(),
    firmwareArtifactId: uuid('firmware_artifact_id').notNull(),
    firmwareReviewRevision: integer('firmware_review_revision').notNull(),
    binding: jsonb('binding').notNull(),
    bindingDigest: text('binding_digest').notNull(),
    requestDigest: text('request_digest').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    status: text('status').notNull(),
    run: jsonb('run').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.id] }),
    uniqueIndex('simulation_runs_project_idempotency').on(table.projectId, table.idempotencyKey),
    index('simulation_runs_project_latest').on(table.projectId, table.createdAt, table.id),
    index('simulation_runs_active')
      .on(table.projectId, table.status, table.createdAt)
      .where(sql`${table.status} IN ('queued','preparing','running','stopping')`),
  ],
);
export const simulationRunAttempts = pgTable(
  'simulation_run_attempts',
  {
    projectId: uuid('project_id').notNull(),
    runId: uuid('run_id').notNull(),
    jobId: uuid('job_id').notNull(),
    attemptNumber: integer('attempt_number').notNull(),
    attemptId: uuid('attempt_id').notNull(),
    payloadDigest: text('payload_digest').notNull(),
    executionProfileId: text('execution_profile_id').notNull(),
    imageDigest: text('image_digest').notNull(),
    bindingDigest: text('binding_digest').notNull(),
    requestJti: uuid('request_jti').notNull(),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull(),
    notBefore: timestamp('not_before', { withTimezone: true }).notNull(),
    deadlineAt: timestamp('deadline_at', { withTimezone: true }).notNull(),
    state: text('state').notNull(),
    responseJti: uuid('response_jti'),
    responseDigest: text('response_digest'),
    responseIssuedAt: timestamp('response_issued_at', { withTimezone: true }),
    stopRequestedAt: timestamp('stop_requested_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.runId, table.attemptNumber] }),
    uniqueIndex('simulation_run_attempts_attempt_id').on(table.attemptId),
    index('simulation_run_attempts_job_current').on(
      table.projectId,
      table.jobId,
      table.attemptNumber,
    ),
    index('simulation_run_attempts_response_jti').on(table.responseJti),
  ],
);
