'use client';
import { AlertCircle, Check, LoaderCircle } from 'lucide-react';
import { ApiError, friendlyError } from '@/lib/api';

export function ErrorNotice({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  if (!error) return null;
  return (
    <div className="error-notice" role="alert">
      <AlertCircle size={18} />
      <div>
        <p>{friendlyError(error)}</p>
        {error instanceof ApiError && error.requestId && (
          <span className="fine-text">Reference: {error.requestId}</span>
        )}
        {error instanceof ApiError && error.status === 401 ? (
          <a className="text-button" href="/api/auth/signin">
            Sign in to continue →
          </a>
        ) : (
          onRetry && (
            <button className="text-button" onClick={onRetry}>
              {error instanceof ApiError && error.status === 409
                ? 'Refresh latest revision'
                : 'Try again'}
            </button>
          )
        )}
      </div>
    </div>
  );
}
export function SaveState({ busy, saved }: { busy: boolean; saved?: boolean }) {
  return (
    <span className="save-state" role="status">
      {busy ? (
        <>
          <LoaderCircle size={14} className="spin" /> Saving…
        </>
      ) : saved ? (
        <>
          <Check size={14} /> Saved to workspace
        </>
      ) : (
        <>No pending changes</>
      )}
    </span>
  );
}
export function Loading({ label = 'Loading your workspace…' }: { label?: string }) {
  return (
    <div className="loading-state" role="status">
      <LoaderCircle className="spin" size={22} />
      {label}
    </div>
  );
}
