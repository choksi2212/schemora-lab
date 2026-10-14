import { NextRequest, NextResponse } from 'next/server';
import { apiToken, identity, validWriteOrigin } from '../../../../auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const maxBody = 15 * 1024 * 1024;
async function proxy(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  try {
    const user = await identity(request);
    if (!user)
      return NextResponse.json(
        { error: { code: 'UNAUTHENTICATED', message: 'Sign in to continue.' } },
        { status: 401 },
      );
    if (!['GET', 'HEAD'].includes(request.method) && !validWriteOrigin(request))
      return NextResponse.json(
        { error: { code: 'ORIGIN_REJECTED', message: 'Invalid request origin.' } },
        { status: 403 },
      );
    const { path } = await context.params;
    const validCatalogRead =
      path[0] === 'v1' &&
      path[1] === 'catalog' &&
      ['GET', 'HEAD'].includes(request.method) &&
      (path.length === 2 || path.length === 3);
    const validProjectOperation = path[0] === 'v1' && path[1] === 'projects';
    const validAccountOperation =
      path[0] === 'v1' && path[1] === 'account' && (path.length === 2 || path.length === 3);
    if (
      (!validCatalogRead && !validProjectOperation && !validAccountOperation) ||
      path.some((part) => part === '..' || part.includes('/') || part.includes('\\'))
    )
      return NextResponse.json(
        { error: { code: 'NOT_FOUND', message: 'Unknown operation.' } },
        { status: 404 },
      );
    const origin = new URL(process.env.API_ORIGIN ?? 'http://127.0.0.1:4000');
    const target = new URL(`/${path.map(encodeURIComponent).join('/')}`, origin);
    target.search = request.nextUrl.search;
    const headers = new Headers({
      Authorization: `Bearer ${await apiToken(user.sub, user.name, user.authTime)}`,
    });
    for (const name of ['content-type', 'idempotency-key', 'x-request-id']) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
    let body: Uint8Array | undefined;
    if (request.body && !['GET', 'HEAD'].includes(request.method)) {
      const chunks: Uint8Array[] = [];
      let size = 0;
      const reader = request.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBody) {
          await reader.cancel();
          return NextResponse.json(
            { error: { code: 'TOO_LARGE', message: 'Upload exceeds the supported size.' } },
            { status: 413 },
          );
        }
        chunks.push(value);
      }
      body = Buffer.concat(chunks);
    }
    const response = await fetch(target, {
      method: request.method,
      headers,
      body: body as BodyInit | undefined,
      signal: AbortSignal.timeout(30000),
      cache: 'no-store',
      redirect: 'error',
    });
    const responseHeaders = new Headers({
      'Content-Type': response.headers.get('content-type') ?? 'application/json',
      'Cache-Control': 'no-store',
    });
    const contentDisposition = response.headers.get('content-disposition');
    if (contentDisposition) responseHeaders.set('Content-Disposition', contentDisposition);
    return new NextResponse(response.body, { status: response.status, headers: responseHeaders });
  } catch {
    return NextResponse.json(
      {
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: 'The service is unavailable. Your saved work has been preserved.',
        },
      },
      { status: 503 },
    );
  }
}
export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
