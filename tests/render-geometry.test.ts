import assert from 'node:assert/strict';
import test from 'node:test';
import { emptyScene, makeRoom, type Scene } from '../shared/model';
import {
  roomFootprint,
  roomSlabs,
  stairFootprint,
  subtractRectangles,
  wallAxis,
  wallPanels,
  type Rect,
} from '../src/renderGeometry';

const area = (rect: Rect) => (rect.maxX - rect.minX) * (rect.maxZ - rect.minZ);
const contains = (rect: Rect, x: number, z: number) =>
  x > rect.minX && x < rect.maxX && z > rect.minZ && z < rect.maxZ;
function connectedScene(): Scene {
  return {
    ...emptyScene,
    rooms: [
      makeRoom({ id: 'a', x: 0, z: 0, width: 8, depth: 10, height: 3, east: 'door' }),
      makeRoom({ id: 'b', x: 6, z: 2, width: 4, depth: 6, height: 3, west: 'door' }),
    ],
    design: {
      groups: [],
      requirements: [],
      stairLinks: [],
      connections: [
        {
          id: 'door',
          roomAId: 'a',
          roomBId: 'b',
          sideA: 'east',
          center: 3,
          width: 1.2,
          height: 2.4,
          kind: 'door',
        },
      ],
    },
  };
}

test('off-center connections leave the same world-space opening in both walls', () => {
  const scene = connectedScene();
  for (const [room, side] of [
    [scene.rooms[0], 'east'],
    [scene.rooms[1], 'west'],
  ] as const) {
    const axis = wallAxis(room, side);
    const panels = wallPanels(scene, room, side, false);
    const covers = (worldCoordinate: number, height: number) =>
      panels.some(
        (panel) =>
          Math.abs(worldCoordinate - axis.center - panel.offset) < panel.width / 2 - 0.001 &&
          height > panel.bottom &&
          height < panel.bottom + panel.height,
      );
    assert.equal(covers(3, 1), false, 'the actual doorway is open');
    assert.equal(covers(2.2, 1), true, 'the wall beside the opening is solid');
    assert.equal(covers(3, 2.7), true, 'the lintel remains above the door');
    assert.equal(axis.boundary, 4);
  }
  assert.deepEqual(
    wallPanels(scene, scene.rooms[1], 'west'),
    [],
    'neighbor owns the identical shared surface',
  );
});

test('partial full-height open connections retain walls beside the opening', () => {
  const scene = connectedScene();
  scene.design!.connections[0].kind = 'open';
  scene.rooms[0].east = 'open';
  scene.rooms[1].west = 'open';
  const panels = wallPanels(scene, scene.rooms[0], 'east', false);
  assert.ok(panels.length > 0);
  assert.ok(panels.every((panel) => panel.bottom === 0 && panel.height === 3));
  assert.ok(Math.abs(panels.reduce((total, panel) => total + panel.width, 0) - 8.8) < 1e-8);
});

test('legacy centered doors survive without inventing missing connections', () => {
  const room = makeRoom({ id: 'legacy', width: 6, height: 3, north: 'door', south: 'open' });
  const scene = { ...emptyScene, rooms: [room] };
  const panels = wallPanels(scene, room, 'north');
  assert.equal(panels.length, 3);
  assert.equal(
    panels.some((panel) => panel.offset === 0 && panel.bottom === 2.4),
    true,
  );
  assert.deepEqual(wallPanels(scene, room, 'south'), []);
});

test('shared wall deduplication preserves a wall that closes a mismatched legacy door', () => {
  const scene = connectedScene();
  scene.design = undefined;
  scene.rooms[0].east = 'door';
  scene.rooms[1].west = 'solid';
  const peer = scene.rooms[1];
  const panels = wallPanels(scene, peer, 'west');
  assert.ok(
    panels.some((panel) => Math.abs(peer.z + panel.offset) < panel.width / 2 && panel.bottom === 0),
    'solid neighbor still closes legacy doorway at world z=0',
  );
});

test('rectangle subdivision handles overlapping cutouts without duplicate surfaces', () => {
  const base = { minX: 0, minZ: 0, maxX: 10, maxZ: 10 };
  const result = subtractRectangles(base, [
    { minX: 2, minZ: 2, maxX: 6, maxZ: 6 },
    { minX: 4, minZ: 4, maxX: 8, maxZ: 8 },
  ]);
  assert.equal(
    result.reduce((total, rect) => total + area(rect), 0),
    72,
  );
  for (let i = 0; i < result.length; i++)
    for (let j = i + 1; j < result.length; j++) {
      const a = result[i],
        b = result[j];
      assert.ok(
        Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX) <= 0 ||
          Math.min(a.maxZ, b.maxZ) - Math.max(a.minZ, b.minZ) <= 0,
      );
    }
});

test('upper floors replace internal roofs and foundations, with linked stair cutouts', () => {
  const lower = makeRoom({ id: 'lower', height: 3.2 });
  const upper = makeRoom({ id: 'upper', elevation: 3.2 });
  const stair = { id: 'stair', x: 0, z: 1, elevation: 0, rise: 3.2, width: 1, run: 3, rotation: 0 };
  const scene: Scene = {
    ...emptyScene,
    rooms: [lower, upper],
    stairs: [stair],
    design: {
      groups: [],
      connections: [],
      requirements: [],
      stairLinks: [{ stairId: 'stair', lowerRoomId: 'lower', upperRoomId: 'upper' }],
    },
  };
  const lowerSlabs = roomSlabs(scene, lower);
  const upperSlabs = roomSlabs(scene, upper);
  assert.equal(
    lowerSlabs.roof.some((rect) => contains(rect, 0, 0)),
    false,
  );
  assert.equal(lowerSlabs.roofClipped, true);
  assert.deepEqual(upperSlabs.foundation, []);
  assert.equal(
    upperSlabs.floor.some((rect) => contains(rect, stair.x, stair.z)),
    false,
  );
  assert.ok(
    upperSlabs.floor.some((rect) => contains(rect, -2, 0)),
    'floor away from stair stays intact',
  );
  assert.ok(
    upperSlabs.floor.reduce((total, rect) => total + area(rect), 0) <
      area(roomFootprint(upper, 0.08)),
  );
});

test('rotated stairs produce a correctly oriented opening footprint', () => {
  const footprint = stairFootprint(
    { id: 's', x: 2, z: 3, elevation: 0, rise: 3.2, width: 1, run: 4, rotation: 90 },
    0,
  );
  assert.ok(Math.abs(footprint.maxX - footprint.minX - 4) < 1e-8);
  assert.ok(Math.abs(footprint.maxZ - footprint.minZ - 1) < 1e-8);
  assert.equal((footprint.minX + footprint.maxX) / 2, 2);
  assert.equal((footprint.minZ + footprint.maxZ) / 2, 3);
});
