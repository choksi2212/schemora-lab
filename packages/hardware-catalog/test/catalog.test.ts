import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  catalogReleaseSchema,
  assessCatalogUpgrade,
  validateCatalogHistory,
  getCatalogRelease,
  getCatalogReleaseById,
  getCatalogReleases,
  getHardwareFamilyContract,
} from '../src/index.js';

describe('curated hardware catalog release', () => {
  const historyManifest = JSON.parse(
    readFileSync(new URL('../catalog-history.json', import.meta.url), 'utf8'),
  ) as unknown;

  function contentDigests(releases: ReturnType<typeof getCatalogReleases>) {
    const canonicalJson = (value: unknown): string => {
      if (value === null || typeof value !== 'object') return JSON.stringify(value);
      if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
      const record = value as Record<string, unknown>;
      return `{${Object.keys(record)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
        .join(',')}}`;
    };
    return Object.fromEntries(
      releases.map((release) => [
        release.releaseId,
        createHash('sha256').update(canonicalJson(release), 'utf8').digest('hex'),
      ]),
    );
  }

  it('parses the published immutable starter release', () => {
    const release = getCatalogRelease();
    expect(release.releaseId).toBe('schemora-hw-2026.10.1');
    expect(release.parts.map((part) => part.id)).toEqual([
      'board.espressif.esp32-devkitc-v4.wroom-32e.male',
      'led.kingbright.wp7113id',
      'resistor.yageo.cfr-25jb-52-220r',
      'button.omron.b3f-1000',
    ]);
  });

  it('retains and resolves immutable historical releases by their pinned ID', () => {
    const releases = getCatalogReleases();
    expect(releases.map((release) => release.releaseId)).toEqual([
      'schemora-hw-2026.10',
      'schemora-hw-2026.10.1',
    ]);
    expect(getCatalogReleaseById('schemora-hw-2026.10')?.parts).toHaveLength(3);
    expect(getCatalogReleaseById('schemora-hw-unknown')).toBeUndefined();
  });

  it('validates chronological release deltas and leaves independent review as a visible gate', () => {
    const releases = getCatalogReleases();
    const result = validateCatalogHistory(releases, historyManifest, contentDigests(releases));
    expect(result).toEqual({
      valid: true,
      publicationReady: false,
      issues: [],
      pendingIndependentReviews: ['schemora-hw-2026.10', 'schemora-hw-2026.10.1'],
    });
  });

  it('rejects catalog changes that were not recorded in the release history', () => {
    const releases = getCatalogReleases();
    const latest = releases[1]!;
    const part = latest.parts.find((candidate) => candidate.id === 'button.omron.b3f-1000');
    if (part?.category !== 'pushbutton') throw new Error('Expected the pushbutton record.');
    part.summary += ' Unrecorded change.';
    const result = validateCatalogHistory(releases, historyManifest, contentDigests(releases));
    expect(result.valid).toBe(false);
    expect(result.issues).toContain(
      'schemora-hw-2026.10.1: content SHA-256 does not match the release history record.',
    );
  });

  it('allows additive releases when every graph-referenced fact remains equivalent', () => {
    const releases = getCatalogReleases();
    const assessment = assessCatalogUpgrade(releases[0]!, releases[1]!, {
      componentPartIds: [
        'board.espressif.esp32-devkitc-v4.wroom-32e.male',
        'led.kingbright.wp7113id',
      ],
      topologies: [{ id: 'breadboard.busboard.bb400', version: 1 }],
    });
    expect(assessment).toEqual({ compatible: true, differences: [] });
  });

  it('blocks an upgrade when a referenced part fact changes under the same ID', () => {
    const from = getCatalogReleases()[0]!;
    const to = structuredClone(getCatalogReleases()[1]!);
    const board = to.parts.find((part) => part.category === 'development-board');
    if (board?.category !== 'development-board') throw new Error('Expected the board record.');
    board.pins.find((pin) => pin.terminalId === 'gpio19')!.printedLabel = 'GPIO19';
    const assessment = assessCatalogUpgrade(from, to, {
      componentPartIds: ['board.espressif.esp32-devkitc-v4.wroom-32e.male'],
      topologies: [],
    });
    expect(assessment.compatible).toBe(false);
    expect(assessment.differences).toContainEqual({
      kind: 'part',
      id: 'board.espressif.esp32-devkitc-v4.wroom-32e.male',
      reason: 'changed',
    });
  });

  it('blocks an upgrade when a referenced claim changes under an unchanged part ID', () => {
    const from = getCatalogReleases()[0]!;
    const to = structuredClone(getCatalogReleases()[1]!);
    to.claims.find(
      (claim) => claim.subjectId === 'board.espressif.esp32-devkitc-v4.wroom-32e.male',
    )!.note += ' Edited evidence note.';
    const assessment = assessCatalogUpgrade(from, to, {
      componentPartIds: ['board.espressif.esp32-devkitc-v4.wroom-32e.male'],
      topologies: [],
    });
    expect(assessment.differences).toContainEqual({
      kind: 'claim',
      id: 'board.espressif.esp32-devkitc-v4.wroom-32e.male',
      reason: 'changed',
    });
  });

  it('blocks an upgrade when a source record changes for a referenced part', () => {
    const from = getCatalogReleases()[0]!;
    const to = structuredClone(getCatalogReleases()[1]!);
    to.sources.find((source) => source.id === 'espressif-devkitc-v4-guide')!.documentRevision =
      'different revision';
    const assessment = assessCatalogUpgrade(from, to, {
      componentPartIds: ['board.espressif.esp32-devkitc-v4.wroom-32e.male'],
      topologies: [],
    });
    expect(assessment.differences).toContainEqual({
      kind: 'source',
      id: 'espressif-devkitc-v4-guide',
      reason: 'changed',
    });
  });

  it('blocks an upgrade when a referenced breadboard topology changes', () => {
    const from = getCatalogReleases()[0]!;
    const to = structuredClone(getCatalogReleases()[1]!);
    to.breadboardTopologies[0]!.terminalStripGroups[0]!.holes[0] = 'a2';
    const assessment = assessCatalogUpgrade(from, to, {
      componentPartIds: [],
      topologies: [{ id: 'breadboard.busboard.bb400', version: 1 }],
    });
    expect(assessment.compatible).toBe(false);
    expect(assessment.differences).toContainEqual({
      kind: 'topology',
      id: 'breadboard.busboard.bb400@1',
      reason: 'changed',
    });
  });

  it('registers the B3F family contract with only circuit-level contact behavior', () => {
    expect(getHardwareFamilyContract('button.omron.b3f-1000')).toMatchObject({
      familyId: 'momentary-tactile-switch',
      simulation: {
        mode: 'circuit-level',
        adapterId: 'schemora.ideal-switch-net/v1',
        inputStimulusIds: ['press', 'release'],
      },
      validation: { fixturesRequired: true },
    });
    expect(getHardwareFamilyContract('button.generic.unknown')).toBeUndefined();
  });

  it('records the B3F-1000 bottom-view pin groups and normally-open press connection', () => {
    const button = getCatalogRelease().parts.find((part) => part.category === 'pushbutton');
    expect(button).toMatchObject({
      id: 'button.omron.b3f-1000',
      model: 'B3F-1000',
      terminalGroups: [
        { id: 'left-side', terminalIds: ['pin-2', 'pin-4'] },
        { id: 'right-side', terminalIds: ['pin-1', 'pin-3'] },
      ],
      pressedConnection: ['left-side', 'right-side'],
      contactType: 'normally-open momentary',
    });
  });

  it('rejects an invalid B3F terminal partition', () => {
    const release = structuredClone(getCatalogRelease());
    const button = release.parts.find((part) => part.category === 'pushbutton');
    if (button?.category !== 'pushbutton') throw new Error('Expected the pushbutton record.');
    button.terminalGroups[0].terminalIds[1] = 'pin-2';
    expect(catalogReleaseSchema.safeParse(release).success).toBe(false);
  });

  it('models the exact BB400 topology with all 400 holes and one verified continuous variant per rail', () => {
    const topology = getCatalogRelease().breadboardTopologies[0]!;
    expect(topology.id).toBe('breadboard.busboard.bb400');
    expect(topology.version).toBe(1);
    expect(topology.physicalModel).toMatchObject({
      model: 'BB400',
      orderableVariants: ['BB400 (white)', 'BB400T (transparent)'],
      holePitchMm: 2.54,
    });
    expect(topology.terminalStripGroups).toHaveLength(60);
    expect(topology.terminalStripGroups.every((group) => group.holes.length === 5)).toBe(true);
    expect(topology.railGroups).toHaveLength(4);
    expect(
      topology.railGroups.every(
        (rail) =>
          rail.holes.length === 25 &&
          rail.connectivityVariants.length === 1 &&
          rail.connectivityVariants[0]?.id === 'continuous',
      ),
    ).toBe(true);
    expect(topology.terminalStripGroups.flatMap((group) => group.holes)).toHaveLength(300);
    expect(topology.railGroups.flatMap((rail) => rail.holes)).toHaveLength(100);
  });

  it('maps only the verified IO19 board alias and selected ground headers', () => {
    const board = getCatalogRelease().parts.find((part) => part.category === 'development-board');
    expect(board?.category).toBe('development-board');
    if (board?.category !== 'development-board') throw new Error('Expected the board record.');
    expect(board.configuration).toEqual({ module: 'ESP32-WROOM-32E', header: 'male' });
    expect(board.pins.find((pin) => pin.terminalId === 'gpio19')).toMatchObject({
      header: 'J3',
      position: 8,
      printedLabel: 'IO19',
      functions: ['GPIO19'],
      availableForScenario: true,
    });
    expect(board.moduleOperatingSupplyVolt).toEqual({ minimum: 3, maximum: 3.6 });
  });

  it('rejects a claim whose source is not part of the release', () => {
    const release = structuredClone(getCatalogRelease());
    release.claims[0]!.sourceId = 'unreviewed-url';
    expect(catalogReleaseSchema.safeParse(release).success).toBe(false);
  });

  it('rejects duplicate source identities and non-HTTPS citation URLs', () => {
    const duplicate = structuredClone(getCatalogRelease());
    duplicate.sources.push(structuredClone(duplicate.sources[0]!));
    expect(catalogReleaseSchema.safeParse(duplicate).success).toBe(false);

    const insecure = structuredClone(getCatalogRelease());
    insecure.sources[0]!.url = insecure.sources[0]!.url.replace('https:', 'http:');
    expect(catalogReleaseSchema.safeParse(insecure).success).toBe(false);
  });

  it('rejects duplicate physical board pin positions', () => {
    const release = structuredClone(getCatalogRelease());
    const board = release.parts.find((part) => part.category === 'development-board');
    if (board?.category !== 'development-board') throw new Error('Expected the board record.');
    board.pins[1]!.header = board.pins[0]!.header;
    board.pins[1]!.position = board.pins[0]!.position;
    expect(catalogReleaseSchema.safeParse(release).success).toBe(false);
  });

  it('rejects exact duplicate evidence claims', () => {
    const release = structuredClone(getCatalogRelease());
    release.claims.push(structuredClone(release.claims[0]!));
    expect(catalogReleaseSchema.safeParse(release).success).toBe(false);
  });

  it('rejects a board pin that maps to no semantic terminal', () => {
    const release = structuredClone(getCatalogRelease());
    const board = release.parts.find((part) => part.category === 'development-board');
    if (board?.category !== 'development-board') throw new Error('Expected the board record.');
    board.pins[0]!.terminalId = 'gpio-not-present';
    expect(catalogReleaseSchema.safeParse(release).success).toBe(false);
  });

  it('requires LED polarity fields to resolve to distinct terminals with matching electrical roles', () => {
    const release = structuredClone(getCatalogRelease());
    const led = release.parts.find((part) => part.category === 'led');
    if (led?.category !== 'led') throw new Error('Expected the LED record.');
    expect(led.anodeTerminalId).toBe('anode');
    expect(led.cathodeTerminalId).toBe('cathode');
    led.anodeTerminalId = 'missing-terminal';
    expect(catalogReleaseSchema.safeParse(release).success).toBe(false);
  });

  it('preserves exact electrical ratings without declaring an assembled circuit safe', () => {
    const release = getCatalogRelease();
    const led = release.parts.find((part) => part.category === 'led');
    const resistor = release.parts.find((part) => part.category === 'resistor');
    expect(led).toMatchObject({
      category: 'led',
      forwardVoltage: {
        testCurrentMilliamp: 10,
        typicalVolt: 1.9,
        maximumVolt: 2.3,
        toleranceVolt: 0.1,
      },
      maximumDcForwardCurrentMilliamp: 30,
    });
    expect(resistor).toMatchObject({
      category: 'resistor',
      resistanceOhm: 220,
      tolerancePercent: 5,
      ratedPowerWatt: 0.25,
    });
  });
});
