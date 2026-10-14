import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { jwtVerify } from 'jose';
import { NextRequest } from 'next/server';
import { GET as signIn } from './app/api/auth/signin/route';
import { GET as callback } from './app/api/auth/callback/route';
import { GET as proxyGet, POST as proxyPost } from './app/api/backend/[...path]/route';
import { flowCookie } from './auth';
import { ApiError, friendlyError } from './lib/api';
import {
  apiToken,
  developmentIdentity,
  identity,
  newFlow,
  sameState,
  sessionCookie,
  signSession,
  validWriteOrigin,
} from './auth';

describe('server identity and BFF boundary', () => {
  beforeEach(() => {
    process.env.DEV_AUTH = 'false';
    process.env.AUTH_SECRET = 'test-auth-secret-with-at-least-32-characters';
    process.env.SESSION_SECRET = 'test-api-secret-with-at-least-32-characters';
    process.env.WEB_ORIGIN = 'http://localhost:3000';
  });
  it('rejects unsigned or client-supplied identities', async () => {
    const request = new NextRequest('http://localhost:3000/api/backend/v1/projects', {
      headers: { 'x-dev-user': 'victim', cookie: `${sessionCookie}=forged` },
    });
    expect(await identity(request)).toBeNull();
  });
  it('binds signed browser session to stable provider subject', async () => {
    const token = await signSession('github:12345', 'maker');
    const request = new NextRequest('http://localhost:3000/', {
      headers: { cookie: `${sessionCookie}=${token}` },
    });
    expect(await identity(request)).toMatchObject({
      sub: 'github:12345',
      name: 'maker',
      mode: 'github',
      authTime: expect.any(Number),
    });
  });
  it('makes short-lived API tokens unusable as browser sessions', async () => {
    const token = await apiToken('github:12345', 'maker', Math.floor(Date.now() / 1000));
    const { payload } = await jwtVerify(
      token,
      new TextEncoder().encode(process.env.SESSION_SECRET),
      { issuer: 'schemora-web', audience: 'schemora-api', algorithms: ['HS256'] },
    );
    expect(payload.sub).toBe('github:12345');
    expect(payload.name).toBe('maker');
    expect(payload.auth_time).toEqual(expect.any(Number));
    expect(payload.exp! - payload.iat!).toBe(120);
    expect(
      await identity(
        new NextRequest('http://localhost:3000/', {
          headers: { cookie: `${sessionCookie}=${token}` },
        }),
      ),
    ).toBeNull();
  });
  it('requires an exact origin for mutation requests', () => {
    expect(
      validWriteOrigin(
        new NextRequest('http://localhost:3000/', {
          headers: { origin: 'https://attacker.invalid' },
        }),
      ),
    ).toBe(false);
    expect(validWriteOrigin(new NextRequest('http://localhost:3000/'))).toBe(false);
    expect(
      validWriteOrigin(
        new NextRequest('http://localhost:3000/', { headers: { origin: 'http://localhost:3000' } }),
      ),
    ).toBe(true);
  });
  it('permits explicit development identity on loopback only', () => {
    process.env.DEV_AUTH = 'true';
    expect(developmentIdentity(new NextRequest('http://localhost:3000/'))).toBe(true);
    expect(developmentIdentity(new NextRequest('https://public.example/'))).toBe(false);
  });
  it('uses unique PKCE/state values and exact timing-safe comparison', () => {
    const a = newFlow();
    const b = newFlow();
    expect(a.state).not.toBe(b.state);
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.challenge).toHaveLength(43);
    expect(sameState(a.state, a.state)).toBe(true);
    expect(sameState(a.state, b.state)).toBe(false);
    expect(sameState('a', 'aa')).toBe(false);
  });
});

describe('OAuth and BFF route behavior', () => {
  it('distinguishes revision conflicts from unavailable review actions', () => {
    expect(
      friendlyError(new ApiError('Archived projects are read only.', 'PROJECT_ARCHIVED', 409)),
    ).toBe('Archived projects are read only.');
    expect(
      friendlyError(
        new ApiError('Earlier claims cannot be confirmed.', 'SUPERSEDED_CANDIDATE', 409),
      ),
    ).toBe('Earlier claims cannot be confirmed.');
    expect(friendlyError(new ApiError('Stale revision.', 'REVISION_CONFLICT', 409))).toContain(
      'Refresh',
    );
  });
  beforeEach(() => {
    process.env.DEV_AUTH = 'false';
    process.env.AUTH_SECRET = 'test-auth-secret-with-at-least-32-characters';
    process.env.SESSION_SECRET = 'test-api-secret-with-at-least-32-characters';
    process.env.WEB_ORIGIN = 'http://localhost:3000';
    process.env.AUTH_GITHUB_ID = 'test-client-id';
    process.env.AUTH_GITHUB_SECRET = 'test-client-secret';
  });
  afterEach(() => vi.unstubAllGlobals());
  it('rejects forged callback state before provider access', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const response = await callback(
      new NextRequest('http://localhost:3000/api/auth/callback?code=x&state=forged', {
        headers: { cookie: `${flowCookie}=invalid` },
      }),
    );
    expect(response.status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
    expect(response.cookies.get(flowCookie)?.value).toBe('');
  });
  it('completes mocked GitHub OAuth with PKCE and stable subject', async () => {
    const start = await signIn(new NextRequest('http://localhost:3000/api/auth/signin'));
    const target = new URL(start.headers.get('location')!);
    expect(target.origin).toBe('https://github.com');
    expect(target.searchParams.get('code_challenge_method')).toBe('S256');
    const flow = start.cookies.get(flowCookie)!.value;
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'test-only-token' }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 456, login: 'builder' }), { status: 200 }),
      );
    vi.stubGlobal('fetch', fetcher);
    const response = await callback(
      new NextRequest(
        `http://localhost:3000/api/auth/callback?code=test-code&state=${target.searchParams.get('state')}`,
        { headers: { cookie: `${flowCookie}=${flow}` } },
      ),
    );
    expect(response.status).toBe(307);
    expect(String(fetcher.mock.calls[0]![1].body)).toContain('code_verifier=');
    const token = response.cookies.get(sessionCookie)!.value;
    expect(
      await identity(
        new NextRequest('http://localhost:3000/', {
          headers: { cookie: `${sessionCookie}=${token}` },
        }),
      ),
    ).toEqual({ sub: 'github:456', name: 'builder', mode: 'github' });
    expect(response.headers.get('set-cookie')).toContain('HttpOnly');
    expect(response.cookies.get(flowCookie)?.value).toBe('');
  });
  it('does not forward browser-supplied API bearer tokens', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const response = await proxyGet(
      new NextRequest('http://localhost:3000/api/backend/v1/projects', {
        headers: { Authorization: 'Bearer forged' },
      }),
      { params: Promise.resolve({ path: ['v1', 'projects'] }) },
    );
    expect(response.status).toBe(401);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('BFF signs its own token and restricts forwarded paths', async () => {
    const session = await signSession('github:123', 'maker');
    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: { items: [], nextCursor: null } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetcher);
    const response = await proxyGet(
      new NextRequest('http://localhost:3000/api/backend/v1/projects', {
        headers: { cookie: `${sessionCookie}=${session}`, Authorization: 'Bearer forged' },
      }),
      { params: Promise.resolve({ path: ['v1', 'projects'] }) },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const token = (fetcher.mock.calls[0]![1].headers as Headers).get('authorization')!.slice(7);
    const { payload } = await jwtVerify(
      token,
      new TextEncoder().encode(process.env.SESSION_SECRET),
      { issuer: 'schemora-web', audience: 'schemora-api' },
    );
    expect(payload.sub).toBe('github:123');
    const rejected = await proxyGet(
      new NextRequest('http://localhost:3000/api/backend/v1/other', {
        headers: { cookie: `${sessionCookie}=${session}` },
      }),
      { params: Promise.resolve({ path: ['v1', 'other'] }) },
    );
    expect(rejected.status).toBe(404);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('BFF refuses cross-origin mutations before downstream access', async () => {
    const session = await signSession('github:123', 'maker');
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const response = await proxyPost(
      new NextRequest('http://localhost:3000/api/backend/v1/projects', {
        method: 'POST',
        headers: { cookie: `${sessionCookie}=${session}`, origin: 'https://evil.invalid' },
        body: '{}',
      }),
      { params: Promise.resolve({ path: ['v1', 'projects'] }) },
    );
    expect(response.status).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
