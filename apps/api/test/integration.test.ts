import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SignJWT } from 'jose';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Repository, type Job } from '@schemora/persistence';
import { FileStorage } from '@schemora/storage';
import { Worker } from '../../worker/src/runner.js';
import { readConfig } from '../src/config.js';
import { buildApp } from '../src/app.js';

describe.skipIf(!process.env.TEST_DATABASE_URL)(
  'real PostgreSQL and private storage integration',
  () => {
    const secret = 'test-session-secret-only-00000000000000000000';
    const userA = 'test:' + randomUUID();
    const userB = 'test:' + randomUUID();
    const config = readConfig({
      NODE_ENV: 'test',
      DATABASE_URL: process.env.TEST_DATABASE_URL!,
      SESSION_SECRET: secret,
    });
    const repository = new Repository(config.DATABASE_URL);
    let directory: string;
    let app: ReturnType<typeof buildApp>;
    let worker: Worker;
    let tokenA: string;
    let tokenB: string;
    async function token(subject: string) {
      return new SignJWT({})
        .setSubject(subject)
        .setIssuer('schemora-web')
        .setAudience('schemora-api')
        .setIssuedAt()
        .setExpirationTime('5m')
        .setProtectedHeader({ alg: 'HS256' })
        .sign(new TextEncoder().encode(secret));
    }
    async function request(
      method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
      url: string,
      payload?: unknown,
      identity = tokenA,
      idempotencyKey = randomUUID(),
    ) {
      const response = await app.inject({
        method,
        url,
        headers: { authorization: 'Bearer ' + identity, 'idempotency-key': idempotencyKey },
        ...(payload ? { payload } : {}),
      });
      return { status: response.statusCode, ...response.json() };
    }
    async function create() {
      return (await request('POST', '/v1/projects', { title: 'Integration project' })).data;
    }
    async function upload(
      project: { id: string; revision: number },
      filename = 'conversation.txt',
      content = 'User: Build an ESP32 LED circuit.\nAssistant: Use GPIO18 and a 220 ohm resistor.',
    ) {
      return request('POST', '/v1/projects/' + project.id + '/imports', {
        expectedRevision: project.revision,
        filename,
        contentBase64: Buffer.from(content).toString('base64'),
      });
    }
    beforeAll(async () => {
      directory = await mkdtemp(join(tmpdir(), 'schemora-test-'));
      const storage = new FileStorage(directory, 'test');
      app = buildApp(config, repository, storage);
      worker = new Worker(repository, storage);
      tokenA = await token(userA);
      tokenB = await token(userB);
    });
    afterAll(async () => {
      await app.close();
      await repository.transaction(async (client) => {
        for (const table of [
          'upload_intents',
          'reviews',
          'revisions',
          'imports',
          'import_artifacts',
          'jobs',
          'outbox',
        ])
          await client.query(
            'DELETE FROM ' +
              table +
              ' WHERE project_id IN (SELECT id FROM projects WHERE owner_id=ANY($1))',
            [[userA, userB]],
          );
        await client.query('DELETE FROM idempotency WHERE owner_id=ANY($1)', [[userA, userB]]);
        await client.query('DELETE FROM projects WHERE owner_id=ANY($1)', [[userA, userB]]);
        await client.query('DELETE FROM principals WHERE id=ANY($1)', [[userA, userB]]);
      });
      await repository.pool.end();
      await rm(directory, { recursive: true, force: true });
    });
    it('enforces project and nested import ownership without revealing another owner', async () => {
      const project = await create();
      const source = await upload(project);
      expect((await request('GET', '/v1/projects/' + project.id, undefined, tokenB)).status).toBe(
        404,
      );
      expect(
        (
          await request(
            'GET',
            '/v1/projects/' + project.id + '/imports/' + source.data.import.id,
            undefined,
            tokenB,
          )
        ).status,
      ).toBe(404);
      expect(
        (await request('DELETE', '/v1/projects/' + project.id, { expectedRevision: 2 }, tokenB))
          .status,
      ).toBe(404);
    });
    it('replays the same action and rejects idempotency key reuse with a different body', async () => {
      const key = randomUUID();
      const first = await request('POST', '/v1/projects', { title: 'First title' }, tokenA, key);
      const replay = await request('POST', '/v1/projects', { title: 'First title' }, tokenA, key);
      expect(replay.data.id).toBe(first.data.id);
      expect(
        (await request('POST', '/v1/projects', { title: 'Changed' }, tokenA, key)).status,
      ).toBe(409);
    });
    it('commits one of two concurrent edits and preserves immutable revision snapshots', async () => {
      const project = await create();
      const results = await Promise.all(
        ['One', 'Two'].map((title) =>
          request('PATCH', '/v1/projects/' + project.id, { expectedRevision: 1, title }),
        ),
      );
      expect(results.map((item) => item.status).sort()).toEqual([200, 409]);
      const revisions = await request('GET', '/v1/projects/' + project.id + '/revisions');
      expect(revisions.data.map((item: { revision: number }) => item.revision)).toEqual([2, 1]);
      const initial = await request('GET', '/v1/projects/' + project.id + '/revisions/1');
      expect(initial.data.snapshot.project.title).toBe('Integration project');
    });
    it('accepts all six bounded upload formats and safely cancels before interpretation', async () => {
      for (const extension of ['txt', 'md', 'html', 'pdf', 'json', 'zip']) {
        const project = await create();
        const source = await upload(project, 'export.' + extension, 'format intake bytes');
        expect(source.status).toBe(202);
        expect(JSON.stringify(source.data)).not.toContain('object_key');
        const cancelled = await request(
          'POST',
          '/v1/projects/' + project.id + '/imports/' + source.data.import.id + '/cancel',
          { expectedRevision: source.data.project.revision },
        );
        expect(cancelled.data.import.status).toBe('cancelled');
      }
    });
    it('normalizes a selected thread, preserves evidence and records reviewed corrections', async () => {
      const project = await create();
      const source = await upload(project);
      // Earlier tests may have queued work; drain to the requested source.
      let detail;
      for (let index = 0; index < 30; index++) {
        await worker.tick('process_import');
        detail = await request(
          'GET',
          '/v1/projects/' + project.id + '/imports/' + source.data.import.id,
        );
        if (detail.data.import.status === 'ready') break;
      }
      expect(detail!.data.import.status).toBe('ready');
      expect(detail!.data.messages.length).toBe(2);
      const candidate = detail!.data.import.extraction.candidates[0];
      expect(candidate.evidence[0].messageId).toBe(detail!.data.messages[0].id);
      const reviewed = await request(
        'POST',
        '/v1/projects/' + project.id + '/imports/' + source.data.import.id + '/reviews',
        {
          expectedRevision: detail!.data.project.revision,
          candidateId: candidate.id,
          decision: 'correct',
          value: 'Exact board model must still be selected',
          reason: 'User correction',
        },
      );
      expect(reviewed.status).toBe(200);
      expect(reviewed.data.review.decision).toBe('correct');
      const fresh = await request(
        'GET',
        '/v1/projects/' + project.id + '/imports/' + source.data.import.id,
      );
      expect(fresh.data.import.extraction.candidates[0].value).toBe(candidate.value);
      expect(fresh.data.reviews[0].value).toContain('Exact board');
    }, 60_000);
    it('requires choosing one of multiple conversations before extraction', async () => {
      const project = await create();
      const source = await upload(
        project,
        'threads.json',
        JSON.stringify([
          { title: 'LED', messages: [{ role: 'user', content: 'ESP32 LED GPIO18' }] },
          { title: 'Motor', messages: [{ role: 'user', content: 'Arduino motor GPIO7' }] },
        ]),
      );
      for (let index = 0; index < 30; index++) {
        await worker.tick('process_import');
        const detail = await request(
          'GET',
          '/v1/projects/' + project.id + '/imports/' + source.data.import.id,
        );
        if (detail.data.import.status === 'awaiting_selection') {
          expect(detail.data.messages).toEqual([]);
          expect(detail.data.import.extraction).toBeNull();
          await request(
            'POST',
            '/v1/projects/' + project.id + '/imports/' + source.data.import.id + '/select',
            {
              expectedRevision: detail.data.project.revision,
              conversationId: detail.data.import.conversations[1].id,
            },
          );
          await worker.tick('process_import');
          const selected = await request(
            'GET',
            '/v1/projects/' + project.id + '/imports/' + source.data.import.id,
          );
          expect(selected.data.import.status).toBe('ready');
          expect(selected.data.messages[0].content).toContain('Arduino');
          expect(
            selected.data.import.extraction.candidates
              .map((item: { value: string }) => item.value)
              .join(' '),
          ).not.toContain('ESP32');
          return;
        }
      }
      throw new Error('Import did not require selection');
    }, 60_000);
    it('retries a cancelled import and archives a project as read only', async () => {
      const project = await create();
      const source = await upload(project);
      const cancelled = await request(
        'POST',
        '/v1/projects/' + project.id + '/imports/' + source.data.import.id + '/cancel',
        { expectedRevision: 2 },
      );
      const retried = await request(
        'POST',
        '/v1/projects/' + project.id + '/imports/' + source.data.import.id + '/retry',
        { expectedRevision: cancelled.data.project.revision },
      );
      expect(retried.data.import.status).toBe('queued');
      const archived = await request('POST', '/v1/projects/' + project.id + '/archive', {
        expectedRevision: retried.data.project.revision,
      });
      expect(archived.data.project.status).toBe('archived');
      expect(
        (
          await request('PATCH', '/v1/projects/' + project.id, {
            expectedRevision: archived.data.project.revision,
            title: 'Cannot edit',
          })
        ).status,
      ).toBe(409);
    });
    it('revokes access before purge, replays deletion and removes private content', async () => {
      const project = await create();
      const source = await upload(project);
      const key = randomUUID();
      const deleted = await request(
        'DELETE',
        '/v1/projects/' + project.id,
        { expectedRevision: 2 },
        tokenA,
        key,
      );
      expect(deleted.data.project.status).toBe('deleting');
      expect(
        (
          await request(
            'DELETE',
            '/v1/projects/' + project.id,
            { expectedRevision: 2 },
            tokenA,
            key,
          )
        ).data.project.status,
      ).toBe('deleting');
      expect((await request('GET', '/v1/projects/' + project.id)).status).toBe(404);
      await worker.tick('delete_project');
      const count = await repository.pool.query(
        'SELECT count(*)::int AS count FROM imports WHERE project_id=$1',
        [project.id],
      );
      expect(count.rows[0].count).toBe(0);
      expect(
        (await repository.pool.query('SELECT title,status FROM projects WHERE id=$1', [project.id]))
          .rows[0],
      ).toEqual({ title: '[deleted]', status: 'deleted' });
    });
    it('paginates projects without overlap including database timestamp precision', async () => {
      for (let index = 0; index < 55; index++)
        await repository.create(userB, 'Page ' + index, randomUUID());
      const first = await request('GET', '/v1/projects', undefined, tokenB);
      expect(first.data.items).toHaveLength(50);
      expect(first.data.nextCursor).toBeTruthy();
      const second = await request(
        'GET',
        '/v1/projects?cursor=' + first.data.nextCursor,
        undefined,
        tokenB,
      );
      expect(second.data.items).toHaveLength(5);
      const ids = [...first.data.items, ...second.data.items].map(
        (item: { id: string }) => item.id,
      );
      expect(new Set(ids).size).toBe(55);
      expect((await request('GET', '/v1/projects?cursor=bad', undefined, tokenB)).status).toBe(400);
    });
    it('fences an expired worker lease and applies duplicate delivery only once', async () => {
      const project = await create();
      const source = await upload(project);
      await repository.dispatch();
      const payloadId = source.data.import.id;
      const original = (
        await repository.pool.query<Job>(
          "UPDATE jobs SET status='running',lease_token=$2,lease_until=now()-interval '1 second',attempts=1 WHERE payload->>'importId'=$1 RETURNING *",
          [payloadId, randomUUID()],
        )
      ).rows[0]!;
      const claimed = (
        await repository.pool.query<Job>(
          "UPDATE jobs SET lease_token=$2,lease_until=now()+interval '120 second',attempts=2 WHERE payload->>'importId'=$1 RETURNING *",
          [payloadId, randomUUID()],
        )
      ).rows[0]!;
      await worker.processImport(original);
      const afterStale = await request(
        'GET',
        '/v1/projects/' + project.id + '/imports/' + payloadId,
      );
      expect(afterStale.data.import.status).toBe('queued');
      expect(afterStale.data.project.revision).toBe(2);
      await worker.processImport(claimed);
      const ready = await request('GET', '/v1/projects/' + project.id + '/imports/' + payloadId);
      expect(ready.data.import.status).toBe('ready');
      await worker.processImport(claimed);
      const duplicate = await request(
        'GET',
        '/v1/projects/' + project.id + '/imports/' + payloadId,
      );
      expect(duplicate.data.project.revision).toBe(ready.data.project.revision);
      const artifacts = await repository.pool.query(
        'SELECT count(*)::int AS count FROM import_artifacts WHERE project_id=$1',
        [project.id],
      );
      expect(artifacts.rows[0].count).toBe(2);
    }, 60_000);
    it('blocks a completed parser result after cancellation during source processing', async () => {
      const project = await create();
      const source = await upload(project);
      await repository.dispatch();
      const job = (
        await repository.pool.query<Job>(
          "UPDATE jobs SET status='running',lease_token=$2,lease_until=now()+interval '120 second',attempts=1 WHERE payload->>'importId'=$1 RETURNING *",
          [source.data.import.id, randomUUID()],
        )
      ).rows[0]!;
      const storage = new FileStorage(directory, 'test');
      let release!: () => void;
      let started!: () => void;
      const waiting = new Promise<void>((resolve) => {
        release = resolve;
      });
      const reading = new Promise<void>((resolve) => {
        started = resolve;
      });
      const blocked = new Worker(repository, {
        put: (...args) => storage.put(...args),
        delete: (...args) => storage.delete(...args),
        read: async (...args) => {
          const bytes = await storage.read(...args);
          started();
          await waiting;
          return bytes;
        },
      });
      const active = blocked.processImport(job);
      await reading;
      const cancelled = await request(
        'POST',
        '/v1/projects/' + project.id + '/imports/' + source.data.import.id + '/cancel',
        { expectedRevision: 2 },
      );
      expect(cancelled.status).toBe(200);
      release();
      await active;
      const detail = await request(
        'GET',
        '/v1/projects/' + project.id + '/imports/' + source.data.import.id,
      );
      expect(detail.data.import.status).toBe('cancelled');
      expect(detail.data.import.extraction).toBeNull();
      expect(detail.data.project.revision).toBe(3);
    }, 60_000);
    it('purges while parsing is active and refuses to republish deleted content', async () => {
      const project = await create();
      const source = await upload(project);
      await repository.dispatch();
      const job = (
        await repository.pool.query<Job>(
          "UPDATE jobs SET status='running',lease_token=$2,lease_until=now()+interval '120 second',attempts=1 WHERE payload->>'importId'=$1 RETURNING *",
          [source.data.import.id, randomUUID()],
        )
      ).rows[0]!;
      const storage = new FileStorage(directory, 'test');
      let release!: () => void;
      let started!: () => void;
      const waiting = new Promise<void>((resolve) => {
        release = resolve;
      });
      const reading = new Promise<void>((resolve) => {
        started = resolve;
      });
      const blocked = new Worker(repository, {
        put: (...args) => storage.put(...args),
        delete: (...args) => storage.delete(...args),
        read: async (...args) => {
          const bytes = await storage.read(...args);
          started();
          await waiting;
          return bytes;
        },
      });
      const active = blocked.processImport(job);
      await reading;
      expect(
        (await request('DELETE', '/v1/projects/' + project.id, { expectedRevision: 2 })).status,
      ).toBe(200);
      await worker.tick('delete_project');
      release();
      await active;
      expect((await request('GET', '/v1/projects/' + project.id)).status).toBe(404);
      const artifacts = await repository.pool.query(
        'SELECT count(*)::int AS count FROM import_artifacts WHERE project_id=$1',
        [project.id],
      );
      expect(artifacts.rows[0].count).toBe(0);
    }, 60_000);
    it('archives during active processing and preserves a cancelled read-only import', async () => {
      const project = await create();
      const source = await upload(project);
      await repository.dispatch();
      const job = (
        await repository.pool.query<Job>(
          "UPDATE jobs SET status='running',lease_token=$2,lease_until=now()+interval '120 second',attempts=1 WHERE payload->>'importId'=$1 RETURNING *",
          [source.data.import.id, randomUUID()],
        )
      ).rows[0]!;
      const storage = new FileStorage(directory, 'test');
      let release!: () => void;
      let started!: () => void;
      const waiting = new Promise<void>((resolve) => {
        release = resolve;
      });
      const reading = new Promise<void>((resolve) => {
        started = resolve;
      });
      const blocked = new Worker(repository, {
        put: (...args) => storage.put(...args),
        delete: (...args) => storage.delete(...args),
        read: async (...args) => {
          const bytes = await storage.read(...args);
          started();
          await waiting;
          return bytes;
        },
      });
      const active = blocked.processImport(job);
      await reading;
      const archived = await request('POST', '/v1/projects/' + project.id + '/archive', {
        expectedRevision: 2,
      });
      expect(archived.status).toBe(200);
      release();
      await active;
      const detail = await request(
        'GET',
        '/v1/projects/' + project.id + '/imports/' + source.data.import.id,
      );
      expect(detail.data.project.status).toBe('archived');
      expect(detail.data.import.status).toBe('cancelled');
      expect(detail.data.import.extraction).toBeNull();
    }, 60_000);
    it('preserves normalized content and truthful manual-assist review when a provider fails', async () => {
      const project = await create();
      const source = await upload(project);
      await repository.dispatch();
      const job = (
        await repository.pool.query<Job>(
          "UPDATE jobs SET status='running',lease_token=$2,lease_until=now()+interval '120 second',attempts=1 WHERE payload->>'importId'=$1 RETURNING *",
          [source.data.import.id, randomUUID()],
        )
      ).rows[0]!;
      const fallback = new Worker(repository, new FileStorage(directory, 'test'), {
        mode: 'provider',
        extract: async () => {
          throw new Error('Provider unavailable');
        },
      });
      await fallback.processImport(job);
      const detail = await request(
        'GET',
        '/v1/projects/' + project.id + '/imports/' + source.data.import.id,
      );
      expect(detail.data.import.status).toBe('ready');
      expect(detail.data.messages).toHaveLength(2);
      expect(detail.data.import.extractionMode).toBe('deterministic');
      expect(detail.data.import.warnings.join(' ')).toContain('may miss design facts');
    }, 60_000);
    it('renews a healthy purge lease while object deletion runs longer than the initial lease', async () => {
      const project = await create();
      await upload(project);
      await request('DELETE', '/v1/projects/' + project.id, { expectedRevision: 2 });
      const storage = new FileStorage(directory, 'test');
      const slow = new Worker(
        repository,
        {
          put: (...args) => storage.put(...args),
          read: (...args) => storage.read(...args),
          delete: async (...args) => {
            await new Promise((resolve) => setTimeout(resolve, 600));
            await storage.delete(...args);
          },
        },
        { mode: 'rules' },
        0.2,
      );
      await slow.tick('delete_project');
      expect(
        (await repository.pool.query('SELECT status FROM projects WHERE id=$1', [project.id]))
          .rows[0].status,
      ).toBe('deleted');
    });
    it('reaps an exhausted lease without invalidating a newer retry job', async () => {
      const project = await create();
      const source = await upload(project);
      await repository.dispatch();
      const original = (
        await repository.pool.query<Job>(
          "UPDATE jobs SET status='running',lease_token=$2,lease_until=now()-interval '1 second',attempts=3 WHERE payload->>'importId'=$1 RETURNING *",
          [source.data.import.id, randomUUID()],
        )
      ).rows[0]!;
      await repository.pool.query("UPDATE imports SET status='processing' WHERE id=$1", [
        source.data.import.id,
      ]);
      await repository.reapExpired();
      expect(
        (await request('GET', '/v1/projects/' + project.id + '/imports/' + source.data.import.id))
          .data.import.status,
      ).toBe('failed');
      const retried = await request(
        'POST',
        '/v1/projects/' + project.id + '/imports/' + source.data.import.id + '/retry',
        { expectedRevision: 2 },
      );
      expect(retried.status).toBe(200);
      await repository.dispatch();
      await repository.pool.query("UPDATE imports SET status='processing' WHERE id=$1", [
        source.data.import.id,
      ]);
      await repository.reapExpired();
      expect(
        (await request('GET', '/v1/projects/' + project.id + '/imports/' + source.data.import.id))
          .data.import.status,
      ).toBe('processing');
      expect(
        (await repository.pool.query('SELECT status FROM jobs WHERE id=$1', [original.id])).rows[0]
          .status,
      ).toBe('failed');
    });
    it('tracks an uncertain failed put until expiry and reclaims a late object write', async () => {
      const project = await create();
      const storage = new FileStorage(directory, 'test');
      let key = '';
      let digest = '';
      const failing = buildApp(config, repository, {
        read: (...args) => storage.read(...args),
        delete: (...args) => storage.delete(...args),
        put: async (objectKey, bytes) => {
          key = objectKey;
          digest = await storage.put(objectKey, bytes);
          throw new Error('Uncertain put acknowledgement');
        },
      });
      try {
        const result = await failing.inject({
          method: 'POST',
          url: '/v1/projects/' + project.id + '/imports',
          headers: { authorization: 'Bearer ' + tokenA, 'idempotency-key': randomUUID() },
          payload: {
            expectedRevision: 1,
            filename: 'source.txt',
            contentBase64: Buffer.from('ESP32 LED').toString('base64'),
          },
        });
        expect(result.statusCode).toBe(500);
        expect(
          (
            await repository.pool.query(
              'SELECT count(*)::int AS count FROM upload_intents WHERE object_key=$1',
              [key],
            )
          ).rows[0].count,
        ).toBe(1);
        // A storage server may finish its original put after the caller timed out and cleanup ran.
        await storage.put(key, Buffer.from('ESP32 LED'));
        await repository.pool.query(
          "UPDATE upload_intents SET expires_at=now()-interval '1 second' WHERE object_key=$1",
          [key],
        );
        await repository.cleanupUploadIntents((objectKey) => storage.delete(objectKey));
        expect(
          (
            await repository.pool.query(
              'SELECT count(*)::int AS count FROM upload_intents WHERE object_key=$1',
              [key],
            )
          ).rows[0].count,
        ).toBe(0);
        await expect(storage.read(key, digest)).rejects.toThrow();
      } finally {
        await failing.close();
      }
    });
    it('cleans tracked bytes and intent when a confirmed put cannot persist the source', async () => {
      const project = await create();
      const storage = new FileStorage(directory, 'test');
      let key = '';
      let digest = '';
      const failing = buildApp(config, repository, {
        read: (...args) => storage.read(...args),
        delete: (...args) => storage.delete(...args),
        put: async (objectKey, bytes) => {
          key = objectKey;
          return (digest = await storage.put(objectKey, bytes));
        },
      });
      const mutationFailure = vi
        .spyOn(repository, 'mutate')
        .mockRejectedValueOnce(new Error('Persistence unavailable'));
      try {
        const result = await failing.inject({
          method: 'POST',
          url: '/v1/projects/' + project.id + '/imports',
          headers: { authorization: 'Bearer ' + tokenA, 'idempotency-key': randomUUID() },
          payload: {
            expectedRevision: 1,
            filename: 'source.txt',
            contentBase64: Buffer.from('ESP32 LED').toString('base64'),
          },
        });
        expect(result.statusCode).toBe(500);
        expect(
          (
            await repository.pool.query(
              'SELECT count(*)::int AS count FROM upload_intents WHERE object_key=$1',
              [key],
            )
          ).rows[0].count,
        ).toBe(0);
        await expect(storage.read(key, digest)).rejects.toThrow();
      } finally {
        mutationFailure.mockRestore();
        await failing.close();
      }
    });
    it('retains a fresh intent across project purge to reclaim a crashed late upload', async () => {
      const project = await create();
      const storage = new FileStorage(directory, 'test');
      const key = randomUUID();
      await repository.registerUploadIntent(userA, project.id, key);
      await request('DELETE', '/v1/projects/' + project.id, { expectedRevision: 1 });
      await worker.tick('delete_project');
      expect((await request('GET', '/v1/projects/' + project.id)).status).toBe(404);
      expect(
        (
          await repository.pool.query(
            'SELECT count(*)::int AS count FROM upload_intents WHERE object_key=$1',
            [key],
          )
        ).rows[0].count,
      ).toBe(1);
      const digest = await storage.put(key, Buffer.from('Late staged private bytes'));
      await repository.pool.query(
        "UPDATE upload_intents SET expires_at=now()-interval '1 second' WHERE object_key=$1",
        [key],
      );
      await repository.cleanupUploadIntents((objectKey) => storage.delete(objectKey));
      await expect(storage.read(key, digest)).rejects.toThrow();
    });
    it('cleans expired crash intents while preserving fresh and accepted source objects', async () => {
      const project = await create();
      await upload(project);
      const storage = new FileStorage(directory, 'test');
      const accepted = (
        await repository.pool.query(
          'SELECT object_key,source_digest FROM imports WHERE project_id=$1',
          [project.id],
        )
      ).rows[0];
      expect(
        (
          await repository.pool.query(
            'SELECT count(*)::int AS count FROM upload_intents WHERE project_id=$1',
            [project.id],
          )
        ).rows[0].count,
      ).toBe(0);
      const expired = randomUUID(),
        fresh = randomUUID();
      await repository.registerUploadIntent(userA, project.id, expired);
      await repository.registerUploadIntent(userA, project.id, fresh);
      const expiredDigest = await storage.put(expired, Buffer.from('Expired private bytes'));
      const freshDigest = await storage.put(fresh, Buffer.from('Fresh private bytes'));
      // Defense against legacy or partially recovered metadata: accepted keys remain protected.
      await repository.registerUploadIntent(userA, project.id, accepted.object_key);
      await repository.pool.query(
        "UPDATE upload_intents SET expires_at=now()-interval '1 second' WHERE object_key=ANY($1)",
        [[expired, accepted.object_key]],
      );
      await repository.cleanupUploadIntents((objectKey) => storage.delete(objectKey));
      await expect(storage.read(expired, expiredDigest)).rejects.toThrow();
      expect((await storage.read(fresh, freshDigest)).length).toBeGreaterThan(0);
      expect(
        (await storage.read(accepted.object_key, accepted.source_digest)).length,
      ).toBeGreaterThan(0);
      expect(
        (
          await repository.pool.query(
            'SELECT count(*)::int AS count FROM upload_intents WHERE object_key=$1',
            [fresh],
          )
        ).rows[0].count,
      ).toBe(1);
    });
    it('retains an expired cleanup intent after a storage deletion failure', async () => {
      const project = await create();
      const key = randomUUID();
      await repository.registerUploadIntent(userA, project.id, key);
      await repository.pool.query(
        "UPDATE upload_intents SET expires_at=now()-interval '1 second' WHERE object_key=$1",
        [key],
      );
      await repository.cleanupUploadIntents(async () => {
        throw new Error('Object store unavailable');
      });
      expect(
        (
          await repository.pool.query(
            'SELECT count(*)::int AS count FROM upload_intents WHERE object_key=$1',
            [key],
          )
        ).rows[0].count,
      ).toBe(1);
    });
    it('paginates a 201-message transcript without loss or cross-user exposure', async () => {
      const project = await create();
      const text = Array.from(
        { length: 201 },
        (_, index) => 'User: synthetic transcript message ' + index,
      ).join('\n');
      const source = await upload(project, 'large-transcript.txt', text);
      await repository.dispatch();
      const job = (
        await repository.pool.query<Job>(
          "UPDATE jobs SET status='running',lease_token=$2,lease_until=now()+interval '120 second',attempts=1 WHERE payload->>'importId'=$1 RETURNING *",
          [source.data.import.id, randomUUID()],
        )
      ).rows[0]!;
      await worker.processImport(job);
      const route = '/v1/projects/' + project.id + '/imports/' + source.data.import.id;
      const first = await request('GET', route);
      const second = await request('GET', route + '?messageOffset=200');
      expect(first.data.messages).toHaveLength(200);
      expect(first.data.nextMessageSequence).toBe(200);
      expect(second.data.messages).toHaveLength(1);
      expect(second.data.nextMessageSequence).toBeNull();
      const combined = [...first.data.messages, ...second.data.messages];
      expect(new Set(combined.map((message: { id: string }) => message.id)).size).toBe(201);
      expect(combined.map((message: { sequence: number }) => message.sequence)).toEqual(
        Array.from({ length: 201 }, (_, index) => index),
      );
      expect(combined.every((message: { role: string }) => message.role === 'user')).toBe(true);
      expect(second.data.messages[0].content).toBe('synthetic transcript message 200');
      expect((await request('GET', route + '?messageOffset=200', undefined, tokenB)).status).toBe(
        404,
      );
    }, 60_000);
  },
);
