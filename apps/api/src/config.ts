import { z } from 'zod';
import { FileStorage, S3Storage } from '@schemora/storage';
import { createClamdUploadScanner, localUploadScanner } from './upload-scanner.js';

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
  MALWARE_SCANNER_MODE: z.enum(['disabled', 'clamd']).default('disabled'),
  CLAMD_HOST: z.string().min(1).max(255).optional(),
  CLAMD_PORT: z.coerce.number().int().min(1).max(65535).default(3310),
  VISION_RECOGNITION_ENABLED: z.enum(['true', 'false']).default('false'),
  VISION_RECOGNITION_APPROVED: z.enum(['true', 'false']).default('false'),
  VISION_RECOGNITION_NOTICE_REVISION: z
    .string()
    .min(1)
    .max(64)
    .default('vultr-qwen3.8-27b-notice-v1'),
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
  if (config.VISION_RECOGNITION_ENABLED === 'true' && config.VISION_RECOGNITION_APPROVED !== 'true')
    throw new Error('Vision recognition requires explicit API-side approval');
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
  if (config.NODE_ENV === 'production' && config.MALWARE_SCANNER_MODE !== 'clamd')
    throw new Error('Production requires an enabled malware scanner');
  if (config.MALWARE_SCANNER_MODE === 'clamd' && !config.CLAMD_HOST)
    throw new Error('ClamAV scanner host is required');
  if (config.STORAGE_DRIVER === 's3' && (!config.S3_BUCKET || !config.AWS_REGION))
    throw new Error('S3 configuration missing');
  return config;
}
export function configuredStorage(config: ApiConfig) {
  return config.STORAGE_DRIVER === 's3'
    ? new S3Storage(config.S3_BUCKET!, config.AWS_REGION!)
    : new FileStorage(config.STORAGE_DIRECTORY, config.NODE_ENV);
}

export function configuredUploadScanner(config: ApiConfig) {
  if (config.MALWARE_SCANNER_MODE === 'clamd') {
    return createClamdUploadScanner(config.CLAMD_HOST!, config.CLAMD_PORT);
  }
  return localUploadScanner;
}
