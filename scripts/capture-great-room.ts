/** Fixed-camera Great Hall evidence for the realism pilot.
 *
 * Reads the owner's saved house read-only, copies its scene into isolated
 * verification storage on its own scenario server, and captures the same
 * cameras through the real local render broker. Never writes `.data/workspace.json`.
 *
 *   npx tsx scripts/capture-great-room.ts --out .data/verification/great-room/before
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { sceneSchema, type Scene } from '../shared/model.ts';
import { chooseModelPatch } from '../shared/finishes.ts';
import { sceneFingerprint } from '../server/render-service.ts';
import { renderCamera, renderRequestSchema, type RenderRequest } from '../shared/render.ts';

const args = process.argv.slice(2);
function option(name: string, fallback: string) {
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1] || fallback;
}
const port = Number(option('--port', '5195'));
if (!Number.isInteger(port) || port < 1024 || port > 45000 || port === 5174 || port === 5173)
  throw new Error(
    'Choose a verification port between 1024 and 45000; production ports are forbidden.',
  );
const base = `http://127.0.0.1:${port}`;
const output = path.resolve(option('--out', '.data/verification/great-room/latest'));
const executablePath = option('--chromium', '/usr/bin/chromium');
const gpu = option('--gpu', 'hardware');
const roomId = option('--room', 'great-hall');
const only = option('--only', '');

type Workspace = { activeProjectId: string; projects: { projectId: string; scene: Scene }[] };
const workspace = JSON.parse(await readFile('.data/workspace.json', 'utf8')) as Workspace;
const projectId = option('--project', workspace.activeProjectId);
const source = workspace.projects.find((project) => project.projectId === projectId);
if (!source) throw new Error(`No saved project ${projectId}.`);
const scene = sceneSchema.parse(structuredClone(source.scene));
const room = scene.rooms.find((item) => item.id === roomId);
if (!room) throw new Error(`Project ${projectId} has no room ${roomId}.`);
// --demo-catalog picks catalog models and adds a few plants, also only in this copy.
if (args.includes('--demo-catalog')) {
  const byId = (id: string) => scene.rooms.find((item) => item.id === id);
  const pieces = (roomKey: string, kind: string) =>
    (byId(roomKey)?.furniture ?? []).filter((item) => item.kind === kind);
  const choose = (roomKey: string, kind: string, model: string, index?: number) =>
    pieces(roomKey, kind).forEach((item, i) => {
      if (index === undefined || index === i) Object.assign(item, chooseModelPatch(item, model));
    });
  choose('great-hall', 'armchair', 'armchair-mid-century', 1);
  choose('great-hall', 'coffee-table', 'coffee-table-round-steel', 1);
  choose('dining', 'dining-table', 'dining-table-plank');
  choose('dining', 'chair', 'chair-tufted-dining');
  choose('primary-suite', 'nightstand', 'nightstand-open-shelf');
  choose('primary-suite', 'wardrobe', 'wardrobe-hutch');
  choose('terrace', 'chair', 'chair-ladder-back');
  const plant = (roomKey: string, id: string, model: string, x: number, z: number, height = 1.3) =>
    byId(roomKey)?.furniture?.push({
      id, kind: 'plant', name: 'Potted plant', model, x, z, rotation: 0, width: 0.6, depth: 0.6, height,
    });
  plant('great-hall', 'demo-plant-hall', 'plant-ficus', 5.9, -5.0, 1.5);
  plant('entry', 'demo-plant-entry', 'plant-leafy', -1.6, 2.9, 1.0);
  plant('primary-suite', 'demo-plant-suite', 'plant-aloe', -4.3, -2.4, 0.7);
}
// --demo-slots shows the two atlas-split models with swapped finishes (isolated copy only).
if (args.includes('--demo-slots')) {
  const hall = scene.rooms.find((item) => item.id === 'great-hall');
  const pieces = (kind: string) => (hall?.furniture ?? []).filter((item) => item.kind === kind);
  const sofa = pieces('sofa')[1],
    armchair = pieces('armchair')[1];
  if (sofa)
    Object.assign(sofa, chooseModelPatch(sofa, 'sofa-painted-settle'), {
      finishes: { upholstery: 'boucle', wood: 'pale-oak' },
    });
  if (armchair)
    Object.assign(armchair, chooseModelPatch(armchair, 'armchair-mid-century'), {
      finishes: { upholstery: 'leather-cognac', wood: 'pale-oak' },
    });
}
// --demo-finishes applies library finishes to this isolated copy only.
if (args.includes('--demo-finishes')) {
  const byId = (id: string) => scene.rooms.find((item) => item.id === id);
  const piece = (roomKey: string, kind: string, index = 0) =>
    (byId(roomKey)?.furniture ?? []).filter((item) => item.kind === kind)[index];
  const hall = byId('great-hall');
  if (hall) hall.furnitureFinishes = { wood: 'walnut', metal: 'blackened-steel' };
  Object.assign(piece('great-hall', 'sofa') ?? {}, { finishes: { upholstery: 'boucle' } });
  Object.assign(piece('great-hall', 'sofa', 1) ?? {}, { finishes: { upholstery: 'velvet' } });
  Object.assign(piece('great-hall', 'armchair') ?? {}, { finishes: { upholstery: 'leather-cognac' } });
  Object.assign(piece('great-hall', 'coffee-table') ?? {}, { finishes: { stone: 'white-marble' } });
  Object.assign(piece('great-hall', 'rug') ?? {}, { finishes: { rug: 'jute' } });
  for (const [id, finishes] of [
    ['primary-suite', { upholstery: 'linen', wood: 'pale-oak' }],
    ['dining', { wood: 'teak', upholstery: 'leather-espresso' }],
    ['kitchen', { wood: 'ebonised-oak', stone: 'white-marble', metal: 'brass' }],
  ] as const)
    if (byId(id)) byId(id)!.furnitureFinishes = finishes;
}

// Interior angles use the broker's 68° framing; explicit cameras use the
// exterior contract (43°) placed inside the room at standing eye height.
const at = (x: number, y: number, z: number): [number, number, number] => [
  room.x + x,
  room.elevation + y,
  room.z + z,
];
const shots: { id: string; request: RenderRequest }[] = [
  { id: 'wide-southeast', request: interior('southeast') },
  { id: 'wide-northwest', request: interior('northwest') },
  { id: 'fireside-front', request: explicit(at(1.6, 1.45, -3.7), at(-3.2, 0.55, -0.3)) },
  { id: 'fireside-behind', request: explicit(at(-0.6, 1.6, 4.6), at(-2.6, 1.0, -3.6)) },
  { id: 'conversation', request: explicit(at(0.2, 1.35, 5.2), at(3.6, 0.55, 2.3)) },
  // Whole-house cameras (world meters) for windows, doors, siding and catalog pieces.
  // They assume the saved Timber Ridge Lodge layout and are skipped with --room.
  ...(roomId === 'great-hall'
    ? [
        { id: 'exterior-south', request: explicit([15, 4.2, 30], [1, 2.2, 10]) },
        { id: 'exterior-northwest', request: explicit([-22, 6, -26], [-2, 2.5, -4]) },
        { id: 'entry-door', request: explicit([-3.9, 1.6, 7.1], [1.6, 1.15, 12.9]) },
        { id: 'suite-windows', request: explicit([7.6, 1.6, -2.2], [15.5, 1.1, -7.2]) },
        { id: 'kitchen-dining', request: explicit([-7.6, 1.6, 5.5], [-13.5, 0.9, -2.5]) },
      ]
    : []),
];
function interior(angle: RenderRequest['angle']) {
  return renderRequestSchema.parse({
    view: 'interior',
    roomId,
    light: 'day',
    quality: 'live',
    angle,
  });
}
function explicit(position: [number, number, number], target: [number, number, number]) {
  return renderRequestSchema.parse({
    view: 'exterior',
    light: 'day',
    quality: 'live',
    angle: 'southeast',
    camera: { position, target },
  });
}

await mkdir(output, { recursive: true });
await writeFile(path.join(output, 'fixture.json'), JSON.stringify(scene, null, 2));
await new Promise<void>((resolve, reject) => {
  const probe = createServer();
  probe.once('error', () => reject(new Error(`Port ${port} is in use; pass --port.`)));
  probe.listen(port, '127.0.0.1', () =>
    probe.close((error) => (error ? reject(error) : resolve())),
  );
});
const logs: string[] = [];
const server = spawn(process.execPath, ['--import', 'tsx', 'scripts/scenario-server.ts'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    SCENARIO_RUN: `great-room-${port}`,
    SCENARIO_PORT: String(port),
    SCENARIO_HOST: '127.0.0.1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', (chunk) => logs.push(String(chunk)));
server.stderr.on('data', (chunk) => logs.push(String(chunk)));
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const evidence: Record<string, unknown> = { projectId, roomId, gpu, captures: [] };
try {
  let ready = false;
  for (let attempt = 0; attempt < 150 && !ready; attempt++) {
    if (server.exitCode !== null) throw new Error(`Scenario server exited: ${logs.join('')}`);
    try {
      const status = await (
        await fetch(`${base}/__verification`, { signal: AbortSignal.timeout(500) })
      ).json();
      ready = status.mode === 'simulated' && status.processId === server.pid;
    } catch {
      /* starting */
    }
    if (!ready) await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (!ready) throw new Error('Scenario server did not become ready.');
  const reset = await fetch(`${base}/__verification/reset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scene }),
  });
  if (!reset.ok) throw new Error(`Fixture reset failed: ${await reset.text()}`);
  browser = await chromium.launch({
    executablePath,
    headless: true,
    args: [
      '--no-sandbox',
      ...(gpu === 'swiftshader'
        ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']
        : ['--enable-gpu', '--ignore-gpu-blocklist']),
    ],
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  // tsx names nested callbacks with __name when serializing page functions.
  await context.addInitScript('globalThis.__name = (target) => target');
  await context.route('**/*', (route) =>
    new URL(route.request().url()).origin === base ? route.continue() : route.abort(),
  );
  const page = await context.newPage();
  const diagnostics: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning')
      diagnostics.push(`${message.type()}: ${message.text()}`);
  });
  page.on('pageerror', (error) => diagnostics.push(`pageerror: ${error.message}`));
  evidence.browserDiagnostics = diagnostics;
  const registered = page.waitForResponse(
    (response) =>
      response.url() === `${base}/api/render/clients` && response.request().method() === 'POST',
  );
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  const { clientId } = await (await registered).json();
  await page.locator('canvas').first().waitFor();
  await page.waitForTimeout(1500);
  evidence.webgl = await page
    .locator('canvas')
    .first()
    .evaluate((element) => {
      const gl = (element as HTMLCanvasElement).getContext('webgl2')!;
      const debug = gl.getExtension('WEBGL_debug_renderer_info');
      return debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    });
  for (const shot of shots) {
    if (only && !only.split(',').includes(shot.id)) continue;
    const started = Date.now();
    const response = await fetch(`${base}/__verification/render`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId, scene, request: shot.request }),
      signal: AbortSignal.timeout(120000),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(`Capture ${shot.id} failed: ${JSON.stringify(result)}`);
    if (result.sceneHash !== sceneFingerprint(scene))
      throw new Error(`Capture ${shot.id} is stale`);
    const png = await page.evaluate(async (dataUrl: string) => {
      const image = new Image();
      image.src = dataUrl;
      await image.decode();
      const target = document.createElement('canvas');
      target.width = image.width;
      target.height = image.height;
      target.getContext('2d')!.drawImage(image, 0, 0);
      return target.toDataURL('image/png');
    }, result.image);
    const filename = `${shot.id}.png`;
    await writeFile(path.join(output, filename), Buffer.from(png.split(',')[1], 'base64'));
    (evidence.captures as unknown[]).push({
      filename,
      request: shot.request,
      framing: renderCamera(scene, shot.request),
      elapsedMs: Date.now() - started,
    });
    console.log(path.join(output, filename));
  }
  // --gpu-bench times synchronous draws of the interactive canvas from fixed
  // cameras (no vsync involved): average milliseconds per frame, scene pass only.
  if (args.includes('--gpu-bench')) {
    const cameras = shots
      .filter((shot) => !only || only.split(',').includes(shot.id))
      .map((shot) => ({ id: shot.id, ...renderCamera(scene, shot.request) }));
    evidence.gpuBench = await page.evaluate(async (list) => {
      const resource = performance
        .getEntriesByType('resource')
        .find((entry) => entry.name.includes('/@react-three_fiber.js'));
      const fiber = await import(resource?.name || '/node_modules/.vite/deps/@react-three_fiber.js');
      const state = fiber._roots.get(document.querySelector('canvas'))?.store.getState();
      const { gl, scene, camera } = state;
      const context = gl.getContext();
      const pixel = new Uint8Array(4);
      const results = [];
      for (const view of list) {
        camera.position.set(...view.position);
        camera.fov = view.fov;
        camera.updateProjectionMatrix();
        camera.lookAt(...view.target);
        camera.updateMatrixWorld();
        const draw = () => {
          gl.render(scene, camera);
          context.readPixels(0, 0, 1, 1, context.RGBA, context.UNSIGNED_BYTE, pixel);
        };
        for (let i = 0; i < 10; i++) draw();
        // Five rounds; the lowest round median resists clock and scheduler noise.
        const all: number[] = [],
          medians: number[] = [];
        for (let round = 0; round < 5; round++) {
          const times: number[] = [];
          for (let i = 0; i < 30; i++) {
            const start = performance.now();
            draw();
            times.push(performance.now() - start);
          }
          times.sort((a, b) => a - b);
          medians.push(times[15]);
          all.push(...times);
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        all.sort((a, b) => a - b);
        results.push({
          id: view.id,
          best: Math.min(...medians),
          p50: all[Math.floor(all.length / 2)],
          p95: all[Math.floor(all.length * 0.95)],
          size: [context.drawingBufferWidth, context.drawingBufferHeight],
        });
      }
      return results;
    }, cameras);
    console.log(JSON.stringify(evidence.gpuBench));
  }
  // --restore-check screenshots the interactive canvas from an interior camera,
  // forces a WebGL context loss and restore, and screenshots it again.
  if (args.includes('--restore-check')) {
    const view = renderCamera(scene, interior('northwest'));
    const shoot = async (name: string) => {
      await page.evaluate(async (camera) => {
        const resource = performance
          .getEntriesByType('resource')
          .find((entry) => entry.name.includes('/@react-three_fiber.js'));
        const fiber = await import(resource?.name || '/node_modules/.vite/deps/@react-three_fiber.js');
        const state = fiber._roots.get(document.querySelector('canvas'))?.store.getState();
        state.camera.position.set(...camera.position);
        state.camera.fov = camera.fov;
        state.camera.updateProjectionMatrix();
        state.camera.lookAt(...camera.target);
        state.invalidate();
      }, view);
      await page.waitForTimeout(3000);
      await page.locator('canvas').first().screenshot({ path: path.join(output, name) });
    };
    await shoot('restore-before.png');
    await page.locator('canvas').first().evaluate((element) => {
      const gl = (element as HTMLCanvasElement).getContext('webgl2')!;
      const extension = gl.getExtension('WEBGL_lose_context')!;
      extension.loseContext();
      setTimeout(() => extension.restoreContext(), 1000);
    });
    await page.waitForTimeout(2500);
    await shoot('restore-after.png');
  }
  // --probe-report records the interactive canvas's per-room probe state.
  if (args.includes('--probe-report')) {
    evidence.probes = await page.evaluate(async () => {
      const resource = performance
        .getEntriesByType('resource')
        .find((entry) => entry.name.includes('/@react-three_fiber.js'));
      const fiber = await import(resource?.name || '/node_modules/.vite/deps/@react-three_fiber.js');
      const state = fiber._roots.get(document.querySelector('canvas'))?.store.getState();
      const system = state?.scene.userData.roomProbes;
      if (!system) return null;
      // A warm rerun separates capture cost from first-use shader compilation.
      const first = { ...system.timings, milliseconds: system.milliseconds };
      system.timings = { bounceDraw: 0, readback: 0, reflection: 0 };
      const before = system.milliseconds;
      system.reset();
      system.update(state.gl, state.scene);
      const warm = { ...system.timings, milliseconds: system.milliseconds - before };
      return {
        first,
        warm,
        captures: system.captures,
        milliseconds: system.milliseconds,
        converged: system.converged,
        timings: system.timings,
        drawCalls: state.gl.info.render.calls,
        rooms: system.lightings.map((lighting: any) => ({
          id: lighting.room.id,
          apertures: lighting.apertures.length,
          luminance: lighting.luminance,
          bounceL0: lighting.uniforms.roomBounce.value[0].toArray(),
          probe: lighting.bounds.probe.toArray(),
          grid: lighting.uniforms.roomGrid.value.toArray(),
          reflection: lighting.reflection.width,
        })),
      };
    });
    console.log(JSON.stringify(evidence.probes, null, 1));
  }
} finally {
  await writeFile(path.join(output, 'metadata.json'), JSON.stringify(evidence, null, 2));
  await writeFile(path.join(output, 'diagnostics.log'), logs.join(''));
  await browser?.close();
  if (server.exitCode === null) {
    await new Promise<void>((resolve) => {
      const force = setTimeout(() => server.kill('SIGKILL'), 3000);
      server.once('exit', () => {
        clearTimeout(force);
        resolve();
      });
      server.kill('SIGTERM');
    });
  }
}
