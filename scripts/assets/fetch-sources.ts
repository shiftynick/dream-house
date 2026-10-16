/** Download the CC0 sources listed in sources.json into gitignored assets-src/.
 * Poly Haven files are checksum-verified and skipped when already present.
 * ambientCG publishes no checksums: its zip is size-checked against the API and
 * only the expected maps are extracted, flattened, into a fresh directory.
 *
 *   npx tsx scripts/assets/fetch-sources.ts
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = path.resolve('assets-src/polyhaven');
const ambientRoot = path.resolve('assets-src/ambientcg');
type TextureSource = { polyhaven?: string; ambientcg?: string; size: number; texture?: string };
const sources = JSON.parse(await readFile('scripts/assets/sources.json', 'utf8')) as {
  furniture: { polyhaven?: string }[];
  textures: TextureSource[];
  materials?: TextureSource[];
  environment: { polyhaven: string; resolution: string }[];
};
type FileEntry = { url: string; md5: string; size: number };

async function fetchJson(url: string) {
  const response = await fetch(url, { headers: { 'User-Agent': 'terrain-asset-pipeline' } });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.json();
}
async function download(entry: FileEntry, target: string) {
  try {
    const existing = await readFile(target);
    if (createHash('md5').update(existing).digest('hex') === entry.md5) return false;
  } catch {
    /* missing */
  }
  const response = await fetch(entry.url);
  if (!response.ok) throw new Error(`${entry.url}: HTTP ${response.status}`);
  const data = Buffer.from(await response.arrayBuffer());
  if (createHash('md5').update(data).digest('hex') !== entry.md5)
    throw new Error(`${entry.url}: checksum mismatch`);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, data);
  return true;
}
function inside(base: string, relative: string) {
  const target = path.resolve(base, relative);
  if (!target.startsWith(base + path.sep))
    throw new Error(`Refusing path outside ${base}: ${relative}`);
  return target;
}

for (const { polyhaven: id } of sources.furniture) {
  if (!id) continue;
  const dir = path.join(root, id);
  const files = await fetchJson(`https://api.polyhaven.com/files/${id}`);
  const gltf = files.gltf['2k'].gltf as FileEntry & { include: Record<string, FileEntry> };
  let fetched = await download(gltf, inside(dir, `${id}.gltf`));
  for (const [relative, entry] of Object.entries(gltf.include))
    fetched = (await download(entry, inside(dir, relative))) || fetched;
  await writeFile(
    path.join(dir, 'info.json'),
    JSON.stringify(await fetchJson(`https://api.polyhaven.com/info/${id}`), null, 2),
  );
  console.log(`${fetched ? 'fetched' : 'cached '} model ${id}`);
}
const textureSources = [
  ...sources.textures,
  // Library entries that reuse a building texture share its download.
  ...(sources.materials ?? []).filter((item) => !item.texture),
];
for (const { polyhaven: id, size } of textureSources) {
  if (!id) continue;
  const dir = path.join(root, id);
  const files = await fetchJson(`https://api.polyhaven.com/files/${id}`);
  const resolution = `${Math.round(size / 1024)}k`;
  let fetched = false;
  for (const [map, name] of [
    ['Diffuse', 'color'],
    ['nor_gl', 'normal'],
    ['arm', 'arm'],
  ] as const) {
    const entry = files[map]?.[resolution]?.jpg as FileEntry | undefined;
    if (!entry) throw new Error(`${id} has no ${resolution} ${map} JPEG`);
    fetched = (await download(entry, inside(dir, `${name}.jpg`))) || fetched;
  }
  await writeFile(
    path.join(dir, 'info.json'),
    JSON.stringify(await fetchJson(`https://api.polyhaven.com/info/${id}`), null, 2),
  );
  console.log(`${fetched ? 'fetched' : 'cached '} texture ${id} ${resolution}`);
}
for (const { ambientcg: id, size } of textureSources) {
  if (!id) continue;
  const dir = path.join(ambientRoot, id);
  const resolution = `${Math.max(1, Math.round(size / 1024))}K-JPG`;
  const details = await fetchJson(
    `https://ambientcg.com/api/v2/full_json?id=${encodeURIComponent(id)}&include=downloadData,tagData`,
  );
  const asset = details.foundAssets?.[0];
  const entry = asset?.downloadFolders?.default?.downloadFiletypeCategories?.zip?.downloads?.find(
    (item: { attribute: string }) => item.attribute === resolution,
  ) as { downloadLink: string; size: number; fileName: string } | undefined;
  if (!asset || asset.assetId !== id || !entry) throw new Error(`ambientCG ${id} has no ${resolution}`);
  const archive = path.join(dir, entry.fileName);
  const cached = await stat(archive).then((file) => file.size === entry.size, () => false);
  if (!cached) {
    const response = await fetch(entry.downloadLink, {
      headers: { 'User-Agent': 'terrain-asset-pipeline' },
    });
    if (!response.ok) throw new Error(`${entry.downloadLink}: HTTP ${response.status}`);
    const data = Buffer.from(await response.arrayBuffer());
    if (data.length !== entry.size) throw new Error(`${entry.fileName}: size mismatch`);
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    await writeFile(archive, data);
  }
  const maps = path.join(dir, 'maps');
  await rm(maps, { recursive: true, force: true });
  await mkdir(maps, { recursive: true });
  // -j drops archive paths, so entries cannot escape `maps`.
  await run('unzip', ['-o', '-j', '-q', archive, '*.jpg', '-d', maps]);
  await writeFile(
    path.join(dir, 'info.json'),
    JSON.stringify(
      { name: asset.displayName, tags: asset.tags, url: asset.shortLink, archive: entry.fileName },
      null,
      2,
    ),
  );
  console.log(`${cached ? 'cached ' : 'fetched'} ambientCG ${id} ${resolution}`);
}
for (const { polyhaven: id, resolution } of sources.environment) {
  const files = await fetchJson(`https://api.polyhaven.com/files/${id}`);
  const entry = files.hdri?.[resolution]?.hdr as FileEntry | undefined;
  if (!entry) throw new Error(`${id} has no ${resolution} HDR`);
  const fetched = await download(entry, inside(path.join(root, id), 'environment.hdr'));
  await writeFile(
    path.join(root, id, 'info.json'),
    JSON.stringify(await fetchJson(`https://api.polyhaven.com/info/${id}`), null, 2),
  );
  console.log(`${fetched ? 'fetched' : 'cached '} environment ${id} ${resolution}`);
}
