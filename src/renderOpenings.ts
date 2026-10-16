import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Room, Scene, Side } from '../shared/model';
import { roomOpenings, type ResolvedWallOpening } from '../shared/openings';
import { wallPanels } from './renderGeometry';
import { interiorFaceGroups } from './renderMeshes';
import { projectedUvs } from './renderAssets';

/** Window and door kits built by scripts/assets/build_openings.py. Each is
 * authored around a native opening; `edges` [left, right, bottom, top] are the
 * bands that keep their true size while the interior (glass, panels) absorbs
 * the difference, the same idea as furniture stretch zones. */
export type OpeningAsset = {
  id: string;
  url: string;
  opening: [number, number];
  edges: [number, number, number, number];
  hinge?: 'left';
  thickness?: number;
};
export type OpeningKit = {
  asset: OpeningAsset;
  parts: { geometry: THREE.BufferGeometry; role: string; rigid: boolean }[];
};
export type OpeningKits = Partial<
  Record<'window-casement' | 'window-fixed' | 'door-frame' | 'door-leaf-panel' | 'door-leaf-glazed', OpeningKit>
>;

/** Kit roles to architecture material keys (src/SceneView.tsx). */
export const openingRoleMaterial: Record<string, string> = {
  frame: 'frame',
  flashing: 'frame',
  glass: 'glass',
  sill: 'wood',
  surround: 'frame',
  casing: 'trim',
  leaf: 'wood',
  hardware: 'chrome',
};

/** Piecewise map of one axis: positions within `low` of the start and `high`
 * of the end translate with their edge; the span between scales. Openings
 * too small for both bands scale uniformly. `start` is the native axis start. */
export function bandMap(native: number, target: number, low: number, high: number, start: number) {
  const inner = native - low - high,
    targetInner = target - low - high;
  if (inner <= 0.001 || targetInner <= 0.001) return (value: number) => start * (target / native) + (value - start) * (target / native);
  const a = start + low,
    b = start + native - high;
  const targetStart = start === 0 ? 0 : -target / 2;
  const a2 = targetStart + low,
    b2 = targetStart + target - high;
  return (value: number) =>
    value <= a ? value + (a2 - a) : value >= b ? value + (b2 - b) : a2 + ((value - a) * (b2 - a2)) / (b - a);
}

/** Fit a kit to `width` x `height`; returns cloned parts (caller disposes).
 * Rigid parts (hardware) move with the band map but keep their exact size. */
export function fitOpeningKit(kit: OpeningKit, width: number, height: number) {
  const [w, h] = kit.asset.opening;
  const [left, right, bottom, top] = kit.asset.edges;
  const mx = bandMap(w, width, left, right, -w / 2),
    my = bandMap(h, height, bottom, top, 0);
  return kit.parts.map(({ geometry: source, role, rigid }) => {
    const geometry = source.clone();
    const position = geometry.getAttribute('position') as THREE.BufferAttribute;
    if (rigid) {
      geometry.computeBoundingBox();
      const center = geometry.boundingBox!.getCenter(new THREE.Vector3());
      geometry.translate(mx(center.x) - center.x, my(center.y) - center.y, 0);
    } else {
      for (let i = 0; i < position.count; i++)
        position.setXY(i, mx(position.getX(i)), my(position.getY(i)));
      position.needsUpdate = true;
    }
    projectedUvs(geometry, 'uv');
    geometry.deleteAttribute('uv1');
    return { geometry, role };
  });
}

/** Even split of a span into bays no wider than `max`. */
export function bays(span: number, max: number) {
  return Math.max(1, Math.ceil(span / max - 1e-6));
}
/** Leaves for a door width: single to 1.25 m, a pair to 2.5 m, then ~1.1 m panels. */
export function leafCount(width: number) {
  return width <= 1.25 ? 1 : width <= 2.5 ? 2 : Math.min(8, Math.ceil(width / 1.1));
}

const outdoor = (room: Room) => room.kind === 'terrace' || room.kind === 'courtyard';
const opposite: Record<Side, Side> = { north: 'south', south: 'north', east: 'west', west: 'east' };

/** An opening is exterior when nothing indoor lies on its other face. */
export function openingIsExterior(house: Scene, room: Room, side: Side, opening: ResolvedWallOpening) {
  if (opening.source === 'connection') {
    const connection = house.design?.connections.find((item) => item.id === opening.id);
    const otherId = connection?.roomAId === room.id ? connection?.roomBId : connection?.roomAId;
    const other = house.rooms.find((item) => item.id === otherId);
    return !other || outdoor(other);
  }
  return !house.rooms.some(
    (other) =>
      other.id !== room.id &&
      !outdoor(other) &&
      roomOpenings(house, other.id, opposite[side]).some((item) => item.id === opening.id),
  );
}

type Placed = { geometry: THREE.BufferGeometry; role: string };

/** Every kit part for one wall, in the wall group's local frame (x along the
 * wall, +z interior on north/east walls), merged per material with outside /
 * inside face groups like the wall itself. Undefined when a needed kit is missing. */
export function openingKitGeometry(house: Scene, room: Room, side: Side, kits: OpeningKits) {
  const { 'window-casement': casement, 'window-fixed': fixed, 'door-frame': frame } = kits;
  const panelLeaf = kits['door-leaf-panel'],
    glazedLeaf = kits['door-leaf-glazed'];
  if (!casement || !fixed || !frame || !panelLeaf || !glazedLeaf) return undefined;
  const positive = side === 'north' || side === 'east';
  const placed: Placed[] = [];
  /** Place parts authored in opening-local axes (+z interior) at wall-local x, y:
   * optional half-turn (hinge side), swing about a local hinge, shift, then a
   * half-turn on south/west walls whose local +z faces outward. */
  const put = (
    parts: Placed[],
    x: number,
    y: number,
    options: { mirror?: boolean; swing?: number; pivotX?: number; shift?: [number, number] } = {},
  ) => {
    const matrix = new THREE.Matrix4();
    if (options.mirror) matrix.premultiply(new THREE.Matrix4().makeRotationY(Math.PI));
    if (options.swing) {
      const pivot = options.pivotX ?? 0;
      matrix
        .premultiply(new THREE.Matrix4().makeTranslation(-pivot, 0, 0))
        .premultiply(new THREE.Matrix4().makeRotationY(options.swing))
        .premultiply(new THREE.Matrix4().makeTranslation(pivot, 0, 0));
    }
    const [shiftX, shiftZ] = options.shift ?? [0, 0];
    matrix.premultiply(new THREE.Matrix4().makeTranslation(shiftX, 0, shiftZ));
    if (!positive) matrix.premultiply(new THREE.Matrix4().makeRotationY(Math.PI));
    matrix.premultiply(new THREE.Matrix4().makeTranslation(x, y, 0));
    for (const part of parts) {
      part.geometry.applyMatrix4(matrix);
      placed.push(part);
    }
  };
  const glazing = (x: number, bottom: number, width: number, height: number, operable: boolean) => {
    const rows = bays(height, operable ? 2.4 : 3.2),
      columns = bays(width, operable ? 1.5 : 1.8);
    const bayWidth = width / columns,
      bayHeight = height / rows;
    // Stool, sill, drip and trim boards belong to the whole opening, not each bay.
    const sill = (role: string) => role === 'sill' || role === 'flashing' || role === 'surround';
    for (let row = 0; row < rows; row++)
      for (let column = 0; column < columns; column++) {
        // Only the bottom row of a window opens; its sill runs once under all bays.
        const kit = operable && row === 0 ? casement : fixed;
        const parts = fitOpeningKit(kit, bayWidth, bayHeight);
        parts.filter((part) => sill(part.role)).forEach((part) => part.geometry.dispose());
        put(
          parts.filter((part) => !sill(part.role)),
          x - width / 2 + (column + 0.5) * bayWidth,
          bottom + row * bayHeight,
          // Alternate handle sides so paired casements meet at the mullion.
          { mirror: kit === casement && column % 2 === 1 },
        );
      }
    if (operable) {
      const parts = fitOpeningKit(casement, width, height);
      parts.filter((part) => !sill(part.role)).forEach((part) => part.geometry.dispose());
      put(parts.filter((part) => sill(part.role)), x, bottom);
    }
  };
  const openings = roomOpenings(house, room.id, side);
  if (room[side] === 'glass' && !openings.length)
    for (const panel of wallPanels(house, room, side, false))
      glazing(panel.offset, panel.bottom, panel.width, panel.height, false);
  for (const opening of openings) {
    const x = opening.offset;
    if (opening.kind === 'window') {
      // A window between two rooms is fixed interior glazing, drawn once by its owner.
      const exterior = openingIsExterior(house, room, side, opening);
      if (!exterior && opening.sourceRoomId !== room.id) continue;
      glazing(x, opening.sill, opening.width, opening.height, exterior);
    } else if (opening.kind === 'door') {
      put(fitOpeningKit(frame, opening.width, opening.height), x, opening.sill);
      const exterior = openingIsExterior(house, room, side, opening);
      // A shared door belongs to its owning room so the leaf is drawn once.
      if (!exterior && opening.sourceRoomId !== room.id) continue;
      const count = leafCount(opening.width);
      if (!exterior && count > 2) continue; // wide interior passages read as open pocket doors
      const kit = exterior ? glazedLeaf : panelLeaf;
      const gap = 0.004,
        leafWidth = opening.width / count - gap * 2,
        leafHeight = opening.height - 0.012;
      for (let index = 0; index < count; index++) {
        const center = x - opening.width / 2 + (index + 0.5) * (opening.width / count);
        // Leaves in the right half of the wall hinge on the right. South/west
        // walls turn the opening around, so the authored side flips there.
        const mirror = (count > 1 && index >= count / 2) !== !positive;
        const parts = fitOpeningKit(kit, leafWidth, leafHeight);
        if (exterior) put(parts, center, opening.sill + 0.006, { mirror });
        else
          // Interior doors stand open 90 degrees into the room beside their hinge jamb.
          put(parts, center, opening.sill + 0.006, {
            mirror,
            swing: mirror ? Math.PI / 2 : -Math.PI / 2,
            pivotX: mirror ? leafWidth / 2 : -leafWidth / 2,
            shift: [mirror ? -0.024 : 0.024, 0.03],
          });
      }
    }
  }
  if (!placed.length) return [];
  const groups = new Map<string, THREE.BufferGeometry[]>();
  for (const part of placed) {
    const key = openingRoleMaterial[part.role] ?? 'frame';
    const geometry = part.geometry.index ? part.geometry.toNonIndexed() : part.geometry;
    if (geometry !== part.geometry) part.geometry.dispose();
    for (const name of Object.keys(geometry.attributes))
      if (!['position', 'normal', 'uv'].includes(name)) geometry.deleteAttribute(name);
    const list = groups.get(key) ?? [];
    list.push(geometry);
    groups.set(key, list);
  }
  return [...groups].map(([material, parts]) => {
    const geometry = interiorFaceGroups(mergeGeometries(parts)!, positive);
    parts.forEach((part) => part.dispose());
    return { material, geometry };
  });
}
