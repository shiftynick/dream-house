import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import * as THREE from 'three';
import { emptyScene, makeRoom, type Scene } from '../shared/model.ts';
import {
  bandMap,
  fitOpeningKit,
  leafCount,
  openingIsExterior,
  openingKitGeometry,
  type OpeningKit,
  type OpeningKits,
} from '../src/renderOpenings.ts';
import type { AssetManifest } from '../src/renderAssets.ts';

/** A 1 x 2 m kit: a 0.1 m frame member on the left edge, a pane, and a 0.04 m handle. */
function box(lo: number[], hi: number[], axis = 2) {
  const size = hi.map((v, i) => v - lo[i]);
  const g = new THREE.BoxGeometry(size[0], size[1], size[2]).translate(
    ...(lo.map((v, i) => v + size[i] / 2) as [number, number, number]),
  );
  g.setAttribute('uv1', new THREE.BufferAttribute(new Float32Array(g.getAttribute('position').count * 2).fill(axis), 2));
  return g;
}
function kit(id: string): OpeningKit {
  return {
    asset: { id, url: '', opening: [1, 2], edges: [0.1, 0.1, 0.1, 0.1] },
    parts: [
      { geometry: box([-0.5, 0, -0.03], [-0.4, 2, 0.03]), role: 'frame', rigid: false },
      { geometry: box([-0.4, 0.1, -0.005], [0.4, 1.9, 0.005]), role: 'glass', rigid: false },
      { geometry: box([0.3, 0.98, 0.03], [0.34, 1.02, 0.07]), role: 'hardware', rigid: true },
    ],
  };
}
const kits = Object.fromEntries(
  ['window-casement', 'window-fixed', 'door-frame', 'door-leaf-panel', 'door-leaf-glazed'].map((id) => [id, kit(id)]),
) as OpeningKits;
const size = (geometry: THREE.BufferGeometry) => {
  geometry.computeBoundingBox();
  return geometry.boundingBox!.getSize(new THREE.Vector3());
};

test('bands keep their true size while the interior absorbs the opening size', () => {
  const map = bandMap(1, 3, 0.1, 0.1, -0.5);
  assert.ok(Math.abs(map(-0.5) + 1.5) < 1e-9 && Math.abs(map(-0.4) + 1.4) < 1e-9);
  assert.ok(Math.abs(map(0.5) - 1.5) < 1e-9 && Math.abs(map(0) - 0) < 1e-9);
  // Too small for both bands: uniform scale.
  assert.ok(Math.abs(bandMap(1, 0.15, 0.1, 0.1, -0.5)(0.5) - 0.075) < 1e-9);
});

test('frames stay true size, glass stretches and hardware keeps its exact size', () => {
  const [frame, glass, handle] = fitOpeningKit(kits['window-casement']!, 2.4, 3);
  assert.ok(Math.abs(size(frame.geometry).x - 0.1) < 1e-6, 'frame member width');
  assert.ok(Math.abs(size(frame.geometry).y - 3) < 1e-6, 'frame member length');
  assert.ok(Math.abs(size(glass.geometry).x - 2.2) < 1e-6);
  const hardware = size(handle.geometry);
  assert.ok(Math.abs(hardware.x - 0.04) < 1e-6 && Math.abs(hardware.y - 0.04) < 1e-6);
  // Meter UVs rebuilt on channel 0 for physical textures.
  const uv = glass.geometry.getAttribute('uv');
  let max = 0;
  for (let i = 0; i < uv.count; i++) max = Math.max(max, uv.getX(i));
  assert.ok(Math.abs(max - 1.1) < 1e-6);
  assert.equal(glass.geometry.getAttribute('uv1'), undefined);
});

test('door widths choose single, pair or multi-panel leaves', () => {
  assert.deepEqual([0.9, 1.2, 1.8, 2.6, 4.4, 40].map(leafCount), [1, 1, 2, 3, 4, 8]);
});

function house(): Scene {
  return {
    ...structuredClone(emptyScene),
    rooms: [
      makeRoom({ id: 'a', x: 0, z: 0, width: 6, depth: 5, north: 'solid', south: 'solid', east: 'solid', west: 'solid',
        wallOpenings: [
          { id: 'w', side: 'south', kind: 'window', offset: 0, width: 3.2, height: 2, sill: 0.8 },
          { id: 'front', side: 'north', kind: 'door', offset: 1, width: 1.8, height: 2.4, sill: 0 },
        ] }),
      makeRoom({ id: 'b', x: 6, z: 0, width: 6, depth: 5, north: 'solid', south: 'solid', east: 'solid', west: 'solid' }),
      makeRoom({ id: 't', kind: 'terrace', x: 0, z: 5, width: 6, depth: 5 }),
    ],
    design: {
      groups: [], stairLinks: [], requirements: [],
      connections: [
        { id: 'ab', roomAId: 'a', roomBId: 'b', sideA: 'east', center: 0, width: 0.9, height: 2.1, kind: 'door' },
        { id: 'at', roomAId: 'a', roomBId: 't', sideA: 'south', center: -2.2, width: 1, height: 2.1, kind: 'door' },
      ],
    },
  };
}

test('doors to the outside or terraces are exterior; doors between rooms are not', () => {
  const scene = house();
  const room = scene.rooms[0];
  const find = (side: 'north' | 'south' | 'east', id: string) =>
    openingIsExterior(scene, room, side, { ...room.wallOpenings!.find((o) => o.id === id) ?? {
      id, offset: 0, width: 1, height: 2.1, sill: 0, kind: 'door' as const }, source: id.length > 2 ? 'explicit' : 'connection', sourceRoomId: 'a' } as never);
  assert.equal(find('north', 'front'), true);
  assert.equal(find('east', 'ab'), false);
  assert.equal(find('south', 'at'), true);
});

test('a wall gets merged kit geometry per material, and a shared door leaf is drawn once', () => {
  const scene = house();
  const [a, b] = scene.rooms;
  const south = openingKitGeometry(scene, a, 'south', kits)!;
  assert.ok(south.some((part) => part.material === 'glass'));
  assert.ok(south.every((part) => part.geometry.groups.length >= 1));
  const count = (room: typeof a, side: 'east' | 'west') =>
    openingKitGeometry(scene, room, side, kits)!.reduce((sum, part) => sum + part.geometry.getAttribute('position').count, 0);
  // Owner a draws frame + leaf; neighbor b draws only its frame.
  assert.ok(count(a, 'east') > count(b, 'west'));
  assert.equal(openingKitGeometry(scene, a, 'south', {}), undefined);
});

test('the committed opening kits exist', () => {
  const manifest = JSON.parse(readFileSync('public/assets/manifest.json', 'utf8')) as AssetManifest;
  const ids = (manifest.openings ?? []).map((item) => item.id).sort();
  assert.deepEqual(ids, ['door-frame', 'door-leaf-glazed', 'door-leaf-panel', 'window-casement', 'window-fixed']);
  for (const item of manifest.openings ?? []) assert.ok(existsSync(`public${item.url}`), item.id);
});
