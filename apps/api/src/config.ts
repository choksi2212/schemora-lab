import { z } from 'zod';
import { FileStorage, S3Storage } from '@schemora/storage';

const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().url(),
  SESSION_SECRET: z.string().min(32),
  STORAGE_DRIVER: z.enum(['filesystem', 's3']).default('filesystem'),
  STORAGE_DIRECTORY: z.string().default('.private-sources'),
  S3_BUCKET: z.string().optional(),
  AWS_REGION: z.string().optional(),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4001),
  API_HOST: z.string().default('127.0.0.1'),
  WEB_ORIGIN: z.string().url().default('http://localhost:3000'),
  DATABASE_POOL_SIZE: z.coerce.number().int().min(1).max(50).default(10),
});
export type ApiConfig = z.infer<typeof configSchema>;
export function readConfig(environment: NodeJS.ProcessEnv = process.env): ApiConfig {
  const parsed = configSchema.safeParse(environment);
  if (!parsed.success)
    throw new Error(
      'Invalid service configuration: ' +
        parsed.error.issues.map((issue) => issue.path.join('.')).join(', '),
    );
  const config = parsed.data;
  if (config.NODE_ENV === 'production') {
    if (/local|example|changeme|development/i.test(config.SESSION_SECRET))
      throw new Error('Production session secret must be generated independently');
    if (new URL(config.DATABASE_URL).searchParams.get('sslmode') !== 'verify-full')
      throw new Error('Production database requires sslmode=verify-full');
    if (new URL(config.WEB_ORIGIN).protocol !== 'https:')
      throw new Error('Production web origin requires HTTPS');
  }
  if (config.NODE_ENV === 'production' && config.STORAGE_DRIVER !== 's3')
    throw new Error('Production requires private S3 storage');
  if (config.STORAGE_DRIVER === 's3' && (!config.S3_BUCKET || !config.AWS_REGION))
    throw new Error('S3 configuration missing');
  return config;
}
export function configuredStorage(config: ApiConfig) {
  return config.STORAGE_DRIVER === 's3'
    ? new S3Storage(config.S3_BUCKET!, config.AWS_REGION!)
    : new FileStorage(config.STORAGE_DIRECTORY, config.NODE_ENV);
}
