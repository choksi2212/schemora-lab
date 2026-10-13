import { NextRequest, NextResponse } from 'next/server';
import { cookieOptions, sessionCookie, validWriteOrigin } from '../../../../auth';
export async function POST(request: NextRequest) {
  if (!validWriteOrigin(request))
    return NextResponse.json({ error: 'Invalid request origin.' }, { status: 403 });
  const response = NextResponse.json({ signedOut: true });
  response.cookies.set(sessionCookie, '', { ...cookieOptions, maxAge: 0 });
  return response;
}
