export {
  circuitGraphSchema,
  componentInstanceSchema,
  holeRefSchema,
  terminalRefSchema,
  wireEdgeSchema,
  visualComponentPlacementSchema,
  visualLayoutSchema,
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
  VisualComponentPlacement,
  VisualLayout,
} from './schema.js';
export type { BreadboardTopology } from '@schemora/catalog';
export {
  createTransientSwitchOverlay,
  deriveNets,
  validateCircuitGraph,
  validateTransientSwitchOverlay,
} from './graph.js';
export type {
  CircuitCatalog,
  CircuitGraphIssue,
  CircuitValidationResult,
  TransientSwitchContact,
  TransientSwitchDefinition,
  TransientSwitchOverlay,
} from './graph.js';
export { deriveStableId } from './stable-id.js';
export { compareCircuitDesigns } from './design-diff.js';
export type { CircuitDesignDifference } from './design-diff.js';
export { mapReviewedConnectionCandidate } from './candidate-adapter.js';
export type { ReviewedCandidateDecision } from './candidate-adapter.js';
