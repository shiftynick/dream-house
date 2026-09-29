import type { Room, Scene, Side, WallOpening } from './model.ts';
import { close, horizontalSide, oppositeSide, round, sharedBoundary } from './geometry.ts';
import { roofHeightAt } from './architecture.ts';
import type { DesignIssue } from './design.ts';

export type ResolvedWallOpening = Omit<WallOpening, 'side'> & {
  source: 'explicit' | 'connection';
  sourceRoomId: string;
};

export function openingWorldCenter(room: Room, opening: Pick<WallOpening, 'side' | 'offset'>) {
  return (horizontalSide(opening.side) ? room.x : room.z) + opening.offset;
}

/** Physical apertures have one owner. Their opposite-face representation is
 * derived, so moving a room cannot leave behind a second, stale opening record.
 */
export function wallOpeningHeightLimit(
  scene: Scene,
  room: Room,
  side: Side,
  offset: number,
  width: number,
) {
  const coordinates = [-1, 1].map((sign) =>
    horizontalSide(side)
      ? {
          x: room.x + offset + (sign * width) / 2,
          z: room.z + (side === 'north' ? -room.depth / 2 : room.depth / 2),
        }
      : {
          x: room.x + (side === 'west' ? -room.width / 2 : room.width / 2),
          z: room.z + offset + (sign * width) / 2,
        },
  );
  return Math.min(
    ...coordinates.map((point) => roofHeightAt(scene, room, point.x, point.z) - room.elevation),
  );
}

export function mirroredOpening(
  scene: Scene,
  owner: Room,
  opening: WallOpening,
  receiver: Room,
): WallOpening | null {
  const boundary = sharedBoundary(owner, receiver);
  if (!boundary || boundary.sideA !== opening.side) return null;
  const center = openingWorldCenter(owner, opening);
  if (
    center - opening.width / 2 < boundary.start - 0.01 ||
    center + opening.width / 2 > boundary.end + 0.01
  )
    return null;
  const sill = owner.elevation + opening.sill - receiver.elevation;
  const offset = round(center - (horizontalSide(boundary.sideB) ? receiver.x : receiver.z));
  if (
    sill < -0.01 ||
    sill + opening.height >
      wallOpeningHeightLimit(scene, receiver, boundary.sideB, offset, opening.width) + 0.01
  )
    return null;
  // A floor-level passage must meet both floors; a high window may be shared
  // between split levels when its full physical aperture fits both wall faces.
  if (opening.kind !== 'window' && !close(owner.elevation, receiver.elevation)) {
    const hasStair = (scene.design?.stairLinks ?? []).some(
      (link) =>
        (link.lowerRoomId === owner.id && link.upperRoomId === receiver.id) ||
        (link.upperRoomId === owner.id && link.lowerRoomId === receiver.id),
    );
    if (!hasStair) return null;
  }
  return {
    ...opening,
    side: boundary.sideB,
    offset,
    sill: round(Math.max(0, sill)),
  };
}

export function roomOpenings(scene: Scene, roomId: string, side: Side): ResolvedWallOpening[] {
  const room = scene.rooms.find((candidate) => candidate.id === roomId);
  if (!room) return [];
  const result: ResolvedWallOpening[] = [];
  for (const owner of scene.rooms)
    for (const original of owner.wallOpenings ?? []) {
      const opening =
        owner.id === room.id ? original : mirroredOpening(scene, owner, original, room);
      if (!opening || opening.side !== side) continue;
      const { side: _side, ...dimensions } = opening;
      result.push({ ...dimensions, source: 'explicit', sourceRoomId: owner.id });
    }
  for (const connection of scene.design?.connections ?? []) {
    if (!(
      (connection.roomAId === roomId && connection.sideA === side) ||
      (connection.roomBId === roomId && oppositeSide(connection.sideA) === side)
    ))
      continue;
    result.push({
      id: connection.id,
      offset: round(connection.center - (horizontalSide(side) ? room.x : room.z)),
      width: connection.width,
      height: connection.kind === 'open' ? room.height : connection.height,
      sill: 0,
      kind: connection.kind,
      source: 'connection',
      sourceRoomId: connection.roomAId,
    });
  }
  return result.sort((a, b) => a.offset - b.offset || a.sill - b.sill || a.id.localeCompare(b.id));
}

/** Validate physical aperture rectangles, not just legacy whole-wall flags. */
export function validateOpenings(scene: Scene): DesignIssue[] {
  const issues: DesignIssue[] = [];
  const seen = new Set((scene.design?.connections ?? []).map((connection) => connection.id));
  const add = (
    code: string,
    message: string,
    objectIds: string[],
    details?: Record<string, unknown>,
  ) =>
    issues.push({ code, severity: 'error', message, objectIds, ...(details ? { details } : {}) });
  for (const room of scene.rooms) {
    for (const opening of room.wallOpenings ?? []) {
      const ids = [room.id, opening.id];
      if (seen.has(opening.id))
        add(
          'duplicate_opening_id',
          'Explicit openings and semantic connections need distinct stable IDs.',
          ids,
        );
      seen.add(opening.id);
      const length = horizontalSide(opening.side) ? room.width : room.depth;
      if (Math.abs(opening.offset) + opening.width / 2 > length / 2 + 0.01)
        add(
          'opening_outside_wall',
          `“${opening.id}” extends beyond the ${opening.side} wall of “${room.name}”.`,
          ids,
          {
            wallLength: length,
            openingStart: opening.offset - opening.width / 2,
            openingEnd: opening.offset + opening.width / 2,
          },
        );
      const limit = wallOpeningHeightLimit(
        scene,
        room,
        opening.side,
        opening.offset,
        opening.width,
      );
      if (opening.sill + opening.height > limit + 0.01)
        add(
          'opening_too_high',
          `“${opening.id}” extends above the wall or sloping roof edge of “${room.name}”.`,
          ids,
          { maximumHeadHeight: round(limit), requestedHeadHeight: opening.sill + opening.height },
        );
      if (
        opening.kind !== 'window' &&
        (opening.sill > 0.01 || opening.width < 0.75 || opening.height < 2)
      )
        add(
          'passage_dimensions',
          'Doors and open passages must start at floor level and provide at least 0.75 m width and 2 m height.',
          ids,
          { sill: opening.sill, width: opening.width, height: opening.height },
        );
      for (const neighbor of scene.rooms) {
        if (neighbor.id === room.id) continue;
        const boundary = sharedBoundary(room, neighbor);
        if (!boundary || boundary.sideA !== opening.side) continue;
        const center = openingWorldCenter(room, opening);
        const horizontalOverlap =
          Math.min(center + opening.width / 2, boundary.end) -
          Math.max(center - opening.width / 2, boundary.start);
        const receiverOffset = center - (horizontalSide(boundary.sideB) ? neighbor.x : neighbor.z);
        const neighborTop =
          neighbor.elevation +
          wallOpeningHeightLimit(scene, neighbor, boundary.sideB, receiverOffset, opening.width);
        const verticalOverlap =
          Math.min(room.elevation + opening.sill + opening.height, neighborTop) -
          Math.max(room.elevation + opening.sill, neighbor.elevation);
        if (
          horizontalOverlap > 0.02 &&
          verticalOverlap > 0.02 &&
          !mirroredOpening(scene, room, opening, neighbor)
        )
          add(
            'opening_shared_wall_conflict',
            `“${opening.id}” is partly blocked by the shared wall or floor of “${neighbor.name}”. Fit it inside one shared wall segment; connect split levels with stairs.`,
            [room.id, neighbor.id, opening.id],
            {
              horizontalOverlap: round(horizontalOverlap),
              verticalOverlap: round(verticalOverlap),
            },
          );
      }
    }
    for (const side of ['north', 'south', 'east', 'west'] as const) {
      const openings = roomOpenings(scene, room.id, side);
      for (let i = 0; i < openings.length; i++)
        for (let j = i + 1; j < openings.length; j++) {
          const a = openings[i],
            b = openings[j];
          const horizontalOverlap =
            Math.min(a.offset + a.width / 2, b.offset + b.width / 2) -
            Math.max(a.offset - a.width / 2, b.offset - b.width / 2);
          const verticalOverlap =
            Math.min(a.sill + a.height, b.sill + b.height) - Math.max(a.sill, b.sill);
          if (horizontalOverlap > 0.01 && verticalOverlap > 0.01)
            add(
              'opening_overlap',
              `“${a.id}” and “${b.id}” overlap on the ${side} wall of “${room.name}”. Keep their aperture rectangles separate.`,
              [room.id, a.id, b.id],
              {
                horizontalOverlap: round(horizontalOverlap),
                verticalOverlap: round(verticalOverlap),
              },
            );
        }
    }
  }
  return issues;
}
