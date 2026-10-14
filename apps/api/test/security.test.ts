import { afterAll, describe, expect, it, vi } from 'vitest';
import { SignJWT } from 'jose';
import { Repository, requestDigest } from '@schemora/persistence';
import { FileStorage } from '@schemora/storage';
import { readConfig } from '../src/config.js';
import { buildApp } from '../src/app.js';

const secret = 'test-session-secret-only-00000000000000000000';
const config = readConfig({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://invalid:invalid@127.0.0.1:1/unavailable',
  SESSION_SECRET: secret,
});
const repository = new Repository(config.DATABASE_URL);
const app = buildApp(config, repository, new FileStorage('.private-test-unused', 'test'));
const scannedUploads: number[] = [];
const scanningApp = buildApp(config, repository, new FileStorage('.private-test-unused', 'test'), {
  scan: async (bytes) => {
    scannedUploads.push(bytes.length);
    return 'infected';
  },
  ready: async () => true,
});
afterAll(async () => {
  await app.close();
  await scanningApp.close();
  await repository.pool.end();
});
describe('trusted identity and production configuration', () => {
  it('denies an unauthenticated caller and forged browser identity without touching the database', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/projects',
      headers: { 'x-dev-user': 'github:1' },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('UNAUTHENTICATED');
  });
  it('rejects a token with a wrong audience and wrong key', async () => {
    for (const [audience, signingSecret] of [
      ['other-api', secret],
      ['schemora-api', secret + 'wrong'],
    ]) {
      const token = await new SignJWT({ auth_time: Math.floor(Date.now() / 1000) })
        .setSubject('github:1')
        .setIssuer('schemora-web')
        .setAudience(audience!)
        .setIssuedAt()
        .setExpirationTime('2m')
        .setProtectedHeader({ alg: 'HS256' })
        .sign(new TextEncoder().encode(signingSecret));
      const response = await app.inject({
        method: 'GET',
        url: '/v1/projects',
        headers: { authorization: 'Bearer ' + token },
      });
      expect(response.statusCode).toBe(401);
    }
  });
  it('rejects infected source and photo uploads before persistence or image parsing', async () => {
    const accountGuard = vi
      .spyOn(repository.pool, 'query')
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [{ lifecycle_status: 'active' }], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [{ lifecycle_status: 'active' }], rowCount: 1 } as never);
    const token = await new SignJWT({ auth_time: Math.floor(Date.now() / 1000), name: 'maker' })
      .setSubject('github:1')
      .setIssuer('schemora-web')
      .setAudience('schemora-api')
      .setIssuedAt()
      .setExpirationTime('2m')
      .setProtectedHeader({ alg: 'HS256' })
      .sign(new TextEncoder().encode(secret));
    const headers = { authorization: 'Bearer ' + token };
    const projectId = '00000000-0000-4000-8000-000000000001';
    const source = await scanningApp.inject({
      method: 'POST',
      url: `/v1/projects/${projectId}/imports`,
      headers,
      payload: { expectedRevision: 1, filename: 'source.txt', contentBase64: 'dGVzdA==' },
    });
    const photo = await scanningApp.inject({
      method: 'POST',
      url: `/v1/projects/${projectId}/hardware-photos`,
      headers,
      payload: {
        expectedRevision: 1,
        shotRole: 'other',
        consentVersion: 'photo-evidence-v1',
        contentBase64: 'dGVzdA==',
      },
    });
    expect(source.statusCode).toBe(422);
    expect(photo.statusCode).toBe(422);
    expect(source.json().error.code).toBe('MALWARE_DETECTED');
    expect(photo.json().error.code).toBe('MALWARE_DETECTED');
    expect(scannedUploads).toEqual([4, 4]);
    accountGuard.mockRestore();
  });
  it('rejects cross-origin requests before database access', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/projects',
      headers: { origin: 'https://untrusted.example' },
    });
    expect(response.statusCode).toBe(403);
  });
  it('rejects unsafe production adapters, secrets, database TLS and web origin', () => {
    expect(() =>
      readConfig({
        NODE_ENV: 'production',
        DATABASE_URL: config.DATABASE_URL,
        SESSION_SECRET: secret,
      }),
    ).toThrow();
    expect(() => new FileStorage('.private-test-unused', 'production')).toThrow();
    const valid = {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://user:pass@db.example/schemora?sslmode=verify-full',
      SESSION_SECRET: '98db39cc0e9ae0a8c079a323e3c7f433a39b2d113',
      STORAGE_DRIVER: 's3',
      S3_BUCKET: 'private-bucket',
      AWS_REGION: 'ap-south-1',
      MALWARE_SCANNER_MODE: 'clamd',
      CLAMD_HOST: 'clamav.internal',
      WEB_ORIGIN: 'https://schemora.example',
    };
    expect(readConfig(valid).STORAGE_DRIVER).toBe('s3');
    expect(() => readConfig({ ...valid, MALWARE_SCANNER_MODE: 'disabled' })).toThrow(
      'malware scanner',
    );
    expect(() => readConfig({ ...valid, CLAMD_HOST: undefined })).toThrow('scanner host');
    expect(() => readConfig({ ...valid, DATABASE_URL: config.DATABASE_URL })).toThrow('sslmode');
  });
  it('binds immutable artifact identity to processing metadata for an identical payload', () => {
    const payload = { summary: 'Same source facts', schemaVersion: 1 };
    const first = requestDigest({
      payload,
      metadata: { parserVersion: '1', model: 'a', promptVersion: '1' },
    });
    const parserChanged = requestDigest({
      payload,
      metadata: { parserVersion: '2', model: 'a', promptVersion: '1' },
    });
    const modelChanged = requestDigest({
      payload,
      metadata: { parserVersion: '1', model: 'b', promptVersion: '1' },
    });
    const promptChanged = requestDigest({
      payload,
      metadata: { parserVersion: '1', model: 'a', promptVersion: '2' },
    });
    expect(new Set([first, parserChanged, modelChanged, promptChanged]).size).toBe(4);
  });
});
