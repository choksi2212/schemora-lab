import { z } from 'zod';

/**
 * Versioned contract for a hardware family implementation. A catalog record is
 * not considered product support unless its required capabilities are provided
 * by a registered family contract.
 */
export const hardwareFamilyContractSchema = z
  .object({
    schemaVersion: z.literal(1),
    familyId: z.string().regex(/^[a-z][a-z0-9-]+$/),
    contractVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    category: z.string().min(1),
    supportedPartIds: z.array(z.string().min(1)).min(1),
    terminals: z
      .object({
        source: z.literal('catalog'),
        supportsInternalConnectivity: z.boolean(),
        stateModel: z.enum(['static', 'discrete-interaction', 'continuous']),
      })
      .strict(),
    physicalModel: z
      .object({
        representation: z.enum([
          'catalog-facts-only',
          'schematic-symbol',
          '2d-footprint',
          '3d-geometry',
        ]),
        coordinateFrame: z.enum(['none', 'board-local', 'component-local']),
        sourceRequired: z.boolean(),
        assemblyClearanceModel: z.enum(['none', 'bounding-box', 'reviewed-clearance']),
      })
      .strict(),
    electricalModel: z
      .object({
        modelId: z.string().min(1),
        domain: z.enum(['identity-only', 'connectivity', 'digital', 'analog', 'power']),
        stateInputs: z.array(z.string().min(1)),
        explicitUnknowns: z.array(z.string().min(1)).min(1),
      })
      .strict(),
    assembly: z
      .object({
        actionIds: z.array(z.string().min(1)).min(1),
        dependencies: z.enum([
          'component-order-only',
          'terminal-placement',
          'mechanical-constraints',
        ]),
        instructionsSource: z.enum(['catalog-limitations', 'family-provider']),
      })
      .strict(),
    simulation: z
      .object({
        mode: z.enum(['unsupported', 'circuit-level', 'firmware-in-the-loop']),
        adapterId: z.string().nullable(),
        observableIds: z.array(z.string().min(1)),
        inputStimulusIds: z.array(z.string().min(1)),
        limitations: z.array(z.string().min(1)).min(1),
      })
      .strict(),
    validation: z
      .object({
        ruleIds: z.array(z.string().min(1)),
        version: z.string().regex(/^\d+\.\d+\.\d+$/),
        fixturesRequired: z.boolean(),
      })
      .strict(),
    owner: z.string().min(1),
  })
  .strict()
  .superRefine((contract, ctx) => {
    if (contract.simulation.mode === 'unsupported' && contract.simulation.adapterId !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['simulation', 'adapterId'],
        message: 'Unsupported simulation cannot name an adapter.',
      });
    }
    if (contract.simulation.mode !== 'unsupported' && contract.simulation.adapterId === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['simulation', 'adapterId'],
        message: 'A supported simulation mode must name its implementation adapter.',
      });
    }
    if (
      contract.simulation.mode === 'firmware-in-the-loop' &&
      contract.simulation.observableIds.length === 0
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['simulation', 'observableIds'],
        message: 'Firmware simulation must declare at least one attributable observable.',
      });
    }
    if (
      contract.terminals.stateModel === 'discrete-interaction' &&
      contract.simulation.mode !== 'circuit-level' &&
      contract.simulation.mode !== 'firmware-in-the-loop'
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['simulation', 'mode'],
        message:
          'Interactive terminal states require an explicit simulator or circuit-level evaluator.',
      });
    }
    if (
      contract.physicalModel.representation === '3d-geometry' &&
      contract.physicalModel.coordinateFrame === 'none'
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['physicalModel', 'coordinateFrame'],
        message: '3D geometry must declare its coordinate frame.',
      });
    }
  });

export type HardwareFamilyContract = z.infer<typeof hardwareFamilyContractSchema>;

/** Validate a provider descriptor before any runtime registers it. */
export function parseHardwareFamilyContract(input: unknown): HardwareFamilyContract {
  return hardwareFamilyContractSchema.parse(input);
}
