import * as THREE from 'three';
import type { Rect } from './renderGeometry';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/** Project a coherent pair of axes in meters. An origin anchors separate
 * architectural pieces to the same texture, while furniture stays local. */
export function physicalUvs(
  geometry: THREE.BufferGeometry,
  origin: [number, number, number] = [0, 0, 0],
) {
  const position = geometry.getAttribute('position');
  const normal = geometry.getAttribute('normal');
  const uv = new Float32Array(position.count * 2);
  for (let index = 0; index < position.count; index++) {
    const x = Math.abs(normal.getX(index)),
      y = Math.abs(normal.getY(index)),
      z = Math.abs(normal.getZ(index));
    const acrossX = x > y && x > z;
    uv[index * 2] = acrossX ? position.getZ(index) + origin[2] : position.getX(index) + origin[0];
    uv[index * 2 + 1] =
      !acrossX && y > z ? position.getZ(index) + origin[2] : position.getY(index) + origin[1];
  }
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return geometry;
}

/** A closed, thin roof/foundation shell with independently sloped top/bottom.
 * Geometry is room-local; height functions consume world x/z. */
export function slabGeometry(
  rect: Rect,
  origin: [number, number, number],
  top: (x: number, z: number) => number,
  bottom: (x: number, z: number) => number,
  roofTextureAxis?: 'x' | 'z',
) {
  const corners = [
    [rect.minX, rect.minZ],
    [rect.maxX, rect.minZ],
    [rect.maxX, rect.maxZ],
    [rect.minX, rect.maxZ],
  ];
  const vertices = [bottom, top].flatMap((height) =>
    corners.map(([x, z]) => [x - origin[0], height(x, z) - origin[1], z - origin[2]]),
  );
  const faces = [
    [0, 1, 2, 3],
    [7, 6, 5, 4],
    [4, 5, 1, 0],
    [5, 6, 2, 1],
    [6, 7, 3, 2],
    [7, 4, 0, 3],
  ];
  const position = faces.flatMap(([a, b, c, d]) => [a, b, c, a, c, d].flatMap((i) => vertices[i]));
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
  geometry.computeVertexNormals();
  physicalUvs(geometry, origin);
  if (roofTextureAxis) {
    // Roof seams run down the slope, at the same physical spacing for either
    // roof direction. World coordinates keep coplanar room patches in phase.
    const position = geometry.getAttribute('position');
    const normal = geometry.getAttribute('normal');
    const uv = geometry.getAttribute('uv');
    for (let index = 0; index < position.count; index++) {
      const vertical = Math.abs(normal.getY(index));
      if (vertical < 0.000001) continue; // Keep the shell's vertical edges projected normally.
      const alongX = roofTextureAxis === 'x';
      const slope = alongX ? normal.getX(index) : normal.getZ(index);
      const metersPerHorizontalMeter = Math.hypot(vertical, slope) / vertical;
      uv.setXY(
        index,
        alongX ? position.getZ(index) + origin[2] : position.getX(index) + origin[0],
        (alongX ? position.getX(index) + origin[0] : position.getZ(index) + origin[2]) *
          metersPerHorizontalMeter,
      );
    }
  }
  return geometry;
}

/** Clip roof-wall cells to the exact sloped profile and cut raised apertures.
 * Subdivision at aperture edges leaves no triangulation holes touching a border. */
export function wallCapGeometry(
  profile: [number, number][],
  eave: number,
  openings: { offset: number; width: number; sill: number; height: number }[] = [],
  textureOrigin: [number, number, number] = [0, 0, 0],
) {
  if (!profile.length || profile.every(([, height]) => height <= eave + 0.001)) return null;
  const xs = [
    ...new Set([
      ...profile.map(([x]) => x),
      ...openings.flatMap((o) => [o.offset - o.width / 2, o.offset + o.width / 2]),
    ]),
  ]
    .filter((x) => x >= profile[0][0] && x <= profile.at(-1)![0])
    .sort((a, b) => a - b);
  const maximum = Math.max(...profile.map(([, y]) => y));
  const ys = [...new Set([eave, maximum, ...openings.flatMap((o) => [o.sill, o.sill + o.height])])]
    .filter((y) => y >= eave && y <= maximum)
    .sort((a, b) => a - b);
  const pieces: THREE.BufferGeometry[] = [];
  for (let column = 1; column < xs.length; column++)
    for (let row = 1; row < ys.length; row++) {
      const x0 = xs[column - 1],
        x1 = xs[column],
        y0 = ys[row - 1],
        y1 = ys[row];
      const midX = (x0 + x1) / 2,
        midY = (y0 + y1) / 2;
      if (
        openings.some(
          (o) =>
            Math.abs(midX - o.offset) < o.width / 2 && midY > o.sill && midY < o.sill + o.height,
        )
      )
        continue;
      const segment = profile.findIndex(
        ([x], i) => i < profile.length - 1 && midX >= x && midX <= profile[i + 1][0],
      );
      if (segment < 0) continue;
      const [a, b] = [profile[segment], profile[segment + 1]];
      const ceiling = (x: number) => a[1] + ((x - a[0]) * (b[1] - a[1])) / (b[0] - a[0]);
      const input: [number, number][] = [
        [x0, y0],
        [x1, y0],
        [x1, y1],
        [x0, y1],
      ];
      const polygon: [number, number][] = [];
      for (let i = 0; i < input.length; i++) {
        const p = input[i],
          q = input[(i + 1) % input.length];
        const fp = p[1] - ceiling(p[0]),
          fq = q[1] - ceiling(q[0]);
        if (fp <= 0.000001) polygon.push(p);
        if (fp <= 0 !== fq <= 0) {
          const t = fp / (fp - fq);
          polygon.push([p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])]);
        }
      }
      if (polygon.length < 3) continue;
      const shape = new THREE.Shape(polygon.map(([x, y]) => new THREE.Vector2(x, y)));
      const part = new THREE.ExtrudeGeometry(shape, { depth: 0.1, bevelEnabled: false });
      part.translate(0, 0, -0.05);
      pieces.push(part);
    }
  if (!pieces.length) return null;
  const geometry = mergeGeometries(pieces, false);
  pieces.forEach((piece) => piece.dispose());
  return physicalUvs(geometry, textureOrigin);
}

/** Two draw groups separate an outward wall face from its room-facing finish.
 * Reorder triangle indices only: positions, dimensions, UVs and picking survive. */
export function interiorFaceGroups(geometry: THREE.BufferGeometry, positive: boolean) {
  const normal = geometry.getAttribute('normal');
  const count = geometry.index?.count ?? normal.count;
  const outside: number[] = [],
    inside: number[] = [];
  for (let index = 0; index < count; index += 3) {
    const a = geometry.index?.getX(index) ?? index;
    const destination = normal.getZ(a) * (positive ? 1 : -1) < -0.5 ? outside : inside;
    for (let corner = 0; corner < 3; corner++)
      destination.push(geometry.index?.getX(index + corner) ?? index + corner);
  }
  geometry.setIndex([...outside, ...inside]);
  geometry.clearGroups();
  if (outside.length) geometry.addGroup(0, outside.length, 0);
  if (inside.length) geometry.addGroup(outside.length, inside.length, 1);
  return geometry;
}
