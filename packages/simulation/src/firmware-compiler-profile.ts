import { canonicalDigest } from '@schemora/assembly-plan';
import { z } from 'zod';
import {
  firmwareProjectPathSchema,
  firmwareProjectTargetSchema,
} from './firmware-project-bundle.js';

/** Immutable administrator-owned compiler contract. It describes a build; it does not run one. */
export const firmwareCompilerProfileSchema = z
  .object({
    schemaVersion: z.literal(1),
    profileId: z.string().min(1).max(100),
    buildSystem: z.literal('esp-idf'),
    target: firmwareProjectTargetSchema,
    compiler: z.literal('esp-idf'),
    compilerVersion: z.string().regex(/^v?\d+\.\d+(?:\.\d+)?$/),
    imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    platform: z.literal('linux/amd64'),
    dependencyPolicy: z.literal('builtin-components-only'),
    networkPolicy: z.literal('disabled'),
    command: z.tuple([z.literal('idf.py'), z.literal('build')]),
    limits: z
      .object({
        wallTimeoutMs: z.number().int().min(10_000).max(600_000),
        memoryBytes: z
          .number()
          .int()
          .min(512 * 1024 ** 2)
          .max(8 * 1024 ** 3),
        cpuCount: z.number().positive().max(8),
        pids: z.number().int().min(16).max(256),
        workspaceBytes: z
          .number()
          .int()
          .min(64 * 1024 ** 2)
          .max(2 * 1024 ** 3),
        outputBytes: z
          .number()
          .int()
          .min(1024)
          .max(64 * 1024 * 1024),
        logBytes: z
          .number()
          .int()
          .min(1024)
          .max(2 * 1024 * 1024),
      })
      .strict(),
  })
  .strict()
  .superRefine((profile, ctx) => {
    if (profile.target.kind !== 'esp-idf-target' || profile.target.target !== 'esp32')
      ctx.addIssue({
        code: 'custom',
        path: ['target'],
        message: 'Only reviewed target esp32 is supported.',
      });
  });

export type FirmwareCompilerProfile = z.infer<typeof firmwareCompilerProfileSchema>;

export function firmwareCompilerProfileDigest(profile: FirmwareCompilerProfile): string {
  return canonicalDigest(profile);
}

/** Reject a well-shaped result that is bound to another source or compiler profile. */
export function firmwareCompileResultMatchesProfile(
  resultInput: unknown,
  profileInput: unknown,
  expectedSourceManifestDigest: string,
): boolean {
  const result = firmwareCompileResultSchema.safeParse(resultInput);
  const profile = firmwareCompilerProfileSchema.safeParse(profileInput);
  if (!result.success || !profile.success || !/^[a-f0-9]{64}$/.test(expectedSourceManifestDigest))
    return false;
  const value = result.data;
  const limits = profile.data.limits;
  const totalArtifactBytes = value.artifacts.reduce(
    (total, artifact) => total + artifact.byteLength,
    0,
  );
  return (
    value.sourceManifestDigest === expectedSourceManifestDigest &&
    value.profileDigest === firmwareCompilerProfileDigest(profile.data) &&
    value.compilerVersion === profile.data.compilerVersion &&
    value.imageDigest === profile.data.imageDigest &&
    value.durationMs <= limits.wallTimeoutMs &&
    totalArtifactBytes <= limits.outputBytes &&
    (value.status !== 'succeeded' || !value.diagnostics.some((item) => item.severity === 'error'))
  );
}

export const firmwareCompileDiagnosticSchema = z
  .object({
    severity: z.enum(['error', 'warning', 'info']),
    code: z.string().min(1).max(80),
    message: z.string().min(1).max(2_000),
    sourcePath: firmwareProjectPathSchema.nullable(),
    line: z.number().int().positive().max(10_000_000).nullable(),
    column: z.number().int().positive().max(1_000_000).nullable(),
    endLine: z.number().int().positive().max(10_000_000).nullable(),
    endColumn: z.number().int().positive().max(1_000_000).nullable(),
  })
  .strict()
  .superRefine((diagnostic, ctx) => {
    const hasPosition = diagnostic.line !== null || diagnostic.column !== null;
    if (
      hasPosition &&
      (!diagnostic.sourcePath || diagnostic.line === null || diagnostic.column === null)
    )
      ctx.addIssue({
        code: 'custom',
        path: ['sourcePath'],
        message: 'A source location requires a path, line, and column.',
      });
    if ((diagnostic.endLine === null) !== (diagnostic.endColumn === null))
      ctx.addIssue({
        code: 'custom',
        path: ['endLine'],
        message: 'End line and column must be supplied together.',
      });
    if (
      diagnostic.endLine !== null &&
      diagnostic.line !== null &&
      diagnostic.endLine < diagnostic.line
    )
      ctx.addIssue({
        code: 'custom',
        path: ['endLine'],
        message: 'Diagnostic end cannot precede its start.',
      });
  });

export const firmwareCompileArtifactSchema = z
  .object({
    role: z.enum(['application', 'bootloader', 'partition_table']),
    path: firmwareProjectPathSchema,
    byteLength: z
      .number()
      .int()
      .positive()
      .max(64 * 1024 * 1024),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export const firmwareCompileResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    status: z.enum(['succeeded', 'failed', 'timed_out', 'rejected']),
    sourceManifestDigest: z.string().regex(/^[a-f0-9]{64}$/),
    profileDigest: z.string().regex(/^[a-f0-9]{64}$/),
    compilerVersion: z.string().min(1).max(40),
    imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    diagnostics: z.array(firmwareCompileDiagnosticSchema).max(2_000),
    artifacts: z.array(firmwareCompileArtifactSchema).max(3),
    logTruncated: z.boolean(),
    durationMs: z.number().int().nonnegative().max(600_000),
  })
  .strict()
  .superRefine((result, ctx) => {
    const roles = result.artifacts.map((artifact) => artifact.role);
    if (new Set(roles).size !== roles.length)
      ctx.addIssue({
        code: 'custom',
        path: ['artifacts'],
        message: 'Artifact roles must be unique.',
      });
    if (result.status === 'succeeded' && (!roles.includes('application') || roles.length !== 3))
      ctx.addIssue({
        code: 'custom',
        path: ['artifacts'],
        message:
          'A successful ESP-IDF build requires application, bootloader, and partition table binaries.',
      });
    if (result.status !== 'succeeded' && result.artifacts.length > 0)
      ctx.addIssue({
        code: 'custom',
        path: ['artifacts'],
        message: 'A non-successful build cannot publish binary artifacts.',
      });
    if (
      result.status === 'failed' &&
      !result.diagnostics.some((diagnostic) => diagnostic.severity === 'error')
    )
      ctx.addIssue({
        code: 'custom',
        path: ['diagnostics'],
        message: 'A failed build must include at least one normalized error diagnostic.',
      });
    if (
      result.status === 'succeeded' &&
      result.diagnostics.some((diagnostic) => diagnostic.severity === 'error')
    )
      ctx.addIssue({
        code: 'custom',
        path: ['diagnostics'],
        message: 'A successful build cannot contain error diagnostics.',
      });
    if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 4 * 1024 * 1024)
      ctx.addIssue({
        code: 'custom',
        path: [],
        message: 'Compile result exceeds the 4 MiB contract limit.',
      });
  });

export type FirmwareCompileDiagnostic = z.infer<typeof firmwareCompileDiagnosticSchema>;
export type FirmwareCompileArtifact = z.infer<typeof firmwareCompileArtifactSchema>;
export type FirmwareCompileResult = z.infer<typeof firmwareCompileResultSchema>;
