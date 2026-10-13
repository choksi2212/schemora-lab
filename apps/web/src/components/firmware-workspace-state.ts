export type FirmwareBinding = { graphDigest: string; graphRevision: number };
export type FirmwareLanguage = 'c' | 'cpp' | 'arduino-cpp' | 'esp-idf-c';

export function firmwareEntrypointError(language: FirmwareLanguage, entrypoint: string) {
  if (!/^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(c|cc|cpp)$/.test(entrypoint))
    return 'Use a relative .c, .cc, or .cpp entrypoint path with no spaces.';
  const cLanguage = language === 'c' || language === 'esp-idf-c';
  if (cLanguage !== entrypoint.endsWith('.c'))
    return 'The entrypoint extension must match the selected source language.';
  if (!cLanguage && !/\.(cc|cpp)$/.test(entrypoint))
    return 'C++ firmware entrypoints must end in .cc or .cpp.';
  return null;
}

export function canCancelQueuedRun(status: string) {
  return status === 'queued';
}

export type FirmwareArtifactState = {
  reviewStatus: 'accepted' | 'pending' | 'rejected';
  binding: FirmwareBinding | null;
  currentGraphDigest: string | null;
  currentGraphRevision: number | null;
  graphDirty: boolean;
};

export function firmwareGraphState(state: FirmwareArtifactState) {
  const boundToCurrentGraph = Boolean(
    !state.graphDirty &&
    state.binding &&
    state.currentGraphDigest &&
    state.binding.graphDigest === state.currentGraphDigest &&
    state.binding.graphRevision === state.currentGraphRevision,
  );
  return {
    boundToCurrentGraph,
    label: boundToCurrentGraph ? 'Matches current saved circuit' : 'Circuit binding is stale',
    canRun: boundToCurrentGraph && state.reviewStatus === 'accepted',
  };
}

export type SerialEvent = {
  kind: string;
  sequence: number;
  simulationTimeMs: number;
  stream?: string;
  text?: string;
};

export function serialOutput(events: SerialEvent[]) {
  return events
    .filter(
      (event): event is SerialEvent & { kind: 'serial'; text: string; stream: string } =>
        event.kind === 'serial' && typeof event.text === 'string',
    )
    .sort((left, right) => left.sequence - right.sequence)
    .map((event) => ({
      sequence: event.sequence,
      simulationTimeMs: event.simulationTimeMs,
      stream: event.stream,
      text: event.text,
    }));
}
