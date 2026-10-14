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
import { FirmwareWorkspace } from './firmware-workspace';
import type { SceneSimulationRun } from './simulation-scene-state';
import styles from './circuit-workspace.module.css';
import type { AssemblyPlan } from '@schemora/assembly-plan';
import type { CatalogRelease } from '@schemora/catalog';
import {
  createTransientSwitchOverlay,
  deriveNets,
  type TransientSwitchOverlay,
} from '@schemora/circuit-model';
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
  anodeTerminalId?: string;
  cathodeTerminalId?: string;
};
type Catalog = { release: CatalogRelease };
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
type GraphSnapshot = { id: string; projectRevision: number; graphDigest: string; graph: Graph };
type GraphResponse = { project: Project; graphSnapshot: GraphSnapshot | null };
type DesignDiffResponse = {
  comparable: boolean;
  reason: string | null;
  workingGraphSnapshotId: string | null;
  intent: {
    versionId: string;
    graphSnapshotId: string;
    graphDigest: string;
    confirmedAt: string;
  } | null;
  differences: { kind: string; identity: string; intended: unknown; working: unknown }[];
};
type ValidationResponse = { report: { report: Report } | null; current?: boolean };
type PrePowerCheck = { id: string; title: string; detail: string };
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

function describeEndpoint(endpoint: Endpoint, graph: Graph, parts: Map<string, Part>): string {
  if (endpoint.kind === 'hole')
    return `${endpoint.hole.breadboardInstanceId} · hole ${endpoint.hole.holeId}`;
  const component = graph.components.find(
    (item) => item.id === endpoint.terminal.componentInstanceId,
  );
  const part = component ? parts.get(component.catalogPartId) : undefined;
  const terminal = part?.terminals.find((item) => item.id === endpoint.terminal.catalogTerminalId);
  return `${endpoint.terminal.componentInstanceId} (${part?.model ?? component?.catalogPartId ?? 'component'}) · ${terminal?.label ?? endpoint.terminal.catalogTerminalId}`;
}

function makePrePowerChecklist(
  graph: Graph,
  parts: Map<string, Part>,
  report: Report,
): PrePowerCheck[] {
  const checks: PrePowerCheck[] = [
    {
      id: 'power-disconnected',
      title: 'Keep the real circuit disconnected from power during inspection.',
      detail: 'Do not connect USB, batteries, or an external supply until the review is complete.',
    },
    {
      id: 'physical-identities',
      title: 'Confirm each physical component matches its exact catalog model and configuration.',
      detail: graph.components
        .map((component) => {
          const part = parts.get(component.catalogPartId);
          return `${component.id}: ${part ? `${part.manufacturer} ${part.model}` : component.catalogPartId}`;
        })
        .join(' · '),
    },
    {
      id: 'board-power',
      title: 'Check board supply requirements and polarity against the manufacturer guide.',
      detail:
        'The virtual model does not establish the physical supply voltage, polarity, or current budget.',
    },
  ];
  for (const wire of graph.wires) {
    checks.push({
      id: `wire-${wire.id}`,
      title: `Inspect wire ${wire.id} against the real connection.`,
      detail: `${describeEndpoint(wire.source, graph, parts)} → ${describeEndpoint(wire.target, graph, parts)}`,
    });
  }
  for (const placement of graph.terminalPlacements) {
    checks.push({
      id: `placement-${placement.terminal.componentInstanceId}-${placement.terminal.catalogTerminalId}`,
      title: 'Check this terminal’s physical breadboard position.',
      detail: `${describeEndpoint({ kind: 'terminal', terminal: placement.terminal }, graph, parts)} → ${placement.hole.breadboardInstanceId} · hole ${placement.hole.holeId}`,
    });
  }
  for (const breadboard of graph.breadboards) {
    const topology = breadboard.topologyId;
    checks.push({
      id: `topology-${breadboard.id}`,
      title: 'Confirm the real breadboard matches the selected topology and rail variant.',
      detail: `${breadboard.id}: ${topology}; verify split rails and printed row labels on the actual board.`,
    });
  }
  const led = graph.components.find(
    (component) => parts.get(component.catalogPartId)?.category === 'led',
  );
  if (led) {
    const part = parts.get(led.catalogPartId)!;
    checks.push({
      id: `polarity-${led.id}`,
      title: 'Verify the LED anode and cathode orientation on the physical part.',
      detail: `Current graph: anode ${part.anodeTerminalId} · cathode ${part.cathodeTerminalId}. Use the manufacturer’s physical marking; do not infer polarity from color alone.`,
    });
  }
  const uncertain = report.findings.filter(
    (finding) =>
      finding.status === 'unknown' || finding.status === 'error' || finding.status === 'fail',
  );
  if (uncertain.length) {
    checks.push({
      id: 'unresolved-findings',
      title: 'Read and account for every failed or unknown digital finding.',
      detail: uncertain.map((finding) => `${finding.ruleId}: ${finding.message}`).join(' · '),
    });
  }
  return checks;
}

function relatedFaultWireIds(finding: Finding, graph: Graph): string[] {
  const ids = new Set(
    finding.affectedEntityIds
      .filter((id) => id.startsWith('wire:'))
      .map((id) => id.slice('wire:'.length)),
  );
  if (finding.ruleId === 'LED_SERIES_RESISTOR') {
    const componentIds = new Set(finding.affectedEntityIds.filter((id) => !id.startsWith('wire:')));
    for (const wire of graph.wires) {
      if (
        [wire.source, wire.target].some(
          (endpoint) =>
            endpoint.kind === 'terminal' && componentIds.has(endpoint.terminal.componentInstanceId),
        )
      )
        ids.add(wire.id);
    }
  }
  return [...ids].sort();
}

function describeDesignDifference(
  difference: DesignDiffResponse['differences'][number],
  graph: Graph,
  parts: Map<string, Part>,
): string {
  const record = (difference.working ?? difference.intended) as {
    id?: string;
    source?: Endpoint;
    target?: Endpoint;
  } | null;
  if (record?.source && record.target)
    return `${describeEndpoint(record.source, graph, parts)} → ${describeEndpoint(record.target, graph, parts)}`;
  if (record?.id) return record.id;
  if (difference.kind.startsWith('placement-')) {
    try {
      const terminalRef = JSON.parse(difference.identity) as {
        componentInstanceId?: string;
        catalogTerminalId?: string;
      };
      if (terminalRef.componentInstanceId && terminalRef.catalogTerminalId)
        return `${terminalRef.componentInstanceId} · ${terminalRef.catalogTerminalId}`;
    } catch {
      return 'Terminal placement';
    }
  }
  return difference.identity;
}

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
  const [latestCatalog, setLatestCatalog] = useState<Catalog['release'] | null>(null);
  const [catalogReleases, setCatalogReleases] = useState<Record<string, Catalog['release']>>({});
  const [graph, setGraph] = useState<Graph | null>(null);
  const [graphDigest, setGraphDigest] = useState<string | null>(null);
  const [graphSnapshotId, setGraphSnapshotId] = useState<string | null>(null);
  const [designDiff, setDesignDiff] = useState<DesignDiffResponse | null>(null);
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
  const [checkedPrePowerItems, setCheckedPrePowerItems] = useState<string[]>([]);
  const [assemblyPersistenceWarning, setAssemblyPersistenceWarning] = useState(false);
  const [assemblyStale, setAssemblyStale] = useState(false);
  const [activeDesignPanel, setActiveDesignPanel] = useState<'wiring' | 'placement'>('wiring');
  const [explanationLevel, setExplanationLevel] = useState<ExplanationLevel>('beginner');
  const [teaching, setTeaching] = useState<TeachingExplanation | null>(null);
  const [sceneSimulationRun, setSceneSimulationRun] = useState<SceneSimulationRun | null>(null);
  const [sceneFirmwareDigest, setSceneFirmwareDigest] = useState<string | null>(null);
  const [closedSwitchInstanceIds, setClosedSwitchInstanceIds] = useState<string[]>([]);
  const refreshDesignDiff = useCallback(async () => {
    try {
      setDesignDiff(await api<DesignDiffResponse>(`/projects/${projectId}/circuit/design-diff`));
    } catch {
      setDesignDiff(null);
    }
  }, [projectId]);
  const load = useCallback(async () => {
    setError('');
    try {
      const [p, catalogIndex, saved, validation, comparison] = await Promise.all([
        api<{ project: Project }>(`/projects/${projectId}`),
        api<{ currentReleaseId?: string; releases: { releaseId: string }[] }>('/catalog'),
        api<GraphResponse>(`/projects/${projectId}/circuit`),
        api<ValidationResponse>(`/projects/${projectId}/circuit/validation`).catch(
          (): ValidationResponse => ({ report: null }),
        ),
        api<DesignDiffResponse>(`/projects/${projectId}/circuit/design-diff`).catch(
          (): null => null,
        ),
      ]);
      const releaseId =
        saved.graphSnapshot?.graph.catalogReleaseId ?? catalogIndex.releases[0]?.releaseId;
      if (!releaseId) throw new Error('The hardware catalog has no published release yet.');
      const currentReleaseId = catalogIndex.currentReleaseId ?? catalogIndex.releases[0]?.releaseId;
      if (!currentReleaseId) throw new Error('The hardware catalog has no current release.');
      const [c, latest] = await Promise.all([
        api<Catalog>(`/catalog/${encodeURIComponent(releaseId)}`),
        releaseId === currentReleaseId
          ? api<Catalog>(`/catalog/${encodeURIComponent(releaseId)}`)
          : api<Catalog>(`/catalog/${encodeURIComponent(currentReleaseId)}`),
      ]);
      setProject(p.project);
      setCatalog(c.release);
      setLatestCatalog(latest.release);
      setCatalogReleases({
        [c.release.releaseId]: c.release,
        [latest.release.releaseId]: latest.release,
      });
      setGraph(
        saved.graphSnapshot?.graph ?? starterGraph(projectId, p.project.revision, c.release),
      );
      setGraphDigest(saved.graphSnapshot?.graphDigest ?? null);
      setGraphSnapshotId(saved.graphSnapshot?.id ?? null);
      setUndoStack([]);
      setRedoStack([]);
      setDirty(!saved.graphSnapshot);
      setReport(validation.report?.report ?? null);
      setIsCurrent(validation.current !== false);
      setDesignDiff(comparison);
    } catch (cause) {
      setError(friendlyError(cause));
    }
  }, [projectId]);
  const handleSceneRunChange = useCallback(
    (run: SceneSimulationRun | null, firmwareDigest: string | null) => {
      setSceneSimulationRun(run);
      setSceneFirmwareDigest(firmwareDigest);
    },
    [],
  );
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
  const switchOverlay = useMemo<TransientSwitchOverlay | null>(() => {
    if (!catalog || !graph) return null;
    if (
      !graph.components.some(
        (component) => partMap.get(component.catalogPartId)?.category === 'pushbutton',
      )
    )
      return null;
    try {
      return createTransientSwitchOverlay(
        graph,
        { release: catalog },
        closedSwitchInstanceIds.filter((id) =>
          graph.components.some((component) => component.id === id),
        ),
      );
    } catch {
      return null;
    }
  }, [catalog, closedSwitchInstanceIds, graph, partMap]);
  const circuitLevelNets = useMemo(() => {
    if (!catalog || !graph || !switchOverlay) return null;
    try {
      return deriveNets(graph, { release: catalog }, switchOverlay);
    } catch {
      return null;
    }
  }, [catalog, graph, switchOverlay]);
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
    const nextCatalog = catalogReleases[previous.catalogReleaseId];
    if (nextCatalog) setCatalog(nextCatalog);
    setUndoStack((history) => history.slice(0, -1));
    setRedoStack((history) => [...history, graph]);
    setGraph(previous);
    setDirty(true);
    setReport(null);
    setIsCurrent(false);
    setMessage('Last circuit edit undone. Save to record this revision.');
    setAssemblyStale(Boolean(assemblyPlan));
  }
  function redo() {
    if (!graph || redoStack.length === 0) return;
    const next = redoStack.at(-1)!;
    const nextCatalog = catalogReleases[next.catalogReleaseId];
    if (nextCatalog) setCatalog(nextCatalog);
    setRedoStack((history) => history.slice(0, -1));
    setUndoStack((history) => [...history, graph]);
    setGraph(next);
    setDirty(true);
    setReport(null);
    setIsCurrent(false);
    setMessage('Circuit edit restored. Save to record this revision.');
    setAssemblyStale(Boolean(assemblyPlan));
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
      const result = await api<{ project: Project; graphSnapshot: GraphSnapshot }>(
        `/projects/${projectId}/circuit`,
        { method: 'PUT', body: { expectedRevision: project.revision, graph: payload } },
      );
      setProject(result.project);
      setGraph(result.graphSnapshot.graph);
      setGraphDigest(result.graphSnapshot.graphDigest);
      setGraphSnapshotId(result.graphSnapshot.id);
      setDirty(false);
      setMessage('Circuit saved.');
      setReport(null);
      setIsCurrent(false);
      setAssemblyStale(Boolean(assemblyPlan));
      void refreshDesignDiff();
    } catch (cause) {
      setError(friendlyError(cause));
    } finally {
      setBusy(false);
    }
  }
  async function confirmCurrentAsIntended() {
    if (!project || !graphSnapshotId || dirty || busy) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await api(`/projects/${projectId}/circuit/design-intent`, {
        method: 'POST',
        body: { expectedRevision: project.revision, graphSnapshotId },
      });
      setMessage('Saved virtual graph confirmed as the intended design.');
      await load();
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
      let progress: { completed: string[]; skipped: string[]; prePowerChecks: string[] } = {
        completed: [],
        skipped: [],
        prePowerChecks: [],
      };
      try {
        const saved = JSON.parse(window.localStorage.getItem(storageKey) ?? 'null');
        if (
          saved &&
          Array.isArray(saved.completed) &&
          Array.isArray(saved.skipped) &&
          (saved.prePowerChecks === undefined || Array.isArray(saved.prePowerChecks)) &&
          saved.completed.every((id: unknown) => typeof id === 'string') &&
          saved.skipped.every((id: unknown) => typeof id === 'string') &&
          (saved.prePowerChecks === undefined ||
            saved.prePowerChecks.every((id: unknown) => typeof id === 'string'))
        ) {
          progress = { ...saved, prePowerChecks: saved.prePowerChecks ?? [] };
        }
      } catch {
        /* Invalid or unavailable local progress is ignored until a write is attempted. */
      }
      setAssemblyPlan(result.plan);
      setCompletedAssemblySteps(
        progress.completed.filter((id) => result.plan.steps.some((step) => step.id === id)),
      );
      setSkippedAssemblySteps(
        progress.skipped.filter((id) => result.plan.steps.some((step) => step.id === id)),
      );
      setCheckedPrePowerItems(progress.prePowerChecks);
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
    try {
      window.localStorage.setItem(
        `schemora-assembly:${projectId}:${assemblyPlan.planDigest}`,
        JSON.stringify({ completed, skipped, prePowerChecks: checkedPrePowerItems }),
      );
      setAssemblyPersistenceWarning(false);
    } catch {
      setAssemblyPersistenceWarning(true);
    }
  }
  function togglePrePowerCheck(checkId: string, checked: boolean) {
    if (!assemblyPlan) return;
    const next = checked
      ? [...new Set([...checkedPrePowerItems, checkId])]
      : checkedPrePowerItems.filter((id) => id !== checkId);
    setCheckedPrePowerItems(next);
    try {
      window.localStorage.setItem(
        `schemora-assembly:${projectId}:${assemblyPlan.planDigest}`,
        JSON.stringify({
          completed: completedAssemblySteps,
          skipped: skippedAssemblySteps,
          prePowerChecks: next,
        }),
      );
      setAssemblyPersistenceWarning(false);
    } catch {
      setAssemblyPersistenceWarning(true);
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
  const developmentBoards = graph.components.filter(
    (component) => partMap.get(component.catalogPartId)?.category === 'development-board',
  );
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
  const prePowerChecklist =
    report && isCurrent && !dirty ? makePrePowerChecklist(graph, partMap, report) : [];
  const prePowerReviewComplete =
    activeAssemblyStep?.action !== 'pre_power_checklist' ||
    (prePowerChecklist.length > 0 &&
      prePowerChecklist.every((item) => checkedPrePowerItems.includes(item.id)));
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
      {latestCatalog && latestCatalog.releaseId !== catalog.releaseId && (
        <section className="panel" aria-labelledby="catalog-upgrade-title">
          <h2 id="catalog-upgrade-title">New hardware release available</h2>
          <p className="fine-text">
            This graph is pinned to {catalog.releaseId}. Upgrade it to {latestCatalog.releaseId} to
            use newly published parts. Existing part IDs remain available in this release; the
            upgrade changes the graph's catalog identity and must be saved and validated.
          </p>
          <button
            type="button"
            className="button secondary"
            disabled={
              busy ||
              !graph.components.every((component) =>
                latestCatalog.parts.some((part) => part.id === component.catalogPartId),
              )
            }
            onClick={() => {
              setCatalog(latestCatalog);
              edit({ ...graph, catalogReleaseId: latestCatalog.releaseId });
            }}
          >
            Upgrade design catalog
          </button>
        </section>
      )}
      <CircuitScene
        key={graph.components.map((component) => component.id).join(':')}
        graph={graph}
        onGraphChange={edit}
        buttonStates={Object.fromEntries(
          closedSwitchInstanceIds.map((instanceId) => [instanceId, true]),
        )}
        simulationRun={sceneSimulationRun}
        currentGraphDigest={report && isCurrent && !dirty ? report.graphDigest : null}
        currentFirmwareDigest={sceneFirmwareDigest}
      />
      {catalog.parts.some((part) => part.category === 'pushbutton') && (
        <section className="panel" aria-labelledby="switch-model-title">
          <div className="panel-heading">
            <h2 id="switch-model-title">Momentary switch · circuit-level interaction</h2>
            <span className="status-chip">Ideal contact model</span>
          </div>
          <p className="fine-text">
            Add an exact OMRON B3F-1000, connect its labeled terminals, then hold Press to close its
            two contact groups. This changes only the transient modeled net view; it does not edit
            the saved graph or run firmware. Contact bounce, resistance, electrical levels, and
            physical fit are not simulated.
          </p>
          <div className="workspace-actions">
            <button
              type="button"
              className="button secondary"
              disabled={
                busy ||
                graph.components.some((part) => part.catalogPartId === 'button.omron.b3f-1000')
              }
              onClick={() => {
                const buttonPart = catalog.parts.find(
                  (part) => part.id === 'button.omron.b3f-1000',
                );
                if (!buttonPart) return;
                edit({
                  ...graph,
                  components: [
                    ...graph.components,
                    { id: `button-${uid()}`, catalogPartId: buttonPart.id },
                  ],
                });
              }}
            >
              Add B3F-1000
            </button>
            {graph.components
              .filter((component) => component.catalogPartId === 'button.omron.b3f-1000')
              .map((component) => {
                const pressed = closedSwitchInstanceIds.includes(component.id);
                return (
                  <span key={component.id} className="workspace-actions">
                    <button
                      type="button"
                      className={pressed ? 'button primary' : 'button secondary'}
                      aria-pressed={pressed}
                      onPointerDown={() =>
                        setClosedSwitchInstanceIds((current) =>
                          current.includes(component.id) ? current : [...current, component.id],
                        )
                      }
                      onPointerUp={() =>
                        setClosedSwitchInstanceIds((current) =>
                          current.filter((id) => id !== component.id),
                        )
                      }
                      onPointerLeave={() =>
                        setClosedSwitchInstanceIds((current) =>
                          current.filter((id) => id !== component.id),
                        )
                      }
                      onPointerCancel={() =>
                        setClosedSwitchInstanceIds((current) =>
                          current.filter((id) => id !== component.id),
                        )
                      }
                      onKeyDown={(event) => {
                        if (event.key === ' ' || event.key === 'Enter')
                          setClosedSwitchInstanceIds((current) =>
                            current.includes(component.id) ? current : [...current, component.id],
                          );
                      }}
                      onKeyUp={() =>
                        setClosedSwitchInstanceIds((current) =>
                          current.filter((id) => id !== component.id),
                        )
                      }
                      onBlur={() =>
                        setClosedSwitchInstanceIds((current) =>
                          current.filter((id) => id !== component.id),
                        )
                      }
                    >
                      {pressed ? 'Pressed · release' : 'Press and hold'}
                    </button>
                    <button
                      type="button"
                      className="button secondary"
                      disabled={busy}
                      onClick={() => {
                        edit({
                          ...graph,
                          components: graph.components.filter((item) => item.id !== component.id),
                          wires: graph.wires.filter((wire) => {
                            const touches = (endpoint: Endpoint) =>
                              endpoint.kind === 'terminal' &&
                              endpoint.terminal.componentInstanceId === component.id;
                            return !touches(wire.source) && !touches(wire.target);
                          }),
                          terminalPlacements: graph.terminalPlacements.filter(
                            (placement) => placement.terminal.componentInstanceId !== component.id,
                          ),
                          visualLayout: graph.visualLayout
                            ? {
                                ...graph.visualLayout,
                                componentPlacements: graph.visualLayout.componentPlacements.filter(
                                  (placement) => placement.componentInstanceId !== component.id,
                                ),
                              }
                            : undefined,
                        });
                        setClosedSwitchInstanceIds((current) =>
                          current.filter((id) => id !== component.id),
                        );
                      }}
                    >
                      Remove switch
                    </button>
                    <span className="fine-text" role="status">
                      {pressed
                        ? 'The modeled contact bridge is closed.'
                        : 'The modeled contact bridge is open.'}{' '}
                      {circuitLevelNets
                        ? `${circuitLevelNets.length} modeled nets in this transient state.`
                        : 'Net state unavailable while the circuit contains invalid edits.'}
                    </span>
                  </span>
                );
              })}
          </div>
        </section>
      )}
      <FirmwareWorkspace
        project={project}
        projectId={projectId}
        graphRevision={graph.projectRevision}
        graphDigest={graphDigest}
        graphDirty={dirty}
        validationReady={Boolean(
          report &&
          isCurrent &&
          report.graphDigest === graphDigest &&
          report.status !== 'fail' &&
          report.status !== 'error' &&
          !report.findings.some(
            (finding) => finding.status === 'fail' || finding.status === 'error',
          ),
        )}
        boardPartId={developmentBoards.length === 1 ? developmentBoards[0]!.catalogPartId : null}
        onProjectChange={setProject}
        onSceneRunChange={handleSceneRunChange}
      />
      <div className={styles.grid}>
        <div className={styles.responsivePanelNav} role="group" aria-label="Circuit design panels">
          <button
            type="button"
            aria-pressed={activeDesignPanel === 'wiring'}
            onClick={() => setActiveDesignPanel('wiring')}
          >
            Wiring
          </button>
          <button
            type="button"
            aria-pressed={activeDesignPanel === 'placement'}
            onClick={() => setActiveDesignPanel('placement')}
          >
            Terminal placement
          </button>
        </div>
        <section
          className={`panel ${styles.designPanel}`}
          data-visible={activeDesignPanel === 'wiring'}
          aria-label="Wiring"
        >
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
        <section
          className={`panel ${styles.designPanel}`}
          data-visible={activeDesignPanel === 'placement'}
          aria-label="Terminal placement"
        >
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
        <div className={styles.designComparison}>
          <div>
            <h3>Intended design comparison</h3>
            <p className="fine-text">
              This compares saved virtual graphs. It does not observe or verify physical wiring.
            </p>
          </div>
          <button
            type="button"
            className="button secondary"
            disabled={busy || dirty || !graphSnapshotId}
            onClick={() => void confirmCurrentAsIntended()}
          >
            {designDiff?.intent ? 'Replace intended design' : 'Confirm saved graph as intended'}
          </button>
          {designDiff?.intent ? (
            designDiff.comparable ? (
              <>
                <p role="status">
                  {designDiff.differences.length === 0
                    ? 'The current saved virtual graph matches the confirmed intended graph.'
                    : `${designDiff.differences.length} modeled graph difference${designDiff.differences.length === 1 ? '' : 's'} found.`}
                </p>
                {designDiff.differences.length > 0 && (
                  <ul className={styles.findings} aria-label="Virtual graph differences">
                    {designDiff.differences.map((difference, index) => (
                      <li key={`${difference.kind}-${difference.identity}-${index}`}>
                        <div>
                          <strong>{difference.kind.replaceAll('-', ' ')}</strong>
                          <p>{describeDesignDifference(difference, graph, partMap)}</p>
                          <details>
                            <summary>View modeled values</summary>
                            <pre>
                              {JSON.stringify(
                                {
                                  identity: difference.identity,
                                  intended: difference.intended,
                                  working: difference.working,
                                },
                                null,
                                2,
                              )}
                            </pre>
                          </details>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            ) : (
              <p className="warning-notice">
                Comparison unavailable: {designDiff.reason?.replaceAll('_', ' ').toLowerCase()}.
                Confirm a new intended graph from the current catalog release to compare again.
              </p>
            )
          ) : (
            <p className="fine-text">
              Confirm a saved graph to establish a separately versioned target for later
              comparisons.
            </p>
          )}
          {dirty && (
            <p className="warning-notice">Save edits to compare the updated virtual graph.</p>
          )}
        </div>
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
                    {finding.status === 'fail' && (
                      <p className={styles.correctionGuidance}>
                        <strong>Correction:</strong>{' '}
                        {finding.ruleId === 'POWER_GROUND_SHORT'
                          ? 'Keep power disconnected. Inspect the identified wires and remove or reroute the unintended conductive bridge, then save and validate again.'
                          : finding.ruleId === 'LED_POLARITY'
                            ? 'Keep power disconnected. Compare the LED’s physical anode/cathode markings with the named graph endpoints and correct the orientation, then save and validate again.'
                            : finding.ruleId === 'LED_SERIES_RESISTOR'
                              ? 'Keep power disconnected. Trace the modeled source-to-ground path through the LED and ensure every such path passes through a resistor; remove any bypass, then save and validate again.'
                              : 'Review the reported graph path and correct it against the intended project design, then save and validate again.'}
                      </p>
                    )}
                    {relatedFaultWireIds(finding, graph).length > 0 && (
                      <ul className={styles.affectedWires} aria-label="Affected virtual wires">
                        {relatedFaultWireIds(finding, graph).map((wireId) => {
                          const id = `wire:${wireId}`;
                          const wire = graph.wires.find((item) => item.id === wireId);
                          return (
                            <li key={id}>
                              {wire
                                ? `${describeEndpoint(wire.source, graph, partMap)} → ${describeEndpoint(wire.target, graph, partMap)}`
                                : wireId}
                            </li>
                          );
                        })}
                      </ul>
                    )}
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
              {activeAssemblyStep.action === 'pre_power_checklist' && (
                <section
                  className={styles.prePowerChecklist}
                  aria-label="Physical pre-power checklist"
                >
                  <div className={styles.prePowerHeading}>
                    <strong>Inspect the real circuit before connecting power</strong>
                    <span>
                      {
                        checkedPrePowerItems.filter((id) =>
                          prePowerChecklist.some((item) => item.id === id),
                        ).length
                      }{' '}
                      of {prePowerChecklist.length} checked
                    </span>
                  </div>
                  <p className="warning-notice">
                    These checks record your inspection only. Schemora cannot observe physical
                    wiring or certify that the circuit is safe.
                  </p>
                  <p className="fine-text" aria-live="polite">
                    {assemblyPersistenceWarning
                      ? 'This browser could not save checklist progress. Your checks remain visible only until this page closes.'
                      : 'Checklist progress is saved in this browser for this guide. It does not sync to other devices.'}
                  </p>
                  <ul>
                    {prePowerChecklist.map((item) => (
                      <li key={item.id}>
                        <label>
                          <input
                            type="checkbox"
                            checked={checkedPrePowerItems.includes(item.id)}
                            onChange={(event) => togglePrePowerCheck(item.id, event.target.checked)}
                          />
                          <span>
                            <strong>{item.title}</strong>
                            <small>{item.detail}</small>
                          </span>
                        </label>
                      </li>
                    ))}
                  </ul>
                  {report && (
                    <p className="fine-text">
                      Digital report: {report.status.toUpperCase()} · revision{' '}
                      {report.projectRevision} · graph {report.graphDigest.slice(0, 12)}. Unknown
                      checks remain unknown after you complete this physical inspection.
                    </p>
                  )}
                </section>
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
                  disabled={
                    !prerequisitesComplete ||
                    !prePowerReviewComplete ||
                    completedSet.has(activeAssemblyStep.id)
                  }
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
                  disabled={activeAssemblyStep.action === 'pre_power_checklist'}
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
