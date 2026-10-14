import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(root, 'apps/web/node_modules/monaco-editor/min/vs');
const destination = resolve(root, 'apps/web/public/monaco/vs');

await mkdir(dirname(destination), { recursive: true });
await rm(destination, { recursive: true, force: true });
await cp(source, destination, { recursive: true, force: true });
console.log('Prepared locally served Monaco editor assets.');
