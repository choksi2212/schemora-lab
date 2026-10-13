import { createHash, randomUUID } from 'node:crypto';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq, and, desc, or, ne, lt, sql, getTableColumns } from 'drizzle-orm';
import type { ConversationBundle, ExtractionResult } from '@schemora/contracts';
import * as schema from './schema.js';

export interface Project extends QueryResultRow {
  id: string;
  owner_id: string;
  title: string;
  status: string;
  revision: number;
  created_at: Date;
  updated_at: Date;
}
export interface ImportRow extends QueryResultRow {
  id: string;
  project_id: string;
  filename: string;
  object_key: string;
  source_digest: string;
  status: string;
  selected_conversation_id: string | null;
  bundle: ConversationBundle | null;
  extraction: ExtractionResult | null;
  error_code: string | null;
  created_at: Date;
  bundle_digest: string | null;
  extraction_digest: string | null;
  extraction_mode: 'deterministic' | 'provider' | null;
}
export interface ReviewRow extends QueryResultRow {
  id: string;
  import_id: string;
  candidate_id: string;
  decision: string;
  value: string | null;
  reason: string | null;
  revision: number;
  created_at: Date;
}
export interface Job extends QueryResultRow {
  id: string;
  project_id: string;
  kind: 'process_import' | 'delete_project';
  payload: { importId?: string };
  lease_token: string;
  attempts: number;
}
export interface CircuitGraphSnapshot extends QueryResultRow {
  id: string;
  project_id: string;
  project_revision: number;
  actor_id: string;
  graph: unknown;
  graph_digest: string;
  idempotency_key: string;
  request_digest: string;
  created_at: Date;
}
export interface ValidationReportRow extends QueryResultRow {
  id: string;
  project_id: string;
  graph_snapshot_id: string;
  expected_project_revision: number;
  actor_id: string;
  input_identity: unknown;
  input_identity_digest: string;
  report: unknown;
  report_digest: string;
  created_at: Date;
}
export interface FirmwareArtifactRow extends QueryResultRow {
  id: string;
  project_id: string;
  project_revision: number;
  actor_id: string;
  object_key: string;
  sha256: string;
  byte_length: number;
  language: 'c' | 'cpp' | 'arduino-cpp' | 'esp-idf-c';
  entrypoint: string;
  board_part_id: string;
  catalog_release_id: string;
  created_at: Date;
  review_status: 'accepted' | 'rejected' | null;
  review_reason: string | null;
}
export class RepositoryError extends Error {
  constructor(
    public code: string,
    public statusCode: number,
    public currentRevision?: number,
  ) {
    super(code);
  }
}
export function requestDigest(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    return (
      '{' +
      Object.keys(record)
        .sort()
        .map((key) => JSON.stringify(key) + ':' + canonicalJson(record[key]))
        .join(',') +
      '}'
    );
  }
  throw new RepositoryError('INVALID_JSON_PAYLOAD', 400);
}
function canonicalDigest(value: unknown) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}
export function publicProject(project: Project) {
  return {
    id: project.id,
    title: project.title,
    status: project.status,
    revision: project.revision,
    createdAt: project.created_at.toISOString(),
    updatedAt: project.updated_at.toISOString(),
  };
}
export function publicImport(source: ImportRow) {
  return {
    id: source.id,
    projectId: source.project_id,
    filename: source.filename,
    status: source.status,
    selectedConversationId: source.selected_conversation_id,
    errorCode: source.error_code,
    createdAt: source.created_at.toISOString(),
    conversations:
      source.bundle?.conversations.map((item) => ({
        id: item.id,
        title: item.title,
        messageCount: item.messages.length,
      })) ?? [],
    extraction: source.extraction,
    extractionMode: source.extraction_mode,
    warnings: [
      ...new Set([
        ...(source.bundle?.warnings ?? []),
        ...(source.bundle?.conversations.find((item) => item.id === source.selected_conversation_id)
          ?.warnings ?? []),
      ]),
    ],
  };
}
export function publicReview(review: ReviewRow) {
  return {
    id: review.id,
    importId: review.import_id,
    candidateId: review.candidate_id,
    decision: review.decision,
    value: review.value,
    reason: review.reason,
    revision: review.revision,
    createdAt: review.created_at.toISOString(),
  };
}

export function publicFirmwareArtifact(artifact: FirmwareArtifactRow) {
  return {
    id: artifact.id,
    projectId: artifact.project_id,
    projectRevision: artifact.project_revision,
    sha256: artifact.sha256,
    byteLength: artifact.byte_length,
    language: artifact.language,
    entrypoint: artifact.entrypoint,
    boardPartId: artifact.board_part_id,
    catalogReleaseId: artifact.catalog_release_id,
    reviewStatus: artifact.review_status ?? 'pending',
    reviewReason: artifact.review_reason,
    createdAt: artifact.created_at.toISOString(),
  };
}

export class Repository {
  readonly pool: Pool;
  readonly db: ReturnType<typeof drizzle<typeof schema>>;
  constructor(
    connectionString: string,
    max = 10,
    private readonly maxAttempts = 3,
  ) {
    this.pool = new Pool({
      connectionString,
      max,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 30_000,
      statement_timeout: 10_000,
      application_name: 'schemora',
    });
    this.db = drizzle(this.pool, { schema });
  }
  async transaction<T>(action: (client: PoolClient) => Promise<T>) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await action(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async list(owner: string, cursor?: string) {
    let position: { createdAt: string; id: string } | undefined;
    if (cursor) {
      try {
        const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
        if (
          typeof decoded.createdAt !== 'string' ||
          !Number.isFinite(Date.parse(decoded.createdAt)) ||
          !/^[a-f0-9-]{36}$/.test(decoded.id)
        )
          throw new Error();
        position = decoded;
      } catch {
        throw new RepositoryError('INVALID_CURSOR', 400);
      }
    }
    // Drizzle handles the simple scoped read; explicit SQL below owns locking semantics.
    const result = await this.db
      .select({
        ...getTableColumns(schema.projects),
        cursorCreatedAt: sql.raw('projects.created_at::text'),
      })
      .from(schema.projects)
      .where(
        and(
          eq(schema.projects.ownerId, owner),
          ne(schema.projects.status, 'deleting'),
          ne(schema.projects.status, 'deleted'),
          position
            ? or(
                lt(schema.projects.createdAt, sql`${position.createdAt}::timestamptz`),
                and(
                  eq(schema.projects.createdAt, sql`${position.createdAt}::timestamptz`),
                  lt(schema.projects.id, position.id),
                ),
              )
            : undefined,
        ),
      )
      .orderBy(desc(schema.projects.createdAt), desc(schema.projects.id))
      .limit(51);
    const items = result.slice(0, 50).map((item) => ({
      id: item.id,
      title: item.title,
      status: item.status,
      revision: item.revision,
      createdAt: item.createdAt.toISOString(),
      updatedAt: item.updatedAt.toISOString(),
    }));
    const tail = result.slice(0, 50).at(-1);
    return {
      items,
      nextCursor:
        result.length > 50 && tail
          ? Buffer.from(JSON.stringify({ createdAt: tail.cursorCreatedAt, id: tail.id })).toString(
              'base64url',
            )
          : null,
    };
  }
  async project(
    client: PoolClient,
    owner: string,
    id: string,
    lock: boolean | 'share' = false,
    allowDeleting = false,
  ) {
    const result = await client.query<Project>(
      'SELECT * FROM projects WHERE id=$1 AND owner_id=$2' +
        (lock === 'share' ? ' FOR SHARE' : lock ? ' FOR UPDATE' : ''),
      [id, owner],
    );
    const project = result.rows[0];
    if (
      !project ||
      project.status === 'deleted' ||
      (!allowDeleting && project.status === 'deleting')
    )
      throw new RepositoryError('NOT_FOUND', 404);
    return project;
  }
  async detail(owner: string, id: string) {
    return this.transaction(async (client) => {
      // Hold a share lock so deletion cannot revoke authorization midway through this read.
      const project = await this.project(client, owner, id, 'share');
      const imports = await client.query<ImportRow>(
        'SELECT * FROM imports WHERE project_id=$1 ORDER BY created_at DESC LIMIT 20',
        [id],
      );
      const reviews = await client.query<ReviewRow>(
        'SELECT DISTINCT ON(import_id,candidate_id) * FROM reviews WHERE project_id=$1 ORDER BY import_id,candidate_id,revision DESC LIMIT 2000',
        [id],
      );
      return {
        project: publicProject(project),
        imports: imports.rows.map((source) => ({ ...publicImport(source), extraction: null })),
        reviews: reviews.rows.map(publicReview),
      };
    });
  }
  private firmwareArtifactQuery() {
    return `SELECT a.*, latest.decision AS review_status, latest.reason AS review_reason
      FROM firmware_artifacts a
      LEFT JOIN LATERAL (
        SELECT decision, reason FROM firmware_reviews
        WHERE project_id=a.project_id AND artifact_id=a.id
        ORDER BY project_revision DESC LIMIT 1
      ) latest ON true`;
  }
  async firmwareArtifacts(owner: string, projectId: string) {
    return this.transaction(async (client) => {
      await this.project(client, owner, projectId, 'share');
      const result = await client.query<FirmwareArtifactRow>(
        this.firmwareArtifactQuery() +
          ' WHERE a.project_id=$1 ORDER BY a.created_at DESC,a.id DESC LIMIT 100',
        [projectId],
      );
      return result.rows.map(publicFirmwareArtifact);
    });
  }
  async firmwareArtifactRecord(owner: string, projectId: string, artifactId: string) {
    return this.transaction(async (client) => {
      await this.project(client, owner, projectId, 'share');
      const result = await client.query<FirmwareArtifactRow>(
        this.firmwareArtifactQuery() + ' WHERE a.project_id=$1 AND a.id=$2',
        [projectId, artifactId],
      );
      if (!result.rows[0]) throw new RepositoryError('NOT_FOUND', 404);
      return result.rows[0];
    });
  }
  async withFirmwareArtifact<T>(
    owner: string,
    projectId: string,
    artifactId: string,
    action: (record: FirmwareArtifactRow) => Promise<T>,
  ) {
    return this.transaction(async (client) => {
      // Keep deletion from starting between authorization and the bounded object read.
      await this.project(client, owner, projectId, 'share');
      const result = await client.query<FirmwareArtifactRow>(
        this.firmwareArtifactQuery() + ' WHERE a.project_id=$1 AND a.id=$2',
        [projectId, artifactId],
      );
      const record = result.rows[0];
      if (!record) throw new RepositoryError('NOT_FOUND', 404);
      return action(record);
    });
  }
  async firmwareArtifactReviews(owner: string, projectId: string, artifactId: string) {
    return this.transaction(async (client) => {
      await this.project(client, owner, projectId, 'share');
      const artifact = await client.query(
        'SELECT id FROM firmware_artifacts WHERE project_id=$1 AND id=$2',
        [projectId, artifactId],
      );
      if (!artifact.rows[0]) throw new RepositoryError('NOT_FOUND', 404);
      const reviews = await client.query<{
        id: string;
        project_revision: number;
        decision: 'accepted' | 'rejected';
        reason: string | null;
        created_at: Date;
      }>(
        'SELECT id,project_revision,decision,reason,created_at FROM firmware_reviews WHERE project_id=$1 AND artifact_id=$2 ORDER BY project_revision DESC LIMIT 100',
        [projectId, artifactId],
      );
      return reviews.rows.map((review) => ({
        id: review.id,
        projectRevision: review.project_revision,
        decision: review.decision,
        reason: review.reason,
        createdAt: review.created_at.toISOString(),
      }));
    });
  }
  async import(client: PoolClient, projectId: string, id: string) {
    const result = await client.query<ImportRow>(
      'SELECT * FROM imports WHERE project_id=$1 AND id=$2',
      [projectId, id],
    );
    if (!result.rows[0]) throw new RepositoryError('NOT_FOUND', 404);
    return result.rows[0];
  }
  async importDetail(owner: string, projectId: string, id: string, messageOffset = 0) {
    return this.transaction(async (client) => {
      const project = await this.project(client, owner, projectId, 'share');
      const source = await this.import(client, projectId, id);
      const reviews = await client.query<ReviewRow>(
        'SELECT DISTINCT ON(candidate_id) * FROM reviews WHERE project_id=$1 AND import_id=$2 ORDER BY candidate_id,revision DESC LIMIT 2000',
        [projectId, id],
      );
      const conversation = source.bundle?.conversations.find(
        (item) => item.id === source.selected_conversation_id,
      );
      const messages = conversation?.messages.slice(messageOffset, messageOffset + 200) ?? [];
      return {
        project: publicProject(project),
        import: publicImport(source),
        messages,
        reviews: reviews.rows.map(publicReview),
        nextMessageSequence:
          conversation && conversation.messages.length > messageOffset + 200
            ? messageOffset + 200
            : null,
      };
    });
  }
  async revisionHistory(owner: string, id: string, before = 2147483647) {
    return this.transaction(async (client) => {
      await this.project(client, owner, id, 'share');
      const result = await client.query(
        'SELECT revision,kind,created_at,digest FROM revisions WHERE project_id=$1 AND revision<$2 ORDER BY revision DESC LIMIT 100',
        [id, before],
      );
      return result.rows.map((row) => ({
        revision: row.revision,
        kind: row.kind,
        createdAt: row.created_at.toISOString(),
        digest: row.digest,
      }));
    });
  }
  async saveRevision(
    client: PoolClient,
    project: Project,
    actor: string,
    kind: string,
    graphRef?: { id: string; digest: string; revision: number } | null,
  ) {
    const imports = await client.query(
      'SELECT id,filename,status,source_digest,selected_conversation_id,bundle_digest,extraction_digest,extraction_mode,parser_version,normalizer_schema,extractor_version,provider_model,prompt_version FROM imports WHERE project_id=$1 ORDER BY id',
      [project.id],
    );
    const firmwareArtifacts = await client.query(
      `SELECT a.id,a.sha256,a.byte_length,a.language,a.entrypoint,a.board_part_id,
        a.catalog_release_id,a.project_revision,a.created_at,
        coalesce(latest.decision,'pending') AS review_status,
        latest.project_revision AS review_revision
      FROM firmware_artifacts a
      LEFT JOIN LATERAL (
        SELECT decision,project_revision FROM firmware_reviews
        WHERE project_id=a.project_id AND artifact_id=a.id
        ORDER BY project_revision DESC LIMIT 1
      ) latest ON true
      WHERE a.project_id=$1 ORDER BY a.created_at,a.id`,
      [project.id],
    );
    let associatedGraph = graphRef;
    if (associatedGraph === undefined) {
      const graph = await client.query<{
        id: string;
        graph_digest: string;
        project_revision: number;
      }>(
        'SELECT id,graph_digest,project_revision FROM circuit_graph_snapshots WHERE project_id=$1 AND project_revision<=$2 ORDER BY project_revision DESC LIMIT 1',
        [project.id, project.revision],
      );
      const latest = graph.rows[0];
      associatedGraph = latest
        ? { id: latest.id, digest: latest.graph_digest, revision: latest.project_revision }
        : null;
    }
    const snapshot = {
      schemaVersion: 1,
      project: publicProject(project),
      imports: imports.rows,
      firmwareArtifacts: firmwareArtifacts.rows,
      reviewThroughRevision: project.revision,
      circuitGraph: associatedGraph,
    };
    await client.query(
      'INSERT INTO revisions(project_id,revision,actor_id,kind,snapshot,digest) VALUES($1,$2,$3,$4,$5,$6)',
      [
        project.id,
        project.revision,
        actor,
        kind,
        JSON.stringify(snapshot),
        requestDigest(snapshot),
      ],
    );
  }
  async saveCircuitGraph(
    owner: string,
    projectId: string,
    expectedRevision: number,
    key: string,
    input: { graph: unknown },
  ) {
    return this.transaction(async (client) => {
      const project = await this.project(client, owner, projectId, true);
      const fingerprint = canonicalDigest({ expectedRevision, input });
      const scope = projectId + ':circuit_graph';
      const replay = await this.replay(client, owner, scope, key, fingerprint);
      if (replay) return replay;
      if (project.revision !== expectedRevision)
        throw new RepositoryError('REVISION_CONFLICT', 409, project.revision);
      if (project.status !== 'active') throw new RepositoryError('PROJECT_ARCHIVED', 409);
      const graphDigest = canonicalDigest(input.graph);
      const id = randomUUID();
      const nextRevision = project.revision + 1;
      await client.query(
        'INSERT INTO circuit_graph_snapshots(id,project_id,project_revision,actor_id,graph,graph_digest,idempotency_key,request_digest) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [
          id,
          projectId,
          nextRevision,
          owner,
          canonicalJson(input.graph),
          graphDigest,
          key,
          fingerprint,
        ],
      );
      const updated = await client.query<Project>(
        'UPDATE projects SET revision=$2,updated_at=now() WHERE id=$1 RETURNING *',
        [projectId, nextRevision],
      );
      const committed = updated.rows[0]!;
      await this.saveRevision(client, committed, owner, 'circuit_graph_saved', {
        id,
        digest: graphDigest,
        revision: nextRevision,
      });
      const snapshot = {
        id,
        projectId,
        projectRevision: nextRevision,
        graph: input.graph,
        graphDigest,
      };
      const response = { project: publicProject(committed), graphSnapshot: snapshot };
      await this.remember(client, owner, scope, key, fingerprint, response);
      return response;
    });
  }
  async latestCircuitGraph(owner: string, projectId: string) {
    return this.transaction(async (client) => {
      const project = await this.project(client, owner, projectId, 'share');
      const revision = await client.query<{
        snapshot: { circuitGraph?: { id: string; digest: string; revision: number } | null };
      }>('SELECT snapshot FROM revisions WHERE project_id=$1 AND revision=$2', [
        projectId,
        project.revision,
      ]);
      const graphId = revision.rows[0]?.snapshot.circuitGraph?.id;
      if (!graphId) return { project: publicProject(project), graphSnapshot: null };
      const result = await client.query<CircuitGraphSnapshot>(
        'SELECT * FROM circuit_graph_snapshots WHERE project_id=$1 AND id=$2',
        [projectId, graphId],
      );
      const graph = result.rows[0];
      if (!graph) throw new RepositoryError('GRAPH_SNAPSHOT_CORRUPT', 500);
      const reference = revision.rows[0]?.snapshot.circuitGraph;
      if (
        !reference ||
        reference.digest !== graph.graph_digest ||
        reference.revision !== graph.project_revision
      )
        throw new RepositoryError('GRAPH_SNAPSHOT_CORRUPT', 500);
      return { project: publicProject(project), graphSnapshot: this.publicGraph(graph) };
    });
  }
  private publicGraph(graph: CircuitGraphSnapshot) {
    return {
      id: graph.id,
      projectId: graph.project_id,
      projectRevision: graph.project_revision,
      graph: graph.graph,
      graphDigest: graph.graph_digest,
      createdAt: graph.created_at.toISOString(),
    };
  }
  private async graphAtRevision(client: PoolClient, projectId: string, revision: number) {
    const result = await client.query<{ snapshot: { circuitGraph?: { id: string } | null } }>(
      'SELECT snapshot FROM revisions WHERE project_id=$1 AND revision=$2',
      [projectId, revision],
    );
    const graphId = result.rows[0]?.snapshot.circuitGraph?.id;
    if (!graphId) throw new RepositoryError('GRAPH_SNAPSHOT_NOT_FOUND', 404);
    return graphId;
  }
  async saveValidationReport(
    owner: string,
    projectId: string,
    expectedRevision: number,
    input: { graphSnapshotId: string; inputIdentity: unknown; report: unknown },
  ) {
    return this.transaction(async (client) => {
      const project = await this.project(client, owner, projectId, true);
      if (project.revision !== expectedRevision)
        throw new RepositoryError('REVISION_CONFLICT', 409, project.revision);
      const expectedGraphId = await this.graphAtRevision(client, projectId, expectedRevision);
      if (expectedGraphId !== input.graphSnapshotId)
        throw new RepositoryError('GRAPH_REVISION_CONFLICT', 409, project.revision);
      const identity = { graphSnapshotId: input.graphSnapshotId, identity: input.inputIdentity };
      const identityDigest = canonicalDigest(identity);
      const reportDigest = canonicalDigest(input.report);
      const existing = await client.query<ValidationReportRow>(
        'SELECT * FROM validation_reports WHERE project_id=$1 AND graph_snapshot_id=$2 AND input_identity_digest=$3',
        [projectId, input.graphSnapshotId, identityDigest],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].report_digest !== reportDigest)
          throw new RepositoryError('IDEMPOTENCY_CONFLICT', 409);
        return {
          report: this.publicValidation(existing.rows[0]),
          current:
            (await this.graphAtRevision(client, projectId, project.revision)) ===
            input.graphSnapshotId,
        };
      }
      const inserted = await client.query<ValidationReportRow>(
        'INSERT INTO validation_reports(id,project_id,graph_snapshot_id,expected_project_revision,actor_id,input_identity,input_identity_digest,report,report_digest) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
        [
          randomUUID(),
          projectId,
          input.graphSnapshotId,
          expectedRevision,
          owner,
          canonicalJson(input.inputIdentity),
          identityDigest,
          canonicalJson(input.report),
          reportDigest,
        ],
      );
      return {
        report: this.publicValidation(inserted.rows[0]!),
        current:
          (await this.graphAtRevision(client, projectId, project.revision)) ===
          input.graphSnapshotId,
      };
    });
  }
  async latestValidationReport(owner: string, projectId: string, graphSnapshotId?: string) {
    return this.transaction(async (client) => {
      const project = await this.project(client, owner, projectId, 'share');
      const currentGraphId = await this.graphAtRevision(client, projectId, project.revision).catch(
        (error) => {
          if (error instanceof RepositoryError && error.code === 'GRAPH_SNAPSHOT_NOT_FOUND')
            return null;
          throw error;
        },
      );
      const result = await client.query<ValidationReportRow>(
        'SELECT * FROM validation_reports WHERE project_id=$1 AND graph_snapshot_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1',
        [projectId, graphSnapshotId ?? currentGraphId],
      );
      const report = result.rows[0];
      return {
        project: publicProject(project),
        report: report ? this.publicValidation(report) : null,
        current: report !== undefined && report.graph_snapshot_id === currentGraphId,
      };
    });
  }
  private publicValidation(report: ValidationReportRow) {
    return {
      id: report.id,
      projectId: report.project_id,
      graphSnapshotId: report.graph_snapshot_id,
      expectedProjectRevision: report.expected_project_revision,
      inputIdentity: report.input_identity,
      inputIdentityDigest: report.input_identity_digest,
      report: report.report,
      reportDigest: report.report_digest,
      createdAt: report.created_at.toISOString(),
    };
  }
  async revisionDetail(owner: string, id: string, revision: number) {
    return this.transaction(async (client) => {
      await this.project(client, owner, id, 'share');
      const result = await client.query(
        'SELECT revision,kind,created_at,snapshot,digest FROM revisions WHERE project_id=$1 AND revision=$2',
        [id, revision],
      );
      const row = result.rows[0];
      if (!row) throw new RepositoryError('NOT_FOUND', 404);
      return {
        revision: row.revision,
        kind: row.kind,
        createdAt: row.created_at.toISOString(),
        snapshot: row.snapshot,
        digest: row.digest,
      };
    });
  }
  async reviewHistory(owner: string, projectId: string, importId: string, before = 2147483647) {
    return this.transaction(async (client) => {
      await this.project(client, owner, projectId, 'share');
      await this.import(client, projectId, importId);
      const result = await client.query<ReviewRow>(
        'SELECT * FROM reviews WHERE project_id=$1 AND import_id=$2 AND revision<$3 ORDER BY revision DESC LIMIT 100',
        [projectId, importId, before],
      );
      return result.rows.map(publicReview);
    });
  }
  async create(owner: string, title: string, key: string) {
    return this.transaction(async (client) => {
      await client.query('INSERT INTO principals(id) VALUES($1) ON CONFLICT DO NOTHING', [owner]);
      const scope = 'create_project';
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [owner + scope + key]);
      const fingerprint = requestDigest({ title });
      const replay = await this.replay(client, owner, scope, key, fingerprint);
      if (replay) return replay;
      const result = await client.query<Project>(
        "INSERT INTO projects(id,owner_id,title,status,revision) VALUES($1,$2,$3,'active',1) RETURNING *",
        [randomUUID(), owner, title],
      );
      const project = result.rows[0]!;
      await this.saveRevision(client, project, owner, 'project_created');
      const response = publicProject(project);
      await this.remember(client, owner, scope, key, fingerprint, response);
      return response;
    });
  }
  async replay(client: PoolClient, owner: string, scope: string, key: string, fingerprint: string) {
    const previous = await client.query(
      'SELECT request_digest,response FROM idempotency WHERE owner_id=$1 AND scope=$2 AND key=$3',
      [owner, scope, key],
    );
    if (previous.rows[0]) {
      if (previous.rows[0].request_digest !== fingerprint)
        throw new RepositoryError('IDEMPOTENCY_CONFLICT', 409);
      return previous.rows[0].response;
    }
    return null;
  }
  async remember(
    client: PoolClient,
    owner: string,
    scope: string,
    key: string,
    fingerprint: string,
    response: unknown,
  ) {
    await client.query(
      'INSERT INTO idempotency(owner_id,scope,key,request_digest,response) VALUES($1,$2,$3,$4,$5)',
      [owner, scope, key, fingerprint, JSON.stringify(response)],
    );
  }
  async mutate<T>(
    owner: string,
    id: string,
    expected: number,
    key: string,
    kind: string,
    body: unknown,
    action: (client: PoolClient, project: Project) => Promise<T>,
  ) {
    return this.transaction(async (client) => {
      const project = await this.project(client, owner, id, true, kind === 'project_deleted');
      const fingerprint = requestDigest(body);
      const scope = id + ':' + kind;
      const replay = await this.replay(client, owner, scope, key, fingerprint);
      if (replay) return replay;
      if (project.revision !== expected)
        throw new RepositoryError('REVISION_CONFLICT', 409, project.revision);
      if (project.status === 'deleting') throw new RepositoryError('NOT_FOUND', 404);
      if (project.status === 'archived' && kind !== 'project_deleted')
        throw new RepositoryError('PROJECT_ARCHIVED', 409);
      project.revision += 1;
      const output = await action(client, project);
      const updated = await client.query<Project>(
        'UPDATE projects SET title=$2,status=$3,revision=$4,updated_at=now() WHERE id=$1 RETURNING *',
        [id, project.title, project.status, project.revision],
      );
      const committed = updated.rows[0]!;
      await this.saveRevision(client, committed, owner, kind);
      const response = { project: publicProject(committed), ...output };
      await this.remember(client, owner, scope, key, fingerprint, response);
      return response;
    });
  }
  async enqueue(client: PoolClient, projectId: string, kind: Job['kind'], payload: unknown) {
    await client.query('INSERT INTO outbox(id,project_id,kind,payload) VALUES($1,$2,$3,$4)', [
      randomUUID(),
      projectId,
      kind,
      JSON.stringify(payload),
    ]);
  }
  async registerUploadIntent(owner: string, projectId: string, objectKey: string) {
    await this.transaction(async (client) => {
      const project = await this.project(client, owner, projectId, true);
      if (project.status !== 'active') throw new RepositoryError('PROJECT_ARCHIVED', 409);
      const pending = await client.query(
        'SELECT count(*)::int AS count FROM upload_intents WHERE project_id=$1',
        [projectId],
      );
      if (pending.rows[0].count >= 20) throw new RepositoryError('UPLOAD_LIMIT', 429);
      await client.query('INSERT INTO upload_intents(object_key,project_id) VALUES($1,$2)', [
        objectKey,
        projectId,
      ]);
    });
  }
  async consumeUploadIntent(client: PoolClient, projectId: string, objectKey: string) {
    const consumed = await client.query(
      'DELETE FROM upload_intents WHERE project_id=$1 AND object_key=$2 AND expires_at>now() RETURNING object_key',
      [projectId, objectKey],
    );
    if (consumed.rowCount !== 1) throw new RepositoryError('UPLOAD_EXPIRED', 409);
  }
  async discardUploadIntent(objectKey: string) {
    await this.pool.query('DELETE FROM upload_intents WHERE object_key=$1', [objectKey]);
  }
  async cleanupUploadIntents(removeObject: (key: string) => Promise<void>) {
    const pending = await this.pool.query<{ object_key: string }>(
      'SELECT object_key FROM upload_intents WHERE expires_at<=now() ORDER BY expires_at LIMIT 10',
    );
    let removed = 0;
    for (const item of pending.rows) {
      await this.transaction(async (client) => {
        const intent = await client.query(
          'SELECT object_key FROM upload_intents WHERE object_key=$1 AND expires_at<=now() FOR UPDATE SKIP LOCKED',
          [item.object_key],
        );
        if (!intent.rows[0]) return;
        const accepted = await client.query(
          'SELECT id FROM imports WHERE object_key=$1 UNION ALL SELECT id FROM firmware_artifacts WHERE object_key=$1 LIMIT 1',
          [item.object_key],
        );
        if (!accepted.rows[0]) await removeObject(item.object_key);
        await client.query('DELETE FROM upload_intents WHERE object_key=$1', [item.object_key]);
        removed++;
      }).catch(() => {
        // Preserve the durable intent if object removal fails; next maintenance pass retries.
        if (process.env.NODE_ENV !== 'test')
          console.error(JSON.stringify({ event: 'upload_cleanup_unavailable' }));
      });
    }
    return removed;
  }
  async dispatch() {
    return this.transaction(async (client) => {
      const rows = await client.query(
        'SELECT * FROM outbox WHERE delivered_at IS NULL ORDER BY created_at LIMIT 20 FOR UPDATE SKIP LOCKED',
      );
      for (const row of rows.rows) {
        await client.query(
          'INSERT INTO jobs(id,project_id,kind,payload) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
          [row.id, row.project_id, row.kind, JSON.stringify(row.payload)],
        );
        await client.query('UPDATE outbox SET delivered_at=now() WHERE id=$1', [row.id]);
      }
      return rows.rowCount;
    });
  }
  async claim(kind: Job['kind'], leaseSeconds: number) {
    return this.transaction(async (client) => {
      const result = await client.query<Job>(
        "WITH next AS (SELECT id FROM jobs WHERE kind=$1 AND ((status='queued' AND available_at<=now()) OR (status='running' AND lease_until<now())) AND attempts<$4 ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED) UPDATE jobs j SET status='running',attempts=attempts+1,lease_until=now()+$2*interval '1 second',lease_token=$3 FROM next WHERE j.id=next.id RETURNING j.*",
        [kind, leaseSeconds, randomUUID(), this.maxAttempts],
      );
      return result.rows[0] ?? null;
    });
  }
  async renewLease(job: Job, leaseSeconds: number) {
    const result = await this.pool.query(
      "UPDATE jobs SET lease_until=now()+$3*interval '1 second' WHERE id=$1 AND lease_token=$2 AND status='running' AND lease_until>now()",
      [job.id, job.lease_token, leaseSeconds],
    );
    return result.rowCount === 1;
  }
  async jobScope(client: PoolClient, job: Job) {
    const projects = await client.query<Project>('SELECT * FROM projects WHERE id=$1 FOR UPDATE', [
      job.project_id,
    ]);
    const jobs = await client.query(
      "SELECT id FROM jobs WHERE id=$1 AND lease_token=$2 AND status='running' AND lease_until>now() FOR UPDATE",
      [job.id, job.lease_token],
    );
    if (!jobs.rows[0] || !projects.rows[0]) return null;
    return projects.rows[0];
  }
  async fail(job: Job, code: string, retryable: boolean) {
    await this.transaction(async (client) => {
      const project = await this.jobScope(client, job);
      if (!project) return;
      const retry = retryable && job.attempts < this.maxAttempts;
      await client.query(
        "UPDATE jobs SET status=$2,error_code=$3,available_at=now()+$4*interval '1 second',lease_until=NULL WHERE id=$1",
        [job.id, retry ? 'queued' : 'failed', code, 2 ** job.attempts],
      );
      if (job.payload.importId && project.status !== 'deleting' && project.status !== 'deleted') {
        await client.query(
          "UPDATE imports SET status=$3,error_code=$4 WHERE id=$1 AND project_id=$2 AND status IN ('queued','processing')",
          [job.payload.importId, job.project_id, retry ? 'queued' : 'failed', retry ? null : code],
        );
      }
    });
  }
  async reapExpired() {
    await this.pool.query(
      "UPDATE jobs SET status='failed',error_code='RETRY_EXHAUSTED' WHERE status='running' AND lease_until<now() AND attempts>=$1",
      [this.maxAttempts],
    );
    await this.pool.query(
      "UPDATE imports i SET status='failed',error_code='RETRY_EXHAUSTED' WHERE status='processing' AND EXISTS(SELECT 1 FROM jobs j WHERE j.payload->>'importId'=i.id::text AND j.status='failed' AND j.error_code='RETRY_EXHAUSTED') AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.payload->>'importId'=i.id::text AND j.status IN ('queued','running'))",
    );
  }
}
