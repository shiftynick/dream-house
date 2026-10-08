import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyScene, makeRoom, type Scene } from '../shared/model.ts';
import { executeCommands } from '../shared/design.ts';
import { roomFurniture } from '../shared/furniture.ts';
import { reviewEditScope, evaluatePreservation } from '../shared/preservation.ts';
import { designAssessmentSchema, evaluateDesignAssessment } from '../shared/assessment.ts';
import { runAgent, type ModelTurn } from '../server/agent.ts';

function fixture(): Scene {
  return {
    ...structuredClone(emptyScene),
    rooms: [
      makeRoom({ id: 'living', name: 'Living', kind: 'living', width: 8, depth: 6, x: 0 }),
      makeRoom({ id: 'other', name: 'Other', kind: 'bedroom', width: 6, depth: 6, x: 12 }),
    ],
  };
}
function turn(name: string, args: unknown): ModelTurn {
  return {
    calls: [{ id: name, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
    content: null,
    truncated: false,
    usage: { inputTokens: 0, outputTokens: 0, cost: 0 },
  };
}

test('selected floor scope preserves every other surface, room and global field', () => {
  const before = fixture();
  const selection = { roomId: 'living', surface: 'floor' as const };
  const changed = executeCommands(before, [
    { type: 'set_surface_material', roomId: 'living', surface: 'floor', palette: 'cedar' },
  ]);
  assert.equal(changed.applied, true);
  assert.equal(reviewEditScope(before, changed.scene, selection).preserved, true);
  const unrelated = structuredClone(changed.scene);
  unrelated.rooms[1].name = 'Changed elsewhere';
  unrelated.rooms[0].surfacePalettes!.north = 'charcoal';
  unrelated.slope = 0.33;
  const result = reviewEditScope(before, unrelated, selection);
  assert.equal(result.preserved, false);
  assert.ok(result.changes.includes('rooms.other.name'));
  assert.ok(result.changes.includes('rooms.living.surfacePalettes'));
  assert.ok(result.changes.includes('slope'));
});

test('selected legacy furniture can materialize without treating untouched siblings as changes', () => {
  const before = fixture(),
    after = structuredClone(before);
  const items = roomFurniture(after.rooms[0]);
  assert.ok(items.length > 1);
  after.rooms[0].furniture = items;
  after.rooms[0].furniture[0].rotation += 10;
  const selection = { roomId: 'living', surface: 'room' as const, furnitureId: items[0].id };
  assert.equal(reviewEditScope(before, after, selection).preserved, true);
  after.rooms[0].furniture[1].rotation += 10;
  assert.equal(reviewEditScope(before, after, selection).preserved, false);
});

test('wall scope permits its anchored move but detects moved furniture and opposite walls', () => {
  const before = fixture();
  before.rooms[0].south = 'solid';
  before.rooms[0].furniture = roomFurniture(before.rooms[0]);
  const after = structuredClone(before);
  after.rooms[0].width += 1;
  after.rooms[0].x += 0.5;
  const selection = { roomId: 'living', surface: 'east' as const };
  assert.equal(
    reviewEditScope(before, after, selection).preserved,
    false,
    'Unadjusted furniture moved in world space',
  );
  after.rooms[0].furniture!.forEach((item) => (item.x -= 0.5));
  assert.equal(reviewEditScope(before, after, selection).preserved, true);
  after.rooms[0].x += 0.25;
  assert.equal(
    reviewEditScope(before, after, selection).preserved,
    false,
    'Opposite wall must stay fixed',
  );
});

test('baseline assertions resolve inherited finishes and world furniture positions without rebasing', () => {
  const before = fixture(),
    after = structuredClone(before);
  after.palette = 'charcoal';
  assert.equal(
    evaluatePreservation(before, after, {
      kind: 'unchanged_surface',
      roomId: 'living',
      surface: 'floor',
    }).passed,
    false,
  );
  assert.equal(
    evaluatePreservation(undefined, after, { kind: 'unchanged_room', roomId: 'living' }).passed,
    false,
  );
  const item = roomFurniture(before.rooms[0])[0];
  const moved = structuredClone(before);
  moved.rooms[0].furniture = roomFurniture(before.rooms[0]);
  moved.rooms[0].x += 1;
  moved.rooms[0].furniture!.forEach((piece) => (piece.x -= 1));
  assert.equal(
    evaluatePreservation(before, moved, {
      kind: 'unchanged_furniture',
      roomId: 'living',
      furnitureId: item.id,
    }).passed,
    true,
  );
  assert.equal(
    evaluatePreservation(before, moved, {
      kind: 'unchanged_room',
      roomId: 'living',
      properties: ['furniture'],
    }).passed,
    true,
  );
  assert.equal(
    evaluatePreservation(before, moved, {
      kind: 'unchanged_room',
      roomId: 'living',
      properties: ['geometry'],
    }).passed,
    false,
  );
});

test('opening preservation includes legacy apertures and retained windows in world coordinates', () => {
  const before = fixture();
  before.rooms[0].north = 'door';
  const after = structuredClone(before);
  after.rooms[0].north = 'solid';
  assert.equal(
    evaluatePreservation(before, after, {
      kind: 'unchanged_room',
      roomId: 'living',
      properties: ['openings'],
    }).passed,
    false,
  );
  before.rooms[0].north = 'glass';
  assert.equal(
    evaluatePreservation(before, after, {
      kind: 'unchanged_room',
      roomId: 'living',
      properties: ['openings'],
    }).passed,
    false,
  );
  before.rooms[0].north = 'solid';
  before.rooms[0].south = 'solid';
  before.rooms[0].furniture = [];
  before.rooms[0].wallOpenings = [
    {
      id: 'north-window',
      side: 'north',
      kind: 'window',
      offset: 0,
      width: 1.5,
      height: 1,
      sill: 1,
    },
  ];
  const expanded = structuredClone(before);
  expanded.rooms[0].width += 1;
  expanded.rooms[0].x += 0.5;
  const scope = { roomId: 'living', surface: 'east' as const };
  assert.equal(reviewEditScope(before, expanded, scope).preserved, false);
  expanded.rooms[0].wallOpenings![0].offset -= 0.5;
  assert.equal(reviewEditScope(before, expanded, scope).preserved, true);
});

test('an individual opening scope permits only its physical aperture and safe final closure', () => {
  const before = fixture();
  before.rooms[0].east = 'door';
  before.rooms[0].wallOpenings = [
    { id: 'selected', side: 'east', kind: 'door', offset: 0, width: 1, height: 2.1, sill: 0 },
    { id: 'sibling', side: 'north', kind: 'window', offset: 0, width: 1, height: 1, sill: 1 },
  ];
  const after = structuredClone(before);
  after.rooms[0].wallOpenings![0].width = 1.2;
  const selection = { roomId: 'living', surface: 'east' as const, openingId: 'selected' };
  assert.equal(reviewEditScope(before, after, selection).preserved, true);
  assert.equal(
    evaluatePreservation(before, after, {
      kind: 'unchanged_opening',
      roomId: 'living',
      side: 'east',
      openingId: 'selected',
    }).passed,
    false,
  );
  after.rooms[0].wallOpenings![1].width = 1.2;
  assert.equal(reviewEditScope(before, after, selection).preserved, false);
  const closed = structuredClone(before);
  closed.rooms[0].wallOpenings = closed.rooms[0].wallOpenings!.filter(
    (opening) => opening.id !== 'selected',
  );
  closed.rooms[0].east = 'solid';
  assert.equal(reviewEditScope(before, closed, selection).preserved, true);
  closed.rooms[0].north = 'glass';
  assert.equal(reviewEditScope(before, closed, selection).preserved, false);
});

test('a valid unrelated edit cannot remain fulfilled in a baseline preservation assessment', () => {
  const before = fixture(),
    after = structuredClone(before);
  after.rooms[1].name = 'Renamed';
  const input = designAssessmentSchema.parse({
    requirements: [
      {
        id: 'preserve',
        request: 'Keep the other room exactly unchanged.',
        priority: 'required',
        status: 'fulfilled',
        evidence: 'I preserved it.',
        checks: [{ kind: 'unchanged_room', roomId: 'other' }],
      },
    ],
  });
  const evaluated = evaluateDesignAssessment(after, input, before);
  assert.equal(evaluated.requirements[0].status, 'partial');
  assert.equal(evaluated.requiresConfirmation, true);
  assert.match(evaluated.requirements[0].limitation!, /name/);
});

test('immutable request scope forces disclosure and confirmation even when the model omits an assessment', async () => {
  const scene = fixture();
  let round = 0;
  const result = await runAgent({
    scene,
    messages: [{ id: 'u', role: 'user', text: 'Change only the living floor.' }],
    context: { editScope: { roomId: 'living', surface: 'floor' }, allowVisualReview: false },
    client: {
      async complete() {
        if (!round++)
          return turn('apply_operations', {
            operations: [
              {
                type: 'set_surface_material',
                roomId: 'living',
                surface: 'floor',
                palette: 'cedar',
              },
              { type: 'set_surface_material', roomId: 'other', surface: 'floor', palette: 'cedar' },
            ],
          });
        return turn('finish_design', { mode: 'apply', reply: 'Changed the floor.' });
      },
    },
  });
  assert.equal(result.needsConfirmation, true);
  assert.equal(result.editScopeReview?.preserved, false);
  assert.match(result.reply, /outside your selected part/);
  assert.equal(scene.rooms[1].surfacePalettes, undefined);
});

test('request preservation checks survive reset and are not dependent on the model checklist', async () => {
  const scene = fixture();
  let round = 0;
  const turns = [
    turn('reset_draft', {}),
    turn('apply_operations', {
      operations: [
        { type: 'set_surface_material', roomId: 'living', surface: 'floor', palette: 'cedar' },
        { type: 'set_surface_material', roomId: 'other', surface: 'roof', palette: 'cedar' },
      ],
    }),
    turn('finish_design', { mode: 'apply', reply: 'Updated the living floor.' }),
  ];
  const result = await runAgent({
    scene,
    messages: [{ id: 'u', role: 'user', text: 'Keep the other room unchanged.' }],
    context: {
      allowVisualReview: false,
      preservationChecks: [{ kind: 'unchanged_room', roomId: 'other' }],
    },
    client: {
      async complete() {
        return turns[round++];
      },
    },
  });
  assert.equal(result.needsConfirmation, true);
  assert.equal(result.preservationResults?.[0].passed, false);
  assert.match(result.reply, /Preservation needs review/);
  assert.equal(scene.design, undefined);
});

test('valid focused scope applies normally and stale selected target fails before a model call', async () => {
  const scene = fixture();
  let round = 0;
  const result = await runAgent({
    scene,
    messages: [{ id: 'u', role: 'user', text: 'Change this floor.' }],
    context: { editScope: { roomId: 'living', surface: 'floor' }, allowVisualReview: false },
    client: {
      async complete() {
        return round++
          ? turn('finish_design', { mode: 'apply', reply: 'Floor changed.' })
          : turn('apply_operations', {
              operations: [
                {
                  type: 'set_surface_material',
                  roomId: 'living',
                  surface: 'floor',
                  palette: 'cedar',
                },
              ],
            });
      },
    },
  });
  assert.equal(result.editScopeReview?.preserved, true);
  assert.equal(result.needsConfirmation, false);
  await assert.rejects(
    runAgent({
      scene,
      messages: [{ id: 'u', role: 'user', text: 'Edit it.' }],
      context: { editScope: { roomId: 'missing', surface: 'room' } },
      client: {
        async complete() {
          assert.fail('Stale scope must not incur a paid call');
        },
      },
    }),
    /target no longer exists/,
  );
});
