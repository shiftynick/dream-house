import * as THREE from 'three';
import { palettes, type Room, type Scene, type Side } from '../shared/model';
import { roomOpenings } from '../shared/openings';
import { roofHeightAt } from '../shared/architecture';
import { surfacePalette } from '../shared/selection';
import { roomSlabs, roofPatches, wallAxis, wallPanels } from './renderGeometry';
import { daylightSkyPixels } from './renderLighting';

type Light = 'day' | 'golden' | 'evening';
type Patch = {
  normal: THREE.Vector3;
  distance: number;
  contains: (p: THREE.Vector3) => boolean;
  color: THREE.Color;
  outwardSign: number;
};
type ApertureSample = { position: THREE.Vector3; normal: THREE.Vector3; area: number };
const sides: Side[] = ['north', 'south', 'east', 'west'];
const enclosed = (room: Room) => !['terrace', 'courtyard'].includes(room.kind);
export const ROOM_MAP_LIMIT = 8;
export const ROOM_MAP_WIDTH = 128;
export const ROOM_MAP_HEIGHT = 64;

/** Architectural visibility only: these patches reuse the same slab/opening
 * contracts as the meshes. Furniture never becomes a fictitious light source. */
export function roomDaylightField(house: Scene, light: Light) {
  const patches: Patch[] = [];
  const apertures: ApertureSample[] = [];
  for (const room of house.rooms) {
    if (!enclosed(room)) continue;
    const slabs = roomSlabs(house, room);
    for (const side of sides) {
      const axis = wallAxis(room, side);
      const normal = new THREE.Vector3(axis.horizontal ? 0 : 1, 0, axis.horizontal ? 1 : 0);
      const outwardSign = side === 'north' || side === 'west' ? -1 : 1;
      const color = new THREE.Color(palettes[surfacePalette(house, room, side)].wall);
      const openings = roomOpenings(house, room.id, side);
      const transparentWall = room[side] === 'glass' && !openings.length;
      const panels = wallPanels(house, room, side, false);
      const localOffset = (p: THREE.Vector3) => (axis.horizontal ? p.x - room.x : p.z - room.z);
      if (!transparentWall) {
        for (const panel of panels)
          patches.push({
            normal,
            distance: axis.boundary,
            color,
            outwardSign,
            contains: (p) =>
              Math.abs(localOffset(p) - panel.offset) <= panel.width / 2 + 1e-5 &&
              p.y >= room.elevation + panel.bottom - 1e-5 &&
              p.y <= room.elevation + panel.bottom + panel.height + 1e-5,
          });
        if (!slabs.roofClipped && (room[side] !== 'open' || openings.length))
          patches.push({
            normal,
            distance: axis.boundary,
            color,
            outwardSign,
            contains: (p) =>
              Math.abs(localOffset(p)) <= axis.length / 2 + 1e-5 &&
              p.y > room.elevation + room.height &&
              p.y <= roofHeightAt(house, room, p.x, p.z) + 1e-5 &&
              !openings.some(
                (o) =>
                  Math.abs(localOffset(p) - o.offset) < o.width / 2 &&
                  p.y > room.elevation + o.sill &&
                  p.y < room.elevation + o.sill + o.height,
              ),
          });
      }
      // Complementary wall rectangles include explicit, legacy and full-wall
      // apertures. Only exterior-facing samples collect outdoor sky; shared
      // portals are traversed by visibility rather than counted twice.
      const cuts =
        transparentWall || (room[side] === 'open' && !openings.length)
          ? [{ offset: 0, sill: 0, width: axis.length, height: room.height }]
          : openings.length
            ? openings
            : room[side] === 'door'
              ? [
                  {
                    offset: 0,
                    sill: 0,
                    width: Math.min(1.3, axis.length),
                    height: Math.min(2.4, room.height),
                  },
                ]
              : [];
      const outward = normal.clone().multiplyScalar(side === 'north' || side === 'west' ? -1 : 1);
      for (const opening of cuts)
        for (const u of [-0.29, 0.29])
          for (const v of [0.21, 0.79]) {
            const along = axis.center + opening.offset + opening.width * u;
            const position = new THREE.Vector3(
              axis.horizontal ? along : axis.boundary,
              room.elevation + opening.sill + opening.height * v,
              axis.horizontal ? axis.boundary : along,
            );
            const outside = position.clone().addScaledVector(outward, 0.04);
            if (
              house.rooms.some(
                (other) =>
                  other.id !== room.id &&
                  enclosed(other) &&
                  Math.abs(outside.x - other.x) < other.width / 2 &&
                  Math.abs(outside.z - other.z) < other.depth / 2 &&
                  outside.y >= other.elevation &&
                  outside.y < roofHeightAt(house, other, outside.x, outside.z),
              )
            )
              continue;
            apertures.push({
              position,
              normal: outward,
              area: (opening.width * opening.height) / 4,
            });
          }
    }
    for (const rect of slabs.floor)
      patches.push({
        normal: new THREE.Vector3(0, 1, 0),
        distance: room.elevation,
        outwardSign: -1,
        color: new THREE.Color(palettes[surfacePalette(house, room, 'floor')].floor),
        contains: (p) =>
          p.x >= rect.minX && p.x <= rect.maxX && p.z >= rect.minZ && p.z <= rect.maxZ,
      });
    for (const rect of roofPatches(house, room)) {
      const y = (x: number, z: number) =>
        slabs.roofClipped ? room.elevation + room.height : roofHeightAt(house, room, x, z);
      const a = new THREE.Vector3(rect.minX, y(rect.minX, rect.minZ), rect.minZ);
      const dx = new THREE.Vector3(rect.maxX, y(rect.maxX, rect.minZ), rect.minZ).sub(a);
      const dz = new THREE.Vector3(rect.minX, y(rect.minX, rect.maxZ), rect.maxZ).sub(a);
      const normal = new THREE.Vector3().crossVectors(dz, dx).normalize();
      patches.push({
        normal,
        distance: normal.dot(a),
        outwardSign: 1,
        color: new THREE.Color(palettes[surfacePalette(house, room, 'roof')].wood),
        contains: (p) =>
          p.x >= rect.minX && p.x <= rect.maxX && p.z >= rect.minZ && p.z <= rect.maxZ,
      });
    }
  }
  const hitPoint = new THREE.Vector3();
  const firstHit = (origin: THREE.Vector3, direction: THREE.Vector3) => {
    let nearest = Infinity,
      hit: Patch | undefined;
    for (const patch of patches) {
      const dot = patch.normal.dot(direction);
      if (Math.abs(dot) < 1e-7) continue;
      const distance = (patch.distance - patch.normal.dot(origin)) / dot;
      if (distance <= 0.00001 || distance > nearest + 1e-5) continue;
      if (hit && Math.abs(distance - nearest) <= 1e-5 && dot * patch.outwardSign <= 0) continue;
      hitPoint.copy(origin).addScaledVector(direction, distance);
      if (patch.contains(hitPoint)) {
        nearest = distance;
        hit = patch;
      }
    }
    return hit ? { patch: hit, distance: nearest } : null;
  };
  const sky = daylightSkyPixels(light, ROOM_MAP_WIDTH, ROOM_MAP_HEIGHT);
  const skyColor = (direction: THREE.Vector3, output: THREE.Color) => {
    const u = (Math.atan2(direction.z, direction.x) / (2 * Math.PI) + 1.5) % 1;
    const v = 1 - Math.acos(THREE.MathUtils.clamp(direction.y, -1, 1)) / Math.PI;
    const i =
      (Math.min(ROOM_MAP_HEIGHT - 1, Math.round(v * (ROOM_MAP_HEIGHT - 1))) * ROOM_MAP_WIDTH +
        Math.floor(u * ROOM_MAP_WIDTH)) *
      4;
    return output.setRGB(sky[i], sky[i + 1], sky[i + 2]);
  };
  return { patches, apertures, firstHit, skyColor };
}

/** A bounded deterministic angular projection, with one diffuse surface return.
 * This is a center-of-room approximation, not progressive GI or a scene capture.
 * No light reaches a sealed room: every source must see an exterior aperture. */
export function roomDaylightPixels(
  house: Scene,
  room: Room,
  light: Light,
  field = roomDaylightField(house, light),
) {
  const pixels = new Float32Array(ROOM_MAP_WIDTH * ROOM_MAP_HEIGHT * 4);
  const origin = new THREE.Vector3(
    room.x,
    room.elevation + Math.min(0.75, room.height * 0.3),
    room.z,
  );
  const direction = new THREE.Vector3(),
    point = new THREE.Vector3(),
    normal = new THREE.Vector3();
  const sourceDirection = new THREE.Vector3(),
    color = new THREE.Color(),
    incoming = new THREE.Color();
  const sun = new THREE.Vector3(-30, light === 'golden' ? 24 : 48, 20).normalize();
  const sunColor = new THREE.Color(light === 'golden' ? '#ffe1b7' : '#fff9ef');
  const sources = [...field.apertures]
    .sort(
      (a, b) =>
        a.position.distanceToSquared(origin) / a.area -
        b.position.distanceToSquared(origin) / b.area,
    )
    .slice(0, 64);
  // Complex oversized scenes use a dark conservative fallback, never outdoor
  // ambient through opaque walls. This caps CPU edit work as well as GPU maps.
  const supported = field.patches.length <= 512;
  const diffuseCache = new Map<Patch, Map<string, THREE.Color>>();
  const solid = new Uint8Array(ROOM_MAP_WIDTH * ROOM_MAP_HEIGHT);
  for (let y = 0; y < ROOM_MAP_HEIGHT; y++)
    for (let x = 0; x < ROOM_MAP_WIDTH; x++) {
      const theta = (1 - y / (ROOM_MAP_HEIGHT - 1)) * Math.PI;
      const phi = (x / ROOM_MAP_WIDTH - 0.5) * 2 * Math.PI;
      direction.set(
        Math.sin(theta) * Math.cos(phi),
        Math.cos(theta),
        Math.sin(theta) * Math.sin(phi),
      );
      color.setRGB(0, 0, 0);
      const hit = supported ? field.firstHit(origin, direction) : null;
      if (supported && !hit) field.skyColor(direction, color);
      else if (hit) {
        point.copy(origin).addScaledVector(direction, hit.distance);
        normal.copy(hit.patch.normal).multiplyScalar(hit.patch.normal.dot(direction) < 0 ? 1 : -1);
        point.addScaledVector(normal, 0.015);
        const key = `${Math.round(point.x * 3)},${Math.round(point.y * 3)},${Math.round(point.z * 3)}`;
        let cache = diffuseCache.get(hit.patch);
        if (!cache) {
          cache = new Map();
          diffuseCache.set(hit.patch, cache);
        }
        const cached = cache.get(key);
        if (cached) color.copy(cached);
        else {
          for (const source of sources) {
            sourceDirection.copy(source.position).sub(point);
            const distanceSquared = sourceDirection.lengthSq();
            sourceDirection.normalize();
            const cosine = Math.max(0, normal.dot(sourceDirection));
            const facing = Math.max(0, source.normal.dot(sourceDirection));
            if (cosine < 0.001 || facing < 0.001 || field.firstHit(point, sourceDirection))
              continue;
            // Area quadrature of incident sky, with a bounded near-field solid angle.
            const weight =
              (Math.min(1.5, (source.area * facing) / Math.max(0.04, distanceSquared)) * cosine) /
              Math.PI;
            color.add(field.skyColor(sourceDirection, incoming).multiplyScalar(weight));
          }
          const sunCosine = Math.max(0, normal.dot(sun));
          if (sunCosine > 0 && !field.firstHit(point, sun))
            color.add(
              incoming
                .copy(sunColor)
                .multiplyScalar((sunCosine * (light === 'evening' ? 0.4 : 3.2)) / Math.PI),
            );
          color.multiply(hit.patch.color);
          cache.set(key, color.clone());
        }
        solid[y * ROOM_MAP_WIDTH + x] = 1;
      }
      const i = (y * ROOM_MAP_WIDTH + x) * 4;
      pixels[i] = color.r;
      pixels[i + 1] = color.g;
      pixels[i + 2] = color.b;
      pixels[i + 3] = 1;
    }
  // Lumped diffuse cavity return: the measured angular field supplies the
  // incoming energy; finite wall/floor reflectance bounds subsequent diffuse
  // interreflection. It is identically zero without a visible light source.
  const reflectance = roomReflectance(house, room);
  const mean = new THREE.Color(0, 0, 0);
  let weight = 0;
  for (let y = 0; y < ROOM_MAP_HEIGHT; y++) {
    const solidAngle = Math.sin((y / (ROOM_MAP_HEIGHT - 1)) * Math.PI);
    for (let x = 0; x < ROOM_MAP_WIDTH; x++) {
      const i = (y * ROOM_MAP_WIDTH + x) * 4;
      mean.r += pixels[i] * solidAngle;
      mean.g += pixels[i + 1] * solidAngle;
      mean.b += pixels[i + 2] * solidAngle;
      weight += solidAngle;
    }
  }
  mean.multiplyScalar(1 / Math.max(1, weight));
  mean.setRGB(
    (mean.r * reflectance.r) / (1 - reflectance.r),
    (mean.g * reflectance.g) / (1 - reflectance.g),
    (mean.b * reflectance.b) / (1 - reflectance.b),
  );
  for (let i = 0; i < pixels.length; i += 4)
    if (solid[i / 4]) {
      pixels[i] += mean.r;
      pixels[i + 1] += mean.g;
      pixels[i + 2] += mean.b;
    }
  return pixels;
}

function roomReflectance(house: Scene, room: Room) {
  const floorArea = room.width * room.depth;
  const totalArea = 2 * (room.width + room.depth) * room.height + 2 * floorArea;
  const result = new THREE.Color(palettes[surfacePalette(house, room, 'floor')].floor)
    .multiplyScalar(floorArea)
    .add(
      new THREE.Color(palettes[surfacePalette(house, room, 'roof')].wood).multiplyScalar(floorArea),
    );
  for (const side of sides) {
    const area =
      room[side] === 'glass' && !roomOpenings(house, room.id, side).length
        ? 0
        : wallPanels(house, room, side, false).reduce(
            (sum, panel) => sum + panel.width * panel.height,
            0,
          );
    result.add(
      new THREE.Color(palettes[surfacePalette(house, room, side)].wall).multiplyScalar(area),
    );
  }
  // Openings have zero reflectance in this cavity balance: energy can escape.
  result.multiplyScalar(0.9 / totalArea);
  return result.setRGB(
    Math.min(0.75, result.r),
    Math.min(0.75, result.g),
    Math.min(0.75, result.b),
  );
}

/** Bounded fallback for rooms beyond the directional-map budget. The shared
 * neutral map is scaled only by visible real apertures, so ninth rooms are
 * usable and sealed rooms stay dark without allocating another PMREM. */
export function roomDaylightFallback(
  house: Scene,
  room: Room,
  field: ReturnType<typeof roomDaylightField>,
) {
  if (field.patches.length > 512) return 0;
  const origin = new THREE.Vector3(
    room.x,
    room.elevation + Math.min(0.75, room.height * 0.3),
    room.z,
  );
  const direction = new THREE.Vector3(),
    color = new THREE.Color();
  let energy = 0;
  const sources = [...field.apertures]
    .sort(
      (a, b) =>
        a.position.distanceToSquared(origin) / a.area -
        b.position.distanceToSquared(origin) / b.area,
    )
    .slice(0, 64);
  for (const source of sources) {
    direction.copy(source.position).sub(origin);
    const distance = direction.lengthSq();
    direction.normalize();
    const cosine = Math.max(0, source.normal.dot(direction));
    if (!cosine || field.firstHit(origin, direction)) continue;
    field.skyColor(direction, color);
    energy +=
      (((color.r + color.g + color.b) / 3) *
        Math.min(1.5, (source.area * cosine) / Math.max(0.04, distance))) /
      (4 * Math.PI);
  }
  const r = roomReflectance(house, room);
  return energy / (1 - (r.r + r.g + r.b) / 3);
}

export function roomEnvironmentTexture(pixels: Float32Array) {
  const texture = new THREE.DataTexture(
    pixels,
    ROOM_MAP_WIDTH,
    ROOM_MAP_HEIGHT,
    THREE.RGBAFormat,
    THREE.FloatType,
  );
  texture.mapping = THREE.EquirectangularReflectionMapping;
  texture.colorSpace = THREE.LinearSRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

const fieldPixelsCache = new Map<string, Float32Array>();
/** CPU-only bounded cache; GPU textures remain owned by each canvas. */
export function cachedRoomDaylightPixels(
  house: Scene,
  room: Room,
  light: Light,
  field: ReturnType<typeof roomDaylightField>,
  geometryKey: string,
) {
  const key = `${geometryKey}|${light}|${room.id}`;
  const cached = fieldPixelsCache.get(key);
  if (cached) return cached;
  const pixels = roomDaylightPixels(house, room, light, field);
  fieldPixelsCache.set(key, pixels);
  while (fieldPixelsCache.size > 24) fieldPixelsCache.delete(fieldPixelsCache.keys().next().value!);
  return pixels;
}
const harmonicsCache = new WeakMap<Float32Array, THREE.SphericalHarmonics3>();
/** Cosine-convolved diffuse uses SH, independently from GGX specular PMREM. */
export function roomIrradiance(pixels: Float32Array) {
  const cached = harmonicsCache.get(pixels);
  if (cached) return cached;
  const sh = new THREE.SphericalHarmonics3(),
    direction = new THREE.Vector3();
  const basis = new Array<number>(9).fill(0);
  let weight = 0;
  for (let y = 0; y < ROOM_MAP_HEIGHT; y++)
    for (let x = 0; x < ROOM_MAP_WIDTH; x++) {
      const theta = (1 - y / (ROOM_MAP_HEIGHT - 1)) * Math.PI,
        phi = (x / ROOM_MAP_WIDTH - 0.5) * 2 * Math.PI;
      const solidAngle = Math.sin(theta);
      weight += solidAngle;
      direction.set(
        Math.sin(theta) * Math.cos(phi),
        Math.cos(theta),
        Math.sin(theta) * Math.sin(phi),
      );
      THREE.SphericalHarmonics3.getBasisAt(direction, basis);
      const i = (y * ROOM_MAP_WIDTH + x) * 4;
      for (let j = 0; j < 9; j++) {
        const contribution = basis[j] * solidAngle;
        sh.coefficients[j].x += pixels[i] * contribution;
        sh.coefficients[j].y += pixels[i + 1] * contribution;
        sh.coefficients[j].z += pixels[i + 2] * contribution;
      }
    }
  sh.scale((4 * Math.PI) / weight);
  harmonicsCache.set(pixels, sh);
  return sh;
}

export function applyRoomIrradiance(
  material: THREE.MeshStandardMaterial,
  harmonics: THREE.SphericalHarmonics3,
  intensity = 1,
) {
  material.onBeforeCompile = (shader) => {
    // Preserve the room-owned PMREM as the conservative diffuse fallback if
    // Three changes its shader hooks. Never substitute outdoor environment.
    const chunks = THREE.ShaderChunk;
    if (
      !shader.fragmentShader.includes('#include <lights_fragment_maps>') ||
      !shader.fragmentShader.includes('#include <lights_pars_begin>') ||
      !chunks.lights_pars_begin.includes('vec3 getLightProbeIrradiance(') ||
      !chunks.lights_fragment_begin.includes('iblIrradiance') ||
      !chunks.lights_fragment_maps.includes('iblIrradiance')
    )
      return;
    shader.uniforms.roomIrradiance = { value: harmonics.coefficients };
    shader.uniforms.roomIrradianceIntensity = { value: intensity };
    shader.fragmentShader =
      'uniform vec3 roomIrradiance[9];\nuniform float roomIrradianceIntensity;\n' +
      shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <lights_fragment_maps>',
      '#include <lights_fragment_maps>\niblIrradiance = max(vec3(0.0), getLightProbeIrradiance(roomIrradiance, geometryNormal)) * roomIrradianceIntensity;',
    );
  };
  material.customProgramCacheKey = () => 'terrain-room-diffuse-v2';
}
