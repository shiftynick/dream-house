/** Build optimized browser assets from the downloaded CC0 sources.
 *
 *   npx tsx scripts/assets/fetch-sources.ts   # once; fills gitignored assets-src/
 *   npx tsx scripts/assets/build-assets.ts    # writes public/assets/ + manifest.json
 *
 * Furniture goes through headless Blender (scripts/assets/build_furniture.py);
 * surface textures and the finish library are resized/re-encoded with ImageMagick.
 * The manifest records each asset's native size, budget and CC0 provenance for
 * src/renderAssets.ts; shared/asset-catalog.json is the small, bundled subset the
 * editor and design validation list (IDs, names, slots, swatches, attribution).
 * End users never need Blender: everything this writes is committed.
 */
import { execFile } from 'node:child_process';
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const blender = process.env.BLENDER || '/usr/bin/blender';
const sourceRoot = path.resolve('assets-src/polyhaven');
const ambientRoot = path.resolve('assets-src/ambientcg');
const publicRoot = path.resolve('public/assets');
const previewRoot = path.resolve('assets-src/previews');
type Range = [number, number];
type TextureSource = {
  id: string;
  polyhaven?: string;
  ambientcg?: string;
  size: number;
  albedo: 'luminance' | 'photo';
  /** Multiplies the photographed repeat (e.g. 2 doubles board width). */
  scale?: number;
  /** Albedo contrast around its mean, 0..1 (1 keeps the photo). */
  contrast?: number;
  /** Physical repeat in meters when the library does not record one (ambientCG). */
  meters?: number;
  /** Turn the photo a quarter clockwise so grain/brushing runs along v, like the
   * rest of the library (box-projected furniture UVs rely on that convention). */
  rotate90?: boolean;
};
type Sources = {
  furniture: {
    id: string;
    kinds: string[];
    polyhaven: string;
    targetTriangles: number;
    textureSize: number;
    rotateZ?: number;
    /** Source material recolored by the room palette; `split` separates saturated trim. */
    upholstery?: { material: string; split?: boolean; contrast?: number; shade?: number };
    /** Source material name (or prefix) to finish slot; others use name keywords. */
    slots?: Record<string, string>;
    /** Shared atlases split by UV island saturation: [material, saturated slot, rest slot]. */
    split?: [string, string, string][];
    /** Shared atlases split by island mean color (see build_furniture.py --classify). */
    classify?: { material: string; default: string; rules?: unknown[] }[];
    name: string;
    style?: string;
    /** The model a kind renders with until a piece chooses another (at most one per kind). */
    default?: boolean;
    stretch?: { x?: Range; y?: Range; z?: Range };
  }[];
  textures: (TextureSource & { surface: string })[];
  materials?: (TextureSource & {
    name: string;
    category: 'fabric' | 'leather' | 'wood' | 'metal' | 'stone';
    /** Reuse an already-built building texture set instead of encoding a copy. */
    texture?: string;
  })[];
  environment?: {
    id: string;
    polyhaven: string;
    resolution: string;
    width: number;
    lights: string[];
  }[];
};
const sources = JSON.parse(await readFile('scripts/assets/sources.json', 'utf8')) as Sources;
const only = process.argv.includes('--only')
  ? process.argv[process.argv.indexOf('--only') + 1]
  : '';

async function polyhavenInfo(id: string) {
  return JSON.parse(await readFile(path.join(sourceRoot, id, 'info.json'), 'utf8')) as {
    name: string;
    authors: Record<string, string>;
    dimensions?: [number, number];
  };
}
async function provenance(item: { polyhaven?: string; ambientcg?: string }) {
  if (item.ambientcg) {
    const details = JSON.parse(
      await readFile(path.join(ambientRoot, item.ambientcg, 'info.json'), 'utf8'),
    ) as { name: string };
    return {
      library: 'ambientCG',
      id: item.ambientcg,
      name: details.name,
      authors: ['ambientCG (Lennart Demes)'],
      license: 'CC0-1.0',
      url: `https://ambientcg.com/a/${item.ambientcg}`,
    };
  }
  const id = item.polyhaven!;
  const details = await polyhavenInfo(id);
  return {
    library: 'Poly Haven',
    id,
    name: details.name,
    authors: Object.keys(details.authors ?? {}),
    license: 'CC0-1.0',
    url: `https://polyhaven.com/a/${id}`,
  };
}

/** Source map paths: Poly Haven ships color/normal/arm; ambientCG ships separate
 * AO/roughness/metalness maps, which are packed into the same ARM layout. */
async function sourceMaps(item: TextureSource) {
  if (item.polyhaven) {
    const dir = path.join(sourceRoot, item.polyhaven);
    return {
      color: path.join(dir, 'color.jpg'),
      normal: path.join(dir, 'normal.jpg'),
      arm: [path.join(dir, 'arm.jpg')],
    };
  }
  const dir = path.join(ambientRoot, item.ambientcg!, 'maps');
  const files = await readdir(dir);
  const find = (suffix: string) => {
    const file = files.find((name) => name.endsWith(`_${suffix}.jpg`));
    return file ? path.join(dir, file) : undefined;
  };
  const color = find('Color'),
    normal = find('NormalGL'),
    roughness = find('Roughness');
  if (!color || !normal || !roughness) throw new Error(`${item.ambientcg} is missing maps`);
  const size = `${item.size}x${item.size}!`;
  // magick channel images: AO (white when absent), roughness, metalness (black when absent).
  const channel = (file: string | undefined, fill: string) =>
    file ? ['(', file, '-resize', size, '-colorspace', 'Gray', ')'] : ['(', '-size', size, `xc:${fill}`, ')'];
  return {
    color,
    normal,
    arm: [
      ...channel(find('AmbientOcclusion'), 'white'),
      ...channel(roughness, 'gray50'),
      ...channel(find('Metalness'), 'black'),
      '-set',
      'colorspace',
      'sRGB',
      '-combine',
    ],
  };
}

/** Encode color/normal/arm JPEGs and measure the linear mean albedo. */
async function encodeSet(item: TextureSource, target: string) {
  const maps = await sourceMaps(item);
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  let bytes = 0;
  for (const [map, quality] of [
    ['color', 84],
    ['normal', 90],
    ['arm', 84],
  ] as const) {
    const file = path.join(target, `${map}.jpg`);
    const input = map === 'arm' ? maps.arm : [maps[map]];
    // A tangent-space normal turns with the image: n' = (n.y, -n.x) for a quarter clockwise.
    const rotation = !item.rotate90
      ? []
      : map === 'normal'
        ? ['-rotate', '90', '-channel-fx', 'red<=>green', '-channel', 'G', '-negate', '+channel']
        : ['-rotate', '90'];
    await run('magick', [
      ...input,
      ...rotation,
      '-resize',
      `${item.size}x${item.size}>`,
      '-strip',
      '-quality',
      String(quality),
      ...(map !== 'color'
        ? ['-colorspace', 'sRGB', '-type', 'TrueColor']
        : [
            ...(item.albedo === 'luminance' ? ['-colorspace', 'Gray'] : []),
            ...(item.contrast !== undefined && item.contrast < 1
              ? [
                  '(',
                  '+clone',
                  '-resize',
                  '1x1!',
                  '-resize',
                  `${item.size}x${item.size}!`,
                  ')',
                  '-compose',
                  'blend',
                  '-define',
                  `compose:args=${Math.round((1 - item.contrast) * 100)}`,
                  '-composite',
                ]
              : []),
            ...(item.albedo === 'luminance' ? ['-colorspace', 'sRGB', '-type', 'TrueColor'] : []),
          ]),
      file,
    ]);
    bytes += (await stat(file)).size;
  }
  return { bytes, meanLinear: await meanLinear(path.join(target, 'color.jpg')) };
}

// Linear mean albedo lets the renderer keep each palette's average color while
// the photograph supplies only relative variation.
async function meanLinear(file: string) {
  const { stdout } = await run('magick', [
    file,
    '-colorspace',
    'RGB',
    '-resize',
    '1x1!',
    '-format',
    '%[fx:r] %[fx:g] %[fx:b]',
    'info:',
  ]);
  return stdout
    .trim()
    .split(/\s+/)
    .map((value) => Number(Number(value).toFixed(4))) as [number, number, number];
}

async function physicalSize(item: TextureSource) {
  if (item.meters) return [item.meters, item.meters];
  const details = await polyhavenInfo(item.polyhaven!);
  const size = (details.dimensions ?? [1000, 1000]).map(
    (mm) => Math.round(mm * (item.scale ?? 1)) / 1000,
  );
  return item.rotate90 ? size.reverse() : size;
}

const srgbHex = (linear: [number, number, number]) =>
  '#' +
  linear
    .map((c) => {
      const s = c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
      return Math.round(Math.min(1, Math.max(0, s)) * 255)
        .toString(16)
        .padStart(2, '0');
    })
    .join('');

await mkdir(path.join(publicRoot, 'furniture'), { recursive: true });
await mkdir(previewRoot, { recursive: true });
const previous = await readFile(path.join(publicRoot, 'manifest.json'), 'utf8')
  .then((text) => JSON.parse(text))
  .catch(() => ({ furniture: [], textures: [] }));
const furniture = [];
for (const item of sources.furniture) {
  if (only && only !== item.id) {
    const kept = previous.furniture.find((entry: { id: string }) => entry.id === item.id);
    if (kept) furniture.push(kept);
    continue;
  }
  const output = path.join(publicRoot, 'furniture', `${item.id}.glb`);
  const meta = path.join(previewRoot, `${item.id}.json`);
  await run(
    blender,
    [
      '-b',
      '--factory-startup',
      '-noaudio',
      '--python',
      path.resolve('scripts/assets/build_furniture.py'),
      '--',
      '--input',
      path.join(sourceRoot, item.polyhaven, `${item.polyhaven}.gltf`),
      '--output',
      output,
      '--meta',
      meta,
      '--triangles',
      String(item.targetTriangles),
      '--texture-size',
      String(item.textureSize),
      '--rotate-z',
      String(item.rotateZ ?? 0),
      '--preview',
      path.join(previewRoot, `${item.id}.png`),
      '--slots',
      JSON.stringify(item.slots ?? {}),
      ...(item.split ?? []).flatMap((rule) => ['--split', rule.join(':')]),
      ...(item.classify ?? []).flatMap((rule) => ['--classify', JSON.stringify(rule)]),
      '--slot-preview',
      path.join(previewRoot, `${item.id}-slots.png`),
      '--thumbnail',
      path.join(previewRoot, `${item.id}-thumb.png`),
      ...(item.upholstery
        ? [
            '--upholstery',
            item.upholstery.material,
            '--upholstery-contrast',
            String(item.upholstery.contrast ?? 0.6),
            ...(item.upholstery.split ? ['--split-saturated'] : []),
          ]
        : []),
    ],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  const result = JSON.parse(await readFile(meta, 'utf8'));
  // Picker thumbnails: 256 px JPEG on the editor's paper color.
  const thumbnail = path.join(publicRoot, 'thumbnails', `${item.id}.jpg`);
  await mkdir(path.dirname(thumbnail), { recursive: true });
  await run('magick', [
    path.join(previewRoot, `${item.id}-thumb.png`),
    '-resize',
    '160x160',
    '-strip',
    '-quality',
    '82',
    thumbnail,
  ]);
  furniture.push({
    id: item.id,
    name: item.name,
    ...(item.style ? { style: item.style } : {}),
    ...(item.default ? { default: true } : {}),
    thumbnail: `/assets/thumbnails/${item.id}.jpg`,
    kinds: item.kinds,
    url: `/assets/furniture/${item.id}.glb`,
    size: result.size,
    slots: result.slots,
    ...(item.stretch ? { stretch: item.stretch } : {}),
    ...(result.upholstery
      ? { upholstery: { mean: result.upholstery.mean, shade: item.upholstery?.shade ?? 1 } }
      : {}),
    triangles: result.triangles,
    textureSize: result.textureSize,
    bytes: result.bytes,
    source: await provenance(item),
  });
  console.log(
    `${item.id}: ${result.triangles} triangles, ${(result.bytes / 1e6).toFixed(2)} MB, slots ${JSON.stringify(result.slotSources)}`,
  );
}

// Remove models and thumbnails dropped from sources.json.
if (!only)
  for (const [dir, extension] of [
    ['furniture', '.glb'],
    ['thumbnails', '.jpg'],
  ] as const)
    for (const file of await readdir(path.join(publicRoot, dir)).catch(() => []))
      if (!sources.furniture.some((item) => `${item.id}${extension}` === file))
        await rm(path.join(publicRoot, dir, file));

const textures = [];
for (const item of sources.textures) {
  const { bytes, meanLinear } = await encodeSet(item, path.join(publicRoot, 'textures', item.id));
  const size = await physicalSize(item);
  textures.push({
    id: item.id,
    surface: item.surface,
    albedo: item.albedo,
    url: `/assets/textures/${item.id}`,
    size,
    meanLinear,
    bytes,
    source: await provenance(item),
  });
  console.log(`${item.id}: ${(bytes / 1e6).toFixed(2)} MB, ${size.join(' x ')} m repeat`);
}

// The finish library is loaded on demand, only when a piece or room uses it.
// Rebuilt from scratch so renamed or dropped entries leave no orphaned files.
await rm(path.join(publicRoot, 'materials'), { recursive: true, force: true });
const materials = [];
for (const item of sources.materials ?? []) {
  const shared = item.texture && textures.find((texture) => texture.id === item.texture);
  if (item.texture && !shared) throw new Error(`${item.id} reuses unknown texture ${item.texture}`);
  const encoded = shared
    ? { bytes: 0, meanLinear: shared.meanLinear }
    : await encodeSet(item, path.join(publicRoot, 'materials', item.id));
  const size = shared ? shared.size : await physicalSize(item);
  materials.push({
    id: item.id,
    name: item.name,
    category: item.category,
    albedo: item.albedo,
    url: shared ? shared.url : `/assets/materials/${item.id}`,
    size,
    meanLinear: encoded.meanLinear,
    ...(item.category === 'metal' ? { metal: true } : {}),
    bytes: encoded.bytes,
    source: shared ? shared.source : await provenance(item),
  });
  console.log(`${item.id}: ${(encoded.bytes / 1e6).toFixed(2)} MB, ${size.join(' x ')} m repeat`);
}

// Background panoramas only: lighting still comes from the calibrated sky model,
// so a clipped LDR conversion is enough and far smaller than the HDR.
const environment = [];
for (const item of sources.environment ?? []) {
  const target = path.join(publicRoot, 'environment', `${item.id}.jpg`);
  await mkdir(path.dirname(target), { recursive: true });
  await run('magick', [
    path.join(sourceRoot, item.polyhaven, 'environment.hdr'),
    '-resize',
    `${item.width}x${item.width / 2}!`,
    '-colorspace',
    'sRGB',
    '-strip',
    '-quality',
    '82',
    target,
  ]);
  const bytes = (await stat(target)).size;
  environment.push({
    id: item.id,
    url: `/assets/environment/${item.id}.jpg`,
    lights: item.lights,
    bytes,
    source: await provenance(item),
  });
  console.log(`${item.id}: ${(bytes / 1e6).toFixed(2)} MB background`);
}

// Window and door kits are authored procedurally in Blender (no downloaded
// source): true-size frames, sashes and hardware around a native opening.
const openingsMeta = path.join(previewRoot, 'openings.json');
await run(
  blender,
  [
    '-b',
    '--factory-startup',
    '-noaudio',
    '--python',
    path.resolve('scripts/assets/build_openings.py'),
    '--',
    '--output-dir',
    path.join(publicRoot, 'openings'),
    '--meta',
    openingsMeta,
    '--preview-dir',
    previewRoot,
  ],
  { maxBuffer: 64 * 1024 * 1024 },
);
const openings = Object.entries(
  JSON.parse(await readFile(openingsMeta, 'utf8')) as Record<string, Record<string, unknown>>,
).map(([id, info]) => ({
  id,
  url: `/assets/openings/${id}.glb`,
  ...info,
  source: { library: 'Terrain', name: id, authors: ['Terrain asset pipeline'], license: 'CC0-1.0' },
}));
console.log(`openings: ${openings.map((item) => item.id).join(', ')}`);

const draco = path.join(publicRoot, 'draco');
await mkdir(draco, { recursive: true });
for (const file of ['draco_decoder.wasm', 'draco_wasm_wrapper.js'])
  await copyFile(
    path.resolve('node_modules/three/examples/jsm/libs/draco/gltf', file),
    path.join(draco, file),
  );

await writeFile(
  path.join(publicRoot, 'manifest.json'),
  JSON.stringify({ version: 1, furniture, textures, materials, openings, environment }, null, 2) +
    '\n',
);
const attribution = (source: { library: string; name: string; authors: string[]; url: string }) =>
  `${source.name} by ${source.authors.join(', ')} (${source.library}, CC0)`;
await writeFile(
  path.resolve('shared/asset-catalog.json'),
  JSON.stringify(
    {
      materials: materials.map((item) => ({
        id: item.id,
        name: item.name,
        category: item.category,
        swatch: srgbHex(item.meanLinear),
        tinted: item.albedo === 'luminance',
        attribution: attribution(item.source),
      })),
      models: furniture.map((item) => ({
        id: item.id,
        name: item.name,
        ...(item.style ? { style: item.style } : {}),
        ...(item.default ? { default: true } : {}),
        thumbnail: item.thumbnail,
        ...(item.stretch ? { stretches: true } : {}),
        kinds: item.kinds,
        slots: item.slots,
        size: item.size,
        attribution: attribution(item.source),
      })),
    },
    null,
    2,
  ) + '\n',
);
