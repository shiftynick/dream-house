import type { Room, Scene, Side, Stair } from '../shared/model';
import { getDesign, oppositeSide, roomOpenings } from '../shared/design';
import { sharedBoundary } from '../shared/geometry';
import { effectiveRoof, roofHeightAt } from '../shared/architecture';
import { stairPlanFootprint } from '../shared/spatial';

export type Rect = { minX: number; minZ: number; maxX: number; maxZ: number };
export type WallPanel = { offset: number; width: number; bottom: number; height: number };
const EPSILON = 0.001;

// Rectangles are also used in wall space: x is the wall axis, z is height.
// Keeping the subdivision pure lets the plan and 3D views use the same geometry.
export function subtractRectangles(base: Rect, cuts: Rect[]): Rect[] {
  let pieces = [base];
  for (const cut of cuts) {
    pieces = pieces.flatMap((piece) => {
      const x0 = Math.max(piece.minX, cut.minX);
      const x1 = Math.min(piece.maxX, cut.maxX);
      const z0 = Math.max(piece.minZ, cut.minZ);
      const z1 = Math.min(piece.maxZ, cut.maxZ);
      if (x1 - x0 <= EPSILON || z1 - z0 <= EPSILON) return [piece];
      return [
        { minX: piece.minX, minZ: piece.minZ, maxX: x0, maxZ: piece.maxZ },
        { minX: x1, minZ: piece.minZ, maxX: piece.maxX, maxZ: piece.maxZ },
        { minX: x0, minZ: piece.minZ, maxX: x1, maxZ: z0 },
        { minX: x0, minZ: z1, maxX: x1, maxZ: piece.maxZ },
      ].filter((r) => r.maxX - r.minX > EPSILON && r.maxZ - r.minZ > EPSILON);
    });
  }
  return pieces;
}

export function roomFootprint(room: Room, margin = 0): Rect {
  return {
    minX: room.x - room.width / 2 - margin,
    maxX: room.x + room.width / 2 + margin,
    minZ: room.z - room.depth / 2 - margin,
    maxZ: room.z + room.depth / 2 + margin,
  };
}

export function stairFootprint(stair: Stair, margin = 0.08): Rect {
  return stairPlanFootprint(stair, margin);
}

export function wallAxis(room: Room, side: Side) {
  const horizontal = side === 'north' || side === 'south';
  return {
    horizontal,
    center: horizontal ? room.x : room.z,
    length: horizontal ? room.width : room.depth,
    boundary: horizontal
      ? room.z + ((side === 'north' ? -1 : 1) * room.depth) / 2
      : room.x + ((side === 'west' ? -1 : 1) * room.width) / 2,
  };
}

/** A usable plan pointer target on the room's own side of a wall. SVG line
 * bounds have zero width/height; a door gap may also contain their box center. */
export function planWallHitTarget(room: Room, side: Side): Rect {
  const bounds = roomFootprint(room);
  const thickness = Math.min(
    0.45,
    (side === 'north' || side === 'south' ? room.depth : room.width) / 4,
  );
  if (side === 'north') return { ...bounds, maxZ: bounds.minZ + thickness };
  if (side === 'south') return { ...bounds, minZ: bounds.maxZ - thickness };
  if (side === 'east') return { ...bounds, minX: bounds.maxX - thickness };
  return { ...bounds, maxX: bounds.minX + thickness };
}

function rawWallRects(scene: Scene, room: Room, side: Side): Rect[] {
  const axis = wallAxis(room, side);
  const explicit = roomOpenings(scene, room.id, side);
  if (room[side] === 'open' && !explicit.length) return [];
  const openings = explicit.length
    ? explicit
    : room[side] === 'door'
      ? [
          {
            offset: 0,
            width: Math.min(1.3, axis.length),
            height: Math.min(2.4, room.height),
            sill: 0,
          },
        ]
      : [];
  return subtractRectangles(
    {
      minX: axis.center - axis.length / 2,
      maxX: axis.center + axis.length / 2,
      minZ: room.elevation,
      maxZ: room.elevation + room.height,
    },
    openings.map((opening) => ({
      minX: axis.center + opening.offset - opening.width / 2,
      maxX: axis.center + opening.offset + opening.width / 2,
      minZ: room.elevation + opening.sill,
      maxZ: room.elevation + opening.sill + opening.height,
    })),
  );
}

// Only suppress the solid area actually supplied by a neighboring wall. This
// keeps legacy mismatched doors closed rather than inventing a connection.
export function wallPanels(scene: Scene, room: Room, side: Side, deduplicate = true): WallPanel[] {
  const axis = wallAxis(room, side);
  const neighborCuts = deduplicate
    ? scene.rooms.flatMap((other) => {
        if (other.id >= room.id || ['courtyard', 'terrace'].includes(other.kind)) return [];
        const otherSide = oppositeSide(side);
        if (Math.abs(wallAxis(other, otherSide).boundary - axis.boundary) > 0.03) return [];
        return rawWallRects(scene, other, otherSide);
      })
    : [];
  return rawWallRects(scene, room, side)
    .flatMap((rect) => subtractRectangles(rect, neighborCuts))
    .map((rect) => ({
      offset: (rect.minX + rect.maxX) / 2 - axis.center,
      width: rect.maxX - rect.minX,
      bottom: rect.minZ - room.elevation,
      height: rect.maxZ - rect.minZ,
    }));
}

export function roomSlabs(scene: Scene, room: Room) {
  const roofBounds = roomFootprint(room, 0.3);
  const seamCuts = scene.rooms.flatMap((other) => {
    if (other.id === room.id || ['terrace', 'courtyard'].includes(other.kind)) return [];
    const shared = sharedBoundary(room, other);
    if (!shared) return [];
    const axis = wallAxis(room, shared.sideA);
    const joins = [shared.start, shared.center, shared.end].every((coordinate) => {
      const x = axis.horizontal ? coordinate : axis.boundary;
      const z = axis.horizontal ? axis.boundary : coordinate;
      return Math.abs(roofHeightAt(scene, room, x, z) - roofHeightAt(scene, other, x, z)) < 0.04;
    });
    if (!joins) return [];
    const cut = roomFootprint(other, 0.3);
    if (shared.sideA === 'north') cut.maxZ = axis.boundary;
    if (shared.sideA === 'south') cut.minZ = axis.boundary;
    if (shared.sideA === 'east') cut.minX = axis.boundary;
    if (shared.sideA === 'west') cut.maxX = axis.boundary;
    return [cut];
  });
  const links = getDesign(scene).stairLinks;
  const holes = scene.stairs
    .filter((stair) =>
      links.some((link) => link.stairId === stair.id && link.upperRoomId === room.id),
    )
    .map((stair) => stairFootprint(stair));
  const lowerRooms = scene.rooms
    .filter(
      (other) =>
        other.id !== room.id && Math.abs(other.elevation + other.height - room.elevation) < 0.35,
    )
    .map((other) => roomFootprint(other, 0.1));
  const upperRooms = scene.rooms
    .filter(
      (other) =>
        other.id !== room.id && Math.abs(other.elevation - room.elevation - room.height) < 0.35,
    )
    .map((other) => roomFootprint(other, 0.1));
  const ceilingHoles = scene.stairs
    .filter((stair) =>
      links.some((link) => link.stairId === stair.id && link.lowerRoomId === room.id),
    )
    .filter((stair) => stair.elevation + stair.rise >= room.elevation + room.height - 0.35)
    .map((stair) => stairFootprint(stair));
  return {
    floor: subtractRectangles(roomFootprint(room, 0.08), holes),
    foundation: subtractRectangles(roomFootprint(room), [...holes, ...lowerRooms]),
    roof: subtractRectangles(roofBounds, [...upperRooms, ...ceilingHoles, ...seamCuts]),
    // A pitched prism cannot represent partial shared roofs. Use flat exposed
    // patches for stacked rooms rather than placing a roof inside the room above.
    roofClipped: [...upperRooms, ...ceilingHoles].some(
      (cut) =>
        Math.min(roofBounds.maxX, cut.maxX) - Math.max(roofBounds.minX, cut.minX) > EPSILON &&
        Math.min(roofBounds.maxZ, cut.maxZ) - Math.max(roofBounds.minZ, cut.minZ) > EPSILON,
    ),
  };
}

/** Roof patches are split on the ridge. Their four corners therefore always
 * lie on one plane, including mono-pitch eaves and overhangs. */
export function roofPatches(scene: Scene, room: Room): Rect[] {
  const slabs = roomSlabs(scene, room);
  if (slabs.roofClipped || effectiveRoof(scene, room).style !== 'pitched') return slabs.roof;
  const northSouth = ['north', 'south'].includes(effectiveRoof(scene, room).direction);
  return slabs.roof.flatMap((rect) =>
    northSouth
      ? room.z > rect.minZ && room.z < rect.maxZ
        ? [
            { ...rect, maxZ: room.z },
            { ...rect, minZ: room.z },
          ]
        : [rect]
      : room.x > rect.minX && room.x < rect.maxX
        ? [
            { ...rect, maxX: room.x },
            { ...rect, minX: room.x },
          ]
        : [rect],
  );
}

/** Wall-space upper profile; the minimum eave remains the room's usable height. */
export function wallTopProfile(scene: Scene, room: Room, side: Side): [number, number][] {
  if (
    roomSlabs(scene, room).roofClipped ||
    (room[side] === 'open' && !roomOpenings(scene, room.id, side).length)
  )
    return [];
  const axis = wallAxis(room, side);
  const roof = effectiveRoof(scene, room);
  if (roof.style === 'flat') return [];
  const offsets = [-axis.length / 2, axis.length / 2];
  if (roof.style === 'pitched' && axis.horizontal !== ['north', 'south'].includes(roof.direction))
    offsets.splice(1, 0, 0);
  return offsets.map((offset) => [
    offset,
    roofHeightAt(
      scene,
      room,
      axis.horizontal ? room.x + offset : axis.boundary,
      axis.horizontal ? axis.boundary : room.z + offset,
    ) - room.elevation,
  ]);
}

export function naturalGroundHeight(x: number, z: number, slope: number) {
  return -0.38 - slope * z + Math.sin(x * 0.065) * Math.cos(z * 0.06) * 0.45;
}

/** Cut into the hill beneath occupied footprints, with a soft excavation apron.
 * Never raise terrain through lower rooms or their floor slabs. */
export function terrainHeight(scene: Scene, x: number, z: number) {
  let height = naturalGroundHeight(x, z, scene.slope);
  for (const room of scene.rooms) {
    const dx = Math.max(0, Math.abs(x - room.x) - room.width / 2);
    const dz = Math.max(0, Math.abs(z - room.z) - room.depth / 2);
    const distance = Math.hypot(dx, dz);
    if (distance >= 2) continue;
    const mix = 1 - Math.min(1, distance / 2);
    const smooth = mix * mix * (3 - 2 * mix);
    height = Math.min(height, height + (room.elevation - 0.3 - height) * smooth);
  }
  return height;
}
