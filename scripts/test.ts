import { spawnSync } from 'node:child_process';
import { Repository } from '../packages/persistence/src/index.js';

if (process.env.NODE_ENV === 'production')
  throw new Error('Do not run development tests in production.');
if (!process.env.DATABASE_URL || !process.env.TEST_DATABASE_URL)
  throw new Error(
    'Configure DATABASE_URL and a separate TEST_DATABASE_URL before running the full suite.',
  );
const app = new URL(process.env.DATABASE_URL);
const test = new URL(process.env.TEST_DATABASE_URL);
const name = decodeURIComponent(test.pathname.slice(1));
if (
  !/^[a-z][a-z0-9_]{0,57}_test$/.test(name) ||
  app.pathname === test.pathname ||
  app.host !== test.host ||
  app.username !== test.username
)
  throw new Error(
    'The test database must be separate, end in _test, and use the same local/CI database server and role.',
  );
const repository = new Repository(app.toString(), 1);
try {
  const exists = await repository.pool.query('SELECT 1 FROM pg_database WHERE datname=$1', [name]);
  if (!exists.rowCount) await repository.pool.query(`CREATE DATABASE "${name}"`);
} finally {
  await repository.pool.end();
}
const migration = spawnSync(
  process.execPath,
  ['--import', 'tsx', 'packages/persistence/src/migrate.ts'],
  { stdio: 'inherit', env: { ...process.env, DATABASE_URL: test.toString() } },
);
if (migration.status !== 0) process.exit(migration.status ?? 1);
const suite = spawnSync('pnpm -r --if-present test', {
  shell: true,
  stdio: 'inherit',
  env: { ...process.env, NODE_ENV: 'test' },
});
process.exit(suite.status ?? 1);
