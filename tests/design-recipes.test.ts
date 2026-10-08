import assert from 'node:assert/strict';
import test from 'node:test';
import {
  composeHouseRecipe,
  composeHouseSchema,
  grandLodgeDescriptor,
} from '../shared/design-recipes';
import { emptyScene, makeRoom, sceneSchema } from '../shared/model';
import { executeCommands, inspectDesign, validateDesign } from '../shared/design';
import { roofHeightAt, roofMaximumHeight } from '../shared/architecture';
import { inspectDesignQuality } from '../shared/design-quality';
import { roomOpenings } from '../shared/openings';
import { designPlanSchema, evaluatePlan, planAssessment } from '../server/design-planning';

const input = { recipe: 'grand-lodge' };
const request = 'Build a grand lodge demonstrating your architectural capabilities.';
const recipe = () => composeHouseRecipe(input, request);

test('lodge recipe is deterministic, version compatible and replays atomically on the actual site', () => {
  const base = {
    ...structuredClone(emptyScene),
    slope: 0.22,
    roofPitch: 19,
    roofDirection: 'west' as const,
  };
  const untouched = structuredClone(base);
  const built = composeHouseRecipe(input, request, base);
  assert.deepEqual(base, untouched);
  assert.deepEqual(built, composeHouseRecipe(input, request, base));
  assert.deepEqual(sceneSchema.parse(built.scene), built.scene);
  assert.equal(built.scene.slope, base.slope);
  assert.equal(built.scene.roofPitch, base.roofPitch);
  assert.equal(built.scene.roofDirection, base.roofDirection);
  const replay = executeCommands(base, built.operations);
  assert.equal(replay.applied, true);
  assert.deepEqual(replay.scene, built.scene);
  assert.deepEqual(
    built.scene.rooms.map((room) => room.id),
    grandLodgeDescriptor.roomIds,
  );
});

test('recipe refuses unsupported options and existing architecture without mutation', () => {
  assert.equal(composeHouseSchema.safeParse({ ...input, bedrooms: 12 }).success, false);
  const occupied = { ...structuredClone(emptyScene), rooms: [makeRoom({ id: 'existing' })] };
  const before = structuredClone(occupied);
  assert.throws(() => composeHouseRecipe(input, request, occupied), /empty draft/);
  assert.deepEqual(occupied, before);
  assert.throws(() => composeHouseRecipe({ recipe: 'unknown' }, request));
});

test('recipe has valid unobstructed geometry and satisfies its factual plan commitments', () => {
  const { scene, plan } = recipe();
  const issues = validateDesign(scene);
  assert.deepEqual(
    issues.filter((issue) => issue.severity === 'error'),
    [],
  );
  assert.deepEqual(
    issues.filter((issue) => /door|stair|overlap|outside/.test(issue.code)),
    [],
  );
  const parsed = designPlanSchema.parse(plan);
  assert.ok(parsed.intent.includes(request));
  const assessed = evaluatePlan(scene, planAssessment(parsed), emptyScene);
  assert.deepEqual(
    assessed.requirements.flatMap((item) => item.results).filter((result) => !result.passed),
    [],
  );
  assert.deepEqual(inspectDesign(scene).components.length, 1);
});

test('shared guest bath and upper gallery remain accessible without passing through a bedroom', () => {
  const { scene } = recipe();
  const allowed = new Set(
    scene.rooms
      .filter((room) => room.kind !== 'bedroom' && room.kind !== 'terrace')
      .map((room) => room.id),
  );
  const reached = new Set(['entry']);
  const edges = inspectDesign(scene).connections;
  for (let i = 0; i < allowed.size; i++)
    for (const edge of edges) {
      if (!allowed.has(edge.roomAId) || !allowed.has(edge.roomBId)) continue;
      if (reached.has(edge.roomAId)) reached.add(edge.roomBId);
      if (reached.has(edge.roomBId)) reached.add(edge.roomAId);
    }
  for (const id of [
    'great-hall',
    'wing-gallery',
    'guest-bath',
    'kitchen',
    'dining',
    'upper-gallery',
  ])
    assert.ok(reached.has(id), id);
  assert.ok(!reached.has('primary-bath'));
  assert.deepEqual(scene.design?.stairLinks, [
    { stairId: 'gallery-stair', lowerRoomId: 'entry', upperRoomId: 'upper-gallery' },
  ]);
});

test('wings form continuous subordinate roof profiles across room subdivisions', () => {
  const { scene } = recipe();
  const room = (id: string) => scene.rooms.find((room) => room.id === id)!;
  const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);
  for (const x of [-15, -13, -11, -9, -7])
    near(roofHeightAt(scene, room('kitchen'), x, 0), roofHeightAt(scene, room('dining'), x, 0));
  for (const x of [7, 10, 14, 17, 20, 23]) {
    const north = room(x <= 17 ? 'primary-suite' : 'primary-bath');
    const south = room(x <= 17 ? 'guest-bedroom' : 'guest-bath');
    near(roofHeightAt(scene, north, x, -1.5), roofHeightAt(scene, room('wing-gallery'), x, -1.5));
    near(roofHeightAt(scene, south, x, 1.5), roofHeightAt(scene, room('wing-gallery'), x, 1.5));
  }
  for (const id of [
    'kitchen',
    'dining',
    'wing-gallery',
    'primary-suite',
    'primary-bath',
    'guest-bedroom',
    'guest-bath',
    'upper-gallery',
  ])
    assert.ok(roofMaximumHeight(scene, room(id)) < room('great-hall').height, id);
});

test('every indoor room has actual exposed glazing and arrival retains an exterior door', () => {
  const { scene } = recipe();
  const quality = inspectDesignQuality(scene);
  for (const room of quality.rooms.filter((room) => room.enclosed)) {
    assert.ok(room.exteriorWindowCount >= 1, room.id);
    assert.ok(room.exteriorWindowArea >= 1.2, room.id);
    assert.equal(room.roofPalette, 'charcoal');
  }
  const openings = roomOpenings(scene, 'entry', 'south');
  assert.ok(
    openings.some(
      (opening) => opening.kind === 'door' && opening.width === 1.8 && opening.height === 2.5,
    ),
  );
  assert.ok(openings.some((opening) => opening.kind === 'window'));
  assert.ok(
    !inspectDesign(scene).sharedWalls.some(
      (wall) =>
        (wall.roomAId === 'entry' && wall.sideA === 'south') ||
        (wall.roomBId === 'entry' && wall.sideB === 'south'),
    ),
  );
});
