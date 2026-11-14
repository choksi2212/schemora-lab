import { getCatalogReleaseById } from '@schemora/catalog';

export type WorkbenchHoleTarget = {
  breadboardInstanceId: string;
  holeId: string;
  position: [number, number, number];
};

/**
 * BB400 presentation anchors for the declared hole identities. These coordinates are
 * illustrative scene units; they do not claim a physical fit or calibrated scale.
 */
export function pointForBb400Hole(holeId: string): [number, number, number] | null {
  const terminal = /^([A-J])(\d{1,2})$/.exec(holeId);
  if (terminal) {
    const row = terminal[1]!.charCodeAt(0) - 65;
    const column = Number(terminal[2]);
    if (column < 1 || column > 30) return null;
    return [
      -3.65 + (column - 1) * 0.25,
      0.195,
      row < 5 ? 0.55 + row * 0.25 : -0.55 - (row - 5) * 0.25,
    ];
  }
  const rail = /^rail-([1-4]):(\d{1,2})$/.exec(holeId);
  if (rail) {
    const row = Number(rail[1]);
    const column = Number(rail[2]);
    if (column < 1 || column > 25) return null;
    return [
      -3.15 + (column - 1) * 0.25,
      0.195,
      row < 3 ? 1.55 + (row - 1) * 0.18 : -1.55 - (row - 3) * 0.18,
    ];
  }
  return null;
}

/** Enumerates only holes declared by the graph's exact, pinned catalog topology. */
export function getWorkbenchHoleTargets(
  catalogReleaseId: string,
  breadboards: Array<{ id: string; topologyId: string; topologyVersion: number }>,
): WorkbenchHoleTarget[] {
  const release = getCatalogReleaseById(catalogReleaseId);
  if (!release) return [];
  return breadboards.flatMap((breadboard) => {
    const topology = release.breadboardTopologies.find(
      (candidate) =>
        candidate.id === breadboard.topologyId &&
        candidate.version === breadboard.topologyVersion &&
        candidate.id === 'breadboard.busboard.bb400',
    );
    if (!topology) return [];
    const holeIds = [
      ...topology.terminalStripGroups.flatMap((group) => group.holes),
      ...topology.railGroups.flatMap((rail) =>
        rail.connectivityVariants.flatMap((variant) => variant.connectedHoleSets.flat()),
      ),
    ];
    return holeIds.flatMap((holeId) => {
      const position = pointForBb400Hole(holeId);
      return position ? [{ breadboardInstanceId: breadboard.id, holeId, position }] : [];
    });
  });
}
