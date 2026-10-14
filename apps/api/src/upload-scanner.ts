import { createConnection, type Socket } from 'node:net';

export type UploadScanner = {
  scan: (bytes: Uint8Array) => Promise<'clean' | 'infected'>;
  ready: () => Promise<boolean>;
};

export class UploadScannerUnavailableError extends Error {
  constructor() {
    super('Upload scanning is temporarily unavailable.');
    this.name = 'UploadScannerUnavailableError';
  }
}

function command(host: string, port: number, payload: Buffer, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let response = Buffer.alloc(0);
    let settled = false;
    const socket: Socket = createConnection({ host, port });
    const timeout = setTimeout(() => finish(new UploadScannerUnavailableError()), timeoutMs);
    const finish = (error?: Error, result?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      if (error) reject(error);
      else resolve(result!);
    };
    socket.setTimeout(timeoutMs, () => finish(new UploadScannerUnavailableError()));
    socket.once('error', () => finish(new UploadScannerUnavailableError()));
    socket.once('close', () => {
      if (!settled) finish(new UploadScannerUnavailableError());
    });
    socket.on('data', (chunk: Buffer) => {
      response = Buffer.concat([response, chunk]);
      if (response.length > 4096) return finish(new UploadScannerUnavailableError());
      const end = response.indexOf(0);
      if (end >= 0) finish(undefined, response.subarray(0, end).toString('utf8'));
    });
    socket.once('connect', () => {
      if (payload.length === 0) {
        socket.end(Buffer.from('zPING\0'));
        return;
      }
      socket.write(Buffer.from('zINSTREAM\0'));
      for (let offset = 0; offset < payload.length; offset += 64 * 1024) {
        const chunk = payload.subarray(offset, Math.min(offset + 64 * 1024, payload.length));
        const size = Buffer.allocUnsafe(4);
        size.writeUInt32BE(chunk.length);
        socket.write(size);
        socket.write(chunk);
      }
      const end = Buffer.alloc(4);
      socket.end(end);
    });
  });
}

/** Uses ClamD's INSTREAM protocol. The TCP endpoint must stay on a private trusted network. */
export function createClamdUploadScanner(
  host: string,
  port: number,
  timeoutMs = 15_000,
): UploadScanner {
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('Invalid malware scanner endpoint');
  return {
    async ready() {
      try {
        return (await command(host, port, Buffer.alloc(0), Math.min(timeoutMs, 2_000))) === 'PONG';
      } catch {
        return false;
      }
    },
    async scan(bytes) {
      let result: string;
      try {
        result = await command(host, port, Buffer.from(bytes), timeoutMs);
      } catch {
        throw new UploadScannerUnavailableError();
      }
      if (result.endsWith(' OK')) return 'clean';
      if (result.includes(' FOUND')) return 'infected';
      throw new UploadScannerUnavailableError();
    },
  };
}

export const localUploadScanner: UploadScanner = {
  scan: async () => 'clean',
  ready: async () => true,
};
