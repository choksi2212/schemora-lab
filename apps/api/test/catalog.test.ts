import { afterAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { SignJWT } from 'jose';
import { getCatalogRelease, getCatalogReleaseById } from '@schemora/catalog';
import { Repository } from '@schemora/persistence';
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
const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
};

async function authToken() {
  return new SignJWT({})
    .setSubject('github:101')
    .setIssuer('schemora-web')
    .setAudience('schemora-api')
    .setIssuedAt()
    .setExpirationTime('2m')
    .setProtectedHeader({ alg: 'HS256' })
    .sign(new TextEncoder().encode(secret));
}

afterAll(async () => {
  await app.close();
  await repository.pool.end();
});

describe('immutable hardware catalog API', () => {
  it('requires a verified API session', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/catalog' });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('UNAUTHENTICATED');
  });

  it('returns the pinned release, curated parts, and a canonical content digest', async () => {
    const token = await authToken();
    const release = getCatalogRelease();
    const [catalog, detail, repeated] = await Promise.all([
      app.inject({
        method: 'GET',
        url: '/v1/catalog',
        headers: { authorization: `Bearer ${token}` },
      }),
      app.inject({
        method: 'GET',
        url: `/v1/catalog/${release.releaseId}`,
        headers: { authorization: `Bearer ${token}` },
      }),
      app.inject({
        method: 'GET',
        url: `/v1/catalog/${release.releaseId}`,
        headers: { authorization: `Bearer ${token}` },
      }),
    ]);

    expect(catalog.statusCode).toBe(200);
    expect(detail.statusCode).toBe(200);
    expect(repeated.statusCode).toBe(200);
    const catalogData = catalog.json().data;
    const detailData = detail.json().data;
    const expectedDigest = createHash('sha256').update(canonicalJson(release)).digest('hex');
    expect(catalogData.currentReleaseId).toBe(release.releaseId);
    expect(catalogData.releases).toHaveLength(2);
    expect(catalogData.releases[0].releaseId).toBe(release.releaseId);
    expect(catalogData.releases[0]).toMatchObject({
      schemaVersion: release.schemaVersion,
      releaseId: release.releaseId,
      publishedOn: release.publishedOn,
      status: release.status,
      sha256: expectedDigest,
      parts: release.parts,
    });
    expect(detailData).toEqual({
      schemaVersion: release.schemaVersion,
      releaseId: release.releaseId,
      publishedOn: release.publishedOn,
      status: release.status,
      sha256: expectedDigest,
      release,
    });
    expect(repeated.json().data).toEqual(detailData);

    const historicalRelease = getCatalogReleaseById('schemora-hw-2026.10')!;
    const historical = await app.inject({
      method: 'GET',
      url: `/v1/catalog/${historicalRelease.releaseId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(historical.statusCode).toBe(200);
    expect(historical.json().data.release).toEqual(historicalRelease);
    expect(historicalRelease.parts.some((part) => part.category === 'pushbutton')).toBe(false);
  });

  it('returns 404 for an unknown release without consulting user data', async () => {
    const token = await authToken();
    const response = await app.inject({
      method: 'GET',
      url: '/v1/catalog/schemora-hw-2099.99',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('NOT_FOUND');
  });
});
