import Fastify, { type FastifyRequest } from 'fastify';
import { jwtVerify } from 'jose';
import { z, ZodError } from 'zod';
import { randomUUID } from 'node:crypto';
import { canonicalDigest } from '@schemora/assembly-plan';
import { currentCatalogRelease } from './catalog.js';
import {
  Repository,
  RepositoryError,
  publicFirmwareArtifact,
  publicHardwarePhoto,
  publicImport,
  publicReview,
  requestSimulationRunStop,
  requestDigest,
} from '@schemora/persistence';
import { MAX_SOURCE_BYTES, type PrivateBuildStorage, type PrivateStorage } from '@schemora/storage';
import {
  MAX_FIRMWARE_ARTIFACT_BYTES,
  createFirmwareProjectBundle,
  firmwareProjectBuildSystemSchema,
  firmwareProjectTargetSchema,
  verifyFirmwareProjectBundleSources,
  FIRMWARE_BUNDLE_MAX_FILE_BYTES,
  FIRMWARE_BUNDLE_MAX_FILES,
  firmwareArtifactRefSchema,
  simulationBindingSchema,
  simulationRunSchema,
} from '@schemora/simulation';
import { circuitGraphSchema, validateCircuitGraph } from '@schemora/circuit-model';
import { getCatalogRelease } from '@schemora/catalog';
import { validateCircuit, validationReportSchema } from '@schemora/validation';
import { AssemblyPlanBlockedError, generateAssemblyPlan } from '@schemora/assembly-plan';
import type { ApiConfig } from './config.js';
import { MAX_HARDWARE_PHOTO_INPUT_BYTES, normalizeHardwarePhoto } from './hardware-photo.js';

const uuid = z.string().uuid();
const expectedRevision = z.number().int().positive();
const scope = z.object({ projectId: uuid });
const importScope = scope.extend({ importId: uuid });
const firmwareArtifactScope = scope.extend({ artifactId: uuid });
const hardwarePhotoScope = scope.extend({ photoId: uuid });
const firmwareBuildScope = firmwareArtifactScope.extend({ buildId: uuid });
const firmwareBuildArtifactScope = firmwareBuildScope.extend({
  role: z.enum(['application', 'bootloader', 'partition_table']),
});
const firmwareFileQuery = z.object({ path: z.string().min(1).max(240) }).strict();
const simulationRunScope = scope.extend({ runId: uuid });
const mutation = z.object({ expectedRevision }).strict();
const simulationRunCreateSchema = z.object({ expectedRevision, firmwareArtifactId: uuid }).strict();
const emptyBodySchema = z.object({}).strict();
const circuitGraphWrite = z.object({ expectedRevision, graph: circuitGraphSchema }).strict();
const titleSchema = z.string().trim().min(1).max(120);
const encodeDownloadFilename = (value: string) =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => '%' + character.charCodeAt(0).toString(16).toUpperCase(),
  );
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
const hardwarePhotoUploadSchema = z
  .object({
    expectedRevision,
    shotRole: z.enum(['board-top', 'board-back', 'pin-labels', 'module-top', 'markings', 'other']),
    consentVersion: z.literal('photo-evidence-v1'),
    contentBase64: z
      .string()
      .min(4)
      .max(Math.ceil(MAX_HARDWARE_PHOTO_INPUT_BYTES / 3) * 4)
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
const firmwareUploadSchema = z
  .object({
    expectedRevision,
    language: z.enum(['c', 'cpp', 'arduino-cpp', 'esp-idf-c']),
    entrypoint: z
      .string()
      .min(1)
      .max(200)
      .regex(/^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(c|cc|cpp)$/),
    contentBase64: z
      .string()
      .min(4)
      .max(Math.ceil(MAX_FIRMWARE_ARTIFACT_BYTES / 3) * 4)
      .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
  })
  .strict()
  .superRefine((body, ctx) => {
    const isC = body.entrypoint.endsWith('.c');
    if ((body.language === 'c' || body.language === 'esp-idf-c') !== isC)
      ctx.addIssue({
        code: 'custom',
        path: ['entrypoint'],
        message: 'The entrypoint extension must match the selected source language.',
      });
    if (
      (body.language === 'cpp' || body.language === 'arduino-cpp') &&
      !/\.(cc|cpp)$/.test(body.entrypoint)
    )
      ctx.addIssue({
        code: 'custom',
        path: ['entrypoint'],
        message: 'C++ firmware entrypoints must use a .cc or .cpp extension.',
      });
  });
const firmwareBundleUploadSchema = z
  .object({
    expectedRevision,
    buildSystem: firmwareProjectBuildSystemSchema,
    target: firmwareProjectTargetSchema,
    entrypoint: z.string().min(1).max(240),
    files: z
      .array(
        z
          .object({
            path: z.string().min(1).max(240),
            contentBase64: z
              .string()
              .min(4)
              .max(Math.ceil(FIRMWARE_BUNDLE_MAX_FILE_BYTES / 3) * 4)
              .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
          })
          .strict(),
      )
      .min(1)
      .max(FIRMWARE_BUNDLE_MAX_FILES),
  })
  .strict();
const firmwareReviewSchema = z
  .object({
    expectedRevision,
    decision: z.enum(['accepted', 'rejected']),
    reason: z.string().trim().max(2000).optional(),
  })
  .strict();
function key(request: FastifyRequest) {
  return uuid.parse(request.headers['idempotency-key']);
}

function decodeSimulationCursor(value: string | undefined) {
  if (!value) return null;
  try {
    return z
      .object({ createdAt: z.string().datetime(), id: uuid })
      .strict()
      .parse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')));
  } catch {
    throw new ZodError([
      { code: 'custom', path: ['before'], message: 'Invalid simulation run cursor.' },
    ]);
  }
}

function simulationRunSummary(row: {
  id: string;
  status: string;
  binding: unknown;
  created_at: Date;
  updated_at: Date;
}) {
  return {
    id: row.id,
    status: row.status,
    binding: row.binding,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

type RepositoryClient = Parameters<Parameters<Repository['transaction']>[0]>[0];

async function cancelQueuedSimulationRuns(
  client: RepositoryClient,
  projectId: string,
  reason: string,
) {
  const queuedRuns = await client.query<{ id: string; run: unknown }>(
    "SELECT id,run FROM simulation_runs WHERE project_id=$1 AND status='queued' FOR UPDATE",
    [projectId],
  );
  const cancelledRunIds: string[] = [];
  for (const queuedRun of queuedRuns.rows) {
    // A run may still be marked queued in the small interval after its job was
    // claimed and a runner attempt was created. Preserve that execution as
    // active and request a stop instead of falsely recording cancellation.
    const stopRequestedAt = await requestSimulationRunStop(client, projectId, queuedRun.id);
    if (stopRequestedAt) {
      const stoppingRun = simulationRunSchema.parse({
        ...(queuedRun.run as object),
        status: 'stopping',
      });
      await client.query(
        "UPDATE simulation_runs SET status='stopping',run=$3 WHERE project_id=$1 AND id=$2 AND status='queued'",
        [projectId, queuedRun.id, JSON.stringify(stoppingRun)],
      );
      continue;
    }
    const run = simulationRunSchema.parse({
      ...(queuedRun.run as object),
      status: 'cancelled',
      failure: { code: 'CANCELLED', message: reason },
      simulatedDurationMs: 0,
    });
    await client.query(
      "UPDATE simulation_runs SET status='cancelled',run=$3 WHERE project_id=$1 AND id=$2 AND status='queued'",
      [projectId, queuedRun.id, JSON.stringify(run)],
    );
    cancelledRunIds.push(queuedRun.id);
  }
  if (!cancelledRunIds.length) return;
  await client.query(
    "UPDATE jobs SET status='cancelled',lease_token=NULL,lease_until=NULL WHERE project_id=$1 AND kind='simulate_run' AND payload->>'runId'=ANY($2::text[]) AND status IN ('queued','running')",
    [projectId, cancelledRunIds],
  );
  await client.query(
    "UPDATE outbox SET delivered_at=COALESCE(delivered_at,now()) WHERE project_id=$1 AND kind='simulate_run' AND payload->>'runId'=ANY($2::text[]) AND delivered_at IS NULL",
    [projectId, cancelledRunIds],
  );
}

/**
 * Prevent new simulation work after a project lifecycle transition. Queued
 * runs are cancelled; runs with a live runner attempt receive a durable stop
 * request and remain `stopping` until a runner reports a terminal response.
 * Recording this intent does not itself prove that an execution was stopped.
 */
async function stopProjectSimulationRuns(
  client: RepositoryClient,
  projectId: string,
  reason: string,
) {
  await cancelQueuedSimulationRuns(client, projectId, reason);
  const activeRuns = await client.query<{ id: string; status: string; run: unknown }>(
    `SELECT id,status,run FROM simulation_runs
      WHERE project_id=$1 AND status IN ('preparing','running','stopping')
      ORDER BY id FOR UPDATE`,
    [projectId],
  );
  for (const item of activeRuns.rows) {
    const stopRequestedAt = await requestSimulationRunStop(client, projectId, item.id);
    if (stopRequestedAt) {
      if (item.status !== 'stopping') {
        const run = simulationRunSchema.parse({ ...(item.run as object), status: 'stopping' });
        await client.query(
          "UPDATE simulation_runs SET status='stopping',run=$3 WHERE project_id=$1 AND id=$2 AND status=$4",
          [projectId, item.id, JSON.stringify(run), item.status],
        );
      }
      continue;
    }

    // A preparing run without an active runner attempt has no execution whose
    // termination can be awaited. Fence its queued/running job so it cannot
    // progress after the lifecycle mutation commits.
    if (item.status === 'preparing') {
      const run = simulationRunSchema.parse({
        ...(item.run as object),
        status: 'cancelled',
        failure: { code: 'CANCELLED', message: reason },
        simulatedDurationMs: 0,
      });
      await client.query(
        "UPDATE simulation_runs SET status='cancelled',run=$3 WHERE project_id=$1 AND id=$2 AND status='preparing'",
        [projectId, item.id, JSON.stringify(run)],
      );
      await client.query(
        "UPDATE jobs SET status='cancelled',lease_token=NULL,lease_until=NULL WHERE project_id=$1 AND kind='simulate_run' AND payload->>'runId'=$2 AND status IN ('queued','running')",
        [projectId, item.id],
      );
      await client.query(
        "UPDATE outbox SET delivered_at=COALESCE(delivered_at,now()) WHERE project_id=$1 AND kind='simulate_run' AND payload->>'runId'=$2 AND delivered_at IS NULL",
        [projectId, item.id],
      );
    }
  }
}

export function buildApp(
  config: ApiConfig,
  repository: Repository,
  storage: PrivateStorage & Partial<PrivateBuildStorage>,
) {
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
  const removeUploadedBundleObjects = async (
    keys: readonly string[],
    attempted: ReadonlySet<string>,
    succeeded: ReadonlySet<string>,
  ) => {
    await Promise.all(
      keys.map(async (objectKey) => {
        if (succeeded.has(objectKey)) {
          try {
            await storage.delete(objectKey);
            await repository.discardUploadIntent(objectKey);
          } catch {
            // Keep the intent when storage cleanup fails so the janitor can retry.
          }
        } else if (!attempted.has(objectKey)) {
          // No put was started for this key, so there can be no late object.
          await repository.discardUploadIntent(objectKey).catch(() => {});
        }
      }),
    );
  };
  const firmwareTarget = async (principal: string, projectId: string) => {
    const current = await repository.latestCircuitGraph(principal, projectId);
    if (!current.graphSnapshot)
      throw new RepositoryError('FIRMWARE_GRAPH_REQUIRED', 409, current.project.revision);
    const graphResult = circuitGraphSchema.safeParse(current.graphSnapshot.graph);
    const catalog = getCatalogRelease();
    if (
      !graphResult.success ||
      graphResult.data.catalogReleaseId !== catalog.releaseId ||
      !validateCircuitGraph(graphResult.data, { release: catalog }).valid
    )
      throw new RepositoryError('FIRMWARE_TARGET_UNSUPPORTED', 409, current.project.revision);
    const boards = graphResult.data.components.filter((component) =>
      catalog.parts.some(
        (part) => part.id === component.catalogPartId && part.category === 'development-board',
      ),
    );
    if (boards.length !== 1)
      throw new RepositoryError('FIRMWARE_TARGET_UNSUPPORTED', 409, current.project.revision);
    return { boardPartId: boards[0]!.catalogPartId, catalogReleaseId: catalog.releaseId };
  };
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
              FIRMWARE_GRAPH_REQUIRED:
                'Save a circuit containing one supported development board before adding firmware.',
              FIRMWARE_TARGET_UNSUPPORTED:
                'The saved circuit must resolve to exactly one development board in the current catalog.',
              INVALID_FIRMWARE_SOURCE:
                'Upload valid UTF-8 C or C++ source no larger than 2,000,000 bytes.',
              FIRMWARE_ARTIFACT_LIMIT: 'This project has reached its firmware version limit.',
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
  app.post('/v1/projects/:projectId/simulation-runs', async (request, reply) => {
    const { projectId } = scope.parse(request.params);
    const body = simulationRunCreateSchema.parse(request.body);
    const principal = owner(request);
    const idempotencyKey = key(request);
    const requestBody = {
      expectedRevision: body.expectedRevision,
      firmwareArtifactId: body.firmwareArtifactId,
    };
    const fingerprint = requestDigest(requestBody);
    const idempotencyScope = projectId + ':simulation_run_create';
    const result = await repository.transaction(async (client) => {
      const project = await repository.project(client, principal, projectId, true);
      const replay = await repository.replay(
        client,
        principal,
        idempotencyScope,
        idempotencyKey,
        fingerprint,
      );
      if (replay) return replay as { run: unknown; stopRequestedAt: string | null };
      if (project.status !== 'active') throw new RepositoryError('PROJECT_ARCHIVED', 409);
      if (project.revision !== body.expectedRevision)
        throw new RepositoryError('REVISION_CONFLICT', 409, project.revision);

      const currentRevision = await client.query<{
        snapshot: { circuitGraph?: { id: string; digest: string; revision: number } | null };
      }>('SELECT snapshot FROM revisions WHERE project_id=$1 AND revision=$2', [
        projectId,
        project.revision,
      ]);
      const graphReference = currentRevision.rows[0]?.snapshot.circuitGraph;
      if (!graphReference) throw new RepositoryError('VALIDATION_REQUIRED', 409, project.revision);
      const graphResult = await client.query<{
        id: string;
        project_revision: number;
        graph: unknown;
        graph_digest: string;
      }>(
        'SELECT id,project_revision,graph,graph_digest FROM circuit_graph_snapshots WHERE project_id=$1 AND id=$2',
        [projectId, graphReference.id],
      );
      const graphSnapshot = graphResult.rows[0];
      if (
        !graphSnapshot ||
        graphReference.digest !== graphSnapshot.graph_digest ||
        graphReference.revision !== graphSnapshot.project_revision
      )
        throw new RepositoryError('GRAPH_SNAPSHOT_CORRUPT', 500);
      const graph = circuitGraphSchema.parse(graphSnapshot.graph);
      const { release: catalog, sha256: catalogDigest } = currentCatalogRelease();
      if (
        graph.projectId !== projectId ||
        graph.catalogReleaseId !== catalog.releaseId ||
        graph.projectRevision !== graphSnapshot.project_revision ||
        canonicalDigest(graph) !== graphSnapshot.graph_digest ||
        !validateCircuitGraph(graph, { release: catalog }).valid
      )
        throw new RepositoryError('VALIDATION_REQUIRED', 409, project.revision);

      const validationResult = await client.query<{
        id: string;
        report: unknown;
        report_digest: string;
      }>(
        'SELECT id,report,report_digest FROM validation_reports WHERE project_id=$1 AND graph_snapshot_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1',
        [projectId, graphSnapshot.id],
      );
      const validation = validationResult.rows[0];
      if (!validation) throw new RepositoryError('VALIDATION_REQUIRED', 409, project.revision);
      const report = validationReportSchema.parse(validation.report);
      const recomputed = validateCircuit({ graph, catalog });
      if (
        canonicalDigest(report) !== validation.report_digest ||
        canonicalDigest(report) !== canonicalDigest(recomputed) ||
        report.projectId !== projectId ||
        report.graphId !== graph.id ||
        report.graphDigest !== graphSnapshot.graph_digest ||
        report.catalogReleaseId !== catalog.releaseId ||
        report.catalogDigest !== catalogDigest ||
        !['pass', 'unknown'].includes(report.status) ||
        report.findings.some((finding) => finding.status === 'fail' || finding.status === 'error')
      )
        throw new RepositoryError('VALIDATION_REQUIRED', 409, project.revision);

      const firmwareResult = await client.query<{
        id: string;
        project_revision: number;
        sha256: string;
        byte_length: number;
        bundle_digest: string | null;
        total_byte_length: number;
        build_system: 'arduino-cli' | 'esp-idf' | null;
        target: unknown | null;
        language: 'c' | 'cpp' | 'arduino-cpp' | 'esp-idf-c';
        entrypoint: string;
        board_part_id: string;
        catalog_release_id: string;
        review_revision: number | null;
        review_status: string | null;
      }>(
        `SELECT a.id,a.project_revision,a.sha256,a.byte_length,a.bundle_digest,a.total_byte_length,
                a.build_system,a.target,a.language,a.entrypoint,
                a.board_part_id,a.catalog_release_id,latest.project_revision AS review_revision,
                latest.decision AS review_status
         FROM firmware_artifacts a
         LEFT JOIN LATERAL (
           SELECT project_revision,decision FROM firmware_reviews
           WHERE project_id=a.project_id AND artifact_id=a.id
           ORDER BY project_revision DESC LIMIT 1
         ) latest ON true
         WHERE a.project_id=$1 AND a.id=$2`,
        [projectId, body.firmwareArtifactId],
      );
      const artifact = firmwareResult.rows[0];
      if (!artifact || artifact.review_status !== 'accepted' || artifact.review_revision === null)
        throw new RepositoryError('FIRMWARE_NOT_ACCEPTED', 409, project.revision);
      const firmware = firmwareArtifactRefSchema.parse({
        schemaVersion: 1,
        artifactId: artifact.id,
        projectId,
        projectRevision: artifact.project_revision,
        sha256: artifact.sha256,
        byteLength: artifact.byte_length,
        ...(artifact.bundle_digest
          ? {
              bundleDigest: artifact.bundle_digest,
              totalByteLength: artifact.total_byte_length,
              buildSystem: artifact.build_system,
              target: artifact.target,
            }
          : {}),
        language: artifact.language,
        entrypoint: artifact.entrypoint,
        boardPartId: artifact.board_part_id,
        catalogReleaseId: artifact.catalog_release_id,
        reviewStatus: 'accepted',
      });
      const board = catalog.parts.find((part) => part.id === firmware.boardPartId);
      if (
        board?.category !== 'development-board' ||
        firmware.catalogReleaseId !== catalog.releaseId ||
        !graph.components.some((component) => component.catalogPartId === firmware.boardPartId)
      )
        throw new RepositoryError('FIRMWARE_TARGET_UNSUPPORTED', 409, project.revision);

      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext('schemora_simulation_queue_global'))",
      );
      const projectQueue = await client.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM simulation_runs WHERE project_id=$1 AND status IN ('queued','preparing','running','stopping')",
        [projectId],
      );
      const globalQueue = await client.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM simulation_runs WHERE status IN ('queued','preparing','running','stopping')",
      );
      if (projectQueue.rows[0]!.count >= 3 || globalQueue.rows[0]!.count >= 100)
        throw new RepositoryError('SIMULATION_QUEUE_FULL', 429);

      const runId = randomUUID();
      const binding = simulationBindingSchema.parse({
        projectId,
        projectRevision: graph.projectRevision,
        graphId: graphSnapshot.id,
        graphDigest: graphSnapshot.graph_digest,
        catalogReleaseId: catalog.releaseId,
        catalogDigest,
        firmwareArtifactId: firmware.artifactId,
        firmwareDigest: firmware.bundleDigest ?? firmware.sha256,
        firmwareByteLength: firmware.totalByteLength ?? firmware.byteLength,
        adapterId: 'schemora.unconfigured',
        adapterVersion: '0',
        engineId: 'none',
        engineVersion: '0',
      });
      const run = simulationRunSchema.parse({
        schemaVersion: 1,
        contractVersion: '1.0.0',
        runId,
        status: 'queued',
        binding,
        events: [],
        unsupportedFeatures: [],
        limitations: [
          'No approved simulator is configured; this queued run will finish unavailable.',
          ...(report.status === 'unknown'
            ? [
                'The current circuit report contains unknown checks; this record makes no safety claim.',
              ]
            : []),
        ],
        failure: null,
        simulatedDurationMs: null,
      });
      const bindingDigest = canonicalDigest(binding);
      await client.query(
        `INSERT INTO simulation_runs(
           id,project_id,actor_id,project_revision,graph_snapshot_id,validation_report_id,
           firmware_artifact_id,firmware_review_revision,binding,binding_digest,status,run,
           idempotency_key,request_digest
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'queued',$11,$12,$13)`,
        [
          runId,
          projectId,
          principal,
          graph.projectRevision,
          graphSnapshot.id,
          validation.id,
          firmware.artifactId,
          artifact.review_revision,
          JSON.stringify(binding),
          bindingDigest,
          JSON.stringify(run),
          idempotencyScope + ':' + idempotencyKey,
          fingerprint,
        ],
      );
      await repository.enqueue(client, projectId, 'simulate_run', { runId });
      const response = { run };
      await repository.remember(
        client,
        principal,
        idempotencyScope,
        idempotencyKey,
        fingerprint,
        response,
      );
      return response;
    });
    return reply.code(202).send(envelope(request, result));
  });
  app.get('/v1/projects/:projectId/simulation-runs', async (request) => {
    const { projectId } = scope.parse(request.params);
    const query = z
      .object({ before: z.string().max(300).optional() })
      .strict()
      .parse(request.query);
    const cursor = decodeSimulationCursor(query.before);
    const items = await repository.transaction(async (client) => {
      await repository.project(client, owner(request), projectId, 'share');
      const result = await client.query<{
        id: string;
        status: string;
        binding: unknown;
        created_at: Date;
        updated_at: Date;
      }>(
        `SELECT id,status,binding,created_at,updated_at FROM simulation_runs
         WHERE project_id=$1 AND ($2::timestamptz IS NULL OR (created_at,id)<($2,$3::uuid))
         ORDER BY created_at DESC,id DESC LIMIT 51`,
        [projectId, cursor?.createdAt ?? null, cursor?.id ?? null],
      );
      return result.rows;
    });
    const page = items.slice(0, 50).map(simulationRunSummary);
    const tail = items.slice(0, 50).at(-1);
    return envelope(request, {
      items: page,
      nextCursor:
        items.length > 50 && tail
          ? Buffer.from(
              JSON.stringify({ createdAt: tail.created_at.toISOString(), id: tail.id }),
            ).toString('base64url')
          : null,
    });
  });
  app.get('/v1/projects/:projectId/simulation-runs/:runId', async (request) => {
    const { projectId, runId } = simulationRunScope.parse(request.params);
    return envelope(
      request,
      await repository.transaction(async (client) => {
        await repository.project(client, owner(request), projectId, 'share');
        const result = await client.query<{ run: unknown; stop_requested_at: Date | null }>(
          `SELECT r.run, a.stop_requested_at
             FROM simulation_runs r
             LEFT JOIN LATERAL (
               SELECT stop_requested_at FROM simulation_run_attempts
                WHERE project_id=r.project_id AND run_id=r.id AND stop_requested_at IS NOT NULL
                ORDER BY attempt_number DESC LIMIT 1
             ) a ON true
            WHERE r.project_id=$1 AND r.id=$2`,
          [projectId, runId],
        );
        if (!result.rows[0]) throw new RepositoryError('NOT_FOUND', 404);
        return {
          run: simulationRunSchema.parse(result.rows[0].run),
          stopRequestedAt: result.rows[0].stop_requested_at?.toISOString() ?? null,
        };
      }),
    );
  });
  app.post('/v1/projects/:projectId/simulation-runs/:runId/cancel', async (request) => {
    const { projectId, runId } = simulationRunScope.parse(request.params);
    emptyBodySchema.parse(request.body);
    const principal = owner(request);
    const idempotencyKey = key(request);
    const fingerprint = requestDigest({ runId });
    const idempotencyScope = projectId + ':simulation_run_cancel:' + runId;
    const result = await repository.transaction(async (client) => {
      await repository.project(client, principal, projectId, true);
      const replay = await repository.replay(
        client,
        principal,
        idempotencyScope,
        idempotencyKey,
        fingerprint,
      );
      if (replay) return replay as { run: unknown; stopRequestedAt: string | null };
      const selected = await client.query<{
        run: unknown;
        status: string;
        stop_requested_at: Date | null;
      }>(
        `SELECT r.run,r.status,a.stop_requested_at FROM simulation_runs r
          LEFT JOIN LATERAL (
            SELECT stop_requested_at FROM simulation_run_attempts
             WHERE project_id=r.project_id AND run_id=r.id AND stop_requested_at IS NOT NULL
             ORDER BY attempt_number DESC LIMIT 1
          ) a ON true
         WHERE r.project_id=$1 AND r.id=$2 FOR UPDATE OF r`,
        [projectId, runId],
      );
      const stored = selected.rows[0];
      if (!stored) throw new RepositoryError('NOT_FOUND', 404);
      if (stored.status === 'cancelled' || stored.status === 'stopped') {
        const response = {
          run: simulationRunSchema.parse(stored.run),
          stopRequestedAt: stored.stop_requested_at?.toISOString() ?? null,
        };
        await repository.remember(
          client,
          principal,
          idempotencyScope,
          idempotencyKey,
          fingerprint,
          response,
        );
        return response;
      }
      let run: ReturnType<typeof simulationRunSchema.parse>;
      let stopRequestedAt: string | null = null;
      if (stored.status === 'queued') {
        run = simulationRunSchema.parse({
          ...(stored.run as object),
          status: 'cancelled',
          failure: { code: 'CANCELLED', message: 'Run cancelled before execution.' },
          simulatedDurationMs: 0,
        });
        await client.query(
          "UPDATE simulation_runs SET status='cancelled',run=$3 WHERE project_id=$1 AND id=$2 AND status='queued'",
          [projectId, runId, JSON.stringify(run)],
        );
        await client.query(
          "UPDATE jobs SET status='cancelled',lease_token=NULL,lease_until=NULL WHERE project_id=$1 AND kind='simulate_run' AND payload->>'runId'=$2 AND status='queued'",
          [projectId, runId],
        );
        await client.query(
          "UPDATE outbox SET delivered_at=COALESCE(delivered_at,now()) WHERE project_id=$1 AND kind='simulate_run' AND payload->>'runId'=$2 AND delivered_at IS NULL",
          [projectId, runId],
        );
      } else if (stored.status === 'preparing' || stored.status === 'running') {
        const requestedAt = await requestSimulationRunStop(client, projectId, runId);
        if (!requestedAt) throw new RepositoryError('SIMULATION_STOP_UNAVAILABLE', 409);
        run = simulationRunSchema.parse({ ...(stored.run as object), status: 'stopping' });
        stopRequestedAt = requestedAt.toISOString();
        await client.query(
          "UPDATE simulation_runs SET status='stopping',run=$3 WHERE project_id=$1 AND id=$2 AND status=$4",
          [projectId, runId, JSON.stringify(run), stored.status],
        );
      } else if (stored.status === 'stopping') {
        const requestedAt = await requestSimulationRunStop(client, projectId, runId);
        if (!requestedAt) throw new RepositoryError('SIMULATION_STOP_UNAVAILABLE', 409);
        run = simulationRunSchema.parse(stored.run);
        stopRequestedAt = requestedAt.toISOString();
      } else throw new RepositoryError('INVALID_SIMULATION_STATE', 409);
      const response = { run, stopRequestedAt };
      await repository.remember(
        client,
        principal,
        idempotencyScope,
        idempotencyKey,
        fingerprint,
        response,
      );
      return response;
    });
    return envelope(request, result);
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
          await stopProjectSimulationRuns(
            client,
            projectId,
            'Project archived before simulation began.',
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
          await stopProjectSimulationRuns(
            client,
            projectId,
            'Project deletion began before simulation.',
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
  app.get('/v1/projects/:projectId/hardware-photos', async (request) => {
    const { projectId } = scope.parse(request.params);
    return envelope(request, {
      items: await repository.hardwarePhotos(owner(request), projectId),
    });
  });
  app.post('/v1/projects/:projectId/hardware-photos', async (request, reply) => {
    const { projectId } = scope.parse(request.params);
    const body = hardwarePhotoUploadSchema.parse(request.body);
    const principal = owner(request);
    const encoded = Buffer.from(body.contentBase64, 'base64');
    if (
      !encoded.length ||
      encoded.length > MAX_HARDWARE_PHOTO_INPUT_BYTES ||
      encoded.toString('base64') !== body.contentBase64
    )
      throw new RepositoryError('INVALID_PHOTO', 400);

    const objectKey = randomUUID();
    const photoId = randomUUID();
    await repository.registerUploadIntent(principal, projectId, objectKey);
    let normalized: Awaited<ReturnType<typeof normalizeHardwarePhoto>>;
    try {
      normalized = await normalizeHardwarePhoto(encoded);
    } catch {
      await repository.discardUploadIntent(objectKey).catch(() => {});
      throw new RepositoryError('INVALID_PHOTO', 400);
    }
    let photoCommitted = false;
    try {
      const sha256 = await storage.put(objectKey, normalized.bytes);
      const result = await repository.mutate(
        principal,
        projectId,
        body.expectedRevision,
        key(request),
        'hardware_photo_uploaded',
        {
          shotRole: body.shotRole,
          consentVersion: body.consentVersion,
          sha256,
          byteLength: normalized.bytes.length,
          format: normalized.format,
          width: normalized.width,
          height: normalized.height,
        },
        async (client, project) => {
          const count = await client.query(
            'SELECT count(*)::int AS count FROM hardware_photos WHERE project_id=$1',
            [projectId],
          );
          if (count.rows[0].count >= 100) throw new RepositoryError('PHOTO_LIMIT', 429);
          await repository.consumeUploadIntent(client, projectId, objectKey);
          const inserted = await client.query<import('@schemora/persistence').HardwarePhotoRow>(
            `INSERT INTO hardware_photos
              (id,project_id,project_revision,actor_id,object_key,sha256,byte_length,format,
               width,height,shot_role,consent_version,status)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'manual_review') RETURNING *`,
            [
              photoId,
              projectId,
              project.revision,
              principal,
              objectKey,
              sha256,
              normalized.bytes.length,
              normalized.format,
              normalized.width,
              normalized.height,
              body.shotRole,
              body.consentVersion,
            ],
          );
          return { photo: publicHardwarePhoto(inserted.rows[0]!) };
        },
      );
      photoCommitted = result.photo.id === photoId;
      if (!photoCommitted) {
        await storage.delete(objectKey);
        await repository.discardUploadIntent(objectKey);
      }
      return reply.code(photoCommitted ? 201 : 200).send(envelope(request, result));
    } catch (error) {
      if (!photoCommitted)
        await storage
          .delete(objectKey)
          .then(() => repository.discardUploadIntent(objectKey))
          .catch(() => {});
      throw error;
    }
  });
  app.get('/v1/projects/:projectId/hardware-photos/:photoId/content', async (request, reply) => {
    const { projectId, photoId } = hardwarePhotoScope.parse(request.params);
    const photo = await repository.hardwarePhotoRecord(owner(request), projectId, photoId);
    const bytes = await storage.read(photo.object_key, photo.sha256);
    const contentType =
      photo.format === 'jpeg' ? 'image/jpeg' : photo.format === 'png' ? 'image/png' : 'image/webp';
    return reply
      .header('Cache-Control', 'private, no-store')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'none'; sandbox")
      .type(contentType)
      .send(bytes);
  });
  app.delete('/v1/projects/:projectId/hardware-photos/:photoId', async (request) => {
    const { projectId, photoId } = hardwarePhotoScope.parse(request.params);
    const body = mutation.parse(request.body);
    const principal = owner(request);
    return envelope(
      request,
      await repository.mutate(
        principal,
        projectId,
        body.expectedRevision,
        key(request),
        'hardware_photo_deleted',
        { photoId },
        async (client) => {
          const removed = await client.query<{ object_key: string }>(
            'DELETE FROM hardware_photos WHERE project_id=$1 AND id=$2 RETURNING object_key',
            [projectId, photoId],
          );
          const photo = removed.rows[0];
          if (!photo) throw new RepositoryError('NOT_FOUND', 404);
          await client.query(
            "DELETE FROM idempotency WHERE owner_id=$1 AND scope=$2 AND response->'photo'->>'id'=$3",
            [principal, projectId + ':hardware_photo_uploaded', photoId],
          );
          await repository.enqueue(client, projectId, 'delete_hardware_photo', {
            photoId,
            objectKey: photo.object_key,
          });
          return { deletedPhotoId: photoId };
        },
      ),
    );
  });
  app.get('/v1/projects/:projectId/firmware-artifacts', async (request) => {
    const { projectId } = scope.parse(request.params);
    return envelope(request, {
      items: await repository.firmwareArtifacts(owner(request), projectId),
    });
  });
  app.post('/v1/projects/:projectId/firmware-artifacts', async (request, reply) => {
    const { projectId } = scope.parse(request.params);
    const body = firmwareUploadSchema.parse(request.body);
    const bytes = Buffer.from(body.contentBase64, 'base64');
    const source = bytes.toString('utf8');
    if (
      !bytes.length ||
      bytes.length > MAX_FIRMWARE_ARTIFACT_BYTES ||
      bytes.toString('base64') !== body.contentBase64 ||
      source.includes('\u0000') ||
      !Buffer.from(source, 'utf8').equals(bytes)
    )
      throw new RepositoryError('INVALID_FIRMWARE_SOURCE', 400);
    const principal = owner(request);
    const target = await firmwareTarget(principal, projectId);
    const objectKey = randomUUID();
    const artifactId = randomUUID();
    await repository.registerUploadIntent(principal, projectId, objectKey);
    let putSucceeded = false;
    let artifactCommitted = false;
    try {
      const digest = await storage.put(objectKey, bytes);
      putSucceeded = true;
      const result = await repository.mutate(
        principal,
        projectId,
        body.expectedRevision,
        key(request),
        'firmware_artifact_created',
        {
          expectedRevision: body.expectedRevision,
          sha256: digest,
          byteLength: bytes.length,
          language: body.language,
          entrypoint: body.entrypoint,
          boardPartId: target.boardPartId,
          catalogReleaseId: target.catalogReleaseId,
        },
        async (client, project) => {
          const count = await client.query(
            'SELECT count(*)::int AS count FROM firmware_artifacts WHERE project_id=$1',
            [projectId],
          );
          if (count.rows[0].count >= 50) throw new RepositoryError('FIRMWARE_ARTIFACT_LIMIT', 429);
          await repository.consumeUploadIntent(client, projectId, objectKey);
          await client.query(
            'INSERT INTO firmware_artifacts(id,project_id,project_revision,actor_id,object_key,sha256,byte_length,language,entrypoint,board_part_id,catalog_release_id,total_byte_length) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
            [
              artifactId,
              projectId,
              project.revision,
              principal,
              objectKey,
              digest,
              bytes.length,
              body.language,
              body.entrypoint,
              target.boardPartId,
              target.catalogReleaseId,
              bytes.length,
            ],
          );
          await client.query(
            'INSERT INTO firmware_artifact_files(project_id,artifact_id,path,object_key,sha256,byte_length,is_entrypoint) VALUES($1,$2,$3,$4,$5,$6,true)',
            [projectId, artifactId, body.entrypoint, objectKey, digest, bytes.length],
          );
          return { firmwareArtifactId: artifactId };
        },
      );
      artifactCommitted = result.firmwareArtifactId === artifactId;
      if (!artifactCommitted) {
        await storage.delete(objectKey);
        await repository.discardUploadIntent(objectKey);
      }
      const record = await repository.firmwareArtifactRecord(
        principal,
        projectId,
        result.firmwareArtifactId,
      );
      return reply.code(artifactCommitted ? 201 : 200).send(
        envelope(request, {
          project: result.project,
          artifact: publicFirmwareArtifact(record),
        }),
      );
    } catch (error) {
      if (!artifactCommitted)
        await storage
          .delete(objectKey)
          .then(() => (putSucceeded ? repository.discardUploadIntent(objectKey) : undefined))
          .catch(() => {});
      throw error;
    }
  });
  app.post('/v1/projects/:projectId/firmware-artifacts/bundles', async (request, reply) => {
    const { projectId } = scope.parse(request.params);
    const body = firmwareBundleUploadSchema.parse(request.body);
    const principal = owner(request);
    const targetIdentity = await firmwareTarget(principal, projectId);
    const catalog = getCatalogRelease();
    const board = catalog.parts.find((part) => part.id === targetIdentity.boardPartId);
    if (
      body.buildSystem !== 'esp-idf' ||
      body.target.kind !== 'esp-idf-target' ||
      body.target.target !== 'esp32' ||
      board?.category !== 'development-board' ||
      board.model !== 'ESP32-DevKitC V4' ||
      board.configuration.module !== 'ESP32-WROOM-32E' ||
      targetIdentity.catalogReleaseId !== catalog.releaseId
    )
      throw new RepositoryError('FIRMWARE_TARGET_UNSUPPORTED', 409);

    const sourceFiles: { path: string; source: Uint8Array }[] = [];
    for (const file of body.files) {
      const bytes = Buffer.from(file.contentBase64, 'base64');
      const source = bytes.toString('utf8');
      if (
        !bytes.length ||
        bytes.length > FIRMWARE_BUNDLE_MAX_FILE_BYTES ||
        bytes.toString('base64') !== file.contentBase64 ||
        source.includes('\u0000') ||
        !Buffer.from(source, 'utf8').equals(bytes)
      )
        throw new RepositoryError('INVALID_FIRMWARE_SOURCE', 400);
      sourceFiles.push({ path: file.path, source: bytes });
    }
    let bundle;
    try {
      bundle = await createFirmwareProjectBundle({
        buildSystem: body.buildSystem,
        target: body.target,
        entrypoint: body.entrypoint,
        files: sourceFiles,
      });
    } catch {
      throw new RepositoryError('INVALID_FIRMWARE_BUNDLE', 400);
    }
    if (!(await verifyFirmwareProjectBundleSources(bundle)))
      throw new RepositoryError('INVALID_FIRMWARE_BUNDLE', 400);

    const principalKey = principal;
    const artifactId = randomUUID();
    const objectKeys = new Map(bundle.files.map((file) => [file.path, randomUUID()] as const));
    const uploadKeys = [...objectKeys.values()];
    const sourceBytes = new Map(
      sourceFiles.map((file) => [file.path, Buffer.from(file.source)] as const),
    );
    const successfulKeys = new Set<string>();
    const attemptedKeys = new Set<string>();
    let artifactCommitted = false;
    let mutationStarted = false;
    await repository.registerUploadIntents(principalKey, projectId, uploadKeys);
    try {
      for (const file of bundle.files) {
        const objectKey = objectKeys.get(file.path)!;
        attemptedKeys.add(objectKey);
        const storedDigest = await storage.put(objectKey, sourceBytes.get(file.path)!);
        if (storedDigest !== file.sha256)
          throw new RepositoryError('FIRMWARE_ARTIFACT_CORRUPT', 500);
        successfulKeys.add(objectKey);
      }
      const entrypoint = bundle.files.find((file) => file.path === bundle.entrypoint)!;
      const entrypointKey = objectKeys.get(bundle.entrypoint)!;
      mutationStarted = true;
      const result = await repository.mutate(
        principalKey,
        projectId,
        body.expectedRevision,
        key(request),
        'firmware_bundle_created',
        {
          expectedRevision: body.expectedRevision,
          bundleDigest: bundle.manifestDigest,
          totalByteLength: bundle.totalByteLength,
          buildSystem: bundle.buildSystem,
          target: bundle.target,
          entrypoint: bundle.entrypoint,
          files: bundle.files.map(({ path, sha256, byteLength }) => ({ path, sha256, byteLength })),
          boardPartId: targetIdentity.boardPartId,
          catalogReleaseId: targetIdentity.catalogReleaseId,
        },
        async (client, project) => {
          const count = await client.query(
            'SELECT count(*)::int AS count FROM firmware_artifacts WHERE project_id=$1',
            [projectId],
          );
          if (count.rows[0].count >= 50) throw new RepositoryError('FIRMWARE_ARTIFACT_LIMIT', 429);
          for (const objectKey of uploadKeys)
            await repository.consumeUploadIntent(client, projectId, objectKey);
          const language =
            bundle.buildSystem === 'arduino-cli'
              ? 'arduino-cpp'
              : /\.c$/i.test(bundle.entrypoint)
                ? 'esp-idf-c'
                : 'cpp';
          await client.query(
            'INSERT INTO firmware_artifacts(id,project_id,project_revision,actor_id,object_key,sha256,byte_length,language,entrypoint,board_part_id,catalog_release_id,bundle_digest,total_byte_length,build_system,target) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)',
            [
              artifactId,
              projectId,
              project.revision,
              principalKey,
              entrypointKey,
              entrypoint.sha256,
              entrypoint.byteLength,
              language,
              bundle.entrypoint,
              targetIdentity.boardPartId,
              targetIdentity.catalogReleaseId,
              bundle.manifestDigest,
              bundle.totalByteLength,
              bundle.buildSystem,
              JSON.stringify(bundle.target),
            ],
          );
          for (const file of bundle.files) {
            await client.query(
              'INSERT INTO firmware_artifact_files(project_id,artifact_id,path,object_key,sha256,byte_length,is_entrypoint) VALUES($1,$2,$3,$4,$5,$6,$7)',
              [
                projectId,
                artifactId,
                file.path,
                objectKeys.get(file.path),
                file.sha256,
                file.byteLength,
                file.path === bundle.entrypoint,
              ],
            );
          }
          return { firmwareArtifactId: artifactId };
        },
      );
      artifactCommitted = result.firmwareArtifactId === artifactId;
      if (!artifactCommitted)
        await removeUploadedBundleObjects(uploadKeys, attemptedKeys, successfulKeys);
      const record = await repository.firmwareArtifactRecord(
        principalKey,
        projectId,
        result.firmwareArtifactId,
      );
      return reply.code(artifactCommitted ? 201 : 200).send(
        envelope(request, {
          project: result.project,
          artifact: publicFirmwareArtifact(record),
        }),
      );
    } catch (error) {
      let commitKnownAbsent = !mutationStarted;
      if (!artifactCommitted && mutationStarted) {
        try {
          await repository.firmwareArtifactRecord(principalKey, projectId, artifactId);
          // A committed artifact must keep its objects even if the API lost the commit reply.
        } catch (lookupError) {
          commitKnownAbsent =
            lookupError instanceof RepositoryError && lookupError.code === 'NOT_FOUND';
          // A failed or unauthorized lookup leaves commit state uncertain; durable intents
          // remain the recovery record until the project purge or expiry janitor handles them.
        }
      }
      if (!artifactCommitted && commitKnownAbsent)
        await removeUploadedBundleObjects(uploadKeys, attemptedKeys, successfulKeys);
      throw error;
    }
  });
  app.get('/v1/projects/:projectId/firmware-artifacts/:artifactId', async (request) => {
    const { projectId, artifactId } = firmwareArtifactScope.parse(request.params);
    const record = await repository.firmwareArtifactRecord(owner(request), projectId, artifactId);
    return envelope(request, { artifact: publicFirmwareArtifact(record) });
  });
  app.get('/v1/projects/:projectId/firmware-artifacts/:artifactId/builds', async (request) => {
    const { projectId, artifactId } = firmwareArtifactScope.parse(request.params);
    const items = await repository.firmwareBuilds(owner(request), projectId, artifactId);
    return envelope(request, { items });
  });
  app.get(
    '/v1/projects/:projectId/firmware-artifacts/:artifactId/builds/:buildId',
    async (request) => {
      const { projectId, artifactId, buildId } = firmwareBuildScope.parse(request.params);
      const build = await repository.firmwareBuild(owner(request), projectId, artifactId, buildId);
      return envelope(request, { build });
    },
  );
  app.get(
    '/v1/projects/:projectId/firmware-artifacts/:artifactId/builds/:buildId/artifacts/:role',
    async (request, reply) => {
      const { projectId, artifactId, buildId, role } = firmwareBuildArtifactScope.parse(
        request.params,
      );
      if (!storage.readBuildArtifact)
        throw new RepositoryError('FIRMWARE_BUILD_STORAGE_UNAVAILABLE', 503);
      const { record, bytes } = await repository.withFirmwareBuildArtifact(
        owner(request),
        projectId,
        artifactId,
        buildId,
        role,
        async (record) => {
          const bytes = await storage.readBuildArtifact!(
            record.object_key,
            record.sha256,
            record.byte_length,
          );
          if (bytes.length !== record.byte_length)
            throw new RepositoryError('FIRMWARE_BUILD_CORRUPT', 500);
          return { record, bytes };
        },
      );
      return reply
        .header('Cache-Control', 'no-store')
        .header(
          'Content-Disposition',
          "attachment; filename*=UTF-8''" + encodeDownloadFilename(record.path.split('/').at(-1)!),
        )
        .type('application/octet-stream')
        .send(bytes);
    },
  );
  app.get('/v1/projects/:projectId/firmware-artifacts/:artifactId/files', async (request) => {
    const { projectId, artifactId } = firmwareArtifactScope.parse(request.params);
    const rows = await repository.firmwareArtifactFiles(owner(request), projectId, artifactId);
    return envelope(request, {
      items: rows.map((file) => ({
        path: file.path,
        sha256: file.sha256,
        byteLength: file.byte_length,
        isEntrypoint: file.is_entrypoint,
      })),
    });
  });
  app.get(
    '/v1/projects/:projectId/firmware-artifacts/:artifactId/files/content',
    async (request, reply) => {
      const { projectId, artifactId } = firmwareArtifactScope.parse(request.params);
      const { path } = firmwareFileQuery.parse(request.query);
      const { file, bytes } = await repository.withFirmwareArtifactFile(
        owner(request),
        projectId,
        artifactId,
        path,
        async (file) => {
          const bytes = await storage.read(file.object_key, file.sha256);
          if (bytes.length !== file.byte_length)
            throw new RepositoryError('FIRMWARE_ARTIFACT_CORRUPT', 500);
          return { file, bytes };
        },
      );
      const filename = file.path.split('/').at(-1)!;
      return reply
        .header('Cache-Control', 'no-store')
        .header(
          'Content-Disposition',
          "attachment; filename*=UTF-8''" + encodeDownloadFilename(filename),
        )
        .type('application/octet-stream')
        .send(bytes);
    },
  );
  app.get('/v1/projects/:projectId/firmware-artifacts/:artifactId/reviews', async (request) => {
    const { projectId, artifactId } = firmwareArtifactScope.parse(request.params);
    const principal = owner(request);
    const artifact = await repository.firmwareArtifactRecord(principal, projectId, artifactId);
    const reviews = await repository.firmwareArtifactReviews(principal, projectId, artifactId);
    return envelope(request, { artifactId: artifact.id, items: reviews });
  });
  app.get(
    '/v1/projects/:projectId/firmware-artifacts/:artifactId/content',
    async (request, reply) => {
      const { projectId, artifactId } = firmwareArtifactScope.parse(request.params);
      const { record, bytes } = await repository.withFirmwareArtifact(
        owner(request),
        projectId,
        artifactId,
        async (record) => {
          const bytes = await storage.read(record.object_key, record.sha256);
          if (bytes.length !== record.byte_length)
            throw new RepositoryError('FIRMWARE_ARTIFACT_CORRUPT', 500);
          return { record, bytes };
        },
      );
      return reply
        .header('Cache-Control', 'no-store')
        .header(
          'Content-Disposition',
          'attachment; filename="' + record.entrypoint.split('/').at(-1) + '"',
        )
        .type('text/plain; charset=utf-8')
        .send(bytes);
    },
  );
  app.post('/v1/projects/:projectId/firmware-artifacts/:artifactId/reviews', async (request) => {
    const { projectId, artifactId } = firmwareArtifactScope.parse(request.params);
    const body = firmwareReviewSchema.parse(request.body);
    const principal = owner(request);
    const result = await repository.mutate(
      principal,
      projectId,
      body.expectedRevision,
      key(request),
      'firmware_review:' + artifactId,
      { artifactId, ...body },
      async (client, project) => {
        const artifact = await client.query(
          'SELECT id FROM firmware_artifacts WHERE project_id=$1 AND id=$2',
          [projectId, artifactId],
        );
        if (!artifact.rows[0]) throw new RepositoryError('NOT_FOUND', 404);
        await client.query(
          'INSERT INTO firmware_reviews(id,project_id,artifact_id,project_revision,actor_id,decision,reason) VALUES($1,$2,$3,$4,$5,$6,$7)',
          [
            randomUUID(),
            projectId,
            artifactId,
            project.revision,
            principal,
            body.decision,
            body.reason ?? null,
          ],
        );
        return { firmwareArtifactId: artifactId };
      },
    );
    const record = await repository.firmwareArtifactRecord(
      principal,
      projectId,
      result.firmwareArtifactId,
    );
    return envelope(request, {
      project: result.project,
      artifact: publicFirmwareArtifact(record),
    });
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
