import { z } from 'zod';

export const HARDWARE_RECOGNITION_CONSENT_VERSION = 'photo-recognition-remote-v1';

export const hardwareImageRegionSchema = z
  .object({
    x: z.number().finite().min(0).max(1),
    y: z.number().finite().min(0).max(1),
    width: z.number().finite().gt(0).max(1),
    height: z.number().finite().gt(0).max(1),
  })
  .strict()
  .superRefine((region, ctx) => {
    if (region.x + region.width > 1 || region.y + region.height > 1)
      ctx.addIssue({
        code: 'custom',
        message: 'Image region must fit inside the normalized image.',
      });
  });

export const hardwareRecognitionObservationSchema = z
  .object({
    text: z.string().min(1).max(160),
    region: hardwareImageRegionSchema.nullable(),
  })
  .strict();

export const hardwareRecognitionCandidateSchema = z
  .object({
    catalogPartId: z.string().min(1).max(200),
    rank: z.number().int().min(1).max(5),
    basis: z.string().min(1).max(500),
    visibleMarkings: z.array(hardwareRecognitionObservationSchema).max(10),
  })
  .strict();

/** Provider output is a bounded proposal. It is never an inventory or circuit-model mutation. */
export const hardwareRecognitionProposalSchema = z
  .object({
    schemaVersion: z.literal(1),
    outcome: z.enum(['exact-candidate', 'ambiguous', 'unknown', 'unsupported', 'unclear']),
    candidates: z.array(hardwareRecognitionCandidateSchema).max(5),
    observations: z.array(hardwareRecognitionObservationSchema).max(20),
    limitations: z.array(z.string().min(1).max(300)).max(10),
  })
  .strict()
  .superRefine((proposal, ctx) => {
    const ids = proposal.candidates.map((candidate) => candidate.catalogPartId);
    if (new Set(ids).size !== ids.length)
      ctx.addIssue({
        code: 'custom',
        path: ['candidates'],
        message: 'Candidate part IDs must be unique.',
      });
    const ranks = proposal.candidates.map((candidate) => candidate.rank);
    if (new Set(ranks).size !== ranks.length)
      ctx.addIssue({
        code: 'custom',
        path: ['candidates'],
        message: 'Candidate ranks must be unique.',
      });
    if (proposal.outcome === 'exact-candidate' && proposal.candidates.length !== 1)
      ctx.addIssue({
        code: 'custom',
        path: ['candidates'],
        message: 'An exact candidate proposal must contain exactly one catalog candidate.',
      });
    if (
      ['unknown', 'unsupported', 'unclear'].includes(proposal.outcome) &&
      proposal.candidates.length
    )
      ctx.addIssue({
        code: 'custom',
        path: ['candidates'],
        message: 'Unknown, unsupported, and unclear outcomes cannot contain candidates.',
      });
  });

export const hardwareRecognitionConsentSchema = z
  .object({
    version: z.literal(HARDWARE_RECOGNITION_CONSENT_VERSION),
    providerId: z.literal('vultr-inference'),
    modelId: z.literal('qwen3.8-27b'),
    purpose: z.literal('identify-visible-hardware-candidates'),
    noticeRevision: z.string().min(1).max(64),
  })
  .strict();

export type HardwareRecognitionProposal = z.infer<typeof hardwareRecognitionProposalSchema>;
export type HardwareRecognitionConsent = z.infer<typeof hardwareRecognitionConsentSchema>;
