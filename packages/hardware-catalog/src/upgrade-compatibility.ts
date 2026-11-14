import type { CatalogRelease } from './schema.js';

export type CatalogUpgradeReferences = {
  componentPartIds: string[];
  topologies: Array<{ id: string; version: number }>;
};

export type CatalogUpgradeDifference = {
  kind: 'part' | 'topology' | 'claim' | 'source';
  id: string;
  reason: 'missing' | 'changed';
};

export type CatalogUpgradeAssessment = {
  compatible: boolean;
  differences: CatalogUpgradeDifference[];
};

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(',')}}`;
}

function same(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right);
}

/**
 * A release change may carry a graph forward only when every referenced part,
 * topology, claim, and source remains exactly equivalent. New unrelated
 * catalog records are additive and do not invalidate an existing graph.
 */
export function assessCatalogUpgrade(
  from: CatalogRelease,
  to: CatalogRelease,
  references: CatalogUpgradeReferences,
): CatalogUpgradeAssessment {
  const differences: CatalogUpgradeDifference[] = [];
  const usedSourceIds = new Set<string>();

  const compareSubject = (kind: 'part' | 'topology', id: string, left: unknown, right: unknown) => {
    if (!left || !right) {
      differences.push({ kind, id, reason: 'missing' });
      return;
    }
    if (!same(left, right)) differences.push({ kind, id, reason: 'changed' });

    const leftClaims = from.claims.filter((claim) => claim.subjectId === id);
    const rightClaims = to.claims.filter((claim) => claim.subjectId === id);
    if (!same(leftClaims, rightClaims)) differences.push({ kind: 'claim', id, reason: 'changed' });
    for (const claim of [...leftClaims, ...rightClaims]) usedSourceIds.add(claim.sourceId);
  };

  const fromParts = new Map(from.parts.map((part) => [part.id, part]));
  const toParts = new Map(to.parts.map((part) => [part.id, part]));
  for (const id of [...new Set(references.componentPartIds)].sort()) {
    const oldPart = fromParts.get(id);
    const newPart = toParts.get(id);
    compareSubject('part', id, oldPart, newPart);
    for (const sourceId of [...(oldPart?.sourceIds ?? []), ...(newPart?.sourceIds ?? [])])
      usedSourceIds.add(sourceId);
  }

  const fromTopologies = new Map(
    from.breadboardTopologies.map((topology) => [`${topology.id}@${topology.version}`, topology]),
  );
  const toTopologies = new Map(
    to.breadboardTopologies.map((topology) => [`${topology.id}@${topology.version}`, topology]),
  );
  for (const reference of references.topologies) {
    const key = `${reference.id}@${reference.version}`;
    const oldTopology = fromTopologies.get(key);
    const newTopology = toTopologies.get(key);
    compareSubject('topology', key, oldTopology, newTopology);
    for (const sourceId of [...(oldTopology?.sourceIds ?? []), ...(newTopology?.sourceIds ?? [])])
      usedSourceIds.add(sourceId);
  }

  const fromSources = new Map(from.sources.map((source) => [source.id, source]));
  const toSources = new Map(to.sources.map((source) => [source.id, source]));
  for (const id of [...usedSourceIds].sort()) {
    const oldSource = fromSources.get(id);
    const newSource = toSources.get(id);
    if (!oldSource || !newSource) differences.push({ kind: 'source', id, reason: 'missing' });
    else if (!same(oldSource, newSource))
      differences.push({ kind: 'source', id, reason: 'changed' });
  }

  return {
    compatible: differences.length === 0,
    differences,
  };
}
