import assert from 'node:assert/strict';
import test from 'node:test';
import { emptyScene, makeRoom, type Room, type Scene, type Side } from '../shared/model';
import { circulationEdges, executeCommands, validateDesign } from '../shared/design';
import { oppositeSide, horizontalSide } from '../shared/geometry';
import { roomOpenings, wallOpeningHeightLimit } from '../shared/openings';
import { wallPanels } from '../src/renderGeometry';

function connected(side: Side = 'east', elevation = 0, floorDelta = 0): Scene {
  const hall = makeRoom({
    id: 'hall',
    x: 11,
    z: -7,
    width: 8,
    depth: 10,
    height: 7,
    elevation,
    kind: 'living',
    north: 'solid',
    south: 'solid',
    east: 'solid',
    west: 'solid',
    furniture: [],
  });
  const wing = makeRoom({
    ...hall,
    id: 'wing',
    kind: 'hall',
    height: 3.4,
    elevation: elevation + floorDelta,
    x: hall.x + (side === 'east' ? 8 : side === 'west' ? -8 : 0),
    z: hall.z + (side === 'south' ? 10 : side === 'north' ? -10 : 0),
  });
  const scene: Scene = {
    ...structuredClone(emptyScene),
    roof: 'flat',
    fireplace: null,
    rooms: [hall, wing],
  };
  const result = executeCommands(scene, [
    {
      type: 'connect_rooms',
      roomAId: 'hall',
      roomBId: 'wing',
      kind: 'open',
      connectionId: 'shared-passage',
      width: 2.4,
      center: (horizontalSide(side) ? hall.x : hall.z) + 0.7,
    },
  ]);
  assert.equal(result.applied, true);
  assert.deepEqual(
    result.issues.filter((issue) => issue.severity === 'error'),
    [],
  );
  return result.scene;
}

function face(scene: Scene, room: Room, side: Side) {
  return roomOpenings(scene, room.id, side).find((opening) => opening.id === 'shared-passage')!;
}

test('shared open passages close the tall hall wall above a short wing on every orientation', () => {
  for (const side of ['north', 'south', 'east', 'west'] as const) {
    const scene = connected(side, 4.2);
    const before = structuredClone(scene);
    const [hall, wing] = scene.rooms;
    const a = face(scene, hall, side),
      b = face(scene, wing, oppositeSide(side));
    assert.equal(a.height, 3.4);
    assert.equal(b.height, 3.4);
    assert.equal(a.sill, 0);
    assert.equal(b.sill, 0);
    assert.equal(a.id, b.id);
    // Test actual renderer wall cells, including shared-surface deduplication.
    for (const deduplicate of [false, true]) {
      const panels = wallPanels(scene, hall, side, deduplicate);
      const covers = (y: number) =>
        panels.some(
          (panel) =>
            Math.abs(panel.offset - a.offset) < panel.width / 2 &&
            y > panel.bottom &&
            y < panel.bottom + panel.height,
        );
      assert.equal(covers(2), false, 'the indoor passage remains open');
      assert.equal(covers(5), true, 'the exterior wall above the short wing remains solid');
    }
    assert.ok(
      circulationEdges(scene).some(([x, y]) => [x, y].includes('hall') && [x, y].includes('wing')),
    );
    assert.deepEqual(
      validateDesign(scene).filter((issue) => issue.severity === 'error'),
      [],
    );
    assert.deepEqual(
      scene,
      before,
      'resolution must not rewrite saved connections or room geometry',
    );
  }
});

test('shared passage faces use identical world-space bounds at tolerated floor offsets and under roof slopes', () => {
  for (const side of ['north', 'south', 'east', 'west'] as const)
    for (const style of ['pitched', 'single-pitch'] as const)
      for (const direction of ['north', 'south', 'east', 'west'] as const)
        for (const floorDelta of [-0.02, 0.02]) {
          const scene = connected(side, 4.2, floorDelta);
          const [hall, wing] = scene.rooms;
          hall.roof = { style, direction, pitch: 30 };
          wing.roof = { style, direction, pitch: 22 };
          const a = face(scene, hall, side),
            b = face(scene, wing, oppositeSide(side));
          assert.equal(a.height, b.height);
          assert.ok(Math.abs(hall.elevation + a.sill - wing.elevation - b.sill) < 1e-8);
          for (const [room, wallSide, opening] of [
            [hall, side, a],
            [wing, oppositeSide(side), b],
          ] as const) {
            assert.ok(opening.sill + opening.height <= room.height + 1e-8);
            assert.ok(
              opening.sill + opening.height <=
                wallOpeningHeightLimit(scene, room, wallSide, opening.offset, opening.width) + 1e-8,
            );
          }
          assert.deepEqual(
            validateDesign(scene).filter((issue) => issue.severity === 'error'),
            [],
          );
        }
});

test('open passage follows changed live ceilings without mutating its saved metadata', () => {
  const scene = connected();
  const saved = structuredClone(scene.design!.connections);
  scene.rooms[1].height = 4.1;
  assert.equal(face(scene, scene.rooms[0], 'east').height, 4.1);
  assert.equal(face(scene, scene.rooms[1], 'west').height, 4.1);
  assert.deepEqual(scene.design!.connections, saved);
});

test('standalone openings, open walls, doors and outdoor connections retain their existing dimensions', () => {
  const scene = connected();
  scene.design!.connections[0].kind = 'door';
  scene.design!.connections[0].height = 2.4;
  assert.equal(face(scene, scene.rooms[0], 'east').height, 2.4);
  scene.design!.connections[0].kind = 'open';
  scene.rooms[1].kind = 'terrace';
  assert.equal(face(scene, scene.rooms[0], 'east').height, 7);
  scene.design!.connections = [];
  scene.rooms[0].east = 'open';
  assert.deepEqual(roomOpenings(scene, 'hall', 'east'), []);
  assert.deepEqual(wallPanels(scene, scene.rooms[0], 'east'), []);
  scene.rooms[0].wallOpenings = [
    { id: 'overlook', side: 'east', kind: 'open', offset: 0, width: 2, height: 2.5, sill: 3.5 },
  ];
  assert.equal(roomOpenings(scene, 'hall', 'east')[0].height, 2.5);
  assert.equal(roomOpenings(scene, 'hall', 'east')[0].sill, 3.5);
});
