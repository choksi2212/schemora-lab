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

export const visualComponentPlacementSchema = z
  .object({
    componentInstanceId: id,
    x: z.number().finite().min(-50).max(50),
    z: z.number().finite().min(-50).max(50),
    rotationY: z
      .number()
      .int()
      .min(0)
      .max(270)
      .refine((value) => value % 90 === 0),
  })
  .strict();

export const visualLayoutSchema = z
  .object({
    schemaVersion: z.literal(1),
    componentPlacements: z.array(visualComponentPlacementSchema).max(5_000),
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
    visualLayout: visualLayoutSchema.optional(),
  })
  .strict()
  .superRefine((graph, ctx) => {
    const known = new Set(graph.components.map((component) => component.id));
    const seen = new Set<string>();
    for (const [index, placement] of graph.visualLayout?.componentPlacements.entries() ?? []) {
      if (!known.has(placement.componentInstanceId))
        ctx.addIssue({
          code: 'custom',
          path: ['visualLayout', 'componentPlacements', index, 'componentInstanceId'],
          message: 'Visual placements must refer to a component in this graph.',
        });
      if (seen.has(placement.componentInstanceId))
        ctx.addIssue({
          code: 'custom',
          path: ['visualLayout', 'componentPlacements', index, 'componentInstanceId'],
          message: 'A component may have only one visual placement.',
        });
      seen.add(placement.componentInstanceId);
    }
  });

export type CircuitGraph = z.infer<typeof circuitGraphSchema>;
export type ComponentInstance = z.infer<typeof componentInstanceSchema>;
export type TerminalRef = z.infer<typeof terminalRefSchema>;
export type HoleRef = z.infer<typeof holeRefSchema>;
export type WireEdge = z.infer<typeof wireEdgeSchema>;
export type WireEndpoint = z.infer<typeof wireEndpointSchema>;
export type TerminalToHolePlacement = CircuitGraph['terminalPlacements'][number];
export type VisualComponentPlacement = z.infer<typeof visualComponentPlacementSchema>;
export type VisualLayout = z.infer<typeof visualLayoutSchema>;
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
