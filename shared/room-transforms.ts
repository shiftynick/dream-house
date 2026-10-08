import type { DesignCommand } from './design.ts';
import { roomSchema, type Room, type Scene, type Side, type WallOpening } from './model.ts';
import {
  bounds,
  horizontalSide,
  oppositeSide,
  outdoor,
  round,
  sharedBoundary,
  sides,
} from './geometry.ts';
import { effectiveRoof, roofMaximumHeight } from './architecture.ts';
import { furnitureBounds, roomFurniture } from './furniture.ts';
import { openingWorldCenter, roomOpenings } from './openings.ts';
import { stairPlanFootprint } from './spatial.ts';

type Transform = Extract<
  DesignCommand,
  { type: 'move_shared_wall' | 'split_room' | 'merge_rooms' }
>;
const tolerance = 0.0001;
const equal = (a: number, b: number) => Math.abs(a - b) <= tolerance;
export class RoomTransformError extends Error {
  constructor(
    public code: string,
    message: string,
    public objectIds: string[] = [],
    public details?: Record<string, unknown>,
  ) {
    super(message);
  }
}
function fail(code: string, message: string, ids: string[] = []): never {
  throw new RoomTransformError(code, message, ids);
}
function getRoom(scene: Scene, id: string) {
  return (
    scene.rooms.find((room) => room.id === id) ??
    fail('room_not_found', `Room “${id}” does not exist.`, [id])
  );
}
function wall(room: Room, side: Side) {
  const box = bounds(room),
    horizontal = horizontalSide(side);
  return {
    plane: box[side],
    start: horizontal ? box.west : box.north,
    end: horizontal ? box.east : box.south,
  };
}
function palette(scene: Scene, room: Room, surface: Side | 'floor' | 'roof') {
  return room.surfacePalettes?.[surface] ?? room.palette ?? scene.palette;
}
function setPalette(scene: Scene, room: Room, side: Side, value: Scene['palette']) {
  if (palette(scene, room, side) !== value)
    room.surfacePalettes = { ...room.surfacePalettes, [side]: value };
}
function supported(scene: Scene, rooms: Room[]) {
  const ids = rooms.map((room) => room.id);
  if (rooms.some(outdoor))
    fail(
      'room_transform_outdoor',
      'Room partition transformations require enclosed rooms; terraces and courtyards are not supported.',
      ids,
    );
  if (rooms.some((room) => effectiveRoof(scene, room).style !== 'flat'))
    fail(
      'room_transform_roof',
      'This partition operation supports flat roofs only. Sloped roof shapes need a separate explicit redesign; this batch was left unchanged.',
      ids,
    );
  if (
    rooms.some(
      (room) => !equal(room.elevation, rooms[0].elevation) || !equal(room.height, rooms[0].height),
    )
  )
    fail(
      'room_transform_levels',
      'The rooms must have the same floor elevation and height before transferring or merging space.',
      ids,
    );
  for (const stair of scene.stairs) {
    const footprint = stairPlanFootprint(stair);
    const intersects = rooms.some((room) => {
      const box = bounds(room);
      return (
        Math.min(box.east, footprint.maxX) - Math.max(box.west, footprint.minX) > tolerance &&
        Math.min(box.south, footprint.maxZ) - Math.max(box.north, footprint.minZ) > tolerance &&
        stair.elevation < box.top &&
        stair.elevation + stair.rise > box.bottom - tolerance
      );
    });
    if (
      intersects ||
      scene.design!.stairLinks.some(
        (link) =>
          link.stairId === stair.id &&
          (ids.includes(link.lowerRoomId) || ids.includes(link.upperRoomId)),
      )
    )
      fail(
        'room_transform_stairs',
        'A stair or linked landing touches these rooms. Partitioning around stairs is not supported; keep the current rooms or redesign the stair explicitly first.',
        [...ids, stair.id],
      );
  }
}
function pairBoundary(a: Room, b: Room) {
  if (a.id === b.id) fail('room_transform_pair', 'Choose two distinct adjoining rooms.', [a.id]);
  const shared = sharedBoundary(a, b);
  if (!shared)
    fail(
      'room_transform_adjacency',
      'The rooms must share a complete wall and form one rectangle.',
      [a.id, b.id],
    );
  const aa = wall(a, shared.sideA),
    bb = wall(b, shared.sideB);
  if (!equal(aa.plane, bb.plane) || !equal(aa.start, bb.start) || !equal(aa.end, bb.end))
    fail(
      'room_transform_adjacency',
      'Only a full shared wall with a rectangular union is supported. Partial/T-shaped boundaries must be edited separately.',
      [a.id, b.id],
    );
  return shared;
}

/** Freeze implicit door locations before room centers change. One physical owner
 * also supplies its mirrored aperture, so paired legacy doors are not duplicated. */
function materializeDoors(scene: Scene, rooms: Room[]) {
  const occupied = new Set([
    ...scene.rooms.flatMap((room) => (room.wallOpenings ?? []).map((opening) => opening.id)),
    ...scene.design!.connections.map((connection) => connection.id),
  ]);
  for (const room of rooms)
    for (const side of sides) {
      if (room[side] !== 'door' || roomOpenings(scene, room.id, side).length) continue;
      const center = horizontalSide(side) ? room.x : room.z;
      for (const neighbor of scene.rooms) {
        if (neighbor.id === room.id) continue;
        if (
          neighbor.elevation >= room.elevation + Math.min(2.4, room.height) - tolerance ||
          roofMaximumHeight(scene, neighbor) <= room.elevation + tolerance
        )
          continue;
        const boundary = sharedBoundary(room, neighbor);
        if (
          !boundary ||
          boundary.sideA !== side ||
          center + 0.65 <= boundary.start ||
          center - 0.65 >= boundary.end
        )
          continue;
        const neighborCenter = horizontalSide(side) ? neighbor.x : neighbor.z;
        const matchingLegacy =
          !outdoor(neighbor) &&
          neighbor[boundary.sideB] === 'door' &&
          equal(center, neighborCenter) &&
          equal(Math.min(2.4, room.height), Math.min(2.4, neighbor.height)) &&
          equal(
            Math.min(1.3, horizontalSide(side) ? room.width : room.depth),
            Math.min(1.3, horizontalSide(side) ? neighbor.width : neighbor.depth),
          );
        if (
          !equal(room.elevation, neighbor.elevation) ||
          !matchingLegacy ||
          roomOpenings(scene, neighbor.id, boundary.sideB).length ||
          center - 0.65 < boundary.start - tolerance ||
          center + 0.65 > boundary.end + tolerance ||
          Math.min(2.4, room.height) > neighbor.height
        )
          fail(
            'room_transform_legacy_door',
            'A legacy doorway is blocked, differently sized, partly shared, or faces an open/outdoor edge. Resolve both wall faces explicitly before partitioning so no passage, wall infill, or lost neighboring route is introduced.',
            [room.id, neighbor.id],
          );
      }
      const stem = `legacy-${room.id}-${side}`.slice(0, 52);
      let id = stem,
        suffix = 1;
      while (occupied.has(id)) id = `${stem}-${suffix++}`;
      occupied.add(id);
      room.wallOpenings = [
        ...(room.wallOpenings ?? []),
        {
          id,
          side,
          kind: 'door',
          offset: 0,
          width: Math.min(1.3, horizontalSide(side) ? room.width : room.depth),
          height: Math.min(2.4, room.height),
          sill: 0,
        },
      ];
    }
}

function referenceIds(requirement: NonNullable<Scene['design']>['requirements'][number]): string[] {
  switch (requirement.kind) {
    case 'locked':
      return [requirement.roomId];
    case 'connectivity':
      return [...requirement.roomIds, requirement.targetRoomId];
    case 'symmetry':
      return requirement.pairs.flatMap((pair) => [pair.roomAId, pair.roomBId]);
    case 'overlook':
      return [requirement.upperRoomId, requirement.lowerRoomId];
    default:
      return [];
  }
}

/** Mutates only an executeCommands clone. The caller validates locks, geometry
 * and preserved routes before accepting; any failure rolls back the whole batch. */
export function transformRooms(scene: Scene, command: Transform): string[] {
  const rooms =
    command.type === 'split_room'
      ? [getRoom(scene, command.roomId)]
      : [getRoom(scene, command.roomAId), getRoom(scene, command.roomBId)];
  supported(scene, rooms);
  const boundary = rooms.length === 2 ? pairBoundary(rooms[0], rooms[1]) : null;
  if (
    command.type === 'split_room' &&
    [...scene.rooms, ...scene.stairs].some((object) => object.id === command.newRoomId)
  )
    fail('duplicate_id', 'The new room ID is already in use. Supply a distinct stable ID.', [
      command.newRoomId,
    ]);
  if (command.type === 'merge_rooms') {
    const references = scene.design!.requirements.filter((requirement) =>
      referenceIds(requirement).includes(command.roomBId),
    );
    if (references.length)
      fail(
        'merge_requirement_reference',
        'The room being removed is referenced by a design requirement. Resolve that requirement explicitly before merging; snapshots and confirmed requirements are never rewritten.',
        [command.roomBId, ...references.map((requirement) => requirement.id)],
      );
  }
  if (command.type !== 'split_room') {
    for (const surface of ['floor', 'roof'] as const)
      if (palette(scene, rooms[0], surface) !== palette(scene, rooms[1], surface))
        fail(
          command.type === 'merge_rooms'
            ? 'merge_finish_conflict'
            : 'room_transform_finish_conflict',
          `The ${surface} finishes differ. Harmonize that specific finish explicitly before merging or transferring floor area.`,
          rooms.map((room) => room.id),
        );
  }
  materializeDoors(scene, rooms);
  const original = structuredClone(rooms);
  const outputs = structuredClone(rooms);
  if (command.type === 'split_room') {
    const room = outputs[0],
      dimension = command.axis === 'x' ? 'width' : 'depth';
    const length = room[dimension],
      split = room[command.axis] + command.offset;
    const next = structuredClone(room);
    next.id = command.newRoomId;
    next.name = command.newRoomName;
    next.kind = command.newRoomKind ?? room.kind;
    if (outdoor(next))
      fail(
        'room_transform_outdoor',
        'A partition creates an enclosed room; choose an enclosed room kind.',
        [next.id],
      );
    room[dimension] = round(length / 2 + command.offset);
    next[dimension] = round(length / 2 - command.offset);
    room[command.axis] = round(split - room[dimension] / 2);
    next[command.axis] = round(split + next[dimension] / 2);
    outputs.push(next);
  } else if (command.type === 'move_shared_wall') {
    const axis = horizontalSide(boundary!.sideA) ? 'z' : 'x',
      dimension = axis === 'x' ? 'width' : 'depth';
    const sign = ['east', 'south'].includes(boundary!.sideA) ? 1 : -1;
    outputs[0][dimension] = round(outputs[0][dimension] + command.delta);
    outputs[1][dimension] = round(outputs[1][dimension] - command.delta);
    for (const room of outputs) room[axis] = round(room[axis] + (sign * command.delta) / 2);
  } else {
    const a = bounds(rooms[0]),
      b = bounds(rooms[1]);
    outputs[0].width = round(Math.max(a.east, b.east) - Math.min(a.west, b.west));
    outputs[0].depth = round(Math.max(a.south, b.south) - Math.min(a.north, b.north));
    outputs[0].x = round((Math.max(a.east, b.east) + Math.min(a.west, b.west)) / 2);
    outputs[0].z = round((Math.max(a.south, b.south) + Math.min(a.north, b.north)) / 2);
    outputs[0].name = command.name ?? outputs[0].name;
    outputs.splice(1, 1);
  }
  for (const room of outputs) {
    if (room.width < 1.5 || room.depth < 1.5 || room.width > 30 || room.depth > 30)
      fail(
        'room_transform_dimensions',
        'Each resulting room must remain 1.5–30 m wide and deep. Move the partition less or choose a different split offset.',
        outputs.map((room) => room.id),
      );
    room.furniture = [];
    room.wallOpenings = [];
  }
  const internalSide = (room: Room, side: Side) =>
    boundary && side === (room.id === original[0].id ? boundary.sideA : boundary.sideB);
  // A saved wall has only one finish/whole-wall flag. Never flatten two differing
  // exterior segments into an arbitrary survivor's material or glass/solid style.
  for (const room of outputs)
    for (const side of sides) {
      const edge = wall(room, side);
      const sources = original.filter((source) => {
        const old = wall(source, side);
        return (
          !internalSide(source, side) &&
          equal(old.plane, edge.plane) &&
          Math.min(old.end, edge.end) - Math.max(old.start, edge.start) > tolerance
        );
      });
      const style = (source: Room) =>
        roomOpenings(scene, source.id, side).length ? 'solid' : source[side];
      if (sources.length) {
        if (
          sources.some(
            (source) =>
              style(source) !== style(sources[0]) ||
              palette(scene, source, side) !== palette(scene, sources[0], side),
          )
        )
          fail(
            'room_transform_finish_conflict',
            `The combined ${side} exterior wall has different finishes or glass/open/solid sections. Harmonize that specific wall explicitly before changing this partition.`,
            original.map((source) => source.id),
          );
        room[side] = style(sources[0]);
        setPalette(scene, room, side, palette(scene, sources[0], side));
      } else if (command.type === 'move_shared_wall') {
        const source = original.find((source) => source.id === room.id)!;
        room[side] = style(source);
      } else {
        room[side] = 'solid';
        if (room.surfacePalettes) delete room.surfacePalettes[side];
      }
    }
  const ownerAt = (side: Side, plane: number, center: number, width: number, objectId: string) => {
    const candidates = outputs.filter((room) => {
      const edge = wall(room, side);
      return (
        equal(edge.plane, plane) &&
        center - width / 2 >= edge.start - tolerance &&
        center + width / 2 <= edge.end + tolerance
      );
    });
    if (candidates.length !== 1)
      fail(
        'room_transform_opening_cut',
        `The partition would cut or detach opening “${objectId}”. Move that opening or choose another partition position.`,
        [objectId, ...original.map((room) => room.id)],
      );
    return candidates[0];
  };
  for (const source of original)
    for (const opening of source.wallOpenings ?? []) {
      const internal = internalSide(source, opening.side);
      if (internal && command.type === 'merge_rooms') continue;
      const center = openingWorldCenter(source, opening);
      const owner =
        internal && command.type === 'move_shared_wall'
          ? outputs.find((room) => room.id === source.id)!
          : ownerAt(
              opening.side,
              wall(source, opening.side).plane,
              center,
              opening.width,
              opening.id,
            );
      owner.wallOpenings!.push({
        ...opening,
        offset: round(center - (horizontalSide(opening.side) ? owner.x : owner.z)),
      });
    }
  for (const source of original)
    for (const item of roomFurniture(source)) {
      const world = { x: source.x + item.x, z: source.z + item.z },
        size = furnitureBounds(item);
      const owner = outputs.find(
        (room) =>
          Math.abs(world.x - room.x) + size.width / 2 <= room.width / 2 + tolerance &&
          Math.abs(world.z - room.z) + size.depth / 2 <= room.depth / 2 + tolerance,
      );
      if (!owner)
        fail(
          'room_transform_furniture_cut',
          `The partition would cut through “${item.name}” or leave it outside a room. Move the furniture or adjust the partition first.`,
          [source.id, item.id],
        );
      if (owner.furniture!.some((existing) => existing.id === item.id))
        fail(
          'room_transform_furniture_id',
          `Furniture ID “${item.id}” would occur twice in the merged room. Give the pieces distinct IDs explicitly before merging.`,
          [source.id, owner.id, item.id],
        );
      owner.furniture!.push({
        ...item,
        x: round(world.x - owner.x),
        z: round(world.z - owner.z),
        ...(!item.palette && (source.palette ?? scene.palette) !== (owner.palette ?? scene.palette)
          ? { palette: source.palette ?? scene.palette }
          : {}),
      });
    }
  if (
    command.type !== 'merge_rooms' &&
    scene.fireplace &&
    scene.fireplace.elevation < original[0].elevation + original[0].height - tolerance &&
    scene.fireplace.elevation + scene.fireplace.height > original[0].elevation + tolerance
  ) {
    const fire = scene.fireplace;
    const touches = original.some(
      (room) =>
        Math.abs(fire.x - room.x) < room.width / 2 + 1.2 &&
        Math.abs(fire.z - room.z) < room.depth / 2 + 0.8,
    );
    if (
      touches &&
      !outputs.some(
        (room) =>
          Math.abs(fire.x - room.x) + 1.2 <= room.width / 2 + tolerance &&
          Math.abs(fire.z - room.z) + 0.8 <= room.depth / 2 + tolerance,
      )
    )
      fail(
        'room_transform_fireplace_cut',
        'The new partition would cut through the existing fireplace hearth. Move the fireplace or choose a different partition.',
        original.map((room) => room.id),
      );
  }
  const affected = new Set(original.map((room) => room.id));
  scene.design!.connections = scene.design!.connections.flatMap((connection) => {
    const within = affected.has(connection.roomAId) && affected.has(connection.roomBId);
    if (within && command.type === 'merge_rooms') return [];
    if (within) return [connection];
    for (const endpoint of ['roomAId', 'roomBId'] as const) {
      const source = original.find((room) => room.id === connection[endpoint]);
      if (!source) continue;
      const side = endpoint === 'roomAId' ? connection.sideA : oppositeSide(connection.sideA);
      connection[endpoint] = ownerAt(
        side,
        wall(source, side).plane,
        connection.center,
        connection.width,
        connection.id,
      ).id;
    }
    return [connection];
  });
  if (command.type === 'split_room' && command.passage) {
    const p = command.passage,
      side = command.axis === 'x' ? 'east' : 'south';
    if (
      scene.design!.connections.some((connection) => connection.id === p.id) ||
      scene.rooms.some((room) => room.wallOpenings?.some((opening) => opening.id === p.id))
    )
      fail('duplicate_opening_id', 'The split passage needs a distinct stable opening ID.', [p.id]);
    const edge = wall(outputs[0], side),
      center = p.center ?? (edge.start + edge.end) / 2;
    if (
      p.width > edge.end - edge.start - 0.04 ||
      center - p.width / 2 < edge.start + 0.02 - tolerance ||
      center + p.width / 2 > edge.end - 0.02 + tolerance ||
      p.height > outputs[0].height
    )
      fail(
        'split_passage_dimensions',
        'The split passage must fit the new wall with 0.02 m clearance at each end and stay below the ceiling.',
        [p.id],
      );
    scene.design!.connections.push({
      id: p.id,
      roomAId: outputs[0].id,
      roomBId: outputs[1].id,
      sideA: side,
      center,
      width: p.width,
      height: p.kind === 'open' ? outputs[0].height : p.height,
      kind: p.kind,
    });
  }
  for (const room of outputs) {
    for (const connection of scene.design!.connections) {
      const side =
        connection.roomAId === room.id
          ? connection.sideA
          : connection.roomBId === room.id
            ? oppositeSide(connection.sideA)
            : null;
      if (side) room[side] = connection.kind;
    }
    if (!room.wallOpenings!.length) delete room.wallOpenings;
    roomSchema.parse(room);
  }
  scene.rooms = scene.rooms.flatMap((room) =>
    room.id === original[0].id ? outputs : affected.has(room.id) ? [] : [room],
  );
  for (const group of scene.design!.groups) {
    if (command.type === 'split_room' && group.roomIds.includes(command.roomId))
      group.roomIds = group.roomIds.flatMap((id) =>
        id === command.roomId ? [id, command.newRoomId] : [id],
      );
    if (command.type === 'merge_rooms')
      group.roomIds = [
        ...new Set(group.roomIds.map((id) => (id === command.roomBId ? command.roomAId : id))),
      ];
  }
  return [...new Set([...original, ...outputs].map((room) => room.id))];
}
