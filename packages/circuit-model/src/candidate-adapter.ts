import type { Candidate } from '@schemora/contracts';
import type { WireEdge, WireEndpoint } from './schema.js';
import { deriveStableId } from './stable-id.js';

type ConnectionCandidate = Extract<Candidate, { kind: 'connection' }>;
type CandidateEndpoint = NonNullable<ConnectionCandidate['details']['from']>;

export type ReviewedCandidateDecision = {
  candidateId: string;
  decisionId: string;
  disposition: 'confirmed';
  reviewRevision: number;
};

/** Maps a confirmed Phase 1 connection only after callers resolve its labels to exact graph endpoints. */
export function mapReviewedConnectionCandidate(
  candidate: Candidate,
  decision: ReviewedCandidateDecision,
  resolveEndpoint: (endpoint: CandidateEndpoint) => WireEndpoint | null,
): WireEdge | null {
  if (candidate.kind !== 'connection')
    throw new Error('Only connection candidates can map to a graph wire.');
  if (candidate.status === 'superseded')
    throw new Error('A superseded candidate cannot become a graph wire.');
  if (
    decision.disposition !== 'confirmed' ||
    decision.candidateId !== candidate.id ||
    !decision.decisionId ||
    !Number.isSafeInteger(decision.reviewRevision) ||
    decision.reviewRevision < 1
  ) {
    throw new Error('A matching confirmed review decision is required before mapping a candidate.');
  }
  const from = candidate.details.from;
  const to = candidate.details.to;
  if (!from || !to) return null;
  const source = resolveEndpoint(from);
  const target = resolveEndpoint(to);
  if (!source || !target) return null;
  return {
    id: deriveStableId('wire', [decision.decisionId, candidate.id]),
    source,
    target,
  };
}
