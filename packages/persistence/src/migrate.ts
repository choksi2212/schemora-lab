import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
const client = await pool.connect();
try {
  await client.query("SELECT pg_advisory_lock(hashtext('schemora_migrations'))");
  await client.query(
    'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, digest text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())',
  );
  const directory = fileURLToPath(new URL('../migrations/', import.meta.url));
  for (const name of (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort()) {
    const source = await readFile(
      fileURLToPath(new URL('../migrations/' + name, import.meta.url)),
      'utf8',
    );
    const digest = createHash('sha256').update(source).digest('hex');
    const existing = await client.query<{ digest: string }>(
      'SELECT digest FROM schema_migrations WHERE name=$1',
      [name],
    );
    if (existing.rows[0]) {
      if (existing.rows[0].digest !== digest)
        throw new Error('Applied migration was edited: ' + name);
      continue;
    }
    await client.query('BEGIN');
    try {
      await client.query(source);
      await client.query('INSERT INTO schema_migrations(name,digest) VALUES($1,$2)', [
        name,
        digest,
      ]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
    console.log('Applied ' + name);
  }
} finally {
  await client.query("SELECT pg_advisory_unlock(hashtext('schemora_migrations'))");
  client.release();
  await pool.end();
}
