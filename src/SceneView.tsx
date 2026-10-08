import { Component, Suspense, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
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
import { rasterBudget, RenderActivity, visualSceneKey } from './renderPerformance';
import { physicalUvs, slabGeometry, wallCapGeometry, interiorFaceGroups } from './renderMeshes';
import { effectiveRoof, roofHeightAt } from '../shared/architecture';
import { roomOpenings } from '../shared/openings';
import { renderCamera, renderRequestSchema } from '../shared/render';
import { surfacePalette, type DesignSelection, type DesignSurface } from '../shared/selection';
import { roomFurniture } from '../shared/furniture';
import { daylightSkyPixels, interiorExposure } from './renderLighting';
import { RasterRenderer } from './rasterRenderer';
import { FurnitureMesh } from './renderFurniture';
import { wallFinishGeometry, wallSurfaceGeometry } from './architecturalFinish';
import { makeSurfaceTextures, type SurfaceKind } from './renderMaterials';
import {
  ROOM_MAP_LIMIT,
  roomDaylightField,
  roomDaylightFallback,
  cachedRoomDaylightPixels,
  roomIrradiance,
  applyRoomIrradiance,
  roomEnvironmentTexture,
} from './roomDaylight';

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

function Box({
  position,
  size,
  material,
  rotation = 0,
  cast = true,
  onSelect,
  highlight = false,
  textureOrigin,
  insidePositive,
}: {
  position: [number, number, number];
  size: [number, number, number];
  material: THREE.Material | THREE.Material[];
  rotation?: number;
  cast?: boolean;
  onSelect?: () => void;
  highlight?: boolean;
  textureOrigin?: [number, number, number];
  insidePositive?: boolean;
}) {
  const geometry = useMemo(() => {
    const geometry = new THREE.BoxGeometry(...size);
    // UV projection uses room/wall coordinates, not the center of each panel.
    if (textureOrigin) geometry.translate(...textureOrigin);
    physicalUvs(geometry);
    if (textureOrigin)
      geometry.translate(...(textureOrigin.map((value) => -value) as [number, number, number]));
    return insidePositive === undefined ? geometry : interiorFaceGroups(geometry, insidePositive);
  }, [
    size[0],
    size[1],
    size[2],
    textureOrigin?.[0],
    textureOrigin?.[1],
    textureOrigin?.[2],
    insidePositive,
  ]);
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
  roomEnvironment,
  roomEnvironmentIntensity = 1,
}: {
  house: Scene;
  room: Room;
  roomEnvironment?: THREE.Texture;
  roomEnvironmentIntensity?: number;
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
  const interiorSets = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(materialSets).map(([palette, set]) => [
          palette,
          Object.fromEntries(
            Object.entries(set).map(([name, source]) => {
              const material = source.clone() as THREE.MeshStandardMaterial;
              material.envMap = roomEnvironment ?? null;
              if (roomEnvironment)
                applyRoomIrradiance(
                  material,
                  roomIrradiance(roomEnvironment.image.data as Float32Array),
                  roomEnvironmentIntensity,
                );
              material.envMapIntensity = roomEnvironment
                ? roomEnvironmentIntensity
                : source instanceof THREE.MeshStandardMaterial
                  ? source.envMapIntensity
                  : 1;
              return [name, material];
            }),
          ),
        ]),
      ),
    [materialSets, roomEnvironment, roomEnvironmentIntensity],
  );
  useEffect(
    () => () =>
      Object.values(interiorSets).forEach((set) =>
        Object.values(set).forEach((material) => material.dispose()),
      ),
    [interiorSets],
  );
  const insideMaterial = (surface: DesignSurface) =>
    interiorSets[surfacePalette(house, r, surface)];
  const wallMaterials = (side: Side, name: string) => {
    const outside = materialSets[surfacePalette(house, r, side)][name];
    const inside = insideMaterial(side)[name];
    return [outside, inside];
  };
  const surfaceMaterial = (surface: DesignSurface) =>
    materialSets[surfacePalette(house, r, surface)];
  const pick = (surface: DesignSurface) =>
    onSelectSurface ? onSelectSurface({ roomId: r.id, surface }) : onSelect();
  const isSelected = (surface: DesignSurface) =>
    selection?.roomId === r.id && selection.surface === surface;
  const slabs = useMemo(() => roomSlabs(house, r), [house, r]);
  const finishes = useMemo(
    () =>
      Object.fromEntries(
        (['north', 'south', 'east', 'west'] as const).map((side) => [
          side,
          wallFinishGeometry(house, r, side),
        ]),
      ),
    [house, r],
  );
  useEffect(
    () => () =>
      Object.values(finishes)
        .flat()
        .forEach((part) => part.geometry.dispose()),
    [finishes],
  );

  const wallSurfaces = useMemo(
    () =>
      Object.fromEntries(
        (['north', 'south', 'east', 'west'] as const).map((side) => [
          side,
          wallSurfaceGeometry(house, r, side),
        ]),
      ),
    [house, r],
  );
  useEffect(
    () => () =>
      Object.values(wallSurfaces)
        .flat()
        .forEach((part) => part.geometry.dispose()),
    [wallSurfaces],
  );

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
    const roof = effectiveRoof(house, r);
    const roofTextureAxis =
      slabs.roofClipped || roof.style === 'flat' || ['north', 'south'].includes(roof.direction)
        ? 'z'
        : 'x';
    const roofY = (x: number, z: number) =>
      slabs.roofClipped ? r.elevation + r.height : roofHeightAt(house, r, x, z);
    const cap = (side: Side) => {
      const geometry = wallCapGeometry(
        wallTopProfile(house, r, side),
        r.height,
        roomOpenings(house, r.id, side),
        [wallAxis(r, side).center, r.elevation, 0],
      );
      return geometry ? interiorFaceGroups(geometry, side === 'north' || side === 'east') : null;
    };
    return {
      roofs: roofPatches(house, r).map((rect) =>
        slabGeometry(rect, origin, (x, z) => roofY(x, z) + 0.18, roofY, roofTextureAxis),
      ),
      soffits: roofPatches(house, r).map((rect) =>
        slabGeometry(
          rect,
          origin,
          (x, z) => roofY(x, z) + 0.025,
          (x, z) => roofY(x, z) - 0.035,
          roofTextureAxis,
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
        (['north', 'south', 'east', 'west'] as const).map((side) => [side, cap(side)]),
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
    material: THREE.Material | THREE.Material[],
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
    const openings = roomOpenings(house, r.id, side);
    const position: [number, number, number] = horizontal
      ? [0, 0, (side === 'north' ? -1 : 1) * (r.depth / 2 - 0.05)]
      : [(side === 'west' ? -1 : 1) * (r.width / 2 - 0.05), 0, 0];
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
        {finishes[side].map((part) => (
          <mesh
            key={part.material}
            geometry={part.geometry}
            material={insideMaterial(side)[part.material]}
            castShadow
            receiveShadow
          />
        ))}
        {wallSurfaces[side].map((part) => (
          <mesh
            key={part.material}
            geometry={part.geometry}
            material={wallMaterials(side, part.material)}
            castShadow={part.material !== 'glass'}
            receiveShadow
          >
            {isSelected(side) && (
              <mesh geometry={part.geometry} scale={1.001}>
                <meshBasicMaterial color="#e3a44f" wireframe toneMapped={false} />
              </mesh>
            )}
          </mesh>
        ))}
        {generated.caps[side] &&
          generatedMesh(
            generated.caps[side]!,
            wallMaterials(side, r[side] === 'glass' && !openings.length ? 'glass' : 'wall'),
            `cap-${side}`,
            side,
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
            : outdoor
              ? surfaceMaterial('floor').floor
              : insideMaterial('floor').floor,
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
                generatedMesh(geometry, insideMaterial('roof').wood, `soffit-${index}`, 'roof'),
              )}
            </>
          )}
        </>
      )}
      {roomFurniture(r).map((item) => (
        <FurnitureMesh
          key={item.id}
          item={item}
          materials={
            outdoor
              ? item.palette
                ? materialSets[item.palette]
                : m
              : interiorSets[item.palette ?? r.palette ?? house.palette]
          }
          selected={selection?.roomId === r.id && selection.furnitureId === item.id}
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
      {selected && (
        <>
          {(!selection || (selection.surface === 'room' && !selection.furnitureId)) && (
            <mesh position={[0, 0.03, 0]} rotation={[-Math.PI / 2, 0, 0]}>
              <planeGeometry args={[r.width, r.depth]} />
              <meshBasicMaterial color="#b87f45" transparent opacity={0.19} depthWrite={false} />
            </mesh>
          )}
          <RoomLabel room={r} selection={selection} />
        </>
      )}
    </group>
  );
}
/** A plain projected label avoids a nested React DOM root inside the canvas.
 * Its owner removes the element synchronously without unmounting another root. */
function RoomLabel({ room, selection }: { room: Room; selection?: DesignSelection | null }) {
  const { gl, camera, size, invalidate } = useThree();
  const label = useRef<HTMLDivElement | null>(null);
  const point = useMemo(() => new THREE.Vector3(), []);
  useEffect(() => {
    const element = document.createElement('div');
    element.className = 'room-label';
    Object.assign(element.style, {
      position: 'absolute',
      left: '0',
      top: '0',
      pointerEvents: 'none',
      zIndex: '2',
    });
    const surface =
      selection?.roomId === room.id && selection.surface !== 'room'
        ? ` · ${selection.surface}`
        : '';
    element.append(document.createTextNode(room.name + surface));
    const dimensions = document.createElement('span');
    dimensions.textContent = `${room.width} × ${room.depth} m`;
    element.append(dimensions);
    gl.domElement.parentElement?.append(element);
    label.current = element;
    invalidate();
    return () => {
      label.current = null;
      element.remove();
    };
  }, [
    gl,
    room.id,
    room.name,
    room.width,
    room.depth,
    selection?.roomId,
    selection?.surface,
    invalidate,
  ]);
  useFrame(() => {
    if (!label.current) return;
    camera.updateMatrixWorld();
    point.set(room.x, room.elevation + room.height + 0.8, room.z).project(camera);
    label.current.style.display = point.z < -1 || point.z > 1 ? 'none' : '';
    label.current.style.transform = `translate(-50%, -50%) translate(${((point.x + 1) * size.width) / 2}px, ${((1 - point.y) * size.height) / 2}px)`;
  }, 0.5);
  return null;
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
  const { scene, gl, invalidate } = useThree();
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
    const data = daylightSkyPixels(light);
    const tex = new THREE.DataTexture(data, 512, 256, THREE.RGBAFormat, THREE.FloatType);
    tex.mapping = THREE.EquirectangularReflectionMapping;
    tex.needsUpdate = true;
    scene.environment = tex;
    scene.background = new THREE.Color(
      light === 'evening' ? '#9ba8bb' : light === 'golden' ? '#e6ded2' : '#d5e0e9',
    );
    scene.environmentIntensity = 0.8;
    const previousExposure = gl.toneMappingExposure;
    gl.toneMappingExposure = 1.05;
    gl.shadowMap.needsUpdate = true;
    invalidate();
    // Three replaces its PMREM cache on context restoration. Dispose source
    // textures while old target callbacks still belong to the lost context.
    const lost = () => tex.dispose();
    gl.domElement.addEventListener('webglcontextlost', lost);
    return () => {
      gl.domElement.removeEventListener('webglcontextlost', lost);
      scene.environment = null;
      gl.toneMappingExposure = previousExposure;
      tex.dispose();
    };
  }, [scene, gl, light, invalidate]);
  return (
    <>
      <directionalLight
        position={[
          lighting.target.position.x - 30,
          light === 'golden' ? 24 : 48,
          lighting.target.position.z + 20,
        ]}
        target={lighting.target}
        intensity={light === 'evening' ? 0.4 : 3.2}
        color={light === 'golden' ? '#ffe1b7' : '#fff9ef'}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-lighting.extent}
        shadow-camera-right={lighting.extent}
        shadow-camera-top={lighting.extent}
        shadow-camera-bottom={-lighting.extent}
        shadow-camera-far={150}
        shadow-bias={-0.0002}
        shadow-normalBias={0.012}
        shadow-radius={2}
      />
    </>
  );
}
export function Site({ house, quality }: { house: Scene; quality: Quality }) {
  const texture = useMemo(() => makeSurfaceTextures('ground'), []);
  const geometry = useMemo(() => {
    const geo = new THREE.PlaneGeometry(180, 180, 180, 180);
    geo.rotateX(-Math.PI / 2);
    const p = geo.attributes.position;
    for (let i = 0; i < p.count; i++) p.setY(i, terrainHeight(house, p.getX(i), p.getZ(i)));
    geo.computeVertexNormals();
    return physicalUvs(geo);
  }, [house.slope, house.rooms]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  useEffect(() => () => Object.values(texture).forEach((map) => map.dispose()), [texture]);
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
          color={quality === 'clay' ? '#c6c4b9' : '#858b68'}
          {...(quality === 'clay' || quality === 'wireframe' ? {} : texture)}
          normalScale={new THREE.Vector2(0.8, 0.8)}
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
  light = 'day',
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
> & { light?: Light }) {
  const surfaceQuality = quality === 'clay' || quality === 'wireframe' ? quality : 'live';
  const { gl, invalidate } = useThree();
  const daylightKey = JSON.stringify({
    palette: house.palette,
    roof: house.roof,
    roofPitch: house.roofPitch,
    roofDirection: house.roofDirection,
    stairs: house.stairs,
    rooms: house.rooms.map(({ name, furniture, ...room }) => room),
    design: { connections: house.design?.connections, stairLinks: house.design?.stairLinks },
  });
  const environments = useMemo(() => {
    const start = performance.now();
    const field = roomDaylightField(house, light);
    const fallback = roomEnvironmentTexture(new Float32Array(128 * 64 * 4).fill(1));
    const maps = new Map<string, THREE.Texture>();
    const intensities = new Map<string, number>();
    for (const room of house.rooms) {
      if (['terrace', 'courtyard'].includes(room.kind)) continue;
      intensities.set(
        room.id,
        maps.size < ROOM_MAP_LIMIT ? 1 : roomDaylightFallback(house, room, field),
      );
      maps.set(
        room.id,
        maps.size < ROOM_MAP_LIMIT
          ? roomEnvironmentTexture(cachedRoomDaylightPixels(house, room, light, field, daylightKey))
          : fallback,
      );
    }
    return { maps, intensities, fallback, milliseconds: performance.now() - start };
  }, [daylightKey, light]);
  useEffect(() => {
    gl.domElement.dataset.roomEnvironmentCount = String(
      Math.min(environments.maps.size, ROOM_MAP_LIMIT),
    );
    gl.domElement.dataset.roomEnvironmentBuildMs = environments.milliseconds.toFixed(1);
    invalidate();
    const release = () =>
      new Set([...environments.maps.values(), environments.fallback]).forEach((texture) =>
        texture.dispose(),
      );
    gl.domElement.addEventListener('webglcontextlost', release);
    return () => {
      gl.domElement.removeEventListener('webglcontextlost', release);
      release();
    };
  }, [environments, gl, invalidate]);

  const textures = useMemo(
    () =>
      Object.fromEntries(
        (['timber', 'oak', 'plaster', 'concrete', 'linen', 'rug', 'metal'] as SurfaceKind[]).map(
          (kind) => [kind, makeSurfaceTextures(kind)],
        ),
      ),
    [],
  );
  useEffect(
    () => () =>
      Object.values(textures).forEach((set) => Object.values(set).forEach((map) => map.dispose())),
    [textures],
  );
  const materialSets = useMemo(
    () =>
      Object.fromEntries(
        (Object.keys(palettes) as Palette[]).map((palette) => {
          const p = palettes[palette];
          const wireframe = surfaceQuality === 'wireframe',
            clay = surfaceQuality === 'clay';
          const mat = (color: string, roughness = 0.8, surface?: SurfaceKind, bumpScale = 0.002) =>
            new THREE.MeshStandardMaterial({
              color: clay ? '#e0dcd1' : color,
              roughness,
              wireframe,
              ...(surface && !clay && !wireframe
                ? {
                    ...textures[surface],
                    normalScale: new THREE.Vector2(bumpScale / 0.003, bumpScale / 0.003),
                  }
                : {}),
            });
          const fabricColor = {
            chalk: '#ddd7cb',
            limestone: '#c9bfaa',
            cedar: '#c5b6a0',
            charcoal: '#515958',
          }[palette];
          const textile = (color: string) =>
            new THREE.MeshPhysicalMaterial({
              color: clay ? '#e0dcd1' : color,
              roughness: 1,
              wireframe,
              ...(clay || wireframe
                ? {}
                : {
                    ...textures.linen,
                    normalScale: new THREE.Vector2(0.12, 0.12),
                    sheen: 0.28,
                    sheenRoughness: 0.85,
                    sheenColor: new THREE.Color(color).lerp(new THREE.Color('white'), 0.2),
                  }),
            });
          const glass =
            clay || wireframe
              ? mat('#cad8d3', 0.2)
              : new THREE.MeshPhysicalMaterial({
                  color: '#f4f8f8',
                  roughness: 0.025,
                  metalness: 0,
                  transparent: true,
                  opacity: 0.12,
                  transmission: 0,
                  thickness: 0.024,
                  ior: 1.5,
                  depthWrite: false,
                  envMapIntensity: 1.2,
                  side: THREE.DoubleSide,
                });
          return [
            palette,
            {
              wall: mat(
                p.wall,
                1,
                palette === 'cedar' || palette === 'charcoal' ? 'timber' : 'plaster',
                0.003,
              ),
              wood: new THREE.MeshPhysicalMaterial({
                color: clay ? '#e0dcd1' : p.wood,
                roughness: 0.72,
                wireframe,
                ...(clay || wireframe
                  ? {}
                  : {
                      ...textures.oak,
                      normalScale: new THREE.Vector2(0.5, 0.5),
                      clearcoat: 0.16,
                      clearcoatRoughness: 0.4,
                    }),
              }),
              trim: mat(p.wood, 0.7, 'oak', 0.001),
              floor: mat(p.floor, 0.9, palette === 'charcoal' ? 'concrete' : 'oak', 0.003),
              roof: mat(p.roof, 0.8, 'metal', 0.012),
              frame: new THREE.MeshStandardMaterial({
                color: clay ? '#e0dcd1' : p.accent,
                roughness: 0.34,
                metalness: clay ? 0 : 0.55,
                wireframe,
              }),
              foundation: mat('#a4a19b', 1, 'concrete', 0.006),
              deck: mat('#b6a185', 1, 'oak', 0.006),
              fabric: textile(fabricColor),
              seam: textile(new THREE.Color(fabricColor).multiplyScalar(0.85).getStyle()),
              accentFabric: textile(palette === 'charcoal' ? '#a89b82' : '#998870'),
              rug: mat(palette === 'charcoal' ? '#8c9089' : '#b8ac97', 1, 'rug', 0.0025),
              rugEdge: mat('#8f8575', 1, 'rug', 0.001),
              ceramic: mat('#edede7', 0.18),
              basin: mat('#a5afad', 0.16),
              worktop: mat('#dfddd3', 0.42, 'concrete', 0.0005),
              chrome: new THREE.MeshStandardMaterial({
                color: clay ? '#e0dcd1' : '#c4c9cb',
                metalness: clay ? 0 : 0.95,
                roughness: 0.2,
                wireframe,
              }),
              glass,
            },
          ];
        }),
      ),
    [surfaceQuality, textures],
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
          roomEnvironment={surfaceQuality === 'live' ? environments.maps.get(r.id) : undefined}
          roomEnvironmentIntensity={environments.intensities.get(r.id)}
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
  const { camera, gl, invalidate } = useThree();
  const pressed = useRef(new Set<string>());
  const report = useRef(onCameraChange);
  report.current = onCameraChange;
  const lastReport = useRef<number[]>([]);
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
    invalidate();
  }, [view, resetKey, camera, house.rooms.length === 0, invalidate]);
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
      invalidate();
    };
    const down = (e: KeyboardEvent) => {
      if (document.pointerLockElement === canvas) {
        pressed.current.add(e.code);
        invalidate();
      }
    };
    const up = (e: KeyboardEvent) => {
      pressed.current.delete(e.code);
      invalidate();
    };
    const blur = () => {
      pressed.current.clear();
      invalidate();
    };
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
  }, [view, camera, gl, invalidate]);
  useFrame((_, delta) => {
    if (view !== 'walk' || document.pointerLockElement !== gl.domElement) return;
    if (!['KeyW', 'KeyS', 'KeyA', 'KeyD', 'KeyE', 'KeyQ'].some((key) => pressed.current.has(key)))
      return;
    invalidate();
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
  useFrame(() => {
    if (!report.current) return;
    const target =
      view === 'orbit' && controls.current
        ? controls.current.target
        : camera.getWorldDirection(new THREE.Vector3()).multiplyScalar(5).add(camera.position);
    const position = camera.position.toArray() as [number, number, number];
    const focus = target.toArray() as [number, number, number];
    const coordinates = [...position, ...focus];
    if (
      !coordinates.some(
        (value, index) => Math.abs(value - (lastReport.current[index] ?? Infinity)) > 0.001,
      )
    )
      return;
    lastReport.current = coordinates;
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
/** Immediate PBR rendering: camera motion spends its budget on geometry;
 * contact shading is drawn once after motion settles, then the canvas sleeps. */
function InteractiveRenderer({
  house,
  quality,
  sceneKey,
  light,
  onStatus,
}: {
  house: Scene;
  quality: Quality;
  sceneKey: string;
  light: Light;
  onStatus: (text: string) => void;
}) {
  const { gl, scene, camera, size, invalidate, setDpr } = useThree();
  const raster = useRef<RasterRenderer | null>(null);
  const activity = useRef(new RenderActivity());
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const contextLost = useRef(false);
  const frames = useRef(0),
    shadowUpdates = useRef(0),
    aoFrames = useRef(0);
  const status = useRef('');
  const current = useRef({ quality, onStatus });
  current.current = { quality, onStatus };
  const rendererName = useMemo(() => {
    const context = gl.getContext();
    const extension = context.getExtension('WEBGL_debug_renderer_info');
    return extension ? String(context.getParameter(extension.UNMASKED_RENDERER_WEBGL)) : '';
  }, [gl]);
  const budget = rasterBudget(
    rendererName,
    size.width,
    size.height,
    window.devicePixelRatio || 1,
    quality === 'refined',
  );
  useEffect(() => {
    setDpr(budget.dpr);
    invalidate();
  }, [budget.dpr, setDpr, invalidate]);
  const report = (text: string) => {
    if (status.current === text) return;
    status.current = text;
    current.current.onStatus(text);
  };
  useEffect(() => {
    const previousAutoUpdate = gl.shadowMap.autoUpdate;
    gl.shadowMap.autoUpdate = false;
    gl.shadowMap.needsUpdate = true;
    raster.current = new RasterRenderer(gl, scene, camera);
    const lost = (event: Event) => {
      event.preventDefault();
      contextLost.current = true;
      // Release pass handles while their context is lost. Disposing them after
      // restoration would send stale WebGL handles to the new context.
      raster.current?.dispose();
      raster.current = null;
      gl.domElement.dataset.renderStatus = 'context-lost';
      report('Graphics context lost · waiting to restore');
    };
    const restored = () => {
      contextLost.current = false;
      raster.current = new RasterRenderer(gl, scene, camera);
      gl.shadowMap.autoUpdate = false;
      gl.shadowMap.needsUpdate = true;
      activity.current = new RenderActivity();
      delete gl.domElement.dataset.renderError;
      invalidate();
    };
    gl.domElement.addEventListener('webglcontextlost', lost);
    gl.domElement.addEventListener('webglcontextrestored', restored);
    invalidate();
    return () => {
      if (settleTimer.current !== null) clearTimeout(settleTimer.current);
      raster.current?.dispose();
      raster.current = null;
      gl.shadowMap.autoUpdate = previousAutoUpdate;
      gl.domElement.removeEventListener('webglcontextlost', lost);
      gl.domElement.removeEventListener('webglcontextrestored', restored);
    };
  }, [gl, scene, camera, invalidate]);
  useEffect(() => {
    gl.shadowMap.needsUpdate = true;
    invalidate();
  }, [gl, sceneKey, light, quality, invalidate]);
  useFrame(() => {
    if (contextLost.current || gl.getContext().isContextLost() || !raster.current) return;
    const now = performance.now();
    camera.updateMatrixWorld();
    const changed = activity.current.observe(
      [...camera.matrixWorld.elements, ...camera.projectionMatrix.elements],
      now,
    );
    if (changed) {
      if (settleTimer.current !== null) clearTimeout(settleTimer.current);
      settleTimer.current = setTimeout(() => {
        settleTimer.current = null;
        invalidate();
      }, 130);
    }
    const moving = activity.current.moving(now);
    const contact = quality !== 'wireframe' && !moving;
    gl.toneMappingExposure = interiorExposure(house, camera.position);
    const refreshShadow = gl.shadowMap.needsUpdate;
    const autoReset = gl.info.autoReset;
    gl.info.autoReset = false;
    gl.info.reset();
    let shaded = false;
    try {
      shaded = raster.current.render(contact, budget.aoPixels);
    } finally {
      gl.info.autoReset = autoReset;
    }
    frames.current++;
    if (refreshShadow) shadowUpdates.current++;
    if (shaded) aoFrames.current++;
    Object.assign(gl.domElement.dataset, {
      renderMode: 'realtime',
      renderStatus: 'ready',
      renderFrames: String(frames.current),
      renderDrawCalls: String(gl.info.render.calls),
      renderTriangles: String(gl.info.render.triangles),
      renderShadowUpdates: String(shadowUpdates.current),
      renderAoFrames: String(aoFrames.current),
      renderAo: moving ? 'moving' : shaded ? 'on' : contact ? 'unavailable' : 'off',
      renderDpr: String(gl.getPixelRatio()),
      renderTextures: String(gl.info.memory.textures),
      renderGeometries: String(gl.info.memory.geometries),
    });
    report(
      quality === 'refined'
        ? 'Presentation · ready'
        : quality === 'clay'
          ? 'Clay · ready'
          : quality === 'wireframe'
            ? 'Wireframe · ready'
            : 'Live · ready',
    );
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
        frameloop="demand"
        dpr={1}
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
          <InteractiveRenderer
            house={props.house}
            quality={props.quality}
            sceneKey={sceneKey}
            light={props.light}
            onStatus={props.onRenderStatus}
          />
        </Suspense>
      </Canvas>
    </CanvasError>
  );
}
