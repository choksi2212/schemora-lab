export {
  circuitGraphSchema,
  componentInstanceSchema,
  holeRefSchema,
  terminalRefSchema,
  wireEdgeSchema,
} from './schema.js';
export type {
  BreadboardInstance,
  CircuitGraph,
  ComponentInstance,
  HoleRef,
  Net,
  TerminalRef,
  TerminalToHolePlacement,
  WireEdge,
  WireEndpoint,
} from './schema.js';
export type { BreadboardTopology } from '@schemora/catalog';
export { deriveNets, validateCircuitGraph } from './graph.js';
export type { CircuitCatalog, CircuitGraphIssue, CircuitValidationResult } from './graph.js';
export { deriveStableId } from './stable-id.js';
export { mapReviewedConnectionCandidate } from './candidate-adapter.js';
export type { ReviewedCandidateDecision } from './candidate-adapter.js';
