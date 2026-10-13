import { pgTable, text, uuid, integer, timestamp, jsonb, primaryKey } from 'drizzle-orm/pg-core';

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
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.projectId, table.id] })],
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
