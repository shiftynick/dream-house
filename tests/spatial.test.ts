import test from 'node:test';
import assert from 'node:assert/strict';
import { documentSchema, emptyScene, makeRoom, newProject, type Scene } from '../shared/model.ts';
import { effectiveSurfacePalettes, executeCommands, validateDesign } from '../shared/design.ts';
import { bounds } from '../shared/geometry.ts';
import { furnitureFootprints, inspectSpatial } from '../shared/spatial.ts';

const sceneWith = (rooms: Scene['rooms']): Scene => ({
  ...structuredClone(emptyScene),
  rooms,
  slope: 0,
});

test('surface material operations preserve geometry and unrelated surfaces and respect material locks', () => {
  const original = sceneWith([
    makeRoom({
      id: 'room',
      palette: 'cedar',
      surfacePalettes: { north: 'chalk', floor: 'charcoal' },
    }),
  ]);
  const changed = executeCommands(original, [
    { type: 'set_surface_material', roomId: 'room', surface: 'east', palette: 'limestone' },
  ]);
  assert.equal(changed.applied, true);
  assert.deepEqual(changed.scene.rooms[0].surfacePalettes, {
    north: 'chalk',
    floor: 'charcoal',
    east: 'limestone',
  });
  assert.deepEqual(effectiveSurfacePalettes(changed.scene, changed.scene.rooms[0]), {
    north: 'chalk',
    south: 'cedar',
    east: 'limestone',
    west: 'cedar',
    floor: 'charcoal',
    roof: 'cedar',
  });
  const { surfacePalettes: _new, ...geometry } = changed.scene.rooms[0];
  const { surfacePalettes: _old, ...beforeGeometry } = original.rooms[0];
  assert.deepEqual(geometry, beforeGeometry);
  const locked = executeCommands(changed.scene, [
    {
      type: 'set_requirement',
      requirement: {
        id: 'materials',
        kind: 'locked',
        roomId: 'room',
        properties: ['material'],
        source: 'confirmed',
        description: 'Preserve these finishes.',
      },
    },
  ]).scene;
  const conflict = executeCommands(locked, [
    { type: 'set_surface_material', roomId: 'room', surface: 'east', palette: 'charcoal' },
  ]);
  assert.ok(
    conflict.issues.some(
      (issue) => issue.code === 'locked_property_changed' && issue.severity === 'error',
    ),
  );
  const matching = executeCommands(locked, [
    { type: 'set_surface_material', roomId: 'room', surface: 'east', palette: 'limestone' },
  ]);
  assert.equal(
    matching.issues.some((issue) => issue.code === 'locked_property_changed'),
    false,
  );
  const wholeRoom = executeCommands(changed.scene, [
    { type: 'set_material', roomIds: ['room'], palette: 'chalk' },
  ]);
  assert.equal(
    wholeRoom.scene.rooms[0].surfacePalettes,
    undefined,
    'whole-room material commands cover previous surface overrides',
  );
  assert.ok(
    Object.values(effectiveSurfacePalettes(wholeRoom.scene, wholeRoom.scene.rooms[0])).every(
      (palette) => palette === 'chalk',
    ),
  );
});

test('legacy scalar material locks also protect newly introduced surface overrides', () => {
  const original = sceneWith([makeRoom({ id: 'room' })]);
  original.design = {
    groups: [],
    connections: [],
    stairLinks: [],
    requirements: [
      {
        id: 'legacy-lock',
        kind: 'locked',
        source: 'confirmed',
        description: 'Preserve material.',
        roomId: 'room',
        properties: ['material'],
        snapshot: {
          x: 0,
          z: 0,
          elevation: 0,
          width: 6,
          depth: 5,
          height: 3.2,
          palette: 'limestone',
        },
      },
    ],
  };
  const changed = executeCommands(original, [
    { type: 'set_surface_material', roomId: 'room', surface: 'roof', palette: 'cedar' },
  ]);
  assert.ok(changed.issues.some((issue) => issue.code === 'locked_property_changed'));
});

test('move_wall fixes the opposite edge, uses outward-positive distances, and reflows neighbors', () => {
  for (const side of ['north', 'south', 'east', 'west'] as const) {
    const original = sceneWith([makeRoom({ id: 'room', width: 6, depth: 6 })]);
    const result = executeCommands(original, [
      { type: 'move_wall', roomId: 'room', side, delta: 2 },
    ]);
    const old = bounds(original.rooms[0]),
      next = bounds(result.scene.rooms[0]);
    const opposite = { north: 'south', south: 'north', east: 'west', west: 'east' } as const;
    assert.equal(next[opposite[side]], old[opposite[side]]);
    assert.equal(next[side] - old[side], ['north', 'west'].includes(side) ? -2 : 2);
  }
  const original = sceneWith([
    makeRoom({ id: 'a', width: 6, depth: 6, east: 'open' }),
    makeRoom({ id: 'b', x: 6, width: 6, depth: 6, west: 'open' }),
  ]);
  const result = executeCommands(original, [
    { type: 'move_wall', roomId: 'a', side: 'east', delta: 2 },
  ]);
  assert.equal(result.scene.rooms[1].x, 8);
  assert.equal(bounds(result.scene.rooms[0]).east, bounds(result.scene.rooms[1]).west);
  const invalid = executeCommands(original, [
    { type: 'set_material', palette: 'cedar' },
    { type: 'move_wall', roomId: 'a', side: 'west', delta: -5 },
  ]);
  assert.equal(invalid.applied, false);
  assert.deepEqual(
    invalid.scene,
    original,
    'an impossible wall movement rolls back its complete command batch',
  );
});

test('project and visual-alternative metadata stay backward compatible and reject unsafe or unbounded thumbnails', () => {
  const original = newProject();
  assert.equal(documentSchema.parse(original).projectId, undefined);
  const enriched = {
    ...original,
    projectId: 'original',
    projectName: 'Hillside home',
    variants: [
      {
        id: 'v1',
        name: 'Courtyard option',
        createdAt: '2026-09-28',
        scene: original.scene,
        thumbnail: 'data:image/png;base64,YWJj',
        description: 'A brighter courtyard.',
        source: 'generated',
        intent: 'Explore courtyard proportions.',
      },
    ],
  };
  assert.deepEqual(documentSchema.parse(enriched), enriched);
  assert.throws(() => documentSchema.parse({ ...enriched, projectId: '../../other' }));
  assert.throws(() =>
    documentSchema.parse({
      ...enriched,
      variants: [{ ...enriched.variants[0], thumbnail: 'https://example.com/image.png' }],
    }),
  );
  assert.throws(() =>
    documentSchema.parse({
      ...enriched,
      variants: [
        { ...enriched.variants[0], thumbnail: `data:image/png;base64,${'a'.repeat(500_001)}` },
      ],
    }),
  );
});

test('door checks measure actual off-center openings and distinguish blocked approaches from clear ones', () => {
  const room = makeRoom({
    id: 'bedroom',
    name: 'Bedroom',
    kind: 'bedroom',
    width: 8,
    depth: 3,
    north: 'door',
    east: 'solid',
  });
  const blocked = inspectSpatial(sceneWith([room]));
  assert.ok(blocked.issues.some((issue) => issue.code === 'door_approach_blocked'));
  assert.ok(blocked.issues.some((issue) => issue.code === 'door_swing_obstructed'));
  const scene = sceneWith([
    room,
    makeRoom({
      id: 'hall',
      name: 'Hall',
      kind: 'hall',
      x: 3,
      z: -3,
      width: 2,
      depth: 3,
      east: 'solid',
    }),
  ]);
  const connected = executeCommands(scene, [
    { type: 'connect_rooms', roomAId: 'bedroom', roomBId: 'hall', center: 3 },
  ]).scene;
  const clear = inspectSpatial(connected);
  assert.equal(
    clear.issues.some(
      (issue) =>
        ['door_approach_blocked', 'door_swing_obstructed'].includes(issue.code) &&
        issue.objectIds.includes('bedroom'),
    ),
    false,
  );
  assert.ok(
    blocked.issues.every(
      (issue) => issue.severity === 'warning' && issue.details?.advisory === true,
    ),
  );
});

test('schematic furniture checks report measured collisions and kitchen aisle gaps without blocking edits', () => {
  const tight = sceneWith([makeRoom({ id: 'small-kitchen', kind: 'kitchen', width: 3, depth: 4 })]);
  const warning = inspectSpatial(tight).issues.find(
    (issue) => issue.code === 'furniture_aisle_clearance',
  );
  assert.ok(warning);
  assert.equal(warning.details?.measuredGap, 0.175);
  assert.equal(warning.details?.assumedTarget, 0.9);
  assert.equal(warning.severity, 'warning');
  const roomy = sceneWith([
    makeRoom({ id: 'large-kitchen', kind: 'kitchen', width: 8, depth: 8, east: 'solid' }),
  ]);
  assert.equal(
    inspectSpatial(roomy).issues.some((issue) => issue.code.startsWith('furniture_')),
    false,
  );
  const tinyBed = sceneWith([makeRoom({ id: 'tiny-bed', kind: 'bedroom', width: 1.5, depth: 2 })]);
  assert.ok(
    inspectSpatial(tinyBed).issues.some((issue) => issue.code === 'furniture_outside_room'),
  );
  assert.equal(
    validateDesign(tight).some((issue) => issue.severity === 'error'),
    false,
  );
  const bed = furnitureFootprints(makeRoom({ id: 'b', kind: 'bedroom', x: 10, z: 5, depth: 6 }))[0];
  assert.equal(bed.width, 2.25);
  assert.equal(bed.depth, 2.325);
  assert.equal(bed.x, 10);
  assert.equal(bed.z, 4.3875);
});

test('stair headroom distinguishes an obstructing ceiling from a double-height room and linked slab cutouts', () => {
  const stair = {
    id: 'stairs',
    x: 0,
    z: 0,
    elevation: 0,
    width: 1.2,
    run: 4,
    rise: 3.2,
    rotation: 0,
  };
  const low = sceneWith([makeRoom({ id: 'low', width: 8, depth: 8, height: 3.4 })]);
  low.stairs = [stair];
  assert.ok(inspectSpatial(low).issues.some((issue) => issue.code === 'stair_headroom_clearance'));
  const tall = sceneWith([makeRoom({ id: 'tall', width: 8, depth: 8, height: 7 })]);
  tall.stairs = [stair];
  assert.equal(
    inspectSpatial(tall).issues.some((issue) => issue.code === 'stair_headroom_clearance'),
    false,
  );
  const stacked = sceneWith([
    makeRoom({ id: 'lower', width: 8, depth: 8, height: 3.2, east: 'solid' }),
    makeRoom({ id: 'upper', width: 8, depth: 8, elevation: 3.2, height: 3.2, east: 'solid' }),
  ]);
  stacked.stairs = [stair];
  stacked.design = {
    groups: [],
    connections: [],
    requirements: [],
    stairLinks: [{ stairId: 'stairs', lowerRoomId: 'lower', upperRoomId: 'upper' }],
  };
  assert.equal(
    inspectSpatial(stacked).issues.some((issue) => issue.code === 'stair_headroom_clearance'),
    false,
    'the known stair cutout must not be reported as an overhead slab',
  );
  assert.equal(
    inspectSpatial(stacked).issues.some((issue) => issue.code === 'stair_landing_clearance'),
    false,
  );
});

test('stair landing checks identify a flight that reaches the floor but leaves insufficient approach space', () => {
  const scene = sceneWith([
    makeRoom({ id: 'lower', width: 8, depth: 8, height: 3.2 }),
    makeRoom({ id: 'upper', width: 8, depth: 8, elevation: 3.2, height: 3.2 }),
  ]);
  scene.stairs = [
    { id: 'stairs', x: 0, z: 1.9, elevation: 0, width: 1.2, run: 4, rise: 3.2, rotation: 0 },
  ];
  scene.design = {
    groups: [],
    connections: [],
    requirements: [],
    stairLinks: [{ stairId: 'stairs', lowerRoomId: 'lower', upperRoomId: 'upper' }],
  };
  const issue = inspectSpatial(scene).issues.find(
    (issue) => issue.code === 'stair_landing_clearance',
  );
  assert.ok(issue);
  assert.equal(issue.details?.outsideLinkedRoom, true);
  assert.equal(issue.details?.assumedDepth, 0.9);
  assert.equal(issue.severity, 'warning');
});
