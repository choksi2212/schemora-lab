import {
  claimRunnerReplayToken,
  type RunnerReplayQueryable,
} from '@schemora/persistence/runner-replay';
import type { RunnerCapabilityReplayGuard, RunnerResponseReplayGuard } from './capability.js';

/** PostgreSQL-backed capability replay claims shared by every runner replica. */
export class PostgresRunnerCapabilityReplayGuard implements RunnerCapabilityReplayGuard {
  constructor(
    private readonly database: RunnerReplayQueryable,
    private readonly issuerNamespace: string,
  ) {}

  claim(keyId: string, jti: string, expiresAt: number): Promise<boolean> {
    return claimRunnerReplayToken(this.database, {
      tokenClass: 'capability',
      issuerNamespace: this.issuerNamespace,
      keyId,
      jti,
      expiresAt: new Date(expiresAt),
    });
  }
}

/** PostgreSQL-backed response replay claims shared by every worker/runner replica. */
export class PostgresRunnerResponseReplayGuard implements RunnerResponseReplayGuard {
  constructor(
    private readonly database: RunnerReplayQueryable,
    private readonly issuerNamespace: string,
  ) {}

  claim(keyId: string, responseJti: string, expiresAt: number): Promise<boolean> {
    return claimRunnerReplayToken(this.database, {
      tokenClass: 'response',
      issuerNamespace: this.issuerNamespace,
      keyId,
      jti: responseJti,
      expiresAt: new Date(expiresAt),
    });
  }
}
