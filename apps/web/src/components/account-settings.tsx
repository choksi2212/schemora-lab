'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

type Account = {
  provider: string;
  providerAccountId: string;
  displayName: string | null;
  status: 'active' | 'closing' | 'closed';
  createdAt: string;
  deletionRequestedAt: string | null;
  closedAt: string | null;
  activeProjectCount: number;
  pendingProjectDeletionCount: number;
  pendingUploadCleanupCount: number;
  proposedBackupRetentionDays: number;
};

export function AccountSettings() {
  const router = useRouter();
  const [account, setAccount] = useState<Account | null>(null);
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [recentSignIn, setRecentSignIn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void fetch('/api/auth/session', { signal: controller.signal, cache: 'no-store' })
      .then(async (response) => {
        const session = (await response.json()) as {
          authenticated?: boolean;
          authTime?: number;
          user?: { name?: string };
        };
        if (!session.authenticated) {
          setError('Sign in with GitHub to view account settings.');
          return;
        }
        setRecentSignIn(
          typeof session.authTime === 'number' &&
            Math.floor(Date.now() / 1000) - session.authTime <= 300,
        );
        const accountResponse = await fetch('/api/backend/v1/account', {
          signal: controller.signal,
          cache: 'no-store',
        });
        const payload = (await accountResponse.json()) as {
          data?: Account;
          error?: { message?: string };
        };
        if (!accountResponse.ok || !payload.data)
          throw new Error(payload.error?.message ?? 'Account details are unavailable.');
        setAccount(payload.data);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : 'Account details are unavailable.');
      });
    return () => controller.abort();
  }, []);

  async function closeAccount() {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch('/api/backend/v1/account', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirmation }),
      });
      const payload = (await response.json()) as {
        data?: {
          status: Account['status'];
          projectsScheduled: number;
          projectsRemaining: number;
          pendingUploadCleanupCount: number;
        };
        error?: { code?: string; message?: string };
      };
      if (!response.ok || !payload.data) {
        if (payload.error?.code === 'REAUTHENTICATION_REQUIRED') {
          setRecentSignIn(false);
          throw new Error('Sign in again before deleting this account.');
        }
        throw new Error(payload.error?.message ?? 'Account closure could not be started.');
      }
      setAccount((current) =>
        current
          ? {
              ...current,
              status: payload.data!.status,
              displayName: null,
              activeProjectCount: 0,
              pendingProjectDeletionCount: payload.data!.projectsRemaining,
              pendingUploadCleanupCount: payload.data!.pendingUploadCleanupCount,
              deletionRequestedAt: new Date().toISOString(),
              closedAt: payload.data!.status === 'closed' ? new Date().toISOString() : null,
            }
          : current,
      );
      setConfirmation('');
      setMessage(
        payload.data.status === 'closed'
          ? 'Your account is closed. Its project data has been purged.'
          : `Account closure started. ${payload.data.projectsScheduled} project(s) are queued for private data removal.`,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Account closure could not be started.');
    } finally {
      setBusy(false);
    }
  }

  async function startFreshWorkspace() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/backend/v1/account/reactivate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirmation: 'START A NEW WORKSPACE' }),
      });
      const payload = (await response.json()) as {
        data?: { status: string };
        error?: { code?: string; message?: string };
      };
      if (!response.ok || payload.data?.status !== 'active') {
        if (payload.error?.code === 'RECENT_SIGN_IN_REQUIRED') {
          setError('For account safety, sign in again before creating a fresh workspace.');
          return;
        }
        throw new Error(payload.error?.message ?? 'A fresh workspace could not be created.');
      }
      setAccount((current) =>
        current
          ? {
              ...current,
              status: 'active',
              displayName: current.displayName ?? 'GitHub account',
              activeProjectCount: 0,
              pendingProjectDeletionCount: 0,
              pendingUploadCleanupCount: 0,
              deletionRequestedAt: null,
              closedAt: null,
            }
          : current,
      );
      setMessage('A new empty workspace is ready. Previously deleted projects cannot be restored.');
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'A fresh workspace could not be created.');
    } finally {
      setBusy(false);
    }
  }

  if (!account && !error)
    return (
      <section className="page account-page" aria-busy="true">
        <p className="eyebrow">ACCOUNT</p>
        <h1>Account settings</h1>
        <p className="lead">Loading your account details…</p>
      </section>
    );

  if (!account)
    return (
      <section className="page account-page">
        <p className="eyebrow">ACCOUNT</p>
        <h1>Account settings</h1>
        <p className="lead">{error}</p>
        <Link className="button primary account-signin" href="/api/auth/signin?returnTo=%2Faccount">
          Sign in with GitHub
        </Link>
      </section>
    );

  return (
    <section className="page account-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">IDENTITY AND DATA</p>
          <h1>Account settings</h1>
          <p className="lead">
            Review the identity attached to your workspace and control its lifecycle.
          </p>
        </div>
        <span className={`status-chip ${account.status === 'active' ? 'confirmed' : ''}`}>
          {account.status === 'active'
            ? 'Active'
            : account.status === 'closing'
              ? 'Closing'
              : 'Closed'}
        </span>
      </div>

      {message && (
        <p className="account-notice" role="status">
          {message}
        </p>
      )}
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}

      <section className="panel account-panel" aria-labelledby="account-profile-heading">
        <div className="panel-heading">
          <h2 id="account-profile-heading">Profile</h2>
        </div>
        <dl className="account-facts">
          <div>
            <dt>Sign-in provider</dt>
            <dd>{account.provider === 'github' ? 'GitHub' : 'Local development'}</dd>
          </div>
          <div>
            <dt>GitHub account</dt>
            <dd>{account.displayName ?? 'Private account label'}</dd>
          </div>
          <div>
            <dt>Internal account reference</dt>
            <dd>{account.providerAccountId}</dd>
          </div>
          <div>
            <dt>Created</dt>
            <dd>{new Date(account.createdAt).toLocaleDateString()}</dd>
          </div>
          <div>
            <dt>Active projects</dt>
            <dd>{account.activeProjectCount}</dd>
          </div>
          <div>
            <dt>Project deletions in progress</dt>
            <dd>{account.pendingProjectDeletionCount}</dd>
          </div>
          <div>
            <dt>In-flight upload cleanups</dt>
            <dd>{account.pendingUploadCleanupCount}</dd>
          </div>
        </dl>
        <p className="account-footnote">
          Schemora stores your GitHub numeric account reference to keep project ownership stable.
          Your GitHub password and OAuth access token are not stored by Schemora.
        </p>
      </section>

      {account.status === 'active' && (
        <section
          className="panel account-panel account-danger"
          aria-labelledby="account-delete-heading"
        >
          <div className="panel-heading">
            <h2 id="account-delete-heading">Close and delete account</h2>
          </div>
          <div className="account-body">
            <p>
              Closing your account immediately blocks workspace access and queues every project for
              deletion. The process removes uploaded objects and project records asynchronously.
              Once the purge finishes, only a minimal closed-account record remains so deleted
              project ownership and database references cannot be reused.
            </p>
            <p>
              The documented backup target is up to {account.proposedBackupRetentionDays} days, but
              production backups are not provisioned yet and the actual retention window must be
              stated before launch. Existing project data cannot be restored after deletion starts.
              After the purge finishes, you may sign in again to start an empty workspace.
            </p>
            <label className="field-label" htmlFor="account-delete-confirmation">
              Type <strong>DELETE MY ACCOUNT</strong> to continue
            </label>
            <input
              id="account-delete-confirmation"
              className="text-input"
              autoComplete="off"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
            />
            <button
              className="button danger account-close-button"
              disabled={busy || !recentSignIn || confirmation !== 'DELETE MY ACCOUNT'}
              onClick={() => void closeAccount()}
            >
              {busy ? 'Starting deletion…' : 'Close account and delete projects'}
            </button>
            {!recentSignIn && (
              <p className="account-reauth-note">
                Account deletion requires a recent sign-in.{' '}
                <Link href="/api/auth/signin?returnTo=%2Faccount">Sign in again</Link>
              </p>
            )}
          </div>
        </section>
      )}

      {account.status === 'closing' && (
        <section className="panel account-panel">
          <div className="account-body">
            <h2>Project deletion is in progress</h2>
            <p>
              New workspace access is disabled. The worker will finish removing project records,
              private uploads, and any in-flight upload cleanup intents (
              {account.pendingUploadCleanupCount} remain). You can sign out while this runs.
            </p>
          </div>
        </section>
      )}

      {account.status === 'closed' && (
        <section className="panel account-panel">
          <div className="account-body">
            <h2>Account closed</h2>
            <p>
              Your prior projects cannot be recovered from Schemora after closure. You may create a
              new empty workspace after signing in again.
            </p>
            <button
              className="button primary"
              disabled={busy}
              onClick={() => void startFreshWorkspace()}
            >
              {busy ? 'Preparing workspace…' : 'Start a new empty workspace'}
            </button>
            <Link className="account-reauth" href="/api/auth/signin?returnTo=%2Faccount">
              Sign in again first
            </Link>
          </div>
        </section>
      )}
    </section>
  );
}
