import { Repository } from '@schemora/persistence';
import { buildApp } from './app.js';
import { configuredStorage, configuredUploadScanner, readConfig } from './config.js';

const config = readConfig();
const repository = new Repository(config.DATABASE_URL, config.DATABASE_POOL_SIZE);
const app = buildApp(
  config,
  repository,
  configuredStorage(config),
  configuredUploadScanner(config),
);
await app.listen({ host: config.API_HOST, port: config.API_PORT });
console.log('Schemora API listening on configured interface');
for (const signal of ['SIGTERM', 'SIGINT'])
  process.once(signal, async () => {
    await app.close();
    await repository.pool.end();
  });
