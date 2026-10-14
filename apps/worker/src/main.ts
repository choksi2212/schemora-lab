import { z } from 'zod';
import { setTimeout as delay } from 'node:timers/promises';
import { Repository } from '@schemora/persistence';
import { FileStorage, S3Storage } from '@schemora/storage';
import { parseFirmwareBuildAttestationPublicKeysJson } from '@schemora/persistence';
import { Worker } from './runner.js';
import { parseFirmwareCompilerProfileRegistryJson } from './firmware-compiler-profiles.js';

const parsed = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    DATABASE_URL: z.string().url(),
    STORAGE_DRIVER: z.enum(['filesystem', 's3']).default('filesystem'),
    STORAGE_DIRECTORY: z.string().default('.private-sources'),
    S3_BUCKET: z.string().optional(),
    AWS_REGION: z.string().optional(),
    EXTRACTION_MODE: z.enum(['rules', 'provider']).default('rules'),
    EXTRACTION_ENDPOINT: z.string().url().optional(),
    EXTRACTION_API_KEY: z.string().optional(),
    EXTRACTION_MODEL: z.string().optional(),
    PROVIDER_REVIEW_APPROVED: z.enum(['true', 'false']).default('false'),
    VISION_RECOGNITION_MODE: z.enum(['disabled', 'vultr']).default('disabled'),
    VISION_RECOGNITION_APPROVED: z.enum(['true', 'false']).default('false'),
    VISION_PROVIDER_ENDPOINT: z.string().url().optional(),
    VISION_PROVIDER_API_KEY: z.string().optional(),
    VISION_PROVIDER_MODEL: z.string().optional(),
    WORKER_POLL_MS: z.coerce.number().int().min(100).max(30_000).default(1000),
    WORKER_LEASE_SECONDS: z.coerce.number().int().min(120).max(600).default(120),
    WORKER_PROCESS_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(1),
    WORKER_DELETE_CONCURRENCY: z.coerce.number().int().min(1).max(4).default(1),
    WORKER_SIMULATION_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(1),
    WORKER_VISION_CONCURRENCY: z.coerce.number().int().min(1).max(2).default(1),
    WORKER_FIRMWARE_COMPILER_PROFILES_JSON: z.string().max(65_536).default('[]'),
    WORKER_FIRMWARE_BUILD_ATTESTATION_PUBLIC_KEYS_JSON: z.string().max(65_536).default('{}'),
    DATABASE_POOL_SIZE: z.coerce.number().int().min(1).max(50).default(10),
    JOB_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  })
  .safeParse(process.env);
if (!parsed.success)
  throw new Error(
    'Invalid worker configuration: ' +
      parsed.error.issues.map((issue) => issue.path.join('.')).join(', '),
  );
const config = parsed.data;
let firmwareCompilerProfiles;
let firmwareBuildAttestationPublicKeys;
try {
  firmwareCompilerProfiles = parseFirmwareCompilerProfileRegistryJson(
    config.WORKER_FIRMWARE_COMPILER_PROFILES_JSON,
  );
  firmwareBuildAttestationPublicKeys = parseFirmwareBuildAttestationPublicKeysJson(
    config.WORKER_FIRMWARE_BUILD_ATTESTATION_PUBLIC_KEYS_JSON,
  );
} catch {
  throw new Error('Invalid worker firmware compiler configuration');
}
if (
  config.NODE_ENV === 'production' &&
  new URL(config.DATABASE_URL).searchParams.get('sslmode') !== 'verify-full'
)
  throw new Error('Production database requires sslmode=verify-full');
if (
  config.NODE_ENV === 'production' &&
  firmwareCompilerProfiles.size > 0 &&
  Object.keys(firmwareBuildAttestationPublicKeys).length === 0
)
  throw new Error('Production compiler profiles require firmware build attestation keys');
if (config.NODE_ENV === 'production' && config.STORAGE_DRIVER !== 's3')
  throw new Error('Production requires private S3 storage');
if (config.STORAGE_DRIVER === 's3' && (!config.S3_BUCKET || !config.AWS_REGION))
  throw new Error('S3 configuration missing');
if (
  config.EXTRACTION_MODE === 'provider' &&
  (!config.EXTRACTION_ENDPOINT ||
    !config.EXTRACTION_API_KEY ||
    !config.EXTRACTION_MODEL ||
    config.PROVIDER_REVIEW_APPROVED !== 'true')
)
  throw new Error('Provider requires reviewed configuration and explicit approval flag');
if (
  config.VISION_RECOGNITION_MODE === 'vultr' &&
  (config.VISION_RECOGNITION_APPROVED !== 'true' ||
    config.VISION_PROVIDER_ENDPOINT !== 'https://api.vultrinference.com/v1/chat/completions' ||
    !config.VISION_PROVIDER_API_KEY ||
    config.VISION_PROVIDER_MODEL !== 'qwen3.8-27b')
)
  throw new Error('Vision recognition requires reviewed Vultr configuration and explicit approval');
const repository = new Repository(
  config.DATABASE_URL,
  config.DATABASE_POOL_SIZE,
  config.JOB_MAX_ATTEMPTS,
  firmwareBuildAttestationPublicKeys,
);
const storage =
  config.STORAGE_DRIVER === 's3'
    ? new S3Storage(config.S3_BUCKET!, config.AWS_REGION!)
    : new FileStorage(config.STORAGE_DIRECTORY, config.NODE_ENV);
const worker = new Worker(
  repository,
  storage,
  {
    mode: config.EXTRACTION_MODE,
    endpoint: config.EXTRACTION_ENDPOINT,
    apiKey: config.EXTRACTION_API_KEY,
    model: config.EXTRACTION_MODEL,
  },
  config.WORKER_LEASE_SECONDS,
  firmwareCompilerProfiles,
  config.VISION_RECOGNITION_MODE === 'vultr'
    ? {
        endpoint: config.VISION_PROVIDER_ENDPOINT!,
        apiKey: config.VISION_PROVIDER_API_KEY!,
        model: config.VISION_PROVIDER_MODEL!,
      }
    : undefined,
);
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => {
    stopping = true;
  });
async function loop(
  kind:
    | 'process_import'
    | 'delete_project'
    | 'simulate_run'
    | 'delete_hardware_photo'
    | 'process_hardware_recognition',
) {
  while (!stopping) {
    try {
      if (!(await worker.tick(kind))) await delay(config.WORKER_POLL_MS);
    } catch {
      console.error(JSON.stringify({ event: 'worker_unavailable', kind }));
      await delay(config.WORKER_POLL_MS);
    }
  }
}
await Promise.all([
  ...Array.from({ length: config.WORKER_PROCESS_CONCURRENCY }, () => loop('process_import')),
  ...Array.from({ length: config.WORKER_DELETE_CONCURRENCY }, () => loop('delete_project')),
  ...Array.from({ length: config.WORKER_DELETE_CONCURRENCY }, () => loop('delete_hardware_photo')),
  ...Array.from({ length: config.WORKER_SIMULATION_CONCURRENCY }, () => loop('simulate_run')),
  ...Array.from({ length: config.WORKER_VISION_CONCURRENCY }, () =>
    loop('process_hardware_recognition'),
  ),
]);
await repository.pool.end();
