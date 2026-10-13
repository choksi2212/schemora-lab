export {
  boardSchema,
  catalogReleaseSchema,
  hardwarePartSchema,
  ledSchema,
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

import { catalogReleaseSchema } from './schema.js';
import { catalogRelease2026_10 } from './release-2026-10.js';

/** Parse and cross-check a release before it is consumed or persisted. */
export function getCatalogRelease() {
  return catalogReleaseSchema.parse(catalogRelease2026_10);
}
