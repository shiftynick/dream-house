import { Component, Suspense, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls, Html } from '@react-three/drei';
import * as THREE from 'three';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import { palettes, type Palette, type Room, type Scene, type Side } from '../shared/model';
import {
  roomSlabs,
  stairFootprint,
  wallAxis,
  wallPanels,
  planWallHitTarget,
  type Rect,
} from './renderGeometry';
import { surfacePalette, type DesignSelection, type DesignSurface } from '../shared/selection';

export type Quality = 'live' | 'refined' | 'clay' | 'wireframe';
export type View = 'orbit' | 'walk' | 'plan';
export type Light = 'day' | 'golden' | 'evening';
export type CameraContext = {
  position: [number, number, number];
  target: [number, number, number];
};
type Props = {
  house: Scene;
  quality: Quality;
  view: View;
  light: Light;
  cutaway: boolean;
  cutawaySides?: Side[];
  selected: string | null;
  selection?: DesignSelection | null;
  onSelectSurface?: (selection: DesignSelection) => void;
  onSelect: (id: string | null) => void;
  onRenderStatus: (text: string) => void;
  resetKey: number;
  onCameraChange?: (camera: CameraContext) => void;
};

function makeTexture(kind: 'stone' | 'wood' | 'ground') {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 256;
  const ctx = canvas.getContext('2d')!;
  let seed = 17;
  const random = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  ctx.fillStyle = kind === 'wood' ? '#cfc4b2' : kind === 'ground' ? '#aeae97' : '#dbd7cc';
  ctx.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 10000; i++) {
    const v = Math.floor(100 + random() * 140);
    ctx.fillStyle = `rgba(${v},${v},${v},${kind === 'ground' ? 0.23 : 0.1})`;
    ctx.fillRect(
      random() * 256,
      random() * 256,
      kind === 'wood' ? 1 : 2,
      kind === 'wood' ? 20 + random() * 90 : 2,
    );
  }
  if (kind === 'stone') {
    ctx.strokeStyle = '#aaa69e';
    ctx.globalAlpha = 0.22;
    for (let y = 0; y < 256; y += 64) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(256, y);
      ctx.stroke();
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(kind === 'ground' ? 30 : 2, kind === 'ground' ? 30 : 2);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}
function Box({
  position,
  size,
  material,
  rotation = 0,
  cast = true,
  onSelect,
  highlight = false,
}: {
  position: [number, number, number];
  size: [number, number, number];
  material: THREE.Material;
  rotation?: number;
  cast?: boolean;
  onSelect?: () => void;
  highlight?: boolean;
}) {
  return (
    <mesh
      position={position}
      rotation={[0, rotation, 0]}
      material={material}
      castShadow={cast}
      receiveShadow
      onClick={
        onSelect
          ? (event) => {
              event.stopPropagation();
              onSelect();
            }
          : undefined
      }
    >
      <boxGeometry args={size} />
      {highlight && (
        <mesh>
          <boxGeometry args={[size[0] + 0.012, size[1] + 0.012, size[2] + 0.012]} />
          <meshBasicMaterial
            color="#e3a44f"
            wireframe
            transparent
            opacity={0.95}
            toneMapped={false}
          />
        </mesh>
      )}
    </mesh>
  );
}
function RoomMesh({
  house,
  room: r,
  materials: m,
  materialSets,
  selection,
  onSelectSurface,
  roof,
  cutaway,
  cutawaySides = ['south', 'east'],
  selected,
  onSelect,
  quality,
}: {
  house: Scene;
  room: Room;
  materials: Record<string, THREE.Material>;
  materialSets: Record<string, Record<string, THREE.Material>>;
  selection?: DesignSelection | null;
  onSelectSurface?: (selection: DesignSelection) => void;
  roof: Scene['roof'];
  cutaway: boolean;
  cutawaySides?: Side[];
  selected: boolean;
  onSelect: () => void;
  quality: Quality;
}) {
  const outdoor = ['terrace', 'courtyard'].includes(r.kind);
  const surfaceMaterial = (surface: DesignSurface) =>
    materialSets[surfacePalette(house, r, surface)];
  const pick = (surface: DesignSurface) =>
    onSelectSurface ? onSelectSurface({ roomId: r.id, surface }) : onSelect();
  const isSelected = (surface: DesignSurface) =>
    selection?.roomId === r.id && selection.surface === surface;
  const slabs = useMemo(() => roomSlabs(house, r), [house, r]);
  const slab = (
    rect: Rect,
    y: number,
    height: number,
    material: THREE.Material,
    index: number,
    surface?: DesignSurface,
  ) => (
    <Box
      key={index}
      position={[(rect.minX + rect.maxX) / 2 - r.x, y, (rect.minZ + rect.maxZ) / 2 - r.z]}
      size={[rect.maxX - rect.minX, height, rect.maxZ - rect.minZ]}
      material={material}
      onSelect={surface ? () => pick(surface) : undefined}
      highlight={surface ? isSelected(surface) : false}
    />
  );
  const wall = (side: 'north' | 'south' | 'east' | 'west') => {
    if (cutaway && cutawaySides.includes(side)) return null;
    const { horizontal } = wallAxis(r, side);
    const sm = surfaceMaterial(side);
    const position: [number, number, number] = horizontal
      ? [0, 0, (side === 'north' ? -1 : 1) * (r.depth / 2 - 0.05)]
      : [(side === 'west' ? -1 : 1) * (r.width / 2 - 0.05), 0, 0];
    // Each room owns its inward half of a shared wall, so opposite faces may
    // have different finishes and can be selected independently.
    const panels = wallPanels(house, r, side, false);
    return (
      <group
        key={side}
        position={position}
        rotation={[0, horizontal ? 0 : -Math.PI / 2, 0]}
        onClick={(event) => {
          event.stopPropagation();
          pick(side);
        }}
      >
        {panels.map((panel, index) =>
          r[side] === 'glass' ? (
            <group key={index} position={[panel.offset, panel.bottom, 0]}>
              <Box
                position={[0, panel.height / 2, 0]}
                size={[panel.width, panel.height, 0.04]}
                material={sm.glass}
                highlight={isSelected(side)}
                cast={false}
              />
              {[0, panel.height].map((y) => (
                <Box
                  key={y}
                  position={[0, y, 0]}
                  size={[panel.width, 0.09, 0.12]}
                  material={sm.frame}
                />
              ))}
              {Array.from(
                { length: Math.ceil(panel.width / 2.2) + 1 },
                (_, i) => -panel.width / 2 + (i * panel.width) / Math.ceil(panel.width / 2.2),
              ).map((x) => (
                <Box
                  key={x}
                  position={[x, panel.height / 2, 0]}
                  size={[0.06, panel.height, 0.12]}
                  material={sm.frame}
                />
              ))}
            </group>
          ) : (
            <Box
              key={index}
              position={[panel.offset, panel.bottom + panel.height / 2, 0]}
              size={[panel.width, panel.height, 0.1]}
              material={sm.wall}
              highlight={isSelected(side)}
            />
          ),
        )}
      </group>
    );
  };
  const roofGeometry = useMemo(() => {
    const shape = new THREE.Shape();
    shape.moveTo(-r.width / 2 - 0.3, 0);
    shape.lineTo(0, Math.min(2.5, r.width * 0.22));
    shape.lineTo(r.width / 2 + 0.3, 0);
    shape.closePath();
    return new THREE.ExtrudeGeometry(shape, { depth: r.depth + 0.6, bevelEnabled: false });
  }, [r.width, r.depth]);
  useEffect(() => () => roofGeometry.dispose(), [roofGeometry]);
  return (
    <group
      position={[r.x, r.elevation, r.z]}
      onClick={(event) => {
        event.stopPropagation();
        onSelect();
      }}
    >
      {slabs.floor.map((rect, index) =>
        slab(
          rect,
          -0.15,
          0.3,
          outdoor && !r.palette && !r.surfacePalettes?.floor
            ? m.deck
            : surfaceMaterial('floor').floor,
          index,
          'floor',
        ),
      )}
      {slabs.foundation.map((rect, index) => slab(rect, -0.5, 0.4, m.foundation, index))}
      {!outdoor && (
        <>
          {(['north', 'south', 'east', 'west'] as const).map(wall)}
          {!cutaway &&
            (roof === 'flat' || slabs.roofClipped ? (
              <>
                {slabs.roof.map((rect, index) =>
                  slab(rect, r.height + 0.1, 0.22, surfaceMaterial('roof').roof, index, 'roof'),
                )}
                {slabs.roof.map((rect, index) =>
                  slab(rect, r.height - 0.06, 0.1, surfaceMaterial('roof').wood, index, 'roof'),
                )}
              </>
            ) : (
              <mesh
                position={[0, r.height, -r.depth / 2 - 0.3]}
                geometry={roofGeometry}
                material={surfaceMaterial('roof').roof}
                onClick={(event) => {
                  event.stopPropagation();
                  pick('roof');
                }}
                castShadow
                receiveShadow
              >
                {isSelected('roof') && (
                  <mesh geometry={roofGeometry} scale={[1.002, 1.002, 1.002]}>
                    <meshBasicMaterial color="#e3a44f" wireframe toneMapped={false} />
                  </mesh>
                )}
              </mesh>
            ))}
          {r.kind === 'living' && (
            <>
              <Box
                position={[-r.width * 0.22, 0.28, r.depth * 0.13]}
                size={[3.3, 0.5, 1.15]}
                material={m.fabric}
              />
              <Box
                position={[-r.width * 0.22, 0.68, r.depth * 0.13 - 0.5]}
                size={[3.3, 0.55, 0.22]}
                material={m.fabric}
              />
              <Box
                position={[-r.width * 0.22, 0.28, r.depth * 0.13 + 1.6]}
                size={[1.7, 0.35, 0.8]}
                material={m.wood}
              />
              <Box
                position={[-r.width * 0.22, 0.02, r.depth * 0.13 + 0.6]}
                size={[4.8, 0.025, 3.9]}
                material={m.rug}
              />
            </>
          )}
          {r.kind === 'kitchen' && (
            <>
              <Box
                position={[0, 0.45, -r.depth / 2 + 0.6]}
                size={[r.width - 1.2, 0.9, 1]}
                material={m.wood}
              />
              <Box
                position={[0, 0.94, -r.depth / 2 + 0.6]}
                size={[r.width - 1.1, 0.07, 1.1]}
                material={m.wall}
              />
              <Box
                position={[0, 0.5, 0]}
                size={[Math.min(3.8, r.width - 1), 1, 1.2]}
                material={m.wood}
              />
              <Box
                position={[0, 1.04, 0]}
                size={[Math.min(4, r.width - 0.8), 0.09, 1.35]}
                material={m.wall}
              />
            </>
          )}
          {r.kind === 'bedroom' && (
            <>
              <Box position={[0, 0.23, -r.depth * 0.1]} size={[2.05, 0.4, 2.3]} material={m.wood} />
              <Box position={[0, 0.5, -r.depth * 0.1]} size={[2, 0.22, 2.2]} material={m.fabric} />
              <Box
                position={[0, 0.8, -r.depth * 0.1 - 1.1]}
                size={[2.25, 1.4, 0.15]}
                material={m.wood}
              />
              {[-0.5, 0.5].map((x) => (
                <Box
                  key={x}
                  position={[x, 0.68, -r.depth * 0.1 - 0.65]}
                  size={[0.75, 0.15, 0.45]}
                  material={m.rug}
                />
              ))}
            </>
          )}
          {r.kind === 'bathroom' && (
            <Box position={[0, 0.35, 0]} size={[1.8, 0.65, 0.8]} material={m.fabric} />
          )}
        </>
      )}
      {r.kind === 'courtyard' && (
        <>
          <Box position={[0, 0.18, 0]} size={[1.2, 0.35, 1.2]} material={m.wall} />
          <Tree x={0} z={0} y={0.35} scale={0.6} />
        </>
      )}
      {selected && quality !== 'refined' && (
        <>
          {(!selection || selection.surface === 'room') && (
            <mesh position={[0, 0.03, 0]} rotation={[-Math.PI / 2, 0, 0]}>
              <planeGeometry args={[r.width, r.depth]} />
              <meshBasicMaterial color="#b87f45" transparent opacity={0.19} depthWrite={false} />
            </mesh>
          )}
          <Html position={[0, r.height + 0.8, 0]} center>
            <div className="room-label">
              {r.name}
              {selection?.roomId === r.id && selection.surface !== 'room'
                ? ` · ${selection.surface}`
                : ''}
              <span>
                {r.width} × {r.depth} m
              </span>
            </div>
          </Html>
        </>
      )}
    </group>
  );
}
function groundHeight(x: number, z: number, slope: number) {
  return -0.7 - slope * (z + 12) + Math.sin(x * 0.07) * Math.cos(z * 0.07) * 1.1;
}
function Tree({ x, z, y = 0, scale = 1 }: { x: number; z: number; y?: number; scale?: number }) {
  return (
    <group position={[x, y, z]} scale={scale}>
      <mesh position={[0, 1.6, 0]} castShadow>
        <cylinderGeometry args={[0.13, 0.22, 3.2, 6]} />
        <meshStandardMaterial color="#615848" roughness={1} />
      </mesh>
      {[
        [0, 3.7, 0, 1.6],
        [-0.7, 3.1, 0.4, 1.25],
        [0.7, 3.3, -0.3, 1.4],
        [0.1, 4.5, 0.2, 1.1],
      ].map(([a, b, c, s], i) => (
        <mesh key={i} position={[a, b, c]} scale={[s, s * 0.9, s]} castShadow>
          <icosahedronGeometry args={[1, 2]} />
          <meshStandardMaterial
            color={['#697652', '#768360', '#596d4d', '#83906c'][i]}
            roughness={1}
          />
        </mesh>
      ))}
    </group>
  );
}
export function Environment({ light }: { light: Light }) {
  const { scene } = useThree();
  useEffect(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 256;
    const ctx = canvas.getContext('2d')!;
    const gradient = ctx.createLinearGradient(0, 0, 0, 256);
    const colors =
      light === 'evening'
        ? ['#263953', '#829093', '#4c5140']
        : light === 'golden'
          ? ['#b3c5cf', '#f1dbc2', '#777d63']
          : ['#a3c4d6', '#e7ecdf', '#777f69'];
    gradient.addColorStop(0, colors[0]);
    gradient.addColorStop(0.5, colors[1]);
    gradient.addColorStop(1, colors[2]);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 512, 256);
    const pixels = ctx.getImageData(0, 0, 512, 256).data;
    const data = new Float32Array(512 * 256 * 4);
    for (let i = 0; i < pixels.length; i += 4) {
      const color = new THREE.Color(
        pixels[i] / 255,
        pixels[i + 1] / 255,
        pixels[i + 2] / 255,
      ).convertSRGBToLinear();
      data[i] = color.r;
      data[i + 1] = color.g;
      data[i + 2] = color.b;
      data[i + 3] = 1;
    }
    const tex = new THREE.DataTexture(data, 512, 256, THREE.RGBAFormat, THREE.FloatType);
    tex.mapping = THREE.EquirectangularReflectionMapping;
    tex.needsUpdate = true;
    scene.environment = tex;
    scene.background = new THREE.Color(
      light === 'evening' ? '#9aa9ae' : light === 'golden' ? '#dedfce' : '#dbe3dc',
    );
    scene.environmentIntensity = light === 'evening' ? 0.45 : 0.9;
    return () => {
      scene.environment = null;
      tex.dispose();
    };
  }, [scene, light]);
  return (
    <>
      <ambientLight intensity={light === 'evening' ? 0.18 : 0.35} />
      <hemisphereLight args={['#e7eff4', '#7a7954', 1.15]} />
      <directionalLight
        position={light === 'golden' ? [-30, 20, 20] : [-18, 40, 10]}
        intensity={light === 'evening' ? 0.4 : 3}
        color={light === 'golden' ? '#ffe1aa' : '#fff3db'}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-48}
        shadow-camera-right={48}
        shadow-camera-top={48}
        shadow-camera-bottom={-48}
        shadow-camera-far={150}
        shadow-bias={-0.0002}
        shadow-normalBias={0.03}
      />
    </>
  );
}
export function Site({ house, quality }: { house: Scene; quality: Quality }) {
  const texture = useMemo(() => makeTexture('ground'), []);
  const geometry = useMemo(() => {
    const geo = new THREE.PlaneGeometry(230, 230, 100, 100);
    geo.rotateX(-Math.PI / 2);
    const p = geo.attributes.position;
    for (let i = 0; i < p.count; i++) p.setY(i, groundHeight(p.getX(i), p.getZ(i), house.slope));
    geo.computeVertexNormals();
    return geo;
  }, [house.slope]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  useEffect(() => () => texture.dispose(), [texture]);
  const positions = [
    [-27, -14, 1.4],
    [-23, 6, 1.1],
    [-29, 15, 1.7],
    [28, -9, 1.5],
    [31, 5, 1.3],
    [24, 19, 1.1],
    [-15, -25, 1.5],
    [7, -29, 1.6],
    [23, -27, 1.5],
    [-39, -10, 1.8],
    [43, -19, 1.5],
    [-35, 30, 1.4],
    [40, 30, 1.5],
    [-5, -33, 1.2],
  ];
  return (
    <group>
      <mesh geometry={geometry} receiveShadow onClick={(e) => e.stopPropagation()}>
        <meshStandardMaterial
          color={quality === 'clay' ? '#c6c4b9' : '#929d75'}
          map={quality === 'clay' ? null : texture}
          roughness={1}
          wireframe={quality === 'wireframe'}
        />
      </mesh>
      {positions.map(([x, z, s], i) => (
        <Tree key={i} x={x} z={z} y={groundHeight(x, z, house.slope)} scale={s} />
      ))}
      {!house.rooms.length && (
        <group position={[0, 0.02, 0]}>
          <mesh rotation={[-Math.PI / 2, 0, 0]}>
            <planeGeometry args={[22, 18]} />
            <meshStandardMaterial color="#bdbea3" roughness={1} transparent opacity={0.5} />
          </mesh>
          <gridHelper args={[22, 11, '#8c947d', '#adb298']} position={[0, 0.015, 0]} />
        </group>
      )}
    </group>
  );
}
export function Architecture({
  house,
  quality,
  cutaway,
  cutawaySides,
  selected,
  onSelect,
  selection,
  onSelectSurface,
}: Pick<
  Props,
  | 'house'
  | 'quality'
  | 'cutaway'
  | 'selected'
  | 'onSelect'
  | 'selection'
  | 'onSelectSurface'
  | 'cutawaySides'
>) {
  const textures = useMemo(() => ({ stone: makeTexture('stone'), wood: makeTexture('wood') }), []);
  useEffect(() => () => Object.values(textures).forEach((t) => t.dispose()), [textures]);
  const materialSets = useMemo(
    () =>
      Object.fromEntries(
        (Object.keys(palettes) as Palette[]).map((palette) => {
          const p = palettes[palette];
          const wireframe = quality === 'wireframe',
            clay = quality === 'clay';
          const mat = (color: string, roughness = 0.8, map: THREE.Texture | null = null) =>
            new THREE.MeshStandardMaterial({
              color: clay ? '#e0dcd1' : color,
              roughness,
              wireframe,
              map: clay ? null : map,
            });
          return [
            palette,
            {
              wall: mat(
                p.wall,
                0.85,
                palette === 'cedar' || palette === 'charcoal' ? textures.wood : textures.stone,
              ),
              wood: mat(p.wood, 0.65, textures.wood),
              floor: mat(p.floor, 0.7, textures.wood),
              roof: mat(p.roof),
              frame: mat(p.accent, 0.3),
              foundation: mat('#a19d8f', 1, textures.stone),
              deck: mat('#bcbaa7', 0.9, textures.stone),
              fabric: mat('#e2decd', 1),
              rug: mat('#bcb8a4', 1),
              glass:
                clay || wireframe
                  ? mat('#cad8d3', 0.2)
                  : new THREE.MeshPhysicalMaterial({
                      color: '#d2e5df',
                      roughness: 0.08,
                      metalness: 0.05,
                      transparent: true,
                      opacity: quality === 'refined' ? 1 : 0.26,
                      transmission: quality === 'refined' ? 0.94 : 0,
                      thickness: 0.04,
                      ior: 1.45,
                      side: THREE.DoubleSide,
                    }),
            },
          ];
        }),
      ),
    [quality, textures],
  );
  useEffect(
    () => () =>
      Object.values(materialSets).forEach((set) =>
        Object.values(set).forEach((material) => material.dispose()),
      ),
    [materialSets],
  );
  const m = materialSets[house.palette];
  return (
    <group>
      {house.rooms.map((r) => (
        <RoomMesh
          key={r.id}
          house={house}
          room={r}
          materials={materialSets[r.palette ?? house.palette]}
          materialSets={materialSets}
          selection={selection}
          onSelectSurface={onSelectSurface}
          roof={house.roof}
          cutaway={cutaway}
          cutawaySides={cutawaySides}
          selected={selected === r.id}
          onSelect={() => onSelect(r.id)}
          quality={quality}
        />
      ))}
      {house.stairs.map((s) => (
        <group
          key={s.id}
          position={[s.x, s.elevation, s.z]}
          rotation={[0, (s.rotation * Math.PI) / 180, 0]}
        >
          {Array.from({ length: Math.ceil(s.rise / 0.18) }, (_, i) => {
            const count = Math.ceil(s.rise / 0.18),
              h = (s.rise * (i + 1)) / count;
            return (
              <Box
                key={i}
                position={[0, h / 2, -s.run / 2 + ((i + 0.5) * s.run) / count]}
                size={[s.width, h, s.run / count]}
                material={m.floor}
              />
            );
          })}
        </group>
      ))}
      {house.fireplace && (
        <group position={[house.fireplace.x, house.fireplace.elevation, house.fireplace.z]}>
          <Box position={[0, 0.15, 0]} size={[2.4, 0.3, 1.6]} material={m.wall} />
          <Box position={[-0.8, 0.7, 0]} size={[0.35, 1.1, 1.15]} material={m.wall} />
          <Box position={[0.8, 0.7, 0]} size={[0.35, 1.1, 1.15]} material={m.wall} />
          <Box
            position={[0, (house.fireplace.height + 1.2) / 2, 0]}
            size={[1.95, house.fireplace.height - 1.2, 1.15]}
            material={m.wall}
          />
          <Box position={[0, 0.55, 0]} size={[1.2, 0.3, 0.5]} material={m.frame} />
          <mesh position={[0, 0.65, 0.1]}>
            <sphereGeometry args={[0.32, 12, 8]} />
            <meshStandardMaterial color="#edb568" emissive="#e78333" emissiveIntensity={2} />
          </mesh>
          <pointLight position={[0, 0.8, 0.7]} intensity={8} color="#ffb45f" distance={8} />
        </group>
      )}
    </group>
  );
}
function CameraRig({
  view,
  resetKey,
  house,
  onCameraChange,
}: Pick<Props, 'view' | 'resetKey' | 'house' | 'onCameraChange'>) {
  const controls = useRef<OrbitControlsImpl>(null);
  const { camera, gl } = useThree();
  const pressed = useRef(new Set<string>());
  const report = useRef(onCameraChange);
  report.current = onCameraChange;
  const lastReport = useRef({ time: -1, coordinates: [] as number[] });
  useEffect(() => {
    if (view === 'walk') {
      const room = house.rooms.find((r) => r.kind === 'living') || house.rooms[0];
      camera.position.set(room?.x || 0, (room?.elevation || 0) + 1.7, (room?.z || 0) + 2);
      camera.lookAt(room?.x || 0, (room?.elevation || 0) + 1.7, (room?.z || 0) - 5);
    } else {
      camera.position.set(34, 26, 38);
      controls.current?.target.set(0, 1, 0);
      controls.current?.update();
    }
  }, [view, resetKey, camera]);
  useEffect(() => {
    if (view !== 'walk') return;
    const canvas = gl.domElement;
    const click = () => {
      canvas.requestPointerLock()?.catch(() => {});
    };
    const move = (event: MouseEvent) => {
      if (document.pointerLockElement !== canvas) return;
      const e = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ');
      e.y -= event.movementX * 0.002;
      e.x = THREE.MathUtils.clamp(e.x - event.movementY * 0.002, -1.45, 1.45);
      camera.quaternion.setFromEuler(e);
    };
    const down = (e: KeyboardEvent) => {
      if (document.pointerLockElement === canvas) pressed.current.add(e.code);
    };
    const up = (e: KeyboardEvent) => pressed.current.delete(e.code);
    const blur = () => pressed.current.clear();
    canvas.addEventListener('click', click);
    document.addEventListener('mousemove', move);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    document.addEventListener('pointerlockchange', blur);
    return () => {
      canvas.removeEventListener('click', click);
      document.removeEventListener('mousemove', move);
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
      document.removeEventListener('pointerlockchange', blur);
      if (document.pointerLockElement === canvas) document.exitPointerLock();
    };
  }, [view, camera, gl]);
  useFrame((_, delta) => {
    if (view !== 'walk' || document.pointerLockElement !== gl.domElement) return;
    const speed = Math.min(delta, 0.05) * (pressed.current.has('ShiftLeft') ? 8 : 3.5);
    const forward = new THREE.Vector3();
    camera.getWorldDirection(forward);
    forward.y = 0;
    forward.normalize();
    const right = new THREE.Vector3().crossVectors(forward, camera.up).normalize();
    if (pressed.current.has('KeyW')) camera.position.addScaledVector(forward, speed);
    if (pressed.current.has('KeyS')) camera.position.addScaledVector(forward, -speed);
    if (pressed.current.has('KeyA')) camera.position.addScaledVector(right, -speed);
    if (pressed.current.has('KeyD')) camera.position.addScaledVector(right, speed);
    if (pressed.current.has('KeyE')) camera.position.y += speed;
    if (pressed.current.has('KeyQ')) camera.position.y -= speed;
  });
  useFrame(({ clock }) => {
    if (!report.current || clock.elapsedTime - lastReport.current.time < 0.25) return;
    const target =
      view === 'orbit' && controls.current
        ? controls.current.target
        : camera.getWorldDirection(new THREE.Vector3()).multiplyScalar(5).add(camera.position);
    const position = camera.position.toArray() as [number, number, number];
    const focus = target.toArray() as [number, number, number];
    const coordinates = [...position, ...focus];
    if (
      !coordinates.some(
        (value, index) =>
          Math.abs(value - (lastReport.current.coordinates[index] ?? Infinity)) > 0.001,
      )
    )
      return;
    lastReport.current = { time: clock.elapsedTime, coordinates };
    report.current({ position, target: focus });
  });
  return view === 'orbit' ? (
    <OrbitControls
      ref={controls}
      makeDefault
      minDistance={5}
      maxDistance={125}
      maxPolarAngle={Math.PI * 0.49}
      enableDamping
      dampingFactor={0.08}
      target={[0, 1, 0]}
    />
  ) : null;
}
function ProgressiveRenderer({
  enabled,
  sceneKey,
  onStatus,
}: {
  enabled: boolean;
  sceneKey: string;
  onStatus: (text: string) => void;
}) {
  const { gl, scene, camera, size } = useThree();
  const tracer = useRef<import('three-gpu-pathtracer').WebGLPathTracer | null>(null);
  const lastMatrix = useRef<number[]>([]);
  const lastStatus = useRef('');
  useEffect(() => {
    let cancelled = false;
    onStatus(enabled ? 'Preparing path tracer' : 'Live rendering');
    if (enabled) {
      import('three-gpu-pathtracer')
        .then(({ WebGLPathTracer }) => {
          if (cancelled) return;
          onStatus('Building path-traced scene');
          const pt = new WebGLPathTracer(gl);
          pt.textureSize.set(256, 256);
          pt.bounces = 4;
          pt.renderDelay = 650;
          pt.minSamples = 2;
          pt.fadeDuration = 300;
          const debugInfo = gl.getContext().getExtension('WEBGL_debug_renderer_info');
          const rendererName = debugInfo
            ? String(gl.getContext().getParameter(debugInfo.UNMASKED_RENDERER_WEBGL))
            : '';
          pt.renderScale = /intel|swiftshader|llvmpipe/i.test(rendererName) ? 0.5 : 0.8;
          pt.tiles.set(2, 2);
          tracer.current = pt;
          scene.updateMatrixWorld(true);
          pt.setScene(scene, camera);
          onStatus('Path tracer ready');
        })
        .catch((error) => {
          console.error('Path tracer initialization failed', error);
          tracer.current?.dispose();
          tracer.current = null;
          onStatus('Refinement unavailable · live rendering');
        });
    }
    return () => {
      cancelled = true;
      tracer.current?.dispose();
      tracer.current = null;
    };
  }, [enabled, sceneKey, gl, scene, camera, onStatus, size.width, size.height]);
  useFrame(() => {
    const pt = tracer.current;
    gl.domElement.dataset.renderSamples = String(pt?.samples ?? 'live');
    if (!enabled || !pt) {
      gl.render(scene, camera);
      return;
    }
    const matrix = camera.matrixWorld.elements;
    // Orbit damping can produce sub-pixel floating point changes forever.
    // Ignore those so an otherwise stationary view can accumulate samples.
    if (
      matrix.some(
        (value, index) => Math.abs(value - (lastMatrix.current[index] ?? Infinity)) > 1e-5,
      )
    ) {
      pt.updateCamera();
      lastMatrix.current = [...matrix];
    }
    try {
      if (pt.samples < 128) pt.renderSample();
      const status =
        pt.samples >= 128
          ? 'Path traced · 128 samples'
          : pt.samples < 1
            ? 'Settling light…'
            : `Refining · ${Math.floor(pt.samples)} / 128 samples`;
      if (status !== lastStatus.current) {
        lastStatus.current = status;
        onStatus(status);
      }
    } catch (error) {
      console.error('Path tracer render failed', error);
      pt.dispose();
      tracer.current = null;
      onStatus('Refinement unavailable · live rendering');
      gl.render(scene, camera);
    }
  }, 1);
  return null;
}
export function FloorPlanSvg({
  house,
  selected,
  onSelect,
  selection,
  onSelectSurface,
  level,
  quality = 'live',
}: Pick<Props, 'house' | 'selected' | 'onSelect' | 'selection' | 'onSelectSurface'> & {
  level: number;
  quality?: Quality;
}) {
  const rooms = house.rooms.filter((room) => Math.abs(room.elevation - level) < 0.01);
  const extents = rooms.length
    ? rooms.reduce(
        (b, room) => [
          Math.min(b[0], room.x - room.width / 2),
          Math.min(b[1], room.z - room.depth / 2),
          Math.max(b[2], room.x + room.width / 2),
          Math.max(b[3], room.z + room.depth / 2),
        ],
        [Infinity, Infinity, -Infinity, -Infinity],
      )
    : [-12, -10, 12, 10];
  const [minX, minZ, maxX, maxZ] = extents;
  const width = maxX - minX + 6,
    depth = maxZ - minZ + 6;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      fontFamily="sans-serif"
      viewBox={`${minX - 3} ${minZ - 3} ${width} ${depth}`}
      role={onSelectSurface ? 'group' : 'img'}
      aria-label={`Floor plan at ${level} meters`}
    >
      {house.rooms
        .filter((r) => Math.abs(r.elevation - level) < 0.01)
        .map((r) => (
          <g
            key={r.id}
            onClick={() => onSelect(r.id)}
            tabIndex={0}
            role="button"
            aria-label={`Select ${r.name}`}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onSelect(r.id);
              }
            }}
            style={{ cursor: 'pointer' }}
          >
            <rect
              onClick={
                onSelectSurface
                  ? (event) => {
                      event.stopPropagation();
                      onSelectSurface({ roomId: r.id, surface: 'floor' });
                    }
                  : undefined
              }
              role={onSelectSurface ? 'button' : undefined}
              tabIndex={onSelectSurface ? 0 : undefined}
              aria-label={onSelectSurface ? `Select ${r.name} floor` : undefined}
              onKeyDown={
                onSelectSurface
                  ? (event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        event.stopPropagation();
                        onSelectSurface({ roomId: r.id, surface: 'floor' });
                      }
                    }
                  : undefined
              }
              x={r.x - r.width / 2}
              y={r.z - r.depth / 2}
              width={r.width}
              height={r.depth}
              fill={
                selected === r.id && (!selection || ['room', 'floor'].includes(selection.surface))
                  ? '#dac5a6'
                  : ['courtyard', 'terrace'].includes(r.kind)
                    ? '#dce3d0'
                    : quality === 'clay'
                      ? '#ddd9ce'
                      : palettes[surfacePalette(house, r, 'floor')].floor
              }
              fillOpacity={
                quality === 'wireframe'
                  ? 0
                  : selected === r.id &&
                      (!selection || ['room', 'floor'].includes(selection.surface))
                    ? 1
                    : 0.48
              }
              stroke={['courtyard', 'terrace'].includes(r.kind) ? '#899b7c' : 'none'}
              strokeWidth={0.08}
              strokeDasharray=".25 .15"
            />
            <text
              x={r.x}
              y={r.z - 0.2}
              textAnchor="middle"
              fontSize={Math.min(0.52, r.width / 15)}
              fill="#384d43"
            >
              {r.name}
            </text>
            <text x={r.x} y={r.z + 0.55} textAnchor="middle" fontSize=".4" fill="#8b8f81">
              {r.width} × {r.depth} m
            </text>
          </g>
        ))}
      <g>
        {house.rooms
          .filter(
            (room) => room.elevation === level && !['courtyard', 'terrace'].includes(room.kind),
          )
          .flatMap((room) =>
            (['north', 'south', 'east', 'west'] as const).flatMap((side) => {
              const axis = wallAxis(room, side);
              // Each floor owns its plan outline even when a neighboring
              // double-height room supplies that surface in the 3D model.
              const panels = wallPanels(house, room, side, false).filter(
                (panel) => panel.bottom < 1 && panel.bottom + panel.height > 1,
              );
              if (!panels.length) return [];
              const hit = planWallHitTarget(room, side);
              return [
                <g
                  key={`${room.id}-${side}`}
                  role={onSelectSurface ? 'button' : undefined}
                  tabIndex={onSelectSurface ? 0 : undefined}
                  aria-label={`Select ${room.name} ${side} wall`}
                  onClick={
                    onSelectSurface
                      ? () => onSelectSurface({ roomId: room.id, surface: side })
                      : undefined
                  }
                  onKeyDown={
                    onSelectSurface
                      ? (event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            onSelectSurface({ roomId: room.id, surface: side });
                          }
                        }
                      : undefined
                  }
                  style={onSelectSurface ? { cursor: 'pointer' } : undefined}
                >
                  {onSelectSurface && (
                    <rect
                      data-wall-hit-target={side}
                      x={hit.minX}
                      y={hit.minZ}
                      width={hit.maxX - hit.minX}
                      height={hit.maxZ - hit.minZ}
                      fill="transparent"
                      pointerEvents="all"
                    />
                  )}
                  {panels.map((panel, index) => {
                    const start = axis.center + panel.offset - panel.width / 2;
                    const end = axis.center + panel.offset + panel.width / 2;
                    return (
                      <line
                        key={`${room.id}-${side}-${index}`}
                        x1={axis.horizontal ? start : axis.boundary}
                        y1={axis.horizontal ? axis.boundary : start}
                        x2={axis.horizontal ? end : axis.boundary}
                        y2={axis.horizontal ? axis.boundary : end}
                        stroke={
                          selection?.roomId === room.id && selection.surface === side
                            ? '#c98a36'
                            : room[side] === 'glass'
                              ? '#779faa'
                              : palettes[surfacePalette(house, room, side)].accent
                        }
                        strokeWidth={
                          selection?.roomId === room.id && selection.surface === side
                            ? 0.3
                            : room[side] === 'glass'
                              ? 0.12
                              : 0.2
                        }
                        strokeLinecap="butt"
                      />
                    );
                  })}
                </g>,
              ];
            }),
          )}
        {house.stairs
          .filter(
            (stair) =>
              level >= stair.elevation - 0.01 && level <= stair.elevation + stair.rise + 0.01,
          )
          .map((stair) => {
            const footprint = stairFootprint(stair, 0);
            return (
              <g key={stair.id} pointerEvents="none">
                <rect
                  x={footprint.minX}
                  y={footprint.minZ}
                  width={footprint.maxX - footprint.minX}
                  height={footprint.maxZ - footprint.minZ}
                  fill="#e9e4d7"
                  stroke="#899483"
                  strokeWidth={0.05}
                />
                <g transform={`translate(${stair.x} ${stair.z}) rotate(${-stair.rotation})`}>
                  {Array.from({ length: Math.ceil(stair.rise / 0.18) }, (_, index) => (
                    <line
                      key={index}
                      x1={-stair.width / 2}
                      x2={stair.width / 2}
                      y1={-stair.run / 2 + (index * stair.run) / Math.ceil(stair.rise / 0.18)}
                      y2={-stair.run / 2 + (index * stair.run) / Math.ceil(stair.rise / 0.18)}
                      stroke="#899483"
                      strokeWidth={0.04}
                    />
                  ))}
                  <path
                    d={`M 0 ${-stair.run * 0.35} V ${stair.run * 0.35} m -.18 -.3 l .18 .3 .18 -.3`}
                    fill="none"
                    stroke="#526a59"
                    strokeWidth={0.06}
                  />
                </g>
              </g>
            );
          })}
      </g>
    </svg>
  );
}
function FloorPlan({
  house,
  selected,
  onSelect,
  selection,
  onSelectSurface,
  quality,
}: Pick<Props, 'house' | 'selected' | 'onSelect' | 'selection' | 'onSelectSurface' | 'quality'>) {
  const levels = [...new Set(house.rooms.map((r) => r.elevation))].sort((a, b) => a - b);
  return (
    <div className="floor-plan">
      <div className="plan-heading">
        <h2>Floor plan</h2>
        <p>Dimensions in meters · gaps show openings · select a space to inspect it</p>
      </div>
      <div className="plan-levels">
        {(levels.length ? levels : [0]).map((level) => (
          <div className="plan-level" key={level}>
            <span className="eyebrow">LEVEL {level.toFixed(1)} M</span>
            <FloorPlanSvg
              house={house}
              selected={selected}
              onSelect={onSelect}
              selection={selection}
              onSelectSurface={onSelectSurface}
              level={level}
              quality={quality}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
class CanvasError extends Component<{ children: ReactNode }, { error: boolean }> {
  state = { error: false };
  static getDerivedStateFromError() {
    return { error: true };
  }
  render() {
    return this.state.error ? (
      <div className="canvas-error">
        The 3D renderer could not start. Enable hardware acceleration in your browser, then reload.
        Your saved project is safe.
      </div>
    ) : (
      this.props.children
    );
  }
}
export default function SceneView(props: Props) {
  const sceneKey = JSON.stringify([props.house, props.light, props.cutaway]);
  if (props.view === 'plan') return <FloorPlan {...props} />;
  return (
    <CanvasError>
      <Canvas
        shadows
        dpr={[1, 1.7]}
        camera={{ position: [34, 26, 38], fov: 43, near: 0.1, far: 500 }}
        gl={{
          antialias: true,
          preserveDrawingBuffer: true,
          powerPreference: 'high-performance',
          toneMapping: THREE.ACESFilmicToneMapping,
        }}
        onPointerMissed={() => props.onSelect(null)}
      >
        <Suspense fallback={null}>
          <Environment light={props.light} />
          <Site house={props.house} quality={props.quality} />
          <Architecture {...props} />
          <CameraRig {...props} />
          <ProgressiveRenderer
            enabled={props.quality === 'refined'}
            sceneKey={sceneKey}
            onStatus={props.onRenderStatus}
          />
        </Suspense>
      </Canvas>
    </CanvasError>
  );
}
