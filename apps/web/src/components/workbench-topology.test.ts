import { describe, expect, it } from 'vitest';
import { getWorkbenchHoleTargets, pointForBb400Hole } from './workbench-topology';

const breadboard = {
  id: 'breadboard-1',
  topologyId: 'breadboard.busboard.bb400',
  topologyVersion: 1,
};

describe('BB400 workbench topology projection', () => {
  it('maps every declared terminal-strip and rail hole to one stable scene target', () => {
    const targets = getWorkbenchHoleTargets('schemora-hw-2026.10.1', [breadboard]);
    expect(targets).toHaveLength(400);
    expect(new Set(targets.map(({ holeId }) => holeId)).size).toBe(400);
    expect(
      targets.every(
        ({ breadboardInstanceId, position }) =>
          breadboardInstanceId === breadboard.id && position.every(Number.isFinite),
      ),
    ).toBe(true);
  });

  it('does not substitute an unknown release, topology, or topology version', () => {
    expect(getWorkbenchHoleTargets('unknown-release', [breadboard])).toEqual([]);
    expect(
      getWorkbenchHoleTargets('schemora-hw-2026.10.1', [{ ...breadboard, topologyId: 'unknown' }]),
    ).toEqual([]);
    expect(
      getWorkbenchHoleTargets('schemora-hw-2026.10.1', [{ ...breadboard, topologyVersion: 2 }]),
    ).toEqual([]);
  });

  it('rejects labels outside the declared coordinate convention', () => {
    for (const holeId of ['A0', 'A31', 'K1', 'rail-0:1', 'rail-1:26', 'not-a-hole'])
      expect(pointForBb400Hole(holeId)).toBeNull();
  });
});
