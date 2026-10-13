import { canonicalDigest } from '@schemora/assembly-plan';
import { z } from 'zod';

/** Bounds for an untrusted project snapshot before a compiler adapter exists. */
export const FIRMWARE_BUNDLE_MAX_FILES = 128;
export const FIRMWARE_BUNDLE_MAX_FILE_BYTES = 2_000_000;
export const FIRMWARE_BUNDLE_MAX_TOTAL_BYTES = 8_000_000;
export const FIRMWARE_BUNDLE_MAX_PATH_BYTES = 240;
const base64Pattern = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const comparePaths = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

export const firmwareProjectBuildSystemSchema = z.enum(['arduino-cli', 'esp-idf']);
export type FirmwareProjectBuildSystem = z.infer<typeof firmwareProjectBuildSystemSchema>;

/** User supplied target identity; trusted toolchain profiles are resolved server-side. */
export const firmwareProjectTargetSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('arduino-fqbn'),
      // FQBN form: package:architecture:board[:menu=value...]. This validates
      // syntax only; a pinned server profile must decide which FQBNs are allowed.
      fqbn: z
        .string()
        .min(5)
        .max(200)
        .regex(
          /^[A-Za-z0-9_.-]*:[A-Za-z0-9_.-]*:[A-Za-z0-9_.-]+(?::[A-Za-z0-9_.-]+=[A-Za-z0-9_.-]+(?:,[A-Za-z0-9_.-]+=[A-Za-z0-9_.-]+)*)?$/,
        ),
    })
    .strict(),
  z
    .object({
      kind: z.literal('esp-idf-target'),
      target: z
        .string()
        .min(5)
        .max(40)
        .regex(/^esp32[a-z0-9]*$/),
    })
    .strict(),
]);
export type FirmwareProjectTarget = z.infer<typeof firmwareProjectTargetSchema>;

/**
 * A path is a portable, normalized POSIX relative path. Backslashes, drive
 * prefixes, dot segments, empty segments, control characters, and non-NFC
 * spellings are rejected so the same manifest has the same meaning on every
 * supported host filesystem.
 */
export const firmwareProjectPathSchema = z
  .string()
  .min(1)
  .max(FIRMWARE_BUNDLE_MAX_PATH_BYTES)
  .superRefine((path, ctx) => {
    const segments = path.split('/');
    if (
      path.normalize('NFC') !== path ||
      path.startsWith('/') ||
      path.includes('\\') ||
      /^[A-Za-z]:/.test(path) ||
      /[\u0000-\u001f\u007f]/.test(path) ||
      segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Path must be a normalized, safe relative POSIX path.',
      });
    if (new TextEncoder().encode(path).byteLength > FIRMWARE_BUNDLE_MAX_PATH_BYTES)
      ctx.addIssue({ code: 'custom', message: 'UTF-8 path exceeds the byte limit.' });
  });

const firmwareBundleFileSchema = z
  .object({
    path: firmwareProjectPathSchema,
    byteLength: z.number().int().positive().max(FIRMWARE_BUNDLE_MAX_FILE_BYTES),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    contentBase64: z
      .string()
      .min(4)
      .max(Math.ceil(FIRMWARE_BUNDLE_MAX_FILE_BYTES / 3) * 4)
      .regex(base64Pattern),
  })
  .strict()
  .superRefine((file, ctx) => {
    const padding = file.contentBase64.endsWith('==')
      ? 2
      : file.contentBase64.endsWith('=')
        ? 1
        : 0;
    const decodedLength = (file.contentBase64.length / 4) * 3 - padding;
    if (decodedLength !== file.byteLength)
      ctx.addIssue({
        code: 'custom',
        path: ['contentBase64'],
        message: 'Encoded source length does not match byteLength.',
      });
    else if (toBase64(fromBase64(file.contentBase64)) !== file.contentBase64)
      ctx.addIssue({
        code: 'custom',
        path: ['contentBase64'],
        message: 'Source must use canonical base64 encoding.',
      });
  });

export const firmwareProjectBundleSchema = z
  .object({
    schemaVersion: z.literal(1),
    buildSystem: firmwareProjectBuildSystemSchema,
    target: firmwareProjectTargetSchema,
    entrypoint: firmwareProjectPathSchema,
    files: z.array(firmwareBundleFileSchema).min(1).max(FIRMWARE_BUNDLE_MAX_FILES),
    totalByteLength: z.number().int().positive().max(FIRMWARE_BUNDLE_MAX_TOTAL_BYTES),
    manifestDigest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
  .superRefine((bundle, ctx) => {
    let total = 0;
    const paths = new Set<string>();
    const foldedPaths = new Set<string>();
    let previousPath: string | null = null;
    for (const [index, file] of bundle.files.entries()) {
      total += file.byteLength;
      const folded = file.path.toLocaleLowerCase('en-US');
      if (paths.has(file.path) || foldedPaths.has(folded))
        ctx.addIssue({
          code: 'custom',
          path: ['files', index, 'path'],
          message: 'File paths must be unique, including case-insensitive collisions.',
        });
      if (previousPath !== null && comparePaths(previousPath, file.path) >= 0)
        ctx.addIssue({
          code: 'custom',
          path: ['files', index, 'path'],
          message: 'Files must be sorted in deterministic ascending path order.',
        });
      paths.add(file.path);
      foldedPaths.add(folded);
      previousPath = file.path;
    }
    if (total > FIRMWARE_BUNDLE_MAX_TOTAL_BYTES || bundle.totalByteLength !== total)
      ctx.addIssue({
        code: 'custom',
        path: ['totalByteLength'],
        message: 'Aggregate byte length exceeds the limit or does not match its files.',
      });
    if (!paths.has(bundle.entrypoint))
      ctx.addIssue({
        code: 'custom',
        path: ['entrypoint'],
        message: 'Entrypoint must identify a file in the bundle.',
      });
    if (bundle.buildSystem === 'arduino-cli') {
      if (bundle.target.kind !== 'arduino-fqbn')
        ctx.addIssue({
          code: 'custom',
          path: ['target'],
          message: 'Arduino CLI bundles require an Arduino FQBN target.',
        });
      const segments = bundle.entrypoint.split('/');
      const sketchName = segments.at(-1)?.replace(/\.ino$/i, '');
      const sketchDirectory = segments.at(-2);
      if (
        !bundle.entrypoint.toLowerCase().endsWith('.ino') ||
        !sketchDirectory ||
        sketchDirectory !== sketchName
      )
        ctx.addIssue({
          code: 'custom',
          path: ['entrypoint'],
          message:
            'Arduino entrypoint must be an .ino file whose basename matches its sketch directory.',
        });
      else if (
        bundle.files.some(
          (file) =>
            file.path !== bundle.entrypoint &&
            !file.path.startsWith(`${segments.slice(0, -1).join('/')}/`),
        )
      )
        ctx.addIssue({
          code: 'custom',
          path: ['files'],
          message: 'All Arduino sketch files must be inside the entrypoint sketch directory.',
        });
    } else {
      if (bundle.target.kind !== 'esp-idf-target')
        ctx.addIssue({
          code: 'custom',
          path: ['target'],
          message: 'ESP-IDF bundles require an ESP-IDF target.',
        });
      if (!paths.has('CMakeLists.txt') || !paths.has('main/CMakeLists.txt'))
        ctx.addIssue({
          code: 'custom',
          path: ['files'],
          message: 'ESP-IDF bundles require root and main/CMakeLists.txt files.',
        });
      if (!/^main\/.+\.(?:c|cc|cpp|cxx)$/i.test(bundle.entrypoint))
        ctx.addIssue({
          code: 'custom',
          path: ['entrypoint'],
          message: 'ESP-IDF entrypoint must be a C/C++ source file under main/.',
        });
    }
    const core = {
      schemaVersion: bundle.schemaVersion,
      buildSystem: bundle.buildSystem,
      target: bundle.target,
      entrypoint: bundle.entrypoint,
      totalByteLength: bundle.totalByteLength,
      files: bundle.files.map(({ path, byteLength, sha256 }) => ({ path, byteLength, sha256 })),
    };
    if (canonicalDigest(core) !== bundle.manifestDigest)
      ctx.addIssue({
        code: 'custom',
        path: ['manifestDigest'],
        message: 'Manifest digest does not match the canonical manifest.',
      });
  });

export type FirmwareProjectBundle = z.infer<typeof firmwareProjectBundleSchema>;
export type FirmwareProjectBundleFile = FirmwareProjectBundle['files'][number];

export type FirmwareProjectBundleInput = {
  buildSystem: FirmwareProjectBuildSystem;
  target: FirmwareProjectTarget;
  entrypoint: string;
  files: readonly { path: string; source: Uint8Array }[];
};

function toBase64(bytes: Uint8Array) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  return btoa(binary);
}

function fromBase64(encoded: string) {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function sha256(bytes: Uint8Array) {
  // Copy into a fresh ArrayBuffer so callers backed by SharedArrayBuffer cannot
  // leak a wider BufferSource type into WebCrypto's strict TypeScript contract.
  const input = Uint8Array.from(bytes);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', input.buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function canonicalManifest(
  bundle: Pick<
    FirmwareProjectBundle,
    'schemaVersion' | 'buildSystem' | 'target' | 'entrypoint' | 'files' | 'totalByteLength'
  >,
) {
  return {
    schemaVersion: bundle.schemaVersion,
    buildSystem: bundle.buildSystem,
    target: bundle.target,
    entrypoint: bundle.entrypoint,
    totalByteLength: bundle.totalByteLength,
    files: bundle.files.map(({ path, byteLength, sha256: digest }) => ({
      path,
      byteLength,
      sha256: digest,
    })),
  };
}

/** Build a canonical, immutable snapshot from raw source bytes. */
export async function createFirmwareProjectBundle(
  input: FirmwareProjectBundleInput,
): Promise<FirmwareProjectBundle> {
  const files = [...input.files].sort((left, right) => comparePaths(left.path, right.path));
  if (files.length === 0 || files.length > FIRMWARE_BUNDLE_MAX_FILES)
    throw new Error(
      `A firmware bundle must contain between 1 and ${FIRMWARE_BUNDLE_MAX_FILES} files.`,
    );
  let totalByteLength = 0;
  const packedFiles: FirmwareProjectBundle['files'] = [];
  for (const file of files) {
    firmwareProjectPathSchema.parse(file.path);
    if (
      !(file.source instanceof Uint8Array) ||
      file.source.byteLength === 0 ||
      file.source.byteLength > FIRMWARE_BUNDLE_MAX_FILE_BYTES
    )
      throw new Error(`Source file ${file.path} is empty or exceeds the per-file byte limit.`);
    totalByteLength += file.source.byteLength;
    if (totalByteLength > FIRMWARE_BUNDLE_MAX_TOTAL_BYTES)
      throw new Error('Firmware bundle exceeds the aggregate byte limit.');
    packedFiles.push({
      path: file.path,
      byteLength: file.source.byteLength,
      sha256: await sha256(file.source),
      contentBase64: toBase64(file.source),
    });
  }
  const core = {
    schemaVersion: 1 as const,
    buildSystem: input.buildSystem,
    target: input.target,
    entrypoint: input.entrypoint,
    files: packedFiles,
    totalByteLength,
  };
  const bundle = { ...core, manifestDigest: canonicalDigest(canonicalManifest(core)) };
  return firmwareProjectBundleSchema.parse(bundle);
}

/** Rehash every decoded source file; schema validation alone cannot prove byte contents. */
export async function verifyFirmwareProjectBundleSources(
  bundle: FirmwareProjectBundle,
): Promise<boolean> {
  const parsed = firmwareProjectBundleSchema.safeParse(bundle);
  if (!parsed.success) return false;
  for (const file of parsed.data.files) {
    const bytes = fromBase64(file.contentBase64);
    if (bytes.byteLength !== file.byteLength || (await sha256(bytes)) !== file.sha256) return false;
  }
  return true;
}
