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
  roofPatches,
  wallTopProfile,
  terrainHeight,
  type Rect,
} from './renderGeometry';
import { RetainedResource } from './retainedResource';
import { GpuSchedule } from './gpuSchedule';
import { renderingBudget, visualSceneKey } from './renderPerformance';
import { physicalUvs, slabGeometry, wallCapGeometry } from './renderMeshes';
import { effectiveRoof, roofHeightAt } from '../shared/architecture';
import { roomOpenings } from '../shared/openings';
import { renderCamera, renderRequestSchema } from '../shared/render';
import { surfacePalette, type DesignSelection, type DesignSurface } from '../shared/selection';
import { roomFurniture } from '../shared/furniture';
import type { Furniture } from '../shared/model';

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
  ctx.fillStyle = kind === 'wood' ? '#e7e0d5' : kind === 'ground' ? '#aeae97' : '#dbd7cc';
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
  if (kind === 'wood') {
    ctx.strokeStyle = 'rgba(70,55,35,.22)';
    ctx.lineWidth = 1;
    for (let x = 0; x < 256; x += 32) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, 256);
      ctx.stroke();
      ctx.fillStyle = `rgba(255,255,255,${0.01 + random() * 0.05})`;
      ctx.fillRect(x + 1, 0, 30, 256);
    }
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
  texture.repeat.set(kind === 'ground' ? 30 : 1, kind === 'ground' ? 30 : 1);
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
  const geometry = useMemo(
    () => physicalUvs(new THREE.BoxGeometry(...size)),
    [size[0], size[1], size[2]],
  );
  useEffect(() => () => geometry.dispose(), [geometry]);
  return (
    <mesh
      geometry={geometry}
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
function FurnitureMesh({
  item,
  materials: m,
  selected,
  onSelect,
}: {
  item: Furniture;
  materials: Record<string, THREE.Material>;
  selected: boolean;
  onSelect: () => void;
}) {
  const box = (
    key: string,
    x: number,
    y: number,
    z: number,
    w: number,
    h: number,
    d: number,
    material: THREE.Material,
  ) => <Box key={key} position={[x, y, z]} size={[w, h, d]} material={material} />;
  const seating = ['sofa', 'armchair', 'chair'].includes(item.kind);
  const table = ['coffee-table', 'dining-table', 'nightstand'].includes(item.kind);
  return (
    <group
      position={[item.x, 0, item.z]}
      rotation={[0, (item.rotation * Math.PI) / 180, 0]}
      scale={[item.width, item.height, item.depth]}
      userData={{ furnitureId: item.id }}
      onClick={(e) => {
        e.stopPropagation();
        onSelect();
      }}
    >
      {seating ? (
        <>
          {box('base', 0, 0.3, 0, 1, 0.35, 1, m.fabric)}
          {box('back', 0, 0.72, -0.41, 1, 0.56, 0.18, m.fabric)}
          {item.kind !== 'chair' &&
            [-1, 1].map((sign) => box(`arm${sign}`, sign * 0.45, 0.53, 0, 0.1, 0.36, 1, m.fabric))}
          {[-1, 1].flatMap((x) =>
            [-1, 1].map((z) =>
              box(`leg${x}${z}`, x * 0.38, 0.09, z * 0.34, 0.08, 0.18, 0.08, m.wood),
            ),
          )}
        </>
      ) : item.kind === 'bed' ? (
        <>
          {box('base', 0, 0.16, 0, 0.92, 0.3, 1, m.wood)}
          {box('mattress', 0, 0.36, 0.02, 0.9, 0.2, 0.94, m.fabric)}
          {box('headboard', 0, 0.5, -0.46, 1, 1, 0.08, m.wood)}
          {[-1, 1].map((sign) =>
            box(`pillow${sign}`, sign * 0.23, 0.49, -0.27, 0.34, 0.09, 0.2, m.rug),
          )}
        </>
      ) : table ? (
        <>
          {box('top', 0, 0.93, 0, 1, 0.14, 1, m.wood)}
          {[-1, 1].flatMap((x) =>
            [-1, 1].map((z) =>
              box(`leg${x}${z}`, x * 0.4, 0.43, z * 0.36, 0.07, 0.86, 0.08, m.frame),
            ),
          )}
        </>
      ) : item.kind === 'rug' ? (
        box('rug', 0, 0.5, 0, 1, 1, 1, m.rug)
      ) : item.kind === 'bath' ? (
        <>
          {box('base', 0, 0.4, 0, 1, 0.8, 1, m.fabric)}
          {box('water', 0, 0.805, 0, 0.82, 0.012, 0.65, m.glass)}
          {box('tap', 0.38, 0.9, 0, 0.025, 0.2, 0.05, m.frame)}
        </>
      ) : item.kind === 'toilet' ? (
        <>
          {box('tank', 0, 0.58, -0.34, 1, 0.84, 0.32, m.fabric)}
          {box('bowl', 0, 0.32, 0.1, 0.86, 0.55, 0.8, m.fabric)}
        </>
      ) : (
        <>
          {box('body', 0, 0.46, 0, 0.94, 0.92, 0.94, m.wood)}
          {box('top', 0, 0.96, 0, 1, 0.08, 1, item.kind === 'wardrobe' ? m.wood : m.wall)}
          {box('handle', 0, 0.64, 0.48, 0.25, 0.025, 0.04, m.frame)}
          {['island', 'vanity'].includes(item.kind) &&
            box('sink', 0, 0.999, 0, 0.35, 0.002, 0.45, m.frame)}
        </>
      )}
      {selected && (
        <mesh position={[0, 0.5, 0]}>
          <boxGeometry args={[1.015, 1.015, 1.015]} />
          <meshBasicMaterial color="#d3933d" wireframe toneMapped={false} />
        </mesh>
      )}
    </group>
  );
}

function RoomMesh({
  house,
  room: r,
  materials: m,
  materialSets,
  selection,
  onSelectSurface,
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
    quality !== 'refined' && selection?.roomId === r.id && selection.surface === surface;
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
  const generated = useMemo(() => {
    const origin: [number, number, number] = [r.x, r.elevation, r.z];
    const roofY = (x: number, z: number) =>
      slabs.roofClipped ? r.elevation + r.height : roofHeightAt(house, r, x, z);
    return {
      roofs: roofPatches(house, r).map((rect) =>
        slabGeometry(rect, origin, (x, z) => roofY(x, z) + 0.18, roofY),
      ),
      soffits: roofPatches(house, r).map((rect) =>
        slabGeometry(
          rect,
          origin,
          (x, z) => roofY(x, z) + 0.025,
          (x, z) => roofY(x, z) - 0.035,
        ),
      ),
      foundations: slabs.foundation.map((rect) =>
        slabGeometry(
          rect,
          origin,
          () => r.elevation - 0.18,
          (x, z) => Math.min(r.elevation - 0.32, terrainHeight(house, x, z) - 0.12),
        ),
      ),
      caps: Object.fromEntries(
        (['north', 'south', 'east', 'west'] as const).map((side) => [
          side,
          wallCapGeometry(
            wallTopProfile(house, r, side),
            r.height,
            roomOpenings(house, r.id, side),
          ),
        ]),
      ),
    };
  }, [house, r, slabs]);
  useEffect(
    () => () => {
      [
        ...generated.roofs,
        ...generated.soffits,
        ...generated.foundations,
        ...Object.values(generated.caps),
      ].forEach((geometry) => geometry?.dispose());
    },
    [generated],
  );
  const generatedMesh = (
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    key: number | string,
    surface?: DesignSurface,
  ) => (
    <mesh
      key={key}
      geometry={geometry}
      material={material}
      castShadow
      receiveShadow
      onClick={
        surface
          ? (event) => {
              event.stopPropagation();
              pick(surface);
            }
          : undefined
      }
    >
      {surface && isSelected(surface) && (
        <mesh geometry={geometry} scale={1.001}>
          <meshBasicMaterial color="#e3a44f" wireframe toneMapped={false} />
        </mesh>
      )}
    </mesh>
  );
  const wall = (side: Side) => {
    if (cutaway && cutawaySides.includes(side)) return null;
    const { horizontal } = wallAxis(r, side);
    const sm = surfaceMaterial(side);
    const position: [number, number, number] = horizontal
      ? [0, 0, (side === 'north' ? -1 : 1) * (r.depth / 2 - 0.05)]
      : [(side === 'west' ? -1 : 1) * (r.width / 2 - 0.05), 0, 0];
    const panels = wallPanels(house, r, side, false);
    const openings = roomOpenings(house, r.id, side);
    const glazing = (offset: number, bottom: number, width: number, height: number, id: string) => (
      <group key={id} position={[offset, bottom, 0]}>
        <Box
          position={[0, height / 2, 0]}
          size={[width, height, 0.024]}
          material={sm.glass}
          cast={false}
          highlight={isSelected(side)}
        />
        {[0, height].map((y) => (
          <Box
            key={y}
            position={[0, y, 0]}
            size={[width + 0.07, 0.055, 0.12]}
            material={sm.frame}
          />
        ))}
        {Array.from(
          { length: Math.ceil(width / 1.7) + 1 },
          (_, i) => -width / 2 + (i * width) / Math.ceil(width / 1.7),
        ).map((x) => (
          <Box
            key={x}
            position={[x, height / 2, 0]}
            size={[0.045, height, 0.12]}
            material={sm.frame}
          />
        ))}
      </group>
    );
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
          r[side] === 'glass' && !openings.length ? (
            glazing(panel.offset, panel.bottom, panel.width, panel.height, `wall-${index}`)
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
        {generated.caps[side] &&
          generatedMesh(
            generated.caps[side]!,
            r[side] === 'glass' && !openings.length ? sm.glass : sm.wall,
            `cap-${side}`,
            side,
          )}
        {openings.map((opening) =>
          opening.kind === 'window' ? (
            <group key={opening.id}>
              {glazing(opening.offset, opening.sill, opening.width, opening.height, opening.id)}
              <Box
                position={[opening.offset, opening.sill - 0.035, 0]}
                size={[opening.width + 0.12, 0.06, 0.24]}
                material={sm.wood}
              />
            </group>
          ) : opening.kind === 'door' ? (
            <group key={opening.id} position={[opening.offset, opening.sill, 0]}>
              {[-1, 1].map((sign) => (
                <Box
                  key={sign}
                  position={[sign * (opening.width / 2 - 0.025), opening.height / 2, 0]}
                  size={[0.05, opening.height, 0.15]}
                  material={sm.frame}
                />
              ))}
              <Box
                position={[0, opening.height - 0.025, 0]}
                size={[opening.width, 0.05, 0.15]}
                material={sm.frame}
              />
            </group>
          ) : null,
        )}
      </group>
    );
  };
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
          -0.11,
          0.22,
          outdoor && !r.palette && !r.surfacePalettes?.floor
            ? m.deck
            : surfaceMaterial('floor').floor,
          index,
          'floor',
        ),
      )}
      {generated.foundations.map((geometry, index) => generatedMesh(geometry, m.foundation, index))}
      {!outdoor && (
        <>
          {(['north', 'south', 'east', 'west'] as const).map(wall)}
          {!cutaway && (
            <>
              {generated.roofs.map((geometry, index) =>
                generatedMesh(geometry, surfaceMaterial('roof').roof, index, 'roof'),
              )}
              {generated.soffits.map((geometry, index) =>
                generatedMesh(geometry, surfaceMaterial('roof').wood, `soffit-${index}`, 'roof'),
              )}
            </>
          )}
        </>
      )}
      {roomFurniture(r).map((item) => (
        <FurnitureMesh
          key={item.id}
          item={item}
          materials={item.palette ? materialSets[item.palette] : m}
          selected={
            quality !== 'refined' && selection?.roomId === r.id && selection.furnitureId === item.id
          }
          onSelect={() =>
            onSelectSurface
              ? onSelectSurface({ roomId: r.id, surface: 'room', furnitureId: item.id })
              : onSelect()
          }
        />
      ))}
      {r.kind === 'courtyard' && (
        <>
          <Box position={[0, 0.18, 0]} size={[1.2, 0.35, 1.2]} material={m.wall} />
          <Tree x={0} z={0} y={0.35} scale={0.6} />
        </>
      )}
      {selected && quality !== 'refined' && (
        <>
          {(!selection || (selection.surface === 'room' && !selection.furnitureId)) && (
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
export function Environment({ light, house }: { light: Light; house?: Scene }) {
  const { scene } = useThree();
  const lighting = useMemo(() => {
    const rooms = house?.rooms ?? [];
    const minX = Math.min(0, ...rooms.map((room) => room.x - room.width / 2));
    const maxX = Math.max(0, ...rooms.map((room) => room.x + room.width / 2));
    const minZ = Math.min(0, ...rooms.map((room) => room.z - room.depth / 2));
    const maxZ = Math.max(0, ...rooms.map((room) => room.z + room.depth / 2));
    const target = new THREE.Object3D();
    target.position.set((minX + maxX) / 2, 0, (minZ + maxZ) / 2);
    target.updateMatrixWorld(true);
    return {
      target,
      extent: Math.min(75, Math.max(12, (maxX - minX) / 2 + 5, (maxZ - minZ) / 2 + 5)),
    };
  }, [house?.rooms]);
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
      <ambientLight intensity={light === 'evening' ? 0.12 : 0.22} />
      <hemisphereLight args={['#e7eff4', '#766d56', 0.85]} />
      <directionalLight
        position={[
          lighting.target.position.x - 30,
          light === 'golden' ? 24 : 48,
          lighting.target.position.z + 20,
        ]}
        target={lighting.target}
        intensity={light === 'evening' ? 0.4 : 3}
        color={light === 'golden' ? '#ffe1aa' : '#fff3db'}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-lighting.extent}
        shadow-camera-right={lighting.extent}
        shadow-camera-top={lighting.extent}
        shadow-camera-bottom={-lighting.extent}
        shadow-camera-far={150}
        shadow-bias={-0.0002}
        shadow-normalBias={0.015}
      />
    </>
  );
}
export function Site({ house, quality }: { house: Scene; quality: Quality }) {
  const texture = useMemo(() => makeTexture('ground'), []);
  const geometry = useMemo(() => {
    const geo = new THREE.PlaneGeometry(180, 180, 180, 180);
    geo.rotateX(-Math.PI / 2);
    const p = geo.attributes.position;
    for (let i = 0; i < p.count; i++) p.setY(i, terrainHeight(house, p.getX(i), p.getZ(i)));
    geo.computeVertexNormals();
    return geo;
  }, [house.slope, house.rooms]);
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
      {positions
        .filter(
          ([x, z]) =>
            !house.rooms.some(
              (room) =>
                Math.abs(x - room.x) < room.width / 2 + 3 &&
                Math.abs(z - room.z) < room.depth / 2 + 3,
            ),
        )
        .map(([x, z, s], i) => (
          <Tree key={i} x={x} z={z} y={terrainHeight(house, x, z)} scale={s} />
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
              bumpMap: clay || wireframe ? null : map,
              bumpScale: map === textures.wood ? 0.018 : 0.012,
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
              roof: new THREE.MeshStandardMaterial({
                color: clay ? '#e0dcd1' : p.roof,
                roughness: 0.55,
                metalness: clay ? 0 : 0.25,
                wireframe,
              }),
              frame: mat(p.accent, 0.3),
              foundation: mat('#a19d8f', 1, textures.stone),
              deck: mat('#bcbaa7', 0.9, textures.stone),
              fabric: mat('#e2decd', 1),
              rug: mat('#bcb8a4', 1),
              glass:
                clay || wireframe
                  ? mat('#cad8d3', 0.2)
                  : new THREE.MeshPhysicalMaterial({
                      color: '#edf6f5',
                      roughness: 0.08,
                      metalness: 0,
                      transparent: true,
                      opacity: quality === 'refined' ? 1 : 0.22,
                      transmission: quality === 'refined' ? 0.94 : 0,
                      thickness: 0.02,
                      ior: 1.5,
                      depthWrite: false,
                      envMapIntensity: 1.2,
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
      const framing = renderCamera(
        house,
        renderRequestSchema.parse({ view: 'exterior' }),
        gl.domElement.clientWidth / Math.max(1, gl.domElement.clientHeight),
      );
      camera.position.set(...framing.position);
      controls.current?.target.set(...framing.target);
      camera.lookAt(...framing.target);
      controls.current?.update();
    }
  }, [view, resetKey, camera, house.rooms.length === 0]);
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
  light,
  onStatus,
}: {
  enabled: boolean;
  sceneKey: string;
  light: Light;
  onStatus: (text: string) => void;
}) {
  const { gl, scene, camera, size } = useThree();
  // Installed 0.0.24 exposes this getter but omits it from its declaration.
  type Tracer = import('three-gpu-pathtracer').WebGLPathTracer & { readonly isCompiling: boolean };
  const state = useRef<{
    pt: Tracer;
    worker: import('./pathTraceWorker').PathTraceWorker;
    busy: boolean;
    key: string | null;
    light: Light;
    builds: number;
    scale: number;
    started: number;
    preparingSince: number;
  } | null>(null);
  const resources = useRef<RetainedResource<NonNullable<typeof state.current>> | null>(null);
  const materialRevision = useRef(0);
  const current = useRef({ sceneKey, light, onStatus, enabled });
  current.current = { sceneKey, light, onStatus, enabled };
  const lastMatrix = useRef<number[]>([]);
  const lastStatus = useRef('');
  const rendererName = useMemo(() => {
    const context = gl.getContext();
    const extension = context.getExtension('WEBGL_debug_renderer_info');
    return extension ? String(context.getParameter(extension.UNMASKED_RENDERER_WEBGL)) : '';
  }, [gl]);
  const gpu = useMemo(
    () =>
      new GpuSchedule(
        gl.getContext() as WebGL2RenderingContext,
        /intel|swiftshader|llvmpipe/i.test(rendererName) ? 24 : 12,
      ),
    [gl, rendererName],
  );
  const contextLost = useRef(false);
  const disabledAfterError = useRef(false);
  const report = (status: string) => {
    if (status !== lastStatus.current) {
      lastStatus.current = status;
      current.current.onStatus(status);
    }
  };
  const abandon = (message: string) => {
    state.current = null;
    disabledAfterError.current = true;
    resources.current?.clear();
    gpu.dispose();
    if (!gl.getContext().isContextLost()) {
      gl.setRenderTarget(null);
      gl.setScissorTest(false);
      const viewport = gl.getSize(new THREE.Vector2());
      gl.setViewport(0, 0, viewport.x, viewport.y);
      gl.autoClear = true;
    }
    gl.domElement.dataset.renderError = message;
    report(message);
  };
  useEffect(() => {
    const owner = new RetainedResource<NonNullable<typeof state.current>>((active) => {
      active.worker.dispose();
      active.pt.dispose();
    });
    resources.current = owner;
    const lost = (event: Event) => {
      event.preventDefault();
      contextLost.current = true;
      abandon('Graphics context lost · waiting to restore the live view');
    };
    const restored = () => {
      contextLost.current = false;
      report('Graphics restored · live rendering');
    };
    gl.domElement.addEventListener('webglcontextlost', lost);
    gl.domElement.addEventListener('webglcontextrestored', restored);
    return () => {
      if (resources.current === owner) {
        resources.current = null;
        state.current = null;
      }
      owner.dispose();
      gpu.dispose();
      gl.domElement.removeEventListener('webglcontextlost', lost);
      gl.domElement.removeEventListener('webglcontextrestored', restored);
    };
  }, [gl, gpu]);
  useEffect(() => {
    let cancelled = false;
    disabledAfterError.current = false;
    delete gl.domElement.dataset.renderError;
    delete gl.domElement.dataset.renderFirstSampleMs;
    report(enabled ? 'Preparing path tracer' : 'Live rendering');
    const owner = resources.current;
    if (enabled && owner) {
      // Quality changes replace raster materials; reuse the tracer but refresh
      // its scene references before showing its next accumulated image.
      materialRevision.current++;
      void owner
        .acquire(async () => {
          const [{ WebGLPathTracer }, { PathTraceWorker }] = await Promise.all([
            import('three-gpu-pathtracer'),
            import('./pathTraceWorker'),
          ]);
          if (owner.closed || resources.current !== owner || contextLost.current)
            throw new Error('The render canvas is no longer available.');
          const pt = new WebGLPathTracer(gl) as Tracer;
          let worker: import('./pathTraceWorker').PathTraceWorker;
          try {
            worker = new PathTraceWorker();
          } catch (error) {
            pt.dispose();
            throw error;
          }
          pt.setBVHWorker(worker);
          pt.textureSize.set(256, 256);
          pt.bounces = 4;
          pt.transmissiveBounces = 6;
          pt.filterGlossyFactor = 0.5;
          pt.renderDelay = 180;
          pt.minSamples = 1;
          pt.fadeDuration = 180;
          return {
            pt,
            worker,
            busy: false,
            key: null,
            light: current.current.light,
            builds: 0,
            scale: 0,
            started: performance.now(),
            preparingSince: performance.now(),
          };
        })
        .then((active) => {
          if (cancelled || !active || resources.current !== owner || contextLost.current) return;
          state.current = active;
          lastMatrix.current = [];
        })
        .catch((error) => {
          if (cancelled || resources.current !== owner) return;
          console.error('Path tracer initialization failed', error);
          abandon('Refinement unavailable · live rendering');
        });
    }
    // Keep initialized resources paused while another rendering mode is shown.
    // Their canvas owns final cleanup, including its underlying GL context.
    return () => {
      cancelled = true;
    };
  }, [enabled, gl]);
  useFrame(() => {
    if (contextLost.current || gl.getContext().isContextLost()) return;
    const now = performance.now();
    const active = state.current;
    if (enabled && !disabledAfterError.current) {
      try {
        // A driver's initial program compilation can hold its command queue.
        // Give it the same startup budget as the asynchronous shader compiler.
        if (!gpu.ready(now, active?.pt.isCompiling ? 45_000 : 12_000)) return;
      } catch (error) {
        abandon('Refinement paused · live rendering');
        console.error(error);
        return;
      }
    }
    const raster = () => {
      gl.render(scene, camera);
      if (enabled && !disabledAfterError.current) gpu.submittedFrame(now);
    };
    if (!enabled || !active) {
      raster();
      return;
    }
    const { pt } = active;
    const requestedKey = `${current.current.sceneKey}|materials:${materialRevision.current}`;
    if (
      (active.busy && now - active.preparingSince > 30_000) ||
      (pt.isCompiling && now - active.started > 45_000)
    ) {
      abandon('Refinement took too long · live rendering');
      raster();
      return;
    }
    if (!active.busy && active.key !== requestedKey) {
      active.busy = true;
      const key = requestedKey;
      const began = performance.now();
      active.preparingSince = began;
      report('Preparing light · live view available');
      scene.updateMatrixWorld(true);
      void pt
        .setSceneAsync(scene, camera)
        .then(() => {
          if (state.current !== active) return;
          active.busy = false;
          active.key = key;
          active.light = current.current.light;
          active.started = performance.now();
          active.builds += 1;
          gl.domElement.dataset.renderBuildMs = String(Math.round(performance.now() - began));
          gl.domElement.dataset.renderBuilds = String(active.builds);
          lastMatrix.current = [];
        })
        .catch((error) => {
          if (state.current !== active) return;
          console.error('Path tracer preparation failed', error);
          abandon('Refinement unavailable · live rendering');
        });
    }
    if (active.busy || active.key !== requestedKey) {
      raster();
      return;
    }
    try {
      const budget = renderingBudget(rendererName, size.width, size.height, gl.getPixelRatio());
      if (Math.abs(active.scale - budget.scale) > 0.0001) {
        active.scale = budget.scale;
        pt.renderScale = budget.scale;
        pt.tiles.set(budget.tiles, budget.tiles);
        pt.reset();
      }
      if (active.light !== current.current.light) {
        active.light = current.current.light;
        pt.updateEnvironment();
        pt.updateLights();
      }
      const matrix = [...camera.matrixWorld.elements, ...camera.projectionMatrix.elements];
      if (
        matrix.some(
          (value, index) => Math.abs(value - (lastMatrix.current[index] ?? Infinity)) > 1e-5,
        )
      ) {
        pt.updateCamera();
        lastMatrix.current = [...matrix];
        active.started = performance.now();
      }
      if (pt.samples < budget.maxSamples) {
        pt.renderSample();
        gpu.submittedFrame(now);
      }
      gl.domElement.dataset.renderCompiling = String(pt.isCompiling);
      gl.domElement.dataset.renderSamples = String(pt.samples);
      gl.domElement.dataset.renderScale = String(budget.scale.toFixed(3));
      gl.domElement.dataset.renderElapsedMs = String(
        Math.round(performance.now() - active.started),
      );
      if (pt.samples >= 1 && !gl.domElement.dataset.renderFirstSampleMs)
        gl.domElement.dataset.renderFirstSampleMs = String(
          Math.round(performance.now() - active.started),
        );
      report(
        pt.samples >= budget.maxSamples
          ? `Path traced · ${budget.maxSamples} samples`
          : pt.samples < 1
            ? 'Settling light…'
            : `Refining · ${Math.floor(pt.samples)} / ${budget.maxSamples} samples`,
      );
    } catch (error) {
      console.error('Path tracer render failed', error);
      abandon('Refinement unavailable · live rendering');
      gl.setRenderTarget(null);
      gl.setScissorTest(false);
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
            {[...roomFurniture(r)]
              .sort((a, b) => Number(b.kind === 'rug') - Number(a.kind === 'rug'))
              .map((item) => (
                <g
                  key={item.id}
                  data-furniture-id={item.id}
                  data-furniture-kind={item.kind}
                  transform={`translate(${r.x + item.x} ${r.z + item.z}) rotate(${-item.rotation})`}
                  role={onSelectSurface ? 'button' : undefined}
                  tabIndex={onSelectSurface ? 0 : undefined}
                  aria-label={`${item.name} in ${r.name}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    onSelectSurface?.({ roomId: r.id, surface: 'room', furnitureId: item.id });
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      event.stopPropagation();
                      onSelectSurface?.({ roomId: r.id, surface: 'room', furnitureId: item.id });
                    }
                  }}
                >
                  <title>{`${item.name} · ${item.width} × ${item.depth} m`}</title>
                  <rect
                    x={-item.width / 2}
                    y={-item.depth / 2}
                    width={item.width}
                    height={item.depth}
                    rx={Math.min(0.08, item.width * 0.1)}
                    fill={item.kind === 'rug' ? '#ded2b9' : '#f3eee4'}
                    fillOpacity={item.kind === 'rug' ? 0.28 : 0.92}
                    stroke={
                      selection?.roomId === r.id && selection.furnitureId === item.id
                        ? '#b87f45'
                        : '#7e897f'
                    }
                    strokeWidth={
                      selection?.roomId === r.id && selection?.furnitureId === item.id
                        ? 0.08
                        : 0.035
                    }
                    strokeDasharray={item.kind === 'rug' ? '.12 .08' : undefined}
                  />
                  {['sofa', 'armchair', 'chair', 'bed'].includes(item.kind) && (
                    <rect
                      pointerEvents="none"
                      x={-item.width * 0.44}
                      y={-item.depth * 0.44}
                      width={item.width * 0.88}
                      height={item.depth * 0.2}
                      fill="#c3c6ba"
                    />
                  )}
                  {item.kind !== 'rug' && (
                    <path
                      pointerEvents="none"
                      d={`M 0 ${item.depth * 0.2} l -.12 -.12 m .12 .12 l .12 -.12`}
                      fill="none"
                      stroke="#7e897f"
                      strokeWidth=".035"
                    />
                  )}
                </g>
              ))}
            <text
              pointerEvents="none"
              x={r.x}
              y={r.z - r.depth / 2 + 0.45}
              textAnchor="middle"
              fontSize={Math.min(0.52, r.width / 15)}
              fill="#384d43"
            >
              {r.name}
            </text>
            <text
              pointerEvents="none"
              x={r.x}
              y={r.z - r.depth / 2 + 0.95}
              textAnchor="middle"
              fontSize=".4"
              fill="#8b8f81"
            >
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
              const apertures = roomOpenings(house, room.id, side).filter(
                (opening) => opening.kind === 'window' || opening.sill < 1,
              );
              if (!panels.length && !apertures.length) return [];
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
                            : room[side] === 'glass' && !apertures.length
                              ? '#779faa'
                              : palettes[surfacePalette(house, room, side)].accent
                        }
                        strokeWidth={
                          selection?.roomId === room.id && selection.surface === side
                            ? 0.3
                            : room[side] === 'glass' && !apertures.length
                              ? 0.12
                              : 0.2
                        }
                        strokeLinecap="butt"
                      />
                    );
                  })}
                  {apertures.map((opening) => {
                    const center = axis.center + opening.offset;
                    const start = center - opening.width / 2,
                      end = center + opening.width / 2;
                    const color =
                      selection?.roomId === room.id && selection.surface === side
                        ? '#c98a36'
                        : '#658f9a';
                    return (
                      <g
                        key={`opening-${opening.id}`}
                        data-opening-kind={opening.kind}
                        pointerEvents="none"
                        transform={
                          axis.horizontal
                            ? `translate(${start} ${axis.boundary})`
                            : `translate(${axis.boundary} ${start}) rotate(90)`
                        }
                      >
                        {opening.kind === 'window' ? (
                          <>
                            <rect
                              x={0}
                              y={-0.11}
                              width={end - start}
                              height={0.22}
                              fill="#dce8e7"
                            />
                            {[-0.065, 0.065].map((y) => (
                              <line
                                key={y}
                                x1={0}
                                x2={end - start}
                                y1={y}
                                y2={y}
                                stroke={color}
                                strokeWidth={0.025}
                              />
                            ))}
                            {[0, end - start].map((x) => (
                              <line
                                key={x}
                                x1={x}
                                x2={x}
                                y1={-0.12}
                                y2={0.12}
                                stroke={color}
                                strokeWidth={0.05}
                              />
                            ))}
                          </>
                        ) : opening.kind === 'door' ? (
                          <>
                            <path
                              d={`M 0 0 V ${opening.width} A ${opening.width} ${opening.width} 0 0 0 ${opening.width} 0`}
                              fill="none"
                              stroke="#697c71"
                              strokeWidth={0.04}
                              strokeDasharray=".12 .08"
                            />
                            <line
                              x1={0}
                              x2={0}
                              y1={0}
                              y2={opening.width}
                              stroke="#697c71"
                              strokeWidth={0.065}
                            />
                          </>
                        ) : null}
                      </g>
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
        <p>Dimensions in meters · blue lines are windows · arcs are doors</p>
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
  const sceneKey = visualSceneKey(props.house, props.cutaway, props.cutawaySides);
  if (props.view === 'plan') return <FloorPlan {...props} />;
  return (
    <CanvasError>
      <Canvas
        shadows
        dpr={[1, 1.5]}
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
          <Environment light={props.light} house={props.house} />
          <Site house={props.house} quality={props.quality} />
          <Architecture {...props} />
          <CameraRig {...props} />
          <ProgressiveRenderer
            enabled={props.quality === 'refined'}
            sceneKey={sceneKey}
            light={props.light}
            onStatus={props.onRenderStatus}
          />
        </Suspense>
      </Canvas>
    </CanvasError>
  );
}
