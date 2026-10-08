import assert from 'node:assert/strict';
import test from 'node:test';
import { furnitureCatalog, makeFurniture } from '../shared/furniture';
import type { FurnitureKind } from '../shared/model';
import { furniturePartGeometry, furnitureParts, furnitureGeometry } from '../src/renderFurniture';
import {
  makeSurfaceTextures,
  surfacePixels,
  surfaceScale,
  type SurfaceKind,
} from '../src/renderMaterials';
import { SRGBColorSpace, NoColorSpace } from 'three';
import { daylightSkyPixels } from '../src/renderLighting';
import { RasterRenderer } from '../src/rasterRenderer';
import * as THREE from 'three';

test('detailed furniture stays inside the saved dimensions used by plans and clearance checks', () => {
  for (const kind of Object.keys(furnitureCatalog) as FurnitureKind[]) {
    for (const [widthScale, heightScale, depthScale] of [
      [0.45, 0.45, 0.45],
      [1, 1, 1],
      [1.8, 1.8, 1.8],
      [2.8, 0.6, 0.22],
      [0.2, 1.6, 3],
    ]) {
      const item = makeFurniture(kind, 'piece');
      item.width *= widthScale;
      item.height *= heightScale;
      item.depth *= depthScale;
      const before = JSON.stringify(item);
      const parts = furnitureParts(kind);
      assert.ok(parts.length > 0);
      for (const part of parts) {
        const geometry = furniturePartGeometry(item, part);
        const points = geometry.getAttribute('position');
        for (let vertex = 0; vertex < points.count; vertex++) {
          const x = points.getX(vertex) + part.position[0] * item.width;
          const y = points.getY(vertex) + part.position[1] * item.height;
          const z = points.getZ(vertex) + part.position[2] * item.depth;
          assert.ok(Math.abs(x) <= item.width / 2 + 0.00001, `${kind} width`);
          assert.ok(y >= -0.00001 && y <= item.height + 0.00001, `${kind} height`);
          assert.ok(Math.abs(z) <= item.depth / 2 + 0.00001, `${kind} depth`);
        }
        assert.ok(geometry.getAttribute('normal'));
        assert.equal(geometry.getAttribute('uv').count, points.count);
        geometry.dispose();
      }
      assert.equal(JSON.stringify(item), before, 'mesh generation never rewrites saved furniture');
    }
  }
});

test('batched furniture retains each material, triangle, UV and saved local bounds', () => {
  for (const kind of Object.keys(furnitureCatalog) as FurnitureKind[]) {
    const item = makeFurniture(kind, 'piece');
    item.width *= 2.8;
    item.depth *= 0.22;
    const expected = new Map<string, number>();
    for (const part of furnitureParts(kind)) {
      const geometry = furniturePartGeometry(item, part);
      expected.set(
        part.material,
        (expected.get(part.material) ?? 0) +
          (geometry.index?.count ?? geometry.getAttribute('position').count),
      );
      geometry.dispose();
    }
    const batches = furnitureGeometry(item);
    assert.equal(batches.length, expected.size);
    assert.ok(batches.length <= furnitureParts(kind).length);
    assert.ok(batches.length <= 4, 'detail stays in at most four material draw batches');
    for (const { material, geometry } of batches) {
      const positions = geometry.getAttribute('position');
      assert.equal(positions.count, expected.get(material));
      assert.equal(geometry.getAttribute('uv').count, positions.count);
      assert.equal(geometry.getAttribute('normal').count, positions.count);
      geometry.computeBoundingBox();
      const box = geometry.boundingBox!;
      assert.ok(box.min.x >= -item.width / 2 - 1e-5 && box.max.x <= item.width / 2 + 1e-5, kind);
      assert.ok(box.min.z >= -item.depth / 2 - 1e-5 && box.max.z <= item.depth / 2 + 1e-5, kind);
      assert.ok(box.min.y >= -1e-5 && box.max.y <= item.height + 1e-5, kind);
      geometry.dispose();
    }
  }
});

test('local material maps are reproducible and keep color separate from height and roughness data', () => {
  for (const kind of Object.keys(surfaceScale) as SurfaceKind[]) {
    const a = surfacePixels(kind, 32),
      b = surfacePixels(kind, 32);
    assert.deepEqual(a, b, kind);
    assert.notDeepEqual(a.color, a.height, `${kind}: albedo is not a height field`);
    assert.notDeepEqual(a.roughness, a.height, `${kind}: roughness is independently authored`);
    const maps = makeSurfaceTextures(kind);
    assert.equal(maps.map.colorSpace, SRGBColorSpace);
    assert.equal(maps.bumpMap.colorSpace, NoColorSpace);
    assert.equal(maps.normalMap.colorSpace, NoColorSpace);
    assert.equal(maps.roughnessMap.colorSpace, NoColorSpace);
    assert.equal(maps.map.repeat.x, 1 / surfaceScale[kind][0]);
    Object.values(maps).forEach((map) => map.dispose());
  }
});

test('rounded upholstery UVs stay continuous across curved triangles', () => {
  const item = makeFurniture('sofa', 'sofa');
  const cushion = furnitureParts('sofa').find(
    (part) => part.material === 'fabric' && part.cushion === 'y',
  )!;
  const geometry = furniturePartGeometry(item, cushion);
  const position = geometry.getAttribute('position'),
    uv = geometry.getAttribute('uv');
  for (let i = 0; i < position.count; i += 3)
    for (let edge = 0; edge < 3; edge++) {
      const a = i + edge,
        b = i + ((edge + 1) % 3);
      const distance = Math.hypot(
        position.getX(a) - position.getX(b),
        position.getY(a) - position.getY(b),
        position.getZ(a) - position.getZ(b),
      );
      const textureDistance = Math.hypot(uv.getX(a) - uv.getX(b), uv.getY(a) - uv.getY(b));
      assert.ok(
        textureDistance <= distance * 3 + 0.002,
        'a tiny rounded triangle must not span a distant texture region',
      );
    }
  geometry.dispose();
});

test('cloth crowns soften the center and welts stay millimeter-scale in the shared material batch', () => {
  const item = makeFurniture('sofa', 'sofa');
  const parts = furnitureParts('sofa');
  const seat = parts.find((part) => part.cushion === 'y')!;
  const geometry = furniturePartGeometry(item, seat);
  const positions = geometry.getAttribute('position');
  const halfWidth = (seat.size[0] * item.width) / 2;
  const halfHeight = (seat.size[1] * item.height) / 2;
  let center = -Infinity,
    shoulder = -Infinity;
  for (let i = 0; i < positions.count; i++) {
    if (Math.abs(positions.getZ(i)) > 1e-5) continue;
    if (Math.abs(positions.getX(i)) < 1e-5) center = Math.max(center, positions.getY(i));
    if (Math.abs(positions.getX(i)) > halfWidth * 0.7)
      shoulder = Math.max(shoulder, positions.getY(i));
  }
  assert.ok(Math.abs(center - halfHeight) < 1e-5, 'crown reaches the authored cushion height');
  assert.ok(center - shoulder > halfHeight * 0.08, 'cloth falls toward its tailored edge');
  geometry.dispose();
  const welt = furniturePartGeometry(
    item,
    parts.find((part) => part.welt === 'y')!,
  );
  welt.computeBoundingBox();
  assert.ok(
    welt.boundingBox!.max.y - welt.boundingBox!.min.y <= 0.004,
    'piping is a fine binding rather than an overlay slab',
  );
  welt.dispose();
});

test('binding orientation follows construction even for unusually thin or tall saved pieces', () => {
  for (const [kind, height] of [
    ['sofa', 0.02],
    ['rug', 0.8],
  ] as const) {
    const item = makeFurniture(kind, 'piece', { height });
    const part = furnitureParts(kind).find((part) => part.welt === 'y')!;
    const geometry = furniturePartGeometry(item, part);
    geometry.computeBoundingBox();
    const extent = geometry.boundingBox!.max.y - geometry.boundingBox!.min.y;
    if (kind === 'rug') assert.equal(extent, 0, 'rug binding lies on its top surface');
    else assert.ok(extent > 0, 'upholstery seam wraps vertically around the cushion side');
    geometry.dispose();
  }
});

test('furniture detail has deterministic finite geometry and a bounded triangle budget', () => {
  for (const kind of Object.keys(furnitureCatalog) as FurnitureKind[]) {
    const item = makeFurniture(kind, 'piece');
    const first = furnitureGeometry(item),
      second = furnitureGeometry(item);
    let triangles = 0;
    first.forEach(({ material, geometry }, i) => {
      assert.equal(material, second[i].material);
      for (const name of ['position', 'normal', 'uv']) {
        const attribute = geometry.getAttribute(name);
        assert.deepEqual(
          attribute.array,
          second[i].geometry.getAttribute(name).array,
          `${kind}: deterministic ${name}`,
        );
        assert.ok(Array.from(attribute.array).every(Number.isFinite), `${kind}: finite ${name}`);
      }
      const normals = geometry.getAttribute('normal');
      for (let vertex = 0; vertex < normals.count; vertex++) {
        assert.ok(
          Math.abs(
            Math.hypot(normals.getX(vertex), normals.getY(vertex), normals.getZ(vertex)) - 1,
          ) < 1e-5,
          `${kind}: unit surface normals`,
        );
      }
      triangles += geometry.getAttribute('position').count / 3;
      geometry.dispose();
      second[i].geometry.dispose();
    });
    assert.ok(triangles <= 7000, `${kind}: bounded procedural detail`);
  }
});

test('HDR daylight places the luminous sky at positive-Y equirectangular coordinates', () => {
  const width = 32,
    height = 16,
    pixels = daylightSkyPixels('day', width, height);
  const intensity = (row: number) =>
    pixels[row * width * 4] + pixels[row * width * 4 + 1] + pixels[row * width * 4 + 2];
  assert.ok(intensity(height - 1) > intensity(0) * 4, 'upward normals see sky, not ground');
  assert.ok(Math.max(...pixels) > 1, 'radiance is genuinely HDR, not an 8-bit background');
  assert.deepEqual(pixels, daylightSkyPixels('day', width, height));
});

test('contact shading failure restores renderer state and redraws a clean live view', (context) => {
  context.mock.method(console, 'warn', () => {});
  const scene = new THREE.Scene(),
    camera = new THREE.PerspectiveCamera(43, 1, 0.04, 1500);
  const line = new THREE.Line(),
    points = new THREE.Points();
  points.visible = false;
  const glass = new THREE.Mesh(
    new THREE.BoxGeometry(),
    new THREE.MeshBasicMaterial({ transparent: true }),
  );
  scene.add(line, points, glass);
  let color = new THREE.Color('#abcabc'),
    alpha = 1,
    draws = 0;
  const renderer = {
    autoClear: true,
    shadowMap: { autoUpdate: true },
    setRenderTarget: () => {},
    render: () => {
      draws++;
    },
    getDrawingBufferSize: (size: THREE.Vector2) => size.set(768, 576),
    getClearColor: (value: THREE.Color) => value.copy(color),
    getClearAlpha: () => alpha,
    setClearColor: (value: THREE.Color, nextAlpha = alpha) => {
      color = value.clone();
      alpha = nextAlpha;
    },
  };
  const raster = new RasterRenderer(renderer as unknown as THREE.WebGLRenderer, scene, camera);
  const pass = Reflect.get(raster, 'pass');
  let normalDisposals = 0,
    noiseDisposals = 0;
  pass.ssaoMaterial.addEventListener('dispose', () => normalDisposals++);
  pass.noiseTexture.addEventListener('dispose', () => noiseDisposals++);
  pass.render = () => {
    assert.equal(glass.visible, false, 'transparent panes must not become solid AO occluders');
    renderer.autoClear = false;
    color = new THREE.Color('red');
    alpha = 0;
    scene.overrideMaterial = new THREE.MeshNormalMaterial();
    throw new Error('simulated graphics failure');
  };
  assert.equal(raster.render(), false);
  assert.equal(draws, 2, 'fallback redraws the beauty after restoring all state');
  assert.equal(renderer.autoClear, true);
  assert.equal(renderer.shadowMap.autoUpdate, true);
  assert.equal(color.getHexString(), 'abcabc');
  assert.equal(alpha, 1);
  assert.equal(scene.overrideMaterial, null);
  assert.equal(line.visible, true);
  assert.equal(points.visible, false);
  assert.equal(glass.visible, true);
  raster.render();
  assert.equal(draws, 3, 'failed occlusion remains disabled on subsequent frames');
  raster.dispose();
  assert.equal(normalDisposals, 1);
  assert.equal(noiseDisposals, 1);
  glass.geometry.dispose();
  (glass.material as THREE.Material).dispose();
});
