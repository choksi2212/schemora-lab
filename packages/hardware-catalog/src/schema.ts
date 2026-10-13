import { z } from 'zod';

const quantity = z.number().finite().positive();
const sourceReferenceSchema = z
  .object({
    id: z.string().min(1),
    url: z.string().url(),
    publisher: z.string().min(1),
    title: z.string().min(1),
    accessedOn: z.string().date(),
    documentRevision: z.string().nullable(),
  })
  .strict();

const claimSchema = z
  .object({
    subjectId: z.string().min(1),
    property: z.string().min(1),
    sourceId: z.string().min(1),
    locator: z.string().min(1),
    note: z.string().min(1),
  })
  .strict();

const topologyHoleSetSchema = z
  .object({ id: z.string().min(1), holes: z.array(z.string().min(1)).min(1) })
  .strict();

const breadboardTopologySchema = z
  .object({
    id: z.string().min(1),
    version: z.number().int().positive(),
    name: z.string().min(1),
    tiePointCount: z.number().int().positive(),
    physicalModel: z
      .object({
        manufacturer: z.string().min(1),
        model: z.string().min(1),
        orderableVariants: z.array(z.string().min(1)).min(1),
        holePitchMm: z.number().positive(),
        dimensionsMm: z
          .object({
            length: z.number().positive(),
            width: z.number().positive(),
            height: z.number().positive(),
          })
          .strict(),
      })
      .strict(),
    coordinateConvention: z.string().min(1),
    sourceIds: z.array(z.string().min(1)).min(1),
    terminalStripGroups: z.array(topologyHoleSetSchema).min(1),
    railGroups: z
      .array(
        z
          .object({
            id: z.string().min(1),
            holes: z.array(z.string().min(1)).min(1),
            splitCapable: z.boolean(),
            connectivityVariants: z
              .array(
                z
                  .object({
                    id: z.string().min(1),
                    connectedHoleSets: z.array(z.array(z.string().min(1)).min(1)).min(1),
                  })
                  .strict(),
              )
              .min(1),
          })
          .strict(),
      )
      .length(4),
    limitations: z.array(z.string().min(1)).min(1),
  })
  .strict()
  .superRefine((topology, ctx) => {
    const groupIds = topology.terminalStripGroups.map((group) => group.id);
    const allHoles = topology.terminalStripGroups.flatMap((group) => group.holes);
    if (new Set(groupIds).size !== groupIds.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['terminalStripGroups'],
        message: 'Terminal strip group IDs must be unique.',
      });
    }
    const railIds = topology.railGroups.map((rail) => rail.id);
    if (new Set(railIds).size !== railIds.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['railGroups'],
        message: 'Rail group IDs must be unique.',
      });
    }
    for (const rail of topology.railGroups) {
      allHoles.push(...rail.holes);
      const variantIds = rail.connectivityVariants.map((variant) => variant.id);
      if (new Set(variantIds).size !== variantIds.length) {
        ctx.addIssue({
          code: 'custom',
          path: ['railGroups'],
          message: `Connectivity variant IDs must be unique for ${rail.id}.`,
        });
      }
      for (const variant of rail.connectivityVariants) {
        const flattened = variant.connectedHoleSets.flat();
        if (
          flattened.length !== rail.holes.length ||
          new Set(flattened).size !== flattened.length ||
          flattened.some((hole) => !rail.holes.includes(hole))
        ) {
          ctx.addIssue({
            code: 'custom',
            path: ['railGroups'],
            message: `Variant ${variant.id} must partition every hole in ${rail.id} exactly once.`,
          });
        }
      }
    }
    if (new Set(allHoles).size !== allHoles.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['railGroups'],
        message: 'Every modeled hole must occur in exactly one base group.',
      });
    }
    if (allHoles.length !== topology.tiePointCount) {
      ctx.addIssue({
        code: 'custom',
        path: ['tiePointCount'],
        message: 'Tie point count must equal the modeled hole count.',
      });
    }
  });

const terminalSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    electricalRole: z.enum(['gpio', 'ground', 'power', 'anode', 'cathode', 'passive']),
  })
  .strict();

const basePart = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]+$/),
  manufacturer: z.string().min(1),
  model: z.string().min(1),
  category: z.enum(['development-board', 'led', 'resistor']),
  identityScope: z.literal('exact-configuration'),
  summary: z.string().min(1),
  terminals: z.array(terminalSchema).min(2),
  sourceIds: z.array(z.string().min(1)).min(1),
  limitations: z.array(z.string().min(1)),
});

export const boardSchema = basePart
  .extend({
    category: z.literal('development-board'),
    model: z.literal('ESP32-DevKitC V4'),
    configuration: z
      .object({
        module: z.literal('ESP32-WROOM-32E'),
        header: z.literal('male'),
      })
      .strict(),
    moduleOperatingSupplyVolt: z.object({ minimum: quantity, maximum: quantity }).strict(),
    pins: z
      .array(
        z
          .object({
            terminalId: z.string().min(1),
            header: z.enum(['J2', 'J3']),
            position: z.number().int().positive(),
            printedLabel: z.string().min(1),
            functions: z.array(z.string().min(1)).min(1),
            availableForScenario: z.boolean(),
          })
          .strict(),
      )
      .min(1),
    supplyOptions: z.array(z.enum(['micro-usb', '5v-and-ground', '3v3-and-ground'])).min(1),
  })
  .strict();

export const ledSchema = basePart
  .extend({
    category: z.literal('led'),
    model: z.literal('WP7113ID'),
    package: z.literal('T-1 3/4 (5 mm) through-hole'),
    color: z.literal('high-efficiency red'),
    forwardVoltage: z
      .object({
        testCurrentMilliamp: quantity,
        typicalVolt: quantity,
        maximumVolt: quantity,
        toleranceVolt: quantity,
      })
      .strict(),
    maximumDcForwardCurrentMilliamp: quantity,
    powerDissipationMilliwatt: quantity,
    anodeTerminalId: z.string().min(1),
    cathodeTerminalId: z.string().min(1),
  })
  .strict()
  .superRefine((led, ctx) => {
    const anode = led.terminals.find((terminal) => terminal.id === led.anodeTerminalId);
    const cathode = led.terminals.find((terminal) => terminal.id === led.cathodeTerminalId);
    if (!anode || anode.electricalRole !== 'anode') {
      ctx.addIssue({
        code: 'custom',
        path: ['anodeTerminalId'],
        message: 'Must reference a terminal with the anode electrical role.',
      });
    }
    if (!cathode || cathode.electricalRole !== 'cathode') {
      ctx.addIssue({
        code: 'custom',
        path: ['cathodeTerminalId'],
        message: 'Must reference a terminal with the cathode electrical role.',
      });
    }
    if (led.anodeTerminalId === led.cathodeTerminalId) {
      ctx.addIssue({
        code: 'custom',
        path: ['cathodeTerminalId'],
        message: 'Anode and cathode must be distinct terminals.',
      });
    }
  });

export const resistorSchema = basePart
  .extend({
    category: z.literal('resistor'),
    model: z.literal('CFR-25JB-52-220R'),
    resistanceOhm: quantity,
    tolerancePercent: quantity,
    ratedPowerWatt: quantity,
    construction: z.literal('carbon film'),
    mounting: z.literal('axial through-hole'),
  })
  .strict();

export const hardwarePartSchema = z.discriminatedUnion('category', [
  boardSchema,
  ledSchema,
  resistorSchema,
]);

export const catalogReleaseSchema = z
  .object({
    schemaVersion: z.literal(1),
    releaseId: z.string().regex(/^schemora-hw-[0-9]{4}\.[0-9]{2}$/),
    publishedOn: z.string().date(),
    status: z.literal('curated'),
    sources: z.array(sourceReferenceSchema).min(1),
    claims: z.array(claimSchema).min(1),
    parts: z.array(hardwarePartSchema).min(1),
    breadboardTopologies: z.array(breadboardTopologySchema).min(1),
  })
  .strict()
  .superRefine((release, ctx) => {
    const partIds = new Set(release.parts.map((part) => part.id));
    const topologyIds = new Set(release.breadboardTopologies.map((topology) => topology.id));
    const sourceIds = new Set(release.sources.map((source) => source.id));
    if (topologyIds.size !== release.breadboardTopologies.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['breadboardTopologies'],
        message: 'Topology IDs must be unique within a release.',
      });
    }
    for (const [i, topology] of release.breadboardTopologies.entries()) {
      for (const sourceId of topology.sourceIds) {
        if (!sourceIds.has(sourceId)) {
          ctx.addIssue({
            code: 'custom',
            path: ['breadboardTopologies', i, 'sourceIds'],
            message: `Unknown source ${sourceId}.`,
          });
        }
      }
    }
    for (const [i, part] of release.parts.entries()) {
      if (new Set(part.sourceIds).size !== part.sourceIds.length) {
        ctx.addIssue({
          code: 'custom',
          path: ['parts', i, 'sourceIds'],
          message: 'Source references must be unique.',
        });
      }
      for (const id of part.sourceIds) {
        if (!sourceIds.has(id))
          ctx.addIssue({
            code: 'custom',
            path: ['parts', i, 'sourceIds'],
            message: `Unknown source ${id}.`,
          });
      }
      if (new Set(part.terminals.map((terminal) => terminal.id)).size !== part.terminals.length) {
        ctx.addIssue({
          code: 'custom',
          path: ['parts', i, 'terminals'],
          message: 'Terminal IDs must be unique within a part.',
        });
      }
      if (part.category === 'development-board') {
        for (const pin of part.pins) {
          if (!part.terminals.some((terminal) => terminal.id === pin.terminalId)) {
            ctx.addIssue({
              code: 'custom',
              path: ['parts', i, 'pins'],
              message: `Pin references unknown terminal ${pin.terminalId}.`,
            });
          }
        }
      }
    }
    for (const [i, claim] of release.claims.entries()) {
      if (!partIds.has(claim.subjectId) && !topologyIds.has(claim.subjectId))
        ctx.addIssue({
          code: 'custom',
          path: ['claims', i, 'subjectId'],
          message: 'Claim references an unknown part or topology.',
        });
      if (!sourceIds.has(claim.sourceId))
        ctx.addIssue({
          code: 'custom',
          path: ['claims', i, 'sourceId'],
          message: 'Claim references an unknown source.',
        });
    }
  });

export type CatalogSource = z.infer<typeof sourceReferenceSchema>;
export type CatalogClaim = z.infer<typeof claimSchema>;
export type CatalogPart = z.infer<typeof hardwarePartSchema>;
export type BreadboardTopology = z.infer<typeof breadboardTopologySchema>;
export type CatalogRelease = z.infer<typeof catalogReleaseSchema>;
