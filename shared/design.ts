import { z } from 'zod';
import {
  connectionSchema,
  groupSchema,
  paletteSchema,
  requirementSchema,
  roomSchema,
  sceneSchema,
  sideSchema,
  stairSchema,
  surfaceSchema,
  wallSchema,
  type Connection,
  type DesignMetadata,
  type DesignRequirement,
  type Room,
  type Scene,
  type Side,
  type Surface,
} from './model.ts';
import {
  bounds,
  close,
  connectedComponents,
  containsPoint,
  horizontalSide,
  oppositeSide,
  outdoor,
  round,
  sharedBoundary,
  sides,
  stairEndpoints,
  volumeOverlap,
} from './geometry.ts';
import { inspectSpatial } from './spatial.ts';

export { oppositeSide } from './geometry.ts';
export type DesignIssue = {
  code: string;
  severity: 'error' | 'warning';
  message: string;
  objectIds: string[];
  details?: Record<string, unknown>;
};
export type DesignChange = { operation: string; objectIds: string[]; description: string };

const id = z.string().min(1).max(60);
const ids = z.array(id).min(1).max(32);
const delta = z.number().min(-120).max(120);
const dimensions = z.number().min(1.5).max(30);
const alignment = z.enum(['start', 'center', 'end', 'preserve']).default('center');
const opening = {
  kind: z.enum(['door', 'open']).default('door'),
  width: z.number().min(0.8).max(30).default(1.3),
  height: z.number().min(2).max(10).default(2.4),
};
const attach = {
  targetRoomId: id,
  side: sideSchema,
  alignment,
  connect: z.boolean().default(true),
  ...opening,
};

/** Public, transport-independent command contract. All coordinates and lengths are meters. */
export const commandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('add_rooms'), rooms: z.array(roomSchema).min(1).max(32) }).strict(),
  z
    .object({
      type: z.literal('update_room'),
      roomId: id,
      patch: z
        .object({
          name: roomSchema.shape.name.optional(),
          kind: roomSchema.shape.kind.optional(),
          height: roomSchema.shape.height.optional(),
          north: wallSchema.optional(),
          south: wallSchema.optional(),
          east: wallSchema.optional(),
          west: wallSchema.optional(),
        })
        .strict(),
    })
    .strict(),
  z.object({ type: z.literal('remove_objects'), ids: z.array(id).min(1).max(44) }).strict(),
  z.object({ type: z.literal('define_group'), group: groupSchema }).strict(),
  z.object({ type: z.literal('remove_group'), groupId: id }).strict(),
  z
    .object({
      type: z.literal('move_group'),
      roomIds: ids,
      dx: delta,
      dz: delta,
      elevationDelta: z.number().min(-30).max(30).default(0),
      includeGroups: z.boolean().default(true),
    })
    .strict(),
  z
    .object({
      type: z.literal('attach_room'),
      roomId: id,
      moveGroup: z.boolean().default(true),
      ...attach,
    })
    .strict(),
  z.object({ type: z.literal('attach_wing'), groupId: id, anchorRoomId: id, ...attach }).strict(),
  z
    .object({
      type: z.literal('resize_room'),
      roomId: id,
      width: dimensions.optional(),
      depth: dimensions.optional(),
      height: roomSchema.shape.height.optional(),
      anchor: z.enum(['center', 'north', 'south', 'east', 'west']),
      moveConnected: z.boolean().default(true),
    })
    .strict(),
  z
    .object({
      type: z.literal('connect_rooms'),
      roomAId: id,
      roomBId: id,
      ...opening,
      center: z.number().min(-90).max(90).optional(),
    })
    .strict(),
  z.object({ type: z.literal('disconnect_rooms'), roomAId: id, roomBId: id }).strict(),
  z
    .object({
      type: z.literal('set_material'),
      palette: paletteSchema,
      roomIds: z.array(id).max(32).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('set_surface_material'),
      roomId: id,
      surface: surfaceSchema,
      palette: paletteSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('move_wall'),
      roomId: id,
      side: sideSchema,
      delta: z.number().min(-28.5).max(28.5),
    })
    .strict(),
  z
    .object({
      type: z.literal('update_site'),
      name: sceneSchema.shape.name.optional(),
      slope: sceneSchema.shape.slope.optional(),
      roof: sceneSchema.shape.roof.optional(),
    })
    .strict(),
  z.object({ type: z.literal('set_fireplace'), fireplace: sceneSchema.shape.fireplace }).strict(),
  z.object({ type: z.literal('add_stairs'), stairs: z.array(stairSchema).min(1).max(12) }).strict(),
  z
    .object({ type: z.literal('link_stairs'), stairId: id, lowerRoomId: id, upperRoomId: id })
    .strict(),
  z
    .object({
      type: z.literal('connect_levels'),
      stairId: id,
      lowerRoomId: id,
      upperRoomId: id,
      width: stairSchema.shape.width.default(1.2),
      run: stairSchema.shape.run.default(5),
    })
    .strict(),
  z.object({ type: z.literal('set_requirement'), requirement: requirementSchema }).strict(),
  z.object({ type: z.literal('remove_requirement'), requirementId: id }).strict(),
]);
export type DesignCommand = z.infer<typeof commandSchema>;
export const commandsSchema = z.array(commandSchema).min(1).max(64);

export function getDesign(scene: Scene): DesignMetadata {
  return scene.design ?? { groups: [], connections: [], stairLinks: [], requirements: [] };
}

export const surfaces: Surface[] = ['north', 'south', 'east', 'west', 'floor', 'roof'];
export function effectiveSurfacePalettes(
  scene: Scene,
  room: Room,
): Record<Surface, Scene['palette']> {
  return Object.fromEntries(
    surfaces.map((surface) => [
      surface,
      room.surfacePalettes?.[surface] ?? room.palette ?? scene.palette,
    ]),
  ) as Record<Surface, Scene['palette']>;
}

export function roomOpenings(scene: Scene, roomId: string, side: Side) {
  const room = scene.rooms.find((candidate) => candidate.id === roomId);
  if (!room) return [];
  return getDesign(scene)
    .connections.filter(
      (connection) =>
        (connection.roomAId === roomId && connection.sideA === side) ||
        (connection.roomBId === roomId && oppositeSide(connection.sideA) === side),
    )
    .map((connection) => ({
      id: connection.id,
      offset: round(connection.center - (horizontalSide(side) ? room.x : room.z)),
      width: connection.width,
      height: connection.kind === 'open' ? room.height : connection.height,
    }));
}

function issue(
  code: string,
  message: string,
  objectIds: string[],
  severity: DesignIssue['severity'] = 'error',
  details?: Record<string, unknown>,
): DesignIssue {
  return { code, severity, message, objectIds, ...(details ? { details } : {}) };
}
class CommandError extends Error {
  constructor(
    public code: string,
    message: string,
    public objectIds: string[] = [],
    public details?: Record<string, unknown>,
  ) {
    super(message);
  }
}
function roomById(scene: Scene, roomId: string) {
  const room = scene.rooms.find((room) => room.id === roomId);
  if (!room)
    throw new CommandError(
      'room_not_found',
      `Room “${roomId}” does not exist. Inspect the current room IDs.`,
      [roomId],
    );
  return room;
}
function ensureDistinct(values: string[], description: string) {
  if (new Set(values).size !== values.length)
    throw new CommandError('duplicate_id', `${description} must have unique IDs.`, values);
}
function expandGroups(scene: Scene, roomIds: string[]) {
  const selected = new Set(roomIds);
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const group of getDesign(scene).groups)
      if (group.roomIds.some((id) => selected.has(id))) {
        for (const id of group.roomIds)
          if (!selected.has(id)) {
            selected.add(id);
            expanded = true;
          }
      }
  }
  return [...selected];
}
function pair(connection: Connection, a: string, b: string) {
  return (
    (connection.roomAId === a && connection.roomBId === b) ||
    (connection.roomAId === b && connection.roomBId === a)
  );
}

function syncConnections(scene: Scene, previous: Scene) {
  for (const connection of getDesign(scene).connections) {
    const a = scene.rooms.find((r) => r.id === connection.roomAId);
    const b = scene.rooms.find((r) => r.id === connection.roomBId);
    if (!a || !b) continue;
    const boundary = sharedBoundary(a, b);
    if (!boundary || !close(a.elevation, b.elevation) || boundary.length < connection.width)
      continue;
    const oldA = previous.rooms.find((r) => r.id === a.id),
      oldB = previous.rooms.find((r) => r.id === b.id);
    let center = connection.center;
    if (oldA && oldB) {
      const axis = horizontalSide(boundary.sideA) ? 'x' : 'z';
      if (close(a[axis] - oldA[axis], b[axis] - oldB[axis])) center += a[axis] - oldA[axis];
    }
    connection.sideA = boundary.sideA;
    connection.center = round(
      Math.max(
        boundary.start + connection.width / 2,
        Math.min(boundary.end - connection.width / 2, center),
      ),
    );
    a[boundary.sideA] = connection.kind;
    b[boundary.sideB] = connection.kind;
  }
}

function translate(scene: Scene, roomIds: string[], dx: number, dz: number, elevationDelta = 0) {
  const before = structuredClone(scene);
  const selected = new Set(roomIds);
  for (const id of selected) {
    const room = roomById(scene, id);
    room.x = round(room.x + dx);
    room.z = round(room.z + dz);
    room.elevation = round(room.elevation + elevationDelta);
  }
  // Linked stairs are part of a moved assembly only when both floors move together.
  for (const link of getDesign(scene).stairLinks)
    if (selected.has(link.lowerRoomId) && selected.has(link.upperRoomId)) {
      const stair = scene.stairs.find((s) => s.id === link.stairId);
      if (stair) {
        stair.x = round(stair.x + dx);
        stair.z = round(stair.z + dz);
        stair.elevation = round(stair.elevation + elevationDelta);
      }
    }
  // A fireplace belongs to the lowest enclosed room containing its base.
  if (scene.fireplace) {
    const owner = before.rooms.find(
      (r) =>
        !outdoor(r) &&
        close(r.elevation, scene.fireplace!.elevation) &&
        containsPoint(r, scene.fireplace!),
    );
    if (owner && selected.has(owner.id)) {
      scene.fireplace.x = round(scene.fireplace.x + dx);
      scene.fireplace.z = round(scene.fireplace.z + dz);
      scene.fireplace.elevation = round(scene.fireplace.elevation + elevationDelta);
    }
  }
  syncConnections(scene, before);
}

function connect(
  scene: Scene,
  aId: string,
  bId: string,
  options: { kind: 'door' | 'open'; width: number; height: number; center?: number },
) {
  if (aId === bId)
    throw new CommandError('self_connection', 'A room cannot connect to itself.', [aId]);
  const a = roomById(scene, aId),
    b = roomById(scene, bId);
  const boundary = sharedBoundary(a, b);
  if (!boundary)
    throw new CommandError(
      'no_shared_wall',
      `“${a.name}” and “${b.name}” do not share a wall. Attach them before connecting.`,
      [aId, bId],
    );
  if (!close(a.elevation, b.elevation))
    throw new CommandError(
      'different_floors',
      `“${a.name}” and “${b.name}” are on different floors. Use connect_levels or link_stairs.`,
      [aId, bId],
      { elevations: [a.elevation, b.elevation] },
    );
  if (options.width > boundary.length - 0.04)
    throw new CommandError(
      'opening_too_wide',
      `The shared wall is ${round(boundary.length)} m long; the opening needs 0.02 m clearance on each end.`,
      [aId, bId],
      { maximumWidth: round(boundary.length - 0.04) },
    );
  const height = options.kind === 'open' ? Math.min(a.height, b.height) : options.height;
  if (height > Math.min(a.height, b.height))
    throw new CommandError('opening_too_high', 'The opening is taller than one of its rooms.', [
      aId,
      bId,
    ]);
  const center = options.center ?? boundary.center;
  if (
    center - options.width / 2 < boundary.start - 0.001 ||
    center + options.width / 2 > boundary.end + 0.001
  )
    throw new CommandError(
      'opening_outside_wall',
      'The requested opening is outside the shared wall segment.',
      [aId, bId],
      { start: boundary.start, end: boundary.end },
    );
  const design = getDesign(scene);
  const existing = design.connections.find((c) => pair(c, aId, bId));
  const connection = connectionSchema.parse({
    id: existing?.id ?? `opening-${design.connections.length + 1}-${aId}`.slice(0, 60),
    roomAId: aId,
    roomBId: bId,
    sideA: boundary.sideA,
    center: round(center),
    width: options.width,
    height,
    kind: options.kind,
  });
  if (existing) Object.assign(existing, connection);
  else {
    let index = 1;
    while (design.connections.some((c) => c.id === connection.id))
      connection.id = `opening-${++index}-${aId}`.slice(0, 60);
    design.connections.push(connection);
  }
  a[boundary.sideA] = options.kind;
  b[boundary.sideB] = options.kind;
}

function attachRooms(
  scene: Scene,
  anchorId: string,
  roomIds: string[],
  options: z.infer<typeof commandSchema> & {
    targetRoomId: string;
    side: Side;
    alignment: 'start' | 'center' | 'end' | 'preserve';
    connect: boolean;
    kind: 'door' | 'open';
    width: number;
    height: number;
  },
) {
  const anchor = roomById(scene, anchorId),
    target = roomById(scene, options.targetRoomId);
  if (roomIds.includes(target.id))
    throw new CommandError(
      'target_in_group',
      'The target room cannot also belong to the wing being attached.',
      [anchorId, target.id],
    );
  const horizontal = horizontalSide(options.side);
  const edge = bounds(target)[options.side];
  const sign = options.side === 'north' || options.side === 'west' ? -1 : 1;
  const normal = edge + (sign * (horizontal ? anchor.depth : anchor.width)) / 2;
  const targetCenter = horizontal ? target.x : target.z;
  const targetLength = horizontal ? target.width : target.depth;
  const ownLength = horizontal ? anchor.width : anchor.depth;
  const tangent =
    options.alignment === 'preserve'
      ? horizontal
        ? anchor.x
        : anchor.z
      : targetCenter +
        (options.alignment === 'start'
          ? -(targetLength - ownLength) / 2
          : options.alignment === 'end'
            ? (targetLength - ownLength) / 2
            : 0);
  const newX = horizontal ? tangent : normal,
    newZ = horizontal ? normal : tangent;
  translate(
    scene,
    roomIds,
    round(newX - anchor.x),
    round(newZ - anchor.z),
    round(target.elevation - anchor.elevation),
  );
  if (options.connect) connect(scene, target.id, anchorId, options);
}

function intervals(scene: Scene, room: Room, side: Side) {
  const explicit = roomOpenings(scene, room.id, side);
  const center = horizontalSide(side) ? room.x : room.z;
  if (explicit.length)
    return explicit.map((o) => [center + o.offset - o.width / 2, center + o.offset + o.width / 2]);
  if (outdoor(room) || room[side] === 'open') {
    const length = horizontalSide(side) ? room.width : room.depth;
    return [[center - length / 2, center + length / 2]];
  }
  if (room[side] === 'door') return [[center - 0.65, center + 0.65]];
  return [];
}

/** All actual same-floor passages, including correctly aligned legacy wall openings. */
export function circulationEdges(scene: Scene): Array<[string, string]> {
  const edges: Array<[string, string]> = [];
  for (let i = 0; i < scene.rooms.length; i++)
    for (let j = i + 1; j < scene.rooms.length; j++) {
      const a = scene.rooms[i],
        b = scene.rooms[j],
        boundary = sharedBoundary(a, b);
      if (!boundary || !close(a.elevation, b.elevation)) continue;
      const connected = intervals(scene, a, boundary.sideA).some(([aa, ab]) =>
        intervals(scene, b, boundary.sideB).some(
          ([ba, bb]) => Math.min(ab, bb, boundary.end) - Math.max(aa, ba, boundary.start) >= 0.75,
        ),
      );
      if (connected) edges.push([a.id, b.id]);
    }
  for (const link of getDesign(scene).stairLinks)
    if (!stairLinkIssue(scene, link)) edges.push([link.lowerRoomId, link.upperRoomId]);
  return edges;
}

function stairLinkIssue(
  scene: Scene,
  link: DesignMetadata['stairLinks'][number],
): DesignIssue | null {
  const stair = scene.stairs.find((s) => s.id === link.stairId),
    lower = scene.rooms.find((r) => r.id === link.lowerRoomId),
    upper = scene.rooms.find((r) => r.id === link.upperRoomId);
  const ids = [link.stairId, link.lowerRoomId, link.upperRoomId];
  if (!stair || !lower || !upper)
    return issue(
      'stair_reference_missing',
      'A linked stair or its landing room no longer exists.',
      ids,
    );
  const endpoints = stairEndpoints(stair);
  if (
    !close(endpoints.bottom.elevation, lower.elevation, 0.05) ||
    !close(endpoints.top.elevation, upper.elevation, 0.05)
  )
    return issue(
      'stair_floor_mismatch',
      `“${stair.id}” does not arrive at the linked floor elevations.`,
      ids,
      'error',
      {
        bottom: endpoints.bottom.elevation,
        lowerFloor: lower.elevation,
        top: endpoints.top.elevation,
        upperFloor: upper.elevation,
      },
    );
  if (!containsPoint(lower, endpoints.bottom) || !containsPoint(upper, endpoints.top))
    return issue(
      'stair_landing_missing',
      `“${stair.id}” must start inside “${lower.name}” and end inside “${upper.name}”.`,
      ids,
      'error',
      { bottom: endpoints.bottom, top: endpoints.top },
    );
  const angle = (stair.rotation * Math.PI) / 180;
  const halfWidth = {
    x: (Math.cos(angle) * stair.width) / 2,
    z: (-Math.sin(angle) * stair.width) / 2,
  };
  for (const [room, endpoint] of [
    [lower, endpoints.bottom],
    [upper, endpoints.top],
  ] as const) {
    if (
      ![-1, 1].every((direction) =>
        containsPoint(room, {
          x: endpoint.x + direction * halfWidth.x,
          z: endpoint.z + direction * halfWidth.z,
        }),
      )
    )
      return issue(
        'stair_landing_too_narrow',
        `The full width of “${stair.id}” must arrive inside “${room.name}”.`,
        ids,
      );
  }
  const boundary = sharedBoundary(lower, upper);
  if (
    boundary &&
    (!['door', 'open'].includes(upper[boundary.sideB]) ||
      !['door', 'open'].includes(lower[boundary.sideA]))
  )
    return issue(
      'stair_wall_blocked',
      `A wall between the stair and its landing into “${upper.name}” is closed.`,
      ids,
    );
  return null;
}

function resize(scene: Scene, command: Extract<DesignCommand, { type: 'resize_room' }>) {
  const room = roomById(scene, command.roomId),
    before = structuredClone(scene),
    old = bounds(room);
  const oldWidth = room.width,
    oldDepth = room.depth;
  room.width = command.width ?? room.width;
  room.depth = command.depth ?? room.depth;
  room.height = command.height ?? room.height;
  if (command.anchor === 'west') room.x += (room.width - oldWidth) / 2;
  if (command.anchor === 'east') room.x -= (room.width - oldWidth) / 2;
  if (command.anchor === 'north') room.z += (room.depth - oldDepth) / 2;
  if (command.anchor === 'south') room.z -= (room.depth - oldDepth) / 2;
  room.x = round(room.x);
  room.z = round(room.z);
  if (command.moveConnected) {
    const edges = circulationEdges(before);
    const groupEdges = getDesign(before).groups.flatMap((g) =>
      g.roomIds.slice(1).map((id) => [g.roomIds[0], id] as [string, string]),
    );
    const components = connectedComponents(
      before.rooms.filter((r) => r.id !== room.id).map((r) => r.id),
      [...edges, ...groupEdges].filter(([a, b]) => a !== room.id && b !== room.id),
    );
    const next = bounds(room),
      oldRoom = roomById(before, room.id);
    const desired = new Map<string, { dx: number; dz: number }>();
    for (const neighbor of before.rooms) {
      if (neighbor.id === room.id || !close(neighbor.elevation, oldRoom.elevation)) continue;
      const boundary = sharedBoundary(oldRoom, neighbor);
      if (!boundary) continue;
      const related =
        edges.some(
          ([a, b]) => (a === room.id && b === neighbor.id) || (b === room.id && a === neighbor.id),
        ) ||
        getDesign(before).groups.some(
          (g) => g.roomIds.includes(room.id) && g.roomIds.includes(neighbor.id),
        );
      if (!related) continue;
      const amount = round(next[boundary.sideA] - old[boundary.sideA]);
      const movement = horizontalSide(boundary.sideA)
        ? { dx: 0, dz: amount }
        : { dx: amount, dz: 0 };
      const component = components.find((ids) => ids.includes(neighbor.id)) ?? [neighbor.id];
      for (const id of component) {
        const existing = desired.get(id);
        if (existing && (!close(existing.dx, movement.dx) || !close(existing.dz, movement.dz)))
          throw new CommandError(
            'resize_dependency_conflict',
            'Connected rooms surround multiple moving edges. Resize a smaller group or set moveConnected=false and repair explicitly.',
            [room.id, ...component],
          );
        desired.set(id, movement);
      }
    }
    // Apply all positions together so openings are synchronized only once.
    for (const [id, movement] of desired) {
      const member = roomById(scene, id);
      member.x = round(member.x + movement.dx);
      member.z = round(member.z + movement.dz);
    }
    for (const link of getDesign(scene).stairLinks) {
      const a = desired.get(link.lowerRoomId),
        b = desired.get(link.upperRoomId);
      if (a && b && close(a.dx, b.dx) && close(a.dz, b.dz)) {
        const stair = scene.stairs.find((s) => s.id === link.stairId);
        if (stair) {
          stair.x = round(stair.x + a.dx);
          stair.z = round(stair.z + a.dz);
        }
      }
    }
    if (scene.fireplace) {
      const owner = before.rooms.find(
        (r) =>
          !outdoor(r) &&
          close(r.elevation, scene.fireplace!.elevation) &&
          containsPoint(r, scene.fireplace!),
      );
      const movement = owner ? desired.get(owner.id) : undefined;
      if (movement) {
        scene.fireplace.x = round(scene.fireplace.x + movement.dx);
        scene.fireplace.z = round(scene.fireplace.z + movement.dz);
      }
    }
  }
  syncConnections(scene, before);
}

function execute(scene: Scene, command: DesignCommand): DesignChange {
  const design = getDesign(scene);
  let changed: string[] = [];
  let description = '';
  switch (command.type) {
    case 'add_rooms': {
      ensureDistinct(
        [...scene.rooms, ...scene.stairs, ...command.rooms].map((r) => r.id),
        'Rooms and stairs',
      );
      scene.rooms.push(...structuredClone(command.rooms));
      changed = command.rooms.map((r) => r.id);
      description = `Added ${changed.length} room${changed.length === 1 ? '' : 's'}.`;
      break;
    }
    case 'update_room':
      Object.assign(roomById(scene, command.roomId), command.patch);
      changed = [command.roomId];
      description = 'Updated room details.';
      break;
    case 'remove_objects': {
      const existing = new Set([...scene.rooms, ...scene.stairs].map((r) => r.id));
      for (const id of command.ids)
        if (!existing.has(id))
          throw new CommandError('object_not_found', `Object “${id}” does not exist.`, [id]);
      const removed = new Set(command.ids);
      scene.rooms = scene.rooms.filter((r) => !removed.has(r.id));
      scene.stairs = scene.stairs.filter((s) => !removed.has(s.id));
      design.connections = design.connections.filter(
        (c) => !removed.has(c.roomAId) && !removed.has(c.roomBId),
      );
      design.stairLinks = design.stairLinks.filter(
        (l) =>
          !removed.has(l.stairId) && !removed.has(l.lowerRoomId) && !removed.has(l.upperRoomId),
      );
      design.groups = design.groups
        .map((g) => ({ ...g, roomIds: g.roomIds.filter((id) => !removed.has(id)) }))
        .filter((g) => g.roomIds.length);
      changed = command.ids;
      description = `Removed ${changed.length} object${changed.length === 1 ? '' : 's'}.`;
      break;
    }
    case 'define_group': {
      ensureDistinct(command.group.roomIds, 'Group members');
      command.group.roomIds.forEach((id) => roomById(scene, id));
      const index = design.groups.findIndex((g) => g.id === command.group.id);
      if (index >= 0) design.groups[index] = structuredClone(command.group);
      else design.groups.push(structuredClone(command.group));
      changed = command.group.roomIds;
      description = `Defined the “${command.group.name}” group.`;
      break;
    }
    case 'remove_group': {
      if (!design.groups.some((g) => g.id === command.groupId))
        throw new CommandError('group_not_found', 'The group does not exist.', [command.groupId]);
      design.groups = design.groups.filter((g) => g.id !== command.groupId);
      description = 'Removed a room group.';
      break;
    }
    case 'move_group':
      changed = command.includeGroups ? expandGroups(scene, command.roomIds) : command.roomIds;
      translate(scene, changed, command.dx, command.dz, command.elevationDelta);
      description = `Moved ${changed.length} related room${changed.length === 1 ? '' : 's'}.`;
      break;
    case 'attach_room':
      changed = command.moveGroup ? expandGroups(scene, [command.roomId]) : [command.roomId];
      attachRooms(scene, command.roomId, changed, command);
      description = `Attached “${roomById(scene, command.roomId).name}” to “${roomById(scene, command.targetRoomId).name}”.`;
      break;
    case 'attach_wing': {
      const group = design.groups.find((g) => g.id === command.groupId);
      if (!group)
        throw new CommandError(
          'group_not_found',
          'The wing group does not exist. Define it first.',
          [command.groupId],
        );
      if (!group.roomIds.includes(command.anchorRoomId))
        throw new CommandError('anchor_outside_group', 'The anchor room must belong to the wing.', [
          command.anchorRoomId,
          command.groupId,
        ]);
      changed = expandGroups(scene, group.roomIds);
      attachRooms(scene, command.anchorRoomId, changed, command);
      description = `Attached the “${group.name}” wing.`;
      break;
    }
    case 'resize_room': {
      const before = new Map(scene.rooms.map((r) => [r.id, JSON.stringify(r)]));
      resize(scene, command);
      changed = scene.rooms.filter((r) => before.get(r.id) !== JSON.stringify(r)).map((r) => r.id);
      description = `Resized “${roomById(scene, command.roomId).name}” from its ${command.anchor} anchor.`;
      break;
    }
    case 'connect_rooms':
      connect(scene, command.roomAId, command.roomBId, command);
      changed = [command.roomAId, command.roomBId];
      description = 'Created an aligned passage between rooms.';
      break;
    case 'disconnect_rooms': {
      const a = roomById(scene, command.roomAId),
        b = roomById(scene, command.roomBId),
        boundary = sharedBoundary(a, b);
      design.connections = design.connections.filter((c) => !pair(c, a.id, b.id));
      if (boundary) {
        a[boundary.sideA] = 'solid';
        b[boundary.sideB] = 'solid';
      }
      changed = [a.id, b.id];
      description = 'Closed the passage between rooms.';
      break;
    }
    case 'set_material': {
      if (command.roomIds?.length) {
        command.roomIds.forEach((id) => {
          const room = roomById(scene, id);
          room.palette = command.palette;
          delete room.surfacePalettes;
        });
        changed = command.roomIds;
      } else {
        scene.palette = command.palette;
        scene.rooms.forEach((r) => {
          delete r.palette;
          delete r.surfacePalettes;
        });
        changed = scene.rooms.map((r) => r.id);
      }
      description = `Applied the ${command.palette} material palette.`;
      break;
    }
    case 'set_surface_material': {
      const room = roomById(scene, command.roomId);
      room.surfacePalettes = { ...room.surfacePalettes, [command.surface]: command.palette };
      changed = [room.id];
      description = `Changed the ${command.surface} ${['floor', 'roof'].includes(command.surface) ? 'material' : 'wall material'} of “${room.name}” to ${command.palette}.`;
      break;
    }
    case 'move_wall': {
      const room = roomById(scene, command.roomId);
      const dimension = horizontalSide(command.side) ? 'depth' : 'width';
      const next = room[dimension] + command.delta;
      if (next < 1.5 || next > 30)
        throw new CommandError(
          'wall_move_dimensions',
          'Moving this wall would put the room dimension outside 1.5–30 m. Use a smaller wall movement.',
          [room.id],
          { dimension, requested: round(next), current: room[dimension] },
        );
      const before = new Map(scene.rooms.map((r) => [r.id, JSON.stringify(r)]));
      resize(scene, {
        type: 'resize_room',
        roomId: room.id,
        [dimension]: next,
        anchor: oppositeSide(command.side),
        moveConnected: true,
      });
      changed = scene.rooms.filter((r) => before.get(r.id) !== JSON.stringify(r)).map((r) => r.id);
      description = `Moved the ${command.side} wall of “${room.name}” ${Math.abs(command.delta)} m ${command.delta >= 0 ? 'outward' : 'inward'}.`;
      break;
    }
    case 'update_site':
      if (command.name !== undefined) scene.name = command.name;
      if (command.slope !== undefined) scene.slope = command.slope;
      if (command.roof !== undefined) scene.roof = command.roof;
      description = 'Updated site and house settings.';
      break;
    case 'set_fireplace':
      scene.fireplace = structuredClone(command.fireplace);
      description = scene.fireplace ? 'Updated the fireplace.' : 'Removed the fireplace.';
      break;
    case 'add_stairs':
      ensureDistinct(
        [...scene.rooms, ...scene.stairs, ...command.stairs].map((r) => r.id),
        'Rooms and stairs',
      );
      scene.stairs.push(...structuredClone(command.stairs));
      changed = command.stairs.map((s) => s.id);
      description = 'Added stairs.';
      break;
    case 'link_stairs': {
      roomById(scene, command.lowerRoomId);
      roomById(scene, command.upperRoomId);
      if (!scene.stairs.some((s) => s.id === command.stairId))
        throw new CommandError('stair_not_found', 'The stair does not exist.', [command.stairId]);
      design.stairLinks = design.stairLinks.filter((l) => l.stairId !== command.stairId);
      design.stairLinks.push({
        stairId: command.stairId,
        lowerRoomId: command.lowerRoomId,
        upperRoomId: command.upperRoomId,
      });
      changed = [command.stairId];
      description = 'Linked stair landings to their rooms.';
      break;
    }
    case 'connect_levels': {
      const lower = roomById(scene, command.lowerRoomId),
        upper = roomById(scene, command.upperRoomId),
        boundary = sharedBoundary(lower, upper),
        rise = upper.elevation - lower.elevation;
      if (!boundary)
        throw new CommandError(
          'no_shared_wall',
          'Automatic stairs need adjacent lower and upper rooms. Use add_stairs/link_stairs for a different arrangement.',
          [lower.id, upper.id],
        );
      if (rise < 0.3 || rise > 6)
        throw new CommandError(
          'stair_rise',
          'The upper room must be 0.3–6 m above the lower room.',
          [lower.id, upper.id],
        );
      if (bounds(lower).top < upper.elevation + 2)
        throw new CommandError(
          'stair_headroom',
          'The lower room needs at least 2 m of headroom above the upper landing.',
          [lower.id, upper.id],
        );
      if (boundary.length < command.width + 0.1)
        throw new CommandError(
          'stair_width',
          'The shared landing edge is too narrow for this stair.',
          [lower.id, upper.id],
        );
      const rotations: Record<Side, number> = { south: 0, east: 90, north: 180, west: 270 };
      const rotation = rotations[boundary.sideA],
        angle = (rotation * Math.PI) / 180;
      const landing = {
        x: horizontalSide(boundary.sideA) ? boundary.center : bounds(lower)[boundary.sideA],
        z: horizontalSide(boundary.sideA) ? bounds(lower)[boundary.sideA] : boundary.center,
      };
      const stair = stairSchema.parse({
        id: command.stairId,
        x: round(landing.x - Math.sin(angle) * (command.run / 2 - 0.2)),
        z: round(landing.z - Math.cos(angle) * (command.run / 2 - 0.2)),
        elevation: lower.elevation,
        rise,
        width: command.width,
        run: command.run,
        rotation,
      });
      if (scene.rooms.some((r) => r.id === stair.id))
        throw new CommandError('duplicate_id', 'A room already uses the stair ID.', [stair.id]);
      const existing = scene.stairs.findIndex((s) => s.id === stair.id);
      if (existing >= 0) scene.stairs[existing] = stair;
      else scene.stairs.push(stair);
      design.stairLinks = design.stairLinks.filter((l) => l.stairId !== stair.id);
      design.stairLinks.push({ stairId: stair.id, lowerRoomId: lower.id, upperRoomId: upper.id });
      lower[boundary.sideA] = 'open';
      upper[boundary.sideB] = 'open';
      changed = [lower.id, upper.id, stair.id];
      description = 'Created stairs connecting the two floor levels.';
      break;
    }
    case 'set_requirement': {
      const requirement = structuredClone(command.requirement);
      if (requirement.kind === 'locked') {
        const room = roomById(scene, requirement.roomId);
        requirement.snapshot = {
          x: room.x,
          z: room.z,
          elevation: room.elevation,
          width: room.width,
          depth: room.depth,
          height: room.height,
          palette: room.palette ?? scene.palette,
          surfacePalettes: effectiveSurfacePalettes(scene, room),
        };
        const previous = design.requirements.find((r) => r.id === requirement.id);
        // Rewording or expanding a lock must not silently rebase already locked geometry.
        // All snapshots are engine-owned, including when a caller supplies one explicitly.
        if (previous?.kind === 'locked' && previous.roomId === room.id && previous.snapshot) {
          if (previous.properties.includes('position')) {
            requirement.snapshot.x = previous.snapshot.x;
            requirement.snapshot.z = previous.snapshot.z;
            requirement.snapshot.elevation = previous.snapshot.elevation;
          }
          if (previous.properties.includes('size')) {
            requirement.snapshot.width = previous.snapshot.width;
            requirement.snapshot.depth = previous.snapshot.depth;
          }
          if (previous.properties.includes('height'))
            requirement.snapshot.height = previous.snapshot.height;
          if (previous.properties.includes('material')) {
            requirement.snapshot.palette = previous.snapshot.palette;
            requirement.snapshot.surfacePalettes = structuredClone(
              previous.snapshot.surfacePalettes,
            );
          }
        }
      }
      const index = design.requirements.findIndex((r) => r.id === requirement.id);
      if (index >= 0) design.requirements[index] = requirement;
      else design.requirements.push(requirement);
      description = `Remembered: ${requirement.description}`;
      break;
    }
    case 'remove_requirement': {
      if (!design.requirements.some((r) => r.id === command.requirementId))
        throw new CommandError('requirement_not_found', 'The requirement does not exist.', [
          command.requirementId,
        ]);
      design.requirements = design.requirements.filter((r) => r.id !== command.requirementId);
      description = 'Removed a design requirement.';
      break;
    }
  }
  return { operation: command.type, objectIds: changed, description };
}

/** A batch is atomic on command failure. Geometric conflicts remain a repairable draft. */
export function executeCommands(
  input: Scene,
  commands: unknown,
): { scene: Scene; applied: boolean; issues: DesignIssue[]; changes: DesignChange[] } {
  const parsed = commandsSchema.safeParse(commands);
  if (!parsed.success)
    return {
      scene: structuredClone(input),
      applied: false,
      changes: [],
      issues: [
        issue(
          'invalid_command',
          'The command arguments do not match the tool schema.',
          [],
          'error',
          {
            problems: parsed.error.issues.map((e) => ({
              path: e.path.join('.'),
              message: e.message,
            })),
          },
        ),
      ],
    };
  const scene = structuredClone(input);
  scene.design = structuredClone(getDesign(scene));
  const changes: DesignChange[] = [];
  try {
    for (const command of parsed.data) changes.push(execute(scene, command));
    return { scene, applied: true, changes, issues: validateDesign(scene) };
  } catch (error) {
    const failure =
      error instanceof CommandError
        ? issue(error.code, error.message, error.objectIds, 'error', error.details)
        : error instanceof z.ZodError
          ? issue('invalid_geometry', 'An operation would produce invalid geometry.', [], 'error', {
              problems: error.issues.map((e) => ({ path: e.path.join('.'), message: e.message })),
            })
          : issue(
              'command_failed',
              error instanceof Error ? error.message : 'The operation could not be completed.',
              [],
            );
    return { scene: structuredClone(input), applied: false, changes: [], issues: [failure] };
  }
}

function requirementIssues(
  scene: Scene,
  requirement: DesignRequirement,
  edges: Array<[string, string]>,
): DesignIssue[] {
  const severity = requirement.source === 'confirmed' ? 'error' : 'warning';
  const make = (code: string, message: string, ids: string[], details?: Record<string, unknown>) =>
    issue(code, message, ids, severity, { requirementId: requirement.id, ...details });
  const exists = (ids: string[]) => ids.filter((id) => !scene.rooms.some((r) => r.id === id));
  if (requirement.kind === 'intent') return [];
  const referenced =
    requirement.kind === 'connectivity'
      ? [...requirement.roomIds, requirement.targetRoomId]
      : requirement.kind === 'symmetry'
        ? requirement.pairs.flatMap((p) => [p.roomAId, p.roomBId])
        : requirement.kind === 'locked'
          ? [requirement.roomId]
          : [requirement.upperRoomId, requirement.lowerRoomId];
  const missing = exists(referenced);
  if (missing.length)
    return [
      make(
        'requirement_reference_missing',
        `“${requirement.description}” refers to a room that no longer exists.`,
        missing,
      ),
    ];
  if (requirement.kind === 'connectivity') {
    const rooms = scene.rooms.filter((r) => !requirement.indoorOnly || !outdoor(r));
    const component =
      connectedComponents(
        rooms.map((r) => r.id),
        edges,
      ).find((ids) => ids.includes(requirement.targetRoomId)) ?? [];
    const disconnected = requirement.roomIds.filter((id) => !component.includes(id));
    return disconnected.length
      ? [
          make(
            'required_connection_missing',
            `“${requirement.description}” has no ${requirement.indoorOnly ? 'indoor ' : ''}passage for ${disconnected.map((id) => roomById(scene, id).name).join(', ')}.`,
            [...disconnected, requirement.targetRoomId],
          ),
        ]
      : [];
  }
  if (requirement.kind === 'symmetry')
    return requirement.pairs.flatMap((pair) => {
      const a = roomById(scene, pair.roomAId),
        b = roomById(scene, pair.roomBId),
        axis = requirement.axis,
        other = axis === 'x' ? 'z' : 'x';
      const symmetric =
        close(a[axis] + b[axis], requirement.center * 2) &&
        close(a[other], b[other]) &&
        close(a.width, b.width) &&
        close(a.depth, b.depth) &&
        close(a.elevation, b.elevation) &&
        close(a.height, b.height);
      return symmetric
        ? []
        : [
            make(
              'symmetry_broken',
              `“${a.name}” and “${b.name}” no longer mirror each other.`,
              [a.id, b.id],
              { axis, center: requirement.center },
            ),
          ];
    });
  if (requirement.kind === 'locked') {
    if (!requirement.snapshot)
      return [
        make(
          'lock_snapshot_missing',
          'The lock has no reference geometry. Recreate it using set_requirement.',
          [requirement.roomId],
        ),
      ];
    const r = roomById(scene, requirement.roomId),
      s = requirement.snapshot;
    const changed = requirement.properties.filter((property) =>
      property === 'position'
        ? !close(r.x, s.x) || !close(r.z, s.z) || !close(r.elevation, s.elevation)
        : property === 'size'
          ? !close(r.width, s.width) || !close(r.depth, s.depth)
          : property === 'height'
            ? !close(r.height, s.height)
            : surfaces.some(
                (surface) =>
                  effectiveSurfacePalettes(scene, r)[surface] !==
                  (s.surfacePalettes?.[surface] ?? s.palette),
              ),
    );
    return changed.length
      ? [
          make(
            'locked_property_changed',
            `Locked ${changed.join(', ')} changed on “${r.name}”.`,
            [r.id],
            { properties: changed },
          ),
        ]
      : [];
  }
  const upper = roomById(scene, requirement.upperRoomId),
    lower = roomById(scene, requirement.lowerRoomId),
    boundary = sharedBoundary(upper, lower);
  const overlooking =
    upper.elevation > lower.elevation + 0.3 &&
    upper.elevation < lower.elevation + lower.height - 1.5 &&
    boundary &&
    ['open', 'glass'].includes(upper[boundary.sideA]);
  return overlooking
    ? []
    : [
        make(
          'overlook_broken',
          `“${upper.name}” must have an open or glazed edge overlooking the taller “${lower.name}”, with its floor inside that room’s vertical volume.`,
          [upper.id, lower.id],
        ),
      ];
}

/** Geometric and relational facts, with actionable IDs and measured conflicts. */
export function validateDesign(scene: Scene): DesignIssue[] {
  const parsed = sceneSchema.safeParse(scene);
  if (!parsed.success)
    return [
      issue(
        'scene_schema',
        'The draft contains out-of-range or malformed scene data.',
        [],
        'error',
        {
          problems: parsed.error.issues.map((e) => ({
            path: e.path.join('.'),
            message: e.message,
          })),
        },
      ),
    ];
  const issues: DesignIssue[] = [];
  const ids = [...scene.rooms, ...scene.stairs].map((r) => r.id);
  if (new Set(ids).size !== ids.length)
    issues.push(
      issue(
        'duplicate_id',
        'Each room and stair needs a unique ID.',
        ids.filter((id, index) => ids.indexOf(id) !== index),
      ),
    );
  const enclosed = scene.rooms.filter((r) => !outdoor(r));
  for (let i = 0; i < enclosed.length; i++)
    for (let j = i + 1; j < enclosed.length; j++) {
      const a = enclosed[i],
        b = enclosed[j],
        overlap = volumeOverlap(a, b);
      if (overlap)
        issues.push(
          issue(
            'room_overlap',
            `“${a.name}” overlaps “${b.name}” by ${overlap.x} m east/west × ${overlap.z} m north/south × ${overlap.y} m vertically.`,
            [a.id, b.id],
            'error',
            overlap,
          ),
        );
    }
  const design = getDesign(scene);
  for (const [kind, items] of [
    ['group', design.groups],
    ['connection', design.connections],
    ['requirement', design.requirements],
  ] as const) {
    const seen = new Set<string>();
    for (const item of items) {
      if (seen.has(item.id))
        issues.push(issue('duplicate_metadata_id', `Each ${kind} needs a unique ID.`, [item.id]));
      seen.add(item.id);
    }
  }
  for (const group of design.groups) {
    if (new Set(group.roomIds).size !== group.roomIds.length)
      issues.push(
        issue('duplicate_group_member', `“${group.name}” repeats a room.`, group.roomIds),
      );
    const missing = group.roomIds.filter((id) => !scene.rooms.some((r) => r.id === id));
    if (missing.length)
      issues.push(
        issue(
          'group_reference_missing',
          `“${group.name}” refers to rooms that no longer exist.`,
          missing,
        ),
      );
  }
  for (const connection of design.connections) {
    const a = scene.rooms.find((r) => r.id === connection.roomAId),
      b = scene.rooms.find((r) => r.id === connection.roomBId),
      ids = [connection.roomAId, connection.roomBId];
    if (!a || !b) {
      issues.push(
        issue(
          'connection_reference_missing',
          'An opening refers to a room that no longer exists.',
          ids,
        ),
      );
      continue;
    }
    const boundary = sharedBoundary(a, b);
    if (!boundary || boundary.sideA !== connection.sideA || !close(a.elevation, b.elevation)) {
      issues.push(
        issue(
          'connection_detached',
          `The opening between “${a.name}” and “${b.name}” is no longer on a shared wall at the same floor level.`,
          ids,
        ),
      );
      continue;
    }
    if (
      connection.center - connection.width / 2 < boundary.start - 0.01 ||
      connection.center + connection.width / 2 > boundary.end + 0.01
    )
      issues.push(
        issue(
          'opening_outside_wall',
          `The opening between “${a.name}” and “${b.name}” extends past their shared wall.`,
          ids,
          'error',
          { start: boundary.start, end: boundary.end },
        ),
      );
    if (connection.height > Math.min(a.height, b.height))
      issues.push(issue('opening_too_high', 'An opening extends above a room ceiling.', ids));
    if (
      !['open', 'door'].includes(a[boundary.sideA]) ||
      !['open', 'door'].includes(b[boundary.sideB])
    )
      issues.push(issue('opening_blocked', 'A declared passage has a solid or glazed wall.', ids));
  }
  const linked = new Set<string>();
  for (const link of design.stairLinks) {
    if (linked.has(link.stairId))
      issues.push(
        issue('duplicate_stair_link', 'A stair can have only one pair of landing rooms.', [
          link.stairId,
        ]),
      );
    linked.add(link.stairId);
    const problem = stairLinkIssue(scene, link);
    if (problem) issues.push(problem);
  }
  for (const stair of scene.stairs)
    if (!linked.has(stair.id))
      issues.push(
        issue(
          'stair_unlinked',
          `“${stair.id}” has no verified landing connections. Link its lower and upper rooms.`,
          [stair.id],
          'warning',
        ),
      );
  const edges = circulationEdges(scene);
  const components = connectedComponents(
    enclosed.map((r) => r.id),
    edges,
  );
  if (components.length > 1)
    for (const component of components
      .slice()
      .sort((a, b) => b.length - a.length)
      .slice(1))
      issues.push(
        issue(
          'disconnected_rooms',
          `${component.map((id) => roomById(scene, id).name).join(', ')} has no verified indoor route to the largest connected part of the house.`,
          component,
          'warning',
        ),
      );
  for (const requirement of design.requirements)
    issues.push(...requirementIssues(scene, requirement, edges));
  for (let i = 0; i < scene.rooms.length; i++)
    for (let j = i + 1; j < scene.rooms.length; j++) {
      const a = scene.rooms[i],
        b = scene.rooms[j],
        boundary = sharedBoundary(a, b);
      if (!boundary || !close(a.elevation, b.elevation) || outdoor(a) || outdoor(b)) continue;
      const doorwayFacesBoundary = (room: Room, side: Side) =>
        room[side] === 'door' &&
        intervals(scene, room, side).some(
          ([start, end]) => Math.min(end, boundary.end) - Math.max(start, boundary.start) >= 0.75,
        );
      // A long wall may border several neighbors. Its doorway into one neighbor
      // says nothing about a different, solid section bordering another room.
      if (doorwayFacesBoundary(a, boundary.sideA) || doorwayFacesBoundary(b, boundary.sideB)) {
        const connected = edges.some(
          ([x, y]) => (x === a.id && y === b.id) || (x === b.id && y === a.id),
        );
        if (!connected)
          issues.push(
            issue(
              'door_misaligned',
              `The doorway between “${a.name}” and “${b.name}” is blocked or does not align. Use connect_rooms.`,
              [a.id, b.id],
              'warning',
            ),
          );
      }
    }
  return [...issues, ...inspectSpatial(scene).issues];
}

export function inspectDesign(scene: Scene) {
  const edges = circulationEdges(scene);
  return {
    units: 'meters',
    axes: { x: 'east', z: 'south', elevation: 'up' },
    rooms: scene.rooms.map((room) => ({
      ...room,
      bounds: bounds(room),
      effectivePalette: room.palette ?? scene.palette,
      effectiveSurfacePalettes: effectiveSurfacePalettes(scene, room),
      groups: getDesign(scene)
        .groups.filter((g) => g.roomIds.includes(room.id))
        .map((g) => g.id),
    })),
    stairs: scene.stairs.map((stair) => ({ ...stair, endpoints: stairEndpoints(stair) })),
    site: {
      name: scene.name,
      palette: scene.palette,
      roof: scene.roof,
      slope: scene.slope,
      fireplace: scene.fireplace,
    },
    design: getDesign(scene),
    spatial: inspectSpatial(scene),
    connections: edges.map(([roomAId, roomBId]) => ({ roomAId, roomBId })),
    components: connectedComponents(
      scene.rooms.filter((r) => !outdoor(r)).map((r) => r.id),
      edges,
    ),
    issues: validateDesign(scene),
  };
}

/**
 * Commit policy: tolerate unresolved legacy warnings, but never introduce new
 * disconnected interior rooms, break an existing route, or add unverifiable stairs.
 * Compare actual membership and pair connectivity, not warning prose/component order.
 */
export function validateDesignChange(before: Scene, after: Scene): DesignIssue[] {
  const afterIssues = validateDesign(after);
  if (afterIssues.some((problem) => problem.code === 'scene_schema')) return afterIssues;
  const baseline = validateDesign(before);
  const warningIdentity = (problem: DesignIssue) =>
    `${problem.code}:${[...problem.objectIds].sort().join('|')}`;
  const oldWarnings = new Set(
    baseline.filter((problem) => problem.severity === 'warning').map(warningIdentity),
  );
  const issues = afterIssues.map((problem) =>
    problem.severity === 'warning' &&
    ['stair_unlinked', 'door_misaligned'].includes(problem.code) &&
    !oldWarnings.has(warningIdentity(problem))
      ? {
          ...problem,
          severity: 'error' as const,
          details: { ...problem.details, introducedByEdit: true },
        }
      : problem,
  );
  const beforeIds = before.rooms.filter((r) => !outdoor(r)).map((r) => r.id);
  const afterIds = after.rooms.filter((r) => !outdoor(r)).map((r) => r.id);
  const beforeSet = new Set(beforeIds),
    afterSet = new Set(afterIds);
  const policyEdges = (scene: Scene) => {
    const edges = circulationEdges(scene);
    const allComponents = connectedComponents(
      scene.rooms.map((r) => r.id),
      edges,
    );
    for (const requirement of getDesign(scene).requirements) {
      if (
        requirement.kind !== 'connectivity' ||
        requirement.source !== 'confirmed' ||
        requirement.indoorOnly
      )
        continue;
      const reachable =
        allComponents.find((component) => component.includes(requirement.targetRoomId)) ?? [];
      // Explicit permission for courtyard access is local to the named rooms and target.
      // A preference or a merely asserted route cannot bypass the actual geometry graph.
      for (const roomId of requirement.roomIds)
        if (reachable.includes(roomId)) edges.push([roomId, requirement.targetRoomId]);
    }
    return edges;
  };
  const previousComponents = connectedComponents(beforeIds, policyEdges(before));
  const nextComponents = connectedComponents(afterIds, policyEdges(after));
  const nextIndex = new Map(
    nextComponents.flatMap((ids, index) => ids.map((id) => [id, index] as const)),
  );

  for (const component of previousComponents) {
    const survivors = component.filter((id) => afterSet.has(id));
    const split = new Set(survivors.map((id) => nextIndex.get(id)));
    if (split.size > 1)
      issues.push(
        issue(
          'circulation_regression',
          `This edit breaks an existing indoor route between ${survivors.map((id) => roomById(after, id).name).join(', ')}. Restore a passage or a linked stair connection.`,
          survivors,
          'error',
          {
            previousComponent: component,
            resultingGroups: nextComponents
              .map((ids) => ids.filter((id) => survivors.includes(id)))
              .filter((ids) => ids.length),
          },
        ),
      );
  }

  const orphanComponents = nextComponents.filter(
    (component) => !component.some((id) => beforeSet.has(id)),
  );
  // With no surviving existing interior room, the first/largest new connected assembly is the house.
  // This also supports an explicitly reviewed complete replacement of an existing design.
  const hasExistingAnchor = afterIds.some((id) => beforeSet.has(id));
  const exempt = hasExistingAnchor
    ? undefined
    : [...orphanComponents].sort((a, b) => b.length - a.length)[0];
  for (const component of orphanComponents) {
    if (component === exempt) continue;
    issues.push(
      issue(
        'new_disconnected_room',
        `New interior rooms ${component.map((id) => roomById(after, id).name).join(', ')} need an indoor passage to the house. Attach and connect them, or provide linked stairs.`,
        component,
        'error',
        { introducedByEdit: true },
      ),
    );
  }
  return issues;
}
