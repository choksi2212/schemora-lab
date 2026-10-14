import type { CatalogRelease } from './schema.js';
import { catalogRelease2026_10 } from './release-2026-10.js';

/** Immutable catalog snapshot adding one exact, source-reviewed tactile switch SKU. */
export const catalogRelease2026_10_1 = {
  ...catalogRelease2026_10,
  releaseId: 'schemora-hw-2026.10.1',
  publishedOn: '2026-10-14',
  sources: [
    ...catalogRelease2026_10.sources,
    {
      id: 'omron-b3f-datasheet',
      url: 'https://omronfs.omron.com/en_US/ecb/products/pdf/en-b3f.pdf',
      publisher: 'OMRON',
      title: 'B3F Tactile Switch Datasheet',
      accessedOn: '2026-10-14',
      documentRevision: null,
    },
  ],
  parts: [
    ...catalogRelease2026_10.parts,
    {
      id: 'button.omron.b3f-1000',
      manufacturer: 'OMRON',
      model: 'B3F-1000',
      category: 'pushbutton',
      identityScope: 'exact-configuration',
      summary:
        '6 × 6 mm standard flat-plunger, normally-open momentary tactile switch without a ground terminal.',
      package: '6 × 6 mm through-hole tactile switch',
      contactType: 'normally-open momentary',
      terminals: [
        {
          id: 'pin-1',
          label: 'Terminal 1 (bottom view: upper-right)',
          electricalRole: 'switch-contact',
        },
        {
          id: 'pin-2',
          label: 'Terminal 2 (bottom view: upper-left)',
          electricalRole: 'switch-contact',
        },
        {
          id: 'pin-3',
          label: 'Terminal 3 (bottom view: lower-right)',
          electricalRole: 'switch-contact',
        },
        {
          id: 'pin-4',
          label: 'Terminal 4 (bottom view: lower-left)',
          electricalRole: 'switch-contact',
        },
      ],
      terminalGroups: [
        { id: 'left-side', terminalIds: ['pin-2', 'pin-4'] },
        { id: 'right-side', terminalIds: ['pin-1', 'pin-3'] },
      ],
      pressedConnection: ['left-side', 'right-side'],
      operatingForceNewton: 0.98,
      heightMm: 4.3,
      sourceIds: ['omron-b3f-datasheet'],
      limitations: [
        'The bottom-view terminal numbers and top-view PCB/contact drawing define orientation; verify pin numbering against the manufacturer drawing before physical wiring.',
        'Terminal groups encode the two internally common sides; pressing connects the groups. The catalog does not model contact resistance, contact bounce, debounce, wear, or time-dependent behavior.',
        'The 0.98 N operating force and 4.3 mm height are nominal catalog values from the datasheet; product tolerances and environmental conditions still apply.',
        'No voltage/current switching rating or MCU input compatibility is asserted by this record. Do not infer a pull-up, pull-down, GPIO protection, or safe circuit from the switch identity alone.',
        'No reviewed 2D/3D geometry, breadboard footprint anchors, assembly clearance, or firmware simulation adapter is included by this catalog record.',
      ],
    },
  ],
  claims: [
    ...catalogRelease2026_10.claims,
    {
      subjectId: 'button.omron.b3f-1000',
      property: 'model/package/contactType/operatingForceNewton/heightMm',
      sourceId: 'omron-b3f-datasheet',
      locator:
        'Page 1, 6 × 6 mm model table; page 4, standard flat plunger type without ground terminal',
      note: 'OMRON identifies B3F-1000 as the 6 × 6 mm standard flat-plunger model without ground terminal; its table specifies 4.3 mm height and 0.98 N operating force.',
    },
    {
      subjectId: 'button.omron.b3f-1000',
      property: 'terminals/terminalGroups/pressedConnection',
      sourceId: 'omron-b3f-datasheet',
      locator:
        'Page 4, bottom-view terminal numbering and top-view terminal arrangement/internal connections for B3F-1000',
      note: 'The bottom view numbers the terminals 2 upper-left, 1 upper-right, 4 lower-left, and 3 lower-right. The top-view internal-connection drawing shows terminals 2 and 4 as one side and terminals 1 and 3 as the other, bridged by actuation.',
    },
  ],
} satisfies CatalogRelease;
