import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, unlink, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectVersionsCommand,
} from '@aws-sdk/client-s3';

export const MAX_SOURCE_BYTES = 10 * 1024 * 1024;
export const MAX_BUILD_ARTIFACT_BYTES = 64 * 1024 * 1024;

export interface PrivateStorage {
  put(key: string, bytes: Uint8Array): Promise<string>;
  read(key: string, expectedDigest: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

/** Larger immutable compiler outputs use a separate size class from user uploads. */
export interface PrivateBuildStorage {
  putBuildArtifact(key: string, bytes: Uint8Array): Promise<string>;
  readBuildArtifact(
    key: string,
    expectedDigest: string,
    expectedByteLength: number,
  ): Promise<Buffer>;
  deleteBuildArtifact(key: string): Promise<void>;
}

function validateKey(key: string) {
  if (!/^[a-f0-9-]{36}$/.test(key)) throw new Error('Invalid object identifier');
}

function digest(bytes: Uint8Array) {
  return createHash('sha256').update(bytes).digest('hex');
}

function verify(bytes: Buffer, expectedDigest: string) {
  if (bytes.length > MAX_SOURCE_BYTES || digest(bytes) !== expectedDigest) {
    throw new Error('Source integrity verification failed');
  }
  return bytes;
}

/** Local adapter is deliberately single-host and forbidden in production. */
export class FileStorage implements PrivateStorage, PrivateBuildStorage {
  private readonly directory: string;
  constructor(directory: string, environment: string) {
    if (environment !== 'development' && environment !== 'test') {
      throw new Error('Filesystem storage is restricted to development and tests');
    }
    this.directory = resolve(directory);
  }
  async put(key: string, bytes: Uint8Array) {
    validateKey(key);
    if (bytes.length > MAX_SOURCE_BYTES) throw new Error('Source too large');
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await writeFile(join(this.directory, key), bytes, { flag: 'wx', mode: 0o600 });
    return digest(bytes);
  }
  async read(key: string, expectedDigest: string) {
    validateKey(key);
    const metadata = await stat(join(this.directory, key));
    if (!metadata.isFile() || metadata.size > MAX_SOURCE_BYTES)
      throw new Error('Invalid source object size');
    return verify(await readFile(join(this.directory, key)), expectedDigest);
  }
  async delete(key: string) {
    validateKey(key);
    await unlink(join(this.directory, key)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
  async putBuildArtifact(key: string, bytes: Uint8Array) {
    validateKey(key);
    if (bytes.length > MAX_BUILD_ARTIFACT_BYTES) throw new Error('Build artifact too large');
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await writeFile(join(this.directory, key), bytes, { flag: 'wx', mode: 0o600 });
    return digest(bytes);
  }
  async readBuildArtifact(key: string, expectedDigest: string, expectedByteLength: number) {
    validateKey(key);
    if (
      !Number.isSafeInteger(expectedByteLength) ||
      expectedByteLength <= 0 ||
      expectedByteLength > MAX_BUILD_ARTIFACT_BYTES
    )
      throw new Error('Invalid build artifact size');
    const metadata = await stat(join(this.directory, key));
    if (!metadata.isFile() || metadata.size !== expectedByteLength)
      throw new Error('Invalid build artifact size');
    const bytes = await readFile(join(this.directory, key));
    if (bytes.length > MAX_BUILD_ARTIFACT_BYTES || digest(bytes) !== expectedDigest)
      throw new Error('Build artifact integrity verification failed');
    return bytes;
  }
  async deleteBuildArtifact(key: string) {
    return this.delete(key);
  }
}

/** Bucket must deny public access; SDK credentials come from its standard provider chain. */
export class S3Storage implements PrivateStorage, PrivateBuildStorage {
  private readonly client: S3Client;
  constructor(
    private readonly bucket: string,
    region: string,
  ) {
    if (!bucket || !region) throw new Error('S3 bucket and region are required');
    this.client = new S3Client({ region, maxAttempts: 3 });
  }
  async put(key: string, bytes: Uint8Array) {
    validateKey(key);
    if (bytes.length > MAX_SOURCE_BYTES) throw new Error('Source too large');
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: bytes,
        ContentType: 'application/octet-stream',
        IfNoneMatch: '*',
        ChecksumSHA256: createHash('sha256').update(bytes).digest('base64'),
        ServerSideEncryption: 'AES256',
      }),
      { abortSignal: AbortSignal.timeout(30_000) },
    );
    return digest(bytes);
  }
  async read(key: string, expectedDigest: string) {
    validateKey(key);
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      abortSignal: AbortSignal.timeout(30_000),
    });
    if (!result.Body || !result.ContentLength || result.ContentLength > MAX_SOURCE_BYTES) {
      (result.Body as { destroy?: () => void } | undefined)?.destroy?.();
      throw new Error('Invalid source object size');
    }
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of result.Body as AsyncIterable<Uint8Array>) {
      length += chunk.length;
      if (length > MAX_SOURCE_BYTES) {
        (result.Body as { destroy?: () => void }).destroy?.();
        throw new Error('Source too large');
      }
      chunks.push(Buffer.from(chunk));
    }
    return verify(Buffer.concat(chunks), expectedDigest);
  }
  async delete(key: string) {
    validateKey(key);
    // A delete marker alone does not purge private bytes from a versioned bucket.
    let keyMarker: string | undefined;
    let versionMarker: string | undefined;
    for (let page = 0; page < 20; page++) {
      const versions = await this.client.send(
        new ListObjectVersionsCommand({
          Bucket: this.bucket,
          Prefix: key,
          MaxKeys: 1000,
          KeyMarker: keyMarker,
          VersionIdMarker: versionMarker,
        }),
        { abortSignal: AbortSignal.timeout(30_000) },
      );
      for (const version of [...(versions.Versions ?? []), ...(versions.DeleteMarkers ?? [])]) {
        if (version.Key === key && version.VersionId)
          await this.client.send(
            new DeleteObjectCommand({
              Bucket: this.bucket,
              Key: key,
              VersionId: version.VersionId,
            }),
            { abortSignal: AbortSignal.timeout(30_000) },
          );
      }
      if (!versions.IsTruncated) break;
      if (page === 19) throw new Error('Source version purge limit exceeded');
      keyMarker = versions.NextKeyMarker;
      versionMarker = versions.NextVersionIdMarker;
    }
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }), {
      abortSignal: AbortSignal.timeout(30_000),
    });
  }
  async putBuildArtifact(key: string, bytes: Uint8Array) {
    validateKey(key);
    if (bytes.length > MAX_BUILD_ARTIFACT_BYTES) throw new Error('Build artifact too large');
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: bytes,
        ContentType: 'application/octet-stream',
        IfNoneMatch: '*',
        ChecksumSHA256: createHash('sha256').update(bytes).digest('base64'),
        ServerSideEncryption: 'AES256',
      }),
      { abortSignal: AbortSignal.timeout(60_000) },
    );
    return digest(bytes);
  }
  async readBuildArtifact(key: string, expectedDigest: string, expectedByteLength: number) {
    validateKey(key);
    if (
      !Number.isSafeInteger(expectedByteLength) ||
      expectedByteLength <= 0 ||
      expectedByteLength > MAX_BUILD_ARTIFACT_BYTES
    )
      throw new Error('Invalid build artifact size');
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      abortSignal: AbortSignal.timeout(60_000),
    });
    if (!result.Body || result.ContentLength !== expectedByteLength) {
      (result.Body as { destroy?: () => void } | undefined)?.destroy?.();
      throw new Error('Invalid build artifact size');
    }
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of result.Body as AsyncIterable<Uint8Array>) {
      length += chunk.length;
      if (length > expectedByteLength || length > MAX_BUILD_ARTIFACT_BYTES) {
        (result.Body as { destroy?: () => void }).destroy?.();
        throw new Error('Build artifact too large');
      }
      chunks.push(Buffer.from(chunk));
    }
    const bytes = Buffer.concat(chunks);
    if (length !== expectedByteLength || digest(bytes) !== expectedDigest)
      throw new Error('Build artifact integrity verification failed');
    return bytes;
  }
  async deleteBuildArtifact(key: string) {
    return this.delete(key);
  }
}
