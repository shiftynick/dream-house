import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyScene, makeRoom, sceneSchema, type Scene, type Side } from '../shared/model.ts';
import {
  effectiveRoof,
  roofHeightAt,
  roofMaximumHeight,
  roofRise,
} from '../shared/architecture.ts';
import { roomOpenings } from '../shared/openings.ts';
import { hillsideHouse } from '../shared/examples.ts';
import {
  circulationEdges,
  executeCommands,
  inspectDesign,
  validateDesign,
  validateDesignChange,
} from '../shared/design.ts';

const sceneWith = (...rooms: Scene['rooms']): Scene => ({
  ...structuredClone(emptyScene),
  slope: 0,
  rooms,
});
const room = (id = 'main', patch: Partial<Scene['rooms'][number]> = {}) =>
  makeRoom({
    id,
    name: id,
    kind: 'other',
    width: 8,
    depth: 8,
    height: 3,
    ...patch,
  });
const errors = (scene: Scene) =>
  validateDesign(scene).filter((issue) => issue.severity === 'error');
const window = (id: string, offset: number) => ({
  id,
  kind: 'window' as const,
  offset,
  width: 1.4,
  height: 1.4,
  sill: 1,
});
const door = (id: string, offset: number) => ({
  id,
  kind: 'door' as const,
  offset,
  width: 1,
  height: 2.2,
  sill: 0,
});
const close = (actual: number, expected: number) =>
  assert.ok(Math.abs(actual - expected) < 0.0001, `${actual} should equal ${expected}`);

test('legacy gables preserve their ridge direction and exact old rise without changing version-1 documents', () => {
  for (const width of [4, 10, 20]) {
    const original = { ...sceneWith(room('old', { width })), roof: 'pitched' as const };
    const parsed = sceneSchema.parse(JSON.parse(JSON.stringify(original)));
    assert.deepEqual(parsed, original);
    assert.equal(effectiveRoof(parsed, parsed.rooms[0]).direction, 'east');
    close(roofRise(parsed, parsed.rooms[0]), Math.min(2.5, width * 0.22));
    close(roofHeightAt(parsed, parsed.rooms[0], width / 2, 0), 3);
    close(roofHeightAt(parsed, parsed.rooms[0], 0, 0), 3 + Math.min(2.5, width * 0.22));
  }
});

test('single-pitch roofs have a genuine single plane, minimum eave height, and explicit high-edge direction', () => {
  for (const direction of ['north', 'south', 'east', 'west'] as Side[]) {
    const result = executeCommands(
      sceneWith(room('main', { x: 10, z: 20, elevation: 2, width: 8, depth: 6 })),
      [{ type: 'set_roof', style: 'single-pitch', pitch: 30, direction }],
    );
    assert.deepEqual(
      result.issues.filter((issue) => issue.severity === 'error'),
      [],
    );
    const r = result.scene.rooms[0];
    const sign = direction === 'north' || direction === 'west' ? -1 : 1;
    const ns = direction === 'north' || direction === 'south';
    const span = ns ? r.depth : r.width;
    const high = { x: r.x + (ns ? 0 : (sign * span) / 2), z: r.z + (ns ? (sign * span) / 2 : 0) };
    const low = { x: r.x - (high.x - r.x), z: r.z - (high.z - r.z) };
    const rise = Math.tan(Math.PI / 6) * span;
    close(roofHeightAt(result.scene, r, low.x, low.z), 5);
    close(roofHeightAt(result.scene, r, high.x, high.z), 5 + rise);
    close(roofHeightAt(result.scene, r, r.x, r.z), 5 + rise / 2);
    close(roofMaximumHeight(result.scene, r), 5 + rise);
    close(
      roofHeightAt(result.scene, r, high.x + (ns ? 0 : sign * 0.3), high.z + (ns ? sign * 0.3 : 0)),
      5 + rise + Math.tan(Math.PI / 6) * 0.3,
    );
  }
});

test('room roof overrides remain independent and reset deterministically to changing house defaults', () => {
  const original = sceneWith(room('main'), room('wing', { x: 8 }));
  const result = executeCommands(original, [
    { type: 'set_roof', style: 'single-pitch', pitch: 12, direction: 'south' },
    { type: 'set_roof', roomIds: ['wing'], style: 'pitched', pitch: 35, direction: 'west' },
    { type: 'set_roof', style: 'single-pitch', pitch: 18, direction: 'north' },
  ]);
  assert.deepEqual(effectiveRoof(result.scene, result.scene.rooms[0]), {
    style: 'single-pitch',
    pitch: 18,
    direction: 'north',
  });
  assert.deepEqual(effectiveRoof(result.scene, result.scene.rooms[1]), {
    style: 'pitched',
    pitch: 35,
    direction: 'west',
  });
  const reset = executeCommands(result.scene, [{ type: 'reset_roof', roomIds: ['wing'] }]);
  assert.equal(reset.scene.rooms[1].roof, undefined);
  assert.deepEqual(
    effectiveRoof(reset.scene, reset.scene.rooms[1]),
    effectiveRoof(reset.scene, reset.scene.rooms[0]),
  );
  assert.equal(original.roof, 'flat');
  assert.equal(original.rooms[1].roof, undefined);
  const invalid = executeCommands(original, [
    { type: 'set_roof', style: 'single-pitch', pitch: 80, direction: 'north' },
  ]);
  assert.equal(invalid.applied, false);
  assert.deepEqual(invalid.scene, original);
});

test('one facade supports distinct windows and an off-center door with explicit dimensions and sill heights', () => {
  const result = executeCommands(sceneWith(room('main', { width: 10, north: 'glass' })), [
    {
      type: 'set_wall_openings',
      roomId: 'main',
      side: 'north',
      openings: [window('left', -3.3), door('entry', -0.5), window('right', 2.7)],
    },
  ]);
  assert.equal(result.applied, true);
  assert.deepEqual(errors(result.scene), []);
  assert.equal(result.scene.rooms[0].north, 'solid');
  const openings = roomOpenings(result.scene, 'main', 'north');
  assert.deepEqual(
    openings.map((o) => [o.id, o.kind, o.offset, o.sill]),
    [
      ['left', 'window', -3.3, 1],
      ['entry', 'door', -0.5, 0],
      ['right', 'window', 2.7, 1],
    ],
  );
  assert.deepEqual(inspectDesign(result.scene).rooms[0].openings.north, openings);
  assert.deepEqual(
    executeCommands(result.scene, [
      {
        type: 'set_wall_openings',
        roomId: 'main',
        side: 'north',
        openings: [window('left', -3.3), door('entry', -0.5), window('right', 2.7)],
      },
    ]).scene,
    result.scene,
  );
});

test('shared apertures mirror once, windows never create circulation, and shared doors create real routes', () => {
  const original = sceneWith(room('west'), room('east', { x: 8, z: 1, depth: 10 }));
  const glazed = executeCommands(original, [
    {
      type: 'set_wall_openings',
      roomId: 'west',
      side: 'east',
      openings: [window('north-window', -2.5), window('south-window', 2.5)],
    },
  ]);
  assert.deepEqual(errors(glazed.scene), []);
  assert.deepEqual(circulationEdges(glazed.scene), []);
  assert.deepEqual(
    roomOpenings(glazed.scene, 'east', 'west').map((o) => [o.id, o.offset, o.sourceRoomId]),
    [
      ['north-window', -3.5, 'west'],
      ['south-window', 1.5, 'west'],
    ],
  );
  const connected = executeCommands(glazed.scene, [
    {
      type: 'set_wall_openings',
      roomId: 'west',
      side: 'east',
      openings: [window('north-window', -2.5), door('shared-door', 0), window('south-window', 2.5)],
    },
  ]);
  assert.deepEqual(errors(connected.scene), []);
  assert.deepEqual(circulationEdges(connected.scene), [['west', 'east']]);
  assert.equal(
    roomOpenings(connected.scene, 'east', 'west').filter((o) => o.kind === 'door').length,
    1,
  );
  const replaced = executeCommands(connected.scene, [
    {
      type: 'set_wall_openings',
      roomId: 'east',
      side: 'west',
      openings: [window('one-new-window', 0)],
    },
  ]);
  assert.equal(
    replaced.scene.rooms[0].wallOpenings,
    undefined,
    'editing the opposite face transfers physical ownership',
  );
  assert.equal(roomOpenings(replaced.scene, 'west', 'east').length, 1);
  assert.ok(
    validateDesignChange(connected.scene, replaced.scene).some(
      (i) => i.code === 'circulation_regression',
    ),
  );
});

test('standalone windows coexist with semantic passage doors and multiple semantic doors retain stable IDs', () => {
  const original = sceneWith(room('west'), room('east', { x: 8 }));
  const result = executeCommands(original, [
    {
      type: 'connect_rooms',
      roomAId: 'west',
      roomBId: 'east',
      connectionId: 'north-door',
      center: -2,
      width: 1,
    },
    {
      type: 'connect_rooms',
      roomAId: 'west',
      roomBId: 'east',
      connectionId: 'south-door',
      center: 2,
      width: 1,
    },
    {
      type: 'set_wall_openings',
      roomId: 'west',
      side: 'east',
      openings: [{ ...window('middle-window', 0), width: 1 }],
    },
  ]);
  assert.deepEqual(errors(result.scene), []);
  assert.equal(result.scene.design?.connections.length, 2);
  assert.equal(roomOpenings(result.scene, 'east', 'west').length, 3);
  const updated = executeCommands(result.scene, [
    {
      type: 'connect_rooms',
      roomAId: 'west',
      roomBId: 'east',
      connectionId: 'north-door',
      center: -2.5,
      width: 0.9,
    },
    { type: 'set_wall_openings', roomId: 'west', side: 'east', openings: [] },
  ]);
  assert.deepEqual(errors(updated.scene), []);
  assert.equal(updated.scene.design?.connections.find((c) => c.id === 'north-door')?.center, -2.5);
  assert.equal(updated.scene.design?.connections.find((c) => c.id === 'south-door')?.center, 2);
  assert.equal(
    roomOpenings(updated.scene, 'west', 'east').length,
    2,
    'replacing explicit apertures preserves semantic connections',
  );
});

test('apertures follow rigid group moves and preserve anchored wall positions during room resizing', () => {
  const added = executeCommands(sceneWith(room()), [
    {
      type: 'set_wall_openings',
      roomId: 'main',
      side: 'north',
      openings: [window('fixed-window', -2)],
    },
  ]).scene;
  const resized = executeCommands(added, [
    { type: 'resize_room', roomId: 'main', width: 10, anchor: 'west' },
  ]);
  assert.deepEqual(errors(resized.scene), []);
  assert.equal(resized.scene.rooms[0].x, 1);
  assert.equal(roomOpenings(resized.scene, 'main', 'north')[0].offset, -3);
  const moved = executeCommands(resized.scene, [
    { type: 'move_group', roomIds: ['main'], dx: 5, dz: -3, elevationDelta: 1 },
  ]);
  assert.equal(moved.scene.rooms[0].wallOpenings?.[0].offset, -3);
  assert.equal(moved.scene.rooms[0].x, 6);
  assert.equal(moved.scene.rooms[0].elevation, 1);
  const shrunk = executeCommands(added, [
    { type: 'resize_room', roomId: 'main', width: 3, anchor: 'center' },
  ]);
  assert.equal(shrunk.applied, true, 'invalid geometry remains a repairable draft');
  assert.ok(shrunk.issues.some((i) => i.code === 'opening_outside_wall'));
  assert.equal(
    shrunk.scene.rooms[0].wallOpenings?.[0].width,
    1.4,
    'resize never silently deletes or shrinks a window',
  );
});

test('aperture validation rejects overlapping rectangles, unusable doors, duplicate IDs, and partly blocked shared openings', () => {
  const original = sceneWith(room('main'), room('neighbor', { x: 8, z: 3, depth: 2 }));
  for (const [openings, code] of [
    [[window('a', 0), door('b', 0)], 'opening_overlap'],
    [[{ ...door('raised-door', 0), sill: 0.3 }], 'passage_dimensions'],
    [[{ ...window('outside', 4), width: 2 }], 'opening_outside_wall'],
    [[{ ...window('too-high', 0), sill: 2 }], 'opening_too_high'],
    [[{ ...window('straddling-neighbor', 2), width: 2 }], 'opening_shared_wall_conflict'],
  ] as const) {
    const result = executeCommands(original, [
      { type: 'set_wall_openings', roomId: 'main', side: 'east', openings },
    ]);
    assert.equal(result.applied, true);
    assert.ok(
      result.issues.some((issue) => issue.code === code),
      `${code}: ${JSON.stringify(result.issues)}`,
    );
  }
  const ids = executeCommands(original, [
    { type: 'set_wall_openings', roomId: 'main', side: 'north', openings: [window('same', 0)] },
    { type: 'set_wall_openings', roomId: 'main', side: 'south', openings: [window('same', 0)] },
  ]);
  assert.equal(ids.applied, false);
  assert.deepEqual(
    ids.scene,
    original,
    'duplicate-ID command failures roll back the complete batch',
  );
});

test('clerestory window validation follows the sloping wall head and does not use minimum eave height everywhere', () => {
  const roofed = executeCommands(sceneWith(room()), [
    { type: 'set_roof', style: 'single-pitch', pitch: 20, direction: 'east' },
  ]).scene;
  const high = executeCommands(roofed, [
    {
      type: 'set_wall_openings',
      roomId: 'main',
      side: 'east',
      openings: [{ ...window('clerestory', 0), sill: 3.5, height: 1 }],
    },
  ]);
  assert.deepEqual(errors(high.scene), []);
  const low = executeCommands(roofed, [
    {
      type: 'set_wall_openings',
      roomId: 'main',
      side: 'west',
      openings: [{ ...window('clerestory', 0), sill: 3.5, height: 1 }],
    },
  ]);
  assert.ok(low.issues.some((i) => i.code === 'opening_too_high'));
});

test('confirmed roof and opening locks protect resolved defaults and mirrored geometry against spoofed rebasing', () => {
  const original = sceneWith(room('west'), room('east', { x: 8 }));
  const requirement = {
    id: 'keep-architecture',
    kind: 'locked',
    roomId: 'east',
    properties: ['roof', 'openings'],
    source: 'confirmed',
    description: 'Keep the roof and shared windows.',
  };
  const locked = executeCommands(original, [
    { type: 'set_roof', style: 'single-pitch', pitch: 15, direction: 'east' },
    {
      type: 'set_wall_openings',
      roomId: 'west',
      side: 'east',
      openings: [window('shared-window', 0)],
    },
    { type: 'set_requirement', requirement },
  ]).scene;
  assert.deepEqual(errors(locked), []);
  const changed = executeCommands(locked, [
    { type: 'set_roof', style: 'single-pitch', pitch: 30, direction: 'north' },
    {
      type: 'set_wall_openings',
      roomId: 'west',
      side: 'east',
      openings: [window('shared-window', 1)],
    },
    {
      type: 'set_requirement',
      requirement: { ...requirement, description: 'Rewording must retain the original snapshot.' },
    },
  ]);
  const conflict = changed.issues.find((i) => i.code === 'locked_property_changed');
  assert.deepEqual(conflict?.details?.properties, ['roof', 'openings']);
});

test('split-level attachment keeps an explicit floor offset and automatic stairs use actual sloped roof headroom', () => {
  const original = sceneWith(
    room('lower', { height: 2.4 }),
    room('upper', { x: 20, width: 4, height: 3 }),
  );
  const result = executeCommands(original, [
    { type: 'set_roof', roomIds: ['lower'], style: 'single-pitch', pitch: 30, direction: 'east' },
    {
      type: 'attach_room',
      roomId: 'upper',
      targetRoomId: 'lower',
      side: 'east',
      elevationOffset: 3,
      connect: false,
    },
    {
      type: 'connect_levels',
      stairId: 'split-stair',
      lowerRoomId: 'lower',
      upperRoomId: 'upper',
      width: 1.2,
      run: 4,
    },
  ]);
  assert.equal(result.applied, true, JSON.stringify(result.issues));
  assert.deepEqual(errors(result.scene), []);
  assert.equal(result.scene.rooms[1].elevation, 3);
  assert.equal(result.scene.rooms[1].x, 6);
  assert.deepEqual(circulationEdges(result.scene), [['lower', 'upper']]);
  assert.equal(result.scene.stairs[0].rise, 3);
  assert.deepEqual(
    original.rooms.map((r) => r.elevation),
    [0, 0],
  );
});

test('the original hillside example is coherent from an empty site with real indoor access between its levels', () => {
  const scene = hillsideHouse();
  assert.equal(scene.rooms.length, 13);
  assert.equal(scene.stairs.length, 4);
  assert.deepEqual(
    validateDesignChange(emptyScene, scene).filter((i) => i.severity === 'error'),
    [],
  );
  assert.equal(inspectDesign(scene).components.length, 1);
  assert.equal(scene.design?.stairLinks.length, 4);
  assert.equal(scene.rooms.find((r) => r.id === 'kitchen')?.elevation, 3);
  assert.equal(scene.rooms.find((r) => r.id === 'living')?.height, 6.2);
  assert.equal(scene.rooms.filter((r) => r.kind === 'courtyard').length, 2);
  const westFacade = roomOpenings(scene, 'west-guest', 'south');
  const eastFacade = roomOpenings(scene, 'east-guest', 'south');
  for (const kind of ['door', 'window']) {
    const west = westFacade.find((opening) => opening.kind === kind)!;
    const east = eastFacade.find((opening) => opening.kind === kind)!;
    close(west.offset, -east.offset);
    close(west.width, east.width);
  }
  const independent = hillsideHouse();
  scene.rooms[0].width = 20;
  assert.equal(
    independent.rooms[0].width,
    12,
    'loading an example always creates independent house geometry',
  );
});

test('a split-level stair portal uses its actual aperture position and raised opposite face', () => {
  const connected = executeCommands(
    sceneWith(room('lower', { height: 6 }), room('upper', { x: 6, width: 4, elevation: 3 })),
    [
      {
        type: 'connect_levels',
        stairId: 'flight',
        lowerRoomId: 'lower',
        upperRoomId: 'upper',
        run: 4,
        width: 1.2,
      },
      {
        type: 'set_wall_openings',
        roomId: 'upper',
        side: 'west',
        openings: [{ ...door('landing-door', 0), width: 1.4, height: 2.4 }],
      },
    ],
  );
  assert.deepEqual(errors(connected.scene), []);
  assert.equal(roomOpenings(connected.scene, 'lower', 'east')[0].sill, 3);
  assert.deepEqual(circulationEdges(connected.scene), [['lower', 'upper']]);
  const fromBelow = roomOpenings(connected.scene, 'lower', 'east').map(
    ({ source: _source, sourceRoomId: _owner, ...opening }) => ({ ...opening, width: 1.6 }),
  );
  const editedFromBelow = executeCommands(connected.scene, [
    { type: 'set_wall_openings', roomId: 'lower', side: 'east', openings: fromBelow },
  ]);
  assert.deepEqual(errors(editedFromBelow.scene), []);
  assert.equal(editedFromBelow.scene.rooms.find((r) => r.id === 'lower')?.wallOpenings, undefined);
  const ownedDoor = editedFromBelow.scene.rooms.find((r) => r.id === 'upper')?.wallOpenings?.[0];
  assert.equal(ownedDoor?.sill, 0);
  assert.equal(ownedDoor?.width, 1.6);
  assert.equal(roomOpenings(editedFromBelow.scene, 'lower', 'east')[0].sill, 3);
  assert.deepEqual(circulationEdges(editedFromBelow.scene), [['lower', 'upper']]);
  const misplaced = executeCommands(connected.scene, [
    {
      type: 'set_wall_openings',
      roomId: 'upper',
      side: 'west',
      openings: [{ ...door('landing-door', 2), width: 1.4, height: 2.4 }],
    },
  ]);
  assert.ok(misplaced.issues.some((i) => i.code === 'stair_wall_blocked'));
  assert.deepEqual(circulationEdges(misplaced.scene), []);
  const unlinked = structuredClone(connected.scene);
  unlinked.design!.stairLinks = [];
  assert.ok(errors(unlinked).some((i) => i.code === 'opening_shared_wall_conflict'));
  assert.equal(
    roomOpenings(unlinked, 'lower', 'east').length,
    0,
    'a raised doorway needs an actual stair relationship',
  );
});

test('closing one neighboring passage preserves other passages along the same wall', () => {
  const connected = executeCommands(
    sceneWith(
      room('main', { depth: 12 }),
      room('north-neighbor', { x: 8, z: -3, depth: 6 }),
      room('south-neighbor', { x: 8, z: 3, depth: 6 }),
    ),
    [
      { type: 'connect_rooms', roomAId: 'main', roomBId: 'north-neighbor' },
      { type: 'connect_rooms', roomAId: 'main', roomBId: 'south-neighbor' },
    ],
  ).scene;
  const disconnected = executeCommands(connected, [
    { type: 'disconnect_rooms', roomAId: 'main', roomBId: 'north-neighbor' },
  ]);
  assert.deepEqual(errors(disconnected.scene), []);
  assert.equal(disconnected.scene.rooms[0].east, 'door');
  assert.deepEqual(circulationEdges(disconnected.scene), [['main', 'south-neighbor']]);
});
