import { z } from 'zod';
export {
  HARDWARE_RECOGNITION_CONSENT_VERSION,
  hardwareImageRegionSchema,
  hardwareRecognitionObservationSchema,
  hardwareRecognitionCandidateSchema,
  hardwareRecognitionProposalSchema,
  hardwareRecognitionConsentSchema,
  type HardwareRecognitionProposal,
  type HardwareRecognitionConsent,
} from './hardware-recognition.js';

export const evidenceSchema = z
  .object({
    messageId: z.string().min(1),
    quote: z.string().min(1).max(20_000),
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
  })
  .strict();
const candidateBase = z.object({
  id: z.string().min(1).max(200),
  value: z.string().min(1).max(20_000),
  evidence: z.array(evidenceSchema).min(1).max(100),
  status: z.enum(['candidate', 'superseded']),
  supersedes: z.array(z.string()).max(100),
  uncertainty: z.string().max(2_000).nullable(),
});
const nullableLabel = z.string().min(1).max(500).nullable();
const endpointSchema = z
  .object({ label: z.string().min(1).max(500), componentRef: nullableLabel })
  .strict()
  .nullable();
export const candidateSchema = z.discriminatedUnion('kind', [
  candidateBase
    .extend({
      kind: z.literal('board'),
      details: z
        .object({
          manufacturer: nullableLabel,
          family: nullableLabel,
          exactModel: nullableLabel,
          revision: nullableLabel,
        })
        .strict(),
    })
    .strict(),
  candidateBase
    .extend({
      kind: z.literal('component'),
      details: z
        .object({
          type: z.string().min(1).max(500),
          quantity: z.number().int().positive().max(10_000).nullable(),
          resistanceOhms: z.number().positive().max(1e15).nullable(),
        })
        .strict(),
    })
    .strict(),
  candidateBase
    .extend({
      kind: z.literal('connection'),
      details: z.object({ from: endpointSchema, to: endpointSchema }).strict(),
    })
    .strict(),
  candidateBase
    .extend({
      kind: z.literal('firmware'),
      details: z
        .object({ language: nullableLabel, content: z.string().min(1).max(20_000) })
        .strict(),
    })
    .strict(),
  candidateBase
    .extend({
      kind: z.literal('requirement'),
      details: z.object({ text: z.string().min(1).max(20_000) }).strict(),
    })
    .strict(),
]);
export const conflictSchema = z
  .object({
    id: z.string().min(1),
    candidateIds: z.array(z.string()).min(2).max(100),
    description: z.string().min(1).max(2_000),
  })
  .strict();
export const extractionResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    summary: z.string().max(5_000),
    candidates: z.array(candidateSchema).max(2_000),
    missingInformation: z.array(z.string().max(2_000)).max(200),
    conflicts: z.array(conflictSchema).max(200),
  })
  .strict();
export const messageSchema = z
  .object({
    id: z.string().min(1),
    sequence: z.number().int().nonnegative(),
    role: z.enum(['user', 'assistant', 'system', 'unknown']),
    content: z.string().max(2_000_000),
    timestamp: z.string().datetime({ offset: true }).nullable(),
    codeBlocks: z.array(
      z.object({ language: z.string().nullable(), content: z.string() }).strict(),
    ),
    attachments: z.array(z.string()),
    source: z
      .object({
        file: z.string(),
        page: z.number().int().positive().optional(),
        path: z.string().optional(),
      })
      .strict(),
  })
  .strict();
export const normalizedConversationSchema = z
  .object({
    id: z.string().min(1),
    title: z.string(),
    messages: z.array(messageSchema).min(1).max(5_000),
    warnings: z.array(z.string()),
  })
  .strict();
export const conversationBundleSchema = z
  .object({
    schemaVersion: z.literal(1),
    conversations: z.array(normalizedConversationSchema).min(1).max(100),
    warnings: z.array(z.string()),
  })
  .strict();
export type Evidence = z.infer<typeof evidenceSchema>;
export type Candidate = z.infer<typeof candidateSchema>;
export type Conflict = z.infer<typeof conflictSchema>;
export type ExtractionResult = z.infer<typeof extractionResultSchema>;
export type NormalizedMessage = z.infer<typeof messageSchema>;
export type NormalizedConversation = z.infer<typeof normalizedConversationSchema>;
export type ConversationBundle = z.infer<typeof conversationBundleSchema>;
