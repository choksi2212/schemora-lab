import { describe, expect, it, vi } from 'vitest';
import { createRunnerTransport, readBoundedRunnerResponseBody } from '../src/transport.js';

describe('runner HTTP transport seam', () => {
  it('stops reading an oversized chunked response and cancels the stream', async () => {
    let cancelled = false;
    let chunksEnqueued = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        chunksEnqueued += 1;
        controller.enqueue(new Uint8Array(4));
        if (chunksEnqueued === 3) controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    const response = new Response(body, { headers: { 'content-type': 'application/json' } });

    expect(await readBoundedRunnerResponseBody(response, 6)).toEqual({ ok: false });
    expect(cancelled).toBe(true);
    expect(chunksEnqueued).toBe(2);
  });

  it('returns the bytes for an in-budget streamed response', async () => {
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2]));
          controller.enqueue(new Uint8Array([3]));
          controller.close();
        },
      }),
    );

    expect(await readBoundedRunnerResponseBody(response, 3)).toEqual({
      ok: true,
      bytes: new Uint8Array([1, 2, 3]),
    });
  });

  it('is inert unless explicitly enabled', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const transport = createRunnerTransport({
      endpoint: 'https://runner.example/execute',
      fetchImpl,
    });

    expect(await transport.send({})).toEqual({ ok: false, reason: 'disabled' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects non-HTTPS or credential-bearing endpoints before any request', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    for (const endpoint of [
      'http://runner.example/execute',
      'https://user:secret@runner.example/execute',
      'not a URL',
    ]) {
      const transport = createRunnerTransport({ enabled: true, endpoint, fetchImpl });
      expect(await transport.send({})).toEqual({ ok: false, reason: 'invalid_endpoint' });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does not send malformed protocol requests', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const transport = createRunnerTransport({
      enabled: true,
      endpoint: 'https://runner.example/execute',
      fetchImpl,
    });

    expect(await transport.send({ protocolVersion: 'unsupported' })).toEqual({
      ok: false,
      reason: 'invalid_request',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('requires safe timeout and response bounds', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const transport = createRunnerTransport({
      enabled: true,
      endpoint: 'https://runner.example/execute',
      timeoutMs: 1,
      fetchImpl,
    });

    expect(await transport.send({})).toEqual({ ok: false, reason: 'invalid_endpoint' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
