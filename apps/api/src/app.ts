import Fastify, { type FastifyRequest } from 'fastify';
import { jwtVerify } from 'jose';
import { z, ZodError } from 'zod';
import { randomUUID } from 'node:crypto';
import { currentCatalogRelease } from './catalog.js';
import { Repository, RepositoryError, publicImport, publicReview } from '@schemora/persistence';
import { MAX_SOURCE_BYTES, type PrivateStorage } from '@schemora/storage';
import { circuitGraphSchema, validateCircuitGraph } from '@schemora/circuit-model';
import { getCatalogRelease } from '@schemora/catalog';
import { validateCircuit } from '@schemora/validation';
import { AssemblyPlanBlockedError, generateAssemblyPlan } from '@schemora/assembly-plan';
import type { ApiConfig } from './config.js';

const uuid = z.string().uuid();
const expectedRevision = z.number().int().positive();
const scope = z.object({ projectId: uuid });
const importScope = scope.extend({ importId: uuid });
const mutation = z.object({ expectedRevision }).strict();
const circuitGraphWrite = z.object({ expectedRevision, graph: circuitGraphSchema }).strict();
const titleSchema = z.string().trim().min(1).max(120);
const uploadSchema = z
  .object({
    expectedRevision,
    filename: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[^/\\\u0000-\u001f]+\.(txt|md|html|pdf|json|zip)$/i),
    contentBase64: z
      .string()
      .min(4)
      .max(Math.ceil(MAX_SOURCE_BYTES / 3) * 4)
      .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
  })
  .strict();
const reviewSchema = z
  .object({
    expectedRevision,
    candidateId: z.string().min(1).max(200),
    decision: z.enum(['accept', 'reject', 'correct', 'obsolete']),
    value: z.string().trim().min(1).max(20_000).optional(),
    reason: z.string().trim().max(2000).optional(),
  })
  .strict()
  .superRefine((item, ctx) => {
    if (item.decision === 'correct' && !item.value)
      ctx.addIssue({ code: 'custom', path: ['value'], message: 'A correction needs a value' });
    if (item.decision !== 'correct' && item.value !== undefined)
      ctx.addIssue({
        code: 'custom',
        path: ['value'],
        message: 'Only corrections may set a value',
      });
  });
function key(request: FastifyRequest) {
  return uuid.parse(request.headers['idempotency-key']);
}

export function buildApp(config: ApiConfig, repository: Repository, storage: PrivateStorage) {
  const app = Fastify({
    bodyLimit: 14 * 1024 * 1024,
    logger: false,
    requestTimeout: 30_000,
    connectionTimeout: 10_000,
  });
  app.addHook('onResponse', async (request, reply) => {
    if (config.NODE_ENV !== 'test')
      console.log(
        JSON.stringify({
          event: 'api_response',
          route: request.routeOptions.url ?? 'unmatched',
          statusCode: reply.statusCode,
          durationMs: Math.round(reply.elapsedTime),
          requestId: request.id,
        }),
      );
  });
  const identities = new WeakMap<FastifyRequest, string>();
  app.addHook('onRequest', async (request, reply) => {
    if (request.url === '/health/live' || request.url === '/health/ready') return;
    if (request.headers.origin && request.headers.origin !== new URL(config.WEB_ORIGIN).origin) {
      throw new RepositoryError('ORIGIN_DENIED', 403);
    }
    const token = request.headers.authorization?.match(/^Bearer ([^\s]+)$/)?.[1];
    if (!token) throw new RepositoryError('UNAUTHENTICATED', 401);
    try {
      const { payload } = await jwtVerify(token, new TextEncoder().encode(config.SESSION_SECRET), {
        algorithms: ['HS256'],
        issuer: 'schemora-web',
        audience: 'schemora-api',
        requiredClaims: ['sub', 'exp', 'iat'],
        clockTolerance: 5,
      });
      if (
        !payload.sub ||
        payload.sub.length > 200 ||
        !payload.exp ||
        !payload.iat ||
        payload.exp - payload.iat > 300 ||
        payload.iat > Math.floor(Date.now() / 1000) + 5
      ) {
        throw new Error('Invalid session');
      }
      if (config.NODE_ENV === 'production' && !/^github:\d+$/.test(payload.sub))
        throw new Error('Unsupported production principal');
      identities.set(request, payload.sub);
    } catch {
      await reply.code(401).send({
        error: {
          code: 'UNAUTHENTICATED',
          message: 'Sign in to continue.',
          retryable: false,
          requestId: request.id,
        },
      });
    }
  });
  const owner = (request: FastifyRequest) => {
    const principal = identities.get(request);
    if (!principal) throw new RepositoryError('UNAUTHENTICATED', 401);
    return principal;
  };
  const envelope = (request: FastifyRequest, data: unknown) => ({ data, requestId: request.id });
  app.setErrorHandler((error, request, reply) => {
    const domain = error instanceof RepositoryError;
    const frameworkStatus =
      error instanceof Error && 'statusCode' in error ? error.statusCode : undefined;
    const invalid = error instanceof ZodError || frameworkStatus === 400;
    const status = domain ? error.statusCode : invalid ? 400 : frameworkStatus === 413 ? 413 : 500;
    const code = domain
      ? error.code
      : invalid
        ? 'INVALID_INPUT'
        : status === 413
          ? 'SOURCE_TOO_LARGE'
          : 'SERVICE_UNAVAILABLE';
    reply.code(status).send({
      error: {
        code,
        message: domain
          ? ({
              NOT_FOUND: 'Project or resource is unavailable.',
              REVISION_CONFLICT: 'This project changed. Refresh before saving.',
              IDEMPOTENCY_CONFLICT: 'This request identifier was already used for another action.',
              PROJECT_ARCHIVED: 'Archived projects are read only.',
              VALIDATION_REQUIRED:
                'Save and validate this exact circuit before creating an assembly guide.',
              CHECKS_FAILED: 'Resolve failing circuit checks before creating an assembly guide.',
            }[code] ?? 'This action is unavailable in the current state.')
          : invalid
            ? 'Check the submitted fields.'
            : status === 413
              ? 'Choose a file smaller than 10 MiB.'
              : 'The service is unavailable. Try again.',
        retryable: status === 500,
        requestId: request.id,
        ...(domain && error.currentRevision !== undefined
          ? { currentRevision: error.currentRevision }
          : {}),
      },
    });
  });
  app.get('/health/live', async () => ({ status: 'ok' }));
  app.get('/health/ready', async (_request, reply) => {
    try {
      await repository.pool.query('SELECT 1');
      return { status: 'ready' };
    } catch {
      return reply.code(503).send({ status: 'unavailable' });
    }
  });
  app.get('/v1/catalog', async (request) => {
    const { release, sha256 } = currentCatalogRelease();
    return envelope(request, {
      releases: [
        {
          schemaVersion: release.schemaVersion,
          releaseId: release.releaseId,
          publishedOn: release.publishedOn,
          status: release.status,
          sha256,
          parts: release.parts,
        },
      ],
    });
  });
  app.get('/v1/catalog/:releaseId', async (request) => {
    const { releaseId } = z
      .object({
        releaseId: z
          .string()
          .min(1)
          .max(100)
          .regex(/^[a-zA-Z0-9._-]+$/),
      })
      .parse(request.params);
    const { release, sha256 } = currentCatalogRelease();
    if (release.releaseId !== releaseId) throw new RepositoryError('NOT_FOUND', 404);
    return envelope(request, {
      schemaVersion: release.schemaVersion,
      releaseId: release.releaseId,
      publishedOn: release.publishedOn,
      status: release.status,
      sha256,
      release,
    });
  });
  app.get('/v1/projects', async (request) => {
    const query = z.object({ cursor: z.string().max(300).optional() }).parse(request.query);
    return envelope(request, await repository.list(owner(request), query.cursor));
  });
  app.post('/v1/projects', async (request, reply) => {
    const body = z.object({ title: titleSchema }).strict().parse(request.body);
    return reply
      .code(201)
      .send(envelope(request, await repository.create(owner(request), body.title, key(request))));
  });
  app.get('/v1/projects/:projectId', async (request) => {
    const { projectId } = scope.parse(request.params);
    return envelope(request, await repository.detail(owner(request), projectId));
  });
  app.get('/v1/projects/:projectId/revisions', async (request) => {
    const { projectId } = scope.parse(request.params);
    const { before } = z
      .object({ before: z.coerce.number().int().positive().optional() })
      .parse(request.query);
    return envelope(request, await repository.revisionHistory(owner(request), projectId, before));
  });
  app.get('/v1/projects/:projectId/revisions/:revision', async (request) => {
    const { projectId, revision } = scope
      .extend({ revision: z.coerce.number().int().positive() })
      .parse(request.params);
    return envelope(request, await repository.revisionDetail(owner(request), projectId, revision));
  });
  app.get('/v1/projects/:projectId/circuit', async (request) => {
    const { projectId } = scope.parse(request.params);
    return envelope(request, await repository.latestCircuitGraph(owner(request), projectId));
  });
  app.put('/v1/projects/:projectId/circuit', async (request) => {
    const { projectId } = scope.parse(request.params);
    const body = circuitGraphWrite.parse(request.body);
    if (
      body.graph.projectId !== projectId ||
      body.graph.projectRevision !== body.expectedRevision + 1
    )
      throw new RepositoryError('INVALID_GRAPH', 400);
    const release = getCatalogRelease();
    if (body.graph.catalogReleaseId !== release.releaseId)
      throw new RepositoryError('INVALID_GRAPH', 400);
    const structure = validateCircuitGraph(body.graph, { release });
    if (!structure.valid) throw new RepositoryError('INVALID_GRAPH', 400);
    return envelope(
      request,
      await repository.saveCircuitGraph(
        owner(request),
        projectId,
        body.expectedRevision,
        key(request),
        {
          graph: body.graph,
        },
      ),
    );
  });
  app.post('/v1/projects/:projectId/circuit/validate', async (request) => {
    const { projectId } = scope.parse(request.params);
    const body = mutation.parse(request.body);
    const principal = owner(request);
    const latest = await repository.latestCircuitGraph(principal, projectId);
    if (!latest.graphSnapshot) throw new RepositoryError('GRAPH_SNAPSHOT_NOT_FOUND', 404);
    if (latest.project.revision !== body.expectedRevision)
      throw new RepositoryError('REVISION_CONFLICT', 409, latest.project.revision);
    const graph = circuitGraphSchema.parse(latest.graphSnapshot.graph);
    if (graph.projectId !== projectId || graph.catalogReleaseId !== getCatalogRelease().releaseId)
      throw new RepositoryError('INVALID_GRAPH', 400);
    const report = validateCircuit({ graph, catalog: getCatalogRelease() });
    return envelope(
      request,
      await repository.saveValidationReport(principal, projectId, body.expectedRevision, {
        graphSnapshotId: latest.graphSnapshot.id,
        inputIdentity: {
          catalogReleaseId: report.catalogReleaseId,
          catalogDigest: report.catalogDigest,
          rulesetId: report.rulesetId,
          rulesetVersion: report.rulesetVersion,
          validatorVersion: report.validatorVersion,
        },
        report,
      }),
    );
  });
  app.get('/v1/projects/:projectId/circuit/validation', async (request) => {
    const { projectId } = scope.parse(request.params);
    return envelope(request, await repository.latestValidationReport(owner(request), projectId));
  });
  app.post('/v1/projects/:projectId/assembly-plan', async (request) => {
    const { projectId } = scope.parse(request.params);
    const body = mutation.parse(request.body);
    const principal = owner(request);
    const latest = await repository.latestCircuitGraph(principal, projectId);
    if (!latest.graphSnapshot) throw new RepositoryError('GRAPH_SNAPSHOT_NOT_FOUND', 404);
    if (latest.project.revision !== body.expectedRevision)
      throw new RepositoryError('REVISION_CONFLICT', 409, latest.project.revision);
    const validation = await repository.latestValidationReport(principal, projectId);
    if (!validation.report || !validation.current)
      throw new RepositoryError('VALIDATION_REQUIRED', 409, latest.project.revision);
    let plan;
    try {
      plan = generateAssemblyPlan({
        graph: latest.graphSnapshot.graph,
        catalog: getCatalogRelease(),
        report: validation.report.report,
        reportIsCurrent: validation.current,
        validationReportId: validation.report.id,
        validationReportDigest: validation.report.reportDigest,
      });
    } catch (cause) {
      if (cause instanceof AssemblyPlanBlockedError)
        throw new RepositoryError(cause.reason, 409, latest.project.revision);
      throw cause;
    }
    return envelope(request, { plan, current: true });
  });
  app.patch('/v1/projects/:projectId', async (request) => {
    const { projectId } = scope.parse(request.params);
    const body = z.object({ expectedRevision, title: titleSchema }).strict().parse(request.body);
    return envelope(
      request,
      await repository.mutate(
        owner(request),
        projectId,
        body.expectedRevision,
        key(request),
        'project_renamed',
        body,
        async (_client, project) => {
          project.title = body.title;
          return {};
        },
      ),
    );
  });
  app.post('/v1/projects/:projectId/archive', async (request) => {
    const { projectId } = scope.parse(request.params);
    const body = mutation.parse(request.body);
    return envelope(
      request,
      await repository.mutate(
        owner(request),
        projectId,
        body.expectedRevision,
        key(request),
        'project_archived',
        body,
        async (client, project) => {
          project.status = 'archived';
          await client.query(
            "UPDATE imports SET status='cancelled' WHERE project_id=$1 AND status IN ('queued','processing','awaiting_selection')",
            [projectId],
          );
          await client.query(
            "UPDATE jobs SET status='cancelled' WHERE project_id=$1 AND kind='process_import' AND status IN ('queued','running')",
            [projectId],
          );
          return {};
        },
      ),
    );
  });
  app.delete('/v1/projects/:projectId', async (request) => {
    const { projectId } = scope.parse(request.params);
    const body = mutation.parse(request.body);
    return envelope(
      request,
      await repository.mutate(
        owner(request),
        projectId,
        body.expectedRevision,
        key(request),
        'project_deleted',
        body,
        async (client, project) => {
          project.status = 'deleting';
          await client.query(
            "UPDATE jobs SET status='cancelled' WHERE project_id=$1 AND kind='process_import' AND status IN ('queued','running')",
            [projectId],
          );
          await repository.enqueue(client, projectId, 'delete_project', {});
          return {};
        },
      ),
    );
  });
  app.post('/v1/projects/:projectId/imports', async (request, reply) => {
    const { projectId } = scope.parse(request.params);
    const body = uploadSchema.parse(request.body);
    const bytes = Buffer.from(body.contentBase64, 'base64');
    if (
      !bytes.length ||
      bytes.length > MAX_SOURCE_BYTES ||
      bytes.toString('base64') !== body.contentBase64
    )
      throw new RepositoryError('INVALID_SOURCE', 400);
    const objectKey = randomUUID();
    const sourceId = randomUUID();
    // Track the key durably before any private bytes can exist.
    await repository.registerUploadIntent(owner(request), projectId, objectKey);
    let putSucceeded = false;
    let sourceCommitted = false;
    try {
      const digest = await storage.put(objectKey, bytes);
      putSucceeded = true;
      const result = await repository.mutate(
        owner(request),
        projectId,
        body.expectedRevision,
        key(request),
        'source_uploaded',
        { ...body, contentBase64: digest },
        async (client) => {
          const count = await client.query(
            'SELECT count(*)::int AS count FROM imports WHERE project_id=$1',
            [projectId],
          );
          if (count.rows[0].count >= 20) throw new RepositoryError('IMPORT_LIMIT', 429);
          await repository.consumeUploadIntent(client, projectId, objectKey);
          const sources = await client.query<import('@schemora/persistence').ImportRow>(
            "INSERT INTO imports(id,project_id,filename,object_key,source_digest,status) VALUES($1,$2,$3,$4,$5,'queued') RETURNING *",
            [sourceId, projectId, body.filename, objectKey, digest],
          );
          await repository.enqueue(client, projectId, 'process_import', { importId: sourceId });
          return { import: publicImport(sources.rows[0]!) };
        },
      );
      sourceCommitted = result.import.id === sourceId;
      if (result.import.id !== sourceId) {
        await storage.delete(objectKey);
        await repository.discardUploadIntent(objectKey);
      }
      return reply.code(202).send(envelope(request, result));
    } catch (error) {
      // An unsuccessful removal must retain its intent for durable worker cleanup.
      if (!sourceCommitted)
        await storage
          .delete(objectKey)
          .then(() => (putSucceeded ? repository.discardUploadIntent(objectKey) : undefined))
          .catch(() => {});
      throw error;
    }
  });
  app.get('/v1/projects/:projectId/imports/:importId', async (request) => {
    const { projectId, importId } = importScope.parse(request.params);
    const { messageOffset } = z
      .object({ messageOffset: z.coerce.number().int().min(0).max(5000).default(0) })
      .parse(request.query);
    return envelope(
      request,
      await repository.importDetail(owner(request), projectId, importId, messageOffset),
    );
  });
  app.get('/v1/projects/:projectId/imports/:importId/reviews', async (request) => {
    const { projectId, importId } = importScope.parse(request.params);
    const { before } = z
      .object({ before: z.coerce.number().int().positive().optional() })
      .parse(request.query);
    return envelope(
      request,
      await repository.reviewHistory(owner(request), projectId, importId, before),
    );
  });
  for (const action of ['select', 'retry', 'cancel'] as const) {
    app.post('/v1/projects/:projectId/imports/:importId/' + action, async (request) => {
      const { projectId, importId } = importScope.parse(request.params);
      const body =
        action === 'select'
          ? mutation.extend({ conversationId: z.string().min(1).max(200) }).parse(request.body)
          : mutation.parse(request.body);
      return envelope(
        request,
        await repository.mutate(
          owner(request),
          projectId,
          body.expectedRevision,
          key(request),
          'import_' + action,
          { importId, ...body },
          async (client) => {
            const source = await repository.import(client, projectId, importId);
            if (action === 'select') {
              const conversationId = 'conversationId' in body ? body.conversationId : '';
              if (
                source.status !== 'awaiting_selection' ||
                !source.bundle?.conversations.some((item) => item.id === conversationId)
              )
                throw new RepositoryError('INVALID_IMPORT_STATE', 409);
              await client.query(
                "UPDATE imports SET selected_conversation_id=$3,status='queued',error_code=NULL WHERE project_id=$1 AND id=$2",
                [projectId, importId, conversationId],
              );
              await repository.enqueue(client, projectId, 'process_import', { importId });
            } else if (action === 'retry') {
              if (source.status !== 'failed' && source.status !== 'cancelled')
                throw new RepositoryError('INVALID_IMPORT_STATE', 409);
              await client.query(
                "UPDATE imports SET status='queued',error_code=NULL WHERE project_id=$1 AND id=$2",
                [projectId, importId],
              );
              await repository.enqueue(client, projectId, 'process_import', { importId });
            } else {
              if (!['queued', 'processing', 'awaiting_selection', 'failed'].includes(source.status))
                throw new RepositoryError('INVALID_IMPORT_STATE', 409);
              await client.query(
                "UPDATE imports SET status='cancelled' WHERE project_id=$1 AND id=$2",
                [projectId, importId],
              );
              await client.query(
                "UPDATE jobs SET status='cancelled' WHERE project_id=$1 AND payload->>'importId'=$2 AND status IN ('queued','running')",
                [projectId, importId],
              );
            }
            return { import: publicImport(await repository.import(client, projectId, importId)) };
          },
        ),
      );
    });
  }
  app.post('/v1/projects/:projectId/imports/:importId/reviews', async (request) => {
    const { projectId, importId } = importScope.parse(request.params);
    const body = reviewSchema.parse(request.body);
    return envelope(
      request,
      await repository.mutate(
        owner(request),
        projectId,
        body.expectedRevision,
        key(request),
        'candidate_reviewed',
        { importId, ...body },
        async (client, project) => {
          const source = await repository.import(client, projectId, importId);
          const candidate = source.extraction?.candidates.find(
            (candidate) => candidate.id === body.candidateId,
          );
          if (source.status !== 'ready' || !candidate)
            throw new RepositoryError('CANDIDATE_UNAVAILABLE', 409);
          if (candidate.status === 'superseded' && body.decision === 'accept')
            throw new RepositoryError('SUPERSEDED_CANDIDATE', 409);
          const result = await client.query<import('@schemora/persistence').ReviewRow>(
            'INSERT INTO reviews(id,project_id,import_id,candidate_id,decision,value,reason,actor_id,revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
            [
              randomUUID(),
              projectId,
              importId,
              candidate.id,
              body.decision,
              body.decision === 'correct'
                ? body.value
                : body.decision === 'accept'
                  ? candidate.value
                  : null,
              body.reason ?? null,
              owner(request),
              project.revision,
            ],
          );
          return { review: publicReview(result.rows[0]!) };
        },
      ),
    );
  });
  return app;
}
