import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import * as THREE from 'three';
import {
  assetCatalog,
  chooseModelPatch,
  finishOptions,
  modelMaterialSlot,
  pieceModel,
  pieceSlots,
  proceduralSlot,
  resolveFinish,
} from '../shared/finishes.ts';
import { makeFurniture } from '../shared/furniture.ts';
import { executeCommands } from '../shared/design.ts';
import { emptyScene, furnitureSchema, makeRoom, sceneSchema, type Scene } from '../shared/model.ts';
import { projectedUvs, type AssetManifest } from '../src/renderAssets.ts';
import { finishTint } from '../src/renderFinishes.ts';

test('a piece finish overrides the room default, and unknown or misfit IDs are ignored', () => {
  const room = { furnitureFinishes: { wood: 'walnut', upholstery: 'linen' } };
  const piece = { finishes: { upholstery: 'velvet' } };
  assert.equal(resolveFinish(piece, room, 'upholstery'), 'velvet');
  assert.equal(resolveFinish(piece, room, 'wood'), 'walnut');
  assert.equal(resolveFinish(piece, room, 'metal'), undefined);
  // A wood finish on the upholstery slot, or an ID absent from the library, keeps the model's own.
  assert.equal(resolveFinish({ finishes: { upholstery: 'walnut' } }, undefined, 'upholstery'), undefined);
  assert.equal(resolveFinish({ finishes: { wood: 'not-a-finish' } }, room, 'wood'), undefined);
});

test('a model default finish applies only when neither the piece nor its room sets one', () => {
  const model = { finishes: { wood: 'oak' } };
  assert.equal(resolveFinish({}, undefined, 'wood', model), 'oak');
  assert.equal(resolveFinish({}, { furnitureFinishes: { wood: 'walnut' } }, 'wood', model), 'walnut');
  assert.equal(resolveFinish({ finishes: { wood: 'teak' } }, undefined, 'wood', model), 'teak');
  assert.equal(resolveFinish({}, undefined, 'upholstery', model), undefined);
  const plank = pieceModel({ kind: 'dining-table' });
  assert.equal(plank?.id, 'dining-table-plank');
  assert.equal(resolveFinish({}, undefined, 'wood', plank), 'oak');
});

test('slot options follow material categories', () => {
  const ids = (slot: Parameters<typeof finishOptions>[0]) => finishOptions(slot).map((m) => m.id);
  assert.ok(ids('upholstery').includes('leather-cognac') && ids('upholstery').includes('boucle'));
  assert.ok(!ids('rug').includes('leather-cognac'));
  assert.ok(ids('wood').every((id) => assetCatalog.materials.find((m) => m.id === id)!.category === 'wood'));
  for (const slot of ['upholstery', 'wood', 'metal', 'stone', 'rug'] as const)
    assert.ok(finishOptions(slot).length >= 3, slot);
});

test('pieces expose their model slots, or procedural slots without a model', () => {
  assert.deepEqual(pieceSlots({ kind: 'coffee-table' }), ['wood', 'stone']);
  assert.deepEqual(pieceSlots({ kind: 'rug' }), ['rug']);
  // A chosen model for another kind falls back to this kind's default.
  assert.equal(pieceModel({ kind: 'sofa', model: 'coffee-table-concrete-oak' })?.kinds[0], 'sofa');
  assert.equal(modelMaterialSlot('wood.001'), 'wood');
  assert.equal(modelMaterialSlot('Material_12'), undefined);
  assert.equal(proceduralSlot('seam'), 'upholstery');
  assert.equal(proceduralSlot('ceramic'), undefined);
});

test('finishes save with pieces and rooms and old houses still parse', () => {
  const scene: Scene = { ...structuredClone(emptyScene), rooms: [makeRoom({ id: 'a', furniture: [] })] };
  const item = makeFurniture('sofa', 's1');
  const result = executeCommands(scene, [
    { type: 'add_furniture', roomId: 'a', items: [item] },
    {
      type: 'update_furniture',
      roomId: 'a',
      furnitureId: 's1',
      patch: { finishes: { upholstery: 'boucle' }, model: 'sofa-tufted-leather' },
    },
    { type: 'update_room', roomId: 'a', patch: { furnitureFinishes: { wood: 'oak' } } },
  ]);
  assert.ok(result.applied, JSON.stringify(result.issues));
  const room = result.scene.rooms[0];
  assert.deepEqual(room.furnitureFinishes, { wood: 'oak' });
  assert.deepEqual(room.furniture![0].finishes, { upholstery: 'boucle' });
  assert.ok(sceneSchema.safeParse(result.scene).success);
  assert.ok(sceneSchema.safeParse(scene).success);
  assert.ok(
    !sceneSchema.safeParse({
      ...scene,
      rooms: [{ ...scene.rooms[0], furnitureFinishes: { wood: 'Bad ID!' } }],
    }).success,
  );
});

test('projected UVs are meters on the fitted piece along each face axis', () => {
  // One quad per axis: x-facing at x = 2, up-facing at y = 3, z-facing at z = 4.
  const position = new Float32Array([
    2, 0, 0, 2, 1, 0, 2, 0, 1,
    0, 3, 0, 1, 3, 0, 0, 3, 1,
    0, 0, 4, 1, 0, 4, 0, 1, 4,
  ]);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geometry.setAttribute(
    'uv1',
    new THREE.BufferAttribute(new Float32Array([0, 0, 0, 0, 0, 0, 1, 0, 1, 0, 1, 0, 2, 0, 2, 0, 2, 0]), 2),
  );
  projectedUvs(geometry);
  const uv = geometry.getAttribute('uv1');
  // x faces: (z, y); y faces: (z, x) so grain runs along the width; z faces: (x, y).
  assert.deepEqual([uv.getX(1), uv.getY(1), uv.getX(2), uv.getY(2)], [0, 1, 1, 0]);
  assert.deepEqual([uv.getX(4), uv.getY(4), uv.getX(5), uv.getY(5)], [0, 1, 1, 0]);
  assert.deepEqual([uv.getX(7), uv.getY(7), uv.getX(8), uv.getY(8)], [1, 0, 0, 1]);
});

test('tinted finishes keep the palette mean; photographed finishes are untinted', () => {
  const tint = finishTint({ albedo: 'luminance', meanLinear: [0.2, 0.2, 0.2] }, '#c5b6a0');
  const palette = new THREE.Color('#c5b6a0');
  assert.ok(Math.abs(tint.r * 0.2 - palette.r) < 1e-6 && Math.abs(tint.b * 0.2 - palette.b) < 1e-6);
  assert.deepEqual(finishTint({ albedo: 'photo', meanLinear: [0.2, 0.2, 0.2] }, '#c5b6a0').toArray(), [1, 1, 1]);
});

test('the bundled catalog matches the manifest and every library finish has its maps', () => {
  const manifest = JSON.parse(readFileSync('public/assets/manifest.json', 'utf8')) as AssetManifest;
  assert.deepEqual(
    assetCatalog.materials.map((item) => item.id),
    (manifest.materials ?? []).map((item) => item.id),
  );
  assert.deepEqual(
    assetCatalog.models.map((item) => item.id),
    manifest.furniture.map((item) => item.id),
  );
  for (const item of manifest.materials ?? [])
    for (const map of ['color', 'normal', 'arm'])
      assert.ok(existsSync(`public${item.url}/${map}.jpg`), `${item.id} ${map}`);
  for (const model of assetCatalog.models) {
    assert.ok(model.slots.length > 0, model.id);
    assert.match(model.attribution, /CC0/);
  }
});

test('the catalog offers several models for each common kind, each with thumbnail and CC0 credit', () => {
  for (const kind of ['sofa', 'armchair', 'coffee-table', 'dining-table', 'chair', 'nightstand', 'wardrobe', 'plant'] as const)
    assert.ok(assetCatalog.models.filter((m) => m.kinds.includes(kind)).length >= 3, kind);
  assert.ok(assetCatalog.models.filter((m) => m.kinds.includes('bed')).length >= 2);
  for (const model of assetCatalog.models) {
    assert.ok(model.thumbnail && existsSync(`public${model.thumbnail}`), model.id);
    assert.ok(model.name);
  }
  // At most one default per kind; kinds without one keep the built-in piece.
  for (const kind of new Set(assetCatalog.models.flatMap((m) => m.kinds)))
    assert.ok(assetCatalog.models.filter((m) => m.default && m.kinds.includes(kind)).length <= 1, kind);
  assert.equal(pieceModel({ kind: 'bed' }), undefined);
  assert.equal(pieceModel({ kind: 'sofa', model: 'builtin' }), undefined);
  assert.equal(pieceModel({ kind: 'bed', model: 'bed-iron-frame' })?.id, 'bed-iron-frame');
});

test('choosing a non-stretching model adopts its native size; stretchable models keep the saved size', () => {
  const round = chooseModelPatch({ kind: 'coffee-table' }, 'coffee-table-round-steel');
  const model = assetCatalog.models.find((m) => m.id === 'coffee-table-round-steel')!;
  assert.equal(round.width, Math.round(model.size[0] * 100) / 100);
  assert.equal(round.depth, Math.round(model.size[2] * 100) / 100);
  assert.deepEqual(chooseModelPatch({ kind: 'sofa' }, 'sofa-tufted-leather'), { model: 'sofa-tufted-leather' });
  // A model for another kind changes nothing but the (ignored) reference.
  assert.deepEqual(chooseModelPatch({ kind: 'sofa' }, 'bed-iron-frame'), { model: 'bed-iron-frame' });
});

test('every model keeps a valid saved size when its native size is adopted', () => {
  for (const model of assetCatalog.models)
    for (const kind of model.kinds) {
      const item = { ...makeFurniture(kind, 'piece'), ...chooseModelPatch({ kind }, model.id) };
      assert.ok(furnitureSchema.safeParse(item).success, model.id);
    }
  // The aloe is smaller than the minimum footprint and scales up without distortion.
  const aloe = chooseModelPatch({ kind: 'plant' }, 'plant-aloe');
  assert.equal(aloe.width, 0.2);
  assert.ok(Math.abs(aloe.height! / aloe.width! - 0.2675 / 0.1679) < 0.1);
});
