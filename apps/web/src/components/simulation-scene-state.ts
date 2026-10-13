import type { CircuitWorkbenchGraph } from './circuit-scene';

export type SceneSimulationRun = {
  status: string;
  binding: {
    projectId: string;
    projectRevision: number;
    graphId: string;
    graphDigest: string;
    catalogReleaseId: string;
    firmwareDigest: string;
  };
  events: readonly unknown[];
};

export type SceneLedState = 'on' | 'off';

const sha256Pattern = /^[a-f0-9]{64}$/;

/**
 * Resolve only completed LED events bound to the exact current project, graph,
 * catalog, and firmware snapshot. Missing current digests mean no state is safe
 * to display. Any malformed event invalidates the whole scene update.
 */
export function resolveSimulationLedStates(input: {
  graph: CircuitWorkbenchGraph;
  run: SceneSimulationRun | null | undefined;
  currentGraphDigest: string | null | undefined;
  currentFirmwareDigest: string | null | undefined;
}): Readonly<Record<string, SceneLedState>> {
  const { graph, run, currentGraphDigest, currentFirmwareDigest } = input;
  if (
    !run ||
    run.status !== 'completed' ||
    !currentGraphDigest ||
    !sha256Pattern.test(currentGraphDigest) ||
    !currentFirmwareDigest ||
    !sha256Pattern.test(currentFirmwareDigest)
  ) {
    return {};
  }

  const binding = run.binding;
  if (
    !binding ||
    binding.projectId !== graph.projectId ||
    binding.projectRevision !== graph.projectRevision ||
    binding.graphId !== graph.id ||
    binding.graphDigest !== currentGraphDigest ||
    binding.catalogReleaseId !== graph.catalogReleaseId ||
    binding.firmwareDigest !== currentFirmwareDigest
  ) {
    return {};
  }
  if (!Array.isArray(run.events) || run.events.length > 5_000) return {};

  const components = new Map(graph.components.map((component) => [component.id, component]));
  const states = new Map<string, SceneLedState>();
  let previousSequence = -1;
  let previousTime = -1;

  for (const event of run.events) {
    if (!event || typeof event !== 'object' || Array.isArray(event)) return {};
    const candidate = event as Record<string, unknown>;
    const { kind, sequence, simulationTimeMs } = candidate;
    if (
      !Number.isSafeInteger(sequence) ||
      (sequence as number) < 0 ||
      (sequence as number) <= previousSequence ||
      typeof simulationTimeMs !== 'number' ||
      !Number.isFinite(simulationTimeMs) ||
      simulationTimeMs < 0 ||
      simulationTimeMs < previousTime
    ) {
      return {};
    }
    previousSequence = sequence as number;
    previousTime = simulationTimeMs;

    if (kind === 'serial') {
      if (
        typeof candidate.text !== 'string' ||
        candidate.text.length > 1_024 ||
        (candidate.stream !== 'stdout' && candidate.stream !== 'stderr')
      ) {
        return {};
      }
      continue;
    }

    if (kind === 'sensor_reading') {
      if (
        typeof candidate.componentInstanceId !== 'string' ||
        typeof candidate.sensorId !== 'string' ||
        typeof candidate.value !== 'number' ||
        !Number.isFinite(candidate.value) ||
        typeof candidate.unit !== 'string' ||
        candidate.unit.length < 1 ||
        candidate.unit.length > 40
      ) {
        return {};
      }
      continue;
    }

    if (kind !== 'led_state') return {};
    const componentInstanceId = candidate.componentInstanceId;
    const state = candidate.state;
    if (typeof componentInstanceId !== 'string' || (state !== 'on' && state !== 'off')) {
      return {};
    }
    const component = components.get(componentInstanceId);
    if (component?.catalogPartId !== 'led.kingbright.wp7113id') return {};
    states.set(componentInstanceId, state);
  }

  return Object.fromEntries(states);
}
