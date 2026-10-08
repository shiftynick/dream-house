import assert from 'node:assert/strict';
import test from 'node:test';
import { emptyScene, makeRoom, type Room, type Scene, type WallOpening } from '../shared/model';
import { circulationEdges, executeCommands, validateDesign } from '../shared/design';
import { inspectDesignQuality } from '../shared/design-quality';
import { mirroredOpening, roomOpenings, validateOpenings } from '../shared/openings';
import { wallPanels, wallTopProfile } from '../src/renderGeometry';

const room = (patch: Partial<Room>) =>
  makeRoom({
    width: 8,
    depth: 6,
    height: 3,
    elevation: 0,
    x: 0,
    z: 0,
    north: 'solid',
    south: 'solid',
    east: 'solid',
    west: 'solid',
    furniture: [],
    ...patch,
  });
const window = (patch: Partial<WallOpening> = {}): WallOpening => ({
  id: 'window',
  side: 'north',
  kind: 'window',
  offset: 0,
  width: 4,
  height: 2.4,
  sill: 0.6,
  ...patch,
});
const house = (...rooms: Room[]): Scene => ({
  ...structuredClone(emptyScene),
  roof: 'flat',
  rooms,
});
const northEvidence = (scene: Scene) =>
  inspectDesignQuality(scene).rooms[0].walls.find((wall) => wall.side === 'north')!;

test('same-level outdoor decks never impose their nominal wall height or dormant wall flags on windows', () => {
  for (const kind of ['terrace', 'courtyard'] as const)
    for (const flag of ['open', 'solid', 'glass', 'door'] as const) {
      const aperture = window();
      const hall = room({ id: 'hall', height: 6, wallOpenings: [aperture] });
      const deck = room({ id: 'deck', kind, z: -6, height: 2.2, south: flag });
      const source = house(hall, deck);
      assert.deepEqual(validateOpenings(source), []);
      assert.equal(mirroredOpening(source, hall, aperture, deck), null);
      assert.deepEqual(roomOpenings(source, deck.id, 'south'), []);
      assert.deepEqual(wallPanels(source, deck, 'south', false), []);
      assert.deepEqual(wallTopProfile(source, deck, 'south'), []);
      assert.equal(northEvidence(source).windows[0].exposedArea, 9.6);
      assert.equal(northEvidence(source).exteriorWallArea, 48);
      // A shorter aperture must not suddenly invent a mirrored outdoor wall.
      aperture.height = 1;
      assert.deepEqual(roomOpenings(source, deck.id, 'south'), []);
      assert.deepEqual(wallPanels(source, deck, 'south', false), []);
    }
});

test('raised outdoor floor slabs block intersecting apertures, leaving exposure above the slab intact', () => {
  const hall = room({ id: 'hall', wallOpenings: [window({ height: 1, sill: 1 })] });
  const deck = room({ id: 'deck', kind: 'terrace', z: -6, elevation: 1.5, height: 8 });
  const source = house(hall, deck);
  const issues = validateOpenings(source);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].code, 'opening_shared_wall_conflict');
  assert.match(issues[0].message, /floor slab/);
  assert.equal(issues[0].details?.verticalOverlap, 0.22);
  assert.equal(northEvidence(source).windows[0].exposedArea, 3.12);
  assert.equal(northEvidence(source).exteriorWallArea, 22.24);
  hall.wallOpenings![0].sill = 1.5;
  assert.deepEqual(validateOpenings(source), []);
  assert.equal(northEvidence(source).windows[0].exposedArea, 4);
});

test('indoor neighbors still block oversized shared apertures and exclude shared glazing from exterior evidence', () => {
  for (const south of ['solid', 'open'] as const) {
    const hall = room({ id: 'hall', height: 6, wallOpenings: [window()] });
    const neighbor = room({ id: 'neighbor', z: -6, height: 2.2, south });
    const source = house(hall, neighbor);
    assert.ok(
      validateOpenings(source).some((issue) => issue.code === 'opening_shared_wall_conflict'),
    );
    hall.wallOpenings![0].height = 1;
    assert.deepEqual(validateOpenings(source), []);
    assert.equal(roomOpenings(source, neighbor.id, 'south').length, 1);
    assert.equal(northEvidence(source).windows[0].exposedArea, 0);
  }
});

test('schematic lodge retains terrace glazing while real east passage overlaps require correction', () => {
  const source = house(
    room({ id: 'hall', name: 'Great Hall', width: 12, depth: 12, height: 6 }),
    room({
      id: 'terrace',
      name: 'Terrace',
      kind: 'terrace',
      z: -9,
      width: 12,
      height: 2.2,
      north: 'open',
      south: 'open',
      east: 'open',
      west: 'open',
    }),
    room({ id: 'dining', name: 'Dining', x: 9, z: -3, width: 6 }),
    room({ id: 'kitchen', name: 'Kitchen', x: 9, z: 3, width: 6 }),
  );
  const connected = executeCommands(source, [
    {
      type: 'connect_rooms',
      roomAId: 'hall',
      roomBId: 'terrace',
      kind: 'door',
      width: 1.4,
      height: 2,
    },
    { type: 'connect_rooms', roomAId: 'hall', roomBId: 'dining', kind: 'door', width: 2.4 },
    { type: 'connect_rooms', roomAId: 'hall', roomBId: 'kitchen', kind: 'door', width: 2.4 },
  ]);
  assert.equal(connected.applied, true);
  assert.deepEqual(
    connected.issues.filter((issue) => issue.severity === 'error'),
    [],
  );
  const glazed = executeCommands(connected.scene, [
    {
      type: 'set_wall_openings',
      roomId: 'hall',
      side: 'north',
      openings: [
        { id: 'gh-n-w1', kind: 'window', offset: -3.3, width: 4, height: 2.4, sill: 0.6 },
        { id: 'gh-n-w2', kind: 'window', offset: 3.3, width: 4, height: 2.4, sill: 0.6 },
      ],
    },
    {
      type: 'set_wall_openings',
      roomId: 'hall',
      side: 'east',
      openings: [
        { id: 'gh-e-w1', kind: 'window', offset: -3, width: 3, height: 2.4, sill: 0.6 },
        { id: 'gh-e-w2', kind: 'window', offset: 3, width: 3, height: 2.4, sill: 0.6 },
      ],
    },
  ]);
  const errors = glazed.issues.filter((issue) => issue.severity === 'error');
  assert.ok(errors.length > 0);
  assert.ok(errors.every((issue) => issue.code === 'opening_overlap'));
  assert.ok(errors.some((issue) => issue.objectIds.includes('gh-e-w1')));
  assert.ok(
    errors.every(
      (issue) => !issue.objectIds.includes('gh-n-w1') && !issue.objectIds.includes('gh-n-w2'),
    ),
  );
  const repaired = executeCommands(glazed.scene, [
    { type: 'set_wall_openings', roomId: 'hall', side: 'east', openings: [] },
  ]);
  assert.deepEqual(
    validateDesign(repaired.scene).filter((issue) => issue.severity === 'error'),
    [],
  );
  assert.equal(northEvidence(repaired.scene).windows.length, 2);
  assert.equal(
    northEvidence(repaired.scene).windows.reduce((sum, item) => sum + item.exposedArea, 0),
    19.2,
  );
  assert.ok(circulationEdges(repaired.scene).some(([a, b]) => a === 'hall' && b === 'dining'));
  assert.ok(circulationEdges(repaired.scene).some(([a, b]) => a === 'hall' && b === 'kitchen'));
});
