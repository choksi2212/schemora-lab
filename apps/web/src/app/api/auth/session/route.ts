import { NextRequest, NextResponse } from 'next/server';
import { identity } from '../../../../auth';

export const runtime = 'nodejs';
export async function GET(request: NextRequest) {
  try {
    const user = await identity(request);
    return NextResponse.json(
      user
        ? { authenticated: true, mode: user.mode, user: { name: user.name } }
        : { authenticated: false },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch {
    return NextResponse.json(
      { error: 'Authentication configuration is unavailable.' },
      { status: 503 },
    );
  }
}
