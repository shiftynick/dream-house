import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { emptyScene, makeRoom, type Scene } from '../shared/model';
import {
  wallFinishParts,
  wallFinishGeometry,
  wallSurfaceGeometry,
} from '../src/architecturalFinish';
import { interiorExposure, cameraContainment, TONE_EXPOSURE } from '../src/renderLighting';
// Exposure outdoors and deep indoors without measured room luminance.
const OUTDOOR = TONE_EXPOSURE * 1.05,
  INDOOR = TONE_EXPOSURE * 2.1;
const near = (actual: number, expected: number) => Math.abs(actual - expected) < 1e-9;
import { interiorFaceGroups } from '../src/renderMeshes';
const sealed = () =>
  makeRoom({
    id: 'closed',
    width: 6,
    depth: 5,
    height: 3,
    north: 'solid',
    south: 'solid',
    east: 'solid',
    west: 'solid',
    wallOpenings: [],
  });

test('inside/outside wall grouping preserves triangles and face ownership', () => {
  for (const positive of [true, false]) {
    const geometry = interiorFaceGroups(new THREE.BoxGeometry(4, 3, 0.1), positive);
    assert.equal(geometry.index!.count, 36);
    assert.equal(geometry.groups.length, 2);
    assert.equal(geometry.groups[0].count, 6);
    for (let i = 0; i < 6; i++)
      assert.ok(
        geometry.getAttribute('normal').getZ(geometry.index!.getX(i)) * (positive ? 1 : -1) < -0.5,
      );
    geometry.dispose();
  }
});

test('finish trims stop at doors and floor windows and remain inside the wall span', () => {
  const room = sealed();
  room.wallOpenings = [
    { id: 'door', side: 'south', kind: 'door', offset: -1.5, width: 1, height: 2.3, sill: 0 },
    { id: 'glazing', side: 'south', kind: 'window', offset: 1, width: 2, height: 3, sill: 0 },
  ];
  const house: Scene = { ...emptyScene, roof: 'flat', rooms: [room] };
  const before = JSON.stringify(house),
    parts = wallFinishParts(house, room, 'south');
  for (const part of parts) {
    assert.ok(Math.abs(part.position[0]) + part.size[0] / 2 <= room.width / 2);
    assert.ok(part.position[1] + part.size[1] / 2 <= room.height);
    if (part.position[1] < 0.06)
      for (const opening of room.wallOpenings)
        assert.ok(
          part.position[0] + part.size[0] / 2 <= opening.offset - opening.width / 2 + 1e-5 ||
            part.position[0] - part.size[0] / 2 >= opening.offset + opening.width / 2 - 1e-5,
        );
  }
  const batches = wallFinishGeometry(house, room, 'south');
  assert.ok(batches.length <= 2);
  batches.forEach((part) => part.geometry.dispose());
  assert.equal(JSON.stringify(house), before);
});

test('camera exposure adapts smoothly indoors without changing exterior lighting', () => {
  const room = sealed(),
    house: Scene = { ...emptyScene, roof: 'flat', rooms: [room] };
  assert.ok(near(interiorExposure(house, new THREE.Vector3(10, 1.6, 0)), OUTDOOR));
  assert.ok(near(interiorExposure(house, new THREE.Vector3(0, 1.6, 0)), INDOOR));
  const edge = interiorExposure(house, new THREE.Vector3(2.99, 1.6, 0));
  assert.ok(edge >= OUTDOOR - 1e-9 && edge < OUTDOOR + 0.01);
});

test('internal shared doorways retain interior exposure on either side and at the seam', () => {
  const room = sealed();
  room.wallOpenings = [
    { id: 'portal', side: 'east', offset: 0, width: 2, height: 2.4, sill: 0, kind: 'open' },
  ];
  const next = makeRoom({ ...sealed(), id: 'neighbor', x: 6 });
  const house: Scene = { ...emptyScene, roof: 'flat', rooms: [room, next] };
  assert.equal(
    cameraContainment(house),
    cameraContainment(house),
    'containment clipping is cached per scene',
  );
  for (const x of [2.2, 2.8, 2.99, 3, 3.01, 3.2, 3.8])
    assert.ok(near(interiorExposure(house, new THREE.Vector3(x, 1.6, 0)), INDOOR));
  assert.ok(interiorExposure(house, new THREE.Vector3(8.99, 1.6, 0)) < OUTDOOR + 0.01);
  const gap: Scene = { ...house, rooms: [room, { ...next, x: 7 }] };
  assert.ok(near(interiorExposure(gap, new THREE.Vector3(3.5, 1.6, 0)), OUTDOOR));
  const terrace: Scene = { ...house, rooms: [room, { ...next, kind: 'terrace' }] };
  assert.ok(near(interiorExposure(terrace, new THREE.Vector3(3.1, 1.6, 0)), OUTDOOR));
});

test('exposure and tall casings follow actual flat clipped roofs below nominal gables', () => {
  const room = sealed();
  room.depth = 6;
  room.wallOpenings = [
    { id: 'tall', side: 'south', offset: 0, width: 2, height: 4, sill: 0, kind: 'window' },
  ];
  const upper = makeRoom({ ...sealed(), id: 'upper', width: 2, depth: 2, elevation: 3 });
  const house: Scene = { ...emptyScene, roof: 'pitched', rooms: [room, upper] };
  assert.ok(near(interiorExposure(house, new THREE.Vector3(0, 3.2, 2)), OUTDOOR));
  assert.ok(near(interiorExposure(house, new THREE.Vector3(0, 1.6, 2)), INDOOR));
  for (const part of wallFinishParts(house, room, 'south'))
    assert.ok(part.position[1] + part.size[1] / 2 <= room.height);
  const gable: Scene = { ...house, rooms: [room] };
  assert.ok(interiorExposure(gable, new THREE.Vector3(0, 3.2, 2)) > OUTDOOR + 0.01);
});

test('wall batching keeps all triangles, continuous wall UVs and inside/outside ownership', () => {
  const room = sealed();
  room.wallOpenings = [
    { id: 'one', side: 'south', offset: -1.5, width: 1, height: 1.6, sill: 0.9, kind: 'window' },
    { id: 'two', side: 'south', offset: 1.5, width: 1, height: 1.6, sill: 0.9, kind: 'window' },
  ];
  const house: Scene = { ...emptyScene, roof: 'flat', rooms: [room] };
  const batches = wallSurfaceGeometry(house, room, 'south');
  assert.equal(batches.length, 4);
  const frame = batches.find((part) => part.material === 'frame')!.geometry;
  assert.equal(frame.index!.count, 8 * 36, 'eight frame bars retain twelve triangles each');
  for (const { material, geometry } of batches) {
    assert.equal(geometry.groups.length, 2);
    assert.equal(
      geometry.groups.reduce((count, group) => count + group.count, 0),
      geometry.index!.count,
    );
    for (const group of geometry.groups) {
      for (let i = group.start; i < group.start + group.count; i += 3) {
        const index = geometry.index!.getX(i);
        assert.equal(geometry.getAttribute('normal').getZ(index) > 0.5, group.materialIndex === 0);
      }
    }
    if (material === 'wall') {
      const position = geometry.getAttribute('position'),
        normal = geometry.getAttribute('normal'),
        uv = geometry.getAttribute('uv');
      for (let i = 0; i < position.count; i++)
        if (Math.abs(normal.getZ(i)) > 0.5) {
          assert.equal(uv.getX(i), position.getX(i));
          assert.equal(uv.getY(i), position.getY(i));
        }
    }
    geometry.dispose();
  }
});
