import type { Room, Scene, Side, Stair } from '../shared/model';
import { getDesign, oppositeSide, roomOpenings } from '../shared/design';

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
  const radians = (stair.rotation * Math.PI) / 180;
  const width = Math.abs(Math.cos(radians)) * stair.width + Math.abs(Math.sin(radians)) * stair.run;
  const depth = Math.abs(Math.sin(radians)) * stair.width + Math.abs(Math.cos(radians)) * stair.run;
  return {
    minX: stair.x - width / 2 - margin,
    maxX: stair.x + width / 2 + margin,
    minZ: stair.z - depth / 2 - margin,
    maxZ: stair.z + depth / 2 + margin,
  };
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

function rawWallRects(scene: Scene, room: Room, side: Side): Rect[] {
  const axis = wallAxis(room, side);
  const explicit = roomOpenings(scene, room.id, side);
  if (room[side] === 'open' && !explicit.length) return [];
  const openings = explicit.length
    ? explicit
    : room[side] === 'door'
      ? [{ offset: 0, width: Math.min(1.3, axis.length), height: Math.min(2.4, room.height) }]
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
      minZ: room.elevation,
      maxZ: room.elevation + opening.height,
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
  const roofBounds = roomFootprint(room, 0.325);
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
    roof: subtractRectangles(roofBounds, [...upperRooms, ...ceilingHoles]),
    // A pitched prism cannot represent partial shared roofs. Use flat exposed
    // patches for stacked rooms rather than placing a roof inside the room above.
    roofClipped: [...upperRooms, ...ceilingHoles].some(
      (cut) =>
        Math.min(roofBounds.maxX, cut.maxX) - Math.max(roofBounds.minX, cut.minX) > EPSILON &&
        Math.min(roofBounds.maxZ, cut.maxZ) - Math.max(roofBounds.minZ, cut.minZ) > EPSILON,
    ),
  };
}
