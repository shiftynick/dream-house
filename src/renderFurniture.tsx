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
  if (kind === 'sofa' || kind === 'armchair') {
    for (const x of [-0.39, 0.39]) for (const z of [-0.34, 0.34]) leg(x, z, 0.23, 'wood', 0.05);
    box([0, 0.31, 0], [0.94, 0.28, 0.93], 'fabric', 0.045);
    box([0, 0.67, -0.365], [0.98, 0.66, 0.27], 'fabric', 0.055);
    for (const sign of [-1, 1]) {
      box([sign * 0.447, 0.49, 0], [0.106, 0.49, 0.98], 'fabric', 0.04);
      box([sign * 0.448, 0.71, 0], [0.092, 0.022, 0.85], 'seam', 0.009);
    }
    const count = kind === 'sofa' ? 3 : 1;
    for (let i = 0; i < count; i++) {
      const x = -0.39 + ((i + 0.5) * 0.78) / count;
      const width = 0.78 / count - 0.012;
      box([x, 0.432, 0.075], [width, 0.035, 0.72], 'seam', 0.025);
      box([x, 0.493, 0.075], [width, 0.13, 0.72], 'fabric', 0.06);
      box([x, 0.727, -0.222], [width, 0.4, 0.17], 'fabric', 0.065);
    }
    if (kind === 'sofa') {
      box([-0.295, 0.698, -0.11], [0.15, 0.31, 0.18], 'accentFabric', 0.075);
      box([0.285, 0.67, -0.08], [0.16, 0.25, 0.18], 'accentFabric', 0.065);
    }
  } else if (kind === 'chair') {
    for (const x of [-0.38, 0.38]) for (const z of [-0.35, 0.32]) leg(x, z, 0.55, 'wood', 0.065);
    box([0, 0.54, 0.03], [0.94, 0.09, 0.87], 'wood', 0.025);
    box([0, 0.6, 0.03], [0.88, 0.1, 0.82], 'fabric', 0.035);
    for (const x of [-0.38, 0.38]) box([x, 0.77, -0.38], [0.065, 0.46, 0.07], 'wood', 0.012);
    box([0, 0.88, -0.38], [0.94, 0.24, 0.15], 'wood', 0.035);
  } else if (kind === 'coffee-table' || kind === 'dining-table' || kind === 'nightstand') {
    box([0, 0.951, 0], [1, 0.098, 1], 'wood', 0.035);
    box([0, 0.879, 0], [0.87, 0.05, 0.84], 'wood', 0.012);
    for (const x of [-0.4, 0.4]) for (const z of [-0.36, 0.36]) leg(x, z, 0.9, 'wood', 0.055);
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
    box([0, 0.47, 0], [1, 0.94, 1], 'rug', 0.018);
    // A bound edge is geometry, not another floating plane or transparent shadow decal.
    for (const x of [-0.496, 0.496]) box([x, 0.51, 0], [0.008, 0.98, 0.996], 'rugEdge', 0.004);
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

export function furniturePartGeometry(item: Furniture, part: FurniturePart) {
  const size: [number, number, number] = [
    part.size[0] * item.width,
    part.size[1] * item.height,
    part.size[2] * item.depth,
  ];
  const radius = Math.min(part.radius ?? 0, Math.min(...size) * 0.45);
  if (part.cylinder) {
    const radius = Math.min(size[0], size[2]) * 0.5;
    const geometry = new THREE.CylinderGeometry(radius * 0.86, radius, size[1], 12);
    const uv = geometry.getAttribute('uv');
    for (let i = 0; i < uv.count; i++)
      uv.setXY(i, uv.getX(i) * Math.PI * radius * 2, uv.getY(i) * size[1]);
    return geometry;
  }
  if (radius <= 0) return physicalUvs(new THREE.BoxGeometry(...size));
  const geometry = new RoundedBoxGeometry(...size, 2, radius);
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
