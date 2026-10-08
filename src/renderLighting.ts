import * as THREE from 'three';
import type { Scene } from '../shared/model';
import { roofHeightAt } from '../shared/architecture';
import { roomSlabs } from './renderGeometry';

/** Equirectangular typed textures have v=0 at the south pole. Keep the radiance
 * calculation independent from the canvas so this convention stays testable. */
export function daylightSkyPixels(light: 'day' | 'golden' | 'evening', width = 512, height = 256) {
  const data = new Float32Array(width * height * 4);
  const zenith = new THREE.Color(light === 'evening' ? '#566988' : '#b4cbe4');
  const horizon = new THREE.Color(light === 'golden' ? '#f7dfc4' : '#e5e9ec');
  const earth = new THREE.Color('#7d817d');
  const sun = new THREE.Vector3(-30, light === 'golden' ? 24 : 48, 20).normalize();
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
        color.multiplyScalar((light === 'evening' ? 0.45 : 2.4) + glow);
      } else color.copy(earth).multiplyScalar(0.55);
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
/** Adapt at the exterior of the enclosed union, so internal room boundaries
 * never cause an exposure pulse. Axis intervals also retain courtyards/gaps. */
export function interiorExposure(house: Scene, position: THREE.Vector3) {
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
  return 1.05 * (1 + THREE.MathUtils.smoothstep(depth, 0, 0.7));
}
