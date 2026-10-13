import { describe, expect, it } from 'vitest';
import {
  canCancelQueuedRun,
  firmwareEntrypointError,
  firmwareGraphState,
  serialOutput,
} from './firmware-workspace-state';

describe('firmware workspace state', () => {
  it('only permits a run for accepted source bound to the exact current saved graph', () => {
    const current = {
      reviewStatus: 'accepted' as const,
      binding: { graphDigest: 'a'.repeat(64), graphRevision: 4 },
      currentGraphDigest: 'a'.repeat(64),
      currentGraphRevision: 4,
      graphDirty: false,
    };
    expect(firmwareGraphState(current)).toMatchObject({
      boundToCurrentGraph: true,
      canRun: true,
    });
    expect(firmwareGraphState({ ...current, currentGraphRevision: 5 }).canRun).toBe(false);
    expect(firmwareGraphState({ ...current, graphDirty: true }).canRun).toBe(false);
    expect(firmwareGraphState({ ...current, reviewStatus: 'pending' }).canRun).toBe(false);
    expect(firmwareGraphState({ ...current, reviewStatus: 'rejected' }).canRun).toBe(false);
  });

  it('shows only stored serial events and orders them by their sequence', () => {
    expect(
      serialOutput([
        { kind: 'led_state', sequence: 2, simulationTimeMs: 1 },
        { kind: 'serial', sequence: 4, simulationTimeMs: 2, stream: 'stderr', text: 'second' },
        { kind: 'serial', sequence: 1, simulationTimeMs: 0, stream: 'stdout', text: 'first' },
      ]),
    ).toEqual([
      { sequence: 1, simulationTimeMs: 0, stream: 'stdout', text: 'first' },
      { sequence: 4, simulationTimeMs: 2, stream: 'stderr', text: 'second' },
    ]);
  });

  it('matches entrypoint extensions to the firmware language', () => {
    expect(firmwareEntrypointError('arduino-cpp', 'src/main.cpp')).toBeNull();
    expect(firmwareEntrypointError('esp-idf-c', 'src/main.cpp')).toContain('extension');
    expect(firmwareEntrypointError('cpp', '../main.cpp')).toContain('relative');
  });

  it('offers cancellation only while a run remains queued', () => {
    expect(canCancelQueuedRun('queued')).toBe(true);
    expect(canCancelQueuedRun('preparing')).toBe(false);
    expect(canCancelQueuedRun('running')).toBe(false);
  });
});
