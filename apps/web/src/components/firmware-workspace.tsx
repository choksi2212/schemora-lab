'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import type { editor as MonacoEditorApi } from 'monaco-editor';
import { Uri } from 'monaco-editor';
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
  bundleDigest?: string | null;
  totalByteLength?: number | null;
  buildSystem?: 'arduino-cli' | 'esp-idf' | null;
  target?: { kind: string; target?: string; fqbn?: string } | null;
  files?: { path: string; sha256: string; byteLength: number; isEntrypoint: boolean }[];
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
type BuildDiagnostic = {
  severity: 'error' | 'warning' | 'info';
  code: string;
  message: string;
  sourcePath: string | null;
  line: number | null;
  column: number | null;
};
type FirmwareBuild = {
  id: string;
  status: 'succeeded' | 'failed' | 'timed_out' | 'rejected';
  result: {
    compilerVersion: string;
    durationMs: number;
    diagnostics: BuildDiagnostic[];
    artifacts: {
      role: 'application' | 'bootloader' | 'partition_table';
      path: string;
      byteLength: number;
    }[];
  };
  createdAt: string;
};

const languageDefaults: Record<FirmwareLanguage, { entrypoint: string; label: string }> = {
  'arduino-cpp': { entrypoint: 'src/main.cpp', label: 'Arduino C++' },
  cpp: { entrypoint: 'src/main.cpp', label: 'C++' },
  c: { entrypoint: 'src/main.c', label: 'C' },
  'esp-idf-c': { entrypoint: 'src/main.c', label: 'ESP-IDF C' },
};
const maxFirmwareBytes = 2_000_000;
const maxBundleBytes = 8_000_000;
const maxBundleFiles = 128;
const safeBundlePath = (path: string) =>
  Boolean(
    path &&
    new TextEncoder().encode(path).byteLength <= 240 &&
    path.normalize('NFC') === path &&
    !path.startsWith('/') &&
    !path.includes('\\') &&
    !/^[A-Za-z]:/.test(path) &&
    !/[\u0000-\u001f\u007f]/.test(path) &&
    !path.split('/').some((part) => !part || part === '.' || part === '..'),
  );

function encodeBase64(value: string) {
  return encodeBase64Bytes(new TextEncoder().encode(value));
}

function firmwareEditorModelPath(projectId: string, artifactId: string, filePath: string) {
  return Uri.file(`/schemora/${projectId}/${artifactId}/${filePath}`).toString();
}

function encodeBase64Bytes(bytes: Uint8Array) {
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
  const [authoringMode, setAuthoringMode] = useState<'single' | 'esp-idf'>('single');
  const [bundleFiles, setBundleFiles] = useState<{ path: string; source: string }[]>([]);
  const [activeBundlePath, setActiveBundlePath] = useState('');
  const [newFilePath, setNewFilePath] = useState('main/extra.c');
  const [reason, setReason] = useState('');
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [run, setRun] = useState<StoredRun | null>(null);
  const [builds, setBuilds] = useState<FirmwareBuild[]>([]);
  const [buildError, setBuildError] = useState('');
  const [pendingDiagnosticLocation, setPendingDiagnosticLocation] = useState<{
    path: string;
    line: number;
    column: number;
  } | null>(null);
  const [editorEpoch, setEditorEpoch] = useState(0);
  const monacoEditor = useRef<MonacoEditorApi.IStandaloneCodeEditor | null>(null);
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
  const bundleExecutionUnavailable = currentArtifact?.buildSystem === 'esp-idf';
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
    setBuilds([]);
    setBuildError('');
    if (!currentArtifact)
      return () => {
        active = false;
      };
    void api<{ items: FirmwareBuild[] }>(
      `/projects/${encodeURIComponent(projectId)}/firmware-artifacts/${encodeURIComponent(currentArtifact.id)}/builds`,
    )
      .then((result) => {
        if (active) setBuilds(result.items);
      })
      .catch((cause: unknown) => {
        if (active) setBuildError(friendlyError(cause));
      });
    return () => {
      active = false;
    };
  }, [projectId, currentArtifact?.id]);

  useEffect(() => {
    if (!pendingDiagnosticLocation) return;
    const editor = monacoEditor.current;
    const model = editor?.getModel();
    const expectedModelPath = currentArtifact
      ? `/schemora/${projectId}/${currentArtifact.id}/${pendingDiagnosticLocation.path}`
      : '';
    if (!editor || !model || model.uri.path !== expectedModelPath) return;
    const line = Math.min(pendingDiagnosticLocation.line, model.getLineCount());
    editor.setPosition({
      lineNumber: line,
      column: Math.min(pendingDiagnosticLocation.column, model.getLineMaxColumn(line)),
    });
    editor.revealLineInCenter(line);
    editor.focus();
    setPendingDiagnosticLocation(null);
  }, [
    pendingDiagnosticLocation,
    activeBundlePath,
    source,
    editorEpoch,
    currentArtifact,
    projectId,
  ]);

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
    setActiveBundlePath(currentArtifact.entrypoint);
    setReason(currentArtifact.reviewReason ?? '');
    setContentBusy(true);
    void (async () => {
      const prefix = `/api/backend/v1/projects/${encodeURIComponent(projectId)}/firmware-artifacts/${encodeURIComponent(currentArtifact.id)}`;
      if (currentArtifact.buildSystem === 'esp-idf') {
        const fileList = await api<{
          items: { path: string; isEntrypoint: boolean; sha256: string; byteLength: number }[];
        }>(
          `/projects/${encodeURIComponent(projectId)}/firmware-artifacts/${encodeURIComponent(currentArtifact.id)}/files`,
        );
        const loaded = await Promise.all(
          fileList.items.map(async (file) => {
            const query = new URLSearchParams({ path: file.path });
            const response = await fetch(`${prefix}/files/content?${query}`, {
              cache: 'no-store',
              credentials: 'same-origin',
            });
            if (!response.ok) throw new Error(`Saved file ${file.path} could not be loaded.`);
            const bytes = new Uint8Array(await response.arrayBuffer());
            if (
              !bytes.length ||
              bytes.length !== file.byteLength ||
              bytes.length > maxFirmwareBytes
            )
              throw new Error(`Saved file ${file.path} exceeds the supported editor size.`);
            const digestBytes = new Uint8Array(
              await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes).buffer),
            );
            const digest = Array.from(digestBytes, (byte) =>
              byte.toString(16).padStart(2, '0'),
            ).join('');
            if (digest !== file.sha256)
              throw new Error(`Saved file ${file.path} failed its integrity check.`);
            const value = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
            return { path: file.path, source: value };
          }),
        );
        if (active) {
          setAuthoringMode('esp-idf');
          setBundleFiles(loaded);
          setActiveBundlePath(currentArtifact.entrypoint);
          setSource(loaded.find((file) => file.path === currentArtifact.entrypoint)?.source ?? '');
        }
      } else {
        const response = await fetch(`${prefix}/content`, {
          cache: 'no-store',
          credentials: 'same-origin',
        });
        if (!response.ok) throw new Error('Saved source could not be loaded.');
        const value = new TextDecoder('utf-8', { fatal: true }).decode(
          await response.arrayBuffer(),
        );
        if (active) {
          setAuthoringMode('single');
          setBundleFiles([]);
          setSource(value);
        }
      }
    })()
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

  async function saveBundleVersion() {
    if (busy || contentBusy || graphDirty || !graphDigest || !boardPartId) return;
    const normalized = bundleFiles.map((file) => ({ path: file.path.trim(), source: file.source }));
    if (normalized.length < 3 || normalized.length > maxBundleFiles) {
      setError('An ESP-IDF project needs at least three files and may contain at most 128 files.');
      return;
    }
    const paths = normalized.map((file) => file.path);
    if (
      normalized.some((file) => !safeBundlePath(file.path)) ||
      new Set(paths.map((p) => p.toLocaleLowerCase('en-US'))).size !== paths.length
    ) {
      setError('Use unique, safe relative file paths with forward slashes.');
      return;
    }
    if (
      !paths.includes('CMakeLists.txt') ||
      !paths.includes('main/CMakeLists.txt') ||
      !/^main\/.+\.(c|cc|cpp|cxx)$/i.test(entrypoint) ||
      !paths.includes(entrypoint)
    ) {
      setError(
        'ESP-IDF requires root and main/CMakeLists.txt files and a C/C++ entrypoint under main/.',
      );
      return;
    }
    const byteFiles = normalized.map((file) => ({
      ...file,
      bytes: new TextEncoder().encode(file.source),
    }));
    if (
      byteFiles.some((file) => !file.bytes.length || file.bytes.length > maxFirmwareBytes) ||
      byteFiles.reduce((sum, file) => sum + file.bytes.length, 0) > maxBundleBytes
    ) {
      setError('Files must be non-empty, at most 2,000,000 bytes each, and 8,000,000 bytes total.');
      return;
    }
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await api<{ project: Project; artifact: Artifact }>(
        '/projects/' + encodeURIComponent(projectId) + '/firmware-artifacts/bundles',
        {
          method: 'POST',
          body: {
            expectedRevision: project.revision,
            buildSystem: 'esp-idf',
            target: { kind: 'esp-idf-target', target: 'esp32' },
            entrypoint,
            files: byteFiles.map(({ path, bytes }) => ({
              path,
              contentBase64: encodeBase64Bytes(bytes),
            })),
          },
        },
      );
      onProjectChange(result.project);
      setArtifacts((previous) => [
        result.artifact,
        ...previous.filter((item) => item.id !== result.artifact.id),
      ]);
      setSelectedId(result.artifact.id);
      setNotice('New immutable ESP-IDF bundle saved for ESP32. No compilation was performed.');
    } catch (cause) {
      setError(friendlyError(cause));
    } finally {
      setBusy(false);
    }
  }

  function addBundleFile() {
    const path = newFilePath.trim();
    if (
      !safeBundlePath(path) ||
      bundleFiles.some(
        (file) => file.path.toLocaleLowerCase('en-US') === path.toLocaleLowerCase('en-US'),
      )
    ) {
      setError('Enter a unique safe relative path for the new file.');
      return;
    }
    const next = [...bundleFiles, { path, source: '' }];
    setBundleFiles(next);
    setActiveBundlePath(path);
    setSource('');
    setError('');
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
    if (
      !currentArtifact ||
      !artifactState?.canRun ||
      bundleExecutionUnavailable ||
      !validationReady ||
      !graphDigest ||
      busy
    )
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
          <label className="field-label">
            Authoring format
            <select
              value={authoringMode}
              onChange={(event) => {
                const mode = event.target.value as 'single' | 'esp-idf';
                setAuthoringMode(mode);
                if (mode === 'esp-idf' && bundleFiles.length === 0) {
                  const files = [
                    {
                      path: 'CMakeLists.txt',
                      source:
                        'cmake_minimum_required(VERSION 3.16)\ninclude($ENV{IDF_PATH}/tools/cmake/project.cmake)\nproject(schemora_firmware)\n',
                    },
                    {
                      path: 'main/CMakeLists.txt',
                      source: 'idf_component_register(SRCS "main.c" INCLUDE_DIRS ".")\n',
                    },
                    {
                      path: 'main/main.c',
                      source:
                        '#include <stdio.h>\n\nvoid app_main(void) {\n    printf("Schemora firmware\\n");\n}\n',
                    },
                  ];
                  setBundleFiles(files);
                  setEntrypoint('main/main.c');
                  setActiveBundlePath('main/main.c');
                  setSource(files[2].source);
                  setLanguage('esp-idf-c');
                }
              }}
            >
              <option value="single">Single source file</option>
              <option value="esp-idf">ESP-IDF project bundle (ESP32)</option>
            </select>
          </label>
          {authoringMode === 'single' ? (
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
          ) : (
            <>
              <div className={styles.firmwareFields}>
                <label className="field-label">
                  ESP-IDF target
                  <select value="esp32" disabled>
                    <option value="esp32">ESP32 · ESP32-DevKitC V4</option>
                  </select>
                </label>
                <label className="field-label">
                  Entrypoint
                  <select
                    value={entrypoint}
                    onChange={(event) => setEntrypoint(event.target.value)}
                  >
                    {bundleFiles
                      .filter((file) => /^main\/.+\.(c|cc|cpp|cxx)$/i.test(file.path))
                      .map((file) => (
                        <option key={file.path}>{file.path}</option>
                      ))}
                  </select>
                </label>
              </div>
              <div className={styles.firmwareActions}>
                <label className="field-label">
                  New file path
                  <input
                    value={newFilePath}
                    maxLength={240}
                    onChange={(event) => setNewFilePath(event.target.value)}
                  />
                </label>
                <button
                  className="button secondary"
                  type="button"
                  onClick={addBundleFile}
                  disabled={busy}
                >
                  Add file
                </button>
                <label className="field-label">
                  Project file
                  <select
                    value={activeBundlePath}
                    onChange={(event) => {
                      const path = event.target.value;
                      setActiveBundlePath(path);
                      setSource(bundleFiles.find((file) => file.path === path)?.source ?? '');
                    }}
                  >
                    {bundleFiles.map((file) => (
                      <option key={file.path} value={file.path}>
                        {file.path}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  className="button secondary"
                  type="button"
                  disabled={busy || bundleFiles.length <= 3}
                  onClick={() => {
                    const next = bundleFiles.filter((file) => file.path !== activeBundlePath);
                    setBundleFiles(next);
                    setActiveBundlePath(next[0]?.path ?? '');
                    setSource(next[0]?.source ?? '');
                    if (entrypoint === activeBundlePath)
                      setEntrypoint(
                        next.find((file) => /^main\/.+\.(c|cc|cpp|cxx)$/i.test(file.path))?.path ??
                          '',
                      );
                  }}
                >
                  Remove selected file
                </button>
              </div>
            </>
          )}
          <span className="field-label" id="firmware-source-label">
            Source code
          </span>
          <div className={styles.monacoEditor} role="group" aria-labelledby="firmware-source-label">
            <MonacoEditor
              height="390px"
              language={language === 'c' || language === 'esp-idf-c' ? 'c' : 'cpp'}
              path={firmwareEditorModelPath(
                projectId,
                currentArtifact?.id ?? 'draft',
                (authoringMode === 'esp-idf' ? activeBundlePath : entrypoint) || 'src/main.cpp',
              )}
              value={source}
              onMount={(instance) => {
                monacoEditor.current = instance;
                instance.onDidChangeModel(() => {
                  setEditorEpoch((epoch) => epoch + 1);
                });
                setEditorEpoch((epoch) => epoch + 1);
              }}
              onChange={(value) => {
                const nextSource = value ?? '';
                setSource(nextSource);
                if (authoringMode === 'esp-idf')
                  setBundleFiles((files) =>
                    files.map((file) =>
                      file.path === activeBundlePath ? { ...file, source: nextSource } : file,
                    ),
                  );
              }}
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
              {authoringMode === 'esp-idf'
                ? bundleFiles
                    .reduce(
                      (sum, file) => sum + new TextEncoder().encode(file.source).byteLength,
                      0,
                    )
                    .toLocaleString()
                : new TextEncoder().encode(source).byteLength.toLocaleString()}{' '}
              / {(authoringMode === 'esp-idf' ? maxBundleBytes : maxFirmwareBytes).toLocaleString()}{' '}
              bytes · editor only; no compiler is configured
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
                (authoringMode === 'single' && !source.trim()) ||
                (authoringMode === 'single' && Boolean(entrypointError))
              }
              onClick={() =>
                void (authoringMode === 'esp-idf' ? saveBundleVersion() : saveVersion())
              }
            >
              Save new {authoringMode === 'esp-idf' ? 'bundle' : 'version'}
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
        <section className={styles.runRecord} aria-labelledby="firmware-build-heading">
          <h3 id="firmware-build-heading">Compiler history</h3>
          <p className="fine-text">
            Build records are immutable and tied to this source digest. Compiler diagnostics report
            source locations when the compiler supplies them; a build result does not mean the
            firmware was executed.
          </p>
          {buildError && <p className="warning-notice">{buildError}</p>}
          {!buildError && builds.length === 0 && (
            <p className="fine-text">No compiler result is stored for this source version.</p>
          )}
          {builds.map((build) => (
            <article key={build.id} className={styles.runRecord}>
              <div className={styles.firmwareActions}>
                <strong>Build {build.status.replaceAll('_', ' ')}</strong>
                <span className="fine-text">
                  {build.result.compilerVersion} · {build.result.durationMs} ms ·{' '}
                  {new Date(build.createdAt).toLocaleString()}
                </span>
              </div>
              {build.result.diagnostics.length > 0 ? (
                <ul className={styles.buildDiagnostics}>
                  {build.result.diagnostics.map((diagnostic, index) => (
                    <li key={`${diagnostic.code}-${index}`}>
                      <strong>
                        {diagnostic.severity.toUpperCase()} · {diagnostic.code}
                      </strong>
                      {diagnostic.sourcePath &&
                        (diagnostic.line !== null &&
                        diagnostic.column !== null &&
                        (currentArtifact.buildSystem !== 'esp-idf'
                          ? diagnostic.sourcePath === currentArtifact.entrypoint
                          : bundleFiles.some((file) => file.path === diagnostic.sourcePath)) ? (
                          <button
                            type="button"
                            className={styles.diagnosticLocation}
                            onClick={() => {
                              if (currentArtifact.buildSystem === 'esp-idf') {
                                const file = bundleFiles.find(
                                  (item) => item.path === diagnostic.sourcePath,
                                );
                                if (!file) return;
                                setActiveBundlePath(file.path);
                                setSource(file.source);
                              }
                              setPendingDiagnosticLocation({
                                path: diagnostic.sourcePath!,
                                line: diagnostic.line!,
                                column: diagnostic.column!,
                              });
                            }}
                          >
                            {diagnostic.sourcePath}:{diagnostic.line}:{diagnostic.column}
                          </button>
                        ) : (
                          <code>
                            {diagnostic.sourcePath}
                            {diagnostic.line !== null && `:${diagnostic.line}`}
                            {diagnostic.column !== null && `:${diagnostic.column}`}
                          </code>
                        ))}
                      <span>{diagnostic.message}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="fine-text">No compiler diagnostics were recorded.</p>
              )}
              {build.result.artifacts.length > 0 && (
                <ul className={styles.buildArtifacts}>
                  {build.result.artifacts.map((output) => (
                    <li key={output.role}>
                      <a
                        href={`/api/backend/v1/projects/${encodeURIComponent(projectId)}/firmware-artifacts/${encodeURIComponent(currentArtifact.id)}/builds/${encodeURIComponent(build.id)}/artifacts/${encodeURIComponent(output.role)}`}
                      >
                        Download {output.role.replaceAll('_', ' ')}
                      </a>
                      <span className="fine-text">
                        {output.path} · {output.byteLength.toLocaleString()} bytes
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </article>
          ))}
        </section>
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
            disabled={
              busy ||
              !artifactState?.canRun ||
              bundleExecutionUnavailable ||
              !validationReady ||
              !isCurrentGraph()
            }
            onClick={() => void startRun()}
          >
            Create simulation run
          </button>
        </div>
      )}
      {bundleExecutionUnavailable && currentArtifact && (
        <p className="warning-notice">
          ESP-IDF bundles are stored and reviewable, and their request format is validated. This
          artifact cannot be submitted yet because no isolated compiler and execution service is
          connected to the worker.
        </p>
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
