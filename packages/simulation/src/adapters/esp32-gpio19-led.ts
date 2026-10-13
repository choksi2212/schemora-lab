import { catalogReleaseSchema, type CatalogRelease } from '@schemora/catalog';
import {
  deriveNets,
  validateCircuitGraph,
  type CircuitGraph,
  type TerminalRef,
} from '@schemora/circuit-model';

const BOARD_ID = 'board.espressif.esp32-devkitc-v4.wroom-32e.male';
const LED_ID = 'led.kingbright.wp7113id';
const RESISTOR_ID = 'resistor.yageo.cfr-25jb-52-220r';
const GPIO_TERMINAL_ID = 'gpio19';
const GROUND_TERMINAL_IDS = ['gnd-j3-1', 'gnd-j3-7'] as const;
const LED_ANODE_ID = 'anode';
const LED_CATHODE_ID = 'cathode';
const RESISTOR_TERMINAL_IDS = ['lead-a', 'lead-b'] as const;

export type Esp32Gpio19Signal = {
  sequence: number;
  simulationTimeMs: number;
  pin: 19;
  enabled: true;
  level: 0 | 1;
};

export type LedStateMapping =
  | {
      supported: true;
      componentInstanceId: string;
      events: Array<{
        kind: 'led_state';
        sequence: number;
        simulationTimeMs: number;
        componentInstanceId: string;
        state: 'on' | 'off';
      }>;
      limitations: string[];
    }
  | { supported: false; reason: string };

function terminalKey(terminal: TerminalRef): string {
  return `${terminal.componentInstanceId}\u0000${terminal.catalogTerminalId}`;
}

/**
 * Maps digital output from the exact DevKitC GPIO19 signal to the exact LED
 * only when the immutable graph contains the supported GPIO19 -> 220 ohm
 * resistor -> LED anode -> LED cathode -> board ground series path.
 * This is a digital indication only; it does not calculate current or voltage.
 */
export function mapEsp32Gpio19ToLedState(input: {
  graph: unknown;
  catalog: CatalogRelease;
  signals: readonly Esp32Gpio19Signal[];
}): LedStateMapping {
  const catalogResult = catalogReleaseSchema.safeParse(input.catalog);
  if (!catalogResult.success)
    return { supported: false, reason: 'The catalog release is invalid.' };
  const catalog = catalogResult.data;
  const valid = validateCircuitGraph(input.graph, { release: catalog });
  if (!valid.valid) return { supported: false, reason: 'The circuit graph is invalid.' };
  const graph = input.graph as CircuitGraph;

  const board = graph.components.filter((component) => component.catalogPartId === BOARD_ID);
  const leds = graph.components.filter((component) => component.catalogPartId === LED_ID);
  const resistors = graph.components.filter((component) => component.catalogPartId === RESISTOR_ID);
  if (
    graph.components.length !== 3 ||
    board.length !== 1 ||
    leds.length !== 1 ||
    resistors.length !== 1
  ) {
    return { supported: false, reason: 'Only one exact board, LED, and resistor are supported.' };
  }

  const boardPart = catalog.parts.find((part) => part.id === BOARD_ID);
  const ledPart = catalog.parts.find((part) => part.id === LED_ID);
  const resistorPart = catalog.parts.find((part) => part.id === RESISTOR_ID);
  if (!boardPart || !ledPart || !resistorPart) {
    return {
      supported: false,
      reason: 'The exact board, LED, or resistor is missing from the catalog release.',
    };
  }
  if (
    boardPart.category !== 'development-board' ||
    boardPart.model !== 'ESP32-DevKitC V4' ||
    boardPart.configuration.module !== 'ESP32-WROOM-32E' ||
    boardPart.configuration.header !== 'male' ||
    !boardPart.pins.some(
      (pin) => pin.terminalId === GPIO_TERMINAL_ID && pin.functions.includes('GPIO19'),
    ) ||
    !boardPart.terminals.some(
      (terminal) => terminal.id === GPIO_TERMINAL_ID && terminal.electricalRole === 'gpio',
    ) ||
    ![...GROUND_TERMINAL_IDS].every((terminalId) =>
      boardPart.terminals.some(
        (terminal) => terminal.id === terminalId && terminal.electricalRole === 'ground',
      ),
    ) ||
    ledPart.category !== 'led' ||
    ledPart.anodeTerminalId !== LED_ANODE_ID ||
    ledPart.cathodeTerminalId !== LED_CATHODE_ID ||
    resistorPart.category !== 'resistor' ||
    resistorPart.resistanceOhm !== 220
  ) {
    return {
      supported: false,
      reason: 'The catalog terminal polarity or resistor value differs from the reviewed profile.',
    };
  }

  const nets = deriveNets(graph, { release: catalog });
  const netByTerminal = new Map<string, string>();
  for (const net of nets) {
    for (const terminal of net.terminalRefs) netByTerminal.set(terminalKey(terminal), net.id);
  }
  const netAt = (componentInstanceId: string, catalogTerminalId: string) =>
    netByTerminal.get(terminalKey({ componentInstanceId, catalogTerminalId }));
  const boardInstanceId = board[0]!.id;
  const ledInstanceId = leds[0]!.id;
  const resistorInstanceId = resistors[0]!.id;
  const gpioNet = netAt(boardInstanceId, GPIO_TERMINAL_ID);
  const anodeNet = netAt(ledInstanceId, LED_ANODE_ID);
  const cathodeNet = netAt(ledInstanceId, LED_CATHODE_ID);
  const resistorNets = [...RESISTOR_TERMINAL_IDS].map((id) => netAt(resistorInstanceId, id));

  if (!gpioNet || !anodeNet || !cathodeNet || resistorNets.some((net) => !net)) {
    return {
      supported: false,
      reason: 'One or more required terminals are not represented in the graph.',
    };
  }
  if (gpioNet === anodeNet || gpioNet === cathodeNet || anodeNet === cathodeNet) {
    return { supported: false, reason: 'The circuit shorts required LED path nodes together.' };
  }

  const gpioResistorIndex = resistorNets.findIndex((net) => net === gpioNet);
  const anodeResistorIndex = resistorNets.findIndex((net) => net === anodeNet);
  const resistorLeadNetsAreDistinct = resistorNets[0] !== resistorNets[1];
  const groundOnCathode = GROUND_TERMINAL_IDS.some(
    (terminalId) => netAt(boardInstanceId, terminalId) === cathodeNet,
  );
  if (
    gpioResistorIndex < 0 ||
    anodeResistorIndex < 0 ||
    gpioResistorIndex === anodeResistorIndex ||
    !resistorLeadNetsAreDistinct ||
    !groundOnCathode
  ) {
    return {
      supported: false,
      reason: 'The graph does not contain the supported GPIO19-to-resistor-to-LED-to-ground path.',
    };
  }

  const expectedTerminalsByNet = new Map<string, Set<string>>([
    [
      gpioNet,
      new Set([
        terminalKey({ componentInstanceId: boardInstanceId, catalogTerminalId: GPIO_TERMINAL_ID }),
      ]),
    ],
    [
      anodeNet,
      new Set([
        terminalKey({ componentInstanceId: ledInstanceId, catalogTerminalId: LED_ANODE_ID }),
      ]),
    ],
    [
      cathodeNet,
      new Set([
        terminalKey({ componentInstanceId: ledInstanceId, catalogTerminalId: LED_CATHODE_ID }),
      ]),
    ],
  ]);
  expectedTerminalsByNet.get(gpioNet)!.add(
    terminalKey({
      componentInstanceId: resistorInstanceId,
      catalogTerminalId: [...RESISTOR_TERMINAL_IDS][gpioResistorIndex]!,
    }),
  );
  expectedTerminalsByNet.get(anodeNet)!.add(
    terminalKey({
      componentInstanceId: resistorInstanceId,
      catalogTerminalId: [...RESISTOR_TERMINAL_IDS][anodeResistorIndex]!,
    }),
  );
  const cathodeGrounds = GROUND_TERMINAL_IDS.filter(
    (terminalId) => netAt(boardInstanceId, terminalId) === cathodeNet,
  );
  for (const terminalId of cathodeGrounds) {
    expectedTerminalsByNet
      .get(cathodeNet)!
      .add(terminalKey({ componentInstanceId: boardInstanceId, catalogTerminalId: terminalId }));
  }
  for (const [netId, expected] of expectedTerminalsByNet) {
    const actual = nets.find((net) => net.id === netId)?.terminalRefs.map(terminalKey) ?? [];
    if (actual.length !== expected.size || actual.some((key) => !expected.has(key))) {
      return {
        supported: false,
        reason: 'The supported LED path contains an unmodeled terminal branch.',
      };
    }
  }
  const supportedNetIds = new Set(expectedTerminalsByNet.keys());
  if (nets.some((net) => net.wireIds.length > 0 && !supportedNetIds.has(net.id))) {
    return {
      supported: false,
      reason: 'The graph contains a wire outside the supported LED path.',
    };
  }

  for (const signal of input.signals) {
    if (
      !Number.isSafeInteger(signal.sequence) ||
      signal.sequence < 0 ||
      !Number.isFinite(signal.simulationTimeMs) ||
      signal.simulationTimeMs < 0 ||
      signal.pin !== 19 ||
      signal.enabled !== true ||
      (signal.level !== 0 && signal.level !== 1)
    ) {
      return {
        supported: false,
        reason: 'A GPIO signal is malformed or targets an unsupported pin.',
      };
    }
  }
  for (let index = 1; index < input.signals.length; index += 1) {
    const previous = input.signals[index - 1]!;
    const current = input.signals[index]!;
    if (
      current.sequence <= previous.sequence ||
      current.simulationTimeMs < previous.simulationTimeMs
    ) {
      return {
        supported: false,
        reason: 'GPIO signals must be ordered by sequence and simulation time.',
      };
    }
  }

  return {
    supported: true,
    componentInstanceId: ledInstanceId,
    events: input.signals.map((signal) => ({
      kind: 'led_state',
      sequence: signal.sequence,
      simulationTimeMs: signal.simulationTimeMs,
      componentInstanceId: ledInstanceId,
      state: signal.level === 1 ? 'on' : 'off',
    })),
    limitations: [
      'LED state is an ideal digital indication derived from the GPIO level and graph polarity.',
      'This adapter does not calculate LED current, resistor power, GPIO drive limits, or transient behavior.',
    ],
  };
}
