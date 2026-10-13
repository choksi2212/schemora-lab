import { SignJWT } from 'jose';
import { NextRequest, NextResponse } from 'next/server';
import {
  cookieOptions,
  developmentIdentity,
  flowCookie,
  newFlow,
  secret,
  webOrigin,
} from '../../../../auth';

export const runtime = 'nodejs';
export async function GET(request: NextRequest) {
  try {
    if (developmentIdentity(request)) return NextResponse.redirect(new URL('/', webOrigin()));
    const clientId = process.env.AUTH_GITHUB_ID;
    if (!clientId || !process.env.AUTH_GITHUB_SECRET)
      return NextResponse.json({ error: 'GitHub sign-in is not configured.' }, { status: 503 });
    const flow = newFlow();
    const token = await new SignJWT({ state: flow.state, verifier: flow.verifier })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('schemora-oauth')
      .setAudience('github')
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(secret('AUTH_SECRET'));
    const target = new URL('https://github.com/login/oauth/authorize');
    target.search = new URLSearchParams({
      client_id: clientId,
      redirect_uri: `${webOrigin()}/api/auth/callback`,
      state: flow.state,
      code_challenge: flow.challenge,
      code_challenge_method: 'S256',
    }).toString();
    const response = NextResponse.redirect(target);
    response.cookies.set(flowCookie, token, { ...cookieOptions, maxAge: 600 });
    return response;
  } catch {
    return NextResponse.json({ error: 'Sign-in configuration is unavailable.' }, { status: 503 });
  }
}
