import { catalogReleaseSchema, type CatalogRelease } from '@schemora/catalog';
import { z } from 'zod';
import { mapEsp32Gpio19ToLedState } from './esp32-gpio19-led.js';

const MAX_CALLBACK_EVENTS = 5_000;
const safeInteger = z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);

const callbackEventSchema = z.discriminatedUnion('type', [
  z
    .object({
      sequence: safeInteger.positive(),
      type: z.literal('gpio_level'),
      gpio: safeInteger,
      level: safeInteger,
    })
    .strict(),
  z
    .object({
      sequence: safeInteger.positive(),
      type: z.literal('uart_byte'),
      uart: safeInteger,
      value: safeInteger,
    })
    .strict(),
]);

const callbackTraceSchema = z.array(callbackEventSchema).min(1).max(MAX_CALLBACK_EVENTS);

export type QemuCallbackNormalization =
  | {
      supported: true;
      events: Array<
        | {
            kind: 'serial';
            sequence: number;
            simulationTimeMs: 0;
            text: string;
            stream: 'stdout';
          }
        | {
            kind: 'led_state';
            sequence: number;
            simulationTimeMs: 0;
            componentInstanceId: string;
            state: 'on' | 'off';
          }
      >;
      limitations: string[];
    }
  | { supported: false; reason: string };

/**
 * Normalize the pinned reference fixture's callback JSONL into contract-shaped
 * observations. This does not execute or attest a user's firmware and does not
 * create a persisted SimulationRun.
 */
export function normalizeQemuReferenceCallbacks(input: {
  trace: unknown;
  graph: unknown;
  catalog: CatalogRelease;
}): QemuCallbackNormalization {
  const traceResult = callbackTraceSchema.safeParse(input.trace);
  const catalogResult = catalogReleaseSchema.safeParse(input.catalog);
  if (!traceResult.success) return { supported: false, reason: 'Callback trace is invalid.' };
  if (!catalogResult.success) return { supported: false, reason: 'Catalog release is invalid.' };

  const trace = traceResult.data;
  for (let index = 1; index < trace.length; index += 1) {
    if (trace[index]!.sequence <= trace[index - 1]!.sequence)
      return {
        supported: false,
        reason: 'Callback sequence numbers must be strictly increasing.',
      };
  }

  const gpioSignals = [];
  const serialEvents: Extract<QemuCallbackNormalization, { supported: true }>['events'] = [];
  for (const event of trace) {
    if (event.type === 'gpio_level') {
      if (event.gpio !== 19 || (event.level !== 0 && event.level !== 1))
        return {
          supported: false,
          reason: 'Only binary output observations for GPIO19 are supported.',
        };
      gpioSignals.push({
        sequence: event.sequence,
        simulationTimeMs: 0,
        pin: 19 as const,
        enabled: true as const,
        level: event.level as 0 | 1,
      });
      continue;
    }

    if (event.uart !== 0) return { supported: false, reason: 'Only UART0 output is supported.' };
    if (
      event.value < 0 ||
      event.value > 0x7e ||
      (event.value !== 9 && event.value !== 10 && event.value !== 13 && event.value < 0x20)
    )
      return {
        supported: false,
        reason: 'UART0 output must contain printable ASCII or tab/newline characters.',
      };
    serialEvents.push({
      kind: 'serial',
      sequence: event.sequence,
      simulationTimeMs: 0,
      text: String.fromCharCode(event.value),
      stream: 'stdout',
    });
  }

  const mapped = mapEsp32Gpio19ToLedState({
    graph: input.graph,
    catalog: catalogResult.data,
    signals: gpioSignals,
  });
  if (!mapped.supported) return { supported: false, reason: mapped.reason };

  const ledEvents = mapped.events.map((event) => ({ ...event, simulationTimeMs: 0 as const }));
  const events = [...serialEvents, ...ledEvents].sort(
    (left, right) => left.sequence - right.sequence,
  );
  return {
    supported: true,
    events,
    limitations: [
      'This normalizer consumes a fixed reference fixture callback trace; it does not prove which firmware binary produced the trace.',
      'All simulationTimeMs values are zero because this callback ABI provides no simulation clock.',
      ...mapped.limitations,
    ],
  };
}
