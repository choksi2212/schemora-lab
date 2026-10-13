import { describe, expect, it } from 'vitest';
import { catalogReleaseSchema, getCatalogRelease } from '../src/index.js';

describe('curated hardware catalog release', () => {
  it('parses the published immutable starter release', () => {
    const release = getCatalogRelease();
    expect(release.releaseId).toBe('schemora-hw-2026.10');
    expect(release.parts.map((part) => part.id)).toEqual([
      'board.espressif.esp32-devkitc-v4.wroom-32e.male',
      'led.kingbright.wp7113id',
      'resistor.yageo.cfr-25jb-52-220r',
    ]);
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
