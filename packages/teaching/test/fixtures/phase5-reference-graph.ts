import type { CircuitGraph } from '@schemora/circuit-model';

/** Canonical graph structure for the Phase 5 novice study; per-session IDs are derived from this. */
export const phase5ReferenceGraph = {
  schemaVersion: 1,
  id: 'phase5-reference-graph-v1',
  projectId: 'phase5-study-template',
  projectRevision: 2,
  catalogReleaseId: 'schemora-hw-2026.10.1',
  components: [
    {
      id: 'board-1',
      catalogPartId: 'board.espressif.esp32-devkitc-v4.wroom-32e.male',
    },
    { id: 'resistor-1', catalogPartId: 'resistor.yageo.cfr-25jb-52-220r' },
    { id: 'led-1', catalogPartId: 'led.kingbright.wp7113id' },
  ],
  breadboards: [
    {
      id: 'breadboard-1',
      topologyId: 'breadboard.busboard.bb400',
      topologyVersion: 1,
      railVariants: [
        { railGroupId: 'rail-1', variantId: 'continuous' },
        { railGroupId: 'rail-2', variantId: 'continuous' },
        { railGroupId: 'rail-3', variantId: 'continuous' },
        { railGroupId: 'rail-4', variantId: 'continuous' },
      ],
    },
  ],
  terminalPlacements: [],
  wires: [
    {
      id: 'wire-gpio-resistor',
      source: {
        kind: 'terminal',
        terminal: { componentInstanceId: 'board-1', catalogTerminalId: 'gpio19' },
      },
      target: {
        kind: 'terminal',
        terminal: { componentInstanceId: 'resistor-1', catalogTerminalId: 'lead-a' },
      },
    },
    {
      id: 'wire-resistor-led',
      source: {
        kind: 'terminal',
        terminal: { componentInstanceId: 'resistor-1', catalogTerminalId: 'lead-b' },
      },
      target: {
        kind: 'terminal',
        terminal: { componentInstanceId: 'led-1', catalogTerminalId: 'anode' },
      },
    },
    {
      id: 'wire-led-ground',
      source: {
        kind: 'terminal',
        terminal: { componentInstanceId: 'led-1', catalogTerminalId: 'cathode' },
      },
      target: {
        kind: 'terminal',
        terminal: { componentInstanceId: 'board-1', catalogTerminalId: 'gnd-j3-1' },
      },
    },
  ],
} as const satisfies CircuitGraph;
