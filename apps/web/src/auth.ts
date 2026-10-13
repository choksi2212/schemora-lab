import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import type { NextRequest } from 'next/server';

export const sessionCookie = 'schemora_session';
export const flowCookie = 'schemora_oauth';
export const cookieOptions = {
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: process.env.NODE_ENV === 'production',
  path: '/',
};
export function secret(name: 'AUTH_SECRET' | 'SESSION_SECRET') {
  const value = process.env[name];
  if (
    !value ||
    value.length < 32 ||
    (process.env.NODE_ENV === 'production' && value.startsWith('local-'))
  ) {
    throw new Error(
      `${name} must contain at least 32 characters and use a private production value.`,
    );
  }
  return new TextEncoder().encode(value);
}
export function webOrigin() {
  const origin = new URL(process.env.WEB_ORIGIN ?? 'http://localhost:3000');
  if (process.env.NODE_ENV === 'production' && origin.protocol !== 'https:') {
    throw new Error('WEB_ORIGIN must use HTTPS in production.');
  }
  return origin.origin;
}
export function developmentIdentity(request: NextRequest) {
  if (process.env.DEV_AUTH !== 'true') return false;
  if (process.env.NODE_ENV === 'production')
    throw new Error('DEV_AUTH is forbidden in production.');
  return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(request.url).hostname);
}
export async function identity(request: NextRequest) {
  if (developmentIdentity(request))
    return { sub: 'dev:local', name: 'Local developer', mode: 'development' as const };
  const token = request.cookies.get(sessionCookie)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret('AUTH_SECRET'), {
      algorithms: ['HS256'],
      issuer: 'schemora-auth',
      audience: 'schemora-browser',
    });
    if (!payload.sub?.startsWith('github:') || typeof payload.name !== 'string') return null;
    return { sub: payload.sub, name: payload.name, mode: 'github' as const };
  } catch {
    return null;
  }
}
export function newFlow() {
  const state = randomBytes(32).toString('base64url');
  const verifier = randomBytes(48).toString('base64url');
  return { state, verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}
export function sameState(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
export async function signSession(sub: string, name: string) {
  return new SignJWT({ name })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(sub)
    .setIssuer('schemora-auth')
    .setAudience('schemora-browser')
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(secret('AUTH_SECRET'));
}
export async function apiToken(sub: string) {
  return new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(sub)
    .setIssuer('schemora-web')
    .setAudience('schemora-api')
    .setIssuedAt()
    .setExpirationTime('2m')
    .sign(secret('SESSION_SECRET'));
}
export function validWriteOrigin(request: NextRequest) {
  const origin = request.headers.get('origin');
  return origin !== null && origin === webOrigin();
}
