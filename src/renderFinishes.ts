import * as THREE from 'three';
import type { FinishSlot } from '../shared/model';
import { finishMaps, type MaterialAsset } from './renderAssets';

type FinishSet = Parameters<typeof finishMaps>[0];

/** Linear color for a library finish. Grayscale (`luminance`) sets take the
 * palette color divided by the photo's mean, so the palette's average color is
 * kept, as on building surfaces; photographed sets render as photographed. */
export function finishTint(asset: Pick<MaterialAsset, 'albedo' | 'meanLinear'>, palette?: string) {
  const color = new THREE.Color(1, 1, 1);
  if (asset.albedo !== 'luminance' || !palette) return color;
  const target = new THREE.Color(palette);
  // Dark photos (velvet) may need a gain above 4; cap it so noise is not blown out.
  return color.setRGB(
    ...(asset.meanLinear.map((mean, channel) =>
      Math.min(8, target.toArray()[channel] / Math.max(0.02, mean)),
    ) as [number, number, number]),
    THREE.LinearSRGBColorSpace,
  );
}

/** A PBR material for one library finish on one UV channel (meters). The
 * caller owns it and the textures it created; decoded images are shared.
 *
 * On a model's upholstery (or rug) the model's own normal and occlusion maps
 * stay, on its original UVs: tufting, seams and creases are part of the form,
 * so the new cloth follows them. Other slots take the library's grain relief. */
export function createFinishMaterial(
  set: FinishSet,
  slot: FinishSlot,
  channel: number,
  palette?: string,
  source?: THREE.Material,
) {
  const owned = finishMaps(set, channel);
  const form = source as THREE.MeshStandardMaterial | undefined;
  const keepForm = (slot === 'upholstery' || slot === 'rug') && !!form?.normalMap;
  const maps = {
    ...owned,
    ...(keepForm
      ? { normalMap: form!.normalMap, ...(form!.aoMap ? { aoMap: form!.aoMap } : {}) }
      : {}),
  };
  const { category, metal } = set.asset;
  const common = {
    ...maps,
    color: finishTint(set.asset, palette),
    roughness: 1,
    ...(keepForm ? { normalScale: form!.normalScale.clone() } : {}),
  };
  const velvet = set.asset.id === 'velvet';
  const material = metal
    ? new THREE.MeshStandardMaterial({ ...common, metalness: 1 })
    : category === 'fabric'
      ? new THREE.MeshPhysicalMaterial({
          normalScale: new THREE.Vector2(0.6, 0.6),
          ...common,
          // Pile fabrics catch grazing light strongly; flat weaves only slightly.
          sheen: velvet ? 1 : slot === 'rug' ? 0.15 : 0.28,
          sheenRoughness: velvet ? 0.35 : 0.85,
          sheenColor: new THREE.Color(palette ?? '#ffffff').lerp(
            new THREE.Color('white'),
            velvet ? 0.35 : 0.2,
          ),
        })
      : category === 'leather'
        ? new THREE.MeshPhysicalMaterial({ ...common, clearcoat: 0.08, clearcoatRoughness: 0.5 })
        : category === 'wood'
          ? new THREE.MeshPhysicalMaterial({ ...common, clearcoat: 0.16, clearcoatRoughness: 0.4 })
          : // Stone: honed rather than wet-looking.
            new THREE.MeshPhysicalMaterial({ ...common, clearcoat: 0.25, clearcoatRoughness: 0.3 });
  material.userData.ownedMaps = new Set(Object.values(owned));
  return material;
}

/** Dispose a finish material and only the texture objects it created. */
export function disposeFinishMaterial(material: THREE.Material) {
  (material.userData.ownedMaps as Set<THREE.Texture> | undefined)?.forEach((map) => map.dispose());
  material.dispose();
}
