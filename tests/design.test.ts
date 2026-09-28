import test from 'node:test';
import assert from 'node:assert/strict';
import {
  documentSchema,
  editProject,
  emptyScene,
  makeRoom,
  newProject,
  redo,
  sampleScene,
  undo,
  type Scene,
} from '../shared/model.ts';
import {
  executeCommands,
  getDesign,
  inspectDesign,
  roomOpenings,
  validateDesign,
  validateDesignChange,
} from '../shared/design.ts';
import { bounds, sharedBoundary, stairEndpoints } from '../shared/geometry.ts';

const cleanScene = (rooms: Scene['rooms']): Scene => ({
  ...structuredClone(emptyScene),
  rooms,
  slope: 0,
});
const errors = (scene: Scene) =>
  validateDesign(scene).filter((issue) => issue.severity === 'error');

test('legacy projects load with revision zero; relationships survive history and named alternatives', () => {
  const project = newProject();
  const { revision: _revision, ...legacy } = project;
  assert.equal(documentSchema.parse(legacy).revision, 0);
  const result = executeCommands(sampleScene(), [
    {
      type: 'define_group',
      group: { id: 'west-wing', name: 'West wing', roomIds: ['west-suite', 'west-bath'] },
    },
    {
      type: 'set_requirement',
      requirement: {
        id: 'style',
        kind: 'intent',
        source: 'preference',
        description: 'Warm and welcoming.',
      },
    },
  ]);
  assert.equal(result.applied, true);
  const edited = editProject(project, result.scene);
  assert.deepEqual(getDesign(redo(undo(edited)).scene), result.scene.design);
  const named = {
    ...edited,
    variants: [{ id: 'a', name: 'West wing', createdAt: '2026-09-28', scene: result.scene }],
  };
  const persisted = documentSchema.parse(JSON.parse(JSON.stringify(named)));
  assert.deepEqual(persisted.variants[0].scene.design, result.scene.design);
});

test('bedroom attachment moves its bathroom as a wing and creates aligned openings without touching the main house', () => {
  const original = sampleScene();
  const saved = structuredClone(original);
  const result = executeCommands(original, [
    {
      type: 'define_group',
      group: { id: 'west', name: 'West suite', roomIds: ['west-suite', 'west-bath'] },
    },
    {
      type: 'define_group',
      group: { id: 'east', name: 'East suite', roomIds: ['east-suite', 'east-bath'] },
    },
    {
      type: 'attach_wing',
      groupId: 'west',
      anchorRoomId: 'west-suite',
      targetRoomId: 'kitchen',
      side: 'west',
      alignment: 'preserve',
    },
    {
      type: 'attach_wing',
      groupId: 'east',
      anchorRoomId: 'east-suite',
      targetRoomId: 'kitchen',
      side: 'east',
      alignment: 'preserve',
    },
    { type: 'connect_rooms', roomAId: 'west-suite', roomBId: 'west-bath' },
    { type: 'connect_rooms', roomAId: 'east-suite', roomBId: 'east-bath' },
    {
      type: 'set_requirement',
      requirement: {
        id: 'bedrooms-connected',
        kind: 'connectivity',
        source: 'confirmed',
        description: 'Bedrooms have indoor access to the main house.',
        roomIds: ['west-suite', 'east-suite', 'west-bath', 'east-bath'],
        targetRoomId: 'kitchen',
        indoorOnly: true,
      },
    },
  ]);
  assert.equal(result.applied, true);
  assert.deepEqual(errors(result.scene), []);
  assert.deepEqual(
    validateDesignChange(original, result.scene).filter((i) => i.severity === 'error'),
    [],
  );
  assert.equal(
    result.issues.some(
      (i) =>
        i.code === 'door_misaligned' &&
        i.objectIds.includes('kitchen') &&
        (i.objectIds.includes('west-bath') || i.objectIds.includes('east-bath')),
    ),
    false,
    'an explicit door into a bedroom must not imply an opening into a bathroom elsewhere along the same wall',
  );
  assert.deepEqual(original, saved, 'command execution cannot mutate the current scene');
  for (const room of original.rooms.filter(
    (r) => !['west-suite', 'west-bath', 'east-suite', 'east-bath', 'kitchen'].includes(r.id),
  ))
    assert.deepEqual(
      result.scene.rooms.find((r) => r.id === room.id),
      room,
    );
  const west = result.scene.rooms.find((r) => r.id === 'west-suite')!;
  const bath = result.scene.rooms.find((r) => r.id === 'west-bath')!;
  const kitchen = result.scene.rooms.find((r) => r.id === 'kitchen')!;
  assert.equal(west.x, -9);
  assert.equal(bath.x, -9);
  assert.equal(bath.z - west.z, -4.5, 'wing layout remains rigid');
  assert.equal(bounds(west).east, bounds(kitchen).west);
  const westOpening = roomOpenings(result.scene, west.id, 'east')[0];
  const kitchenOpening = roomOpenings(result.scene, kitchen.id, 'west')[0];
  assert.equal(west.z + westOpening.offset, kitchen.z + kitchenOpening.offset);
  assert.notEqual(
    westOpening.offset,
    kitchenOpening.offset,
    'offset doors align in world space, not at unrelated wall centers',
  );
});

test('resize uses its fixed edge and reflows connected rooms and their bathrooms deterministically', () => {
  const source = cleanScene([
    makeRoom({ id: 'kitchen', name: 'Kitchen', x: 0, z: 0, width: 6, depth: 6, east: 'solid' }),
    makeRoom({ id: 'bed', name: 'Bedroom', x: 6, z: 0, width: 6, depth: 6 }),
    makeRoom({ id: 'bath', name: 'Bathroom', x: 6, z: -4.5, width: 6, depth: 3 }),
    makeRoom({ id: 'unrelated', x: -20, z: 20 }),
  ]);
  source.fireplace = { x: 6, z: 0, elevation: 0, height: 4 };
  const prepared = executeCommands(source, [
    { type: 'connect_rooms', roomAId: 'kitchen', roomBId: 'bed' },
    { type: 'connect_rooms', roomAId: 'bed', roomBId: 'bath' },
    { type: 'define_group', group: { id: 'suite', name: 'Suite', roomIds: ['bed', 'bath'] } },
  ]).scene;
  const result = executeCommands(prepared, [
    { type: 'resize_room', roomId: 'kitchen', width: 8, anchor: 'west' },
  ]);
  assert.equal(result.applied, true);
  assert.deepEqual(errors(result.scene), []);
  const kitchen = result.scene.rooms[0],
    bed = result.scene.rooms[1],
    bath = result.scene.rooms[2];
  assert.equal(bounds(kitchen).west, -3);
  assert.equal(kitchen.x, 1);
  assert.equal(bed.x, 8);
  assert.equal(bath.x, 8);
  assert.equal(result.scene.fireplace?.x, 8, 'a fireplace moves with its reflowed owner room');
  assert.deepEqual(result.scene.rooms[3], source.rooms[3]);
  assert.equal(sharedBoundary(kitchen, bed)?.length, 6);
  const connection = getDesign(result.scene).connections.find((c) => c.roomAId === 'bed')!;
  assert.equal(connection.center, 8, 'internal opening follows the translated wing');
});

test('command failures roll back whole batches; geometric conflicts can be repaired in isolated drafts', () => {
  const original = cleanScene([makeRoom({ id: 'a' }), makeRoom({ id: 'b', x: 10 })]);
  const failure = executeCommands(original, [
    { type: 'set_material', palette: 'cedar' },
    { type: 'attach_room', roomId: 'does-not-exist', targetRoomId: 'a', side: 'east' },
  ]);
  assert.equal(failure.applied, false);
  assert.deepEqual(failure.scene, original);
  assert.deepEqual(failure.changes, []);
  assert.equal(failure.issues[0].code, 'room_not_found');
  const conflict = executeCommands(original, [
    { type: 'move_group', roomIds: ['b'], dx: -8, dz: 0 },
  ]);
  assert.equal(conflict.applied, true);
  assert.equal(conflict.issues.find((i) => i.code === 'room_overlap')?.details?.x, 4);
  assert.equal(original.rooms[1].x, 10);
  const repaired = executeCommands(conflict.scene, [
    { type: 'attach_room', roomId: 'b', targetRoomId: 'a', side: 'east' },
  ]);
  assert.deepEqual(errors(repaired.scene), []);
  assert.equal(repaired.scene.rooms[1].x, 6);
  const invalid = executeCommands(original, [
    { type: 'resize_room', roomId: 'a', width: -1, anchor: 'center' },
  ]);
  assert.equal(invalid.applied, false);
  assert.deepEqual(invalid.scene, original);
});

test('locks capture engine-owned geometry, detect changes, and local palettes preserve other rooms', () => {
  const original = cleanScene([makeRoom({ id: 'kitchen' }), makeRoom({ id: 'bedroom', x: 12 })]);
  const locked = executeCommands(original, [
    {
      type: 'set_requirement',
      requirement: {
        id: 'keep-kitchen',
        kind: 'locked',
        roomId: 'kitchen',
        properties: ['position', 'size', 'material'],
        source: 'confirmed',
        description: 'Keep the kitchen where it is.',
        snapshot: { x: 55, z: 0, elevation: 0, width: 1, depth: 1, height: 3, palette: 'cedar' },
      },
    },
  ]).scene;
  const requirement = getDesign(locked).requirements[0];
  assert.equal(requirement.kind === 'locked' ? requirement.snapshot?.x : null, 0);
  const moved = executeCommands(locked, [
    { type: 'move_group', roomIds: ['kitchen'], dx: 1, dz: 0 },
  ]);
  assert.equal(moved.issues.find((i) => i.code === 'locked_property_changed')?.severity, 'error');
  const material = executeCommands(locked, [
    { type: 'set_material', roomIds: ['bedroom'], palette: 'cedar' },
  ]);
  assert.equal(material.scene.rooms[1].palette, 'cedar');
  assert.equal(material.scene.palette, 'limestone');
  assert.deepEqual(material.scene.rooms[0], locked.rooms[0]);
  assert.deepEqual(errors(material.scene), []);
});

test('confirmed connectivity rejects outdoor shortcuts, while preferences and assumptions remain warnings', () => {
  const source = cleanScene([
    makeRoom({ id: 'main', x: 0, width: 4, depth: 4, east: 'open' }),
    makeRoom({ id: 'court', kind: 'courtyard', x: 4, width: 4, depth: 4 }),
    makeRoom({ id: 'bed', x: 8, width: 4, depth: 4, west: 'open' }),
  ]);
  const result = executeCommands(source, [
    {
      type: 'set_requirement',
      requirement: {
        id: 'indoor',
        kind: 'connectivity',
        source: 'confirmed',
        description: 'Indoor bedroom access.',
        roomIds: ['bed'],
        targetRoomId: 'main',
        indoorOnly: true,
      },
    },
    {
      type: 'set_requirement',
      requirement: {
        id: 'outdoor',
        kind: 'connectivity',
        source: 'preference',
        description: 'Courtyard access is acceptable.',
        roomIds: ['bed'],
        targetRoomId: 'main',
        indoorOnly: false,
      },
    },
  ]);
  const failures = result.issues.filter((i) => i.code === 'required_connection_missing');
  assert.equal(failures.length, 1);
  assert.equal(failures[0].details?.requirementId, 'indoor');
  assert.equal(failures[0].severity, 'error');
});

test('symmetry and overlook requirements are machine checked and identify affected rooms', () => {
  const source = cleanScene([
    makeRoom({ id: 'living', x: 0, z: 2, width: 8, depth: 6, height: 6.4, north: 'open' }),
    makeRoom({ id: 'kitchen', x: 0, z: -4, width: 8, depth: 6, elevation: 3.2, south: 'open' }),
    makeRoom({ id: 'west', x: -12, z: 0 }),
    makeRoom({ id: 'east', x: 12, z: 0 }),
  ]);
  const prepared = executeCommands(source, [
    {
      type: 'set_requirement',
      requirement: {
        id: 'view',
        kind: 'overlook',
        upperRoomId: 'kitchen',
        lowerRoomId: 'living',
        source: 'confirmed',
        description: 'Kitchen overlooks the double-height living room.',
      },
    },
    {
      type: 'set_requirement',
      requirement: {
        id: 'mirror',
        kind: 'symmetry',
        pairs: [{ roomAId: 'west', roomBId: 'east' }],
        axis: 'x',
        center: 0,
        source: 'preference',
        description: 'Prefer matching wings.',
      },
    },
  ]).scene;
  assert.deepEqual(errors(prepared), []);
  const changed = executeCommands(prepared, [
    { type: 'update_room', roomId: 'kitchen', patch: { south: 'solid' } },
    { type: 'move_group', roomIds: ['west'], dx: -1, dz: 0 },
  ]);
  assert.equal(changed.issues.find((i) => i.code === 'overlook_broken')?.severity, 'error');
  assert.equal(changed.issues.find((i) => i.code === 'symmetry_broken')?.severity, 'warning');
});

test('connect_levels computes reachable stair endpoints and declared links detect broken landings', () => {
  const source = cleanScene([
    makeRoom({ id: 'living', name: 'Living', x: 0, z: 0, width: 8, depth: 10, height: 6.4 }),
    makeRoom({ id: 'kitchen', name: 'Kitchen', x: 0, z: -8, width: 8, depth: 6, elevation: 3.2 }),
  ]);
  const connected = executeCommands(source, [
    {
      type: 'connect_levels',
      stairId: 'main-stairs',
      lowerRoomId: 'living',
      upperRoomId: 'kitchen',
      run: 4.5,
    },
    {
      type: 'set_requirement',
      requirement: {
        id: 'level-access',
        kind: 'connectivity',
        source: 'confirmed',
        description: 'Kitchen has indoor living room access.',
        roomIds: ['kitchen'],
        targetRoomId: 'living',
        indoorOnly: true,
      },
    },
  ]);
  assert.equal(connected.applied, true);
  assert.deepEqual(errors(connected.scene), []);
  const ends = stairEndpoints(connected.scene.stairs[0]);
  assert.equal(ends.bottom.elevation, 0);
  assert.equal(ends.top.elevation, 3.2);
  assert.ok(ends.top.z < -5);
  assert.equal(inspectDesign(connected.scene).components.length, 1);
  const narrow = structuredClone(connected.scene);
  narrow.stairs[0].x = 3.8;
  assert.ok(validateDesign(narrow).some((i) => i.code === 'stair_landing_too_narrow'));
  const blocked = structuredClone(connected.scene);
  blocked.rooms[0].north = 'solid';
  assert.ok(validateDesign(blocked).some((i) => i.code === 'stair_wall_blocked'));
  const broken = executeCommands(connected.scene, [
    { type: 'move_group', roomIds: ['kitchen'], dx: 12, dz: 0 },
  ]);
  assert.ok(broken.issues.some((i) => i.code === 'stair_landing_missing'));
  assert.ok(broken.issues.some((i) => i.code === 'required_connection_missing'));
});

test('moving both linked floors moves stairs and fireplace with the assembly', () => {
  const source = cleanScene([
    makeRoom({ id: 'lower', x: 0, z: 0, width: 8, depth: 10, height: 6.4 }),
    makeRoom({ id: 'upper', x: 0, z: -8, width: 8, depth: 6, elevation: 3.2 }),
  ]);
  source.fireplace = { x: 0, z: 0, elevation: 0, height: 7 };
  const connected = executeCommands(source, [
    {
      type: 'connect_levels',
      stairId: 'stairs',
      lowerRoomId: 'lower',
      upperRoomId: 'upper',
      run: 4,
    },
  ]).scene;
  const moved = executeCommands(connected, [
    { type: 'move_group', roomIds: ['lower', 'upper'], dx: 10, dz: 7, elevationDelta: 1 },
  ]);
  assert.deepEqual(errors(moved.scene), []);
  assert.equal(moved.scene.stairs[0].x, connected.stairs[0].x + 10);
  assert.equal(moved.scene.stairs[0].z, connected.stairs[0].z + 7);
  assert.equal(moved.scene.stairs[0].elevation, 1);
  assert.deepEqual(moved.scene.fireplace, { x: 10, z: 7, elevation: 1, height: 7 });
});

test('commit policy tolerates legacy islands while rejecting new orphan rooms and split existing routes', () => {
  const original = cleanScene([
    makeRoom({ id: 'a', name: 'A', x: 0, east: 'open' }),
    makeRoom({ id: 'b', name: 'B', x: 6, west: 'open', east: 'solid' }),
    makeRoom({ id: 'legacy', name: 'Old island', x: 20, east: 'solid' }),
  ]);
  const material = executeCommands(original, [{ type: 'set_material', palette: 'cedar' }]);
  assert.deepEqual(
    validateDesignChange(original, material.scene).filter((i) => i.severity === 'error'),
    [],
  );
  const split = executeCommands(original, [{ type: 'move_group', roomIds: ['b'], dx: 3, dz: 0 }]);
  assert.ok(
    validateDesignChange(original, split.scene).some((i) => i.code === 'circulation_regression'),
  );
  const added = executeCommands(original, [
    { type: 'add_rooms', rooms: [makeRoom({ id: 'new', x: -20 })] },
  ]);
  assert.ok(
    validateDesignChange(original, added.scene).some(
      (i) => i.code === 'new_disconnected_room' && i.objectIds.includes('new'),
    ),
  );
  const attached = executeCommands(added.scene, [
    { type: 'attach_room', roomId: 'new', targetRoomId: 'legacy', side: 'east' },
  ]);
  assert.deepEqual(
    validateDesignChange(original, attached.scene).filter((i) => i.severity === 'error'),
    [],
    'a new room may join an existing isolated wing',
  );
});

test('commit policy requires connected first houses, newly aligned doors, and verified new stairs', () => {
  const original = cleanScene([]);
  const islands = cleanScene([
    makeRoom({ id: 'a', x: 0, east: 'solid' }),
    makeRoom({ id: 'b', x: 12, west: 'solid' }),
  ]);
  assert.ok(
    validateDesignChange(original, islands).some((i) => i.code === 'new_disconnected_room'),
  );
  const joined = executeCommands(islands, [
    { type: 'attach_room', roomId: 'b', targetRoomId: 'a', side: 'east' },
  ]).scene;
  assert.deepEqual(
    validateDesignChange(original, joined).filter((i) => i.severity === 'error'),
    [],
  );
  const unlinked = structuredClone(joined);
  unlinked.stairs.push({
    id: 'unverified',
    x: 0,
    z: 0,
    elevation: 0,
    width: 1.2,
    run: 4,
    rise: 3.2,
    rotation: 0,
  });
  assert.equal(
    validateDesignChange(joined, unlinked).find((i) => i.code === 'stair_unlinked')?.severity,
    'error',
  );
  assert.equal(
    validateDesignChange(unlinked, { ...unlinked, palette: 'cedar' }).find(
      (i) => i.code === 'stair_unlinked',
    )?.severity,
    'warning',
  );
  const neighboring = cleanScene([
    makeRoom({ id: 'a', x: 0, east: 'solid' }),
    makeRoom({ id: 'b', x: 6, west: 'solid' }),
  ]);
  const misaligned = structuredClone(neighboring);
  misaligned.rooms[0].east = 'door';
  assert.equal(
    validateDesignChange(neighboring, misaligned).find((i) => i.code === 'door_misaligned')
      ?.severity,
    'error',
  );
});

test('confirmed courtyard access allows a connected guest pavilion without a mandatory indoor route', () => {
  const original = cleanScene([makeRoom({ id: 'main', x: 0, width: 4, depth: 4, east: 'open' })]);
  const result = executeCommands(original, [
    {
      type: 'add_rooms',
      rooms: [
        makeRoom({ id: 'court', kind: 'courtyard', x: 4, width: 4, depth: 4 }),
        makeRoom({ id: 'guest', x: 8, width: 4, depth: 4, west: 'open' }),
      ],
    },
    {
      type: 'set_requirement',
      requirement: {
        id: 'guest-access',
        kind: 'connectivity',
        source: 'confirmed',
        description: 'Reach the guest pavilion through the courtyard.',
        roomIds: ['guest'],
        targetRoomId: 'main',
        indoorOnly: false,
      },
    },
  ]);
  assert.deepEqual(
    validateDesignChange(original, result.scene).filter((i) => i.severity === 'error'),
    [],
  );
  const preference = structuredClone(result.scene);
  preference.design!.requirements[0].source = 'preference';
  assert.ok(
    validateDesignChange(original, preference).some((i) => i.code === 'new_disconnected_room'),
  );
  const unreachable = structuredClone(result.scene);
  unreachable.rooms.find((r) => r.id === 'guest')!.x = 14;
  assert.ok(
    validateDesignChange(original, unreachable).some(
      (i) => i.code === 'required_connection_missing',
    ),
  );
  assert.ok(
    validateDesignChange(original, unreachable).some((i) => i.code === 'new_disconnected_room'),
  );
});

test('rewording an existing lock cannot rebase its snapshot to invalid draft geometry', () => {
  const original = cleanScene([makeRoom({ id: 'a' })]);
  const lock = {
    id: 'lock',
    kind: 'locked' as const,
    roomId: 'a',
    properties: ['position' as const],
    source: 'confirmed' as const,
    description: 'Keep this room fixed.',
  };
  const locked = executeCommands(original, [{ type: 'set_requirement', requirement: lock }]).scene;
  const updated = executeCommands(locked, [
    { type: 'move_group', roomIds: ['a'], dx: 3, dz: 0 },
    { type: 'set_requirement', requirement: { ...lock, description: 'Still keep it fixed.' } },
  ]);
  assert.ok(updated.issues.some((i) => i.code === 'locked_property_changed'));
  const remembered = getDesign(updated.scene).requirements[0];
  assert.equal(remembered.kind === 'locked' ? remembered.snapshot?.x : null, 0);
});

test('door alignment checks only the shared segment containing the actual offset opening', () => {
  const original = cleanScene([
    makeRoom({ id: 'main', x: 0, z: 0, width: 8, depth: 12, east: 'solid' }),
    makeRoom({ id: 'bed', x: 7, z: 2, width: 6, depth: 6, west: 'solid', north: 'solid' }),
    makeRoom({ id: 'bath', x: 7, z: -2.5, width: 6, depth: 3, west: 'solid', south: 'solid' }),
  ]);
  const result = executeCommands(original, [
    { type: 'connect_rooms', roomAId: 'main', roomBId: 'bed', center: 2.5 },
    { type: 'connect_rooms', roomAId: 'bed', roomBId: 'bath' },
  ]);
  assert.equal(result.applied, true);
  assert.equal(
    result.issues.some((i) => i.code === 'door_misaligned'),
    false,
  );
  assert.deepEqual(
    validateDesignChange(original, result.scene).filter((i) => i.severity === 'error'),
    [],
  );
  const blocked = structuredClone(result.scene);
  blocked.design!.connections = [];
  blocked.rooms[1].west = 'solid';
  assert.ok(
    validateDesign(blocked).some(
      (i) =>
        i.code === 'door_misaligned' && i.objectIds.includes('main') && i.objectIds.includes('bed'),
    ),
    'a real centered legacy doorway blocked by its neighbor is still reported',
  );
});
