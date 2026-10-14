import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SignJWT } from 'jose';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getCatalogRelease } from '@schemora/catalog';
import { Repository } from '@schemora/persistence';
import { FileStorage } from '@schemora/storage';
import { readConfig } from '../src/config.js';
import { buildApp } from '../src/app.js';

describe.skipIf(!process.env.TEST_DATABASE_URL)('project circuit API', () => {
  const secret = 'test-session-secret-only-00000000000000000000';
  const userA = 'circuit-test:' + randomUUID();
  const userB = 'circuit-test:' + randomUUID();
  const config = readConfig({
    NODE_ENV: 'test',
    // Vitest evaluates a skipped suite's declaration callback too. Keep the
    // configuration schema valid when the database-backed suite is skipped.
    DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgresql://localhost/schemora_test',
    SESSION_SECRET: secret,
  });
  const repository = new Repository(config.DATABASE_URL);
  let directory: string;
  let app: ReturnType<typeof buildApp>;
  let tokenA: string;
  let tokenB: string;

  async function token(subject: string) {
    return new SignJWT({ auth_time: Math.floor(Date.now() / 1000), name: 'maker' })
      .setSubject(subject)
      .setIssuer('schemora-web')
      .setAudience('schemora-api')
      .setIssuedAt()
      .setExpirationTime('5m')
      .setProtectedHeader({ alg: 'HS256' })
      .sign(new TextEncoder().encode(secret));
  }

  async function request(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH',
    url: string,
    payload: object | undefined,
    identity: string,
    idempotencyKey = randomUUID(),
  ) {
    const response = await app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${identity}`, 'idempotency-key': idempotencyKey },
      ...(payload === undefined ? {} : { payload }),
    });
    return { status: response.statusCode, body: response.json() };
  }

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'schemora-circuit-api-'));
    app = buildApp(config, repository, new FileStorage(directory, 'test'));
    tokenA = await token(userA);
    tokenB = await token(userB);
  });

  afterAll(async () => {
    if (app) await app.close();
    await repository.transaction(async (client) => {
      await client.query(
        'DELETE FROM validation_reports WHERE project_id IN (SELECT id FROM projects WHERE owner_id=ANY($1))',
        [[userA, userB]],
      );
      await client.query(
        'DELETE FROM project_circuit_design_intents WHERE project_id IN (SELECT id FROM projects WHERE owner_id=ANY($1))',
        [[userA, userB]],
      );
      await client.query(
        'DELETE FROM circuit_design_intent_versions WHERE project_id IN (SELECT id FROM projects WHERE owner_id=ANY($1))',
        [[userA, userB]],
      );
      await client.query(
        'DELETE FROM circuit_graph_snapshots WHERE project_id IN (SELECT id FROM projects WHERE owner_id=ANY($1))',
        [[userA, userB]],
      );
      for (const table of ['reviews', 'revisions', 'imports', 'upload_intents', 'jobs', 'outbox']) {
        await client.query(
          'DELETE FROM ' +
            table +
            ' WHERE project_id IN (SELECT id FROM projects WHERE owner_id=ANY($1))',
          [[userA, userB]],
        );
      }
      await client.query('DELETE FROM idempotency WHERE owner_id=ANY($1)', [[userA, userB]]);
      await client.query('DELETE FROM projects WHERE owner_id=ANY($1)', [[userA, userB]]);
      await client.query('DELETE FROM principals WHERE id=ANY($1)', [[userA, userB]]);
    });
    await repository.pool.end();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('scopes, stores, validates, and reports the exact immutable circuit snapshot', async () => {
    const created = await request('POST', '/v1/projects', { title: 'Circuit API test' }, tokenA);
    expect(created.status).toBe(201);
    const project = created.body.data;
    const empty = await request('GET', `/v1/projects/${project.id}/circuit`, undefined, tokenA);
    expect(empty.status).toBe(200);
    expect(empty.body.data.graphSnapshot).toBeNull();

    const denied = await request('GET', `/v1/projects/${project.id}/circuit`, undefined, tokenB);
    expect(denied.status).toBe(404);

    const release = getCatalogRelease();
    const graph = {
      schemaVersion: 1 as const,
      id: 'graph_short_test',
      projectId: project.id,
      projectRevision: project.revision + 1,
      catalogReleaseId: release.releaseId,
      components: [
        {
          id: 'board_test',
          catalogPartId: 'board.espressif.esp32-devkitc-v4.wroom-32e.male',
        },
      ],
      breadboards: [],
      terminalPlacements: [],
      wires: [
        {
          id: 'short_test',
          source: {
            kind: 'terminal' as const,
            terminal: { componentInstanceId: 'board_test', catalogTerminalId: '3v3-j2-1' },
          },
          target: {
            kind: 'terminal' as const,
            terminal: { componentInstanceId: 'board_test', catalogTerminalId: 'gnd-j3-1' },
          },
        },
      ],
    };
    const malformed = await request(
      'PUT',
      `/v1/projects/${project.id}/circuit`,
      { expectedRevision: project.revision, graph: { ...graph, projectId: randomUUID() } },
      tokenA,
    );
    expect(malformed.status).toBe(400);

    const idempotencyKey = randomUUID();
    const saved = await request(
      'PUT',
      `/v1/projects/${project.id}/circuit`,
      { expectedRevision: project.revision, graph },
      tokenA,
      idempotencyKey,
    );
    expect(saved.status).toBe(200);
    expect(saved.body.data.project.revision).toBe(project.revision + 1);
    expect(saved.body.data.graphSnapshot.graph).toEqual(graph);
    const replay = await request(
      'PUT',
      `/v1/projects/${project.id}/circuit`,
      { expectedRevision: project.revision, graph },
      tokenA,
      idempotencyKey,
    );
    expect(replay.status).toBe(200);
    expect(replay.body.data.graphSnapshot.id).toBe(saved.body.data.graphSnapshot.id);

    const stale = await request(
      'PUT',
      `/v1/projects/${project.id}/circuit`,
      { expectedRevision: project.revision, graph },
      tokenA,
    );
    expect(stale.status).toBe(409);

    const validated = await request(
      'POST',
      `/v1/projects/${project.id}/circuit/validate`,
      { expectedRevision: saved.body.data.project.revision },
      tokenA,
    );
    expect(validated.status).toBe(200);
    expect(validated.body.data.current).toBe(true);
    expect(validated.body.data.report.report.status).toBe('fail');
    expect(validated.body.data.report.report.findings).toContainEqual(
      expect.objectContaining({ ruleId: 'POWER_GROUND_SHORT', status: 'fail' }),
    );
    const blockedAssemblyPlan = await request(
      'POST',
      `/v1/projects/${project.id}/assembly-plan`,
      { expectedRevision: saved.body.data.project.revision },
      tokenA,
    );
    expect(blockedAssemblyPlan.status).toBe(409);
    const validationReplay = await request(
      'POST',
      `/v1/projects/${project.id}/circuit/validate`,
      { expectedRevision: saved.body.data.project.revision },
      tokenA,
    );
    expect(validationReplay.body.data.report.id).toBe(validated.body.data.report.id);

    const report = await request(
      'GET',
      `/v1/projects/${project.id}/circuit/validation`,
      undefined,
      tokenA,
    );
    expect(report.status).toBe(200);
    expect(report.body.data.current).toBe(true);
    expect(report.body.data.report.report.graphDigest).toBe(
      saved.body.data.graphSnapshot.graphDigest,
    );

    const renamed = await request(
      'PATCH',
      `/v1/projects/${project.id}`,
      { expectedRevision: saved.body.data.project.revision, title: 'Circuit changed' },
      tokenA,
    );
    expect(renamed.status).toBe(200);
    const nextGraph = {
      ...graph,
      id: 'graph_short_test_v2',
      projectRevision: renamed.body.data.project.revision + 1,
    };
    const updatedGraph = await request(
      'PUT',
      `/v1/projects/${project.id}/circuit`,
      { expectedRevision: renamed.body.data.project.revision, graph: nextGraph },
      tokenA,
    );
    expect(updatedGraph.status).toBe(200);
    const staleReport = await request(
      'GET',
      `/v1/projects/${project.id}/circuit/validation`,
      undefined,
      tokenA,
    );
    expect(staleReport.status).toBe(200);
    expect(staleReport.body.data.current).toBe(false);
    expect(staleReport.body.data.report).toBeNull();

    const unauthorizedValidation = await request(
      'POST',
      `/v1/projects/${project.id}/circuit/validate`,
      { expectedRevision: saved.body.data.project.revision },
      tokenB,
    );
    expect(unauthorizedValidation.status).toBe(404);
  });

  it('confirms an immutable intended graph and compares later saved virtual graphs', async () => {
    const created = await request(
      'POST',
      '/v1/projects',
      { title: 'Design intent API test' },
      tokenA,
    );
    expect(created.status).toBe(201);
    const project = created.body.data;
    const release = getCatalogRelease();
    const firstGraph = {
      schemaVersion: 1 as const,
      id: 'intent_graph_1',
      projectId: project.id,
      projectRevision: project.revision + 1,
      catalogReleaseId: release.releaseId,
      components: [],
      breadboards: [],
      terminalPlacements: [],
      wires: [],
    };
    const firstSave = await request(
      'PUT',
      `/v1/projects/${project.id}/circuit`,
      { expectedRevision: project.revision, graph: firstGraph },
      tokenA,
    );
    expect(firstSave.status).toBe(200);
    const confirmed = await request(
      'POST',
      `/v1/projects/${project.id}/circuit/design-intent`,
      {
        expectedRevision: firstSave.body.data.project.revision,
        graphSnapshotId: firstSave.body.data.graphSnapshot.id,
      },
      tokenA,
    );
    expect(confirmed.status).toBe(200);
    const initialDiff = await request(
      'GET',
      `/v1/projects/${project.id}/circuit/design-diff`,
      undefined,
      tokenA,
    );
    expect(initialDiff.body.data.comparisonVersion).toBe(1);
    expect(initialDiff.body.data.comparable).toBe(true);
    expect(initialDiff.body.data.differences).toEqual([]);

    const updatedGraph = {
      ...firstGraph,
      id: 'intent_graph_2',
      projectRevision: confirmed.body.data.project.revision + 1,
      components: [
        {
          id: 'board_intent_test',
          catalogPartId: 'board.espressif.esp32-devkitc-v4.wroom-32e.male',
        },
      ],
    };
    const secondSave = await request(
      'PUT',
      `/v1/projects/${project.id}/circuit`,
      { expectedRevision: confirmed.body.data.project.revision, graph: updatedGraph },
      tokenA,
    );
    expect(secondSave.status).toBe(200);
    const updatedDiff = await request(
      'GET',
      `/v1/projects/${project.id}/circuit/design-diff`,
      undefined,
      tokenA,
    );
    expect(updatedDiff.body.data.comparable).toBe(true);
    expect(updatedDiff.body.data.differences).toEqual([
      expect.objectContaining({ kind: 'component-added', identity: 'board_intent_test' }),
    ]);
  });

  it('duplicates only the saved circuit and serves owner-authorized project exports', async () => {
    const created = await request('POST', '/v1/projects', { title: 'Source project' }, tokenA);
    const source = created.body.data;
    const release = getCatalogRelease();
    const graph = {
      schemaVersion: 1 as const,
      id: 'duplicate-source-graph',
      projectId: source.id,
      projectRevision: source.revision + 1,
      catalogReleaseId: release.releaseId,
      components: [
        {
          id: 'duplicate-board',
          catalogPartId: 'board.espressif.esp32-devkitc-v4.wroom-32e.male',
        },
      ],
      breadboards: [],
      terminalPlacements: [],
      wires: [],
    };
    const saved = await request(
      'PUT',
      `/v1/projects/${source.id}/circuit`,
      { expectedRevision: source.revision, graph },
      tokenA,
    );
    expect(saved.status).toBe(200);

    const duplicateKey = randomUUID();
    const duplicated = await request(
      'POST',
      `/v1/projects/${source.id}/duplicate`,
      {},
      tokenA,
      duplicateKey,
    );
    expect(duplicated.status).toBe(201);
    expect(duplicated.body.data.copied).toEqual({
      circuitGraph: true,
      imports: false,
      firmware: false,
      hardwarePhotos: false,
      simulationRuns: false,
    });
    const copy = duplicated.body.data.project;
    expect(copy.id).not.toBe(source.id);
    expect(copy.title).toBe('Copy of Source project');
    expect(copy.revision).toBe(2);
    const duplicateReplay = await request(
      'POST',
      `/v1/projects/${source.id}/duplicate`,
      {},
      tokenA,
      duplicateKey,
    );
    expect(duplicateReplay.body.data.project.id).toBe(copy.id);

    const copyGraph = await request('GET', `/v1/projects/${copy.id}/circuit`, undefined, tokenA);
    expect(copyGraph.body.data.graphSnapshot.graph).toMatchObject({
      projectId: copy.id,
      projectRevision: 2,
      components: graph.components,
    });
    expect(copyGraph.body.data.graphSnapshot.graph.id).not.toBe(graph.id);

    const denied = await app.inject({
      method: 'GET',
      url: `/v1/projects/${copy.id}/export?format=checklist`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(denied.statusCode).toBe(404);
    const exportResponse = await app.inject({
      method: 'GET',
      url: `/v1/projects/${copy.id}/export?format=checklist`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(exportResponse.statusCode).toBe(200);
    expect(exportResponse.headers['content-disposition']).toContain('wiring-checklist.md');
    expect(exportResponse.body).toContain('## Components');
    expect(exportResponse.body).toContain('## Connections');
    const specificationResponse = await app.inject({
      method: 'GET',
      url: `/v1/projects/${copy.id}/export?format=specification`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(specificationResponse.statusCode).toBe(200);
    expect(specificationResponse.headers['content-disposition']).toContain('schemora-project.json');
    expect(JSON.parse(specificationResponse.body)).toMatchObject({
      format: 'schemora-project-specification',
      schemaVersion: 1,
      project: { id: copy.id },
      integrity: {
        circuitGraphSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        catalogReleaseSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });

    const renamed = await request(
      'PATCH',
      `/v1/projects/${copy.id}`,
      { expectedRevision: copy.revision, title: 'Changed copy title' },
      tokenA,
    );
    const restoreKey = randomUUID();
    const restored = await request(
      'POST',
      `/v1/projects/${copy.id}/revisions/2/restore`,
      { expectedRevision: renamed.body.data.project.revision },
      tokenA,
      restoreKey,
    );
    expect(restored.body.data.project.title).toBe('Copy of Source project');
    expect(restored.body.data.project.revision).toBe(4);
    expect(restored.body.data.restored).toEqual({ title: true, circuitGraph: true });
    const restoredGraph = await request(
      'GET',
      `/v1/projects/${copy.id}/circuit`,
      undefined,
      tokenA,
    );
    expect(restoredGraph.body.data.graphSnapshot.graph).toMatchObject({
      projectId: copy.id,
      projectRevision: 4,
      components: graph.components,
    });
    expect(restoredGraph.body.data.graphSnapshot.graph.id).not.toBe(
      copyGraph.body.data.graphSnapshot.graph.id,
    );
    const restoreReplay = await request(
      'POST',
      `/v1/projects/${copy.id}/revisions/2/restore`,
      { expectedRevision: renamed.body.data.project.revision },
      tokenA,
      restoreKey,
    );
    expect(restoreReplay.body.data.project.revision).toBe(4);
  });
});
