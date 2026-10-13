import {
  RepositoryError,
  type FirmwareArtifactFileRow,
  type Repository,
} from '@schemora/persistence';
import type { PrivateStorage } from '@schemora/storage';
import {
  createFirmwareProjectBundle,
  firmwareProjectTargetSchema,
  type FirmwareProjectBundle,
} from '@schemora/simulation';

export interface ResolveFirmwareSourceRequest {
  ownerId: string;
  projectId: string;
  artifactId: string;
}

const readConcurrency = 8;

/** Reconstruct only an accepted, immutable ESP-IDF source bundle for a trusted worker caller. */
export async function resolveFirmwareCompilerBundle(
  repository: Repository,
  storage: PrivateStorage,
  request: ResolveFirmwareSourceRequest,
): Promise<FirmwareProjectBundle> {
  const { artifact, files } = await repository.firmwareCompilerSource(
    request.ownerId,
    request.projectId,
    request.artifactId,
  );
  if (artifact.review_status !== 'accepted')
    throw new RepositoryError('FIRMWARE_REVIEW_REQUIRED', 409);
  if (
    artifact.build_system !== 'esp-idf' ||
    artifact.bundle_digest === null ||
    artifact.total_byte_length < 1 ||
    artifact.total_byte_length > 8_000_000
  )
    throw new RepositoryError('FIRMWARE_BUNDLE_UNSUPPORTED', 409);
  const target = firmwareProjectTargetSchema.safeParse(artifact.target);
  if (!target.success || target.data.kind !== 'esp-idf-target' || target.data.target !== 'esp32')
    throw new RepositoryError('FIRMWARE_TARGET_UNSUPPORTED', 409);
  if (
    files.length < 1 ||
    files.length > 128 ||
    files.filter((file) => file.is_entrypoint).length !== 1 ||
    files.find((file) => file.is_entrypoint)?.path !== artifact.entrypoint
  )
    throw new RepositoryError('FIRMWARE_BUNDLE_METADATA_INVALID', 409);

  const sourceFiles: { path: string; source: Uint8Array }[] = [];
  let totalByteLength = 0;
  for (let offset = 0; offset < files.length; offset += readConcurrency) {
    const batch = files.slice(offset, offset + readConcurrency);
    const loaded = await Promise.all(
      batch.map(async (file: FirmwareArtifactFileRow) => {
        if (file.byte_length < 1 || file.byte_length > 2_000_000)
          throw new RepositoryError('FIRMWARE_SOURCE_SIZE_INVALID', 409);
        const bytes = await storage.read(file.object_key, file.sha256);
        if (bytes.byteLength !== file.byte_length)
          throw new RepositoryError('FIRMWARE_SOURCE_LENGTH_MISMATCH', 409);
        return { path: file.path, source: Uint8Array.from(bytes) };
      }),
    );
    for (const file of loaded) {
      totalByteLength += file.source.byteLength;
      if (totalByteLength > 8_000_000)
        throw new RepositoryError('FIRMWARE_BUNDLE_SIZE_INVALID', 409);
      sourceFiles.push(file);
    }
  }
  if (totalByteLength !== artifact.total_byte_length)
    throw new RepositoryError('FIRMWARE_BUNDLE_LENGTH_MISMATCH', 409);

  let bundle: FirmwareProjectBundle;
  try {
    bundle = await createFirmwareProjectBundle({
      buildSystem: 'esp-idf',
      target: target.data,
      entrypoint: artifact.entrypoint,
      files: sourceFiles,
    });
  } catch {
    throw new RepositoryError('FIRMWARE_BUNDLE_INVALID', 409);
  }
  if (bundle.manifestDigest !== artifact.bundle_digest)
    throw new RepositoryError('FIRMWARE_BUNDLE_DIGEST_MISMATCH', 409);
  return bundle;
}
