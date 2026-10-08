import test from 'node:test';
import assert from 'node:assert/strict';
import {
  carryRefinementReview,
  inheritedPreservationContext,
} from '../server/refinement-review.ts';
import { evaluateDesignAssessment, designAssessmentSchema } from '../shared/assessment.ts';
import { emptyScene, makeRoom } from '../shared/model.ts';
import { sceneFingerprint } from '../server/render-service.ts';
import type { AgentResult } from '../server/agent.ts';
import type { EvaluatedVisualReview } from '../shared/visual-review.ts';

const original = { ...emptyScene, rooms: [makeRoom({ id: 'living', width: 8, depth: 6 })] };
function result(scene = original): AgentResult {
  return {
    scene,
    reply: 'Refined the floor.',
    needsConfirmation: false,
    events: [],
    issues: [],
    changes: ['Updated floor.'],
    usage: { calls: 0, inputTokens: 0, outputTokens: 0, cost: 0 },
  };
}
function roofAssessment(scene = original) {
  return evaluateDesignAssessment(
    scene,
    designAssessmentSchema.parse({
      requirements: [
        {
          id: 'roof',
          request: 'Use a single-pitch roof.',
          status: 'fulfilled',
          evidence: 'Roof checked.',
          checks: [{ kind: 'roof', roomId: 'living', style: 'single-pitch' }],
        },
      ],
    }),
    original,
  );
}
function visual(
  scene = original,
  status: 'passed' | 'issues' = 'issues',
  view: 'exterior' | 'interior' = 'exterior',
): EvaluatedVisualReview {
  return {
    status,
    observations: ['Roof panels appear inconsistent.'],
    limitations: [],
    captureIds: ['capture-1'],
    verification: 'model',
    requiresConfirmation: status !== 'passed',
    captures: [
      {
        captureId: 'capture-1',
        sceneHash: sceneFingerprint(scene),
        view,
        quality: 'live',
        light: 'day',
        angle: 'southeast',
        ...(view === 'interior' ? { roomId: 'living' } : {}),
        camera: { position: [5, 5, 5], target: [0, 0, 0] },
      },
    ],
  };
}

test('a minor refinement cannot drop a failed source checklist, weaken its priority or erase checks', () => {
  const source = {
    reply: 'Outstanding roof request.',
    needsConfirmation: true,
    assessment: roofAssessment(),
    reviewBaseline: original,
  };
  const floor = {
    ...original,
    rooms: original.rooms.map((room) => ({
      ...room,
      surfacePalettes: { floor: 'cedar' as const },
    })),
  };
  for (const assessment of [
    undefined,
    evaluateDesignAssessment(
      floor,
      designAssessmentSchema.parse({
        requirements: [
          {
            id: 'roof',
            request: 'Just a floor.',
            priority: 'preference',
            status: 'fulfilled',
            evidence: 'Floor changed.',
            checks: [],
          },
        ],
      }),
    ),
  ]) {
    const carried = carryRefinementReview(
      source,
      { ...result(floor), assessment },
      original,
      original,
    ).answer;
    assert.equal(carried.needsConfirmation, true);
    assert.equal(carried.assessment?.requirements[0].priority, 'required');
    assert.equal(carried.assessment?.requirements[0].request, 'Use a single-pitch roof.');
    assert.equal(carried.assessment?.requirements[0].checks.length, 1);
    assert.equal(carried.assessment?.requirements[0].status, 'partial');
    assert.match(carried.reply, /Still outstanding.*single-pitch roof/);
  }
});

test('actual geometry repair clears an inherited failed objective check', () => {
  const source = {
    reply: 'Outstanding roof request.',
    needsConfirmation: true,
    assessment: roofAssessment(),
    reviewBaseline: original,
  };
  const repaired = {
    ...original,
    roof: 'single-pitch' as const,
    roofPitch: 12,
    roofDirection: 'north' as const,
  };
  const carried = carryRefinementReview(source, result(repaired), original, original).answer;
  assert.equal(carried.assessment?.requirements[0].status, 'fulfilled');
  assert.equal(carried.needsConfirmation, false);
});

test('negative roof review survives a floor-only passing image and clears only with equivalent fresh evidence', () => {
  const source = {
    reply: 'Roof consistency needs review.',
    needsConfirmation: true,
    visualReview: visual(),
    reviewBaseline: original,
  };
  const refined = {
    ...original,
    rooms: original.rooms.map((room) => ({
      ...room,
      surfacePalettes: { floor: 'cedar' as const },
    })),
  };
  for (const replacement of [
    undefined,
    visual(refined, 'passed', 'interior'),
    visual(original, 'passed'),
  ]) {
    const carried = carryRefinementReview(
      source,
      { ...result(refined), visualReview: replacement },
      original,
      original,
    ).answer;
    assert.equal(carried.visualReview?.status, 'issues');
    assert.equal(carried.needsConfirmation, true);
    assert.match(carried.reply, /Roof panels appear inconsistent/);
  }
  const repaired = carryRefinementReview(
    source,
    { ...result(refined), visualReview: visual(refined, 'passed') },
    original,
    original,
  ).answer;
  assert.equal(repaired.visualReview?.status, 'passed');
  assert.equal(repaired.needsConfirmation, false);
});

test('an original preservation baseline cannot be silently rebased by repeated refinements', () => {
  const changed = { ...original, rooms: original.rooms.map((room) => ({ ...room, width: 9 })) };
  const assessment = evaluateDesignAssessment(
    changed,
    designAssessmentSchema.parse({
      requirements: [
        {
          id: 'preserve-room',
          request: 'Keep room geometry.',
          status: 'fulfilled',
          evidence: 'Geometry checked.',
          checks: [{ kind: 'unchanged_room', roomId: 'living', properties: ['geometry'] }],
        },
      ],
    }),
    original,
  );
  const source = {
    reply: 'Geometry changed.',
    needsConfirmation: true,
    assessment,
    assessmentBaselines: { 'preserve-room': original },
    reviewBaseline: original,
  };
  const first = carryRefinementReview(source, result(changed), original, changed);
  const second = carryRefinementReview(
    { ...first.answer, assessmentBaselines: first.baselines, reviewBaseline: changed },
    result(changed),
    original,
    changed,
  );
  assert.equal(second.answer.assessment?.requirements[0].status, 'partial');
  assert.equal(second.answer.needsConfirmation, true);
  assert.deepEqual(second.baselines['preserve-room'], original);
  const repaired = carryRefinementReview(
    { ...second.answer, assessmentBaselines: second.baselines },
    result(original),
    original,
    changed,
  );
  assert.equal(repaired.answer.assessment?.requirements[0].status, 'fulfilled');
});

test('opaque review disclosures and consequential assumptions remain visible across refinement', () => {
  const opaque = carryRefinementReview(
    { reply: 'This changes the agreed entrance position.', needsConfirmation: true },
    result(),
    original,
    original,
  );
  assert.equal(opaque.answer.needsConfirmation, true);
  assert.match(opaque.answer.reply, /agreed entrance position/);
  const assessment = evaluateDesignAssessment(
    original,
    designAssessmentSchema.parse({
      requirements: [
        { id: 'floor', request: 'A warm floor.', status: 'fulfilled', evidence: 'Model judgment.' },
      ],
      assumptions: [
        { description: 'Assumed guest access through the courtyard.', requiresConfirmation: true },
      ],
    }),
  );
  const carried = carryRefinementReview(
    { reply: 'Access assumption.', needsConfirmation: true, assessment },
    result(),
    original,
    original,
  ).answer;
  assert.equal(carried.assessment?.assumptions[0].requiresConfirmation, true);
  assert.equal(carried.needsConfirmation, true);
  assert.match(carried.reply, /courtyard/);
});

test('immutable context preservation survives repaired visual review and clears only after actual repair', () => {
  const changed = {
    ...original,
    rooms: original.rooms.map((room) => ({ ...room, width: room.width + 1 })),
  };
  const source = {
    reply: 'Room geometry changed despite its preservation constraint.',
    needsConfirmation: true,
    visualReview: visual(changed),
    preservationResults: [{ passed: false, actual: null, reason: 'Room geometry changed.' }],
    preservationEntries: [
      {
        check: {
          kind: 'unchanged_room' as const,
          roomId: 'living',
          properties: ['geometry' as const],
        },
        baseline: original,
      },
    ],
  };
  const stillChanged = carryRefinementReview(
    source,
    { ...result(changed), visualReview: visual(changed, 'passed') },
    original,
    changed,
  );
  assert.equal(stillChanged.answer.needsConfirmation, true);
  assert.equal(stillChanged.answer.assessment?.requirements[0].status, 'partial');
  assert.match(stillChanged.answer.reply, /Preserve the original request constraint/);
  const repaired = carryRefinementReview(
    {
      ...source,
      assessment: stillChanged.answer.assessment,
      assessmentBaselines: stillChanged.baselines,
    },
    { ...result(), visualReview: visual(original, 'passed') },
    original,
    changed,
  );
  assert.equal(repaired.answer.assessment?.requirements[0].status, 'fulfilled');
  assert.equal(repaired.answer.needsConfirmation, false);
});

test('legacy failed preservation disclosure is independent of another repaired review', () => {
  const carried = carryRefinementReview(
    {
      reply: 'Two concerns.',
      needsConfirmation: true,
      visualReview: visual(),
      preservationResults: [{ passed: false, actual: null, reason: 'Original room changed.' }],
    },
    { ...result(), visualReview: visual(original, 'passed') },
    original,
    original,
  );
  assert.equal(carried.answer.needsConfirmation, true);
  assert.match(
    carried.answer.reply,
    /Earlier preservation constraint remains unverified: Original room changed/,
  );
});

test('inherited preservation model context groups baselines and projects only checked rooms', () => {
  const baseline = { ...original, rooms: [...original.rooms, makeRoom({ id: 'other', x: 10 })] };
  const context = inheritedPreservationContext({
    reply: '',
    needsConfirmation: true,
    preservationEntries: [
      { check: { kind: 'unchanged_room', roomId: 'living' }, baseline },
      { check: { kind: 'unchanged_surface', roomId: 'living', surface: 'roof' }, baseline },
    ],
  });
  assert.equal(context.length, 1);
  assert.equal(context[0].checks.length, 2);
  assert.deepEqual(
    context[0].originalBaseline.rooms.map((room) => room.id),
    ['living'],
  );
  assert.equal(context[0].originalBaseline.palette, baseline.palette);
  assert.match(context[0].description, /omitted rooms were not removed/);
});
