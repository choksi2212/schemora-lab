import type { ExtractionResult, NormalizedMessage } from '@schemora/contracts';

export type Project = {
  id: string;
  title: string;
  status: 'active' | 'archived' | 'deleting';
  revision: number;
  createdAt: string;
  updatedAt: string;
};
export type ImportRecord = {
  id: string;
  projectId: string;
  filename: string;
  status: 'queued' | 'processing' | 'awaiting_selection' | 'ready' | 'failed' | 'cancelled';
  createdAt: string;
  selectedConversationId: string | null;
  errorCode: string | null;
  conversations: { id: string; title: string; messageCount: number }[];
  extraction: ExtractionResult | null;
  extractionMode: 'deterministic' | 'provider' | null;
  warnings: string[];
};
export type Review = {
  id: string;
  importId: string;
  candidateId: string;
  decision: 'accept' | 'reject' | 'correct' | 'obsolete';
  value: string | null;
  reason: string | null;
  createdAt: string;
  revision: number;
};
export type ProjectDetail = { project: Project; imports: ImportRecord[]; reviews: Review[] };
export type ImportDetail = {
  project: Project;
  import: ImportRecord;
  messages: NormalizedMessage[];
  reviews: Review[];
  nextMessageSequence: number | null;
};
export type Revision = {
  revision: number;
  kind: string;
  createdAt: string;
  digest: string;
  snapshot?: unknown;
};
export type ProjectPage = { items: Project[]; nextCursor: string | null };

export class ApiError extends Error {
  constructor(
    message: string,
    public code: string,
    public status: number,
    public requestId?: string,
    public currentRevision?: number,
  ) {
    super(message);
  }
}

export async function api<T>(
  path: string,
  options?: { method?: string; body?: unknown; signal?: AbortSignal; idempotencyKey?: string },
): Promise<T> {
  const method = options?.method ?? 'GET';
  const response = await fetch(`/api/backend/v1${path}`, {
    method,
    cache: 'no-store',
    credentials: 'same-origin',
    signal: options?.signal,
    headers: {
      ...(options?.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(method !== 'GET'
        ? { 'Idempotency-Key': options?.idempotencyKey ?? crypto.randomUUID() }
        : {}),
    },
    ...(options?.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  if (response.status === 204) return undefined as T;
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error =
      payload && typeof payload === 'object' && 'error' in payload ? payload.error : null;
    const detail =
      error && typeof error === 'object'
        ? (error as {
            message?: string;
            code?: string;
            requestId?: string;
            currentRevision?: number;
          })
        : {};
    throw new ApiError(
      detail.message ??
        (response.status === 401
          ? 'Sign in to access your workspace.'
          : 'This request could not be completed. Please try again.'),
      detail.code ?? 'REQUEST_FAILED',
      response.status,
      detail.requestId,
      detail.currentRevision,
    );
  }
  if (!payload || typeof payload !== 'object' || !('data' in payload))
    throw new ApiError(
      'We received an unexpected response. Please refresh and try again.',
      'INVALID_RESPONSE',
      response.status,
    );
  return payload.data as T;
}

export function friendlyError(error: unknown): string {
  if (error instanceof ApiError && error.status === 409)
    return 'This project changed in another session. Refresh to see the latest revision; your unsaved input has been kept.';
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error && error.message && error.name !== 'TypeError') return error.message;
  return 'Could not reach your workspace. Your input is still here. Check your connection and try again.';
}

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const extensions = ['txt', 'md', 'html', 'pdf', 'json', 'zip'];
export function validateFile(file: Pick<File, 'name' | 'size'>): string | null {
  if (!extensions.includes(file.name.split('.').at(-1)?.toLowerCase() ?? ''))
    return 'Choose a TXT, Markdown, HTML, PDF, JSON, or ZIP conversation export.';
  if (file.size === 0) return 'This file is empty. Choose an export that contains a conversation.';
  if (file.size > MAX_UPLOAD_BYTES)
    return 'This file exceeds 10 MB. Export a smaller conversation and try again.';
  return null;
}

export async function fileBase64(file: File): Promise<string> {
  const buffer = new Uint8Array(await file.arrayBuffer());
  const parts: string[] = [];
  for (let offset = 0; offset < buffer.length; offset += 8192)
    parts.push(String.fromCharCode(...buffer.subarray(offset, offset + 8192)));
  return btoa(parts.join(''));
}

export function when(value: string): string {
  return new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
