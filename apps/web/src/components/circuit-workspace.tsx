'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Cable, CircleHelp, RefreshCw, Save, ShieldAlert, Zap } from 'lucide-react';
import { api, friendlyError, type Project } from '@/lib/api';
import styles from './circuit-workspace.module.css';

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
    setGraph(next);
    setDirty(true);
    setReport(null);
    setIsCurrent(false);
    setMessage('');
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
    } catch (cause) {
      setError(friendlyError(cause));
    } finally {
      setBusy(false);
    }
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
  return (
    <div className={`page ${styles.page}`}>
      <Link href={`/projects/${projectId}`} className="back-link">
        <ArrowLeft size={15} /> Back to project
      </Link>
      <div className="workspace-heading">
        <div>
          <span className="eyebrow">PHASE 2 · CIRCUIT WORKSPACE · REVISION {project.revision}</span>
          <h1>Build and check a circuit</h1>
          <p className="fine-text">
            Circuit facts are tied to the exact catalog release and project revision.
          </p>
        </div>
        <div className="workspace-actions">
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
