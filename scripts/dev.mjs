import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

process.env.STORAGE_DIRECTORY = resolve(process.env.STORAGE_DIRECTORY ?? '.schemora/objects');

const commands = [
  ['@schemora/api', 'dev'],
  ['@schemora/worker', 'dev'],
  ['@schemora/web', 'dev'],
];
const children = commands.map(([name, script]) =>
  spawn(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['--filter', name, script], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: process.env,
  }),
);
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
  child.on('error', (error) => { console.error(error.message); stop(1); });
  child.on('exit', (code) => { if (!stopping) stop(code ?? 1); });
});
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
