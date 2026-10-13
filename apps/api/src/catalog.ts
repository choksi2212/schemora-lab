import { createHash } from 'node:crypto';
import { getCatalogRelease } from '@schemora/catalog';

/** JSON canonicalization used for stable release identity across processes. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

/** Return a validated copy of the bundled release and its content digest. */
export function currentCatalogRelease() {
  const release = getCatalogRelease();
  const sha256 = createHash('sha256').update(canonicalJson(release), 'utf8').digest('hex');
  return { release, sha256 };
}
