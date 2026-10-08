import assert from 'node:assert/strict';
import test from 'node:test';
import { emptyScene, makeRoom, type Scene } from '../shared/model';
import { executeCommands } from '../shared/design';
import { roomOpenings } from '../shared/openings';
import { designPlanSchema, evaluatePlan, planAssessment } from '../server/design-planning';

// These are a designer's declared dimensions, not universal entrance standards.
const plan = designPlanSchema.parse({
  intent: 'A gathering room with a functional front arrival.',
  roomProgram: [
    { roomId: 'hall', name: 'Hall', kind: 'living', purpose: 'Gathering' },
    { roomId: 'foyer', name: 'Foyer', kind: 'hall', purpose: 'Arrival from the south' },
  ],
  materialStrategy: {
    description: 'Coordinated limestone walls.',
    checks: [{ kind: 'material_composition', allowedPalettes: ['limestone'] }],
  },
  fenestration: { description: 'Hall daylight.', roomIds: ['hall'] },
  features: [
    {
      id: 'arrival',
      request: 'A dimensioned front door on the inspected exposed south foyer wall.',
      checks: [
        {
          kind: 'wall_opening',
          roomId: 'foyer',
          side: 'south',
          openingKind: 'door',
          minCount: 1,
          minWidth: 1.6,
          minHeight: 2.6,
        },
      ],
    },
  ],
  reviewViews: ['exterior', 'plan'],
});
const objectives = planAssessment(plan);
const window = {
  id: 'foyer-window',
  kind: 'window',
  offset: 1.7,
  width: 1.4,
  height: 1.5,
  sill: 0.9,
};
const door = { id: 'front-door', kind: 'door', offset: -1.2, width: 1.6, height: 2.6, sill: 0 };

function shell(): Scene {
  const room = {
    elevation: 0,
    height: 3.3,
    north: 'solid',
    south: 'solid',
    east: 'solid',
    west: 'solid',
    furniture: [],
  } as const;
  const scene: Scene = {
    ...structuredClone(emptyScene),
    roof: 'flat',
    fireplace: null,
    rooms: [
      makeRoom({
        ...room,
        furniture: [],
        id: 'hall',
        kind: 'living',
        x: 0,
        z: -4,
        width: 8,
        depth: 8,
      }),
      makeRoom({
        ...room,
        furniture: [],
        id: 'foyer',
        kind: 'hall',
        x: 0,
        z: 1.5,
        width: 6,
        depth: 3,
      }),
    ],
  };
  const result = executeCommands(scene, [
    {
      type: 'connect_rooms',
      roomAId: 'hall',
      roomBId: 'foyer',
      kind: 'door',
      width: 1.6,
      height: 2.6,
    },
    { type: 'set_wall_openings', roomId: 'foyer', side: 'south', openings: [window] },
  ]);
  assert.equal(result.applied, true);
  assert.deepEqual(
    result.issues.filter((issue) => issue.severity === 'error'),
    [],
  );
  return result.scene;
}

function arrival(scene: Scene) {
  return evaluatePlan(scene, objectives, emptyScene).requirements.find(
    (item) => item.id === 'arrival',
  )!.results[0];
}

test('a connected glazed foyer does not satisfy its declared exterior arrival door', () => {
  const scene = shell();
  const evaluated = evaluatePlan(scene, objectives, emptyScene);
  const route = evaluated.requirements
    .flatMap((item) => item.checks.map((check, index) => ({ check, result: item.results[index] })))
    .find((item) => item.check.kind === 'indoor_route')!;
  assert.equal(route.result.passed, true);
  assert.equal(arrival(scene).passed, false);
  assert.equal(roomOpenings(scene, 'foyer', 'north')[0].kind, 'door');
});

test('arrival commitment checks chosen side and dimensions, and accepts a preserved window alongside the door', () => {
  const scene = shell();
  for (const patch of [{ width: 1.2 }, { height: 2.3 }]) {
    const result = executeCommands(scene, [
      {
        type: 'set_wall_openings',
        roomId: 'foyer',
        side: 'south',
        openings: [window, { ...door, ...patch }],
      },
    ]);
    assert.equal(result.applied, true);
    assert.equal(arrival(result.scene).passed, false);
  }
  const wrongSide = executeCommands(scene, [
    {
      type: 'set_wall_openings',
      roomId: 'foyer',
      side: 'east',
      openings: [{ ...door, offset: 0 }],
    },
  ]);
  assert.equal(arrival(wrongSide.scene).passed, false);
  const result = executeCommands(scene, [
    { type: 'set_wall_openings', roomId: 'foyer', side: 'south', openings: [window, door] },
  ]);
  assert.equal(result.applied, true);
  assert.deepEqual(
    result.issues.filter((issue) => issue.severity === 'error'),
    [],
  );
  assert.equal(arrival(result.scene).passed, true);
  assert.deepEqual(
    roomOpenings(result.scene, 'foyer', 'south')
      .map((opening) => opening.kind)
      .sort(),
    ['door', 'window'],
  );
});

test('a later window replacement cannot silently satisfy an arrival check after dropping the front door', () => {
  const before = executeCommands(shell(), [
    { type: 'set_wall_openings', roomId: 'foyer', side: 'south', openings: [window, door] },
  ]).scene;
  assert.equal(arrival(before).passed, true);
  const after = executeCommands(before, [
    { type: 'set_wall_openings', roomId: 'foyer', side: 'south', openings: [window] },
  ]).scene;
  assert.equal(arrival(after).passed, false);
  assert.equal(
    arrival(before).passed,
    true,
    'checking the candidate does not mutate the prior scene',
  );
});
