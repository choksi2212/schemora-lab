export type FirmwareBinding = { graphDigest: string; graphRevision: number };
export type FirmwareLanguage = 'c' | 'cpp' | 'arduino-cpp' | 'esp-idf-c';

export type FirmwareDiagnosticLocation = {
  sourcePath: string | null;
  line: number | null;
  column: number | null;
  endLine?: number | null;
  endColumn?: number | null;
};

/**
 * Resolve compiler-provided locations only against the exact source paths in
 * the selected immutable artifact. A compiler location identifies source text;
 * the current result contract does not identify schematic components.
 */
export function resolveFirmwareDiagnosticLocation<T extends { path: string }>(
  diagnostic: FirmwareDiagnosticLocation,
  sourceFiles: readonly T[],
) {
  const hasPosition =
    typeof diagnostic.sourcePath === 'string' &&
    Number.isInteger(diagnostic.line) &&
    diagnostic.line !== null &&
    diagnostic.line > 0 &&
    Number.isInteger(diagnostic.column) &&
    diagnostic.column !== null &&
    diagnostic.column > 0;
  const file = hasPosition
    ? (sourceFiles.find((sourceFile) => sourceFile.path === diagnostic.sourcePath) ?? null)
    : null;

  return {
    file,
    location: hasPosition
      ? {
          path: diagnostic.sourcePath!,
          line: diagnostic.line!,
          column: diagnostic.column!,
          endLine: diagnostic.endLine ?? null,
          endColumn: diagnostic.endColumn ?? null,
        }
      : null,
    sourceLocationAvailable: hasPosition,
    sourceFileAvailable: file !== null,
    componentAttributionAvailable: false as const,
  };
}

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

export function canRequestRunStop(status: string) {
  return status === 'preparing' || status === 'running';
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
