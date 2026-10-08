import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { Furniture, FurnitureKind } from '../shared/model';
import { physicalUvs } from './renderMeshes';

export type FurniturePart = {
  position: [number, number, number];
  size: [number, number, number];
  material: string;
  radius?: number;
  cylinder?: boolean;
  cushion?: 'y' | 'z';
  welt?: 'y' | 'z';
  flatWelt?: boolean;
  tilt?: [number, number, number];
  taper?: number;
};

/** Parts are normalized to the saved envelope; trim, cushions and feet never
 * enlarge the footprint used by the plan, selection or clearance inspection. */
export function furnitureParts(kind: FurnitureKind): FurniturePart[] {
  const parts: FurniturePart[] = [];
  const box = (
    position: FurniturePart['position'],
    size: FurniturePart['size'],
    material: string,
    radius = 0,
  ) => parts.push({ position, size, material, radius });
  const leg = (x: number, z: number, height: number, material = 'wood', width = 0.045) =>
    parts.push({
      position: [x, height / 2, z],
      size: [width, height, width],
      material,
      cylinder: true,
    });
  const cushion = (
    position: FurniturePart['position'],
    size: FurniturePart['size'],
    axis: 'y' | 'z',
    material = 'fabric',
    tilt?: FurniturePart['tilt'],
  ) => {
    parts.push({ position, size, material, radius: 0.065, cushion: axis, tilt });
    parts.push({
      position,
      size,
      material: material === 'accentFabric' ? material : 'seam',
      radius: 0.065,
      welt: axis,
      tilt,
    });
  };
  if (kind === 'sofa' || kind === 'armchair') {
    for (const x of [-0.39, 0.39])
      for (const z of [-0.34, 0.34]) {
        parts.push({
          position: [x, 0.115, z],
          size: [0.05, 0.23, 0.055],
          material: 'wood',
          radius: 0.003,
          taper: 0.72,
        });
      }
    box([0, 0.285, 0], [0.94, 0.23, 0.91], 'fabric', 0.04);
    box([0, 0.663, -0.382], [0.96, 0.674, 0.236], 'fabric', 0.045);
    for (const sign of [-1, 1]) {
      box([sign * 0.447, 0.485, 0], [0.104, 0.49, 0.98], 'fabric', 0.035);
    }
    const count = kind === 'sofa' ? 3 : 1;
    for (let i = 0; i < count; i++) {
      const x = -0.39 + ((i + 0.5) * 0.78) / count;
      const width = 0.78 / count - 0.012;
      cushion([x, 0.478, 0.076], [width, 0.19, 0.72], 'y');
      cushion([x, 0.747, -0.21], [width, 0.435, 0.23], 'z', 'fabric', [-0.11, 0, 0]);
    }
    if (kind === 'sofa') {
      cushion(
        [-0.292, 0.713, -0.068],
        [0.145, 0.32, 0.225],
        'z',
        'accentFabric',
        [-0.13, 0.07, -0.12],
      );
      cushion([0.285, 0.689, -0.032], [0.15, 0.28, 0.22], 'z', 'accentFabric', [-0.17, -0.08, 0.1]);
    }
  } else if (kind === 'chair') {
    for (const x of [-0.38, 0.38]) for (const z of [-0.35, 0.32]) leg(x, z, 0.55, 'wood', 0.065);
    box([0, 0.54, 0.03], [0.94, 0.09, 0.87], 'wood', 0.025);
    box([0, 0.6, 0.03], [0.88, 0.1, 0.82], 'fabric', 0.035);
    for (const x of [-0.38, 0.38]) box([x, 0.77, -0.38], [0.065, 0.46, 0.07], 'wood', 0.012);
    box([0, 0.88, -0.38], [0.94, 0.24, 0.15], 'wood', 0.035);
  } else if (kind === 'coffee-table' || kind === 'dining-table' || kind === 'nightstand') {
    box([0, 0.945, 0], [1, 0.11, 1], 'wood', 0.005);
    // Four aprons make the top/leg joint legible without filling its open underside.
    for (const z of [-0.355, 0.355]) box([0, 0.817, z], [0.8, 0.17, 0.035], 'wood', 0.003);
    for (const x of [-0.39, 0.39]) box([x, 0.817, 0], [0.03, 0.17, 0.71], 'wood', 0.003);
    for (const x of [-0.39, 0.39])
      for (const z of [-0.355, 0.355]) {
        parts.push({
          position: [x, 0.445, z],
          size: [0.052, 0.89, 0.084],
          material: 'wood',
          radius: 0.003,
          taper: 0.65,
        });
      }
    if (kind === 'nightstand') {
      box([0, 0.67, 0], [0.92, 0.31, 0.9], 'wood', 0.016);
      box([0, 0.67, 0.455], [0.85, 0.27, 0.025], 'wood', 0.007);
      box([0, 0.68, 0.477], [0.22, 0.025, 0.035], 'frame', 0.006);
    }
  } else if (kind === 'bed') {
    for (const x of [-0.4, 0.4]) for (const z of [-0.39, 0.39]) leg(x, z, 0.15, 'wood', 0.045);
    box([0, 0.2, 0.01], [0.98, 0.26, 0.98], 'wood', 0.025);
    box([0, 0.51, -0.456], [1, 0.98, 0.088], 'fabric', 0.06);
    box([0, 0.348, 0.035], [0.94, 0.2, 0.9], 'seam', 0.065);
    box([0, 0.418, 0.145], [0.952, 0.085, 0.695], 'fabric', 0.045);
    box([0, 0.459, 0.25], [0.94, 0.025, 0.21], 'accentFabric', 0.009);
    for (const x of [-0.23, 0.23]) {
      box([x, 0.447, -0.275], [0.39, 0.105, 0.21], 'fabric', 0.065);
      box([x, 0.478, -0.235], [0.365, 0.08, 0.19], 'fabric', 0.06);
    }
  } else if (kind === 'rug') {
    box([0, 0.37, 0], [0.997, 0.74, 0.997], 'rug', 0.007);
    // One continuous, millimeter-scale binding; no stacked dark strips at the edge.
    parts.push({
      position: [0, 0.76, 0],
      size: [1, 0.22, 1],
      material: 'rugEdge',
      radius: 0.012,
      welt: 'y',
      flatWelt: true,
    });
  } else if (kind === 'bath') {
    box([0, 0.36, 0], [0.97, 0.72, 0.96], 'ceramic', 0.14);
    box([0, 0.705, 0], [0.82, 0.035, 0.72], 'basin', 0.13);
    for (const x of [-0.46, 0.46]) box([x, 0.76, 0], [0.08, 0.09, 0.89], 'ceramic', 0.028);
    for (const z of [-0.45, 0.45]) box([0, 0.76, z], [0.92, 0.09, 0.09], 'ceramic', 0.028);
    box([0.35, 0.875, -0.39], [0.025, 0.25, 0.035], 'chrome', 0.008);
    box([0.35, 0.98, -0.31], [0.025, 0.035, 0.18], 'chrome', 0.008);
  } else if (kind === 'toilet') {
    box([0, 0.54, -0.31], [0.88, 0.84, 0.35], 'ceramic', 0.065);
    box([0, 0.3, 0.065], [0.53, 0.6, 0.61], 'ceramic', 0.09);
    box([0, 0.56, 0.125], [0.95, 0.16, 0.75], 'ceramic', 0.12);
    box([0, 0.646, 0.125], [0.81, 0.025, 0.6], 'seam', 0.095);
    box([0, 0.974, -0.31], [0.89, 0.045, 0.36], 'ceramic', 0.016);
    box([0.2, 0.84, -0.13], [0.15, 0.045, 0.025], 'chrome', 0.006);
  } else {
    box([0, 0.07, 0], [0.89, 0.14, 0.85], 'frame', 0.006);
    box([0, 0.52, 0], [0.97, 0.87, 0.94], 'wood', 0.01);
    const doors = kind === 'wardrobe' ? 3 : 4;
    for (let i = 0; i < doors; i++) {
      const x = -0.475 + ((i + 0.5) * 0.95) / doors;
      box([x, 0.54, 0.474], [0.95 / doors - 0.007, 0.79, 0.025], 'wood', 0.004);
      box([x + (0.95 / doors) * 0.31, 0.66, 0.491], [0.007, 0.15, 0.018], 'frame', 0.003);
    }
    box([0, 0.976, 0], [1, 0.048, 1], kind === 'wardrobe' ? 'wood' : 'worktop', 0.014);
    if (kind === 'island' || kind === 'vanity') {
      box([0, 0.998, 0], [0.35, 0.003, 0.46], 'basin', 0.03);
    }
  }
  return parts;
}

/** A rounded shell with interior face samples for a gentle cloth crown. The
 * deformation only contracts the saved envelope. Analytic normals keep the
 * fabric continuous across the six UV charts without extra smoothing draws. */
function cushionGeometry(size: [number, number, number], radius: number, axis: 'y' | 'z') {
  const sourceGeometry = new THREE.BoxGeometry(1, 1, 1, 6, 6, 6);
  const geometry = sourceGeometry.toNonIndexed();
  sourceGeometry.dispose();
  const position = geometry.getAttribute('position'),
    normal = geometry.getAttribute('normal'),
    uv = geometry.getAttribute('uv');
  const t = axis === 'y' ? 1 : 2;
  const a = 0,
    b = axis === 'y' ? 2 : 1;
  // The cloth sits just inside its binding, which remains within the saved bounds.
  const half = size.map(
    (value, dim) => value / 2 - (dim === t ? 0 : Math.min(0.0018, value * 0.005)),
  );
  const p = new THREE.Vector3(),
    n = new THREE.Vector3();
  const crown = 0.28;
  for (let i = 0; i < position.count; i++) {
    const source = [position.getX(i), position.getY(i), position.getZ(i)];
    const q = source.map((value, dim) => {
      const points = [
        -half[dim],
        -half[dim] + radius * 0.3,
        -half[dim] + radius,
        0,
        half[dim] - radius,
        half[dim] - radius * 0.3,
        half[dim],
      ];
      return points[Math.round((value + 0.5) * 6)];
    });
    const core = q.map((value, dim) =>
      THREE.MathUtils.clamp(value, -half[dim] + radius, half[dim] - radius),
    );
    n.set(q[0] - core[0], q[1] - core[1], q[2] - core[2]).normalize();
    p.set(core[0], core[1], core[2]).addScaledVector(n, radius);
    const v = p.toArray(),
      nn = n.toArray();
    const fa = 1 - (v[a] / half[a]) ** 2,
      fb = 1 - (v[b] / half[b]) ** 2;
    const scale = 1 - crown + crown * fa * fb;
    nn[a] -= (nn[t] * v[t] * ((-2 * crown * v[a] * fb) / half[a] ** 2)) / scale;
    nn[b] -= (nn[t] * v[t] * ((-2 * crown * v[b] * fa) / half[b] ** 2)) / scale;
    nn[t] /= scale;
    v[t] *= scale;
    position.setXYZ(i, v[0], v[1], v[2]);
    n.fromArray(nn).normalize();
    normal.setXYZ(i, n.x, n.y, n.z);
    const face = Math.floor(i / (position.count / 6));
    const uAxis = face < 2 ? 2 : 0,
      vAxis = face >= 2 && face < 4 ? 2 : 1;
    uv.setXY(i, q[uAxis] + half[uAxis], q[vAxis] + half[vAxis]);
  }
  return geometry;
}

/** A slim tailored binding with surface-aligned normals. Subpixel round cords
 * cause false serrated self-shadows in the cached directional map. */
function weltGeometry(
  size: [number, number, number],
  corner: number,
  axis: 'y' | 'z',
  flat = false,
) {
  const plane = axis === 'y' ? [0, 2] : [0, 1];
  const thin = axis === 'y' ? 1 : 2;
  const tube = Math.min(0.0018, size[thin] * 0.45, size[plane[0]] * 0.02, size[plane[1]] * 0.02);
  const w = size[plane[0]] / 2 - tube,
    h = size[plane[1]] / 2 - tube;
  const r = Math.min(corner, w * 0.45, h * 0.45);
  const points: THREE.Vector3[] = [],
    directions: THREE.Vector3[] = [];
  for (let quadrant = 0; quadrant < 4; quadrant++) {
    const angle = (quadrant * Math.PI) / 2;
    const cx = quadrant === 0 || quadrant === 3 ? w - r : -w + r;
    const cy = quadrant < 2 ? h - r : -h + r;
    for (let step = 0; step <= 4; step++) {
      const theta = angle + (step * Math.PI) / 8;
      const values = [0, 0, 0];
      values[plane[0]] = cx + Math.cos(theta) * r;
      values[plane[1]] = cy + Math.sin(theta) * r;
      points.push(new THREE.Vector3(...values));
      const radial = new THREE.Vector3();
      radial.setComponent(plane[0], Math.cos(theta));
      radial.setComponent(plane[1], Math.sin(theta));
      directions.push(radial);
    }
  }
  // Straight edges and quarter circles retain their actual physical length.
  const positions: number[] = [],
    normals: number[] = [],
    uvs: number[] = [],
    indices: number[] = [];
  let distance = 0;
  for (let i = 0; i <= points.length; i++) {
    const at = points[i % points.length];
    if (i) distance += at.distanceTo(points[(i - 1) % points.length]);
    const up = new THREE.Vector3();
    up.setComponent(thin, 1);
    const outward = directions[i % points.length];
    for (const side of [-1, 1]) {
      const point = at.clone().addScaledVector(flat ? outward : up, side * tube);
      if (!flat) point.addScaledVector(outward, tube * 0.35);
      positions.push(...point.toArray());
      normals.push(...(flat ? up : outward).toArray());
      uvs.push(distance, (side + 1) * tube);
    }
    if (i < points.length) {
      const start = i * 2;
      const quad = [start, start + 2, start + 1, start + 1, start + 2, start + 3];
      if ((axis === 'y') !== flat) quad.reverse();
      indices.push(...quad);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  return geometry;
}

export function furniturePartGeometry(item: Furniture, part: FurniturePart) {
  const size: [number, number, number] = [
    part.size[0] * item.width,
    part.size[1] * item.height,
    part.size[2] * item.depth,
  ];
  const radius = Math.min(part.radius ?? 0, Math.min(...size) * 0.45);
  if (part.cushion || part.welt) {
    const geometry = part.welt
      ? weltGeometry(size, radius, part.welt, part.flatWelt)
      : cushionGeometry(size, radius, part.cushion!);
    if (part.tilt) {
      const rotation = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(...part.tilt));
      // Use the cushion's fit for its welt too, so the thin binding follows the
      // same surface instead of independently stretching to the entire depth.
      const envelope = part.welt ? cushionGeometry(size, radius, part.welt) : geometry;
      envelope.applyMatrix4(rotation);
      envelope.computeBoundingBox();
      const bounds = envelope.boundingBox!.getSize(new THREE.Vector3());
      if (part.welt) {
        geometry.applyMatrix4(rotation);
        envelope.dispose();
      }
      geometry.scale(
        ...(size.map((value, axis) => value / bounds.getComponent(axis)) as [
          number,
          number,
          number,
        ]),
      );
    }
    return geometry;
  }
  if (part.cylinder) {
    const radius = Math.min(size[0], size[2]) * 0.5;
    const geometry = new THREE.CylinderGeometry(radius * 0.86, radius, size[1], 12);
    const uv = geometry.getAttribute('uv');
    for (let i = 0; i < uv.count; i++)
      uv.setXY(i, uv.getX(i) * Math.PI * radius * 2, uv.getY(i) * size[1]);
    return geometry;
  }
  if (radius <= 0) return physicalUvs(new THREE.BoxGeometry(...size));
  const geometry = new RoundedBoxGeometry(
    ...size,
    part.material === 'fabric' || part.material === 'ceramic' ? 2 : 1,
    radius,
  );
  if (part.taper) {
    const positions = geometry.getAttribute('position');
    for (let i = 0; i < positions.count; i++) {
      const scale = part.taper + (1 - part.taper) * (positions.getY(i) / size[1] + 0.5);
      positions.setX(i, positions.getX(i) * scale);
      positions.setZ(i, positions.getZ(i) * scale);
    }
    geometry.computeVertexNormals();
  }
  // Keep each face's continuous native UV chart across its curved edge. Choosing
  // a projection per vertex normal creates discontinuities on rounded triangles.
  const uv = geometry.getAttribute('uv');
  const verticesPerFace = uv.count / 6;
  for (let i = 0; i < uv.count; i++) {
    const face = Math.floor(i / verticesPerFace);
    const u = face < 2 ? size[2] : size[0];
    const v = face >= 2 && face < 4 ? size[2] : size[1];
    uv.setXY(i, uv.getX(i) * u, uv.getY(i) * v);
  }
  return geometry;
}

/** Merge only within a saved piece, keeping its group as the picking/identity
 * boundary. UVs and normals survive; furniture remains independently editable. */
export function furnitureGeometry(item: Furniture) {
  const groups = new Map<string, THREE.BufferGeometry[]>();
  for (const part of furnitureParts(item.kind)) {
    let geometry = furniturePartGeometry(item, part);
    if (geometry.index) {
      const flat = geometry.toNonIndexed();
      geometry.dispose();
      geometry = flat;
    }
    geometry.translate(
      part.position[0] * item.width,
      part.position[1] * item.height,
      part.position[2] * item.depth,
    );
    const list = groups.get(part.material) ?? [];
    list.push(geometry);
    groups.set(part.material, list);
  }
  return [...groups].map(([material, parts]) => {
    const geometry = mergeGeometries(parts)!;
    parts.forEach((part) => part.dispose());
    return { material, geometry };
  });
}

export function FurnitureMesh({
  item,
  materials,
  selected,
  onSelect,
}: {
  item: Furniture;
  materials: Record<string, THREE.Material>;
  selected: boolean;
  onSelect: () => void;
}) {
  const pieces = useMemo(
    () => furnitureGeometry(item),
    [item.kind, item.width, item.height, item.depth],
  );
  useEffect(() => () => pieces.forEach((part) => part.geometry.dispose()), [pieces]);
  return (
    <group
      position={[item.x, 0, item.z]}
      rotation={[0, (item.rotation * Math.PI) / 180, 0]}
      userData={{ furnitureId: item.id }}
      onClick={(event) => {
        event.stopPropagation();
        onSelect();
      }}
    >
      {pieces.map((part, index) => (
        <mesh
          key={index}
          geometry={part.geometry}
          material={materials[part.material]}
          castShadow
          receiveShadow
        />
      ))}
      {selected && (
        <mesh position={[0, item.height / 2, 0]}>
          <boxGeometry args={[item.width + 0.012, item.height + 0.012, item.depth + 0.012]} />
          <meshBasicMaterial color="#d3933d" wireframe toneMapped={false} />
        </mesh>
      )}
    </group>
  );
}
