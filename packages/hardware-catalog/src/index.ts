export {
  boardSchema,
  catalogReleaseSchema,
  hardwarePartSchema,
  ledSchema,
  pushbuttonSchema,
  resistorSchema,
} from './schema.js';
export type {
  BreadboardTopology,
  CatalogClaim,
  CatalogPart,
  CatalogRelease,
  CatalogSource,
} from './schema.js';
export { catalogRelease2026_10 } from './release-2026-10.js';
export { catalogRelease2026_10_1 } from './release-2026-10-1.js';
export {
  getHardwareFamilyContract,
  hardwareFamilyContractSchema,
  hardwareFamilyContracts,
  parseHardwareFamilyContract,
} from './family-contract.js';
export type { HardwareFamilyContract } from './family-contract.js';

import { catalogReleaseSchema } from './schema.js';
import { catalogRelease2026_10 } from './release-2026-10.js';
import { catalogRelease2026_10_1 } from './release-2026-10-1.js';

const catalogReleases = [catalogRelease2026_10, catalogRelease2026_10_1] as const;

/** Parse and return every immutable catalog snapshot in release order. */
export function getCatalogReleases() {
  return catalogReleases.map((release) => catalogReleaseSchema.parse(release));
}

/** Resolve a pinned historical release without substituting the latest one. */
export function getCatalogReleaseById(releaseId: string) {
  const release = catalogReleases.find((candidate) => candidate.releaseId === releaseId);
  return release ? catalogReleaseSchema.parse(release) : undefined;
}

/** Parse and cross-check the latest curated release before consumption. */
export function getCatalogRelease() {
  return catalogReleaseSchema.parse(catalogRelease2026_10_1);
}
