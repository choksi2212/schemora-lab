import { randomUUID } from 'node:crypto';
import { RepositoryError, type Repository } from '@schemora/persistence';
import type { PrivateBuildStorage, PrivateStorage } from '@schemora/storage';
import { compileFirmwareProject, type FirmwareCompilerSandbox } from '@schemora/simulation';
import { z } from 'zod';
import type { FirmwareCompilerProfileRegistry } from './firmware-compiler-profiles.js';
import { resolveFirmwareCompilerBundle } from './firmware-source.js';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const firmwareBuildRequestSchema = z
  .object({
    ownerId: z.string().regex(uuidPattern),
    projectId: z.string().regex(uuidPattern),
    sourceArtifactId: z.string().regex(uuidPattern),
    idempotencyKey: z.string().regex(uuidPattern),
    profileId: z.string().min(1).max(100),
  })
  .strict();

export interface PersistFirmwareBuildRequest {
  ownerId: string;
  projectId: string;
  sourceArtifactId: string;
  idempotencyKey: string;
  profileId: string;
}

/**
 * Run through the isolated compiler adapter, stage verified binaries under
 * durable upload intents, and atomically persist metadata and manifests in
 * PostgreSQL. Object storage remains a separately cleaned-up system.
 * This boundary is deliberately not wired to ordinary worker jobs yet.
 */
export async function compileAndPersistFirmwareBuild(
  repository: Repository,
  storage: PrivateStorage & PrivateBuildStorage,
  sandbox: FirmwareCompilerSandbox,
  profiles: FirmwareCompilerProfileRegistry,
  requestInput: PersistFirmwareBuildRequest,
) {
  const parsedRequest = firmwareBuildRequestSchema.safeParse(requestInput);
  if (!parsedRequest.success) throw new RepositoryError('INVALID_FIRMWARE_BUILD', 400);
  const request = parsedRequest.data;
  const profile = profiles.resolve(request.profileId);
  const prior = await repository.existingFirmwareBuild(
    request.ownerId,
    request.projectId,
    request.sourceArtifactId,
    request.idempotencyKey,
    profile,
  );
  if (prior) return prior;

  const bundle = await resolveFirmwareCompilerBundle(repository, storage, {
    ownerId: request.ownerId,
    projectId: request.projectId,
    artifactId: request.sourceArtifactId,
  });
  const compiled = await compileFirmwareProject(bundle, profile, sandbox);
  const buildId = randomUUID();
  const objects = compiled.result.artifacts.map((artifact) => ({
    role: artifact.role,
    path: artifact.path,
    objectKey: randomUUID(),
    sha256: artifact.sha256,
    byteLength: artifact.byteLength,
    bytes: compiled.artifacts[artifact.path],
  }));
  if (objects.some((object) => !object.bytes))
    throw new Error('FIRMWARE_COMPILE_ARTIFACTS_INCOMPLETE');

  const objectKeys = objects.map((object) => object.objectKey);
  if (objectKeys.length)
    await repository.registerUploadIntents(request.ownerId, request.projectId, objectKeys);

  const attemptedKeys = new Set<string>();
  let persistenceStarted = false;
  try {
    for (const object of objects) {
      attemptedKeys.add(object.objectKey);
      const actualDigest = await storage.putBuildArtifact(object.objectKey, object.bytes!);
      if (actualDigest !== object.sha256) throw new Error('FIRMWARE_BUILD_OBJECT_DIGEST_MISMATCH');
    }
    persistenceStarted = true;
    return await repository.persistFirmwareBuild(request.ownerId, request.projectId, {
      id: buildId,
      sourceArtifactId: request.sourceArtifactId,
      idempotencyKey: request.idempotencyKey,
      profile,
      result: compiled.result,
      artifacts: objects.map(({ role, path, objectKey, sha256, byteLength }) => ({
        role,
        path,
        objectKey,
        sha256,
        byteLength,
      })),
    });
  } catch (error) {
    // Before a DB commit attempt, delete any possibly written object now. Keep
    // every intent until expiry so ambiguous/late object writes remain tracked.
    if (!persistenceStarted) {
      await Promise.allSettled(
        [...attemptedKeys].map((objectKey) => storage.deleteBuildArtifact(objectKey)),
      );
    }
    throw error;
  }
}
