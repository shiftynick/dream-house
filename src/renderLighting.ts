import * as THREE from 'three';
import type { Scene } from '../shared/model';
import { roofHeightAt } from '../shared/architecture';
import { roomSlabs } from './renderGeometry';

/** Khronos PBR Neutral keeps albedo hue and saturation through the mid-tones
 * (cedar stays cedar, the fire stays orange) and has no toe, so dim rooms seen
 * through doorways keep detail; it only compresses highlights. ACES Filmic
 * crushed those rooms to black, and AgX greyed the palette. */
export const TONE_MAPPING = THREE.NeutralToneMapping;
/** Neutral is near-linear below its shoulder, so it needs less exposure than
 * ACES Filmic did for the same mid-tone brightness. */
export const TONE_EXPOSURE = 0.9;

/** The calibrated procedural sky: one model for the environment map, window
 * light through room apertures and the shader-side sky in src/roomProbes.ts. */
export function skyModel(light: 'day' | 'golden' | 'evening') {
  return {
    zenith: new THREE.Color(light === 'evening' ? '#566988' : '#b4cbe4'),
    horizon: new THREE.Color(light === 'golden' ? '#f7dfc4' : '#e5e9ec'),
    /** Ground radiance below the horizon (earth color × 0.55). */
    ground: new THREE.Color('#7d817d').multiplyScalar(0.55),
    sun: new THREE.Vector3(-30, light === 'golden' ? 24 : 48, 20).normalize(),
    scale: light === 'evening' ? 0.45 : 2.4,
  };
}

/** Equirectangular typed textures have v=0 at the south pole. Keep the radiance
 * calculation independent from the canvas so this convention stays testable. */
export function daylightSkyPixels(light: 'day' | 'golden' | 'evening', width = 512, height = 256) {
  const data = new Float32Array(width * height * 4);
  const { zenith, horizon, ground, sun, scale } = skyModel(light);
  const direction = new THREE.Vector3(),
    color = new THREE.Color();
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const theta = (1 - y / (height - 1)) * Math.PI;
      const phi = (x / width - 0.5) * Math.PI * 2;
      const altitude = Math.cos(theta);
      direction.set(Math.sin(theta) * Math.cos(phi), altitude, Math.sin(theta) * Math.sin(phi));
      if (altitude >= 0) {
        color.copy(horizon).lerp(zenith, Math.pow(altitude, 0.55));
        const glow = Math.pow(Math.max(0, direction.dot(sun)), 32) * 0.8;
        color.multiplyScalar(scale + glow);
      } else color.copy(ground);
      const i = (y * width + x) * 4;
      data[i] = color.r;
      data[i + 1] = color.g;
      data[i + 2] = color.b;
      data[i + 3] = 1;
    }
  return data;
}

const containmentCache = new WeakMap<Scene, ReturnType<typeof buildContainment>>();
function buildContainment(house: Scene) {
  return house.rooms
    .filter((room) => !['terrace', 'courtyard'].includes(room.kind))
    .map((room) => ({
      room,
      minX: room.x - room.width / 2,
      maxX: room.x + room.width / 2,
      minZ: room.z - room.depth / 2,
      maxZ: room.z + room.depth / 2,
      roofClipped: roomSlabs(house, room).roofClipped,
    }));
}
/** Scene edits replace the scene object. Slab clipping is resolved once per
 * scene, never in the animation loop. */
export function cameraContainment(house: Scene) {
  let bounds = containmentCache.get(house);
  if (!bounds) {
    bounds = buildContainment(house);
    containmentCache.set(house, bounds);
  }
  return bounds;
}
function intervalDepth(intervals: [number, number][], position: number) {
  intervals.sort((a, b) => a[0] - b[0]);
  let low = Infinity,
    high = -Infinity;
  for (const [start, end] of intervals) {
    if (start > high + 1e-5) {
      if (position >= low && position <= high) return Math.min(position - low, high - position);
      low = start;
      high = end;
    } else high = Math.max(high, end);
  }
  return position >= low && position <= high ? Math.min(position - low, high - position) : 0;
}
/** scene.environmentIntensity for outdoor surfaces (SceneView Environment). */
export const EXTERIOR_ENVIRONMENT_INTENSITY = 0.8;
export const INTERIOR_EXPOSURE = 2.1;
/** Exposure for a room from the mean luminance its bounce probe saw. Dim rooms
 * open up only partly (exponent 0.6), so they still read dimmer than bright
 * ones, as in a photograph; the clamp keeps windowless rooms from blowing out. */
export function roomExposure(luminance: number | undefined) {
  if (!luminance || !Number.isFinite(luminance)) return INTERIOR_EXPOSURE;
  return THREE.MathUtils.clamp(3.2 * Math.pow(0.048 / luminance, 0.6), 1.6, 4.5);
}
/** Blend room exposures by how far inside each room the camera is, so walking
 * through a doorway ramps exposure over about a meter on either side. */
function blendedRoomExposure(
  house: Scene,
  position: THREE.Vector3,
  luminance: Map<string, number>,
) {
  let total = 0,
    weight = 0;
  for (const { room, minX, maxX, minZ, maxZ } of cameraContainment(house)) {
    const inside = Math.min(
      position.x - minX,
      maxX - position.x,
      position.z - minZ,
      maxZ - position.z,
    );
    if (
      inside < -1 ||
      position.y < room.elevation - 0.5 ||
      position.y > room.elevation + room.height + 12
    )
      continue;
    const w = THREE.MathUtils.smoothstep(inside, -1, 1);
    total += w * roomExposure(luminance.get(room.id));
    weight += w;
  }
  return weight > 0 ? total / weight : INTERIOR_EXPOSURE;
}
/** Adapt at the exterior of the enclosed union, so internal room boundaries
 * never cause an exposure pulse. Axis intervals also retain courtyards/gaps.
 * With measured room luminance, indoor exposure follows the current room. */
export function interiorExposure(
  house: Scene,
  position: THREE.Vector3,
  luminance?: Map<string, number>,
) {
  return exposureAt(house, position, luminance).exposure;
}
/** Tone-mapping exposure plus what local exposure needs: the indoor exposure
 * around the camera and how far indoors it is (0 outside, 1 inside). */
export function exposureAt(house: Scene, position: THREE.Vector3, luminance?: Map<string, number>) {
  const xs: [number, number][] = [],
    zs: [number, number][] = [],
    ys: [number, number][] = [];
  for (const bounds of cameraContainment(house)) {
    const { room, minX, maxX, minZ, maxZ, roofClipped } = bounds;
    const ceiling = roofClipped
      ? room.elevation + room.height
      : roofHeightAt(house, room, position.x, position.z);
    const inX = position.x >= minX - 1e-5 && position.x <= maxX + 1e-5;
    const inZ = position.z >= minZ - 1e-5 && position.z <= maxZ + 1e-5;
    if (inX && inZ) ys.push([room.elevation, ceiling]);
    if (position.y < room.elevation || position.y > ceiling) continue;
    if (inZ) xs.push([minX, maxX]);
    if (inX) zs.push([minZ, maxZ]);
  }
  const depth = Math.min(
    intervalDepth(xs, position.x),
    intervalDepth(zs, position.z),
    intervalDepth(ys, position.y),
  );
  const interior = luminance ? blendedRoomExposure(house, position, luminance) : INTERIOR_EXPOSURE;
  const inside = THREE.MathUtils.smoothstep(depth, 0, 0.7);
  return { exposure: TONE_EXPOSURE * (1.05 + (interior - 1.05) * inside), interior, inside };
}
