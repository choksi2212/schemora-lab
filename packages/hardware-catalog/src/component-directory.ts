import { z } from 'zod';

const componentEntrySchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9.-]+$/),
    manufacturer: z.string().min(1),
    family: z.string().min(1),
    model: z.string().min(1),
    componentType: z.enum(['family', 'series']),
    category: z.enum([
      'timer',
      'operational-amplifier',
      'logic',
      'voltage-regulator',
      'transistor',
      'diode',
      'capacitor',
      'resistor',
      'inductor',
      'transformer',
    ]),
    sourceId: z.string().min(1),
    productUrl: z
      .string()
      .url()
      .refine((url) => new URL(url).protocol === 'https:'),
    supportLevel: z.literal('discovery-only'),
    exactPartNumber: z.boolean(),
    caution: z.string().min(1),
  })
  .strict();

const manufacturers = ['KEMET', 'onsemi', 'Texas Instruments', 'Vishay', 'YAGEO'] as const;

export const componentDirectorySchema = z
  .object({
    schemaVersion: z.literal(1),
    directoryId: z.literal('schemora-component-directory-2026.11'),
    checkedOn: z.string().date(),
    status: z.literal('discovery-index'),
    coverageNote: z.string().min(1),
    sources: z
      .array(
        z
          .object({
            id: z.string().min(1),
            manufacturer: z.enum(manufacturers),
            title: z.string().min(1),
            url: z
              .string()
              .url()
              .refine((url) => new URL(url).protocol === 'https:'),
            checkedOn: z.string().date(),
          })
          .strict(),
      )
      .min(1),
    entries: z.array(componentEntrySchema).min(1),
  })
  .strict()
  .superRefine((directory, ctx) => {
    const sources = new Set(directory.sources.map((source) => source.id));
    const ids = directory.entries.map((entry) => entry.id);
    if (sources.size !== directory.sources.length || new Set(ids).size !== ids.length)
      ctx.addIssue({ code: 'custom', path: ['entries'], message: 'IDs must be unique.' });
    for (const [index, entry] of directory.entries.entries())
      if (!sources.has(entry.sourceId))
        ctx.addIssue({
          code: 'custom',
          path: ['entries', index, 'sourceId'],
          message: 'Every entry must identify a listed manufacturer source.',
        });
  });

const sources = {
  ti: 'https://www.ti.com',
  onsemi: 'https://www.onsemi.com',
  vishay: 'https://www.vishay.com',
  kemet: 'https://www.kemet.com',
  yageo: 'https://yageogroup.com',
};
const family = (
  id: string,
  manufacturer: string,
  model: string,
  category: z.infer<typeof componentEntrySchema>['category'],
  sourceId: string,
  productUrl: string,
  caution: string,
) => ({
  id,
  manufacturer,
  family: model,
  model,
  componentType: 'family' as const,
  category,
  sourceId,
  productUrl,
  supportLevel: 'discovery-only' as const,
  exactPartNumber: false,
  caution,
});

export const componentDirectory2026_11 = componentDirectorySchema.parse({
  schemaVersion: 1,
  directoryId: 'schemora-component-directory-2026.11',
  checkedOn: '2026-11-14',
  status: 'discovery-index',
  coverageNote:
    'A first manufacturer-linked index of common component families. A family name is not an exact orderable part: package, pinout, ratings, suffixes, and operating conditions vary by member. These entries are for discovery only and are not circuit-ready catalog parts.',
  sources: [
    {
      id: 'ti',
      manufacturer: 'Texas Instruments',
      title: 'TI product catalog',
      url: sources.ti,
      checkedOn: '2026-11-14',
    },
    {
      id: 'onsemi',
      manufacturer: 'onsemi',
      title: 'onsemi product and datasheet pages',
      url: sources.onsemi,
      checkedOn: '2026-11-14',
    },
    {
      id: 'vishay',
      manufacturer: 'Vishay',
      title: 'Vishay product catalog',
      url: sources.vishay,
      checkedOn: '2026-11-14',
    },
    {
      id: 'kemet',
      manufacturer: 'KEMET',
      title: 'KEMET capacitor catalog',
      url: sources.kemet,
      checkedOn: '2026-11-14',
    },
    {
      id: 'yageo',
      manufacturer: 'YAGEO',
      title: 'YAGEO resistor product catalog',
      url: sources.yageo,
      checkedOn: '2026-11-14',
    },
  ],
  entries: [
    family(
      'ti.ne555',
      'Texas Instruments',
      'NE555 timer',
      'timer',
      'ti',
      'https://www.ti.com/product/NE555',
      'Package suffixes and electrical limits vary; select a specific orderable part and datasheet.',
    ),
    family(
      'ti.lm358',
      'Texas Instruments',
      'LM358 dual operational amplifier',
      'operational-amplifier',
      'ti',
      'https://www.ti.com/product/LM358',
      'LM358B is a distinct upgraded variant; do not transfer its specifications to every LM358.',
    ),
    family(
      'ti.sn74hc595',
      'Texas Instruments',
      'SN74HC595 shift register',
      'logic',
      'ti',
      'https://www.ti.com/product/SN74HC595',
      'Logic family and package suffix matter; check supply, thresholds, and output limits.',
    ),
    family(
      'ti.lm317',
      'Texas Instruments',
      'LM317 adjustable regulator',
      'voltage-regulator',
      'ti',
      'https://www.ti.com/product/LM317',
      'Thermal, dropout, package, and external-component limits require exact-part review.',
    ),
    family(
      'onsemi.2n3904',
      'onsemi',
      '2N3904 NPN transistor',
      'transistor',
      'onsemi',
      'https://www.onsemi.com/pdf/datasheet/2n3904-d.pdf',
      'Check package pin arrangement and DC gain/test conditions for the exact ordering code.',
    ),
    family(
      'onsemi.2n3906',
      'onsemi',
      '2N3906 PNP transistor',
      'transistor',
      'onsemi',
      'https://www.onsemi.com/download/data-sheet/pdf/2n3906-d.pdf',
      'Check package pin arrangement and DC gain/test conditions for the exact ordering code.',
    ),
    family(
      'vishay.1n4148',
      'Vishay',
      '1N4148 switching diode',
      'diode',
      'vishay',
      'https://www.vishay.com/en/product/81857/',
      'Package, suffix, polarity marking, and switching conditions vary among variants.',
    ),
    family(
      'vishay.1n400x',
      'Vishay',
      '1N4001–1N4007 rectifier diode series',
      'diode',
      'vishay',
      'https://www.vishay.com/en/product/88503/',
      'The voltage grade is part of the identity; this series record is not one interchangeable device.',
    ),
    family(
      'kemet.c0g-mlcc',
      'KEMET',
      'C0G ceramic capacitor family',
      'capacitor',
      'kemet',
      'https://www.kemet.com/en/us/capacitors/ceramic.html',
      'Capacitance, voltage, package, tolerance, and termination are required to identify a usable part.',
    ),
    family(
      'kemet.x7r-mlcc',
      'KEMET',
      'X7R ceramic capacitor family',
      'capacitor',
      'kemet',
      'https://www.kemet.com/en/us/capacitors/ceramic.html',
      'Capacitance can vary with DC bias and temperature; select an exact part and review its curves.',
    ),
    family(
      'yageo.carbon-film-resistors',
      'YAGEO',
      'Carbon film resistors',
      'resistor',
      'yageo',
      'https://yageogroup.com/browse/products/Resistors',
      'Resistance, tolerance, power, voltage, temperature coefficient, and dimensions are exact-part properties.',
    ),
    family(
      'yageo.thick-film-chip-resistors',
      'YAGEO',
      'Thick film chip resistors',
      'resistor',
      'yageo',
      'https://yageogroup.com/browse/products/Resistors',
      'Resistance, tolerance, power, case size, and termination are exact-part properties.',
    ),
    family(
      'yageo.thin-film-chip-resistors',
      'YAGEO',
      'Thin film chip resistors',
      'resistor',
      'yageo',
      'https://yageogroup.com/browse/products/Resistors',
      'Precision and temperature coefficient vary by series and exact order code.',
    ),
    family(
      'vishay.wirewound-resistors',
      'Vishay',
      'Wirewound power resistors',
      'resistor',
      'vishay',
      'https://www.vishay.com/en/resistors-fixed/',
      'Power, pulse, resistance, mounting, and thermal derating vary by exact model.',
    ),
    family(
      'vishay.aluminum-electrolytic-capacitors',
      'Vishay',
      'Aluminum electrolytic capacitors',
      'capacitor',
      'vishay',
      'https://www.vishay.com/en/capacitors/aluminum/',
      'Polarity, capacitance, voltage, ripple current, ESR, lifetime, and temperature are exact-part properties.',
    ),
    family(
      'vishay.film-capacitors',
      'Vishay',
      'Film capacitors',
      'capacitor',
      'vishay',
      'https://www.vishay.com/en/capacitors/film/',
      'Dielectric, capacitance, voltage class, pulse behavior, safety class, and package need exact review.',
    ),
    family(
      'vishay.tantalum-capacitors',
      'Vishay',
      'Tantalum capacitors',
      'capacitor',
      'vishay',
      'https://www.vishay.com/en/capacitors/tantalum/',
      'Polarity, surge behavior, voltage derating, capacitance, and ESR require exact-part review.',
    ),
    family(
      'vishay.power-inductors',
      'Vishay',
      'Power inductors and chokes',
      'inductor',
      'vishay',
      'https://www.vishay.com/en/inductors/',
      'Inductance, saturation current, RMS current, DCR, core loss, and package vary by exact model.',
    ),
    family(
      'vishay.signal-transformers',
      'Vishay',
      'Pulse and signal transformers',
      'transformer',
      'vishay',
      'https://www.vishay.com/en/inductors/transformers/',
      'Turns ratio, isolation rating, bandwidth, winding polarity, and footprint require exact documentation.',
    ),
  ],
});

export function getComponentDirectory() {
  return componentDirectorySchema.parse(componentDirectory2026_11);
}

export type ComponentDirectory = z.infer<typeof componentDirectorySchema>;
