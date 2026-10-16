/** Build optimized browser assets from the downloaded CC0 sources.
 *
 *   npx tsx scripts/assets/fetch-sources.ts   # once; fills gitignored assets-src/
 *   npx tsx scripts/assets/build-assets.ts    # writes public/assets/ + manifest.json
 *
 * Furniture goes through headless Blender (scripts/assets/build_furniture.py);
 * surface textures are resized/re-encoded with ImageMagick. The manifest records
 * each asset's native size, budget and CC0 provenance for src/renderAssets.ts.
 */
import { execFile } from 'node:child_process';
import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const blender = process.env.BLENDER || '/usr/bin/blender';
const sourceRoot = path.resolve('assets-src/polyhaven');
const publicRoot = path.resolve('public/assets');
const previewRoot = path.resolve('assets-src/previews');
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
    stretch?: { x?: [number, number]; y?: [number, number]; z?: [number, number] };
  }[];
  textures: {
    id: string;
    surface: string;
    polyhaven: string;
    size: number;
    albedo: 'luminance' | 'photo';
    /** Multiplies the photographed repeat (e.g. 2 doubles board width). */
    scale?: number;
    /** Albedo contrast around its mean, 0..1 (1 keeps the photo). */
    contrast?: number;
  }[];
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

async function info(id: string) {
  return JSON.parse(await readFile(path.join(sourceRoot, id, 'info.json'), 'utf8')) as {
    name: string;
    authors: Record<string, string>;
    dimensions?: [number, number];
  };
}
const provenance = async (id: string) => {
  const details = await info(id);
  return {
    library: 'Poly Haven',
    id,
    name: details.name,
    authors: Object.keys(details.authors ?? {}),
    license: 'CC0-1.0',
    url: `https://polyhaven.com/a/${id}`,
  };
};

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
  furniture.push({
    id: item.id,
    kinds: item.kinds,
    url: `/assets/furniture/${item.id}.glb`,
    size: result.size,
    ...(item.stretch ? { stretch: item.stretch } : {}),
    ...(result.upholstery
      ? { upholstery: { mean: result.upholstery.mean, shade: item.upholstery?.shade ?? 1 } }
      : {}),
    triangles: result.triangles,
    textureSize: result.textureSize,
    bytes: result.bytes,
    source: await provenance(item.polyhaven),
  });
  console.log(`${item.id}: ${result.triangles} triangles, ${(result.bytes / 1e6).toFixed(2)} MB`);
}

const textures = [];
for (const item of sources.textures) {
  const source = path.join(sourceRoot, item.polyhaven);
  const target = path.join(publicRoot, 'textures', item.id);
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  let bytes = 0;
  for (const [map, quality] of [
    ['color', 84],
    ['normal', 90],
    ['arm', 84],
  ] as const) {
    const file = path.join(target, `${map}.jpg`);
    await run('magick', [
      path.join(source, `${map}.jpg`),
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
  // Linear mean albedo lets the renderer keep each palette's average color while
  // the photograph supplies only relative variation.
  const { stdout } = await run('magick', [
    path.join(target, 'color.jpg'),
    '-colorspace',
    'RGB',
    '-resize',
    '1x1!',
    '-format',
    '%[fx:r] %[fx:g] %[fx:b]',
    'info:',
  ]);
  const details = await info(item.polyhaven);
  const size = (details.dimensions ?? [1000, 1000]).map(
    (mm) => Math.round(mm * (item.scale ?? 1)) / 1000,
  );
  textures.push({
    id: item.id,
    surface: item.surface,
    albedo: item.albedo,
    url: `/assets/textures/${item.id}`,
    size,
    meanLinear: stdout
      .trim()
      .split(/\s+/)
      .map((value) => Number(Number(value).toFixed(4))),
    bytes,
    source: await provenance(item.polyhaven),
  });
  console.log(`${item.id}: ${(bytes / 1e6).toFixed(2)} MB, ${size.join(' x ')} m repeat`);
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
    source: await provenance(item.polyhaven),
  });
  console.log(`${item.id}: ${(bytes / 1e6).toFixed(2)} MB background`);
}

const draco = path.join(publicRoot, 'draco');
await mkdir(draco, { recursive: true });
for (const file of ['draco_decoder.wasm', 'draco_wasm_wrapper.js'])
  await copyFile(
    path.resolve('node_modules/three/examples/jsm/libs/draco/gltf', file),
    path.join(draco, file),
  );

await writeFile(
  path.join(publicRoot, 'manifest.json'),
  JSON.stringify({ version: 1, furniture, textures, environment }, null, 2) + '\n',
);
