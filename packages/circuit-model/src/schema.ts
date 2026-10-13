import { z } from 'zod';

const id = z.string().min(1).max(200);

export const terminalRefSchema = z
  .object({
    componentInstanceId: id,
    catalogTerminalId: id,
  })
  .strict();

export const holeRefSchema = z
  .object({
    breadboardInstanceId: id,
    holeId: id,
  })
  .strict();

export const componentInstanceSchema = z
  .object({
    id,
    catalogPartId: id,
  })
  .strict();

const wireEndpointSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('terminal'), terminal: terminalRefSchema }).strict(),
  z.object({ kind: z.literal('hole'), hole: holeRefSchema }).strict(),
]);

export const wireEdgeSchema = z
  .object({
    id,
    source: wireEndpointSchema,
    target: wireEndpointSchema,
  })
  .strict();

export const circuitGraphSchema = z
  .object({
    schemaVersion: z.literal(1),
    id,
    projectId: id,
    projectRevision: z.number().int().positive(),
    catalogReleaseId: id,
    components: z.array(componentInstanceSchema).max(5_000),
    breadboards: z
      .array(
        z
          .object({
            id,
            topologyId: id,
            topologyVersion: z.number().int().positive(),
            railVariants: z.array(z.object({ railGroupId: id, variantId: id }).strict()),
          })
          .strict(),
      )
      .max(100),
    terminalPlacements: z
      .array(z.object({ terminal: terminalRefSchema, hole: holeRefSchema }).strict())
      .max(20_000),
    wires: z.array(wireEdgeSchema).max(20_000),
  })
  .strict();

export type CircuitGraph = z.infer<typeof circuitGraphSchema>;
export type ComponentInstance = z.infer<typeof componentInstanceSchema>;
export type TerminalRef = z.infer<typeof terminalRefSchema>;
export type HoleRef = z.infer<typeof holeRefSchema>;
export type WireEdge = z.infer<typeof wireEdgeSchema>;
export type WireEndpoint = z.infer<typeof wireEndpointSchema>;
export type TerminalToHolePlacement = CircuitGraph['terminalPlacements'][number];
export type BreadboardInstance = CircuitGraph['breadboards'][number];
export type Net = {
  id: string;
  terminalRefs: TerminalRef[];
  holeRefs: HoleRef[];
  wireIds: string[];
  connectivityGroupRefs: Array<{
    breadboardInstanceId: string;
    connectivityGroupId: string;
    source: 'terminal-strip' | 'rail';
    railGroupId: string | null;
    variantId: string | null;
  }>;
};
