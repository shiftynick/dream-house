import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { furnitureCatalog, makeFurniture } from '../shared/furniture';
import type { FurnitureKind } from '../shared/model';
import { furnitureGeometry } from '../src/renderFurniture';

test('batched furniture remains ray-pickable under saved position, dimensions and yaw', () => {
  const material = new THREE.MeshBasicMaterial();
  try {
    for (const kind of Object.keys(furnitureCatalog) as FurnitureKind[]) {
      for (const rotation of [0, 37, 90, 180]) {
        const item = makeFurniture(kind, `${kind}-saved-id`);
        item.width *= 1.3;
        item.depth *= 0.7;
        item.x = 2.2;
        item.z = -1.4;
        item.rotation = rotation;
        const group = new THREE.Group();
        group.userData.furnitureId = item.id;
        group.position.set(item.x, 0, item.z);
        group.rotation.y = THREE.MathUtils.degToRad(item.rotation);
        const batches = furnitureGeometry(item);
        batches.forEach(({ geometry }) => group.add(new THREE.Mesh(geometry, material)));
        group.updateMatrixWorld(true);
        try {
          const ray = new THREE.Raycaster();
          let picked = 0;
          for (const x of [-0.35, -0.18, 0, 0.18, 0.35]) {
            for (const z of [-0.35, -0.18, 0, 0.18, 0.35]) {
              const origin = group.localToWorld(
                new THREE.Vector3(x * item.width, item.height + 1, z * item.depth),
              );
              ray.set(origin, new THREE.Vector3(0, -1, 0));
              const hit = ray.intersectObject(group, true)[0];
              if (!hit) continue;
              picked++;
              let ancestor: THREE.Object3D | null = hit.object;
              while (ancestor && !ancestor.userData.furnitureId) ancestor = ancestor.parent;
              assert.equal(ancestor?.userData.furnitureId, item.id, `${kind}: stable pick ID`);
              const local = group.worldToLocal(hit.point.clone());
              assert.ok(Math.abs(local.x) <= item.width / 2 + 1e-5, `${kind}: pick width`);
              assert.ok(Math.abs(local.z) <= item.depth / 2 + 1e-5, `${kind}: pick depth`);
              assert.ok(local.y >= -1e-5 && local.y <= item.height + 1e-5, `${kind}: pick height`);
            }
          }
          assert.ok(picked > 0, `${kind} at ${rotation} degrees must expose pickable geometry`);
        } finally {
          batches.forEach(({ geometry }) => geometry.dispose());
        }
      }
    }
  } finally {
    material.dispose();
  }
});
