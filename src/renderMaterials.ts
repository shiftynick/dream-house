import * as THREE from 'three';

export type SurfaceKind =
  'timber' | 'oak' | 'plaster' | 'concrete' | 'linen' | 'rug' | 'ground' | 'metal';
export type SurfacePixels = { color: Uint8Array; height: Uint8Array; roughness: Uint8Array };

const fract = (n: number) => n - Math.floor(n);
const hash = (x: number, y: number) => fract(Math.sin(x * 127.1 + y * 311.7 + 19.3) * 43758.5453);
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
function noise(x: number, y: number) {
  const ix = Math.floor(x),
    iy = Math.floor(y);
  const fx = fract(x),
    fy = fract(y);
  const u = fx * fx * (3 - 2 * fx),
    v = fy * fy * (3 - 2 * fy);
  return mix(
    mix(hash(ix, iy), hash(ix + 1, iy), u),
    mix(hash(ix, iy + 1), hash(ix + 1, iy + 1), u),
    v,
  );
}

/** Local, deterministic PBR maps. Color is sRGB; height and roughness are linear data.
 * A texel is not a centimeter: the physical repeat below defines each material's scale. */
export function surfacePixels(kind: SurfaceKind, size = 256): SurfacePixels {
  const color = new Uint8Array(size * size * 4);
  const height = new Uint8Array(size * size * 4);
  const roughness = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const u = x / size,
        v = y / size;
      const fine = hash(x, y),
        broad = noise(u * 16, v * 16);
      let value = 0.92,
        relief = 0.5,
        rough = 0.8;
      if (kind === 'timber' || kind === 'oak') {
        const boards = kind === 'timber' ? 6 : 8;
        const board = Math.floor(u * boards);
        const along = fract(v + hash(board, 7));
        const sweep = Math.sin(v * 5 + board * 2.1) * 2.5 + noise(board * 1.3, v * 2) * 4;
        const grain = noise(u * 170 + sweep, v * 8);
        const fiber = Math.sin(u * 1600 + noise(u * 13, v * 5) * 18) * 0.5 + 0.5;
        const seam = fract(u * boards) < 0.018 || (kind === 'oak' && along < 0.004);
        value = 0.84 + hash(board, 8) * 0.11 + grain * 0.055 + fiber * 0.022;
        relief = 0.48 + grain * 0.06 + fiber * 0.025;
        rough = 0.58 + grain * 0.12 + fine * 0.025;
        if (seam) {
          value *= kind === 'timber' ? 0.83 : 0.85;
          relief = 0.1;
          rough = 0.85;
        }
      } else if (kind === 'linen' || kind === 'rug') {
        const weave = x % 4 < 2 !== y % 4 < 2 ? 1 : 0;
        value = 0.89 + fine * 0.055 + weave * 0.035;
        relief = 0.3 + weave * 0.3 + fine * 0.12;
        rough = 0.91 + fine * 0.07;
      } else if (kind === 'ground') {
        value = 0.83 + broad * 0.05 + noise(u * 64, v * 64) * 0.055 + fine * 0.045;
        relief = broad * 0.05 + fine * 0.12;
        rough = 0.95;
      } else if (kind === 'metal') {
        const seam = fract(u * 4) < 0.025;
        value = seam ? 0.78 : 0.97 + fine * 0.025;
        relief = seam ? 0.95 : 0.4;
        rough = 0.7 + fine * 0.07;
      } else {
        value =
          kind === 'concrete'
            ? 0.84 + broad * 0.12 + fine * 0.025
            : 0.95 + broad * 0.025 + fine * 0.018;
        relief = 0.35 + broad * 0.15 + fine * 0.1;
        rough = 0.78 + fine * 0.15;
      }
      const i = (y * size + x) * 4;
      for (let channel = 0; channel < 3; channel++) {
        color[i + channel] = Math.round(Math.min(1, value) * 255);
        height[i + channel] = Math.round(relief * 255);
        roughness[i + channel] = Math.round(rough * 255);
      }
      color[i + 3] = height[i + 3] = roughness[i + 3] = 255;
    }
  return { color, height, roughness };
}

/** One repeat in meters: board widths are 0.18–0.20 m, weave repeats at 0.24 m. */
export const surfaceScale: Record<SurfaceKind, [number, number]> = {
  timber: [1.08, 2.4],
  oak: [1.6, 2.8],
  plaster: [1, 1],
  concrete: [2, 2],
  linen: [0.16, 0.16],
  rug: [0.32, 0.32],
  ground: [6, 6],
  metal: [1.8, 3],
};

// Pixel recipes are finite (eight kinds). Each canvas owns its GPU textures but
// reuses the immutable CPU pixels, avoiding repeated generation on captures/modes.
const pixelsCache = new Map<
  SurfaceKind,
  { size: number; pixels: SurfacePixels; normals: Uint8Array }
>();
function materialPixels(kind: SurfaceKind) {
  const cached = pixelsCache.get(kind);
  if (cached) return cached;
  const size = ['timber', 'oak'].includes(kind) ? 512 : 256;
  const pixels = surfacePixels(kind, size);
  // Convert the height field to tangent normals using actual meter spacing.
  const normals = new Uint8Array(size * size * 4);
  const heightAt = (x: number, y: number) =>
    pixels.height[(((y + size) % size) * size + ((x + size) % size)) * 4] / 255;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const dx =
        ((heightAt(x + 1, y) - heightAt(x - 1, y)) * 0.003 * size) / (2 * surfaceScale[kind][0]);
      const dy =
        ((heightAt(x, y + 1) - heightAt(x, y - 1)) * 0.003 * size) / (2 * surfaceScale[kind][1]);
      const length = Math.hypot(dx, dy, 1),
        i = (y * size + x) * 4;
      normals[i] = Math.round(((-dx / length) * 0.5 + 0.5) * 255);
      normals[i + 1] = Math.round(((-dy / length) * 0.5 + 0.5) * 255);
      normals[i + 2] = Math.round(((1 / length) * 0.5 + 0.5) * 255);
      normals[i + 3] = 255;
    }
  const value = { size, pixels, normals };
  pixelsCache.set(kind, value);
  return value;
}

export function makeSurfaceTextures(kind: SurfaceKind) {
  const { size, pixels, normals } = materialPixels(kind);
  const texture = (data: Uint8Array, color = false) => {
    const map = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
    map.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    map.wrapS = map.wrapT = THREE.RepeatWrapping;
    map.repeat.set(1 / surfaceScale[kind][0], 1 / surfaceScale[kind][1]);
    map.magFilter = THREE.LinearFilter;
    map.minFilter = THREE.LinearMipmapLinearFilter;
    map.generateMipmaps = true;
    map.anisotropy = 8;
    map.needsUpdate = true;
    return map;
  };
  return {
    map: texture(pixels.color, true),
    bumpMap: texture(pixels.height),
    normalMap: texture(normals),
    roughnessMap: texture(pixels.roughness),
  };
}
