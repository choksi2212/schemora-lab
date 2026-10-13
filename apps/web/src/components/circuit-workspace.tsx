'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  Cable,
  CircleHelp,
  Redo2,
  RefreshCw,
  Save,
  ShieldAlert,
  Undo2,
  Zap,
} from 'lucide-react';
import { api, friendlyError, type Project } from '@/lib/api';
import { CircuitScene } from './circuit-scene';
import styles from './circuit-workspace.module.css';
import type { AssemblyPlan } from '@schemora/assembly-plan';
import {
  explainAssemblyStep,
  type ExplanationLevel,
  type TeachingExplanation,
} from '@schemora/teaching';

type Terminal = { id: string; label: string; electricalRole: string };
type Part = {
  id: string;
  manufacturer: string;
  model: string;
  category: string;
  terminals: Terminal[];
  sourceIds: string[];
  summary: string;
  limitations: string[];
  [key: string]: unknown;
};
type Catalog = {
  release: {
    releaseId: string;
    sources: { id: string; title: string; url: string }[];
    parts: Part[];
    breadboardTopologies: {
      id: string;
      version: number;
      name: string;
      terminalStripGroups: { holes: string[] }[];
      railGroups: { id: string; connectivityVariants: { id: string }[] }[];
    }[];
  };
};
type Endpoint =
  | { kind: 'terminal'; terminal: { componentInstanceId: string; catalogTerminalId: string } }
  | { kind: 'hole'; hole: { breadboardInstanceId: string; holeId: string } };
type Graph = {
  schemaVersion: 1;
  id: string;
  projectId: string;
  projectRevision: number;
  catalogReleaseId: string;
  components: { id: string; catalogPartId: string }[];
  breadboards: {
    id: string;
    topologyId: string;
    topologyVersion: number;
    railVariants: { railGroupId: string; variantId: string }[];
  }[];
  terminalPlacements: {
    terminal: { componentInstanceId: string; catalogTerminalId: string };
    hole: { breadboardInstanceId: string; holeId: string };
  }[];
  wires: { id: string; source: Endpoint; target: Endpoint }[];
  visualLayout?: {
    schemaVersion: 1;
    componentPlacements: {
      componentInstanceId: string;
      x: number;
      z: number;
      rotationY: number;
    }[];
  };
};
type Finding = {
  ruleId: string;
  status: string;
  severity: string;
  message: string;
  sourceIds: string[];
  affectedEntityIds: string[];
};
type Report = {
  status: string;
  findings: Finding[];
  graphDigest: string;
  catalogReleaseId: string;
  projectRevision: number;
};
type GraphResponse = { project: Project; graphSnapshot: { graph: Graph } | null };
type ValidationResponse = { report: { report: Report } | null; current?: boolean };
const starterParts = {
  board: 'board.espressif.esp32-devkitc-v4.wroom-32e.male',
  led: 'led.kingbright.wp7113id',
  resistor: 'resistor.yageo.cfr-25jb-52-220r',
};
const terminal = (componentInstanceId: string, catalogTerminalId: string): Endpoint => ({
  kind: 'terminal',
  terminal: { componentInstanceId, catalogTerminalId },
});
const uid = () => crypto.randomUUID();

function starterGraph(projectId: string, revision: number, catalog: Catalog['release']): Graph {
  const board = catalog.parts.find((p) => p.id === starterParts.board)!;
  const topology = catalog.breadboardTopologies[0]!;
  const chosenVariant = topology.railGroups.map((rail) => ({
    railGroupId: rail.id,
    variantId: rail.connectivityVariants[0]!.id,
  }));
  const graph: Graph = {
    schemaVersion: 1,
    id: uid(),
    projectId,
    projectRevision: revision + 1,
    catalogReleaseId: catalog.releaseId,
    components: [
      { id: 'board-1', catalogPartId: starterParts.board },
      { id: 'resistor-1', catalogPartId: starterParts.resistor },
      { id: 'led-1', catalogPartId: starterParts.led },
    ],
    breadboards: [
      {
        id: 'breadboard-1',
        topologyId: topology.id,
        topologyVersion: topology.version,
        railVariants: chosenVariant,
      },
    ],
    terminalPlacements: [],
    wires: [
      {
        id: 'wire-gpio-resistor',
        source: terminal('board-1', 'gpio19'),
        target: terminal('resistor-1', 'lead-a'),
      },
      {
        id: 'wire-resistor-led',
        source: terminal('resistor-1', 'lead-b'),
        target: terminal('led-1', 'anode'),
      },
      {
        id: 'wire-led-ground',
        source: terminal('led-1', 'cathode'),
        target: terminal('board-1', 'gnd-j3-1'),
      },
    ],
  };
  return graph;
}

export function CircuitWorkspace({ projectId }: { projectId: string }) {
  const [project, setProject] = useState<Project | null>(null);
  const [catalog, setCatalog] = useState<Catalog['release'] | null>(null);
  const [graph, setGraph] = useState<Graph | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [isCurrent, setIsCurrent] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [dirty, setDirty] = useState(false);
  const [undoStack, setUndoStack] = useState<Graph[]>([]);
  const [redoStack, setRedoStack] = useState<Graph[]>([]);
  const [assemblyPlan, setAssemblyPlan] = useState<AssemblyPlan | null>(null);
  const [assemblyStepIndex, setAssemblyStepIndex] = useState(0);
  const [completedAssemblySteps, setCompletedAssemblySteps] = useState<string[]>([]);
  const [skippedAssemblySteps, setSkippedAssemblySteps] = useState<string[]>([]);
  const [assemblyStale, setAssemblyStale] = useState(false);
  const [explanationLevel, setExplanationLevel] = useState<ExplanationLevel>('beginner');
  const [teaching, setTeaching] = useState<TeachingExplanation | null>(null);
  const load = useCallback(async () => {
    setError('');
    try {
      const [p, catalogIndex, saved, validation] = await Promise.all([
        api<{ project: Project }>(`/projects/${projectId}`),
        api<{ releases: { releaseId: string }[] }>('/catalog'),
        api<GraphResponse>(`/projects/${projectId}/circuit`),
        api<ValidationResponse>(`/projects/${projectId}/circuit/validation`).catch(
          (): ValidationResponse => ({ report: null }),
        ),
      ]);
      const releaseId =
        saved.graphSnapshot?.graph.catalogReleaseId ?? catalogIndex.releases[0]?.releaseId;
      if (!releaseId) throw new Error('The hardware catalog has no published release yet.');
      const c = await api<Catalog>(`/catalog/${encodeURIComponent(releaseId)}`);
      setProject(p.project);
      setCatalog(c.release);
      setGraph(
        saved.graphSnapshot?.graph ?? starterGraph(projectId, p.project.revision, c.release),
      );
      setUndoStack([]);
      setRedoStack([]);
      setDirty(!saved.graphSnapshot);
      setReport(validation.report?.report ?? null);
      setIsCurrent(validation.current !== false);
    } catch (cause) {
      setError(friendlyError(cause));
    }
  }, [projectId]);
  useEffect(() => {
    void load();
  }, [load]);
  const partMap = useMemo(
    () => new Map(catalog?.parts.map((part) => [part.id, part]) ?? []),
    [catalog],
  );
  const terminalOptions = useMemo(
    () =>
      graph?.components.flatMap((item) =>
        (partMap.get(item.catalogPartId)?.terminals ?? []).map((t) => ({
          key: `${item.id}/${t.id}`,
          label: `${partMap.get(item.catalogPartId)?.model}: ${t.label}`,
          ref: terminal(item.id, t.id),
        })),
      ) ?? [],
    [graph, partMap],
  );
  function edit(next: Graph) {
    if (graph) setUndoStack((history) => [...history.slice(-49), graph]);
    setRedoStack([]);
    setGraph(next);
    setDirty(true);
    setReport(null);
    setIsCurrent(false);
    setMessage('');
    setAssemblyStale(Boolean(assemblyPlan));
  }
  function undo() {
    if (!graph || undoStack.length === 0) return;
    const previous = undoStack.at(-1)!;
    setUndoStack((history) => history.slice(0, -1));
    setRedoStack((history) => [...history, graph]);
    setGraph(previous);
    setDirty(true);
    setReport(null);
    setIsCurrent(false);
    setMessage('Last circuit edit undone. Save to record this revision.');
  }
  function redo() {
    if (!graph || redoStack.length === 0) return;
    const next = redoStack.at(-1)!;
    setRedoStack((history) => history.slice(0, -1));
    setUndoStack((history) => [...history, graph]);
    setGraph(next);
    setDirty(true);
    setReport(null);
    setIsCurrent(false);
    setMessage('Circuit edit restored. Save to record this revision.');
  }
  function refresh() {
    if (
      dirty &&
      !window.confirm('Discard the unsaved circuit edits and load the latest saved revision?')
    )
      return;
    void load();
  }
  async function save() {
    if (!project || !graph || busy) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const payload = { ...graph, projectRevision: project.revision + 1 };
      const result = await api<{ project: Project; graphSnapshot: { graph: Graph } }>(
        `/projects/${projectId}/circuit`,
        { method: 'PUT', body: { expectedRevision: project.revision, graph: payload } },
      );
      setProject(result.project);
      setGraph(result.graphSnapshot.graph);
      setDirty(false);
      setMessage('Circuit saved.');
      setReport(null);
      setIsCurrent(false);
      setAssemblyStale(Boolean(assemblyPlan));
    } catch (cause) {
      setError(friendlyError(cause));
    } finally {
      setBusy(false);
    }
  }
  async function createAssemblyPlan() {
    if (!project || !report || !isCurrent || dirty || busy) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const result = await api<{ plan: AssemblyPlan; current: boolean }>(
        `/projects/${projectId}/assembly-plan`,
        { method: 'POST', body: { expectedRevision: project.revision } },
      );
      if (!result.current) throw new Error('The assembly guide is no longer current.');
      const storageKey = `schemora-assembly:${projectId}:${result.plan.planDigest}`;
      let progress: { completed: string[]; skipped: string[] } = { completed: [], skipped: [] };
      try {
        const saved = JSON.parse(window.localStorage.getItem(storageKey) ?? 'null');
        if (
          saved &&
          Array.isArray(saved.completed) &&
          Array.isArray(saved.skipped) &&
          saved.completed.every((id: unknown) => typeof id === 'string') &&
          saved.skipped.every((id: unknown) => typeof id === 'string')
        )
          progress = saved;
      } catch {
        /* Invalid local progress is ignored and replaced below. */
      }
      setAssemblyPlan(result.plan);
      setCompletedAssemblySteps(
        progress.completed.filter((id) => result.plan.steps.some((step) => step.id === id)),
      );
      setSkippedAssemblySteps(
        progress.skipped.filter((id) => result.plan.steps.some((step) => step.id === id)),
      );
      setAssemblyStepIndex(0);
      setAssemblyStale(false);
      setMessage('Deterministic assembly guide generated from the current saved circuit.');
    } catch (cause) {
      setError(friendlyError(cause));
    } finally {
      setBusy(false);
    }
  }
  function saveAssemblyProgress(completed: string[], skipped: string[]) {
    if (!assemblyPlan) return;
    setCompletedAssemblySteps(completed);
    setSkippedAssemblySteps(skipped);
    window.localStorage.setItem(
      `schemora-assembly:${projectId}:${assemblyPlan.planDigest}`,
      JSON.stringify({ completed, skipped }),
    );
  }
  async function validate() {
    if (!project || !graph || dirty || busy) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const result = await api<ValidationResponse>(`/projects/${projectId}/circuit/validate`, {
        method: 'POST',
        body: { expectedRevision: project.revision },
      });
      setReport(result.report?.report ?? null);
      setIsCurrent(result.current !== false);
      setMessage('Validation finished for the saved circuit.');
    } catch (cause) {
      setError(friendlyError(cause));
    } finally {
      setBusy(false);
    }
  }
  const activeAssemblyStep = assemblyPlan?.steps[assemblyStepIndex] ?? null;
  useEffect(() => {
    if (
      !assemblyPlan ||
      !activeAssemblyStep ||
      !graph ||
      !catalog ||
      !report ||
      !isCurrent ||
      assemblyStale
    ) {
      setTeaching(null);
      return;
    }
    let active = true;
    setTeaching(null);
    void explainAssemblyStep({
      step: activeAssemblyStep,
      graph,
      catalog,
      report,
      level: explanationLevel,
      expectedGraphDigest: assemblyPlan.graphDigest,
    })
      .then((result) => {
        if (active) setTeaching(result);
      })
      .catch(() => {
        if (active) setTeaching(null);
      });
    return () => {
      active = false;
    };
  }, [
    assemblyPlan,
    activeAssemblyStep,
    graph,
    catalog,
    report,
    isCurrent,
    assemblyStale,
    explanationLevel,
  ]);
  if (!catalog || !graph || !project)
    return (
      <div className="page">
        <Link href={`/projects/${projectId}`} className="back-link">
          <ArrowLeft size={15} /> Project
        </Link>
        {error ? (
          <div className="warning-notice" role="alert">
            {error}{' '}
            <button className="text-button" onClick={() => void load()}>
              Retry
            </button>
          </div>
        ) : (
          <p>Loading circuit workspace…</p>
        )}
      </div>
    );
  const board = graph.components.find((item) => item.catalogPartId === starterParts.board);
  const connectionRows = [
    {
      id: 'gpio-resistor',
      title: 'Board GPIO19 → resistor',
      defaults: ['board-1/gpio19', 'resistor-1/lead-a'],
    },
    {
      id: 'resistor-led',
      title: 'Resistor → LED anode',
      defaults: ['resistor-1/lead-b', 'led-1/anode'],
    },
    {
      id: 'led-ground',
      title: 'LED cathode → board GND',
      defaults: ['led-1/cathode', 'board-1/gnd-j3-1'],
    },
  ];
  const holes = Array.from({ length: 30 }, (_, i) => i + 1).flatMap((column) =>
    'ABCDEFGHIJ'.split('').map((row) => `${row}${column}`),
  );
  const completedSet = new Set(completedAssemblySteps);
  const prerequisitesComplete = Boolean(
    activeAssemblyStep?.prerequisites.every((id) => completedSet.has(id)),
  );
  return (
    <div className={`page ${styles.page}`}>
      <Link href={`/projects/${projectId}`} className="back-link">
        <ArrowLeft size={15} /> Back to project
      </Link>
      <div className="workspace-heading">
        <div>
          <span className="eyebrow">PHASE 3 · 3D WORKBENCH · REVISION {project.revision}</span>
          <h1>See and edit a circuit</h1>
          <p className="fine-text">
            Circuit facts are tied to the exact catalog release and project revision.
          </p>
        </div>
        <div className="workspace-actions">
          <button className="button secondary" onClick={undo} disabled={busy || !undoStack.length}>
            <Undo2 size={15} /> Undo
          </button>
          <button className="button secondary" onClick={redo} disabled={busy || !redoStack.length}>
            <Redo2 size={15} /> Redo
          </button>
          <button className="button secondary" onClick={refresh} disabled={busy}>
            <RefreshCw size={15} />
            {dirty ? 'Discard edits & refresh' : 'Refresh'}
          </button>
          <button className="button primary" onClick={() => void save()} disabled={busy || !dirty}>
            <Save size={15} />
            {busy ? 'Working…' : 'Save circuit'}
          </button>
        </div>
      </div>
      {error && (
        <div className="warning-notice" role="alert">
          {error}
          {error.includes('Refresh') && (
            <button className="text-button" onClick={refresh}>
              Discard edits and refresh latest
            </button>
          )}
        </div>
      )}
      {message && (
        <p className="success-notice" role="status">
          {message}
        </p>
      )}
      <section className="panel circuit-catalog-note">
        <div className="panel-heading">
          <h2>
            <Zap size={18} /> Exact starter configuration
          </h2>
          <span className="status-chip">{catalog.releaseId}</span>
        </div>
        <p>
          This workspace uses{' '}
          {board ? partMap.get(board.catalogPartId)?.model : 'the curated board'} with the
          catalogued WROOM-32E module and male headers, plus a named LED and resistor. This does not
          identify the hardware you physically own.
        </p>
        <p className="fine-text">
          {catalog.parts.find((p) => p.id === starterParts.board)?.limitations[0]}
        </p>
      </section>
      <CircuitScene
        graph={graph}
        onGraphChange={edit}
        currentGraphDigest={report && isCurrent && !dirty ? report.graphDigest : null}
      />
      <div className={styles.grid}>
        <section className="panel">
          <div className="panel-heading">
            <h2>
              <Cable size={18} /> Wiring
            </h2>
            <span className="fine-text">Terminal-to-terminal connections</span>
          </div>
          <p className="fine-text">
            Choose the two exact catalog terminals joined by each wire. These defaults show a GPIO →
            resistor → LED → ground path.
          </p>
          {connectionRows.map((row) => {
            const wireId = (
              {
                'gpio-resistor': 'wire-gpio-resistor',
                'resistor-led': 'wire-resistor-led',
                'led-ground': 'wire-led-ground',
              } as Record<string, string>
            )[row.id];
            const wire = graph.wires.find((w) => w.id === wireId);
            const refs =
              wire && wire.source.kind === 'terminal' && wire.target.kind === 'terminal'
                ? [wire.source.terminal, wire.target.terminal]
                : row.defaults.map((v) => {
                    const [componentInstanceId, catalogTerminalId] = v.split('/');
                    return {
                      componentInstanceId: componentInstanceId!,
                      catalogTerminalId: catalogTerminalId!,
                    };
                  });
            return (
              <div className={styles.connection} key={row.id}>
                <strong>{row.title}</strong>
                {[0, 1].map((side) => (
                  <label className="field-label" key={side}>
                    {side ? 'To' : 'From'}
                    <select
                      value={`${refs[side]!.componentInstanceId}/${refs[side]!.catalogTerminalId}`}
                      onChange={(e) => {
                        const chosen = terminalOptions.find((o) => o.key === e.target.value);
                        if (!chosen) return;
                        const source =
                          side === 0
                            ? chosen.ref
                            : terminal(refs[0]!.componentInstanceId, refs[0]!.catalogTerminalId);
                        const target =
                          side === 1
                            ? chosen.ref
                            : terminal(refs[1]!.componentInstanceId, refs[1]!.catalogTerminalId);
                        const wires = graph.wires.filter((w) => w.id !== wireId);
                        wires.push({ id: wireId, source, target });
                        edit({ ...graph, wires });
                      }}
                    >
                      {terminalOptions.map((o) => (
                        <option key={o.key} value={o.key}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
            );
          })}
        </section>
        <section className="panel">
          <div className="panel-heading">
            <h2>Terminal placement</h2>
            <span className="fine-text">Optional BB400 hole map</span>
          </div>
          <p className="fine-text">
            Assign a lead to a labeled hole when you know the physical position. Empty means no
            placement assertion.
          </p>
          {graph.components
            .flatMap((component) =>
              (partMap.get(component.catalogPartId)?.terminals ?? []).map((t) => ({
                component,
                t,
              })),
            )
            .map(({ component, t }) => {
              const ref = { componentInstanceId: component.id, catalogTerminalId: t.id };
              const placement = graph.terminalPlacements.find(
                (p) =>
                  p.terminal.componentInstanceId === component.id &&
                  p.terminal.catalogTerminalId === t.id,
              );
              return (
                <label className={styles.placement} key={`${component.id}/${t.id}`}>
                  <span>
                    {partMap.get(component.catalogPartId)?.model}
                    <small>{t.label}</small>
                  </span>
                  <select
                    aria-label={`Hole for ${t.label}`}
                    value={placement?.hole.holeId ?? ''}
                    onChange={(e) => {
                      const placements = graph.terminalPlacements.filter(
                        (p) =>
                          !(
                            p.terminal.componentInstanceId === component.id &&
                            p.terminal.catalogTerminalId === t.id
                          ),
                      );
                      if (e.target.value)
                        placements.push({
                          terminal: ref,
                          hole: { breadboardInstanceId: 'breadboard-1', holeId: e.target.value },
                        });
                      edit({ ...graph, terminalPlacements: placements });
                    }}
                  >
                    <option value="">Not placed</option>
                    {holes.map((h) => (
                      <option key={h} value={h}>
                        {h}
                      </option>
                    ))}
                  </select>
                </label>
              );
            })}
        </section>
      </div>
      <section className={`panel ${styles.validation}`}>
        <div className="panel-heading">
          <div>
            <h2>
              <ShieldAlert size={18} /> Deterministic checks
            </h2>
            <p className="fine-text">Runs against the saved graph. Save edits before validating.</p>
          </div>
          <button
            className="button primary"
            onClick={() => void validate()}
            disabled={busy || dirty || !graph.wires.length}
          >
            <Zap size={15} /> Validate saved circuit
          </button>
        </div>
        <p className="fine-text">
          <CircleHelp size={14} /> Electrical current limits, power budget, thermal behavior, and
          complete operating conditions remain unknown in this ruleset. A passing result is not a
          safety certification.
        </p>
        {dirty && (
          <p className="warning-notice">Unsaved changes: save this circuit to run validation.</p>
        )}
        {report && (
          <>
            <div className={`${styles.summary} status-${report.status}`}>
              <strong>{isCurrent ? 'Current report' : 'Report may be stale'}</strong>
              <span>
                {report.status.toUpperCase()} · revision {report.projectRevision} ·{' '}
                {report.catalogReleaseId}
              </span>
            </div>
            <ul className={styles.findings}>
              {report.findings.map((finding, index) => (
                <li key={`${finding.ruleId}-${index}`}>
                  <span className={`status-chip finding-${finding.status}`}>
                    {finding.status.replaceAll('_', ' ')}
                  </span>
                  <div>
                    <strong>{finding.ruleId}</strong>
                    <p>{finding.message}</p>
                    {finding.sourceIds.map((id) => {
                      const source = catalog.sources.find((s) => s.id === id);
                      return source ? (
                        <a key={id} href={source.url} target="_blank" rel="noreferrer">
                          {source.title}
                        </a>
                      ) : null;
                    })}
                  </div>
                </li>
              ))}
            </ul>
            <p className="fine-text">
              Unknown means the available model or rule cannot establish the result.
            </p>
          </>
        )}
      </section>
      <section className={`panel ${styles.assemblyGuide}`} aria-labelledby="assembly-guide-title">
        <div className="panel-heading">
          <div>
            <h2 id="assembly-guide-title">Assembly guide</h2>
            <p className="fine-text">
              Generated in a stable order from this saved graph and its current validation report.
            </p>
          </div>
          <div className="workspace-actions">
            {assemblyPlan && !assemblyStale && (
              <button className="button secondary" onClick={() => window.print()}>
                Print checklist
              </button>
            )}
            <button
              className="button primary"
              onClick={() => void createAssemblyPlan()}
              disabled={
                busy ||
                dirty ||
                !report ||
                !isCurrent ||
                report.status === 'fail' ||
                report.status === 'error'
              }
            >
              {assemblyPlan ? 'Regenerate guide' : 'Generate assembly guide'}
            </button>
          </div>
        </div>
        {!report || !isCurrent ? (
          <p className="warning-notice">
            Save the circuit and run current checks before generating an assembly guide.
          </p>
        ) : report.status === 'fail' || report.status === 'error' ? (
          <p className="warning-notice">
            Resolve failing circuit checks before generating an assembly guide.
          </p>
        ) : null}
        {assemblyPlan && assemblyStale && (
          <p className="warning-notice" role="status">
            The circuit changed after this guide was generated. Its progress remains tied to the old
            guide on this browser. Regenerate to follow the current circuit.
          </p>
        )}
        {assemblyPlan && !assemblyStale && activeAssemblyStep && (
          <>
            <div className={styles.assemblyMeta}>
              <strong>
                {completedAssemblySteps.length} of {assemblyPlan.steps.length} steps confirmed
              </strong>
              <span>
                Step {activeAssemblyStep.order} of {assemblyPlan.steps.length}
              </span>
              <span>Plan {assemblyPlan.planDigest.slice(0, 12)}</span>
            </div>
            <ol className={styles.assemblyList} aria-label="Assembly steps">
              {assemblyPlan.steps.map((step, index) => {
                const done = completedSet.has(step.id);
                const skipped = skippedAssemblySteps.includes(step.id);
                return (
                  <li key={step.id}>
                    <button
                      type="button"
                      aria-current={index === assemblyStepIndex ? 'step' : undefined}
                      onClick={() => setAssemblyStepIndex(index)}
                    >
                      <span>
                        {step.order}. {step.title}
                      </span>
                      <small>
                        {done ? 'Confirmed' : skipped ? 'Skipped · incomplete' : 'Remaining'}
                      </small>
                    </button>
                  </li>
                );
              })}
            </ol>
            <article className={styles.activeAssemblyStep} aria-live="polite">
              <span className="eyebrow">{activeAssemblyStep.action.replaceAll('_', ' ')}</span>
              <h3>{activeAssemblyStep.title}</h3>
              <p>{activeAssemblyStep.instruction}</p>
              <p className="fine-text">{activeAssemblyStep.explanation}</p>
              {teaching && (
                <section className={styles.teaching} aria-label="Contextual teaching">
                  <div className={styles.teachingHeading}>
                    <div>
                      <strong>Why this step?</strong>
                      <p className="fine-text">
                        Curated explanations for this step and the current circuit.
                      </p>
                    </div>
                    <div className={styles.levels} role="group" aria-label="Explanation detail">
                      {(['quick', 'beginner', 'detailed'] as const).map((level) => (
                        <button
                          type="button"
                          key={level}
                          aria-pressed={explanationLevel === level}
                          onClick={() => setExplanationLevel(level)}
                        >
                          {level[0]!.toUpperCase() + level.slice(1)}
                        </button>
                      ))}
                    </div>
                  </div>
                  {teaching.lessons.length ? (
                    teaching.lessons.map((lesson) => (
                      <article className={styles.lesson} key={lesson.id}>
                        <h4>{lesson.title}</h4>
                        <p>{lesson.text}</p>
                        {lesson.limitations.map((limitation) => (
                          <p className="fine-text" key={limitation}>
                            Limit: {limitation}
                          </p>
                        ))}
                        <div className={styles.citations} aria-label={`${lesson.title} sources`}>
                          {lesson.sources.map((source) => (
                            <a key={source.id} href={source.url} target="_blank" rel="noreferrer">
                              {source.title}
                              {source.locator ? ` · ${source.locator}` : ''}
                            </a>
                          ))}
                        </div>
                      </article>
                    ))
                  ) : (
                    <p className="fine-text">
                      No curated teaching card matches this exact step yet. The guide’s saved
                      targets remain authoritative.
                    </p>
                  )}
                  {teaching.findings.length > 0 && (
                    <div className={styles.teachingFindings}>
                      <strong>Current check explanations</strong>
                      {teaching.findings.map((finding, index) => (
                        <article key={`${finding.ruleId}-${index}`}>
                          <span className={`status-chip finding-${finding.status}`}>
                            {finding.status.replaceAll('_', ' ')}
                          </span>
                          <strong>{finding.ruleId}</strong>
                          <p>{finding.message}</p>
                          <p className="fine-text">{finding.explanation}</p>
                        </article>
                      ))}
                    </div>
                  )}
                </section>
              )}
              {activeAssemblyStep.anchors.length > 0 && (
                <ul aria-label="Exact targets">
                  {activeAssemblyStep.anchors.map((anchor, index) => (
                    <li key={`${anchor.kind}-${index}`}>
                      {anchor.kind === 'component'
                        ? `Component ${anchor.componentInstanceId}`
                        : anchor.kind === 'terminal'
                          ? `${anchor.componentInstanceId} · ${anchor.catalogTerminalId}`
                          : `${anchor.breadboardInstanceId} · hole ${anchor.holeId}`}
                    </li>
                  ))}
                </ul>
              )}
              {activeAssemblyStep.prerequisites.length > 0 && (
                <p className={prerequisitesComplete ? 'fine-text' : 'warning-notice'}>
                  {prerequisitesComplete
                    ? 'Prerequisites complete.'
                    : 'Complete the prerequisite steps before confirming this step.'}
                </p>
              )}
              {activeAssemblyStep.warnings.map((warning) => (
                <p className="warning-notice" key={warning}>
                  {warning}
                </p>
              ))}
              <div className={styles.assemblyActions}>
                <button
                  type="button"
                  className="button secondary"
                  disabled={assemblyStepIndex === 0}
                  onClick={() => setAssemblyStepIndex((index) => Math.max(0, index - 1))}
                >
                  Previous
                </button>
                <button
                  type="button"
                  className="button primary"
                  disabled={!prerequisitesComplete || completedSet.has(activeAssemblyStep.id)}
                  onClick={() =>
                    saveAssemblyProgress(
                      [...completedAssemblySteps, activeAssemblyStep.id],
                      skippedAssemblySteps.filter((id) => id !== activeAssemblyStep.id),
                    )
                  }
                >
                  I completed this step
                </button>
                <button
                  type="button"
                  className="button secondary"
                  onClick={() =>
                    saveAssemblyProgress(
                      completedAssemblySteps.filter((id) => id !== activeAssemblyStep.id),
                      [...new Set([...skippedAssemblySteps, activeAssemblyStep.id])],
                    )
                  }
                >
                  Skip for now
                </button>
                <button
                  type="button"
                  className="button secondary"
                  disabled={assemblyStepIndex >= assemblyPlan.steps.length - 1}
                  onClick={() =>
                    setAssemblyStepIndex((index) =>
                      Math.min(assemblyPlan.steps.length - 1, index + 1),
                    )
                  }
                >
                  Next
                </button>
              </div>
              <p className="fine-text">
                Next only changes the selected step. Completion and skip status are separate.
                Progress is saved in this browser and is not a physical verification.
              </p>
            </article>
            {assemblyPlan.warnings.map((warning) => (
              <p className="warning-notice" key={warning}>
                {warning}
              </p>
            ))}
            <p className="fine-text">
              Planner {assemblyPlan.plannerVersion} · graph {assemblyPlan.graphDigest.slice(0, 12)}{' '}
              · catalog {assemblyPlan.catalogReleaseId}
            </p>
          </>
        )}
      </section>
      <p className="fine-text circuit-footnote">
        Sources:{' '}
        {catalog.sources.map((source) => (
          <a key={source.id} href={source.url} target="_blank" rel="noreferrer">
            {source.title}
          </a>
        ))}
      </p>
    </div>
  );
}
