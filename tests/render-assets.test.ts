import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync, statSync } from 'node:fs';
import * as THREE from 'three';
import { furnitureCatalog } from '../shared/furniture';
import {
  fittedModelGeometry,
  surfaceTextures,
  upholsteryTint,
  type AssetManifest,
  type FurnitureModel,
} from '../src/renderAssets';

function boxModel(stretch?: FurnitureModel['asset']['stretch']): FurnitureModel {
  // A 2 x 1 x 1 m block whose vertices sit at x = ±1 and ±0.5 (arms at the ends).
  const geometry = new THREE.BoxGeometry(2, 1, 1, 4, 1, 1).translate(0, 0.5, 0);
  return {
    asset: { id: 'test', kinds: ['sofa'], url: '', size: [2, 1, 1], stretch },
    parts: [{ geometry, material: new THREE.MeshStandardMaterial() }],
  };
}

test('fitted models fill the saved envelope exactly', () => {
  for (const stretch of [undefined, { x: [-0.25, 0.25] as [number, number] }]) {
    const [part] = fittedModelGeometry(boxModel(stretch), { width: 3.6, height: 0.9, depth: 1.2 });
    const box = part.geometry.boundingBox!;
    assert.ok(Math.abs(box.min.x + 1.8) < 1e-6 && Math.abs(box.max.x - 1.8) < 1e-6);
    assert.ok(Math.abs(box.min.y) < 1e-6 && Math.abs(box.max.y - 0.9) < 1e-6);
    assert.ok(Math.abs(box.min.z + 0.6) < 1e-6 && Math.abs(box.max.z - 0.6) < 1e-6);
    part.geometry.dispose();
  }
});

test('a stretch zone absorbs growth while the ends keep their native length', () => {
  const [part] = fittedModelGeometry(boxModel({ x: [-0.25, 0.25] }), {
    width: 3.6,
    height: 1,
    depth: 1,
  });
  const xs = new Set<number>();
  const position = part.geometry.getAttribute('position');
  for (let i = 0; i < position.count; i++) xs.add(Number(position.getX(i).toFixed(6)));
  // Native vertex columns -1, -0.5, 0, 0.5, 1: the 0.5 m arms stay 0.5 m.
  assert.deepEqual(
    [...xs].sort((a, b) => a - b),
    [-1.8, -1.3, 0, 1.3, 1.8],
  );
  part.geometry.dispose();
});

test('upholstery tint keeps the palette mean and is absent without upholstery', () => {
  const asset = { ...boxModel().asset, upholstery: { mean: 0.35, shade: 0.5 } };
  const tint = upholsteryTint(asset, '#c5b6a0')!;
  const palette = new THREE.Color('#c5b6a0');
  assert.ok(Math.abs(tint.r * 0.35 - palette.r * 0.5) < 1e-6);
  assert.equal(upholsteryTint(boxModel().asset, '#c5b6a0'), undefined);
});

test('surfaces fall back to procedural maps when no photo set has loaded', () => {
  const { maps, photo } = surfaceTextures('stone');
  assert.equal(photo, undefined);
  assert.ok(maps.map instanceof THREE.DataTexture);
  new Set(Object.values(maps)).forEach((map) => map?.dispose());
});

test('the committed asset manifest references existing, budgeted files', () => {
  const manifest = JSON.parse(readFileSync('public/assets/manifest.json', 'utf8')) as AssetManifest;
  let bytes = 0;
  for (const item of manifest.furniture) {
    for (const kind of item.kinds) assert.ok(kind in furnitureCatalog, kind);
    const file = `public${item.url}`;
    assert.ok(existsSync(file), file);
    bytes += statSync(file).size;
    assert.ok(
      item.size.every((value) => value > 0.1 && value < 4),
      item.id,
    );
  }
  for (const item of manifest.textures)
    for (const map of ['color', 'normal', 'arm']) {
      const file = `public${item.url}/${map}.jpg`;
      assert.ok(existsSync(file), file);
      bytes += statSync(file).size;
    }
  for (const item of manifest.materials ?? [])
    if (item.url.startsWith('/assets/materials/'))
      for (const map of ['color', 'normal', 'arm']) bytes += statSync(`public${item.url}/${map}.jpg`).size;
  for (const item of manifest.environment ?? []) bytes += statSync(`public${item.url}`).size;
  // The owner asked to flag committed assets above ~80 MB.
  assert.ok(bytes < 80e6, `assets total ${bytes} bytes`);
});
