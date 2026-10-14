import { describe, expect, it } from 'vitest';
import {
  canCancelQueuedRun,
  firmwareEntrypointError,
  firmwareGraphState,
  resolveFirmwareDiagnosticLocation,
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

  it('resolves compiler locations only to exact artifact paths and never invents component attribution', () => {
    const files = [
      { path: 'main/main.c', source: 'void app_main(void) {}' },
      { path: 'components/led/led.c', source: 'void led_on(void) {}' },
    ];
    expect(
      resolveFirmwareDiagnosticLocation(
        {
          sourcePath: 'components/led/led.c',
          line: 8,
          column: 3,
          endLine: 8,
          endColumn: 12,
        },
        files,
      ),
    ).toEqual({
      file: files[1],
      location: {
        path: 'components/led/led.c',
        line: 8,
        column: 3,
        endLine: 8,
        endColumn: 12,
      },
      sourceLocationAvailable: true,
      sourceFileAvailable: true,
      componentAttributionAvailable: false,
    });
    expect(
      resolveFirmwareDiagnosticLocation(
        { sourcePath: 'main/../private.c', line: 1, column: 1 },
        files,
      ),
    ).toMatchObject({
      file: null,
      sourceLocationAvailable: true,
      sourceFileAvailable: false,
      componentAttributionAvailable: false,
    });
    expect(
      resolveFirmwareDiagnosticLocation({ sourcePath: null, line: null, column: null }, files),
    ).toMatchObject({
      file: null,
      location: null,
      sourceLocationAvailable: false,
      sourceFileAvailable: false,
      componentAttributionAvailable: false,
    });
  });

  it('offers cancellation only while a run remains queued', () => {
    expect(canCancelQueuedRun('queued')).toBe(true);
    expect(canCancelQueuedRun('preparing')).toBe(false);
    expect(canCancelQueuedRun('running')).toBe(false);
  });
});
