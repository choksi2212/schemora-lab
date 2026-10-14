import { createHash } from 'node:crypto';
import { getCatalogRelease, getCatalogReleaseById, getCatalogReleases } from '@schemora/catalog';

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
export function catalogReleaseById(releaseId: string) {
  const release = getCatalogReleaseById(releaseId);
  if (!release) return null;
  const sha256 = createHash('sha256').update(canonicalJson(release), 'utf8').digest('hex');
  return { release, sha256 };
}

export function currentCatalogRelease() {
  return catalogReleaseById(getCatalogRelease().releaseId)!;
}

export function catalogReleaseIndex() {
  return getCatalogReleases().map((release) => ({
    schemaVersion: release.schemaVersion,
    releaseId: release.releaseId,
    publishedOn: release.publishedOn,
    status: release.status,
    sha256: createHash('sha256').update(canonicalJson(release), 'utf8').digest('hex'),
    parts: release.parts,
  }));
}
