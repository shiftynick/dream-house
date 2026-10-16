import { useEffect, useSyncExternalStore } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import type { Furniture, FurnitureKind } from '../shared/model';
import { makeSurfaceTextures, surfaceScale, type SurfaceKind } from './renderMaterials';

/** Optional photographic assets built by scripts/assets/build-assets.ts.
 * Everything here is additive: a missing manifest, model or texture leaves the
 * procedural furniture and generated surface maps in place. */
export const ASSET_ROOT = '/assets';
export type MaterialSurface = SurfaceKind | 'veneer' | 'stone' | 'charred' | 'ashlar' | 'stucco';
type Range = [number, number];
export type FurnitureAsset = {
  id: string;
  kinds: FurnitureKind[];
  url: string;
  /** Native [width, height, depth] in meters; front faces +z, origin bottom center. */
  size: [number, number, number];
  /** Normalized (-0.5..0.5; y 0..1) spans that absorb resizing on that axis. */
  stretch?: { x?: Range; y?: Range; z?: Range };
  /** The material named `upholstery` holds grayscale detail with this linear
   * mean; it is tinted by the palette fabric color times `shade`. */
  upholstery?: { mean: number; shade: number };
  /** Finish slots named by the model's materials. */
  slots?: string[];
};
/** A swappable finish from the library; loaded on first use. */
export type MaterialAsset = {
  id: string;
  name: string;
  category: string;
  url: string;
  size: [number, number];
  albedo: 'luminance' | 'photo';
  meanLinear: [number, number, number];
  metal?: boolean;
};
export type TextureAsset = {
  id: string;
  surface: MaterialSurface;
  url: string;
  /** Physical repeat in meters. */
  size: [number, number];
  /** `luminance` maps are grayscale detail tinted by the palette; `photo` keeps its color. */
  albedo: 'luminance' | 'photo';
  /** Linear mean albedo, used to keep a palette's average color. */
  meanLinear: [number, number, number];
};
export type EnvironmentAsset = { id: string; url: string; lights: string[] };
export type AssetManifest = {
  version: 1;
  furniture: FurnitureAsset[];
  textures: TextureAsset[];
  materials?: MaterialAsset[];
  environment?: EnvironmentAsset[];
};

export type ModelPart = { geometry: THREE.BufferGeometry; material: THREE.Material };
export type FurnitureModel = { asset: FurnitureAsset; parts: ModelPart[] };
type PhotoSet = {
  asset: TextureAsset;
  color: HTMLImageElement;
  normal: HTMLImageElement;
  arm: HTMLImageElement;
};

const proceduralFallback: Record<MaterialSurface, SurfaceKind> = {
  timber: 'timber',
  oak: 'oak',
  plaster: 'plaster',
  concrete: 'concrete',
  linen: 'linen',
  rug: 'rug',
  ground: 'ground',
  metal: 'metal',
  veneer: 'oak',
  stone: 'concrete',
  charred: 'timber',
  ashlar: 'concrete',
  stucco: 'plaster',
};

type FinishSet = { asset: MaterialAsset; sources: Record<'color' | 'normal' | 'arm', THREE.Source> };
const state = {
  version: 0,
  /** By asset ID; `defaults` maps each kind to its first listed model. */
  models: new Map<string, FurnitureModel>(),
  defaults: new Map<FurnitureKind, string>(),
  photos: new Map<MaterialSurface, PhotoSet>(),
  library: new Map<string, MaterialAsset>(),
  finishes: new Map<string, FinishSet | 'loading' | 'failed'>(),
  backgrounds: new Map<string, HTMLImageElement>(),
  failures: [] as string[],
};
const listeners = new Set<() => void>();
let loading: Promise<void> | undefined;

function publish() {
  state.version++;
  listeners.forEach((listener) => listener());
}

async function loadModel(loader: GLTFLoader, asset: FurnitureAsset): Promise<FurnitureModel> {
  const gltf = await loader.loadAsync(asset.url);
  gltf.scene.updateMatrixWorld(true);
  // One geometry per material in model space keeps a piece to a few draws.
  const parts: ModelPart[] = [];
  gltf.scene.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    const geometry = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
    const material = (
      Array.isArray(mesh.material) ? mesh.material[0] : mesh.material
    ) as THREE.Material;
    geometry.computeBoundingBox();
    parts.push({ geometry, material });
  });
  if (!parts.length) throw new Error(`${asset.url} has no meshes`);
  return { asset, parts };
}

function loadImage(url: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Could not load ${url}`));
    image.src = url;
  });
}

/** Idempotent; resolves after every listed asset has loaded or failed. Never rejects. */
export function loadRenderAssets(): Promise<void> {
  if (loading) return loading;
  if (typeof window === 'undefined' || typeof fetch === 'undefined') return Promise.resolve();
  loading = (async () => {
    let manifest: AssetManifest;
    try {
      const response = await fetch(`${ASSET_ROOT}/manifest.json`);
      if (!response.ok) return;
      manifest = await response.json();
      if (manifest.version !== 1) return;
    } catch {
      return;
    }
    const draco = new DRACOLoader().setDecoderPath(`${ASSET_ROOT}/draco/`);
    const loader = new GLTFLoader().setDRACOLoader(draco);
    for (const asset of manifest.materials ?? []) state.library.set(asset.id, asset);
    for (const asset of manifest.furniture)
      for (const kind of asset.kinds) if (!state.defaults.has(kind)) state.defaults.set(kind, asset.id);
    await Promise.all([
      ...manifest.furniture.map(async (asset) => {
        try {
          state.models.set(asset.id, await loadModel(loader, asset));
        } catch (error) {
          state.failures.push(`${asset.id}: ${error instanceof Error ? error.message : error}`);
        }
      }),
      ...manifest.textures.map(async (asset) => {
        try {
          const [color, normal, arm] = await Promise.all(
            ['color', 'normal', 'arm'].map((map) => loadImage(`${asset.url}/${map}.jpg`)),
          );
          state.photos.set(asset.surface, { asset, color, normal, arm });
        } catch (error) {
          state.failures.push(`${asset.id}: ${error instanceof Error ? error.message : error}`);
        }
      }),
      ...(manifest.environment ?? []).map(async (asset) => {
        try {
          const image = await loadImage(asset.url);
          for (const light of asset.lights) state.backgrounds.set(light, image);
        } catch (error) {
          state.failures.push(`${asset.id}: ${error instanceof Error ? error.message : error}`);
        }
      }),
    ]);
    draco.dispose();
    publish();
  })();
  return loading;
}

/** Re-renders when assets finish loading; starts loading on first use. */
export function useRenderAssets() {
  const version = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state.version,
    () => 0,
  );
  useEffect(() => {
    void loadRenderAssets();
  }, []);
  return version;
}

/** The loaded model for a piece: its chosen catalog model when it fits the
 * kind, else the kind's default; undefined renders the procedural fallback. */
export function furnitureModel(kind: FurnitureKind, modelId?: string) {
  const chosen = modelId ? state.models.get(modelId) : undefined;
  if (chosen?.asset.kinds.includes(kind)) return chosen;
  const fallback = state.defaults.get(kind);
  return fallback ? state.models.get(fallback) : undefined;
}

/** A library finish's decoded maps, or undefined while it loads (a publish
 * follows) or when it is unknown/failed. Images decode once per page. */
export function finishSet(id: string) {
  const entry = state.finishes.get(id);
  if (entry && entry !== 'loading' && entry !== 'failed') return entry;
  const asset = state.library.get(id);
  if (entry || !asset) return undefined;
  state.finishes.set(id, 'loading');
  void Promise.all(['color', 'normal', 'arm'].map((map) => loadImage(`${asset.url}/${map}.jpg`)))
    .then(([color, normal, arm]) => {
      state.finishes.set(id, {
        asset,
        sources: {
          color: new THREE.Source(color),
          normal: new THREE.Source(normal),
          arm: new THREE.Source(arm),
        },
      });
    })
    .catch((error) => {
      state.finishes.set(id, 'failed');
      state.failures.push(`${id}: ${error instanceof Error ? error.message : error}`);
    })
    .finally(publish);
  return undefined;
}

/** Textures for one material using `channel` UVs (meters). They share decoded
 * sources, so materials on one canvas share GPU memory; callers dispose them. */
export function finishMaps(set: FinishSet, channel: number) {
  const texture = (source: THREE.Source, color = false) => {
    const map = new THREE.Texture();
    map.source = source;
    map.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    map.wrapS = map.wrapT = THREE.RepeatWrapping;
    map.repeat.set(1 / set.asset.size[0], 1 / set.asset.size[1]);
    map.channel = channel;
    map.anisotropy = 8;
    map.needsUpdate = true;
    return map;
  };
  const arm = texture(set.sources.arm);
  return {
    map: texture(set.sources.color, true),
    normalMap: texture(set.sources.normal),
    roughnessMap: arm,
    aoMap: arm,
    ...(set.asset.metal ? { metalnessMap: arm } : {}),
  };
}
export function photoTexture(surface: MaterialSurface) {
  return state.photos.get(surface)?.asset;
}
export function renderAssetFailures() {
  return [...state.failures];
}

export function hasBackground(light: string) {
  return state.backgrounds.has(light);
}

/** A fresh equirectangular background for this lighting preset (caller disposes). */
export function backgroundTexture(light: string) {
  const image = state.backgrounds.get(light);
  if (!image) return undefined;
  const texture = new THREE.Texture(image);
  texture.mapping = THREE.EquirectangularReflectionMapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

export type SurfaceMaps = {
  map: THREE.Texture;
  normalMap: THREE.Texture;
  roughnessMap: THREE.Texture;
  aoMap?: THREE.Texture;
  bumpMap?: THREE.Texture;
};
/** Fresh GPU textures per canvas (callers dispose them); decoded images are shared. */
export function surfaceTextures(surface: MaterialSurface): {
  maps: SurfaceMaps;
  photo?: TextureAsset;
} {
  const photo = state.photos.get(surface);
  if (!photo) {
    const kind = proceduralFallback[surface];
    const maps = makeSurfaceTextures(kind);
    return { maps };
  }
  const texture = (image: HTMLImageElement, color = false) => {
    const map = new THREE.Texture(image);
    map.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    map.wrapS = map.wrapT = THREE.RepeatWrapping;
    map.repeat.set(1 / photo.asset.size[0], 1 / photo.asset.size[1]);
    map.anisotropy = 8;
    map.needsUpdate = true;
    return map;
  };
  const arm = texture(photo.arm);
  return {
    maps: {
      map: texture(photo.color, true),
      normalMap: texture(photo.normal),
      roughnessMap: arm,
      aoMap: arm,
    },
    photo: photo.asset,
  };
}
export { surfaceScale };

/** Remap one axis so a stretch zone absorbs growth and the ends stay rigid.
 * `low` is the normalized start of the axis (-0.5 centered, 0 for height); the
 * zone uses the same normalized coordinates. Returns [position, local scale]
 * (the scale corrects normals). Shrinking, or an axis without a zone, is uniform. */
function axisMap(native: number, target: number, zone: Range | undefined, low: number) {
  const uniform = target / native;
  if (!zone || target <= native) return (value: number) => [value * uniform, uniform] as const;
  const a = zone[0] * native,
    b = zone[1] * native,
    inner = b - a;
  const k = (inner + target - native) / inner;
  const mapped = (value: number) =>
    value <= a ? value : value >= b ? value + (k - 1) * inner : a + (value - a) * k;
  const shift = low * target - mapped(low * native);
  return (value: number) => [mapped(value) + shift, value > a && value < b ? k : 1] as const;
}

/** Replace the pipeline's per-face projection axis (`uv1`.x: 0 = x, 1 = y,
 * 2 = z) with box-projected UVs in meters, measured on the fitted piece so a
 * library finish keeps its real-world scale on stretched zones too. */
export function projectedUvs(geometry: THREE.BufferGeometry) {
  const axes = geometry.getAttribute('uv1') as THREE.BufferAttribute | undefined;
  if (!axes) return;
  const position = geometry.getAttribute('position') as THREE.BufferAttribute;
  const uv = new Float32Array(position.count * 2);
  for (let i = 0; i < position.count; i++) {
    const axis = Math.round(axes.getX(i));
    const x = position.getX(i),
      y = position.getY(i),
      z = position.getZ(i);
    // Library grain runs along v: up the piece on vertical faces (legs, panels)
    // and along the width on horizontal ones (tops, seats).
    uv[i * 2] = axis === 0 || axis === 1 ? z : x;
    uv[i * 2 + 1] = axis === 1 ? x : y;
  }
  geometry.setAttribute('uv1', new THREE.BufferAttribute(uv, 2));
}

/** Fit a model to a saved piece's exact envelope. Geometry is owned by the caller. */
export function fittedModelGeometry(
  model: FurnitureModel,
  item: Pick<Furniture, 'width' | 'height' | 'depth'>,
) {
  const [w, h, d] = model.asset.size;
  const stretch = model.asset.stretch ?? {};
  const mx = axisMap(w, item.width, stretch.x, -0.5),
    my = axisMap(h, item.height, stretch.y, 0),
    mz = axisMap(d, item.depth, stretch.z, -0.5);
  return model.parts.map((part) => {
    const geometry = part.geometry.clone();
    const position = geometry.getAttribute('position') as THREE.BufferAttribute;
    const normal = geometry.getAttribute('normal') as THREE.BufferAttribute | undefined;
    const n = new THREE.Vector3();
    for (let i = 0; i < position.count; i++) {
      const [x, sx] = mx(position.getX(i)),
        [y, sy] = my(position.getY(i)),
        [z, sz] = mz(position.getZ(i));
      position.setXYZ(i, x, y, z);
      if (normal) {
        n.set(normal.getX(i) / sx, normal.getY(i) / sy, normal.getZ(i) / sz).normalize();
        normal.setXYZ(i, n.x, n.y, n.z);
      }
    }
    position.needsUpdate = true;
    if (normal) normal.needsUpdate = true;
    projectedUvs(geometry);
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return { geometry, material: part.material };
  });
}

/** Linear tint for a model's `upholstery` material from a palette fabric color. */
export function upholsteryTint(asset: FurnitureAsset, fabric: string | undefined) {
  if (!asset.upholstery || !fabric) return undefined;
  return new THREE.Color(fabric).multiplyScalar(asset.upholstery.shade / asset.upholstery.mean);
}
