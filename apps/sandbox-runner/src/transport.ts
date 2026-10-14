import {
  MAX_RUNNER_REQUEST_BYTES,
  runnerAuthenticatedResponseSchema,
  runnerExecutionRequestSchema,
  type RunnerAuthenticatedResponse,
  type RunnerExecutionRequest,
} from '@schemora/simulation';

/**
 * Disabled-by-default HTTP seam for a future separately deployed runner.
 * This module transports protocol messages only: it does not admit, execute,
 * or sign work, and no worker currently invokes it.
 */
export const MAX_RUNNER_TRANSPORT_RESPONSE_BYTES = 16_000_000;
export const DEFAULT_RUNNER_TRANSPORT_TIMEOUT_MS = 10_000;

export type RunnerTransportFailure =
  | 'disabled'
  | 'invalid_endpoint'
  | 'invalid_request'
  | 'request_too_large'
  | 'timeout'
  | 'network_error'
  | 'http_error'
  | 'invalid_content_type'
  | 'response_too_large'
  | 'invalid_response';

export type RunnerTransportResult =
  | { ok: true; response: RunnerAuthenticatedResponse }
  | { ok: false; reason: RunnerTransportFailure };

export type RunnerTransport = {
  send(request: unknown): Promise<RunnerTransportResult>;
};

export type RunnerTransportOptions = {
  /** Must be set explicitly; absent/false never makes a network request. */
  enabled?: boolean;
  endpoint?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  fetchImpl?: typeof fetch;
};

/** Read a response incrementally, cancelling as soon as its byte budget is exceeded. */
export async function readBoundedRunnerResponseBody(
  response: Response,
  maxBytes: number,
): Promise<{ ok: true; bytes: Uint8Array } | { ok: false }> {
  if (!response.body) return { ok: true, bytes: new Uint8Array() };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel('runner response exceeds configured byte limit').catch(() => undefined);
        return { ok: false };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes };
}

function safeEndpoint(value: string | undefined): URL | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.hash)
      return null;
    return url;
  } catch {
    return null;
  }
}

/** Create an HTTPS-only, bounded transport. It remains inert unless enabled is true. */
export function createRunnerTransport(options: RunnerTransportOptions = {}): RunnerTransport {
  const enabled = options.enabled === true;
  const endpoint = enabled ? safeEndpoint(options.endpoint) : null;
  const timeoutMs = options.timeoutMs ?? DEFAULT_RUNNER_TRANSPORT_TIMEOUT_MS;
  const maxResponseBytes = options.maxResponseBytes ?? MAX_RUNNER_TRANSPORT_RESPONSE_BYTES;
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    async send(requestInput) {
      if (!enabled) return { ok: false, reason: 'disabled' };
      if (!endpoint) return { ok: false, reason: 'invalid_endpoint' };
      if (
        !Number.isInteger(timeoutMs) ||
        timeoutMs < 100 ||
        timeoutMs > 120_000 ||
        !Number.isInteger(maxResponseBytes) ||
        maxResponseBytes < 1_024 ||
        maxResponseBytes > MAX_RUNNER_TRANSPORT_RESPONSE_BYTES
      )
        return { ok: false, reason: 'invalid_endpoint' };

      const parsed = runnerExecutionRequestSchema.safeParse(requestInput);
      if (!parsed.success) return { ok: false, reason: 'invalid_request' };
      const body = JSON.stringify(parsed.data);
      if (new TextEncoder().encode(body).byteLength > MAX_RUNNER_REQUEST_BYTES)
        return { ok: false, reason: 'request_too_large' };

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body,
          signal: controller.signal,
          redirect: 'error',
          credentials: 'omit',
          cache: 'no-store',
        });
        if (!response.ok) return { ok: false, reason: 'http_error' };
        const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim();
        if (contentType !== 'application/json')
          return { ok: false, reason: 'invalid_content_type' };
        const declaredLength = response.headers.get('content-length');
        if (declaredLength !== null && Number(declaredLength) > maxResponseBytes)
          return { ok: false, reason: 'response_too_large' };
        const bodyResult = await readBoundedRunnerResponseBody(response, maxResponseBytes);
        if (!bodyResult.ok) return { ok: false, reason: 'response_too_large' };
        const bytes = bodyResult.bytes;
        let value: unknown;
        try {
          value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        } catch {
          return { ok: false, reason: 'invalid_response' };
        }
        const authenticated = runnerAuthenticatedResponseSchema.safeParse(value);
        if (!authenticated.success) return { ok: false, reason: 'invalid_response' };
        return { ok: true, response: authenticated.data };
      } catch (error) {
        return {
          ok: false,
          reason:
            controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')
              ? 'timeout'
              : 'network_error',
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
