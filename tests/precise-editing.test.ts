import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  emptyScene,
  makeRoom,
  newProject,
  editProject,
  undo,
  type Room,
  type Scene,
} from '../shared/model';
import { makeFurniture, roomFurniture } from '../shared/furniture';
import { executeCommands, roomOpenings, circulationEdges } from '../shared/design';
import { validSelection, selectionLabel } from '../shared/selection';
import { FurniturePlanGesture, furniturePlanError, planPoint } from '../src/planFurnitureGesture';
import { FloorPlanSvg } from '../src/SceneView';
import { SelectedOpeningControls, selectedOpeningPatch } from '../src/SelectedOpeningControls';
import { wallPanels } from '../src/renderGeometry';

const room = (patch: Partial<Room> = {}) =>
  makeRoom({
    id: 'a',
    width: 8,
    depth: 6,
    height: 3,
    north: 'solid',
    south: 'solid',
    east: 'solid',
    west: 'solid',
    furniture: [],
    ...patch,
  });
const house = (...rooms: Room[]): Scene => ({ ...structuredClone(emptyScene), rooms });
const windows = () => [
  {
    id: 'left',
    side: 'south' as const,
    kind: 'window' as const,
    offset: -2,
    width: 1,
    height: 1,
    sill: 1,
  },
  {
    id: 'right',
    side: 'south' as const,
    kind: 'window' as const,
    offset: 2,
    width: 1,
    height: 1,
    sill: 1,
  },
];
function apply(scene: Scene, commands: unknown[]) {
  const result = executeCommands(scene, commands);
  assert.equal(result.applied, true, JSON.stringify(result.issues));
  assert.deepEqual(
    result.issues.filter((issue) => issue.severity === 'error'),
    [],
  );
  return result.scene;
}
function reject(scene: Scene, commands: unknown[], code: string) {
  const before = structuredClone(scene),
    result = executeCommands(scene, commands);
  assert.equal(result.applied, false);
  assert.equal(result.issues[0].code, code);
  assert.deepEqual(result.scene, before);
  assert.deepEqual(scene, before);
  assert.deepEqual(result.changes, []);
}

test('one explicit opening edit preserves sibling bytes, walls and materials; removal removes only its ID', () => {
  const a = room({ surfacePalettes: { south: 'cedar' }, wallOpenings: windows() });
  const source = house(a);
  const next = apply(source, [
    {
      type: 'update_opening',
      roomId: 'a',
      side: 'south',
      openingId: 'left',
      patch: { offset: -1.8, width: 1.2, sill: 0.8 },
    },
  ]);
  assert.deepEqual(next.rooms[0].wallOpenings![1], a.wallOpenings![1]);
  assert.deepEqual(next.rooms[0].surfacePalettes, a.surfacePalettes);
  assert.equal(next.rooms[0].south, a.south);
  const removed = apply(next, [
    { type: 'remove_opening', roomId: 'a', side: 'south', openingId: 'left' },
  ]);
  assert.deepEqual(removed.rooms[0].wallOpenings, [a.wallOpenings![1]]);
});

test('mirrored selected-face coordinates update the actual owner without adopting or duplicating its opening', () => {
  const a = room({
    width: 8,
    depth: 4,
    wallOpenings: [
      { id: 'shared', side: 'south', kind: 'window', offset: 1, width: 1, height: 0.7, sill: 1.3 },
    ],
  });
  const b = room({ id: 'b', width: 4, depth: 4, x: 1, z: 4, elevation: 0.5, height: 3 });
  const source = house(a, b);
  const next = apply(source, [
    {
      type: 'update_opening',
      roomId: 'b',
      side: 'north',
      openingId: 'shared',
      patch: { offset: 0.4, sill: 1, width: 1.1 },
    },
  ]);
  assert.equal(next.rooms[0].wallOpenings![0].offset, 1.4);
  assert.equal(next.rooms[0].wallOpenings![0].sill, 1.5);
  assert.equal(next.rooms[1].wallOpenings, undefined);
  assert.equal(roomOpenings(next, 'b', 'north')[0].offset, 0.4);
  assert.equal(roomOpenings(next, 'b', 'north')[0].sill, 1);
  assert.deepEqual(next.rooms[1], b);
});

test('opening moves atomically reject entering or leaving a last-aperture legacy receiver fallback', () => {
  for (const flag of ['open', 'door', 'glass'] as const)
    for (const entering of [false, true]) {
      const a = room({
        x: 0,
        z: 0,
        width: 8,
        depth: 4,
        wallOpenings: [{ ...windows()[0], id: 'w', offset: entering ? 2 : -2 }],
      });
      const b = room({ id: 'b', x: -4, z: 4, width: 8, depth: 4, north: flag });
      const source = house(a, b);
      const beforePanels = wallPanels(source, b, 'north');
      assert.equal(roomOpenings(source, 'b', 'north').length, entering ? 0 : 1);
      // This exact open-wall exit previously removed all four panels, including
      // the unrelated exterior stretch x=[-8,-4] beyond the shared boundary.
      if (flag === 'open' && !entering) {
        assert.equal(wallPanels(source, b, 'north', false).length, 4);
        assert.deepEqual(beforePanels, [{ offset: -2, width: 4, bottom: 0, height: 3 }]);
      }
      reject(
        source,
        [
          {
            type: 'update_opening',
            roomId: 'a',
            side: 'south',
            openingId: 'w',
            patch: { offset: entering ? -2 : 2 },
          },
        ],
        'opening_mirror_transition',
      );
      assert.deepEqual(wallPanels(source, b, 'north'), beforePanels);
      assert.equal(b.north, flag);
    }
});

test('opening mirror changes remain supported on solid receivers and with a surviving sibling', () => {
  for (const entering of [false, true]) {
    const a = room({
      width: 8,
      depth: 4,
      wallOpenings: [{ ...windows()[0], id: 'w', offset: entering ? 2 : -2 }],
    });
    const b = room({ id: 'b', x: -4, z: 4, width: 8, depth: 4 });
    const next = apply(house(a, b), [
      {
        type: 'update_opening',
        roomId: 'a',
        side: 'south',
        openingId: 'w',
        patch: { offset: entering ? -2 : 2 },
      },
    ]);
    assert.equal(roomOpenings(next, 'b', 'north').length, entering ? 1 : 0);
    assert.deepEqual(next.rooms[1], b);
  }
  const sibling = { ...windows()[0], id: 'sibling', side: 'north' as const, offset: -2 };
  const a = room({ width: 8, depth: 4, wallOpenings: [{ ...windows()[0], id: 'w' }] });
  const b = room({
    id: 'b',
    x: -4,
    z: 4,
    width: 8,
    depth: 4,
    north: 'open',
    wallOpenings: [sibling],
  });
  const next = apply(house(a, b), [
    { type: 'update_opening', roomId: 'a', side: 'south', openingId: 'w', patch: { offset: 2 } },
  ]);
  assert.deepEqual(next.rooms[1], b);
  assert.deepEqual(
    roomOpenings(next, 'b', 'north').map((item) => item.id),
    ['sibling'],
  );
});

test('semantic passage edits retain IDs and flags, update both faces, and retain other passages on removal', () => {
  const a = room({ width: 4, depth: 6 }),
    b = room({ id: 'b', x: 4, width: 4, depth: 6 });
  let source = apply(house(a, b), [
    {
      type: 'connect_rooms',
      roomAId: 'a',
      roomBId: 'b',
      connectionId: 'one',
      center: -1.5,
      width: 1,
      height: 2.2,
      kind: 'door',
    },
    {
      type: 'connect_rooms',
      roomAId: 'a',
      roomBId: 'b',
      connectionId: 'two',
      center: 1.5,
      width: 1,
      height: 2.2,
      kind: 'door',
    },
  ]);
  const other = structuredClone(source.design!.connections[1]);
  const next = apply(source, [
    {
      type: 'update_opening',
      roomId: 'b',
      side: 'west',
      openingId: 'one',
      patch: { offset: -1.3, width: 0.9, kind: 'open' },
    },
  ]);
  assert.deepEqual(next.design!.connections[1], other);
  assert.equal(next.design!.connections[0].center, -1.3);
  assert.equal(next.design!.connections[0].height, 3);
  assert.equal(next.rooms[0].east, source.rooms[0].east);
  assert.equal(next.rooms[1].west, source.rooms[1].west);
  assert.equal(roomOpenings(next, 'a', 'east')[0].kind, 'open');
  source = apply(next, [{ type: 'remove_opening', roomId: 'b', side: 'west', openingId: 'one' }]);
  assert.deepEqual(source.design!.connections, [other]);
  assert.deepEqual(circulationEdges(source), [['a', 'b']]);
  reject(
    source,
    [{ type: 'remove_opening', roomId: 'b', side: 'west', openingId: 'two' }],
    'opening_edit_invalid',
  );
  assert.deepEqual(
    circulationEdges(source),
    [['a', 'b']],
    'the last route survives the rejected deletion',
  );
});

test('removing a last explicit aperture closes glass/open legacy fallbacks on both affected faces', () => {
  const a = room({
    width: 4,
    depth: 4,
    east: 'glass',
    wallOpenings: [
      { id: 'window', side: 'east', kind: 'window', offset: 0, width: 1, height: 1, sill: 1 },
    ],
  });
  const b = room({ id: 'b', width: 4, depth: 4, x: 4, west: 'open' });
  const next = apply(house(a, b), [
    { type: 'remove_opening', roomId: 'b', side: 'west', openingId: 'window' },
  ]);
  assert.equal(next.rooms[0].east, 'solid');
  assert.equal(next.rooms[1].west, 'solid');
  assert.equal(next.rooms[0].wallOpenings, undefined);
  assert.equal(next.rooms[0].south, 'solid');
});

test('invalid, stale, overlapping and locked individual opening edits atomically preserve the scene', () => {
  const source = house(room({ wallOpenings: windows() }));
  reject(
    source,
    [
      {
        type: 'update_opening',
        roomId: 'a',
        side: 'south',
        openingId: 'left',
        patch: { offset: 8 },
      },
    ],
    'opening_edit_invalid',
  );
  reject(
    source,
    [
      {
        type: 'update_opening',
        roomId: 'a',
        side: 'south',
        openingId: 'left',
        patch: { offset: 2 },
      },
    ],
    'opening_edit_invalid',
  );
  reject(
    source,
    [{ type: 'remove_opening', roomId: 'a', side: 'north', openingId: 'left' }],
    'opening_not_found',
  );
  const locked = apply(source, [
    {
      type: 'set_requirement',
      requirement: {
        id: 'lock',
        kind: 'locked',
        source: 'confirmed',
        description: 'Keep all openings',
        roomId: 'a',
        properties: ['openings'],
      },
    },
  ]);
  reject(
    locked,
    [
      {
        type: 'update_opening',
        roomId: 'a',
        side: 'south',
        openingId: 'left',
        patch: { width: 1.1 },
      },
    ],
    'opening_edit_invalid',
  );
  reject(
    locked,
    [{ type: 'remove_opening', roomId: 'a', side: 'south', openingId: 'left' }],
    'opening_edit_invalid',
  );
});

test('semantic passage cannot become a window, rise off the floor or choose an independent open height', () => {
  const source = apply(house(room({ width: 4 }), room({ id: 'b', x: 4, width: 4 })), [
    { type: 'connect_rooms', roomAId: 'a', roomBId: 'b', connectionId: 'door' },
  ]);
  for (const patch of [{ kind: 'window' }, { sill: 1 }])
    reject(
      source,
      [{ type: 'update_opening', roomId: 'a', side: 'east', openingId: 'door', patch }],
      'semantic_opening_kind',
    );
  reject(
    source,
    [
      {
        type: 'update_opening',
        roomId: 'a',
        side: 'east',
        openingId: 'door',
        patch: { kind: 'open', height: 2.2 },
      },
    ],
    'semantic_opening_height',
  );
});

test('taller-room controls omit derived height when turning a semantic door into an open passage', () => {
  const source = apply(
    house(room({ width: 4, height: 3 }), room({ id: 'b', x: 4, width: 4, height: 4 })),
    [
      {
        type: 'connect_rooms',
        roomAId: 'a',
        roomBId: 'b',
        connectionId: 'door',
        kind: 'door',
        width: 1,
        height: 2.2,
      },
    ],
  );
  const original = { kind: 'door' as const, offset: 0, width: 1, height: 2.2, sill: 0 };
  const patch = selectedOpeningPatch(original, { ...original, kind: 'open', height: 4 }, true);
  assert.deepEqual(patch, { kind: 'open' });
  const next = apply(source, [
    { type: 'update_opening', roomId: 'b', side: 'west', openingId: 'door', patch },
  ]);
  assert.equal(next.design!.connections[0].height, 3);
  assert.equal(next.design!.connections[0].kind, 'open');
});

test('opening selection resolves either shared face, rejects contradictory/stale targets and labels the chosen aperture', () => {
  const source = house(room({ wallOpenings: windows() }));
  const selection = { roomId: 'a', surface: 'south' as const, openingId: 'left' };
  assert.deepEqual(validSelection(source, selection), selection);
  assert.match(selectionLabel(source, selection), /south window/);
  for (const patch of [
    { surface: 'floor' },
    { furnitureId: 'sofa' },
    { openingId: 'gone' },
    { surface: 'north' },
  ])
    assert.equal(validSelection(source, { ...selection, ...patch }), null);
  const shared = apply(house(room({ width: 4 }), room({ id: 'b', x: 4, width: 4 })), [
    { type: 'connect_rooms', roomAId: 'a', roomBId: 'b', connectionId: 'shared' },
  ]);
  assert.ok(validSelection(shared, { roomId: 'b', surface: 'west', openingId: 'shared' }));
});

test('responsive plan coordinate conversion uses the full SVG screen matrix', () => {
  assert.deepEqual(planPoint(190, 270, { a: 10, b: 0, c: 0, d: 10, e: 150, f: 200 }), {
    x: 4,
    z: 7,
  });
  assert.deepEqual(planPoint(20, 30, { a: 0, b: 2, c: -2, d: 0, e: 24, f: 24 }), { x: 3, z: 2 });
  assert.throws(() => planPoint(1, 1, { a: 0, b: 0, c: 0, d: 0, e: 0, f: 0 }), /not ready/);
});

test('hundreds of drag preview updates create one history entry on a consumed finish', () => {
  const a = room({
    x: 10,
    z: -4,
    furniture: [makeFurniture('chair', 'chair', { x: 0.2, z: -0.1 })],
  });
  const source = house(a),
    original = structuredClone(source),
    gesture = new FurniturePlanGesture();
  gesture.begin(a, a.furniture![0], { x: 10.2, z: -4.1 }, 'move');
  for (let i = 0; i <= 200; i++) gesture.update({ x: 10.2 + i / 200, z: -4.1 + i / 400 });
  assert.deepEqual(source, original);
  const result = gesture.finish();
  assert.ok(result.command);
  assert.deepEqual(gesture.finish(), {});
  const project = editProject({ ...newProject(), scene: source }, apply(source, [result.command]));
  assert.equal(project.past.length, 1);
  assert.equal(project.scene.rooms[0].furniture![0].x, 1.2);
  assert.equal(project.scene.rooms[0].furniture![0].z, 0.4);
  assert.deepEqual(undo(project).scene, source);
});

test('click, cancellation and out-of-bounds release never materialize legacy furniture or create a command', () => {
  const a = room({ kind: 'bedroom', furniture: undefined }),
    item = roomFurniture(a)[0],
    gesture = new FurniturePlanGesture();
  gesture.begin(a, { ...item, x: 0.12345 }, { x: 1, z: 1 }, 'move');
  gesture.update({ x: 1, z: 1 });
  assert.deepEqual(gesture.finish(), {});
  gesture.begin(a, item, { x: 0, z: 0 }, 'move');
  gesture.update({ x: 1, z: 1 });
  gesture.cancel();
  assert.deepEqual(gesture.finish(), {});
  gesture.begin(a, item, { x: 0, z: 0 }, 'move');
  gesture.update({ x: 100, z: 0 });
  const invalid = gesture.finish();
  assert.match(invalid.error!, /outside/);
  assert.equal(invalid.command, undefined);
  assert.equal(a.furniture, undefined);
  gesture.begin(a, item, { x: 0, z: 0 }, 'move');
  gesture.update({ x: 0.5, z: 0 });
  const next = apply(house(a), [gesture.finish().command!]);
  assert.ok(next.rooms[0].furniture);
  assert.equal(a.furniture, undefined);
});

test('rotation follows saved yaw, supports 15-degree snapping and validates rotated bounds including rugs', () => {
  const a = room(),
    item = makeFurniture('chair', 'chair'),
    gesture = new FurniturePlanGesture();
  gesture.begin(a, item, { x: 0, z: -1 }, 'rotate');
  const preview = gesture.update({ x: 1, z: 0 })!;
  assert.equal(preview.rotation, -90);
  assert.equal((gesture.finish().command as { patch: { rotation: number } }).patch.rotation, -90);
  gesture.begin(a, item, { x: 0, z: -1 }, 'rotate');
  assert.equal(
    gesture.update({ x: Math.sin(Math.PI / 7), z: -Math.cos(Math.PI / 7) }, true)!.rotation,
    -30,
  );
  assert.match(
    furniturePlanError(
      room({ width: 2, depth: 2 }),
      makeFurniture('rug', 'rug', { width: 2, depth: 2, rotation: 45 }),
    )!,
    /outside/,
  );
});

test('plan and focused controls expose stable opening IDs and an accessible furniture rotation handle', () => {
  const a = room({ wallOpenings: windows(), furniture: [makeFurniture('chair', 'chair')] }),
    source = house(a);
  const plan = renderToStaticMarkup(
    createElement(FloorPlanSvg, {
      house: source,
      selected: 'a',
      selection: { roomId: 'a', surface: 'room', furnitureId: 'chair' },
      onSelect: () => {},
      onSelectSurface: () => {},
      onApplyFurniture: () => true,
      level: 0,
    }),
  );
  assert.match(plan, /data-opening-id="left"/);
  assert.match(plan, /Select New room south window left/);
  assert.match(plan, /aria-label="Rotate Chair"/);
  const controls = renderToStaticMarkup(
    createElement(SelectedOpeningControls, {
      scene: source,
      room: a,
      selectedSide: 'south',
      selectedId: 'left',
      disabled: false,
      onSelect: () => {},
      onApply: () => true,
    }),
  );
  assert.match(controls, /Selected opening width/);
  assert.match(controls, /Apply selected opening/);
  assert.match(controls, /Only this opening changes/);
});
