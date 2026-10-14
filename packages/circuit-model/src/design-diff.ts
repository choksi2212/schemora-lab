import type { CircuitGraph } from './schema.js';

export type CircuitDesignDifference = {
  kind:
    | 'component-added'
    | 'component-removed'
    | 'component-changed'
    | 'breadboard-added'
    | 'breadboard-removed'
    | 'breadboard-changed'
    | 'placement-added'
    | 'placement-removed'
    | 'placement-changed'
    | 'wire-added'
    | 'wire-removed'
    | 'wire-changed';
  identity: string;
  intended: unknown | null;
  working: unknown | null;
};

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return (
      '{' +
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => JSON.stringify(key) + ':' + canonical(child))
        .join(',') +
      '}'
    );
  }
  return JSON.stringify(value);
}

function indexed<T>(items: T[], key: (item: T) => string) {
  const result = new Map<string, T[]>();
  for (const item of items) {
    const identity = key(item);
    result.set(identity, [...(result.get(identity) ?? []), item]);
  }
  return result;
}

/** Compare two user-authored virtual graphs. This does not observe physical hardware. */
export function compareCircuitDesigns(
  intended: CircuitGraph,
  working: CircuitGraph,
): CircuitDesignDifference[] {
  if (intended.catalogReleaseId !== working.catalogReleaseId)
    throw new Error('DESIGN_DIFF_CATALOG_RELEASE_MISMATCH');
  const differences: CircuitDesignDifference[] = [];
  const compare = <T>(
    expected: T[],
    actual: T[],
    key: (item: T) => string,
    kind: string,
    equal: (left: T, right: T) => boolean = (left, right) => canonical(left) === canonical(right),
  ) => {
    const before = indexed(expected, key);
    const after = indexed(actual, key);
    for (const identity of [...new Set([...before.keys(), ...after.keys()])].sort()) {
      const left = before.get(identity) ?? [];
      const right = after.get(identity) ?? [];
      for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
        const expected = left[index];
        const actual = right[index];
        if (expected === undefined)
          differences.push({
            kind: (kind + '-added') as CircuitDesignDifference['kind'],
            identity,
            intended: null,
            working: actual,
          });
        else if (actual === undefined)
          differences.push({
            kind: (kind + '-removed') as CircuitDesignDifference['kind'],
            identity,
            intended: expected,
            working: null,
          });
        else if (!equal(expected, actual))
          differences.push({
            kind: (kind + '-changed') as CircuitDesignDifference['kind'],
            identity,
            intended: expected,
            working: actual,
          });
      }
    }
  };
  compare(intended.components, working.components, (item) => item.id, 'component');
  compare(
    intended.breadboards,
    working.breadboards,
    (item) => item.id,
    'breadboard',
    (left, right) =>
      canonical({
        ...left,
        railVariants: [...left.railVariants].sort((a, b) =>
          a.railGroupId.localeCompare(b.railGroupId),
        ),
      }) ===
      canonical({
        ...right,
        railVariants: [...right.railVariants].sort((a, b) =>
          a.railGroupId.localeCompare(b.railGroupId),
        ),
      }),
  );
  compare(
    intended.terminalPlacements,
    working.terminalPlacements,
    (item) => canonical(item.terminal),
    'placement',
  );
  compare(
    intended.wires,
    working.wires,
    (item) => canonical([canonical(item.source), canonical(item.target)].sort()),
    'wire',
    (left, right) =>
      canonical([canonical(left.source), canonical(left.target)].sort()) ===
      canonical([canonical(right.source), canonical(right.target)].sort()),
  );
  return differences;
}
