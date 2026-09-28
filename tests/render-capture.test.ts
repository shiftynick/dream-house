import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PerspectiveCamera, Vector3 } from 'three';
import { emptyScene, makeRoom, type Scene } from '../shared/model';
import {
  renderCamera,
  renderCameraForScenes,
  renderFloor,
  renderRequestSchema,
} from '../shared/render';
import {
  designSelectionSchema,
  selectionLabel,
  surfacePalette,
  validSelection,
} from '../shared/selection';
import { FloorPlanSvg } from '../src/SceneView';
import { planWallHitTarget } from '../src/renderGeometry';

test('render contracts supply bounded defaults and reject missing interior targets', () => {
  assert.deepEqual(renderRequestSchema.parse({ view: 'exterior' }), {
    view: 'exterior',
    angle: 'southeast',
    quality: 'live',
    light: 'day',
  });
  assert.throws(() => renderRequestSchema.parse({ view: 'interior' }), /roomId/);
  assert.throws(() =>
    renderRequestSchema.parse({
      view: 'exterior',
      camera: { position: [501, 0, 0], target: [0, 0, 0] },
    }),
  );
  assert.throws(() =>
    renderRequestSchema.parse({
      view: 'exterior',
      camera: { position: [0, 0, 0], target: [0, 0, 0] },
    }),
  );
  assert.throws(() => renderRequestSchema.parse({ view: 'exterior', url: 'https://example.com' }));
});

test('exterior presets fit all room corners and a tall chimney from every angle', () => {
  const scene: Scene = {
    ...emptyScene,
    roof: 'pitched',
    rooms: [
      makeRoom({ id: 'a', x: -24, z: 13, width: 30, depth: 4, height: 6 }),
      makeRoom({ id: 'b', x: 28, z: -19, width: 8, depth: 20, elevation: 5, height: 7 }),
    ],
    fireplace: { x: 2, z: 0, elevation: 0, height: 16 },
  };
  const original = structuredClone(scene);
  for (const angle of ['southeast', 'southwest', 'northeast', 'northwest'] as const) {
    for (const aspect of [4 / 3, 0.6]) {
      const request = renderRequestSchema.parse({ view: 'exterior', angle });
      const framing = renderCamera(scene, request, aspect);
      assert.deepEqual(renderCamera(scene, request, aspect), framing);
      const camera = new PerspectiveCamera(framing.fov, aspect, 0.1, 1500);
      camera.position.set(...framing.position);
      camera.lookAt(...framing.target);
      camera.updateMatrixWorld(true);
      const points = scene.rooms.flatMap((room) =>
        [-1, 1].flatMap((x) =>
          [-1, 1].flatMap((z) =>
            [room.elevation - 0.7, room.elevation + room.height + 2.5].map(
              (y) =>
                new Vector3(
                  room.x + x * (room.width / 2 + 0.5),
                  y,
                  room.z + z * (room.depth / 2 + 0.5),
                ),
            ),
          ),
        ),
      );
      points.push(new Vector3(2, 16, 0));
      for (const point of points) {
        const ndc = point.project(camera);
        assert.ok(
          Math.abs(ndc.x) < 1 && Math.abs(ndc.y) < 1 && ndc.z > -1 && ndc.z < 1,
          `${angle} cropped a geometry corner`,
        );
      }
    }
  }
  assert.deepEqual(scene, original);
});

test('comparison overrides keep identical framing across materially different layouts', () => {
  const camera = {
    position: [34, 26, 38] as [number, number, number],
    target: [0, 1, 0] as [number, number, number],
  };
  const request = renderRequestSchema.parse({ view: 'cutaway', camera });
  const first = renderCamera({ ...emptyScene, rooms: [makeRoom({ width: 4 })] }, request);
  const second = renderCamera({ ...emptyScene, rooms: [makeRoom({ width: 20, x: 15 })] }, request);
  assert.deepEqual(first, second);
  first.position[0] = 100;
  assert.equal(camera.position[0], 34, 'framing does not mutate the shared comparison camera');
});

test('alternative framing includes every pitched roof, distant chimney, and stair', () => {
  const first: Scene = { ...emptyScene, rooms: [makeRoom({ id: 'house', x: -20, width: 5 })] };
  const second: Scene = {
    ...emptyScene,
    roof: 'pitched',
    rooms: [makeRoom({ id: 'house', x: 22, width: 18, height: 7 })],
    fireplace: { x: 50, z: -35, elevation: 5, height: 16 },
    stairs: [
      { id: 'stair', x: -52, z: 22, width: 2, run: 10, elevation: 2, rise: 5, rotation: 90 },
    ],
  };
  const original = structuredClone([first, second]);
  const request = renderRequestSchema.parse({ view: 'exterior', angle: 'northwest' });
  const common = renderCameraForScenes([first, second], request);
  const camera = new PerspectiveCamera(common.fov, 4 / 3, 0.1, 1500);
  camera.position.set(...common.position);
  camera.lookAt(...common.target);
  camera.updateMatrixWorld(true);
  for (const point of [
    [-22.5, 0, 0],
    [31, 9.5, 0],
    [51.2, 21, -35.8],
    [-57, 7, 23],
  ]) {
    const projected = new Vector3(...point).project(camera);
    assert.ok(
      Math.abs(projected.x) < 1 && Math.abs(projected.y) < 1 && projected.z > -1 && projected.z < 1,
    );
  }
  const locked = { ...request, camera: { position: common.position, target: common.target } };
  assert.deepEqual(renderCamera(first, locked), renderCamera(second, locked));
  assert.deepEqual([first, second], original);
});

test('interior framing starts inside the requested room and respects its floor elevation', () => {
  const room = makeRoom({ id: 'upper', x: 13, z: -8, width: 6, depth: 7, elevation: 4, height: 3 });
  const scene = { ...emptyScene, rooms: [room] };
  const camera = renderCamera(
    scene,
    renderRequestSchema.parse({ view: 'interior', roomId: 'upper', angle: 'northwest' }),
  );
  assert.ok(
    camera.position[0] > room.x - room.width / 2 && camera.position[0] < room.x + room.width / 2,
  );
  assert.ok(
    camera.position[2] > room.z - room.depth / 2 && camera.position[2] < room.z + room.depth / 2,
  );
  assert.ok(camera.position[1] > 4 && camera.position[1] < 7);
  assert.ok(camera.target[0] > camera.position[0] && camera.target[2] > camera.position[2]);
  assert.throws(
    () => renderCamera(scene, renderRequestSchema.parse({ view: 'interior', roomId: 'missing' })),
    /no longer exists/,
  );
});

test('plan requests select the actual specified floor without falling back to another level', () => {
  const scene = {
    ...emptyScene,
    rooms: [
      makeRoom({ id: 'low', name: 'Ground room', elevation: 3 }),
      makeRoom({ id: 'high', name: 'Upper room', elevation: 6 }),
    ],
  };
  assert.equal(renderFloor(scene, renderRequestSchema.parse({ view: 'plan' })), 3);
  assert.equal(renderFloor(scene, renderRequestSchema.parse({ view: 'plan', roomId: 'high' })), 6);
  assert.throws(
    () => renderFloor(scene, renderRequestSchema.parse({ view: 'plan', elevation: 0 })),
    /no floor/,
  );
  const svg = renderToStaticMarkup(
    createElement(FloorPlanSvg, { house: scene, level: 6, selected: null, onSelect: () => {} }),
  );
  assert.match(svg, /Upper room/);
  assert.doesNotMatch(svg, /Ground room/);
  assert.match(svg, /Floor plan at 6 meters/);
});

test('surface selections remain explicit and stale or nonexistent surfaces are rejected', () => {
  const scene = {
    ...emptyScene,
    rooms: [
      makeRoom({ id: 'room', name: 'Bedroom' }),
      makeRoom({ id: 'yard', name: 'Garden', kind: 'courtyard' }),
    ],
  };
  assert.deepEqual(validSelection(scene, { roomId: 'room', surface: 'north' }), {
    roomId: 'room',
    surface: 'north',
  });
  assert.equal(selectionLabel(scene, { roomId: 'room', surface: 'north' }), 'Bedroom · north wall');
  assert.equal(validSelection(scene, { roomId: 'deleted', surface: 'room' }), null);
  assert.equal(validSelection(scene, { roomId: 'yard', surface: 'roof' }), null);
  assert.equal(validSelection(scene, { roomId: 'yard', surface: 'floor' })?.surface, 'floor');
  assert.throws(() => designSelectionSchema.parse({ roomId: 'room', surface: 'ceiling' }));
});

test('surface finishes override room and house materials without changing adjacent surfaces', () => {
  const room = makeRoom({
    id: 'room',
    palette: 'cedar',
    surfacePalettes: { north: 'charcoal', floor: 'chalk' },
  });
  const scene = { ...emptyScene, rooms: [room] };
  assert.equal(surfacePalette(scene, room, 'north'), 'charcoal');
  assert.equal(surfacePalette(scene, room, 'floor'), 'chalk');
  assert.equal(surfacePalette(scene, room, 'south'), 'cedar');
  assert.equal(surfacePalette(scene, makeRoom({ id: 'plain' }), 'roof'), 'limestone');
  const svg = renderToStaticMarkup(
    createElement(FloorPlanSvg, {
      house: scene,
      level: 0,
      selected: 'room',
      selection: { roomId: 'room', surface: 'north' },
      onSelect: () => {},
      onSelectSurface: () => {},
    }),
  );
  assert.equal(
    (svg.match(/aria-label="Select New room north wall"/g) || []).length,
    1,
    'one keyboard target per wall, even for segmented openings',
  );
  assert.match(svg, /stroke="#c98a36"/);
  assert.match(svg, /fill="#d8cdb8"/, 'floor uses its own palette');
});

test('all plan wall buttons have nonzero interior hit areas, including doorway gaps', () => {
  const room = makeRoom({
    id: 'bath',
    name: 'Bathroom',
    x: 3,
    z: 5,
    width: 4,
    depth: 4,
    east: 'solid',
    west: 'door',
    north: 'glass',
    south: 'solid',
  });
  const scene = {
    ...emptyScene,
    rooms: [room],
    stairs: [{ id: 'stair', x: 5, z: 5, width: 1, run: 3, elevation: 0, rise: 3, rotation: 0 }],
  };
  for (const side of ['north', 'south', 'east', 'west'] as const) {
    const hit = planWallHitTarget(room, side);
    assert.ok(
      hit.maxX - hit.minX > 0 && hit.maxZ - hit.minZ > 0,
      `${side} must have a clickable area`,
    );
    assert.ok(hit.minX >= room.x - room.width / 2 && hit.maxX <= room.x + room.width / 2);
    assert.ok(hit.minZ >= room.z - room.depth / 2 && hit.maxZ <= room.z + room.depth / 2);
  }
  const svg = renderToStaticMarkup(
    createElement(FloorPlanSvg, {
      house: scene,
      level: 0,
      selected: null,
      onSelect: () => {},
      onSelectSurface: () => {},
    }),
  );
  for (const side of ['north', 'south', 'east', 'west']) {
    assert.match(
      svg,
      new RegExp(
        `aria-label="Select Bathroom ${side} wall"[^>]*><rect data-wall-hit-target="${side}"[^>]+fill="transparent" pointer-events="all"`,
      ),
    );
  }
  assert.match(
    svg,
    /<g pointer-events="none"><rect/,
    'decorative stair overlays cannot intercept wall/floor clicks',
  );
});
