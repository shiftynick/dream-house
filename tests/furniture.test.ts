import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  emptyScene,
  makeRoom,
  newProject,
  redo,
  undo,
  sceneSchema,
  type Scene,
} from '../shared/model.ts';
import { ProjectStore } from '../server/storage.ts';
import { DesignService } from '../server/design-service.ts';
import { furnitureBounds, makeFurniture, roomFurniture } from '../shared/furniture.ts';
import { furnitureFootprints, inspectRoomFurniture } from '../shared/spatial.ts';
import { executeCommands, inspectDesign, validateDesign } from '../shared/design.ts';
import { DesignDraft, canonicalScene } from '../shared/draft.ts';
import { designAssessmentSchema, evaluateDesignAssessment } from '../shared/assessment.ts';
import { selectionLabel, validSelection } from '../shared/selection.ts';
import { furnitureBlockingCodes } from '../shared/furniture-layout.ts';
import { FloorPlanSvg } from '../src/SceneView.tsx';
import { visualSceneKey } from '../src/renderPerformance.ts';
import { runAgent, type ModelTurn } from '../server/agent.ts';

const fixture = (): Scene => ({
  ...structuredClone(emptyScene),
  slope: 0,
  rooms: [
    makeRoom({
      id: 'living',
      name: 'Living',
      kind: 'living',
      width: 8,
      depth: 5,
      north: 'solid',
      south: 'glass',
      east: 'door',
      west: 'solid',
    }),
    makeRoom({ id: 'bedroom', kind: 'bedroom', x: 15, width: 6, depth: 6 }),
  ],
});
const architecture = (scene: Scene) => ({
  ...scene,
  rooms: scene.rooms.map(({ furniture: _, ...room }) => room),
});

test('legacy furniture stays implicit and stable until the first targeted edit; empty means unfurnished', () => {
  const before = fixture(),
    bytes = JSON.stringify(before),
    legacy = roomFurniture(before.rooms[0]);
  assert.equal(inspectDesign(before).rooms[0].furnitureMode, 'generated');
  assert.equal(JSON.stringify(before), bytes);
  const next = executeCommands(before, [
    { type: 'update_furniture', roomId: 'living', furnitureId: 'table', patch: { x: 2, z: 1 } },
  ]);
  assert.equal(next.applied, true);
  const expected = structuredClone(legacy);
  Object.assign(
    expected.find((item) => item.id === 'table')!,
    { x: 2, z: 1 },
  );
  assert.deepEqual(next.scene.rooms[0].furniture, expected);
  assert.deepEqual(next.scene.rooms[1], before.rooms[1]);
  assert.deepEqual(architecture(next.scene).rooms, architecture(before).rooms);
  const cleared = executeCommands(next.scene, [
    { type: 'remove_furniture', roomId: 'living', furnitureIds: expected.map((item) => item.id) },
  ]);
  assert.deepEqual(roomFurniture(cleared.scene.rooms[0]), []);
  assert.deepEqual(sceneSchema.parse(cleared.scene).rooms[0].furniture, []);
});

test('deterministic arrangement fixes an overhanging table without changing inventory or architecture', () => {
  const before = fixture();
  assert.ok(
    inspectRoomFurniture(before, before.rooms[0]).some((i) => i.code === 'furniture_outside_room'),
  );
  const command = [{ type: 'arrange_furniture', roomIds: ['living'] }];
  const first = executeCommands(before, command),
    second = executeCommands(before, command);
  assert.equal(first.applied, true);
  assert.deepEqual(first.scene, second.scene);
  assert.deepEqual(architecture(first.scene).rooms, architecture(before).rooms);
  assert.deepEqual(
    roomFurniture(first.scene.rooms[0]).map(({ x: _, z: __, rotation: ___, ...item }) => item),
    roomFurniture(before.rooms[0]).map(({ x: _, z: __, rotation: ___, ...item }) => item),
  );
  assert.deepEqual(
    validateDesign(first.scene).filter((i) => i.severity === 'error'),
    [],
  );
  assert.deepEqual(
    inspectRoomFurniture(first.scene, first.scene.rooms[0]).filter((i) =>
      furnitureBlockingCodes.has(i.code),
    ),
    [],
  );
});

test('a clear but corner-heavy seating group can be balanced without inventing a clearance failure', () => {
  const before = fixture();
  before.rooms[0].depth = 5.6;
  before.rooms[0].south = 'open';
  assert.deepEqual(inspectRoomFurniture(before, before.rooms[0]), []);
  const after = executeCommands(before, [{ type: 'arrange_furniture', roomIds: ['living'] }]).scene;
  assert.notDeepEqual(roomFurniture(after.rooms[0]), roomFurniture(before.rooms[0]));
  const sofa = roomFurniture(after.rooms[0]).find((item) => item.kind === 'sofa')!;
  const table = roomFurniture(after.rooms[0]).find((item) => item.kind === 'coffee-table')!;
  assert.ok(Math.abs(sofa.x) < 0.1 && Math.abs(table.x) < 0.1);
  assert.deepEqual(
    inspectRoomFurniture(after, after.rooms[0]).filter((i) => furnitureBlockingCodes.has(i.code)),
    [],
  );
});

test('an impossible furnishing request keeps its pieces and exposes the fit problem', () => {
  const before = fixture();
  before.rooms[0].width = 2;
  before.rooms[0].depth = 2;
  const after = executeCommands(before, [{ type: 'arrange_furniture', roomIds: ['living'] }]);
  assert.equal(roomFurniture(after.scene.rooms[0]).length, roomFurniture(before.rooms[0]).length);
  assert.ok(after.issues.some((i) => i.code === 'furniture_does_not_fit'));
  assert.deepEqual(architecture(after.scene).rooms, architecture(before).rooms);
});

test('rotations match world-space footprints, move once with rooms and stay editable by stable ID', () => {
  const before = fixture();
  before.rooms[0].furniture = [
    makeFurniture('sofa', 'sofa', { x: 1, z: -1, rotation: 90, width: 3, depth: 1 }),
  ];
  const footprint = furnitureFootprints(before.rooms[0])[0];
  assert.ok(Math.abs(footprint.width - 1) < 1e-9);
  assert.equal(footprint.depth, 3);
  const moved = executeCommands(before, [
    { type: 'move_group', roomIds: ['living'], dx: 4, dz: 2, includeGroups: false },
  ]);
  assert.deepEqual(moved.scene.rooms[0].furniture, before.rooms[0].furniture);
  assert.equal(furnitureFootprints(moved.scene.rooms[0])[0].x, footprint.x + 4);
  assert.equal(furnitureFootprints(moved.scene.rooms[0])[0].z, footprint.z + 2);
  const repositioned = executeCommands(moved.scene, [
    { type: 'update_furniture', roomId: 'living', furnitureId: 'sofa', patch: { x: 0 } },
  ]);
  assert.equal(
    repositioned.scene.rooms[0].furniture![0].rotation,
    90,
    'A position-only patch must not reset rotation.',
  );
  const selection = { roomId: 'living', surface: 'room', furnitureId: 'sofa' };
  assert.ok(validSelection(moved.scene, selection));
  assert.match(selectionLabel(moved.scene, validSelection(moved.scene, selection)), /Sofa/);
  const removed = executeCommands(moved.scene, [
    { type: 'remove_furniture', roomId: 'living', furnitureIds: ['sofa'] },
  ]);
  assert.equal(validSelection(removed.scene, selection), null);
  assert.equal(validSelection(before, { ...selection, surface: 'north' }), null);
});

test('explicit furniture bounds and duplicates block saving while drafts remain repairable', () => {
  const scene = fixture();
  scene.rooms[0].furniture = [makeFurniture('armchair', 'chair', { x: 0, z: 0 })];
  const draft = new DesignDraft(scene);
  draft.apply([
    { type: 'update_furniture', roomId: 'living', furnitureId: 'chair', patch: { x: 20 } },
  ]);
  assert.ok(draft.inspect().issues.some((i) => i.code === 'furniture_does_not_fit'));
  draft.apply([
    { type: 'update_furniture', roomId: 'living', furnitureId: 'chair', patch: { x: 0 } },
  ]);
  assert.ok(!draft.inspect().issues.some((i) => i.code === 'furniture_does_not_fit'));
  const added = executeCommands(scene, [
    { type: 'add_furniture', roomId: 'living', items: [makeFurniture('bed', 'chair')] },
  ]);
  assert.equal(added.applied, false);
  assert.deepEqual(added.scene, scene);
  const malformed = structuredClone(scene);
  malformed.rooms[0].furniture!.push(makeFurniture('sofa', 'chair'));
  assert.ok(validateDesign(malformed).some((i) => i.code === 'duplicate_furniture_id'));
  assert.equal(
    executeCommands(scene, [
      { type: 'update_furniture', roomId: 'living', furnitureId: 'missing', patch: { x: 1 } },
    ]).applied,
    false,
  );
});

test('furniture claims are checked against real positions, passages and stair obstructions', () => {
  const scene = fixture();
  scene.rooms[0].furniture = [makeFurniture('armchair', 'chair', { x: 3.3, z: 0 })];
  const check = (checks: unknown[]) =>
    evaluateDesignAssessment(
      scene,
      designAssessmentSchema.parse({
        requirements: [
          {
            id: 'furnish',
            request: 'Keep doors clear',
            priority: 'required',
            status: 'fulfilled',
            evidence: 'Claimed clear',
            checks,
          },
        ],
        assumptions: [],
      }),
    );
  const failed = check([{ kind: 'furniture_layout', roomId: 'living' }]);
  assert.equal(failed.requiresConfirmation, true);
  assert.equal(failed.requirements[0].status, 'partial');
  assert.equal(
    check([{ kind: 'furniture_item', roomId: 'living', furnitureId: 'chair', x: 0 }])
      .requiresConfirmation,
    true,
  );
  scene.rooms[0].east = 'open';
  assert.ok(
    inspectRoomFurniture(scene, scene.rooms[0]).some((i) => i.code === 'door_approach_blocked'),
  );
  assert.ok(
    !inspectRoomFurniture(scene, scene.rooms[0]).some((i) => i.code === 'door_swing_obstructed'),
  );
  scene.rooms[0].furniture[0].x = 0;
  scene.stairs = [
    { id: 'stair', x: 0, z: 0, elevation: 0, rise: 3, width: 1, run: 3, rotation: 0 },
  ];
  assert.ok(
    inspectRoomFurniture(scene, scene.rooms[0]).some((i) => i.code === 'furniture_stair_blocked'),
  );
});

test('furniture locks survive edits and cannot be rebased by repeating the requirement', () => {
  const before = fixture();
  before.rooms[0].furniture = [makeFurniture('chair', 'chair')];
  const requirement = {
    id: 'furniture-lock',
    kind: 'locked',
    roomId: 'living',
    properties: ['furniture'],
    source: 'confirmed',
    description: 'Preserve furnishings',
  };
  const locked = executeCommands(before, [{ type: 'set_requirement', requirement }]);
  const changed = executeCommands(locked.scene, [
    { type: 'update_furniture', roomId: 'living', furnitureId: 'chair', patch: { x: 1 } },
    { type: 'set_requirement', requirement },
  ]);
  assert.ok(changed.issues.some((i) => i.code === 'locked_property_changed'));
});

test('draft furniture inventory changes stay anchored to the saved house across multiple rounds', () => {
  const draft = new DesignDraft(fixture());
  draft.apply([
    { type: 'update_furniture', roomId: 'living', furnitureId: 'sofa', patch: { x: 0 } },
  ]);
  draft.apply([
    { type: 'add_furniture', roomId: 'living', items: [makeFurniture('armchair', 'new-chair')] },
  ]);
  draft.apply([{ type: 'remove_furniture', roomId: 'living', furnitureIds: ['table'] }]);
  assert.deepEqual(draft.inspect().furnitureChanges, [
    { roomId: 'living', added: ['new-chair'], removed: ['table'], changed: ['sofa'] },
  ]);
  draft.reset();
  assert.deepEqual(draft.inspect().furnitureChanges, []);
});

test('floor plan contains the same oriented furniture dimensions and changes invalidate rendered evidence', () => {
  const scene = fixture();
  scene.rooms[0].furniture = [
    makeFurniture('bed', 'bed', { x: 1, z: -1, rotation: 90, width: 2, depth: 2.5 }),
  ];
  const svg = renderToStaticMarkup(
    createElement(FloorPlanSvg, { house: scene, level: 0, selected: null, onSelect: () => {} }),
  );
  assert.match(svg, /data-furniture-id="bed"/);
  assert.match(svg, /translate\(1 -1\) rotate\(-90\)/);
  assert.match(svg, /width="2" height="2.5"/);
  const moved = executeCommands(scene, [
    { type: 'update_furniture', roomId: 'living', furnitureId: 'bed', patch: { x: 1.5 } },
  ]).scene;
  assert.notEqual(visualSceneKey(scene, false), visualSceneKey(moved, false));
  assert.notEqual(canonicalScene(scene), canonicalScene(moved));
  assert.ok(furnitureBounds(scene.rooms[0].furniture[0]).depth >= 2);
});

test('injected agent can arrange furniture and satisfy local assertions without changing architecture', async () => {
  const scene = fixture();
  let round = 0;
  const result = await runAgent({
    key: 'synthetic',
    model: 'synthetic',
    scene,
    messages: [{ id: 'request', role: 'user', text: 'Can you do better furniture placement?' }],
    client: {
      async complete(): Promise<ModelTurn> {
        const name = round++ === 0 ? 'apply_operations' : 'finish_design';
        const args =
          name === 'apply_operations'
            ? { operations: [{ type: 'arrange_furniture', roomIds: ['living'] }] }
            : {
                mode: 'apply',
                reply: 'Rearranged the seating and coffee table without changing the room.',
                assessment: {
                  requirements: [
                    {
                      id: 'placement',
                      request: 'Better furniture placement',
                      status: 'fulfilled',
                      evidence: 'Pieces fit and doorway is clear',
                      checks: [{ kind: 'furniture_layout', roomId: 'living' }],
                    },
                  ],
                  assumptions: [],
                },
              };
        return {
          calls: [
            {
              id: String(round),
              type: 'function',
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
          content: null,
          truncated: false,
          usage: { inputTokens: 0, outputTokens: 0, cost: 0 },
        };
      },
    },
  });
  assert.equal(result.needsConfirmation, false);
  assert.ok(result.scene);
  assert.deepEqual(architecture(result.scene).rooms, architecture(scene).rooms);
  assert.equal(result.assessment?.requirements[0].verification, 'geometry');
});

test('furniture replacement commits through shared services and survives disk reload, undo and redo', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'terrain-furniture-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new ProjectStore(directory);
  const project = await store.save({ ...newProject(), scene: fixture() });
  const service = new DesignService(store);
  const draft = await service.create(project.revision, project.scene, project.projectId);
  service.apply(draft.id, [
    { type: 'arrange_furniture', roomIds: ['living'] },
    {
      type: 'update_furniture',
      roomId: 'living',
      furnitureId: 'table',
      patch: {
        kind: 'dining-table',
        name: 'Dining table',
        width: 1.8,
        depth: 0.9,
        height: 0.76,
        palette: 'cedar',
      },
    },
  ]);
  assert.deepEqual(await store.read(), project, 'Draft operations must not save early.');
  const { project: committed } = await service.commit(draft.id, project.revision, false);
  const restarted = new ProjectStore(directory);
  assert.deepEqual(await restarted.read(), committed);
  assert.equal(committed.past.length, 1);
  const table = roomFurniture(committed.scene.rooms[0]).find((item) => item.id === 'table')!;
  assert.deepEqual(
    [table.kind, table.width, table.depth, table.height, table.palette],
    ['dining-table', 1.8, 0.9, 0.76, 'cedar'],
  );
  const undone = await restarted.save(undo(committed), committed.revision);
  assert.deepEqual(undone.scene, project.scene);
  const redone = await restarted.save(redo(undone), undone.revision);
  assert.deepEqual((await new ProjectStore(directory).read()).scene, committed.scene);
  assert.deepEqual(redone.scene, committed.scene);
});
