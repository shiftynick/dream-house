import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { emptyScene, makeRoom, type Scene } from '../shared/model';
import {
  apertureIrradiance,
  cubeFacesToHarmonics,
  rectangleIntegral,
  RoomLighting,
  RoomProbeSystem,
  roomApertures,
  roomProbeVolume,
  skyHarmonics,
} from '../src/roomProbes';
import { exposureAt, INTERIOR_EXPOSURE, roomExposure } from '../src/renderLighting';

const sealed = (patch = {}) =>
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
    ...patch,
  });
const window = (side: 'north' | 'south' | 'east' | 'west', patch = {}) => ({
  id: `${side}-window`,
  side,
  kind: 'window' as const,
  offset: 0,
  width: 2,
  height: 1.5,
  sill: 0.9,
  ...patch,
});
const house = (...rooms: ReturnType<typeof sealed>[]): Scene => ({
  ...emptyScene,
  roof: 'flat',
  rooms,
});
const up = new THREE.Vector3(0, 1, 0);

test('a sealed room has no openings and receives no window light', () => {
  const room = sealed();
  const apertures = roomApertures(house(room), room);
  assert.equal(apertures.length, 0);
  for (const light of ['day', 'golden', 'evening'] as const)
    assert.equal(apertureIrradiance(apertures, light, new THREE.Vector3(0, 0.01, 0), up).r, 0);
});

test('the form factor matches Lambert for a tiny window and a whole hemisphere', () => {
  // A 0.1 m square 2 m straight ahead: F ≈ A / (π d²).
  const point = new THREE.Vector3(0, 0, 0),
    normal = new THREE.Vector3(0, 0, -1);
  const small = rectangleIntegral(
    point,
    normal,
    new THREE.Vector3(-0.05, -0.05, -2),
    new THREE.Vector3(0.1, 0, 0),
    0.1,
  );
  assert.ok(Math.abs(Math.abs(small) - 0.01 / (Math.PI * 4)) < 1e-5);
  // A huge rectangle just in front covers the hemisphere: |F| → 1.
  const huge = rectangleIntegral(
    point,
    normal,
    new THREE.Vector3(-500, -500, -0.01),
    new THREE.Vector3(1000, 0, 0),
    1000,
  );
  assert.ok(Math.abs(Math.abs(huge) - 1) < 1e-3);
});

test('openings are wound toward the room and light only surfaces that face them', () => {
  const room = sealed({ wallOpenings: [window('south'), window('east')] });
  const apertures = roomApertures(house(room), room);
  assert.equal(apertures.length, 2);
  for (const aperture of apertures) {
    const middle = aperture.corner
      .clone()
      .addScaledVector(aperture.along, 0.5)
      .add(new THREE.Vector3(0, aperture.height / 2, 0));
    const inside = middle.clone().addScaledVector(aperture.outward, -1);
    assert.ok(
      rectangleIntegral(
        inside,
        aperture.outward,
        aperture.corner,
        aperture.along,
        aperture.height,
      ) > 0,
    );
  }
  const center = new THREE.Vector3(0, 1.5, 0);
  const south = apertureIrradiance(apertures, 'day', center, new THREE.Vector3(0, 0, 1));
  const north = apertureIrradiance(apertures, 'day', center, new THREE.Vector3(0, 0, -1));
  const west = apertureIrradiance(apertures, 'day', center, new THREE.Vector3(-1, 0, 0));
  assert.ok(south.r > 0 && north.r === 0 && west.r === 0);
  // Falloff: the floor is brighter near the window than across the room.
  const near = apertureIrradiance(apertures, 'day', new THREE.Vector3(0, 0, 2), up);
  const far = apertureIrradiance(apertures, 'day', new THREE.Vector3(0, 0, -2), up);
  assert.ok(near.r > far.r * 2);
});

test('surfaces below a window see sky; a ceiling above it sees only the ground', () => {
  const room = sealed({ wallOpenings: [window('south')] });
  const apertures = roomApertures(house(room), room);
  const floor = apertureIrradiance(apertures, 'day', new THREE.Vector3(0, 0, 1), up);
  const ceiling = apertureIrradiance(
    apertures,
    'day',
    new THREE.Vector3(0, 3, 1),
    new THREE.Vector3(0, -1, 0),
  );
  assert.ok(ceiling.r > 0, 'the ground outside lights the ceiling');
  assert.ok(floor.b > ceiling.b * 3, 'the floor sees the much brighter sky');
});

test('an opening into another enclosed room is a portal, not an outdoor window', () => {
  const portal = {
    id: 'portal',
    side: 'east' as const,
    kind: 'open' as const,
    offset: 0,
    width: 2,
    height: 2.4,
    sill: 0,
  };
  const a = sealed({ wallOpenings: [portal] });
  // The neighbour sees the same opening mirrored from its owner.
  const b = sealed({ id: 'next', x: 6 });
  const apertures = roomApertures(house(a, b), a);
  assert.equal(apertures.length, 1);
  assert.equal(apertures[0].neighbour, 'next');
  assert.equal(apertures[0].weight, 1);
  assert.equal(
    apertureIrradiance(apertures, 'day', new THREE.Vector3(2, 1, 0), new THREE.Vector3(1, 0, 0)).r,
    0,
  );
  // Without the neighbour the same opening looks outdoors.
  const alone = roomApertures(house(a), a);
  assert.equal(alone[0].neighbour, undefined);
});

test('the probe volume spans the room up to its roof and keeps the probe at eye height', () => {
  const room = sealed({ height: 2.6 });
  const { min, max, probe } = roomProbeVolume(
    { ...house(room), roof: 'pitched', roofPitch: 30 },
    room,
  );
  assert.deepEqual(min.toArray(), [-3, 0, -2.5]);
  assert.ok(max.y > 2.6, 'a gable roof raises the reflection box');
  assert.ok(probe.y > 1 && probe.y < 1.3);
});

test('cube faces project onto SH with the right orientation and scale', () => {
  const size = 8;
  const face = (value: number) => new Float32Array(size * size * 4).fill(value);
  const uniform = cubeFacesToHarmonics(
    Array.from({ length: 6 }, () => face(1)),
    size,
  );
  for (const normal of [up, new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, -1)])
    assert.ok(Math.abs(uniform.sh.getIrradianceAt(normal, new THREE.Vector3()).x - Math.PI) < 0.01);
  assert.ok(Math.abs(uniform.luminance - 1) < 1e-6);
  // Only the +Y face (index 2) is lit: upward normals receive it, downward do not.
  const sky = cubeFacesToHarmonics([0, 0, 1, 0, 0, 0].map(face), size);
  const above = sky.sh.getIrradianceAt(up, new THREE.Vector3()).x;
  const below = sky.sh.getIrradianceAt(new THREE.Vector3(0, -1, 0), new THREE.Vector3()).x;
  assert.ok(above > 1 && below < 0.1);
});

test('room lighting leaves materials untouched when Three lacks its shader hooks', () => {
  const room = sealed({ wallOpenings: [window('south')] });
  const lighting = new RoomLighting(house(room), room, 'day', 16);
  const material = new THREE.MeshStandardMaterial();
  lighting.apply(material);
  assert.equal(material.envMap, lighting.reflection.texture);
  const compile = (vertexShader: string, fragmentShader: string) => {
    const shader = { vertexShader, fragmentShader, uniforms: {} } as Parameters<
      typeof material.onBeforeCompile
    >[0];
    material.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
    return shader;
  };
  const vertex = '#include <worldpos_vertex>';
  const fragment =
    '#include <envmap_physical_pars_fragment>\n#include <lights_fragment_maps>\n#include <tonemapping_fragment>';
  const full = compile(vertex, fragment);
  assert.ok(full.fragmentShader.includes('roomBoxProject'));
  assert.ok(full.fragmentShader.includes('roomWindowIrradiance'));
  assert.ok(full.vertexShader.includes('vRoomWorldPosition'));
  for (const incomplete of [
    '#include <lights_fragment_maps>',
    '#include <envmap_physical_pars_fragment>',
  ]) {
    const shader = compile(vertex, incomplete);
    assert.equal(shader.fragmentShader, incomplete);
    assert.deepEqual(shader.uniforms, {});
  }
  material.dispose();
  lighting.dispose();
});

test('a new probe set queues bounce passes then reflections, and starts unconverged', () => {
  const a = sealed({ id: 'probe-a', wallOpenings: [window('south')] });
  const b = sealed({ id: 'probe-b', x: 6 });
  const scene = house(a, b);
  const system = new RoomProbeSystem(
    [a, b].map((room) => new RoomLighting(scene, room, 'day', 16)),
  );
  assert.ok(system.pending);
  assert.equal(system.queued, 3 * 2 + 2);
  assert.equal(system.converged, false);
  system.dispose();
});

test('exposure follows measured room luminance, bounded and continuous through a doorway', () => {
  assert.equal(roomExposure(undefined), INTERIOR_EXPOSURE);
  assert.ok(roomExposure(0.01) > roomExposure(0.05));
  assert.ok(roomExposure(1e-6) <= 4.5 && roomExposure(10) >= 1.6);
  const portal = {
    id: 'portal',
    side: 'east' as const,
    kind: 'open' as const,
    offset: 0,
    width: 2,
    height: 2.4,
    sill: 0,
  };
  const bright = sealed({ id: 'bright', wallOpenings: [portal] });
  const dim = sealed({ id: 'dim', x: 6 });
  const scene = house(bright, dim);
  const luminance = new Map([
    ['bright', 0.06],
    ['dim', 0.01],
  ]);
  const at = (x: number) => exposureAt(scene, new THREE.Vector3(x, 1.6, 0), luminance).interior;
  assert.ok(Math.abs(at(-1) - roomExposure(0.06)) < 1e-9);
  assert.ok(Math.abs(at(7) - roomExposure(0.01)) < 1e-9);
  let previous = at(1.5);
  for (let x = 1.6; x <= 4.5; x += 0.1) {
    const value = at(x);
    assert.ok(value >= previous - 1e-9 && value - previous < 0.25, `smooth at ${x.toFixed(1)}`);
    previous = value;
  }
});

test('local exposure lifts only dimmer rooms, and only when the camera is indoors', () => {
  const bright = sealed({ id: 'lit', wallOpenings: [window('south')] });
  const dim = sealed({ id: 'dim', x: 6 });
  const scene = house(bright, dim);
  const lightings = [bright, dim].map((room) => new RoomLighting(scene, room, 'day', 16));
  const system = new RoomProbeSystem(lightings);
  lightings[0].luminance = 0.06;
  lightings[1].luminance = 0.006;
  const gains = () => lightings.map((lighting) => lighting.uniforms.roomExposureGain.value);
  system.setCameraExposure(roomExposure(0.06), 1);
  const [litGain, dimGain] = gains();
  assert.equal(litGain, 1);
  assert.ok(dimGain > 1.2 && dimGain < roomExposure(0.006) / roomExposure(0.06));
  // Seen from the dim room the bright one is not darkened.
  system.setCameraExposure(roomExposure(0.006), 1);
  assert.deepEqual(gains(), [1, 1]);
  // Outdoors, interiors keep their physical level.
  system.setCameraExposure(roomExposure(0.06), 0);
  assert.deepEqual(gains(), [1, 1]);
  system.dispose();
});

test('sky harmonics light upward faces more than downward ones, for every light', () => {
  for (const light of ['day', 'golden', 'evening'] as const) {
    const sh = new THREE.SphericalHarmonics3();
    skyHarmonics(light).forEach((value, index) => sh.coefficients[index].copy(value));
    const upward = sh.getIrradianceAt(up, new THREE.Vector3());
    const downward = sh.getIrradianceAt(new THREE.Vector3(0, -1, 0), new THREE.Vector3());
    assert.ok(Number.isFinite(upward.x) && upward.z > downward.z, light);
  }
});
