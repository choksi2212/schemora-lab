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

/**
 * Statically registered capabilities shipped by this application version.
 * Catalog facts alone never activate executable providers from remote data.
 */
export const hardwareFamilyContracts: readonly HardwareFamilyContract[] = [
  parseHardwareFamilyContract({
    schemaVersion: 1,
    familyId: 'momentary-tactile-switch',
    contractVersion: '1.0.0',
    category: 'pushbutton',
    supportedPartIds: ['button.omron.b3f-1000'],
    terminals: {
      source: 'catalog',
      supportsInternalConnectivity: true,
      stateModel: 'discrete-interaction',
    },
    physicalModel: {
      representation: 'catalog-facts-only',
      coordinateFrame: 'none',
      sourceRequired: true,
      assemblyClearanceModel: 'none',
    },
    electricalModel: {
      modelId: 'ideal-momentary-contact-connectivity',
      domain: 'connectivity',
      stateInputs: ['released', 'pressed'],
      explicitUnknowns: [
        'contact resistance',
        'contact bounce and debounce',
        'GPIO voltage levels and pull-up or pull-down requirements',
        'switching current and voltage limits',
      ],
    },
    assembly: {
      actionIds: ['identify-component', 'connect-labeled-terminals'],
      dependencies: 'terminal-placement',
      instructionsSource: 'catalog-limitations',
    },
    simulation: {
      mode: 'circuit-level',
      adapterId: 'schemora.ideal-switch-net/v1',
      observableIds: ['terminal-net-membership'],
      inputStimulusIds: ['press', 'release'],
      limitations: [
        'Only ideal terminal connectivity changes; this does not execute firmware or predict voltage, current, timing, bounce, or mechanical fit.',
      ],
    },
    validation: {
      ruleIds: ['PUSHBUTTON_ELECTRICAL_SCOPE', 'GRAPH_INTEGRITY'],
      version: '1.0.0',
      fixturesRequired: true,
    },
    owner: 'Schemora hardware catalog maintainers',
  }),
];

export function getHardwareFamilyContract(partId: string): HardwareFamilyContract | undefined {
  return hardwareFamilyContracts.find((contract) => contract.supportedPartIds.includes(partId));
}
