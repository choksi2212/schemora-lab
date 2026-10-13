'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { api, friendlyError, type Project } from '@/lib/api';
import {
  canCancelQueuedRun,
  firmwareEntrypointError,
  firmwareGraphState,
  serialOutput,
  type FirmwareLanguage,
} from './firmware-workspace-state';
import styles from './circuit-workspace.module.css';

const MonacoEditor = dynamic(() => import('./firmware-monaco-editor'), {
  ssr: false,
  loading: () => <div className={styles.editorLoading}>Loading code editor…</div>,
});

type Artifact = {
  id: string;
  projectId: string;
  projectRevision: number;
  sha256: string;
  byteLength: number;
  language: FirmwareLanguage;
  entrypoint: string;
  boardPartId: string;
  catalogReleaseId: string;
  reviewStatus: 'accepted' | 'pending' | 'rejected';
  reviewReason: string | null;
  createdAt: string;
};
type ArtifactList = { items: Artifact[] };
type StoredRun = {
  schemaVersion: 1;
  contractVersion: '1.0.0';
  runId: string;
  status:
    | 'unsupported'
    | 'queued'
    | 'preparing'
    | 'running'
    | 'stopping'
    | 'completed'
    | 'stopped'
    | 'failed'
    | 'timed_out'
    | 'cancelled';
  binding: {
    projectRevision: number;
    graphDigest: string;
    firmwareArtifactId: string;
    firmwareDigest: string;
  };
  events: {
    kind: string;
    sequence: number;
    simulationTimeMs: number;
    stream?: string;
    text?: string;
  }[];
  unsupportedFeatures: string[];
  limitations: string[];
  failure: { code: string; message: string } | null;
  simulatedDurationMs: number | null;
};
type RunSummary = { id: string; status: string; binding: StoredRun['binding']; createdAt: string };
type BoundArtifact = { graphDigest: string; graphRevision: number };

const languageDefaults: Record<FirmwareLanguage, { entrypoint: string; label: string }> = {
  'arduino-cpp': { entrypoint: 'src/main.cpp', label: 'Arduino C++' },
  cpp: { entrypoint: 'src/main.cpp', label: 'C++' },
  c: { entrypoint: 'src/main.c', label: 'C' },
  'esp-idf-c': { entrypoint: 'src/main.c', label: 'ESP-IDF C' },
};
const maxFirmwareBytes = 2_000_000;

function encodeBase64(value: string) {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (let start = 0; start < bytes.length; start += 8192)
    binary += String.fromCharCode(...bytes.subarray(start, start + 8192));
  return btoa(binary);
}

function isTerminal(status: StoredRun['status']) {
  return ['unsupported', 'completed', 'stopped', 'failed', 'timed_out', 'cancelled'].includes(
    status,
  );
}

export function FirmwareWorkspace({
  project,
  projectId,
  graphRevision,
  graphDigest,
  graphDirty,
  validationReady,
  boardPartId,
  onProjectChange,
}: {
  project: Project;
  projectId: string;
  graphRevision: number;
  graphDigest: string | null;
  graphDirty: boolean;
  validationReady: boolean;
  boardPartId: string | null;
  onProjectChange: (project: Project) => void;
}) {
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [bindings, setBindings] = useState<Record<string, BoundArtifact>>({});
  const [selectedId, setSelectedId] = useState('');
  const [language, setLanguage] = useState<FirmwareLanguage>('arduino-cpp');
  const [entrypoint, setEntrypoint] = useState(languageDefaults['arduino-cpp'].entrypoint);
  const [source, setSource] = useState('');
  const [reason, setReason] = useState('');
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [run, setRun] = useState<StoredRun | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [contentBusy, setContentBusy] = useState(false);
  const runRequestId = useRef(0);

  const currentArtifact = artifacts.find((artifact) => artifact.id === selectedId) ?? null;
  const association = currentArtifact ? (bindings[currentArtifact.id] ?? null) : null;
  const artifactState = useMemo(
    () =>
      currentArtifact
        ? firmwareGraphState({
            reviewStatus: currentArtifact.reviewStatus,
            binding: association,
            currentGraphDigest: graphDigest,
            currentGraphRevision: graphRevision,
            graphDirty,
          })
        : null,
    [currentArtifact, association, graphDigest, graphRevision, graphDirty],
  );
  const entrypointError = firmwareEntrypointError(language, entrypoint);
  const refreshArtifacts = useCallback(async () => {
    const result = await api<ArtifactList>(`/projects/${projectId}/firmware-artifacts`);
    setArtifacts(result.items);
    setSelectedId((selected) =>
      result.items.some((item) => item.id === selected) ? selected : (result.items[0]?.id ?? ''),
    );
    const resolved = await Promise.all(
      result.items.map(async (item) => {
        try {
          const revision = await api<{
            snapshot: { circuitGraph?: { digest: string; revision: number } | null };
          }>(`/projects/${projectId}/revisions/${item.projectRevision}`);
          const graph = revision.snapshot.circuitGraph;
          return graph
            ? ([item.id, { graphDigest: graph.digest, graphRevision: graph.revision }] as const)
            : null;
        } catch {
          return null;
        }
      }),
    );
    setBindings(Object.fromEntries(resolved.filter((item) => item !== null)));
  }, [projectId]);
  const refreshRuns = useCallback(async () => {
    const result = await api<{ items: RunSummary[] }>(`/projects/${projectId}/simulation-runs`);
    setRuns(result.items);
    const targetId = result.items[0]?.id;
    if (!targetId) {
      runRequestId.current += 1;
      setRun(null);
      return;
    }
    const requestId = ++runRequestId.current;
    const detail = await api<{ run: StoredRun }>(
      `/projects/${projectId}/simulation-runs/${encodeURIComponent(targetId)}`,
    );
    if (requestId === runRequestId.current) setRun(detail.run);
  }, [projectId]);

  useEffect(() => {
    let active = true;
    void Promise.all([refreshArtifacts(), refreshRuns()]).catch((cause: unknown) => {
      if (active) setError(friendlyError(cause));
    });
    return () => {
      active = false;
    };
  }, [refreshArtifacts, refreshRuns]);

  useEffect(() => {
    if (!currentArtifact) return;
    let active = true;
    setLanguage(currentArtifact.language);
    setEntrypoint(currentArtifact.entrypoint);
    setReason(currentArtifact.reviewReason ?? '');
    setContentBusy(true);
    void fetch(
      `/api/backend/v1/projects/${encodeURIComponent(projectId)}/firmware-artifacts/${encodeURIComponent(currentArtifact.id)}/content`,
      { cache: 'no-store', credentials: 'same-origin' },
    )
      .then(async (response) => {
        if (!response.ok) throw new Error('Saved source could not be loaded.');
        const value = await response.text();
        if (active) setSource(value);
      })
      .catch((cause: unknown) => {
        if (active) setError(friendlyError(cause));
      })
      .finally(() => {
        if (active) setContentBusy(false);
      });
    return () => {
      active = false;
    };
    // Review metadata updates do not change the selected immutable source content.
    // Reload only when the selected artifact changes, preserving unsaved editor input.
  }, [selectedId, projectId]);

  useEffect(() => {
    if (!run || isTerminal(run.status)) return;
    let active = true;
    const selectedRunId = run.runId;
    const selectionRequestId = runRequestId.current;
    const timer = window.setInterval(() => {
      void api<{ run: StoredRun }>(
        `/projects/${projectId}/simulation-runs/${encodeURIComponent(selectedRunId)}`,
      )
        .then((result) => {
          if (active && runRequestId.current === selectionRequestId) setRun(result.run);
        })
        .catch((cause: unknown) => setError(friendlyError(cause)));
    }, 2_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [projectId, run?.runId, run?.status]);

  async function selectArtifact(artifactId: string) {
    setSource('');
    setContentBusy(Boolean(artifactId));
    setSelectedId(artifactId);
    setError('');
  }

  async function saveVersion() {
    if (busy || contentBusy || graphDirty || !graphDigest || !boardPartId || !source.trim()) return;
    const byteLength = new TextEncoder().encode(source).byteLength;
    if (byteLength > maxFirmwareBytes) {
      setError('Source exceeds the 2,000,000 byte firmware limit.');
      return;
    }
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await api<{ project: Project; artifact: Artifact }>(
        `/projects/${projectId}/firmware-artifacts`,
        {
          method: 'POST',
          body: {
            expectedRevision: project.revision,
            language,
            entrypoint,
            contentBase64: encodeBase64(source),
          },
        },
      );
      onProjectChange(result.project);
      const revision = await api<{
        snapshot: { circuitGraph?: { digest: string; revision: number } | null };
      }>(`/projects/${projectId}/revisions/${result.artifact.projectRevision}`);
      const graph = revision.snapshot.circuitGraph;
      const binding = graph
        ? { graphDigest: graph.digest, graphRevision: graph.revision }
        : { graphDigest, graphRevision };
      setBindings((previous) => ({ ...previous, [result.artifact.id]: binding }));
      setArtifacts((previous) => [
        result.artifact,
        ...previous.filter((item) => item.id !== result.artifact.id),
      ]);
      setSelectedId(result.artifact.id);
      setNotice('New immutable source version saved. No compilation was performed.');
    } catch (cause) {
      setError(friendlyError(cause));
    } finally {
      setBusy(false);
    }
  }

  async function review(decision: 'accepted' | 'rejected') {
    if (!currentArtifact || busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await api<{ project: Project; artifact: Artifact }>(
        `/projects/${projectId}/firmware-artifacts/${encodeURIComponent(currentArtifact.id)}/reviews`,
        {
          method: 'POST',
          body: {
            expectedRevision: project.revision,
            decision,
            ...(reason.trim() ? { reason: reason.trim() } : {}),
          },
        },
      );
      onProjectChange(result.project);
      setArtifacts((items) =>
        items.map((item) => (item.id === result.artifact.id ? result.artifact : item)),
      );
      setNotice(
        `Source review recorded as ${decision}. This is a review decision, not a compiler result.`,
      );
    } catch (cause) {
      setError(friendlyError(cause));
    } finally {
      setBusy(false);
    }
  }

  async function startRun() {
    if (!currentArtifact || !artifactState?.canRun || !validationReady || !graphDigest || busy)
      return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await api<{ run: StoredRun }>(`/projects/${projectId}/simulation-runs`, {
        method: 'POST',
        body: { expectedRevision: project.revision, firmwareArtifactId: currentArtifact.id },
      });
      setRun(result.run);
      setNotice(
        'Run record queued. This environment has no configured simulator; the worker reports SIMULATOR_UNAVAILABLE.',
      );
      void refreshRuns();
    } catch (cause) {
      setError(friendlyError(cause));
    } finally {
      setBusy(false);
    }
  }

  async function selectRun(id: string) {
    const requestId = ++runRequestId.current;
    try {
      const result = await api<{ run: StoredRun }>(
        `/projects/${projectId}/simulation-runs/${encodeURIComponent(id)}`,
      );
      if (requestId === runRequestId.current) setRun(result.run);
    } catch (cause) {
      setError(friendlyError(cause));
    }
  }

  async function cancelQueuedRun() {
    if (!run || !canCancelQueuedRun(run.status) || busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await api<{ run: StoredRun }>(
        `/projects/${projectId}/simulation-runs/${encodeURIComponent(run.runId)}/cancel`,
        { method: 'POST', body: {}, idempotencyKey: crypto.randomUUID() },
      );
      setRun(result.run);
      setNotice(
        'Queued run cancelled before execution. Active runs cannot be stopped by this control.',
      );
      void refreshRuns();
    } catch (cause) {
      setError(friendlyError(cause));
    } finally {
      setBusy(false);
    }
  }

  const serial = run ? serialOutput(run.events) : [];
  return (
    <section className={`panel ${styles.firmwarePanel}`} aria-labelledby="firmware-title">
      <div className="panel-heading">
        <div>
          <h2 id="firmware-title">Firmware source</h2>
          <p className="fine-text">
            Author and version source for the saved board. Saving creates a new immutable version.
          </p>
        </div>
        <span className="status-chip">{artifacts.length} versions</span>
      </div>
      <section className={styles.coveragePanel} aria-labelledby="simulation-coverage-title">
        <div>
          <h3 id="simulation-coverage-title">Simulation coverage and limits</h3>
          <p className="fine-text">
            Coverage describes what this product can currently establish. It is separate from
            circuit validation and does not imply electrical safety.
          </p>
        </div>
        <dl className={styles.coverageGrid}>
          <div>
            <dt>Simulated behavior</dt>
            <dd>
              {run?.status === 'completed'
                ? 'This stored run completed. Review its bound events and limitations below.'
                : 'None available. The worker reports SIMULATOR_UNAVAILABLE; queued or unavailable records are not simulation evidence.'}
            </dd>
          </div>
          <div>
            <dt>Visual-only behavior</dt>
            <dd>
              The 3D workbench displays circuit components and layout. Rendering does not establish
              electrical behavior or physical fit.
            </dd>
          </div>
          <div>
            <dt>Unsupported behavior</dt>
            <dd>
              No product simulation provider is approved or configured. Unsupported boards,
              components, or topologies must fail closed instead of being reported as simulated.
              {run?.unsupportedFeatures.length
                ? ` Current run: ${run.unsupportedFeatures.join(' ')}`
                : ''}
            </dd>
          </div>
          <div>
            <dt>Unmodeled behavior</dt>
            <dd>
              Electrical validation does not establish GPIO current budget, thermal margin,
              transient response, or other omitted physical behavior.
            </dd>
          </div>
        </dl>
      </section>
      {graphDirty && (
        <p className="warning-notice" role="status">
          Save circuit edits before attaching firmware. Existing source bindings remain tied to
          their prior graph snapshot.
        </p>
      )}
      {!boardPartId && (
        <p className="warning-notice">
          The saved circuit needs exactly one supported development board before firmware can be
          saved.
        </p>
      )}
      <div className={styles.firmwareGrid}>
        <div className={styles.firmwareEditor}>
          <div className={styles.firmwareFields}>
            <label className="field-label">
              Language
              <select
                value={language}
                onChange={(event) => {
                  const next = event.target.value as FirmwareLanguage;
                  setLanguage(next);
                  const extension = next === 'c' || next === 'esp-idf-c' ? 'c' : 'cpp';
                  setEntrypoint((current) => current.replace(/\.(c|cc|cpp)$/, `.${extension}`));
                }}
              >
                {Object.entries(languageDefaults).map(([value, item]) => (
                  <option key={value} value={value}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field-label">
              Entrypoint path
              <input
                value={entrypoint}
                maxLength={200}
                onChange={(event) => setEntrypoint(event.target.value)}
              />
            </label>
          </div>
          <span className="field-label" id="firmware-source-label">
            Source code
          </span>
          <div className={styles.monacoEditor} role="group" aria-labelledby="firmware-source-label">
            <MonacoEditor
              height="390px"
              language={language === 'c' || language === 'esp-idf-c' ? 'c' : 'cpp'}
              path={entrypoint || 'src/main.cpp'}
              value={source}
              onChange={(value) => setSource(value ?? '')}
              loading={<div className={styles.editorLoading}>Loading code editor…</div>}
              options={{
                ariaLabel: 'Firmware source editor',
                automaticLayout: true,
                fontSize: 13,
                lineNumbers: 'on',
                minimap: { enabled: false },
                scrollBeyondLastLine: false,
                tabSize: 2,
                wordWrap: 'off',
              }}
            />
          </div>
          <div className={styles.firmwareActions}>
            <span className="fine-text">
              {new TextEncoder().encode(source).byteLength.toLocaleString()} /{' '}
              {maxFirmwareBytes.toLocaleString()} bytes · editor only; no compiler is configured
            </span>
            <button
              className="button primary"
              type="button"
              disabled={
                busy ||
                contentBusy ||
                graphDirty ||
                !graphDigest ||
                !boardPartId ||
                !source.trim() ||
                Boolean(entrypointError)
              }
              onClick={() => void saveVersion()}
            >
              Save new version
            </button>
          </div>
          {entrypointError && (
            <p className="warning-notice" role="status">
              {entrypointError}
            </p>
          )}
        </div>
        <div className={styles.firmwareVersions}>
          <label className="field-label">
            Saved source versions
            <select
              value={selectedId}
              onChange={(event) => void selectArtifact(event.target.value)}
            >
              {!artifacts.length && <option value="">No saved versions</option>}
              {artifacts.map((artifact) => (
                <option key={artifact.id} value={artifact.id}>
                  {artifact.language} · {artifact.id.slice(0, 8)} · {artifact.reviewStatus}
                </option>
              ))}
            </select>
          </label>
          {currentArtifact ? (
            <>
              <dl className={styles.firmwareMetadata}>
                <div>
                  <dt>Review status</dt>
                  <dd>{currentArtifact.reviewStatus}</dd>
                </div>
                <div>
                  <dt>Source digest</dt>
                  <dd>
                    <code>{currentArtifact.sha256}</code>
                  </dd>
                </div>
                <div>
                  <dt>Version revision</dt>
                  <dd>{currentArtifact.projectRevision}</dd>
                </div>
                <div>
                  <dt>Graph association</dt>
                  <dd>{artifactState?.label}</dd>
                </div>
                {association && (
                  <div>
                    <dt>Bound graph</dt>
                    <dd>
                      Revision {association.graphRevision} ·{' '}
                      <code>{association.graphDigest.slice(0, 12)}</code>
                    </dd>
                  </div>
                )}
                <div>
                  <dt>Source size</dt>
                  <dd>{currentArtifact.byteLength.toLocaleString()} bytes</dd>
                </div>
              </dl>
              <p className="fine-text">
                {currentArtifact.reviewReason || 'No review reason recorded.'}
              </p>
              <label className="field-label">
                Review reason (optional)
                <textarea
                  value={reason}
                  maxLength={2000}
                  rows={3}
                  onChange={(event) => setReason(event.target.value)}
                />
              </label>
              <div className={styles.firmwareActions}>
                <button
                  className="button secondary"
                  disabled={busy}
                  onClick={() => void review('accepted')}
                >
                  Mark accepted
                </button>
                <button
                  className="button secondary"
                  disabled={busy}
                  onClick={() => void review('rejected')}
                >
                  Mark rejected
                </button>
              </div>
              {contentBusy && <p className="fine-text">Loading saved source…</p>}
            </>
          ) : (
            <p className="fine-text">
              Saving source creates the first version. Review status stays pending until a review
              decision is recorded.
            </p>
          )}
        </div>
      </div>
      {currentArtifact && (
        <p className="fine-text">
          Accepted means accepted by the review record only. There are no compile diagnostics. The
          graph association is derived from the immutable project revision snapshot; firmware
          artifacts do not carry a separate graph association field.
        </p>
      )}
      {currentArtifact && (
        <div className={styles.runControls}>
          <div>
            <strong>Simulation</strong>
            <p className="fine-text">
              Runs are stored against the exact graph and firmware digests. This worker does not
              compile or execute firmware.
            </p>
          </div>
          <button
            className="button primary"
            disabled={busy || !artifactState?.canRun || !validationReady || !isCurrentGraph()}
            onClick={() => void startRun()}
          >
            Create simulation run
          </button>
        </div>
      )}
      {currentArtifact && !validationReady && (
        <p className="warning-notice">
          Save and validate the current graph with no failed or errored checks before creating a
          run.
        </p>
      )}
      {runs.length > 0 && (
        <label className="field-label">
          Stored runs
          <select value={run?.runId ?? ''} onChange={(event) => void selectRun(event.target.value)}>
            {runs.map((item) => (
              <option key={item.id} value={item.id}>
                {item.status} · {item.id.slice(0, 8)}
              </option>
            ))}
          </select>
        </label>
      )}
      {run && (
        <div className={styles.runRecord}>
          <div className={styles.firmwareActions}>
            <strong>Run {run.status.replaceAll('_', ' ')}</strong>
            <span className="fine-text">
              Graph {run.binding.graphDigest.slice(0, 12)} · firmware{' '}
              {run.binding.firmwareDigest.slice(0, 12)}
            </span>
            {canCancelQueuedRun(run.status) && (
              <button
                className="button secondary"
                disabled={busy}
                onClick={() => void cancelQueuedRun()}
              >
                Cancel queued run
              </button>
            )}
          </div>
          {run.failure && (
            <p className="warning-notice">
              <strong>{run.failure.code}</strong>: {run.failure.message}
            </p>
          )}
          {!run.failure && run.status !== 'completed' && (
            <p className="warning-notice">
              No execution result is available. The run remains a queued or unavailable record.
            </p>
          )}
          {run.limitations.map((item) => (
            <p className="fine-text" key={item}>
              {item}
            </p>
          ))}
          <h3>Stored serial output</h3>
          {serial.length ? (
            <pre className={styles.serialOutput}>
              {serial
                .map((event) => `[${event.simulationTimeMs} ms] ${event.stream}: ${event.text}`)
                .join('\n')}
            </pre>
          ) : (
            <p className="fine-text">No serial events are stored for this run.</p>
          )}
        </div>
      )}
      {error && (
        <p className="warning-notice" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="fine-text" role="status">
          {notice}
        </p>
      )}
    </section>
  );

  function isCurrentGraph() {
    return Boolean(!graphDirty && graphDigest && graphRevision > 0);
  }
}
