import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Mesh, MeshBasicMaterial, Raycaster, Vector3, PerspectiveCamera } from 'three';
import { emptyScene, makeRoom, type Scene } from '../shared/model';
import { roofHeightAt, roofMaximumHeight } from '../shared/architecture';
import { renderCameraForScenes, renderRequestSchema } from '../shared/render';
import {
  wallPanels,
  wallTopProfile,
  roofPatches,
  terrainHeight,
  naturalGroundHeight,
} from '../src/renderGeometry';
import { slabGeometry, wallCapGeometry } from '../src/renderMeshes';
import { renderingBudget, visualSceneKey } from '../src/renderPerformance';
import { FloorPlanSvg } from '../src/SceneView';

test('multiple raised windows retain sills and a separate door stays open at floor level', () => {
  const room = makeRoom({
    id: 'cabin',
    width: 10,
    height: 3,
    north: 'solid',
    wallOpenings: [
      { id: 'left', side: 'north', kind: 'window', offset: -3, width: 1.6, height: 1.1, sill: 1 },
      { id: 'entry', side: 'north', kind: 'door', offset: 0, width: 1, height: 2.2, sill: 0 },
      { id: 'right', side: 'north', kind: 'window', offset: 3, width: 1.6, height: 1.1, sill: 1 },
    ],
  });
  const scene = { ...emptyScene, rooms: [room] };
  const panels = wallPanels(scene, room, 'north', false);
  const solid = (x: number, y: number) =>
    panels.some(
      (panel) =>
        Math.abs(x - panel.offset) < panel.width / 2 - 0.001 &&
        y > panel.bottom &&
        y < panel.bottom + panel.height,
    );
  for (const x of [-3, 3]) {
    assert.equal(solid(x, 0.5), true, 'sill wall is retained');
    assert.equal(solid(x, 1.5), false, 'window is a real aperture');
    assert.equal(solid(x, 2.6), true, 'lintel is retained');
  }
  assert.equal(solid(0, 0.5), false);
  assert.equal(solid(0, 2.6), true);
  const svg = renderToStaticMarkup(
    createElement(FloorPlanSvg, { house: scene, level: 0, selected: null, onSelect: () => {} }),
  );
  assert.equal((svg.match(/data-opening-kind="window"/g) ?? []).length, 2);
  assert.equal((svg.match(/data-opening-kind="door"/g) ?? []).length, 1);
});

test('roof shells have outward faces and remain thin above an accessible vaulted interior', () => {
  for (const style of ['single-pitch', 'pitched'] as const)
    for (const direction of ['north', 'south', 'east', 'west'] as const) {
      const room = makeRoom({
        id: 'r',
        x: 3,
        z: -2,
        width: 8,
        depth: 6,
        height: 2.7,
        roof: { style, pitch: 24, direction },
      });
      const scene = { ...emptyScene, rooms: [room] };
      const patches = roofPatches(scene, room);
      assert.equal(patches.length, style === 'pitched' ? 2 : 1);
      for (const rect of patches) {
        const top = (x: number, z: number) => roofHeightAt(scene, room, x, z) + 0.18;
        const bottom = (x: number, z: number) => roofHeightAt(scene, room, x, z);
        const geometry = slabGeometry(rect, [room.x, room.elevation, room.z], top, bottom);
        const mesh = new Mesh(geometry, new MeshBasicMaterial());
        mesh.position.set(room.x, room.elevation, room.z);
        mesh.updateMatrixWorld(true);
        const x = (rect.minX + rect.maxX) / 2,
          z = (rect.minZ + rect.maxZ) / 2;
        const upward = new Raycaster(new Vector3(x, 0, z), new Vector3(0, 1, 0)).intersectObject(
          mesh,
        );
        const downward = new Raycaster(
          new Vector3(x, 40, z),
          new Vector3(0, -1, 0),
        ).intersectObject(mesh);
        assert.ok(upward.length && downward.length, 'both sides of the closed shell are visible');
        assert.ok(Math.abs(upward[0].point.y - bottom(x, z)) < 1e-5);
        assert.ok(Math.abs(downward[0].point.y - top(x, z)) < 1e-5);
        assert.ok(upward[0].face!.normal.y < 0 && downward[0].face!.normal.y > 0);
        geometry.dispose();
        (mesh.material as MeshBasicMaterial).dispose();
      }
      for (const side of ['north', 'south', 'east', 'west'] as const) {
        const profile = wallTopProfile(scene, room, side);
        const geometry = wallCapGeometry(profile, room.height);
        if (profile.some(([, y]) => y > room.height + 0.001))
          assert.ok(geometry, 'sloping/gable wall top is filled');
        geometry?.dispose();
      }
    }
});

test('comparison framing preserves each room roof override including a tall mono-pitch high edge', () => {
  const scenes: Scene[] = [
    {
      ...emptyScene,
      roof: 'flat',
      rooms: [
        makeRoom({
          id: 'r',
          width: 12,
          depth: 10,
          roof: { style: 'single-pitch', pitch: 40, direction: 'north' },
        }),
      ],
    },
    {
      ...emptyScene,
      roof: 'pitched',
      roofPitch: 28,
      roofDirection: 'west',
      rooms: [makeRoom({ id: 'r', x: 20, width: 10, depth: 5 })],
    },
  ];
  const request = renderRequestSchema.parse({ view: 'exterior' });
  const framing = renderCameraForScenes(scenes, request);
  const camera = new PerspectiveCamera(framing.fov, 4 / 3, 0.1, 1500);
  camera.position.set(...framing.position);
  camera.lookAt(...framing.target);
  camera.updateMatrixWorld(true);
  for (const scene of scenes)
    for (const room of scene.rooms) {
      const point = new Vector3(room.x, roofMaximumHeight(scene, room) + 0.18, room.z).project(
        camera,
      );
      assert.ok(Math.abs(point.x) < 1 && Math.abs(point.y) < 1 && point.z < 1);
    }
});

test('adjoining coplanar roof shells meet at the shared edge without overlapping overhangs', () => {
  const lower = makeRoom({
    id: 'lower',
    width: 8,
    depth: 6,
    height: 3,
    roof: { style: 'single-pitch', pitch: 12, direction: 'north' },
  });
  const rear = makeRoom({
    id: 'rear',
    width: 8,
    depth: 4,
    z: -5,
    height: 3 + 6 * Math.tan((12 * Math.PI) / 180),
    roof: { style: 'single-pitch', pitch: 12, direction: 'north' },
  });
  const scene = { ...emptyScene, rooms: [lower, rear] };
  const lowerPatches = roofPatches(scene, lower),
    rearPatches = roofPatches(scene, rear);
  assert.ok(
    lowerPatches.every((rect) => rect.minZ >= -3),
    'front roof cannot overhang the rear room',
  );
  assert.ok(
    rearPatches.every((rect) => rect.maxZ <= -3),
    'rear roof cannot overhang the front room',
  );
  assert.ok(Math.abs(roofHeightAt(scene, lower, 0, -3) - roofHeightAt(scene, rear, 0, -3)) < 1e-8);
});

test('clerestory openings cut through the high wall beneath a mono-pitch roof', () => {
  const room = makeRoom({
    id: 'clerestory',
    width: 8,
    depth: 6,
    height: 3,
    roof: { style: 'single-pitch', pitch: 20, direction: 'east' },
  });
  const scene = { ...emptyScene, rooms: [room] };
  const opening = { offset: 0, width: 2, sill: 3.5, height: 1 };
  const geometry = wallCapGeometry(wallTopProfile(scene, room, 'east'), room.height, [opening])!;
  const mesh = new Mesh(geometry, new MeshBasicMaterial());
  mesh.updateMatrixWorld(true);
  const hit = (x: number, y: number) =>
    new Raycaster(new Vector3(x, y, 2), new Vector3(0, 0, -1)).intersectObject(mesh).length > 0;
  assert.equal(hit(0, 4), false, 'the high window is a genuine hole through the wall cap');
  assert.equal(hit(0, 3.25), true, 'its sill remains solid');
  assert.equal(hit(0, 4.8), true, 'its head remains solid');
  assert.equal(hit(1.5, 4), true, 'its jamb remains solid');
  geometry.dispose();
  (mesh.material as MeshBasicMaterial).dispose();
});

test('a stair-linked upper doorway is not drawn as a floor-level exit on the lower plan', () => {
  const lower = makeRoom({ id: 'low', width: 4, depth: 6, height: 7 });
  const upper = makeRoom({
    id: 'upper',
    width: 4,
    depth: 4,
    z: -5,
    elevation: 3,
    wallOpenings: [
      { id: 'landing', side: 'south', kind: 'door', offset: 0, width: 1.2, sill: 0, height: 2.2 },
    ],
  });
  const scene: Scene = {
    ...emptyScene,
    rooms: [lower, upper],
    stairs: [
      { id: 'flight', x: 0, z: -1.7, elevation: 0, rise: 3, width: 1, run: 3, rotation: 180 },
    ],
    design: {
      groups: [],
      connections: [],
      requirements: [],
      stairLinks: [{ stairId: 'flight', lowerRoomId: 'low', upperRoomId: 'upper' }],
    },
  };
  const plan = (level: number) =>
    renderToStaticMarkup(
      createElement(FloorPlanSvg, { house: scene, level, selected: null, onSelect: () => {} }),
    );
  assert.doesNotMatch(plan(0), /data-opening-kind="door"/);
  assert.match(plan(3), /data-opening-kind="door"/);
});

test('hillside excavation stays below floor slabs without raising distant terrain', () => {
  const room = makeRoom({ x: 0, z: -12, width: 8, depth: 6, elevation: 0 });
  const scene = { ...emptyScene, slope: 0.3, rooms: [room] };
  for (const x of [-4, 0, 4])
    for (const z of [-15, -12, -9]) assert.ok(terrainHeight(scene, x, z) <= -0.29999);
  assert.equal(terrainHeight(scene, 50, 50), naturalGroundHeight(50, 50, 0.3));
  assert.ok(
    terrainHeight(scene, 0, -16) < naturalGroundHeight(0, -16, 0.3),
    'excavation has a smooth apron',
  );
});

test('refinement pixel budget bounds high-DPI work and ignores nonvisual conversation changes', () => {
  for (const gpu of ['Intel Graphics', 'NVIDIA RTX 5070', 'llvmpipe'])
    for (const dpr of [1, 1.5, 2]) {
      const budget = renderingBudget(gpu, 3840, 2160, dpr);
      assert.ok(3840 * 2160 * dpr * dpr * budget.scale * budget.scale <= budget.maximumPixels + 1);
      assert.ok(budget.scale > 0 && budget.scale <= 1);
    }
  const scene = { ...emptyScene, rooms: [makeRoom({ id: 'r', name: 'Old name' })] };
  const renamed = structuredClone(scene);
  renamed.rooms[0].name = 'New name';
  assert.equal(visualSceneKey(scene, false), visualSceneKey(renamed, false));
  renamed.rooms[0].roof = { style: 'single-pitch', pitch: 15, direction: 'north' };
  assert.notEqual(visualSceneKey(scene, false), visualSceneKey(renamed, false));
});
