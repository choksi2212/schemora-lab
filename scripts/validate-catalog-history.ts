import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  getCatalogReleases,
  validateCatalogHistory,
} from '../packages/hardware-catalog/src/index.js';

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

const releases = getCatalogReleases();
const actualContentSha256 = Object.fromEntries(
  releases.map((release) => [
    release.releaseId,
    createHash('sha256').update(canonicalJson(release), 'utf8').digest('hex'),
  ]),
);
const manifest = JSON.parse(
  readFileSync(
    new URL('../packages/hardware-catalog/catalog-history.json', import.meta.url),
    'utf8',
  ),
) as unknown;
const result = validateCatalogHistory(releases, manifest, actualContentSha256);
console.log(
  JSON.stringify(
    {
      catalogReleaseCount: releases.length,
      contentSha256: actualContentSha256,
      historyValid: result.valid,
      publicationReady: result.publicationReady,
      pendingIndependentReviews: result.pendingIndependentReviews,
      issues: result.issues,
    },
    null,
    2,
  ),
);
if (!result.valid) process.exitCode = 1;
