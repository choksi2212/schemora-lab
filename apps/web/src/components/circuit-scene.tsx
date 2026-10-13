'use client';

import {
  Component,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ErrorInfo,
  type ReactNode,
} from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import { resolveSimulationLedStates, type SceneSimulationRun } from './simulation-scene-state';
import styles from './circuit-scene.module.css';

type Endpoint =
  | { kind: 'terminal'; terminal: { componentInstanceId: string; catalogTerminalId: string } }
  | { kind: 'hole'; hole: { breadboardInstanceId: string; holeId: string } };

export type CircuitWorkbenchGraph = {
  schemaVersion: 1;
  id: string;
  projectId: string;
  projectRevision: number;
  catalogReleaseId: string;
  components: { id: string; catalogPartId: string }[];
  breadboards: {
    id: string;
    topologyId: string;
    topologyVersion: number;
    railVariants: { railGroupId: string; variantId: string }[];
  }[];
  terminalPlacements: {
    terminal: { componentInstanceId: string; catalogTerminalId: string };
    hole: { breadboardInstanceId: string; holeId: string };
  }[];
  wires: { id: string; source: Endpoint; target: Endpoint }[];
  visualLayout?: {
    schemaVersion: 1;
    componentPlacements: {
      componentInstanceId: string;
      x: number;
      z: number;
      rotationY: number;
    }[];
  };
};

type TerminalRef = { componentInstanceId: string; catalogTerminalId: string };
type Props = {
  graph: CircuitWorkbenchGraph;
  onGraphChange: (graph: CircuitWorkbenchGraph) => void;
  simulationRun?: SceneSimulationRun | null;
  currentGraphDigest?: string | null;
  currentFirmwareDigest?: string | null;
  className?: string;
  title?: string;
};
type Vec3 = [number, number, number];
type VisualPose = { x: number; z: number; rotationY: number };

const partNames: Record<string, string> = {
  'board.espressif.esp32-devkitc-v4.wroom-32e.male': 'ESP32-DevKitC V4 · WROOM-32E',
  'resistor.yageo.cfr-25jb-52-220r': 'YAGEO 220 Ω resistor',
  'led.kingbright.wp7113id': 'Kingbright WP7113ID red LED',
};
const terminalNames: Record<string, Record<string, string>> = {
  'board.espressif.esp32-devkitc-v4.wroom-32e.male': {
    gpio19: 'GPIO19 / IO19',
    'gnd-j3-1': 'J3 GND position 1',
    'gnd-j3-7': 'J3 GND position 7',
    '3v3-j2-1': 'J2 3V3 position 1',
  },
  'resistor.yageo.cfr-25jb-52-220r': { 'lead-a': 'Lead A', 'lead-b': 'Lead B' },
  'led.kingbright.wp7113id': { anode: 'Anode', cathode: 'Cathode' },
};

function poseFor(
  graph: CircuitWorkbenchGraph,
  componentId: string,
  catalogPartId: string,
): VisualPose {
  const saved = graph.visualLayout?.componentPlacements.find(
    (placement) => placement.componentInstanceId === componentId,
  );
  if (saved) return saved;
  if (catalogPartId.includes('esp32-devkitc')) return { x: 0, z: 0.63, rotationY: 0 };
  if (catalogPartId.includes('resistor')) return { x: 0, z: 0.12, rotationY: 0 };
  if (catalogPartId.includes('led')) return { x: 0.95, z: -0.05, rotationY: 0 };
  return { x: 0, z: 0, rotationY: 0 };
}

function isWebGLAvailable() {
  try {
    const canvas = document.createElement('canvas');
    return Boolean(canvas.getContext('webgl2') || canvas.getContext('webgl'));
  } catch {
    return false;
  }
}

class SceneBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('3D circuit view failed to render', error, info);
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function pointForHole(holeId: string): Vec3 | null {
  const terminal = /^([A-J])(\d{1,2})$/.exec(holeId);
  if (terminal) {
    const row = terminal[1]!.charCodeAt(0) - 65;
    const column = Number(terminal[2]);
    if (column < 1 || column > 30) return null;
    return [
      -3.65 + (column - 1) * 0.25,
      0.23,
      row < 5 ? 0.55 + row * 0.25 : -0.55 - (row - 5) * 0.25,
    ];
  }
  const rail = /^rail-([1-4]):(\d{1,2})$/.exec(holeId);
  if (rail) {
    const row = Number(rail[1]);
    const column = Number(rail[2]);
    if (column < 1 || column > 25) return null;
    return [
      -3.15 + (column - 1) * 0.25,
      0.23,
      row < 3 ? 1.55 + (row - 1) * 0.18 : -1.55 - (row - 3) * 0.18,
    ];
  }
  return null;
}

function terminalPoint(partId: string, terminalId: string): Vec3 | null {
  if (partId.includes('esp32-devkitc')) {
    const anchors: Record<string, Vec3> = {
      gpio19: [-0.63, 0.38, 0.306],
      'gnd-j3-1': [-0.63, 0.38, -0.31],
      'gnd-j3-7': [-0.63, 0.38, 0.218],
      '3v3-j2-1': [0.63, 0.38, -0.31],
    };
    return anchors[terminalId] ?? null;
  }
  if (partId.includes('resistor'))
    return terminalId === 'lead-a' ? [-0.48, 0.36, 0] : [0.48, 0.36, 0];
  if (partId.includes('led')) return terminalId === 'anode' ? [-0.07, 0.39, 0] : [0.07, 0.39, 0];
  return null;
}

function transformPoint(point: Vec3, pose: VisualPose): Vec3 {
  const angle = (pose.rotationY * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return [
    pose.x + point[0] * cos + point[2] * sin,
    point[1],
    pose.z - point[0] * sin + point[2] * cos,
  ];
}

function endpointPoint(
  endpoint: Endpoint,
  graph: CircuitWorkbenchGraph,
  partById: Map<string, string>,
): Vec3 | null {
  if (endpoint.kind === 'hole') return pointForHole(endpoint.hole.holeId);
  const ref = endpoint.terminal;
  const placement = graph.terminalPlacements.find(
    (entry) =>
      entry.terminal.componentInstanceId === ref.componentInstanceId &&
      entry.terminal.catalogTerminalId === ref.catalogTerminalId,
  );
  if (placement) return pointForHole(placement.hole.holeId);
  const catalogPartId = partById.get(ref.componentInstanceId) ?? '';
  const point = terminalPoint(catalogPartId, ref.catalogTerminalId);
  return point
    ? transformPoint(point, poseFor(graph, ref.componentInstanceId, catalogPartId))
    : null;
}

function Wire({
  start,
  end,
  color,
  onRemove,
}: {
  start: Vec3;
  end: Vec3;
  color: string;
  onRemove?: () => void;
}) {
  const curve = useMemo(
    () =>
      new THREE.QuadraticBezierCurve3(
        new THREE.Vector3(...start),
        new THREE.Vector3(
          (start[0] + end[0]) / 2,
          Math.max(start[1], end[1]) + 0.3,
          (start[2] + end[2]) / 2,
        ),
        new THREE.Vector3(...end),
      ),
    [start, end],
  );
  const points = useMemo(() => curve.getPoints(24), [curve]);
  return (
    <mesh
      onClick={
        onRemove
          ? (event) => {
              event.stopPropagation();
              onRemove();
            }
          : undefined
      }
      onPointerOver={
        onRemove
          ? (event) => {
              event.stopPropagation();
              document.body.style.cursor = 'pointer';
            }
          : undefined
      }
      onPointerOut={
        onRemove
          ? () => {
              document.body.style.cursor = '';
            }
          : undefined
      }
    >
      <tubeGeometry args={[new THREE.CatmullRomCurve3(points), 32, 0.035, 8, false]} />
      <meshStandardMaterial color={color} roughness={0.36} />
    </mesh>
  );
}

function InstancedHoles({
  positions,
  radius,
  color,
}: {
  positions: Vec3[];
  radius: number;
  color: string;
}) {
  const instanceRef = useRef<THREE.InstancedMesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  useEffect(() => {
    const mesh = instanceRef.current;
    if (!mesh) return;
    positions.forEach(([x, y, z], index) => {
      dummy.position.set(x, y, z);
      dummy.updateMatrix();
      mesh.setMatrixAt(index, dummy.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
  }, [positions, dummy]);
  return (
    <instancedMesh ref={instanceRef} args={[undefined, undefined, positions.length]}>
      <cylinderGeometry args={[radius, radius, 0.012, 10]} />
      <meshStandardMaterial color={color} />
    </instancedMesh>
  );
}

function BoardScene({
  graph,
  ledStates,
  selected,
  onSelect,
  onRemoveWire,
  onSelectComponent,
}: {
  graph: CircuitWorkbenchGraph;
  ledStates: Readonly<Record<string, 'on' | 'off'>>;
  selected: TerminalRef | null;
  onSelect: (terminal: TerminalRef) => void;
  onRemoveWire: (wireId: string) => void;
  onSelectComponent: (componentId: string) => void;
}) {
  const parts = useMemo(
    () => new Map(graph.components.map((entry) => [entry.id, entry.catalogPartId])),
    [graph.components],
  );
  const tiePointPositions = useMemo(
    () =>
      Array.from({ length: 30 }, (_, col) =>
        Array.from(
          { length: 10 },
          (_, row): Vec3 => [
            -3.65 + col * 0.25,
            0.185,
            row < 5 ? 0.55 + row * 0.25 : -0.55 - (row - 5) * 0.25,
          ],
        ),
      ).flat(),
    [],
  );
  const railPositions = useMemo(
    () =>
      Array.from({ length: 4 }, (_, rail) =>
        Array.from(
          { length: 25 },
          (_, col): Vec3 => [
            -3.15 + col * 0.25,
            0.185,
            rail < 2 ? 1.55 + rail * 0.18 : -1.55 - (rail - 2) * 0.18,
          ],
        ),
      ).flat(),
    [],
  );
  const wireColors = ['#f05c43', '#2585d8', '#35a66d', '#e1a52f', '#ab6ac7'];
  return (
    <>
      <color attach="background" args={['#f2f5f8']} />
      <ambientLight intensity={1.8} />
      <directionalLight position={[4, 8, 5]} intensity={2.1} castShadow />
      <group position={[0, -0.3, 0]}>
        <mesh receiveShadow position={[0, 0, 0]}>
          <boxGeometry args={[8.1, 0.22, 5.2]} />
          <meshStandardMaterial color="#dce7ed" roughness={0.78} />
        </mesh>
        <mesh position={[0, 0.13, 0]}>
          <boxGeometry args={[7.85, 0.08, 5.0]} />
          <meshStandardMaterial color="#fdfefe" roughness={0.72} />
        </mesh>
        <InstancedHoles positions={tiePointPositions} radius={0.038} color="#8c9da7" />
        <InstancedHoles positions={railPositions} radius={0.032} color="#9eabb2" />
        <mesh position={[0, 0.178, 0]}>
          <boxGeometry args={[7.8, 0.015, 0.08]} />
          <meshStandardMaterial color="#d0d9dd" />
        </mesh>
        {graph.components.map((component) => {
          const pose = poseFor(graph, component.id, component.catalogPartId);
          const rotation: [number, number, number] = [0, (pose.rotationY * Math.PI) / 180, 0];
          const selectPart = (event: { stopPropagation: () => void }) => {
            event.stopPropagation();
            onSelectComponent(component.id);
          };
          return component.catalogPartId.includes('esp32-devkitc') ? (
            <group
              key={component.id}
              position={[pose.x, 0.34, pose.z]}
              rotation={rotation}
              onClick={selectPart}
            >
              <mesh castShadow>
                <boxGeometry args={[1.65, 0.12, 0.8]} />
                <meshStandardMaterial color="#136a6b" roughness={0.48} />
              </mesh>
              <mesh position={[0, 0.07, 0]}>
                <boxGeometry args={[0.52, 0.04, 0.58]} />
                <meshStandardMaterial color="#333d45" />
              </mesh>
              {Array.from({ length: 8 }, (_, i) =>
                [-1, 1].map((side) => (
                  <mesh key={`${i}-${side}`} position={[side * 0.63, -0.08, -0.31 + i * 0.088]}>
                    <cylinderGeometry args={[0.035, 0.035, 0.26, 8]} />
                    <meshStandardMaterial color="#d5b75d" metalness={0.65} />
                  </mesh>
                )),
              )}
              <mesh position={[0, 0.09, -0.27]}>
                <boxGeometry args={[0.25, 0.015, 0.09]} />
                <meshStandardMaterial color="#e8f3ed" />
              </mesh>
            </group>
          ) : component.catalogPartId.includes('resistor') ? (
            <group
              key={component.id}
              position={[pose.x, 0.36, pose.z]}
              rotation={rotation}
              onClick={selectPart}
            >
              <mesh rotation={[0, 0, Math.PI / 2]}>
                <cylinderGeometry args={[0.09, 0.09, 0.6, 16]} />
                <meshStandardMaterial color="#c9a775" />
              </mesh>
              {[-0.38, 0.38].map((x) => (
                <mesh key={x} position={[x, 0, 0]} rotation={[0, 0, Math.PI / 2]}>
                  <cylinderGeometry args={[0.018, 0.018, 0.2, 8]} />
                  <meshStandardMaterial color="#bdc4c8" metalness={0.7} />
                </mesh>
              ))}
              {[-0.12, -0.04, 0.04, 0.12].map((x, i) => (
                <mesh key={x} position={[x, 0.091, 0]}>
                  <boxGeometry args={[0.024, 0.004, 0.17]} />
                  <meshStandardMaterial color={['#8b3c2b', '#b68424', '#8b3c2b', '#8b3c2b'][i]} />
                </mesh>
              ))}
            </group>
          ) : component.catalogPartId.includes('led') ? (
            <group
              key={component.id}
              position={[pose.x, 0.39, pose.z]}
              rotation={rotation}
              onClick={selectPart}
            >
              <mesh>
                <sphereGeometry args={[0.13, 20, 16]} />
                <meshStandardMaterial
                  color={ledStates[component.id] === 'on' ? '#ff625b' : '#d3423c'}
                  emissive={ledStates[component.id] === 'on' ? '#c51c16' : '#210605'}
                  emissiveIntensity={ledStates[component.id] === 'on' ? 1.25 : 0.04}
                  roughness={0.22}
                  metalness={0.04}
                />
              </mesh>
              {[-0.07, 0.07].map((x) => (
                <mesh key={x} position={[x, -0.2, 0]}>
                  <cylinderGeometry args={[0.015, 0.015, 0.4, 8]} />
                  <meshStandardMaterial color="#bfc6c8" metalness={0.65} />
                </mesh>
              ))}
            </group>
          ) : null;
        })}
        {graph.components.flatMap((component) => {
          const supported = terminalNames[component.catalogPartId];
          if (!supported) return [];
          return Object.entries(supported).flatMap(([terminalId, label]) => {
            const point = endpointPoint(
              {
                kind: 'terminal',
                terminal: { componentInstanceId: component.id, catalogTerminalId: terminalId },
              },
              graph,
              parts,
            );
            if (!point) return [];
            const isSelected =
              selected?.componentInstanceId === component.id &&
              selected.catalogTerminalId === terminalId;
            return [
              <mesh
                key={`terminal-${component.id}-${terminalId}`}
                position={point}
                onClick={(event) => {
                  event.stopPropagation();
                  onSelect({ componentInstanceId: component.id, catalogTerminalId: terminalId });
                }}
                onPointerOver={() => {
                  document.body.style.cursor = 'crosshair';
                }}
                onPointerOut={() => {
                  document.body.style.cursor = '';
                }}
              >
                <sphereGeometry args={[isSelected ? 0.105 : 0.075, 12, 12]} />
                <meshStandardMaterial
                  color={isSelected ? '#f3b534' : '#2e86a3'}
                  emissive={isSelected ? '#7a4f00' : '#092b38'}
                />
              </mesh>,
            ];
          });
        })}
        {graph.wires.map((wire, index) => {
          const start = endpointPoint(wire.source, graph, parts);
          const end = endpointPoint(wire.target, graph, parts);
          return start && end ? (
            <Wire
              key={wire.id}
              start={start}
              end={end}
              color={wireColors[index % wireColors.length]!}
              onRemove={() => onRemoveWire(wire.id)}
            />
          ) : null;
        })}
      </group>
      <OrbitControls
        makeDefault
        enableDamping
        minDistance={5}
        maxDistance={14}
        maxPolarAngle={Math.PI * 0.48}
      />
    </>
  );
}

function AccessibleFallback({ message }: { message: string }) {
  return (
    <div className={styles.fallback} role="status">
      <strong>3D view unavailable</strong>
      <span>{message}</span>
    </div>
  );
}

/** An illustrative, graph-derived view. It contains no editable 3D pose or CAD guarantee. */
export function CircuitScene({
  graph,
  onGraphChange,
  simulationRun = null,
  currentGraphDigest = null,
  currentFirmwareDigest = null,
  className,
  title = 'Circuit workbench 3D view',
}: Props) {
  const [webgl, setWebgl] = useState<boolean | null>(null);
  const [resetKey, setResetKey] = useState(0);
  const [selected, setSelected] = useState<TerminalRef | null>(null);
  const [selectedComponentId, setSelectedComponentId] = useState<string | null>(null);
  const [editMessage, setEditMessage] = useState('Choose a terminal to start a wire.');
  const ledStates = resolveSimulationLedStates({
    graph,
    run: simulationRun,
    currentGraphDigest,
    currentFirmwareDigest,
  });
  useEffect(() => {
    setWebgl(isWebGLAvailable());
  }, []);
  const aria =
    graph.components
      .map((part) => `${partNames[part.catalogPartId] ?? part.catalogPartId} (${part.id})`)
      .join('; ') || 'No circuit components yet';
  const terminals = graph.components.flatMap((component) =>
    Object.entries(terminalNames[component.catalogPartId] ?? {}).map(([terminalId, label]) => ({
      ref: { componentInstanceId: component.id, catalogTerminalId: terminalId },
      label,
      part: partNames[component.catalogPartId] ?? component.catalogPartId,
    })),
  );
  const arrangedComponent = graph.components.find(
    (component) => component.id === selectedComponentId,
  );
  const arrangedPose = arrangedComponent
    ? poseFor(graph, arrangedComponent.id, arrangedComponent.catalogPartId)
    : null;
  function selectTerminal(terminal: TerminalRef) {
    if (!selected) {
      setSelected(terminal);
      setEditMessage('Now choose a different terminal to add a wire.');
      return;
    }
    if (
      selected.componentInstanceId === terminal.componentInstanceId &&
      selected.catalogTerminalId === terminal.catalogTerminalId
    ) {
      setSelected(null);
      setEditMessage('Wire selection cleared. Choose a terminal to start a wire.');
      return;
    }
    const sameConnection = (wire: CircuitWorkbenchGraph['wires'][number]) =>
      wire.source.kind === 'terminal' &&
      wire.target.kind === 'terminal' &&
      ((wire.source.terminal.componentInstanceId === selected.componentInstanceId &&
        wire.source.terminal.catalogTerminalId === selected.catalogTerminalId &&
        wire.target.terminal.componentInstanceId === terminal.componentInstanceId &&
        wire.target.terminal.catalogTerminalId === terminal.catalogTerminalId) ||
        (wire.target.terminal.componentInstanceId === selected.componentInstanceId &&
          wire.target.terminal.catalogTerminalId === selected.catalogTerminalId &&
          wire.source.terminal.componentInstanceId === terminal.componentInstanceId &&
          wire.source.terminal.catalogTerminalId === terminal.catalogTerminalId));
    if (graph.wires.some(sameConnection)) {
      setSelected(null);
      setEditMessage('Those terminals already have a wire.');
      return;
    }
    const id =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `wire-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    onGraphChange({
      ...graph,
      wires: [
        ...graph.wires,
        {
          id,
          source: { kind: 'terminal', terminal: selected },
          target: { kind: 'terminal', terminal },
        },
      ],
    });
    setSelected(null);
    setEditMessage('Wire added between the selected terminals.');
  }
  function removeWire(wireId: string) {
    onGraphChange({ ...graph, wires: graph.wires.filter((wire) => wire.id !== wireId) });
    setEditMessage('Wire removed.');
  }
  function moveSelectedComponent(dx: number, dz: number, rotationDelta = 0) {
    if (!selectedComponentId) return;
    const component = graph.components.find((item) => item.id === selectedComponentId);
    if (!component) return;
    const pose = poseFor(graph, component.id, component.catalogPartId);
    const placements = graph.visualLayout?.componentPlacements ?? [];
    const rotationY = (pose.rotationY + rotationDelta + 360) % 360;
    const nextPlacement = {
      componentInstanceId: component.id,
      x: dx === 0 ? pose.x : Math.max(-4.5, Math.min(4.5, Math.round((pose.x + dx) * 4) / 4)),
      z: dz === 0 ? pose.z : Math.max(-3, Math.min(3, Math.round((pose.z + dz) * 4) / 4)),
      rotationY,
    };
    onGraphChange({
      ...graph,
      visualLayout: {
        schemaVersion: 1,
        componentPlacements: [
          ...placements.filter((item) => item.componentInstanceId !== component.id),
          nextPlacement,
        ],
      },
    });
    setEditMessage(
      `${partNames[component.catalogPartId] ?? component.catalogPartId} moved in the illustrative scene.`,
    );
  }
  return (
    <section className={`${styles.root} ${className ?? ''}`} aria-labelledby="cw3d-title">
      <header className={styles.header}>
        <div>
          <h2 id="cw3d-title">{title}</h2>
          <p>
            Revision {graph.projectRevision} · {graph.catalogReleaseId}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setResetKey((value) => value + 1)}
          aria-label="Reset 3D camera view"
        >
          Reset view
        </button>
      </header>
      <p className={styles.note}>
        Illustrative schematic view. Geometry is not dimension-accurate CAD and does not prove
        electrical safety or physical fit.
      </p>
      <div className={styles.editTools}>
        <p>
          Connect terminals: select two terminal buttons or markers. Click an existing wire to
          remove it. Drag to orbit; scroll or pinch to zoom.
        </p>
        <p className={styles.editStatus} role="status" aria-live="polite">
          {editMessage}
        </p>
        <ul aria-label="Connectable circuit terminals">
          {terminals.map(({ ref, label, part }) => {
            const isSelected =
              selected?.componentInstanceId === ref.componentInstanceId &&
              selected.catalogTerminalId === ref.catalogTerminalId;
            return (
              <li key={`${ref.componentInstanceId}:${ref.catalogTerminalId}`}>
                <button type="button" aria-pressed={isSelected} onClick={() => selectTerminal(ref)}>
                  {part}: {label}
                </button>
              </li>
            );
          })}
        </ul>
        <h3>Arrange components</h3>
        <p>
          Select a component, then move it by one workbench grid step or rotate it by 90 degrees.
        </p>
        <ul aria-label="Components to arrange">
          {graph.components.map((component) => (
            <li key={`arrange-${component.id}`}>
              <button
                type="button"
                aria-pressed={selectedComponentId === component.id}
                onClick={() => setSelectedComponentId(component.id)}
              >
                {partNames[component.catalogPartId] ?? component.catalogPartId}
              </button>
            </li>
          ))}
        </ul>
        {arrangedComponent && arrangedPose && (
          <p className={styles.editStatus}>
            Selected:{' '}
            {partNames[arrangedComponent.catalogPartId] ?? arrangedComponent.catalogPartId} · X{' '}
            {arrangedPose.x} · Z {arrangedPose.z} · rotation {arrangedPose.rotationY}°
          </p>
        )}
        <div className={styles.arrangeButtons} aria-label="Move or rotate selected component">
          <button
            type="button"
            disabled={!selectedComponentId}
            onClick={() => moveSelectedComponent(-0.25, 0)}
          >
            Move left
          </button>
          <button
            type="button"
            disabled={!selectedComponentId}
            onClick={() => moveSelectedComponent(0.25, 0)}
          >
            Move right
          </button>
          <button
            type="button"
            disabled={!selectedComponentId}
            onClick={() => moveSelectedComponent(0, -0.25)}
          >
            Move forward
          </button>
          <button
            type="button"
            disabled={!selectedComponentId}
            onClick={() => moveSelectedComponent(0, 0.25)}
          >
            Move backward
          </button>
          <button
            type="button"
            disabled={!selectedComponentId}
            onClick={() => moveSelectedComponent(0, 0, -90)}
          >
            Rotate left
          </button>
          <button
            type="button"
            disabled={!selectedComponentId}
            onClick={() => moveSelectedComponent(0, 0, 90)}
          >
            Rotate right
          </button>
        </div>
      </div>
      <div
        className={styles.viewport}
        role="region"
        aria-label={`Illustrative circuit workbench containing: ${aria}. Rotate with the mouse or touch; zoom with the wheel or pinch.`}
      >
        {webgl === null ? (
          <AccessibleFallback message="Checking graphics support…" />
        ) : !webgl ? (
          <AccessibleFallback message="This browser or device does not provide WebGL. The graph and circuit details remain available in the workspace." />
        ) : (
          <SceneBoundary
            fallback={
              <AccessibleFallback message="The 3D renderer encountered a graphics error. Reload the workspace to try again." />
            }
          >
            <Canvas
              key={resetKey}
              camera={{ position: [6, 6, 7], fov: 42 }}
              shadows
              dpr={[1, 1.75]}
            >
              <Suspense fallback={null}>
                <BoardScene
                  graph={graph}
                  ledStates={ledStates}
                  selected={selected}
                  onSelect={selectTerminal}
                  onRemoveWire={removeWire}
                  onSelectComponent={setSelectedComponentId}
                />
              </Suspense>
            </Canvas>
          </SceneBoundary>
        )}
      </div>
      <div className={styles.details}>
        <h3>Components in this view</h3>
        <ul>
          {graph.components.map((part) => (
            <li key={part.id}>
              {partNames[part.catalogPartId] ?? part.catalogPartId} <span>({part.id})</span>
              {ledStates[part.id] && <span> · Digital simulation state: {ledStates[part.id]}</span>}
            </li>
          ))}
        </ul>
        {Object.keys(ledStates).length > 0 && (
          <p role="status" aria-live="polite">
            LED state is an ideal digital indication. It does not report current, voltage, or
            electrical safety.
          </p>
        )}
        <p>
          {graph.wires.length} graph wire{graph.wires.length === 1 ? '' : 's'} ·{' '}
          {graph.breadboards.length} breadboard{graph.breadboards.length === 1 ? '' : 's'}
        </p>
        {graph.wires.length > 0 && (
          <ul className={styles.wireList} aria-label="Existing circuit wires">
            {graph.wires.map((wire, index) => (
              <li key={wire.id}>
                <button
                  type="button"
                  onClick={() => removeWire(wire.id)}
                  aria-label={`Remove wire ${index + 1}`}
                >
                  Remove wire {index + 1}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

export default CircuitScene;
