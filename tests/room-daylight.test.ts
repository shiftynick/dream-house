import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { emptyScene, makeRoom, type Scene } from '../shared/model';
import {
  roomDaylightField,
  roomDaylightPixels,
  roomDaylightFallback,
  roomIrradiance,
  applyRoomIrradiance,
} from '../src/roomDaylight';
import {
  wallFinishParts,
  wallFinishGeometry,
  wallSurfaceGeometry,
} from '../src/architecturalFinish';
import { interiorExposure, cameraContainment } from '../src/renderLighting';
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
const energy = (pixels: Float32Array) =>
  pixels.reduce((sum, value, index) => sum + (index % 4 === 3 ? 0 : value), 0);

test('opaque enclosure admits no procedural daylight in day or evening', () => {
  const room = sealed();
  const house: Scene = { ...emptyScene, roof: 'flat', rooms: [room] };
  for (const light of ['day', 'evening'] as const)
    assert.equal(energy(roomDaylightPixels(house, room, light)), 0);
  room.wallOpenings = [
    { id: 'window', side: 'east', offset: 0, width: 2, height: 1.6, sill: 0.9, kind: 'window' },
  ];
  const day = energy(roomDaylightPixels(house, room, 'day'));
  assert.ok(day > 1);
  assert.ok(day > energy(roomDaylightPixels(house, room, 'evening')));
  const field = roomDaylightField(house, 'day');
  assert.equal(field.firstHit(new THREE.Vector3(0, 1.5, 0), new THREE.Vector3(1, 0, 0)), null);
  assert.ok(field.firstHit(new THREE.Vector3(0, 1.5, 0), new THREE.Vector3(-1, 0, 0)));
});

test('neighbor windows light a connected room only through its real shared portal', () => {
  const room = sealed();
  const next = makeRoom({ ...sealed(), id: 'neighbor', x: 6, east: 'glass' });
  const house: Scene = { ...emptyScene, roof: 'flat', rooms: [room, next] };
  assert.equal(energy(roomDaylightPixels(house, room, 'day')), 0);
  room.wallOpenings = [
    { id: 'portal', side: 'east', offset: 0, width: 2, height: 2.4, sill: 0, kind: 'open' },
  ];
  assert.ok(energy(roomDaylightPixels(house, room, 'day')) > 1);
  const field = roomDaylightField(house, 'day');
  assert.equal(field.apertures.length, 4, 'the shared opening is not a second outdoor emitter');
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

test('room-owned diffuse SH reproduces uniform irradiance without an extra pi factor', () => {
  const sh = roomIrradiance(new Float32Array(128 * 64 * 4).fill(1));
  for (const normal of [
    new THREE.Vector3(0, 1, 0),
    new THREE.Vector3(1, 0, 0),
    new THREE.Vector3(0, 0, -1),
  ]) {
    const irradiance = sh.getIrradianceAt(normal, new THREE.Vector3());
    assert.ok(Math.abs(irradiance.x - Math.PI) < 0.004);
  }
});

test('shared-wall color belongs to the incident room, independent of room order', () => {
  const a = sealed(),
    b = makeRoom({ ...sealed(), id: 'b', x: 6, palette: 'charcoal' });
  a.palette = 'chalk';
  for (const rooms of [
    [a, b],
    [b, a],
  ]) {
    const field = roomDaylightField({ ...emptyScene, roof: 'flat', rooms }, 'day');
    const left = field.firstHit(new THREE.Vector3(0, 1, 0), new THREE.Vector3(1, 0, 0))!;
    const right = field.firstHit(new THREE.Vector3(6, 1, 0), new THREE.Vector3(-1, 0, 0))!;
    assert.ok(left.patch.color.r > right.patch.color.r * 2);
  }
});

test('clipped roofs omit phantom gable occluders above exposed flat patches', () => {
  const low = sealed();
  low.depth = 6;
  const upper = makeRoom({ ...sealed(), id: 'upper', width: 2, depth: 2, elevation: 3 });
  const field = roomDaylightField({ ...emptyScene, roof: 'pitched', rooms: [low, upper] }, 'day');
  const probe = new THREE.Vector3(0, 3.7, -3);
  assert.ok(!field.patches.some((p) => p.normal.z === 1 && p.distance === -3 && p.contains(probe)));
});

test('bounded fallback retains aperture light and all supported fields remain finite', () => {
  const room = sealed(),
    house: Scene = { ...emptyScene, roof: 'flat', rooms: [room] };
  assert.equal(roomDaylightFallback(house, room, roomDaylightField(house, 'day')), 0);
  room.east = 'glass';
  for (const light of ['day', 'golden', 'evening'] as const) {
    const field = roomDaylightField(house, light);
    assert.ok(roomDaylightFallback(house, room, field) > 0);
    assert.ok(roomDaylightPixels(house, room, light, field).every(Number.isFinite));
    const oversized = { ...field, patches: Array(513).fill(field.patches[0]) };
    assert.equal(energy(roomDaylightPixels(house, room, light, oversized)), 0);
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
  assert.equal(interiorExposure(house, new THREE.Vector3(10, 1.6, 0)), 1.05);
  assert.equal(interiorExposure(house, new THREE.Vector3(0, 1.6, 0)), 2.1);
  const near = interiorExposure(house, new THREE.Vector3(2.99, 1.6, 0));
  assert.ok(near >= 1.05 && near < 1.06);
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
    assert.equal(interiorExposure(house, new THREE.Vector3(x, 1.6, 0)), 2.1);
  assert.ok(interiorExposure(house, new THREE.Vector3(8.99, 1.6, 0)) < 1.06);
  const gap: Scene = { ...house, rooms: [room, { ...next, x: 7 }] };
  assert.equal(interiorExposure(gap, new THREE.Vector3(3.5, 1.6, 0)), 1.05);
  const terrace: Scene = { ...house, rooms: [room, { ...next, kind: 'terrace' }] };
  assert.equal(interiorExposure(terrace, new THREE.Vector3(3.1, 1.6, 0)), 1.05);
});

test('exposure and tall casings follow actual flat clipped roofs below nominal gables', () => {
  const room = sealed();
  room.depth = 6;
  room.wallOpenings = [
    { id: 'tall', side: 'south', offset: 0, width: 2, height: 4, sill: 0, kind: 'window' },
  ];
  const upper = makeRoom({ ...sealed(), id: 'upper', width: 2, depth: 2, elevation: 3 });
  const house: Scene = { ...emptyScene, roof: 'pitched', rooms: [room, upper] };
  assert.equal(interiorExposure(house, new THREE.Vector3(0, 3.2, 2)), 1.05);
  assert.equal(interiorExposure(house, new THREE.Vector3(0, 1.6, 2)), 2.1);
  for (const part of wallFinishParts(house, room, 'south'))
    assert.ok(part.position[1] + part.size[1] / 2 <= room.height);
  const gable: Scene = { ...house, rooms: [room] };
  assert.ok(interiorExposure(gable, new THREE.Vector3(0, 3.2, 2)) > 1.05);
});

test('missing SH shader hooks retain the assigned local PMREM without injecting broken GLSL', () => {
  const material = new THREE.MeshStandardMaterial();
  const local = new THREE.Texture();
  material.envMap = local;
  applyRoomIrradiance(material, new THREE.SphericalHarmonics3());
  const compile = (fragmentShader: string) => {
    const shader = { fragmentShader, uniforms: {} } as Parameters<
      typeof material.onBeforeCompile
    >[0];
    material.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
    return shader;
  };
  const standard = '#include <lights_pars_begin>\n#include <lights_fragment_maps>';
  assert.ok(compile(standard).fragmentShader.includes('roomIrradianceIntensity'));
  for (const incomplete of ['#include <lights_fragment_maps>', '#include <lights_pars_begin>']) {
    const shader = compile(incomplete);
    assert.equal(shader.fragmentShader, incomplete);
    assert.deepEqual(shader.uniforms, {});
    assert.equal(material.envMap, local);
  }
  const original = THREE.ShaderChunk.lights_pars_begin;
  try {
    THREE.ShaderChunk.lights_pars_begin = '';
    assert.equal(compile(standard).fragmentShader, standard);
  } finally {
    THREE.ShaderChunk.lights_pars_begin = original;
  }
  material.dispose();
  local.dispose();
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
