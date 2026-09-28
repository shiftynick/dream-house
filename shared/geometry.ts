import type { Room, Side, Stair } from './model.ts';

export const GEOMETRY_TOLERANCE = 0.03;
export const sides: Side[] = ['north', 'south', 'east', 'west'];
export const oppositeSide = (side: Side): Side =>
  ({ north: 'south', south: 'north', east: 'west', west: 'east' })[side] as Side;
export const horizontalSide = (side: Side) => side === 'north' || side === 'south';
export const outdoor = (room: Room) => room.kind === 'courtyard' || room.kind === 'terrace';
export const close = (a: number, b: number, tolerance = GEOMETRY_TOLERANCE) =>
  Math.abs(a - b) <= tolerance;
export const round = (value: number) => Math.round(value * 10000) / 10000;

export function bounds(room: Room) {
  return {
    west: room.x - room.width / 2,
    east: room.x + room.width / 2,
    north: room.z - room.depth / 2,
    south: room.z + room.depth / 2,
    bottom: room.elevation,
    top: room.elevation + room.height,
  };
}

export type SharedBoundary = {
  sideA: Side;
  sideB: Side;
  start: number;
  end: number;
  length: number;
  center: number;
};

/** Plan adjacency only: floor levels are checked by the caller. */
export function sharedBoundary(a: Room, b: Room): SharedBoundary | null {
  const aa = bounds(a),
    bb = bounds(b);
  for (const sideA of sides) {
    const sideB = oppositeSide(sideA);
    if (!close(aa[sideA], bb[sideB])) continue;
    const horizontal = horizontalSide(sideA);
    const start = Math.max(horizontal ? aa.west : aa.north, horizontal ? bb.west : bb.north);
    const end = Math.min(horizontal ? aa.east : aa.south, horizontal ? bb.east : bb.south);
    if (end - start <= GEOMETRY_TOLERANCE) continue;
    return { sideA, sideB, start, end, length: end - start, center: (start + end) / 2 };
  }
  return null;
}

export function volumeOverlap(a: Room, b: Room) {
  const aa = bounds(a),
    bb = bounds(b);
  const x = Math.min(aa.east, bb.east) - Math.max(aa.west, bb.west);
  const z = Math.min(aa.south, bb.south) - Math.max(aa.north, bb.north);
  const y = Math.min(aa.top, bb.top) - Math.max(aa.bottom, bb.bottom);
  return x > GEOMETRY_TOLERANCE && z > GEOMETRY_TOLERANCE && y > GEOMETRY_TOLERANCE
    ? { x: round(x), z: round(z), y: round(y) }
    : null;
}

export function stairEndpoints(stair: Stair) {
  const angle = (stair.rotation * Math.PI) / 180;
  const dx = (Math.sin(angle) * stair.run) / 2;
  const dz = (Math.cos(angle) * stair.run) / 2;
  return {
    bottom: { x: stair.x - dx, z: stair.z - dz, elevation: stair.elevation },
    top: { x: stair.x + dx, z: stair.z + dz, elevation: stair.elevation + stair.rise },
  };
}

export function containsPoint(room: Room, point: { x: number; z: number }, margin = 0) {
  const box = bounds(room);
  return (
    point.x >= box.west + margin - GEOMETRY_TOLERANCE &&
    point.x <= box.east - margin + GEOMETRY_TOLERANCE &&
    point.z >= box.north + margin - GEOMETRY_TOLERANCE &&
    point.z <= box.south - margin + GEOMETRY_TOLERANCE
  );
}

export function connectedComponents(ids: string[], edges: Array<[string, string]>) {
  const allowed = new Set(ids);
  const neighbors = new Map(ids.map((id) => [id, new Set<string>()]));
  for (const [a, b] of edges) {
    if (!allowed.has(a) || !allowed.has(b)) continue;
    neighbors.get(a)!.add(b);
    neighbors.get(b)!.add(a);
  }
  const seen = new Set<string>();
  const result: string[][] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    const component: string[] = [],
      queue = [id];
    seen.add(id);
    for (let i = 0; i < queue.length; i++) {
      const current = queue[i];
      component.push(current);
      for (const next of neighbors.get(current) ?? [])
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
    }
    result.push(component);
  }
  return result;
}
