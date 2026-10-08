import test from 'node:test';
import assert from 'node:assert/strict';
import {
  designAssessmentSchema,
  evaluateDesignAssessment,
  assessmentDisclosure,
} from '../shared/assessment.ts';
import { emptyScene, makeRoom, type Scene } from '../shared/model.ts';

const scene: Scene = {
  ...emptyScene,
  roof: 'single-pitch',
  roofPitch: 12,
  roofDirection: 'south',
  rooms: [
    makeRoom({
      id: 'cabin',
      width: 8,
      depth: 6,
      height: 3,
      south: 'solid',
      wallOpenings: [
        {
          id: 'south-window',
          side: 'south',
          kind: 'window',
          offset: -1,
          width: 3,
          height: 2,
          sill: 0.6,
        },
        {
          id: 'south-door',
          side: 'south',
          kind: 'door',
          offset: 2.4,
          width: 1,
          height: 2.4,
          sill: 0,
        },
      ],
    }),
  ],
};
function assessment(checks: unknown[], overrides: Record<string, unknown> = {}) {
  return designAssessmentSchema.parse({
    requirements: [
      {
        id: 'brief',
        request: 'A single-pitch cabin with south-facing windows.',
        status: 'fulfilled',
        evidence: 'Roof and opening tools inspected.',
        checks,
        ...overrides,
      },
    ],
  });
}
test('explicit roof, aperture and dimension assertions verify the actual cabin geometry', () => {
  const result = evaluateDesignAssessment(
    scene,
    assessment([
      { kind: 'roof', roomId: 'cabin', style: 'single-pitch', pitch: 12, direction: 'south' },
      {
        kind: 'wall_opening',
        roomId: 'cabin',
        side: 'south',
        openingKind: 'window',
        minWidth: 3,
        minHeight: 2,
      },
      { kind: 'wall_opening', roomId: 'cabin', side: 'south', openingKind: 'door' },
      { kind: 'room_dimension', roomId: 'cabin', dimension: 'width', value: 8 },
    ]),
  );
  assert.equal(result.requiresConfirmation, false);
  assert.equal(result.requirements[0].verification, 'geometry');
  assert.ok(result.requirements[0].results.every((check) => check.passed));
});

test('individual aperture assertions use its stable ID and requested dimensions', () => {
  const input = assessment([
    {
      kind: 'opening_item',
      roomId: 'cabin',
      side: 'south',
      openingId: 'south-window',
      width: 3,
      offset: -1,
      openingKind: 'window',
    },
  ]);
  assert.equal(evaluateDesignAssessment(scene, input).requiresConfirmation, false);
  const changed = structuredClone(scene);
  changed.rooms[0].wallOpenings![0].width = 2.5;
  assert.equal(evaluateDesignAssessment(changed, input).requiresConfirmation, true);
  const removal = assessment([
    {
      kind: 'opening_item',
      roomId: 'cabin',
      side: 'south',
      openingId: 'south-window',
      present: false,
    },
  ]);
  assert.equal(evaluateDesignAssessment(scene, removal).requiresConfirmation, true);
  changed.rooms[0].wallOpenings!.shift();
  assert.equal(evaluateDesignAssessment(changed, removal).requiresConfirmation, false);
  changed.rooms = [];
  assert.equal(evaluateDesignAssessment(changed, removal).requiresConfirmation, true);
});
test('claimed fulfillment cannot override a wrong roof, window direction, missing room or unmet dimensions', () => {
  const result = evaluateDesignAssessment(
    scene,
    assessment([
      { kind: 'roof', roomId: 'cabin', style: 'pitched' },
      { kind: 'wall_opening', roomId: 'cabin', side: 'north', openingKind: 'window' },
      {
        kind: 'room_dimension',
        roomId: 'cabin',
        dimension: 'width',
        comparison: 'at_least',
        value: 10,
      },
      { kind: 'material', roomId: 'missing', palette: 'cedar' },
    ]),
  );
  assert.equal(result.requirements[0].status, 'partial');
  assert.equal(result.requiresConfirmation, true);
  assert.equal(result.requirements[0].results.filter((check) => check.passed).length, 0);
  assert.match(assessmentDisclosure(result), /Still outstanding/);
  assert.match(assessmentDisclosure(result), /does not exist/);
});
test('geometry assertions respect per-room roof overrides, legacy glass, and explicit aperture replacement', () => {
  const overridden: Scene = {
    ...scene,
    rooms: [makeRoom({ ...scene.rooms[0], roof: { style: 'flat' }, north: 'glass' })],
  };
  const result = evaluateDesignAssessment(
    overridden,
    assessment([
      { kind: 'roof', roomId: 'cabin', style: 'flat' },
      { kind: 'wall_opening', roomId: 'cabin', side: 'north', openingKind: 'window', minWidth: 8 },
      { kind: 'wall_opening', roomId: 'cabin', side: 'south', openingKind: 'window', minCount: 2 },
    ]),
  );
  assert.deepEqual(
    result.requirements[0].results.map((check) => check.passed),
    [true, true, false],
  );
});
test('aesthetic judgment is marked as model evidence and consequential assumptions require approval', () => {
  const input = assessment([]);
  input.assumptions = [
    { description: 'Move the bedroom to another floor.', requiresConfirmation: true },
  ];
  const result = evaluateDesignAssessment(scene, input);
  assert.equal(result.requirements[0].verification, 'model');
  assert.equal(result.requiresConfirmation, true);
  assert.match(assessmentDisclosure(result), /Assumption for your approval/);
  assert.equal(
    evaluateDesignAssessment(scene, assessment([], { priority: 'preference', status: 'unmet' }))
      .requiresConfirmation,
    false,
  );
});
test('an open courtyard does not satisfy an asserted indoor route', () => {
  const disconnected: Scene = {
    ...scene,
    rooms: [...scene.rooms, makeRoom({ id: 'bedroom', x: 15 })],
  };
  const result = evaluateDesignAssessment(
    disconnected,
    assessment([{ kind: 'indoor_route', roomIds: ['cabin', 'bedroom'] }]),
  );
  assert.equal(result.requirements[0].results[0].passed, false);
});
test('assessment rejects duplicate IDs and unbounded numerical tolerances', () => {
  const value = assessment([]);
  value.requirements.push(value.requirements[0]);
  assert.equal(designAssessmentSchema.safeParse(value).success, false);
  assert.throws(() =>
    assessment([
      { kind: 'room_dimension', roomId: 'cabin', dimension: 'width', value: 100, tolerance: 100 },
    ]),
  );
});
