import { spawn, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';

process.env.STORAGE_DIRECTORY = resolve(process.env.STORAGE_DIRECTORY ?? '.schemora/objects');
process.env.PORT = new URL(process.env.WEB_ORIGIN ?? 'http://localhost:3010').port || '3010';

const require = createRequire(import.meta.url);
const monacoAssets = spawnSync(process.execPath, [resolve('scripts/copy-monaco.mjs')], {
  stdio: 'inherit',
});
if (monacoAssets.status !== 0) process.exit(monacoAssets.status ?? 1);
const watch = process.env.SCHEMORA_WATCH !== 'false';
const runnerArgs = (file) =>
  watch ? ['watch', '--exclude', '**/.schemora/**', '--exclude', '**/.next/**', file] : [file];
const commands = [
  { directory: 'apps/api', cli: 'tsx/cli', args: runnerArgs('src/server.ts') },
  { directory: 'apps/worker', cli: 'tsx/cli', args: runnerArgs('src/main.ts') },
  {
    directory: 'apps/web',
    cli: 'next/dist/bin/next',
    args: ['dev', '--webpack', '--hostname', '127.0.0.1'],
  },
];
const children = commands.map(({ directory, cli, args }) => {
  const cwd = resolve(directory);
  return spawn(process.execPath, [require.resolve(cli, { paths: [cwd] }), ...args], {
    cwd,
    stdio: 'inherit',
    env: process.env,
  });
});
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (process.platform === 'win32' && child.pid) {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else child.kill('SIGTERM');
  }
  process.exitCode = code;
}
children.forEach((child) => {
  child.on('error', (error) => {
    console.error(error.message);
    stop(1);
  });
  child.on('exit', (code) => {
    if (!stopping) stop(code ?? 1);
  });
});
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
