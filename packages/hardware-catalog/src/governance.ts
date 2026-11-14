import { z } from 'zod';
import { catalogReleaseSchema, type CatalogRelease } from './schema.js';

const recordDeltaSchema = z
  .object({
    added: z.array(z.string()),
    changed: z.array(z.string()),
    removed: z.array(z.string()),
  })
  .strict();

const releaseDeltaSchema = z
  .object({
    parts: recordDeltaSchema,
    topologies: recordDeltaSchema,
    sources: recordDeltaSchema,
    claims: recordDeltaSchema,
  })
  .strict();

const catalogHistoryRecordSchema = z
  .object({
    releaseId: z.string().min(1),
    contentSha256: z.string().regex(/^[a-f0-9]{64}$/),
    classification: z.enum([
      'initial',
      'additive-part',
      'corrected-claim',
      'deprecated-identity',
      'topology-change',
      'migration-required',
      'display-only',
    ]),
    summary: z.string().min(1),
    delta: releaseDeltaSchema.nullable(),
    independentReview: z
      .object({
        status: z.enum(['pending', 'approved']),
        reviewer: z.string().min(1).nullable(),
        reviewedOn: z.string().date().nullable(),
      })
      .strict(),
  })
  .strict();

export const catalogHistoryManifestSchema = z
  .object({ schemaVersion: z.literal(1), releases: z.array(catalogHistoryRecordSchema).min(1) })
  .strict();

export type CatalogHistoryManifest = z.infer<typeof catalogHistoryManifestSchema>;
export type CatalogHistoryResult = {
  valid: boolean;
  publicationReady: boolean;
  issues: string[];
  pendingIndependentReviews: string[];
};
type RecordDelta = z.infer<typeof recordDeltaSchema>;

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(',')}}`;
}

function diffRecords<T>(previous: T[], current: T[], keyOf: (value: T) => string): RecordDelta {
  const before = new Map(previous.map((value) => [keyOf(value), value]));
  const after = new Map(current.map((value) => [keyOf(value), value]));
  const added: string[] = [];
  const changed: string[] = [];
  const removed: string[] = [];
  for (const [key, value] of after) {
    const oldValue = before.get(key);
    if (oldValue === undefined) added.push(key);
    else if (stableJson(oldValue) !== stableJson(value)) changed.push(key);
  }
  for (const key of before.keys()) if (!after.has(key)) removed.push(key);
  return {
    added: added.sort(),
    changed: changed.sort(),
    removed: removed.sort(),
  };
}

function claimKey(claim: CatalogRelease['claims'][number]): string {
  return `${claim.subjectId}|${claim.property}|${claim.sourceId}|${claim.locator}`;
}

function expectedDelta(previous: CatalogRelease, current: CatalogRelease) {
  return {
    parts: diffRecords(previous.parts, current.parts, (part) => part.id),
    topologies: diffRecords(
      previous.breadboardTopologies,
      current.breadboardTopologies,
      (topology) => topology.id,
    ),
    sources: diffRecords(previous.sources, current.sources, (source) => source.id),
    claims: diffRecords(previous.claims, current.claims, claimKey),
  };
}

/**
 * Validate chronological catalog history and require every published change to
 * have an explicit, machine-checkable classification and reviewer state.
 * Independent approval remains a separate publication gate.
 */
export function validateCatalogHistory(
  input: unknown,
  rawManifest: unknown,
  actualContentSha256: Record<string, string>,
): CatalogHistoryResult {
  const issues: string[] = [];
  const pendingIndependentReviews: string[] = [];
  const historyResult = z.array(catalogReleaseSchema).min(1).safeParse(input);
  const manifestResult = catalogHistoryManifestSchema.safeParse(rawManifest);
  if (!historyResult.success) issues.push('One or more catalog releases fail the release schema.');
  if (!manifestResult.success) issues.push('Catalog history manifest does not match its schema.');
  if (!historyResult.success || !manifestResult.success)
    return { valid: false, publicationReady: false, issues, pendingIndependentReviews };

  const releases = historyResult.data;
  const manifest = manifestResult.data;
  const releaseIds = releases.map((release) => release.releaseId);
  const recordIds = manifest.releases.map((record) => record.releaseId);
  if (new Set(releaseIds).size !== releaseIds.length)
    issues.push('Catalog release IDs must be unique.');
  if (new Set(recordIds).size !== recordIds.length)
    issues.push('Each release must have exactly one history record.');
  if (
    releaseIds.length !== recordIds.length ||
    releaseIds.some((id, index) => id !== recordIds[index])
  )
    issues.push('History records must list every release exactly once in published order.');

  for (let index = 0; index < releases.length; index += 1) {
    const release = releases[index]!;
    const record = manifest.releases[index];
    const previous = releases[index - 1];
    if (previous && previous.publishedOn >= release.publishedOn)
      issues.push(`${release.releaseId}: publication dates must increase strictly.`);
    if (!record || record.releaseId !== release.releaseId) continue;
    if (record.contentSha256 !== actualContentSha256[release.releaseId])
      issues.push(
        `${release.releaseId}: content SHA-256 does not match the release history record.`,
      );
    if (record.independentReview.status === 'approved') {
      if (!record.independentReview.reviewer || !record.independentReview.reviewedOn)
        issues.push(`${release.releaseId}: approved review requires reviewer identity and date.`);
    } else {
      if (record.independentReview.reviewer || record.independentReview.reviewedOn)
        issues.push(
          `${release.releaseId}: pending review cannot claim a reviewer or approval date.`,
        );
      pendingIndependentReviews.push(release.releaseId);
    }

    if (!previous) {
      if (record.classification !== 'initial' || record.delta !== null)
        issues.push(
          `${release.releaseId}: first release must be classified initial with no delta.`,
        );
      continue;
    }
    const actual = expectedDelta(previous, release);
    if (!record.delta || stableJson(record.delta) !== stableJson(actual))
      issues.push(
        `${release.releaseId}: declared release delta does not match the catalog contents.`,
      );
    if (
      actual.topologies.added.length +
        actual.topologies.changed.length +
        actual.topologies.removed.length >
        0 &&
      record.classification !== 'topology-change' &&
      record.classification !== 'migration-required'
    )
      issues.push(
        `${release.releaseId}: topology changes require topology-change or migration-required classification.`,
      );
    if (
      actual.parts.removed.length > 0 &&
      record.classification !== 'deprecated-identity' &&
      record.classification !== 'migration-required'
    )
      issues.push(
        `${release.releaseId}: removed parts require deprecation or migration classification.`,
      );
    if (
      actual.parts.changed.length + actual.claims.changed.length + actual.sources.changed.length >
        0 &&
      record.classification !== 'corrected-claim' &&
      record.classification !== 'migration-required'
    )
      issues.push(
        `${release.releaseId}: changed catalog facts require correction or migration classification.`,
      );
    if (
      actual.parts.added.length > 0 &&
      actual.parts.changed.length + actual.parts.removed.length === 0 &&
      record.classification !== 'additive-part' &&
      record.classification !== 'migration-required'
    )
      issues.push(`${release.releaseId}: newly added parts require additive-part classification.`);
  }

  return {
    valid: issues.length === 0,
    publicationReady: issues.length === 0 && pendingIndependentReviews.length === 0,
    issues,
    pendingIndependentReviews,
  };
}
