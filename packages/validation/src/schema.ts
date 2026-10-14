import { z } from 'zod';

export const validationStatusSchema = z.enum([
  'pass',
  'fail',
  'unknown',
  'not_applicable',
  'error',
]);

export const findingSchema = z
  .object({
    id: z.string().min(1),
    ruleId: z.string().min(1),
    ruleVersion: z.string().min(1),
    status: validationStatusSchema,
    severity: z.enum(['info', 'warning', 'error']),
    message: z.string().min(1),
    affectedEntityIds: z.array(z.string().min(1)),
    sourceIds: z.array(z.string().min(1)),
  })
  .strict();

export const validationReportSchema = z
  .object({
    schemaVersion: z.literal(1),
    projectId: z.string().min(1),
    projectRevision: z.number().int().positive(),
    graphId: z.string().min(1),
    graphDigest: z.string().regex(/^[a-f0-9]{64}$/),
    catalogReleaseId: z.string().min(1),
    catalogDigest: z.string().regex(/^[a-f0-9]{64}$/),
    rulesetId: z.literal('schemora-phase2-basic-circuit'),
    rulesetVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    validatorVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    status: validationStatusSchema,
    findings: z.array(findingSchema).max(10_000),
  })
  .strict();

export type ValidationStatus = z.infer<typeof validationStatusSchema>;
export type ValidationFinding = z.infer<typeof findingSchema>;
export type ValidationReport = z.infer<typeof validationReportSchema>;
