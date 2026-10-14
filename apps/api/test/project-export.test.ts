import { describe, expect, it } from 'vitest';
import { getCatalogRelease } from '@schemora/catalog';
import type { CircuitGraph } from '@schemora/circuit-model';
import {
  buildProjectSpecification,
  buildWiringChecklist,
  type ExportProject,
} from '../src/project-export.js';

const catalog = getCatalogRelease();
const project: ExportProject = {
  id: 'project-1',
  title: 'LED | prototype',
  revision: 4,
  createdAt: '2026-10-14T00:00:00.000Z',
  updatedAt: '2026-10-14T01:00:00.000Z',
};
const graph: CircuitGraph = {
  schemaVersion: 1,
  id: 'graph-1',
  projectId: project.id,
  projectRevision: 4,
  catalogReleaseId: catalog.releaseId,
  components: [
    { id: 'board-1', catalogPartId: 'board.espressif.esp32-devkitc-v4.wroom-32e.male' },
    { id: 'led-1', catalogPartId: 'led.kingbright.wp7113id' },
  ],
  breadboards: [
    {
      id: 'breadboard-1',
      topologyId: 'breadboard.busboard.bb400',
      topologyVersion: 1,
      railVariants: [],
    },
  ],
  terminalPlacements: [
    {
      terminal: { componentInstanceId: 'led-1', catalogTerminalId: 'anode' },
      hole: { breadboardInstanceId: 'breadboard-1', holeId: 'a1' },
    },
  ],
  wires: [
    {
      id: 'wire-1',
      source: {
        kind: 'terminal',
        terminal: { componentInstanceId: 'board-1', catalogTerminalId: 'gpio19' },
      },
      target: {
        kind: 'terminal',
        terminal: { componentInstanceId: 'led-1', catalogTerminalId: 'anode' },
      },
    },
  ],
};

describe('project export', () => {
  it('exports only the saved specification and states private data excluded', () => {
    const result = buildProjectSpecification({
      project,
      graph,
      graphDigest: 'a'.repeat(64),
      catalog,
      catalogDigest: 'b'.repeat(64),
      validation: null,
      validationDigest: null,
    });
    expect(result.format).toBe('schemora-project-specification');
    expect(result.circuit?.catalogParts).toHaveLength(2);
    expect(result.integrity.circuitGraphSha256).toBe('a'.repeat(64));
    expect(result.excludedPrivateData).toContain('firmware source and build artifacts');
    expect(JSON.stringify(result)).not.toContain('contentBase64');
  });

  it('generates an escaped, printable wiring checklist from exact terminal labels', () => {
    const result = buildWiringChecklist({ project, graph, catalog });
    expect(result).toContain('# Wiring checklist — LED \\| prototype');
    expect(result).toContain('GPIO19');
    expect(result).toContain('Anode');
    expect(result).toContain('hole a1');
    expect(result).toContain('does not verify electrical ratings');
  });

  it('reports an empty graph clearly without implying saved connections', () => {
    const result = buildWiringChecklist({ project, graph: null, catalog: null });
    expect(result).toContain('No saved circuit graph is available');
  });

  it('escapes heading metacharacters and line breaks in user-controlled titles', () => {
    const result = buildWiringChecklist({
      project: { ...project, title: '[example](url)\n# injected heading' },
      graph: null,
      catalog: null,
    });
    expect(result.split('\n')[0]).toBe(
      '# Wiring checklist — \\[example\\]\\(url\\) \\# injected heading',
    );
    expect(result).not.toContain('\n# injected heading');
  });
});
