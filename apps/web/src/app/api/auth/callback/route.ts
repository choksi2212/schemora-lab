import { jwtVerify } from 'jose';
import { NextRequest, NextResponse } from 'next/server';
import {
  cookieOptions,
  flowCookie,
  sameState,
  secret,
  sessionCookie,
  signSession,
  webOrigin,
} from '../../../../auth';

export const runtime = 'nodejs';
export async function GET(request: NextRequest) {
  try {
    const code = request.nextUrl.searchParams.get('code');
    const state = request.nextUrl.searchParams.get('state');
    const flow = request.cookies.get(flowCookie)?.value;
    if (!code || !state || !flow) throw new Error('Missing authorization response.');
    const { payload } = await jwtVerify(flow, secret('AUTH_SECRET'), {
      algorithms: ['HS256'],
      issuer: 'schemora-oauth',
      audience: 'github',
    });
    if (
      typeof payload.state !== 'string' ||
      typeof payload.verifier !== 'string' ||
      !sameState(state, payload.state)
    )
      throw new Error('Invalid authorization state.');
    const clientId = process.env.AUTH_GITHUB_ID;
    const clientSecret = process.env.AUTH_GITHUB_SECRET;
    if (!clientId || !clientSecret) throw new Error('Missing OAuth configuration.');
    const exchanged = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: `${webOrigin()}/api/auth/callback`,
        code_verifier: payload.verifier,
      }),
      signal: AbortSignal.timeout(15000),
      cache: 'no-store',
    });
    const tokens = (await exchanged.json()) as { access_token?: string };
    if (!exchanged.ok || !tokens.access_token) throw new Error('Authorization exchange failed.');
    const profile = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
        Accept: 'application/vnd.github+json',
      },
      signal: AbortSignal.timeout(15000),
      cache: 'no-store',
    });
    const user = (await profile.json()) as { id?: number; login?: string };
    if (
      !profile.ok ||
      !Number.isSafeInteger(user.id) ||
      typeof user.login !== 'string' ||
      !/^[A-Za-z0-9-]{1,39}$/.test(user.login)
    )
      throw new Error('Identity lookup failed.');
    const returnTo =
      typeof payload.returnTo === 'string' &&
      payload.returnTo.startsWith('/') &&
      !payload.returnTo.startsWith('//') &&
      !payload.returnTo.includes('\\')
        ? payload.returnTo
        : '/';
    const response = NextResponse.redirect(new URL(returnTo, webOrigin()));
    response.cookies.set(sessionCookie, await signSession(`github:${user.id}`, user.login), {
      ...cookieOptions,
      maxAge: 3600,
    });
    response.cookies.set(flowCookie, '', { ...cookieOptions, maxAge: 0 });
    return response;
  } catch {
    const response = NextResponse.json(
      { error: 'Sign-in could not be completed. Start sign-in again.' },
      { status: 400 },
    );
    response.cookies.set(flowCookie, '', { ...cookieOptions, maxAge: 0 });
    return response;
  }
}
