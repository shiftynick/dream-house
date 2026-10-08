import test from 'node:test';
import assert from 'node:assert/strict';
import {
  needsColorReview,
  visualReviewSchema,
  evaluateVisualReview,
  type VisualCaptureProvenance,
} from '../shared/visual-review.ts';
import { emptyScene, makeRoom } from '../shared/model.ts';
import { executeCommands, effectiveSurfacePalettes } from '../shared/design.ts';
import { evaluateDesignAssessment, designAssessmentSchema } from '../shared/assessment.ts';

const scene = {
  ...emptyScene,
  rooms: [
    makeRoom({
      id: 'living',
      width: 8,
      depth: 6,
      surfacePalettes: { roof: 'cedar', north: 'charcoal', floor: 'limestone' },
    }),
    makeRoom({ id: 'kitchen', width: 8, depth: 6, x: 8, palette: 'chalk' }),
  ],
};

test('color review follows effective inherited surfaces, roof geometry and new rooms', () => {
  assert.equal(needsColorReview(scene, structuredClone(scene)), false);
  const inherited = { ...scene, palette: 'cedar' as const };
  assert.equal(needsColorReview(scene, inherited), true);
  const roof = {
    ...scene,
    roof: 'single-pitch' as const,
    roofPitch: 12,
    roofDirection: 'north' as const,
  };
  assert.equal(needsColorReview(scene, roof), true);
  const added = { ...scene, rooms: [...scene.rooms, makeRoom({ id: 'new', x: 20 })] };
  assert.equal(needsColorReview(scene, added), true);
  const geometry = executeCommands(scene, [
    { type: 'resize_room', roomId: 'living', depth: 7, anchor: 'north', moveConnected: false },
  ]).scene;
  assert.equal(
    needsColorReview(scene, geometry),
    false,
    'geometry-only edits can use a plan review',
  );
  const overridden = {
    ...scene,
    rooms: scene.rooms.map((room) => ({ ...room, palette: 'cedar' as const })),
  };
  assert.equal(
    needsColorReview(overridden, { ...overridden, palette: 'chalk' }),
    false,
    'ineffective defaults do not require color evidence',
  );
});

test('matching two roof surfaces preserves unrelated accent and floor choices and verifies each target', () => {
  const result = executeCommands(scene, [
    { type: 'set_surface_material', roomId: 'living', surface: 'roof', palette: 'chalk' },
    { type: 'set_surface_material', roomId: 'kitchen', surface: 'roof', palette: 'chalk' },
  ]);
  assert.equal(result.applied, true);
  assert.equal(effectiveSurfacePalettes(result.scene, result.scene.rooms[0]).roof, 'chalk');
  assert.equal(effectiveSurfacePalettes(result.scene, result.scene.rooms[1]).roof, 'chalk');
  assert.equal(result.scene.rooms[0].surfacePalettes?.north, 'charcoal');
  assert.equal(result.scene.rooms[0].surfacePalettes?.floor, 'limestone');
  assert.equal(result.scene.rooms[1].palette, 'chalk');
  assert.equal(result.scene.palette, scene.palette);
  const evaluated = evaluateDesignAssessment(
    result.scene,
    designAssessmentSchema.parse({
      requirements: [
        {
          id: 'matching-roofs',
          request: 'Match both roof surfaces.',
          status: 'fulfilled',
          evidence: 'Each effective roof palette is chalk.',
          checks: scene.rooms.map((room) => ({
            kind: 'material',
            roomId: room.id,
            surface: 'roof',
            palette: 'chalk',
          })),
        },
      ],
    }),
  );
  assert.ok(evaluated.requirements[0].results.every((check) => check.passed));
  assert.equal(needsColorReview(scene, result.scene), true);
});

test('visual judgments require nonempty bounded observations and distinct evidence IDs', () => {
  const input = {
    status: 'passed',
    captureIds: ['capture-1'],
    observations: ['Coordinated materials.'],
  };
  assert.equal(visualReviewSchema.safeParse(input).success, true);
  assert.equal(visualReviewSchema.safeParse({ ...input, observations: [] }).success, false);
  assert.equal(visualReviewSchema.safeParse({ ...input, observations: ['   '] }).success, false);
  assert.equal(
    visualReviewSchema.safeParse({ ...input, captureIds: ['capture-1', 'capture-1'] }).success,
    false,
  );
  assert.equal(
    visualReviewSchema.safeParse({ ...input, observations: ['x'.repeat(401)] }).success,
    false,
  );
});

test('effective furniture palette changes require color evidence without treating rearrangement as a material edit', () => {
  const furnished = {
    ...scene,
    rooms: scene.rooms.map((room) =>
      room.id === 'living'
        ? {
            ...room,
            furniture: [
              {
                id: 'sofa',
                kind: 'sofa' as const,
                name: 'Sofa',
                x: 0,
                z: 0,
                width: 2,
                depth: 1,
                height: 1,
                rotation: 0,
                palette: 'cedar' as const,
              },
            ],
          }
        : room,
    ),
  };
  const moved = structuredClone(furnished);
  moved.rooms[0].furniture![0].x = 1;
  assert.equal(needsColorReview(furnished, moved), false);
  const recolored = structuredClone(furnished);
  recolored.rooms[0].furniture![0].palette = 'chalk';
  assert.equal(needsColorReview(furnished, recolored), true);
});

test('every changed appearance target needs relevant evidence; whole-scene review can cover them together', () => {
  const modified = executeCommands(
    scene,
    scene.rooms.map((room) => ({
      type: 'set_surface_material',
      roomId: room.id,
      surface: 'north',
      palette: 'cedar',
    })),
  ).scene;
  const capture: VisualCaptureProvenance = {
    captureId: 'capture-1',
    sceneHash: 'final',
    view: 'interior',
    roomId: 'living',
    quality: 'live',
    light: 'day',
    angle: 'southeast',
    camera: { position: [1, 1, 1], target: [0, 1, 0] },
  };
  const options = {
    input: visualReviewSchema.parse({
      status: 'passed',
      captureIds: ['capture-1'],
      observations: ['Walls look coordinated.'],
    }),
    deliveredIds: new Set(['capture-1']),
    sceneHash: 'final',
    original: scene,
    scene: modified,
  };
  assert.match(
    evaluateVisualReview({ ...options, captures: new Map([['capture-1', capture]]) }).error!,
    /rooms kitchen/,
  );
  const wholeScene = { ...capture, view: 'cutaway' as const, roomId: undefined };
  assert.equal(
    evaluateVisualReview({ ...options, captures: new Map([['capture-1', wholeScene]]) }).review
      ?.status,
    'passed',
  );
});

test('a geometry-only edit can be explicitly reviewed using a delivered plan', () => {
  const modified = executeCommands(scene, [
    { type: 'resize_room', roomId: 'living', depth: 7, anchor: 'north', moveConnected: false },
  ]).scene;
  const capture: VisualCaptureProvenance = {
    captureId: 'capture-1',
    sceneHash: 'final',
    view: 'plan',
    quality: 'live',
    light: 'day',
    angle: 'southeast',
    camera: { position: [0, 50, 0], target: [0, 0, 0] },
  };
  const result = evaluateVisualReview({
    input: visualReviewSchema.parse({
      status: 'passed',
      captureIds: ['capture-1'],
      observations: ['The resized footprint is visible in plan.'],
    }),
    captures: new Map([['capture-1', capture]]),
    deliveredIds: new Set(['capture-1']),
    sceneHash: 'final',
    original: scene,
    scene: modified,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.review?.captures[0].view, 'plan');
});
