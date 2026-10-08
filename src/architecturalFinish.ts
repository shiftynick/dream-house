import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Room, Scene, Side } from '../shared/model';
import { roomOpenings } from '../shared/openings';
import { wallPanels, wallAxis, roomSlabs } from './renderGeometry';
import { roofHeightAt } from '../shared/architecture';
import { physicalUvs, interiorFaceGroups } from './renderMeshes';
export type FinishPart = {
  position: [number, number, number];
  size: [number, number, number];
  material: 'trim' | 'chrome';
};
/** Thin finishes follow physical wall cells, stopping at passages and low glass. */
export function wallFinishParts(house: Scene, room: Room, side: Side): FinishPart[] {
  const openings = roomOpenings(house, room.id, side);
  const roofClipped = roomSlabs(house, room).roofClipped;
  if ((room[side] === 'glass' || room[side] === 'open') && !openings.length) return [];
  const sign = side === 'north' || side === 'east' ? 1 : -1;
  const parts: FinishPart[] = [];
  const axis = wallAxis(room, side);
  const box = (
    x: number,
    y: number,
    w: number,
    h: number,
    material: FinishPart['material'] = 'trim',
    depth = 0.024,
    z = 0.065,
  ) => {
    const left = Math.max(-axis.length / 2 + 0.005, x - w / 2),
      right = Math.min(axis.length / 2 - 0.005, x + w / 2);
    const ceiling = Math.min(
      ...[left, right].map(
        (offset) =>
          (roofClipped
            ? room.elevation + room.height
            : roofHeightAt(
                house,
                room,
                axis.horizontal ? room.x + offset : axis.boundary,
                axis.horizontal ? axis.boundary : room.z + offset,
              )) - room.elevation,
      ),
    );
    const bottom = Math.max(0, y - h / 2),
      top = Math.min(ceiling, y + h / 2);
    if (right > left && top > bottom)
      parts.push({
        position: [(left + right) / 2, (bottom + top) / 2, z * sign],
        size: [right - left, top - bottom, depth],
        material,
      });
  };
  for (const panel of wallPanels(house, room, side, false))
    if (panel.bottom < 0.001 && panel.height >= 0.11) box(panel.offset, 0.052, panel.width, 0.104);
  for (const opening of openings) {
    const width = 0.045,
      base = opening.sill,
      top = base + opening.height;
    for (const sign of [-1, 1])
      box(
        opening.offset + sign * (opening.width / 2 + width / 2),
        (base + top) / 2,
        width,
        opening.height,
      );
    box(opening.offset, top + width / 2, opening.width + 2 * width, width);
    if (opening.kind === 'window') {
      // A restrained window latch: visual hardware stays within the frame.
      box(
        opening.offset - opening.width / 2 + 0.04,
        base + Math.min(1.05, opening.height * 0.5),
        0.018,
        0.105,
        'chrome',
        0.022,
        0.092,
      );
    }
  }
  return parts;
}
export function wallFinishGeometry(house: Scene, room: Room, side: Side) {
  const groups = new Map<string, THREE.BufferGeometry[]>();
  for (const part of wallFinishParts(house, room, side)) {
    const geometry = physicalUvs(new THREE.BoxGeometry(...part.size));
    if (part.material === 'trim' && part.size[0] > part.size[1]) {
      const uv = geometry.getAttribute('uv');
      for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getY(i), uv.getX(i));
    }
    geometry.translate(...part.position);
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

/** Batch repeated wall cells and frame bars by finish. Each material retains
 * exactly one outward and one inward draw group, with the original UVs. */
export function wallSurfaceGeometry(house: Scene, room: Room, side: Side) {
  const groups = new Map<string, THREE.BufferGeometry[]>();
  const textureOrigin: [number, number, number] = [wallAxis(room, side).center, room.elevation, 0];
  const box = (
    material: string,
    position: [number, number, number],
    size: [number, number, number],
    continuous = false,
  ) => {
    const geometry = new THREE.BoxGeometry(...size);
    if (continuous) geometry.translate(...position);
    physicalUvs(geometry, continuous ? textureOrigin : undefined);
    if (!continuous) geometry.translate(...position);
    const parts = groups.get(material) ?? [];
    parts.push(geometry);
    groups.set(material, parts);
  };
  const glazing = (offset: number, bottom: number, width: number, height: number) => {
    box('glass', [offset, bottom + height / 2, 0], [width, height, 0.024]);
    for (const y of [0, height]) box('frame', [offset, bottom + y, 0], [width + 0.07, 0.055, 0.12]);
    const count = Math.ceil(width / 1.7);
    for (let i = 0; i <= count; i++)
      box(
        'frame',
        [offset - width / 2 + (i * width) / count, bottom + height / 2, 0],
        [0.045, height, 0.12],
      );
  };
  const openings = roomOpenings(house, room.id, side);
  for (const panel of wallPanels(house, room, side, false)) {
    if (room[side] === 'glass' && !openings.length)
      glazing(panel.offset, panel.bottom, panel.width, panel.height);
    else
      box(
        'wall',
        [panel.offset, panel.bottom + panel.height / 2, 0],
        [panel.width, panel.height, 0.1],
        true,
      );
  }
  for (const opening of openings) {
    if (opening.kind === 'window') {
      glazing(opening.offset, opening.sill, opening.width, opening.height);
      box('wood', [opening.offset, opening.sill - 0.035, 0], [opening.width + 0.12, 0.06, 0.24]);
    } else if (opening.kind === 'door') {
      for (const sign of [-1, 1])
        box(
          'frame',
          [
            opening.offset + sign * (opening.width / 2 - 0.025),
            opening.sill + opening.height / 2,
            0,
          ],
          [0.05, opening.height, 0.15],
        );
      box(
        'frame',
        [opening.offset, opening.sill + opening.height - 0.025, 0],
        [opening.width, 0.05, 0.15],
      );
    }
  }
  return [...groups].map(([material, parts]) => {
    const geometry = interiorFaceGroups(
      mergeGeometries(parts)!,
      side === 'north' || side === 'east',
    );
    parts.forEach((part) => part.dispose());
    return { material, geometry };
  });
}
