import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  RoofControls,
  OpeningControls,
  roofControlState,
  openingControlEntries,
  availableOpeningSpace,
} from '../src/ArchitectureControls.tsx';
import { emptyScene, makeRoom, type Scene } from '../shared/model.ts';
import { effectiveRoof } from '../shared/architecture.ts';
import { circulationEdges, executeCommands, roomOpenings } from '../shared/design.ts';

test('house roof controls show the effective legacy gable pitch and slope axis', () => {
  const scene: Scene = {
    ...emptyScene,
    roof: 'pitched',
    rooms: [makeRoom({ id: 'room', width: 8 })],
  };
  const original = structuredClone(scene);
  const state = roofControlState(scene);
  assert.equal(state.pitch, effectiveRoof(scene, scene.rooms[0]).pitch);
  assert.equal(state.direction, 'east');
  assert.equal(state.mixed, false);
  const markup = renderToStaticMarkup(
    createElement(RoofControls, { scene, disabled: false, onApply: () => true }),
  );
  assert.match(markup, /value="23\.75"/);
  assert.match(markup, /value="east" selected=""/);
  assert.doesNotMatch(markup, /value="north" selected=""/);
  assert.deepEqual(scene, original, 'merely opening the controls never standardizes old roofs');
});

test('mixed legacy gable pitches are shown as mixed and need an explicit shared pitch', () => {
  const scene: Scene = {
    ...emptyScene,
    roof: 'pitched',
    rooms: [makeRoom({ id: 'small', width: 8 }), makeRoom({ id: 'wide', x: 20, width: 20 })],
  };
  const state = roofControlState(scene);
  assert.equal(state.pitch, null);
  assert.equal(state.mixed, true);
  assert.equal(state.direction, 'east');
  const markup = renderToStaticMarkup(
    createElement(RoofControls, { scene, disabled: false, onApply: () => true }),
  );
  assert.match(markup, /placeholder="Varies by room" value=""/);
  assert.match(markup, /Enter a pitch to set one house default/);
  assert.match(markup, /disabled="" type="submit">Apply roof/);
  scene.rooms[1].roof = { style: 'flat' };
  assert.equal(
    roofControlState(scene).mixed,
    false,
    'room overrides do not misrepresent the inheriting rooms',
  );
  scene.roofPitch = 15;
  scene.roofDirection = 'south';
  assert.deepEqual(roofControlState(scene), {
    style: 'pitched',
    pitch: 15,
    direction: 'south',
    legacy: false,
    mixed: false,
  });
});

test('adding a window through controls preserves a legacy door and its indoor route', () => {
  const west = makeRoom({ id: 'west', width: 6, depth: 6, east: 'door' });
  const east = makeRoom({ id: 'east', x: 6, width: 6, depth: 6, west: 'door' });
  const scene: Scene = { ...emptyScene, rooms: [west, east] };
  const entries = openingControlEntries(scene, west, 'east', 'promoted-door');
  assert.deepEqual(
    entries.map((opening) => [opening.kind, opening.width, opening.height, opening.sill]),
    [['door', 1.3, 2.4, 0]],
  );
  const gap = availableOpeningSpace(west.depth, entries);
  assert.ok(gap);
  const result = executeCommands(scene, [
    {
      type: 'set_wall_openings',
      roomId: west.id,
      side: 'east',
      openings: [...entries, { id: 'new-window', kind: 'window', ...gap, height: 1.2, sill: 1 }],
    },
  ]);
  assert.equal(result.applied, true);
  assert.deepEqual(
    result.issues.filter((issue) => issue.severity === 'error'),
    [],
  );
  assert.deepEqual(circulationEdges(result.scene), [['west', 'east']]);
  assert.equal(
    roomOpenings(result.scene, 'west', 'east').filter((opening) => opening.kind === 'door').length,
    1,
  );
});

test('full legacy glazing is editable and prevents creating an opening in occupied wall space', () => {
  const room = makeRoom({ id: 'main', width: 8, south: 'glass' });
  const scene: Scene = { ...emptyScene, rooms: [room] };
  const entries = openingControlEntries(scene, room, 'south', 'legacy-glazing');
  assert.equal(entries[0].kind, 'window');
  assert.equal(entries[0].width, 8);
  assert.equal(entries[0].height, room.height);
  assert.equal(availableOpeningSpace(8, entries), null);
  const markup = renderToStaticMarkup(
    createElement(OpeningControls, { scene, room, disabled: false, onApply: () => true }),
  );
  assert.match(markup, /Opening 1/);
  assert.match(markup, /No free wall space for another opening/);
});

test('connected passages stay separate from editable standalone entries', () => {
  const scene: Scene = {
    ...emptyScene,
    rooms: [makeRoom({ id: 'west', width: 6 }), makeRoom({ id: 'east', x: 6, width: 6 })],
  };
  const connected = executeCommands(scene, [
    { type: 'connect_rooms', roomAId: 'west', roomBId: 'east' },
  ]).scene;
  assert.deepEqual(openingControlEntries(connected, connected.rooms[0], 'east', 'unused'), []);
  assert.equal(
    roomOpenings(connected, 'west', 'east').length,
    1,
    'controls do not synthesize a duplicate centered legacy door',
  );
});
