import assert from 'node:assert/strict';
import test from 'node:test';
import {
  executeCommands,
  circulationEdges,
  getDesign,
  inspectDesign,
  roomOpenings,
  type DesignCommand,
} from '../shared/design.ts';
import { bounds, sharedBoundary, round } from '../shared/geometry.ts';
import {
  emptyScene,
  makeRoom,
  editProject,
  newProject,
  undo,
  redo,
  type Room,
  type Scene,
} from '../shared/model.ts';
import { makeFurniture, roomFurniture } from '../shared/furniture.ts';

const room = (patch: Partial<Room> = {}) =>
  makeRoom({
    id: 'a',
    width: 8,
    depth: 6,
    height: 3,
    north: 'solid',
    south: 'solid',
    east: 'solid',
    west: 'solid',
    furniture: [],
    ...patch,
  });
const scene = (...rooms: Room[]): Scene => ({ ...structuredClone(emptyScene), slope: 0, rooms });
function apply(input: Scene, commands: unknown[]) {
  const result = executeCommands(input, commands);
  assert.equal(result.applied, true, JSON.stringify(result.issues));
  assert.deepEqual(
    result.issues.filter((issue) => issue.severity === 'error'),
    [],
  );
  return result.scene;
}
function rejected(input: Scene, commands: unknown[], code: string) {
  const before = structuredClone(input),
    result = executeCommands(input, commands);
  assert.equal(result.applied, false, JSON.stringify(result));
  assert.equal(result.issues[0].code, code);
  assert.deepEqual(result.scene, before, 'failed operation returns the entire original scene');
  assert.deepEqual(input, before, 'input stays immutable');
  assert.deepEqual(result.changes, []);
  return result;
}
const split = (patch: Record<string, unknown> = {}) => ({
  type: 'split_room',
  roomId: 'a',
  axis: 'x',
  offset: 0,
  newRoomId: 'b',
  newRoomName: 'East bedroom',
  newRoomKind: 'bedroom',
  passage: { id: 'partition-door', width: 1, height: 2.2 },
  ...patch,
});
function furnitureWorld(input: Scene) {
  return input.rooms
    .flatMap((room) =>
      roomFurniture(room).map((item) => ({
        ...item,
        x: round(room.x + item.x),
        z: round(room.z + item.z),
        palette: item.palette ?? room.palette ?? input.palette,
      })),
    )
    .sort((a, b) => a.id.localeCompare(b.id));
}

test('shared wall transfers space in every orientation without moving perimeter, furniture or unrelated rooms', () => {
  for (const side of ['north', 'south', 'east', 'west'] as const)
    for (const delta of [-0.6, 0.8]) {
      const a = room({
        width: 4,
        depth: 4,
        furniture: [
          makeFurniture('chair', 'a-chair', {
            width: 0.5,
            depth: 0.5,
            x: -0.5,
            z: 0.4,
            rotation: 27,
          }),
        ],
      });
      const b = room({
        id: 'b',
        width: 4,
        depth: 4,
        x: side === 'east' ? 4 : side === 'west' ? -4 : 0,
        z: side === 'south' ? 4 : side === 'north' ? -4 : 0,
        furniture: [makeFurniture('chair', 'b-chair', { x: 0.3, z: -0.3 })],
      });
      const untouched = room({
        id: 'unrelated',
        x: 20,
        name: 'Keep exact',
        surfacePalettes: { north: 'cedar' },
        furniture: undefined,
      });
      const before = scene(a, b, untouched);
      const after = apply(before, [
        { type: 'move_shared_wall', roomAId: 'a', roomBId: 'b', delta },
      ]);
      const axis = ['east', 'west'].includes(side) ? 'width' : 'depth';
      assert.equal(after.rooms[0][axis], a[axis] + delta);
      assert.equal(after.rooms[1][axis], b[axis] - delta);
      for (const edge of ['north', 'south', 'east', 'west'] as const) {
        const aggregation = ['north', 'west'].includes(edge) ? Math.min : Math.max;
        assert.equal(
          aggregation(...after.rooms.slice(0, 2).map((r) => bounds(r)[edge])),
          aggregation(bounds(a)[edge], bounds(b)[edge]),
        );
      }
      assert.equal(sharedBoundary(after.rooms[0], after.rooms[1])!.sideA, side);
      assert.deepEqual(
        furnitureWorld(after).filter((item) => item.id.endsWith('chair')),
        furnitureWorld(before).filter((item) => item.id.endsWith('chair')),
      );
      assert.deepEqual(after.rooms[2], untouched);
    }
});

test('moving shared wall reassigns furniture and an external semantic door while carrying the shared opening', () => {
  const a = room({
    width: 4,
    x: -2,
    furniture: [
      makeFurniture('chair', 'transfer-chair', {
        x: 1.6,
        z: 1.6,
        width: 0.3,
        depth: 0.3,
        palette: 'cedar',
      }),
    ],
    wallOpenings: [
      {
        id: 'shared-window',
        side: 'east',
        kind: 'window',
        offset: -1.7,
        width: 0.8,
        height: 0.7,
        sill: 1.2,
      },
    ],
  });
  const b = room({ id: 'b', width: 4, x: 2 });
  const hall = room({ id: 'hall', width: 8, depth: 3, z: 4.5 });
  const before = apply(scene(a, b, hall), [
    {
      type: 'connect_rooms',
      roomAId: 'a',
      roomBId: 'b',
      connectionId: 'shared-door',
      width: 0.9,
      height: 2.1,
      kind: 'door',
      center: 0,
    },
    {
      type: 'connect_rooms',
      roomAId: 'a',
      roomBId: 'hall',
      connectionId: 'external-door',
      width: 0.8,
      height: 2.1,
      kind: 'door',
      center: -0.5,
    },
  ]);
  const after = apply(before, [
    { type: 'move_shared_wall', roomAId: 'a', roomBId: 'b', delta: -1 },
  ]);
  assert.equal(after.rooms[0].furniture!.length, 0);
  assert.equal(after.rooms[1].furniture![0].id, 'transfer-chair');
  assert.deepEqual(furnitureWorld(after), furnitureWorld(before));
  assert.deepEqual(
    getDesign(after).connections.find((c) => c.id === 'external-door'),
    { ...getDesign(before).connections.find((c) => c.id === 'external-door')!, roomAId: 'b' },
  );
  assert.equal(
    roomOpenings(after, 'a', 'east').find((o) => o.id === 'shared-window')!.offset,
    -1.7,
  );
  assert.equal(
    roomOpenings(after, 'b', 'west').find((o) => o.id === 'shared-window')!.sourceRoomId,
    'a',
  );
  assert.equal(bounds(after.rooms[0]).east, -1);
});

test('split retains the north/west identity, reassigns windows and furniture, expands groups and keeps requirements untouched', () => {
  for (const axis of ['x', 'z'] as const) {
    const source = room({
      width: 8,
      depth: 8,
      x: 3,
      z: -2,
      furniture: [
        makeFurniture('chair', 'left-chair', { x: -2, z: -2 }),
        makeFurniture('chair', 'right-chair', { x: 2, z: 2 }),
      ],
      wallOpenings: [
        {
          id: 'outer-window',
          side: axis === 'x' ? 'south' : 'east',
          kind: 'window',
          offset: 2,
          width: 1,
          height: 1,
          sill: 1,
        },
      ],
    });
    const untouched = room({ id: 'c', x: 20 });
    const before = apply(scene(source, untouched), [
      { type: 'define_group', group: { id: 'wing', name: 'Wing', roomIds: ['a', 'c'] } },
      {
        type: 'set_requirement',
        requirement: {
          id: 'keep-c',
          kind: 'locked',
          source: 'confirmed',
          description: 'Keep separate room unchanged',
          roomId: 'c',
          properties: ['position', 'size', 'material'],
        },
      },
    ]);
    const after = apply(before, [split({ axis })]);
    assert.deepEqual(getDesign(after).groups[0].roomIds, ['a', 'b', 'c']);
    assert.deepEqual(getDesign(after).requirements, getDesign(before).requirements);
    assert.deepEqual(
      after.rooms.find((r) => r.id === 'c'),
      untouched,
    );
    assert.deepEqual(furnitureWorld(after), furnitureWorld(before));
    assert.equal(after.rooms.find((r) => r.id === 'b')!.wallOpenings![0].id, 'outer-window');
    assert.equal(getDesign(after).connections[0].sideA, axis === 'x' ? 'east' : 'south');
    assert.deepEqual(circulationEdges(after), [['a', 'b']]);
  }
});

test('split keeps explicit opening ownership on an untouched neighbor and remaps the matching semantic endpoint', () => {
  const a = room({ width: 8, depth: 4 });
  const neighbor = room({
    id: 'neighbor',
    width: 8,
    depth: 4,
    z: 4,
    wallOpenings: [
      {
        id: 'neighbor-window',
        side: 'north',
        kind: 'window',
        offset: 2.6,
        width: 0.7,
        height: 0.8,
        sill: 1.2,
      },
    ],
  });
  const before = apply(scene(a, neighbor), [
    {
      type: 'connect_rooms',
      roomAId: 'neighbor',
      roomBId: 'a',
      connectionId: 'entry',
      kind: 'door',
      width: 1,
      height: 2.2,
      center: 1.2,
    },
  ]);
  const after = apply(before, [split()]);
  assert.deepEqual(
    after.rooms.find((r) => r.id === 'neighbor'),
    before.rooms[1],
  );
  assert.equal(getDesign(after).connections.find((c) => c.id === 'entry')!.roomBId, 'b');
  assert.equal(
    roomOpenings(after, 'b', 'south').find((o) => o.id === 'neighbor-window')!.sourceRoomId,
    'neighbor',
  );
});

test('legacy external doors keep their world aperture position and legacy furniture is materialized only by an accepted edit', () => {
  const a = room({
    id: 'a',
    kind: 'bedroom',
    width: 10,
    depth: 8,
    x: 2,
    z: -3,
    east: 'door',
    furniture: undefined,
  });
  const before = scene(a);
  const after = apply(before, [split({ axis: 'x', offset: -2 })]);
  assert.deepEqual(furnitureWorld(after), furnitureWorld(before));
  const next = after.rooms.find((r) => r.id === 'b')!;
  const door = roomOpenings(after, 'b', 'east')[0];
  assert.equal(next.z + door.offset, a.z);
  assert.equal(door.width, 1.3);
  assert.equal(before.rooms[0].furniture, undefined);
  assert.ok(after.rooms.every((r) => r.furniture !== undefined));
});

test('merge removes only the partition and internal passages, preserving outside finishes, apertures, furniture and group membership', () => {
  const a = room({
    x: -2,
    width: 4,
    surfacePalettes: { west: 'cedar' },
    furniture: [makeFurniture('chair', 'a-chair', { x: 0.4, z: -1 })],
  });
  const b = room({
    id: 'b',
    x: 2,
    width: 4,
    surfacePalettes: { east: 'charcoal' },
    furniture: [makeFurniture('chair', 'b-chair', { x: -0.4, z: 1 })],
    wallOpenings: [
      {
        id: 'east-window',
        side: 'east',
        kind: 'window',
        offset: 0.7,
        width: 1.2,
        height: 1,
        sill: 1,
      },
    ],
  });
  const hall = room({ id: 'hall', width: 8, depth: 3, z: 4.5 });
  const before = apply(scene(a, b, hall), [
    {
      type: 'connect_rooms',
      roomAId: 'a',
      roomBId: 'b',
      connectionId: 'remove-door',
      kind: 'door',
      width: 1,
      height: 2.2,
    },
    {
      type: 'connect_rooms',
      roomAId: 'b',
      roomBId: 'hall',
      connectionId: 'keep-door',
      kind: 'door',
      width: 1,
      height: 2.2,
      center: 2,
    },
    { type: 'define_group', group: { id: 'both', name: 'Both', roomIds: ['a', 'b', 'hall'] } },
    { type: 'define_group', group: { id: 'east', name: 'East', roomIds: ['b', 'hall'] } },
  ]);
  const after = apply(before, [
    { type: 'merge_rooms', roomAId: 'a', roomBId: 'b', name: 'Combined' },
  ]);
  assert.deepEqual(
    after.rooms.map((r) => r.id),
    ['a', 'hall'],
  );
  assert.equal(after.rooms[0].width, 8);
  assert.equal(after.rooms[0].name, 'Combined');
  assert.equal(after.rooms[0].surfacePalettes!.west, 'cedar');
  assert.equal(after.rooms[0].surfacePalettes!.east, 'charcoal');
  assert.deepEqual(furnitureWorld(after), furnitureWorld(before));
  assert.deepEqual(
    getDesign(after).groups.map((g) => g.roomIds),
    [
      ['a', 'hall'],
      ['a', 'hall'],
    ],
  );
  assert.deepEqual(
    getDesign(after).connections.map((c) => [c.id, c.roomAId, c.roomBId]),
    [['keep-door', 'a', 'hall']],
  );
  assert.equal(after.rooms[0].wallOpenings![0].id, 'east-window');
  assert.deepEqual(after.rooms[1], before.rooms[2]);
});

test('split and merge reject unsupported footprints, slopes, levels, stairs and out-of-range dimensions atomically', () => {
  const a = room({ width: 4, depth: 4 });
  const merge = { type: 'merge_rooms', roomAId: 'a', roomBId: 'b' };
  rejected(
    scene(a, room({ id: 'b', x: 4, width: 4, depth: 3 })),
    [merge],
    'room_transform_adjacency',
  );
  rejected(
    scene(a, room({ id: 'b', x: 4, width: 4, depth: 4, elevation: 1 })),
    [merge],
    'room_transform_levels',
  );
  rejected({ ...scene(a), roof: 'pitched' }, [split()], 'room_transform_roof');
  rejected(scene(a), [split({ offset: 1 })], 'room_transform_dimensions');
  rejected(scene(a), [split({ newRoomId: 'a' })], 'duplicate_id');
  rejected(
    {
      ...scene(a),
      stairs: [{ id: 'stair', x: 0, z: 0, elevation: 0, width: 1, run: 3, rise: 3, rotation: 0 }],
    },
    [split()],
    'room_transform_stairs',
  );
  rejected(
    scene(a, room({ id: 'b', x: 4, width: 4, depth: 4 })),
    [{ type: 'move_shared_wall', roomAId: 'a', roomBId: 'b', delta: 3 }],
    'room_transform_dimensions',
  );
});

test('partitions reject cuts through explicit or mirrored apertures, solid furniture and rugs without losing their IDs', () => {
  for (const kind of ['chair', 'rug'] as const)
    rejected(
      scene(room({ furniture: [makeFurniture(kind, 'cut-me')] })),
      [split()],
      'room_transform_furniture_cut',
    );
  rejected(
    scene(
      room({
        wallOpenings: [
          {
            id: 'cut-window',
            side: 'south',
            kind: 'window',
            offset: 0,
            width: 2,
            height: 1,
            sill: 1,
          },
        ],
      }),
    ),
    [split()],
    'room_transform_opening_cut',
  );
  const a = room({ depth: 4 }),
    neighbor = room({
      id: 'n',
      depth: 4,
      z: 4,
      wallOpenings: [
        {
          id: 'mirrored-cut',
          side: 'north',
          kind: 'window',
          offset: 0,
          width: 2,
          height: 1,
          sill: 1,
        },
      ],
    });
  const failed = rejected(scene(a, neighbor), [split()], 'room_transform_invalid');
  assert.equal(failed.issues[0].details!.cause, 'opening_shared_wall_conflict');
});

test('merge refuses ambiguous finish segments, duplicate furniture IDs and requirement references', () => {
  const a = room({ x: -2, width: 4 }),
    b = room({ id: 'b', x: 2, width: 4 });
  const command = { type: 'merge_rooms', roomAId: 'a', roomBId: 'b' };
  rejected(
    scene(a, { ...b, surfacePalettes: { floor: 'cedar' } }),
    [command],
    'merge_finish_conflict',
  );
  rejected(
    scene(a, { ...b, surfacePalettes: { south: 'cedar' } }),
    [command],
    'room_transform_finish_conflict',
  );
  rejected(scene(a, { ...b, south: 'glass' }), [command], 'room_transform_finish_conflict');
  rejected(
    scene(
      { ...a, furniture: [makeFurniture('chair', 'same')] },
      { ...b, furniture: [makeFurniture('chair', 'same')] },
    ),
    [command],
    'room_transform_furniture_id',
  );
  const protectedScene = apply(scene(a, b), [
    {
      type: 'set_requirement',
      requirement: {
        id: 'preserve-b',
        kind: 'locked',
        source: 'confirmed',
        description: 'Keep height',
        roomId: 'b',
        properties: ['height'],
      },
    },
  ]);
  rejected(protectedScene, [command], 'merge_requirement_reference');
});

test('confirmed locks and symmetry remain unchanged and force rollback when a partition violates them', () => {
  const a = room({ width: 4, x: -2 }),
    b = room({ id: 'b', width: 4, x: 2 });
  const locked = apply(scene(a, b), [
    {
      type: 'set_requirement',
      requirement: {
        id: 'locked-a',
        kind: 'locked',
        source: 'confirmed',
        description: 'Keep A geometry',
        roomId: 'a',
        properties: ['position', 'size'],
      },
    },
  ]);
  const result = rejected(
    locked,
    [{ type: 'move_shared_wall', roomAId: 'a', roomBId: 'b', delta: 0.5 }],
    'room_transform_invalid',
  );
  assert.equal(result.issues[0].details!.cause, 'locked_property_changed');
  const symmetric = apply(scene(a, b), [
    {
      type: 'set_requirement',
      requirement: {
        id: 'sym',
        kind: 'symmetry',
        source: 'confirmed',
        description: 'Keep mirrored pair',
        pairs: [{ roomAId: 'a', roomBId: 'b' }],
        axis: 'x',
        center: 0,
      },
    },
  ]);
  rejected(
    symmetric,
    [{ type: 'move_shared_wall', roomAId: 'a', roomBId: 'b', delta: 0.5 }],
    'room_transform_invalid',
  );
});

test('split requires indoor access and never severs a prior route; malformed later commands roll back the entire batch', () => {
  rejected(scene(room()), [split({ passage: undefined })], 'split_passage_required');
  const left = room({ id: 'left', width: 4, x: -6 }),
    right = room({ id: 'right', width: 4, x: 6 });
  const before = apply(scene(room(), left, right), [
    { type: 'connect_rooms', roomAId: 'left', roomBId: 'a', kind: 'door', width: 1, height: 2.2 },
    { type: 'connect_rooms', roomAId: 'a', roomBId: 'right', kind: 'door', width: 1, height: 2.2 },
  ]);
  rejected(before, [split({ passage: undefined })], 'room_transform_route');
  rejected(
    scene(room()),
    [split(), { type: 'move_shared_wall', roomAId: 'b', roomBId: 'missing', delta: 1 }],
    'room_not_found',
  );
});

test('transformed scenes retain ordinary persistence and one-step undo/redo', () => {
  const initial = { ...newProject(), scene: scene(room()) };
  const after = apply(initial.scene, [split()]);
  const project = editProject(initial, after);
  const restored = JSON.parse(JSON.stringify(project));
  assert.deepEqual(undo(restored).scene, initial.scene);
  assert.deepEqual(redo(undo(restored)).scene, after);
  assert.equal(restored.past.length, 1);
});

test('implicit shared doors do not invent a route through a solid neighbor, and fireplace cuts roll back', () => {
  const a = room({ width: 4, depth: 4, east: 'door' });
  const b = room({ id: 'b', width: 4, depth: 4, x: 4 });
  rejected(
    scene(a, b),
    [{ type: 'move_shared_wall', roomAId: 'a', roomBId: 'b', delta: 0.5 }],
    'room_transform_legacy_door',
  );
  const aligned = scene(a, { ...b, west: 'door' });
  const moved = apply(aligned, [
    { type: 'move_shared_wall', roomAId: 'a', roomBId: 'b', delta: 0.5 },
  ]);
  assert.equal(moved.rooms.flatMap((r) => r.wallOpenings ?? []).length, 1);
  assert.deepEqual(circulationEdges(moved), [['a', 'b']]);
  rejected(
    { ...scene(room()), fireplace: { x: 0, z: 0, elevation: 0, height: 5 } },
    [split()],
    'room_transform_fireplace_cut',
  );
});

test('inspection explains the shared wall coordinate, normal axis and positive delta direction', () => {
  const input = scene(room({ width: 4, depth: 4 }), room({ id: 'b', x: -4, width: 4, depth: 4 }));
  const edge = inspectDesign(input).sharedWalls[0];
  assert.equal(edge.sideA, 'west');
  assert.equal(edge.coordinate, -2);
  assert.equal(edge.normalAxis, 'x');
  assert.equal(edge.positiveDeltaDirection, 'west');
  assert.equal(edge.fullWall, true);
  assert.equal(edge.sameFloorAndHeight, true);
  input.rooms[1].x = -4.02;
  assert.equal(
    inspectDesign(input).sharedWalls[0].fullWall,
    false,
    'nearby parallel planes do not form a full shared wall',
  );
});

test('legacy door promotion cannot fill an untouched whole-open neighbor facade', () => {
  const a = room({ width: 4, depth: 4, x: -2, south: 'door' });
  const neighbor = room({ id: 'neighbor', width: 8, depth: 4, z: 4, north: 'open' });
  rejected(scene(a, neighbor), [split({ axis: 'z' })], 'room_transform_legacy_door');
});

test('vertically separate rooms do not block legacy door preservation', () => {
  const a = room({ width: 4, depth: 4, east: 'door' });
  const upper = room({ id: 'upper', width: 4, depth: 4, x: 4, elevation: 3 });
  const after = apply(scene(a, upper), [split()]);
  assert.deepEqual(
    after.rooms.find((room) => room.id === 'upper'),
    upper,
  );
  assert.equal(roomOpenings(after, 'b', 'east')[0].kind, 'door');
  assert.deepEqual(roomOpenings(after, 'upper', 'west'), []);
});

test('fireplace obstruction uses vertical intersection, including a slightly raised hearth', () => {
  rejected(
    { ...scene(room()), fireplace: { x: 0, z: 0, elevation: 0.01, height: 5 } },
    [split()],
    'room_transform_fireplace_cut',
  );
  const above = { ...scene(room()), fireplace: { x: 0, z: 0, elevation: 3.1, height: 5 } };
  assert.equal(apply(above, [split()]).rooms.length, 2);
});

test('moving a shared wall cannot repaint the transferred floor or roof strip', () => {
  const a = room({ width: 4, depth: 4 }),
    b = room({ id: 'b', x: 4, width: 4, depth: 4 });
  for (const surface of ['floor', 'roof'] as const)
    rejected(
      scene(a, { ...b, surfacePalettes: { [surface]: 'cedar' } }),
      [{ type: 'move_shared_wall', roomAId: 'a', roomBId: 'b', delta: 0.5 }],
      'room_transform_finish_conflict',
    );
});

test('legacy door preservation rejects opposite doors of a different physical height', () => {
  const a = room({ width: 4, depth: 4, height: 2.2, east: 'door' });
  const neighbor = room({ id: 'n', width: 4, depth: 4, x: 4, west: 'door' });
  rejected(
    scene(a, neighbor),
    [split({ passage: { id: 'partition', width: 1, height: 2 } })],
    'room_transform_legacy_door',
  );
});

test('legacy door promotion cannot narrow a shared terrace edge and break another room route', () => {
  const a = room({ width: 4, depth: 4, x: -2, south: 'door' });
  const c = room({ id: 'c', width: 4, depth: 4, x: 2, south: 'door' });
  const terrace = room({ id: 'terrace', kind: 'terrace', width: 8, depth: 4, z: 4 });
  const before = scene(a, c, terrace);
  assert.ok(circulationEdges(before).some(([x, y]) => x === 'c' && y === 'terrace'));
  rejected(before, [split({ axis: 'z' })], 'room_transform_legacy_door');
});
