import { describe, expect, it } from 'vitest';
import type { RunnerReplayQueryable } from '@schemora/persistence/runner-replay';
import {
  PostgresRunnerCapabilityReplayGuard,
  PostgresRunnerResponseReplayGuard,
} from '../src/replay-guard.js';

describe('PostgreSQL runner replay guard adapters', () => {
  it('separates request capabilities and response receipts in shared storage', async () => {
    const claims: unknown[][] = [];
    const database = {
      query: async (_text: string, values?: unknown[]) => {
        claims.push(values ?? []);
        return { rows: [{ claimed: true }], rowCount: 1 };
      },
    } as RunnerReplayQueryable;
    const expiresAt = Date.parse('2026-10-14T12:00:00.000Z');

    expect(
      await new PostgresRunnerCapabilityReplayGuard(database, 'runner-prod').claim(
        'runner-key-1',
        'capability-jti',
        expiresAt,
      ),
    ).toBe(true);
    expect(
      await new PostgresRunnerResponseReplayGuard(database, 'worker-prod').claim(
        'response-key-1',
        'response-jti',
        expiresAt,
      ),
    ).toBe(true);

    expect(claims.map((claim) => claim.slice(0, 4))).toEqual([
      ['capability', 'runner-prod', 'runner-key-1', 'capability-jti'],
      ['response', 'worker-prod', 'response-key-1', 'response-jti'],
    ]);
    expect(claims[0]?.[4]).toBe(new Date(expiresAt).toISOString());
  });
});
