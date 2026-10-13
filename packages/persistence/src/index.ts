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
  async saveRevision(client: PoolClient, project: Project, actor: string, kind: string) {
    const imports = await client.query(
      'SELECT id,filename,status,source_digest,selected_conversation_id,bundle_digest,extraction_digest,extraction_mode,parser_version,normalizer_schema,extractor_version,provider_model,prompt_version FROM imports WHERE project_id=$1 ORDER BY id',
      [project.id],
    );
    const snapshot = {
      schemaVersion: 1,
      project: publicProject(project),
      imports: imports.rows,
      reviewThroughRevision: project.revision,
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
        const accepted = await client.query('SELECT id FROM imports WHERE object_key=$1', [
          item.object_key,
        ]);
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
