import { createServer, type Server } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createClamdUploadScanner, UploadScannerUnavailableError } from '../src/upload-scanner.js';

const servers: Server[] = [];
async function listen(reply?: string): Promise<{ host: string; port: number }> {
  const server = createServer((socket) => {
    socket.on('data', () => {});
    socket.on('end', () => {
      if (reply !== undefined) socket.end(Buffer.from(reply + '\0'));
      else socket.destroy();
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Test scanner did not bind a TCP port');
  return { host: '127.0.0.1', port: address.port };
}

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

describe('ClamD upload scanner', () => {
  it('streams bytes using INSTREAM and accepts only an OK response', async () => {
    const endpoint = await listen('stream: OK');
    const scanner = createClamdUploadScanner(endpoint.host, endpoint.port);
    expect(await scanner.scan(Buffer.from('safe upload'))).toBe('clean');
  });

  it('rejects a detected signature without exposing its name', async () => {
    const endpoint = await listen('stream: Eicar-Test-Signature FOUND');
    const scanner = createClamdUploadScanner(endpoint.host, endpoint.port);
    expect(await scanner.scan(Buffer.from('test'))).toBe('infected');
  });

  it('fails closed on a scanner protocol error', async () => {
    const endpoint = await listen('stream: ERROR');
    const scanner = createClamdUploadScanner(endpoint.host, endpoint.port, 200);
    await expect(scanner.scan(Buffer.from('test'))).rejects.toBeInstanceOf(
      UploadScannerUnavailableError,
    );
  });

  it('uses PING for readiness', async () => {
    const endpoint = await listen('PONG');
    expect(await createClamdUploadScanner(endpoint.host, endpoint.port).ready()).toBe(true);
  });
});
