/** Deterministic no-cloud image evidence. Own server and synthetic storage only. */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { installPerformanceProbe, runPerformanceSmoke } from './render-performance-smoke.ts';
import { cabinScene } from './scenarios.ts';
import { sceneSchema } from '../shared/model.ts';
import { sceneFingerprint } from '../server/render-service.ts';
import { renderCamera, renderRequestSchema } from '../shared/render.ts';
import { materialStudyCaptures } from './material-study-fixtures.ts';

const args = process.argv.slice(2);
function option(name: string, fallback: string) {
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1] || fallback;
}
const port = Number(option('--port', '5186'));
if (!Number.isInteger(port) || port < 1024 || port > 45000 || port === 5174 || port === 5173)
  throw new Error(
    'Choose a verification port between 1024 and 45000; production ports are forbidden.',
  );
const base = `http://127.0.0.1:${port}`;
const output = path.resolve(option('--out', '.data/verification/render-fidelity/evidence/latest'));
const executablePath = option('--chromium', '/usr/bin/chromium');
const refined = args.includes('--refined');
const lifecycleSmoke = args.includes('--lifecycle-smoke');
const performanceSmoke = args.includes('--performance-smoke');
const performanceOrder = option('--performance-order', 'live-first');
if (!['live-first', 'presentation-first'].includes(performanceOrder))
  throw new Error('Use --performance-order live-first or presentation-first.');
const interiorStudy = args.includes('--interior-study');
const materialStudy = args.includes('--material-study');
if (materialStudy && (interiorStudy || lifecycleSmoke || performanceSmoke || refined))
  throw new Error(
    '--material-study is a focused capture run; use it without other study/smoke flags.',
  );
const gpu = option('--gpu', 'swiftshader');
if (!['swiftshader', 'hardware'].includes(gpu))
  throw new Error('Use --gpu swiftshader or --gpu hardware.');
const refinedTimeout = Number(option('--refined-wait-ms', '60000'));
const refinedSamples = Number(option('--refined-samples', '8'));
if (
  !Number.isFinite(refinedTimeout) ||
  refinedTimeout < 1000 ||
  !Number.isInteger(refinedSamples) ||
  refinedSamples < 1 ||
  refinedSamples > 96
)
  throw new Error('Use --refined-wait-ms >= 1000 and --refined-samples between 1 and 96.');
const logs: string[] = [];
async function rendererSourceHashes() {
  const files = [
    'src/App.tsx',
    'src/SceneView.tsx',
    'src/RenderCapture.tsx',
    'src/renderMeshes.ts',
    'src/renderGeometry.ts',
    'src/renderFurniture.tsx',
    'src/renderMaterials.ts',
    'src/renderLighting.ts',
    'src/roomDaylight.ts',
    'src/architecturalFinish.ts',
    'src/rasterRenderer.ts',
    'src/renderPerformance.ts',
    'src/gpuSchedule.ts',
    'src/pathTraceWorker.ts',
    'src/bvh.worker.ts',
    'src/retainedResource.ts',
    'src/captureSchedule.ts',
    'shared/model.ts',
    'shared/render.ts',
    'shared/architecture.ts',
    'shared/openings.ts',
    'shared/furniture.ts',
    'shared/selection.ts',
    'shared/geometry.ts',
    'shared/design.ts',
    'shared/spatial.ts',
    'package-lock.json',
    'scripts/capture-render-fidelity.ts',
    'scripts/material-study-fixtures.ts',
  ];
  const result: Record<string, string> = {};
  for (const file of files) {
    try {
      result[file] = createHash('sha256')
        .update(await readFile(file))
        .digest('hex');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return result;
}
const evidence: Record<string, unknown> = {
  viewport: { width: 1440, height: 1000 },
  deviceScaleFactor: 1,
  requestedGpu: gpu,
  light: 'day',
  executablePath,
  rendererSourceHashes: await rendererSourceHashes(),
  captures: [],
};
if (path.basename(output) === 'baseline' && !args.includes('--overwrite')) {
  let exists = false;
  try {
    await access(path.join(output, 'metadata.json'));
    exists = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (exists)
    throw new Error(
      'Historical baseline evidence already exists. Choose a fresh --out directory, or explicitly use --overwrite.',
    );
}
await mkdir(output, { recursive: true });
// Probe the socket instead of identifying arbitrary existing HTTP listeners.
await new Promise<void>((resolve, reject) => {
  const probe = createServer();
  probe.once('error', () =>
    reject(new Error(`Port ${port} already has a listener; choose --port with a free port.`)),
  );
  probe.listen(port, '127.0.0.1', () =>
    probe.close((error) => (error ? reject(error) : resolve())),
  );
});
const server = spawn(process.execPath, ['--import', 'tsx', 'scripts/scenario-server.ts'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    SCENARIO_RUN: `render-fidelity-${port}`,
    SCENARIO_PORT: String(port),
    SCENARIO_HOST: '127.0.0.1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', (chunk) => logs.push(String(chunk)));
server.stderr.on('data', (chunk) => logs.push(String(chunk)));
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let browserLaunching: ReturnType<typeof chromium.launch> | undefined;
let cleanupPromise: Promise<void> | undefined;
function cleanup() {
  if (!cleanupPromise)
    cleanupPromise = (async () => {
      try {
        const ownedBrowser = browser || (await browserLaunching?.catch(() => undefined));
        await ownedBrowser?.close();
      } finally {
        if (server.exitCode === null && server.signalCode === null) {
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
    })();
  return cleanupPromise;
}
for (const [signal, exitCode] of [
  ['SIGINT', 130],
  ['SIGTERM', 143],
] as const) {
  process.once(signal, () => {
    evidence.interrupted = signal;
    void (async () => {
      try {
        await writeFile(path.join(output, 'metadata.json'), JSON.stringify(evidence, null, 2));
        await writeFile(path.join(output, 'diagnostics.log'), logs.join(''));
      } finally {
        await cleanup();
        process.exit(exitCode);
      }
    })();
  });
}
try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server.exitCode !== null)
      throw new Error(`Scenario server exited ${server.exitCode}: ${logs.join('')}`);
    try {
      const response = await fetch(`${base}/__verification`, { signal: AbortSignal.timeout(500) });
      const status = await response.json();
      if (status.mode === 'simulated' && status.processId === server.pid) {
        ready = true;
        break;
      }
    } catch {
      /* startup */
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (!ready) throw new Error('Scenario server did not become ready.');
  const scene = materialStudy ? materialStudyCaptures()[0].scene : cabinScene();
  if (!materialStudy) {
    scene.name = 'Render fidelity cabin';
    scene.rooms.find((room) => room.id === 'living')!.furniture = [
      {
        id: 'sofa',
        name: 'Sofa',
        kind: 'sofa',
        x: -1.2,
        z: -1.5,
        rotation: 0,
        width: 2.8,
        depth: 1,
        height: 0.85,
        palette: 'chalk',
      },
      {
        id: 'table',
        name: 'Coffee table',
        kind: 'coffee-table',
        x: -1.2,
        z: 0,
        rotation: 0,
        width: 1.5,
        depth: 0.8,
        height: 0.42,
        palette: 'cedar',
      },
      {
        id: 'rug',
        name: 'Rug',
        kind: 'rug',
        x: -1.2,
        z: -0.2,
        rotation: 0,
        width: 3.6,
        depth: 2.8,
        height: 0.025,
        palette: 'limestone',
      },
      {
        id: 'chair',
        name: 'Armchair',
        kind: 'armchair',
        x: 1.5,
        z: -1.2,
        rotation: -30,
        width: 0.9,
        depth: 0.9,
        height: 0.9,
        palette: 'charcoal',
      },
    ];
  }
  sceneSchema.parse(scene);
  await writeFile(path.join(output, 'fixture.json'), JSON.stringify(scene, null, 2));
  const reset = await fetch(`${base}/__verification/reset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scene }),
  });
  if (!reset.ok) throw new Error(`Fixture reset failed: ${await reset.text()}`);
  browserLaunching = chromium.launch({
    executablePath,
    headless: true,
    handleSIGINT: false,
    handleSIGTERM: false,
    args: [
      '--no-sandbox',
      ...(gpu === 'swiftshader'
        ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']
        : ['--enable-gpu', '--ignore-gpu-blocklist']),
    ],
  });
  browser = await browserLaunching;
  evidence.browserVersion = browser.version();
  const context = await browser.newContext({
    viewport: evidence.viewport as { width: number; height: number },
    deviceScaleFactor: 1,
  });
  if (performanceSmoke) await installPerformanceProbe(context);
  await context.route('**/*', (route) =>
    new URL(route.request().url()).origin === base ? route.continue() : route.abort(),
  );
  const page = await context.newPage();
  const browserDiagnostics: { type: string; message: string }[] = [];
  evidence.browserDiagnostics = browserDiagnostics;
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      browserDiagnostics.push({ type: message.type(), message: message.text() });
      logs.push(`browser ${message.type()}: ${message.text()}\n`);
    }
  });
  const pageExceptions: string[] = [];
  page.on('pageerror', (error) => {
    pageExceptions.push(error.message);
    logs.push(`pageerror: ${error.message}\n`);
  });
  const registered = page.waitForResponse(
    (response) =>
      response.url() === `${base}/api/render/clients` && response.request().method() === 'POST',
  );
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame())
      evidence.invalidatedByNavigation = { url: frame.url(), at: new Date().toISOString() };
  });
  function assertStablePage() {
    if (evidence.invalidatedByNavigation)
      throw new Error(
        'Capture invalidated by unexpected page navigation/reload; rerun without editing files served by Vite.',
      );
  }
  const { clientId } = await (await registered).json();
  const canvas = page.locator('canvas').first();
  await canvas.waitFor();
  await page.waitForTimeout(1500);
  evidence.webgl = await canvas.evaluate((element) => {
    const canvas = element as HTMLCanvasElement;
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    if (!gl) throw new Error('No WebGL context');
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      renderer: gl.getParameter(gl.RENDERER),
      vendor: gl.getParameter(gl.VENDOR),
      version: gl.getParameter(gl.VERSION),
      unmaskedRenderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null,
    };
  });
  evidence.initialRendererDiagnostics = await canvas.evaluate((element) => ({
    ...(element as HTMLCanvasElement).dataset,
  }));
  const captureTasks = materialStudy
    ? materialStudyCaptures()
    : ['exterior', 'interior'].map((view) => ({
        filename: `${view}-live.png`,
        scene,
        request: renderRequestSchema.parse({
          view,
          ...(view === 'interior' ? { roomId: 'living' } : {}),
          light: 'day',
          quality: 'live',
          angle: 'southeast',
        }),
      }));
  if (interiorStudy) {
    // Interior broker framing intentionally uses angle, not request.camera (ignored for interiors).
    const viewpoints = [
      { id: 'wide', angle: 'southeast' },
      { id: 'windows', angle: 'northwest' },
      { id: 'seating', angle: 'northeast' },
    ] as const;
    for (const viewpoint of viewpoints)
      for (const light of ['day', 'golden', 'evening'] as const)
        captureTasks.push({
          filename: `study-${viewpoint.id}-${light}.png`,
          scene,
          request: renderRequestSchema.parse({
            view: 'interior',
            roomId: 'living',
            quality: 'live',
            angle: viewpoint.angle,
            light,
          }),
        });
    const sealed = structuredClone(scene);
    const room = sealed.rooms.find((item) => item.id === 'living')!;
    room.wallOpenings = [];
    room.north = room.south = room.east = room.west = 'solid';
    sealed.design!.connections = sealed.design!.connections.filter(
      (connection) => connection.roomAId !== 'living' && connection.roomBId !== 'living',
    );
    sceneSchema.parse(sealed);
    await writeFile(path.join(output, 'fixture-sealed.json'), JSON.stringify(sealed, null, 2));
    for (const light of ['day', 'evening'] as const)
      captureTasks.push({
        filename: `study-sealed-${light}.png`,
        scene: sealed,
        request: renderRequestSchema.parse({
          view: 'interior',
          roomId: 'living',
          quality: 'live',
          angle: 'southeast',
          light,
        }),
      });
    evidence.interiorStudy = {
      viewpoints,
      lights: ['day', 'golden', 'evening'],
      sealedControl:
        'All living-room wall openings and connections removed; four wall sides solid. No new artificial lights.',
      schedule:
        'Broker waits committed effects and performs two bounded explicit renders before reading pixels.',
      samplesAre: 'JPEG broker output converted to PNG; not ground-truth illumination.',
    };
  }
  for (const task of captureTasks) {
    const { request, filename, scene: captureScene } = task;
    if (materialStudy)
      await writeFile(
        path.join(output, filename.replace('.png', '.scene.json')),
        JSON.stringify(captureScene, null, 2),
      );
    const response = await fetch(`${base}/__verification/render`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId, scene: captureScene, request }),
      signal: AbortSignal.timeout(45000),
    });
    const result = await response.json();
    assertStablePage();
    if (!response.ok) throw new Error(`Capture ${filename} failed: ${JSON.stringify(result)}`);
    if (result.sceneHash !== sceneFingerprint(captureScene))
      throw new Error(`Capture ${filename} has stale scene fingerprint`);
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
    await writeFile(path.join(output, filename), Buffer.from(png.split(',')[1], 'base64'));
    const { image: _image, ...metadata } = result;
    (evidence.captures as unknown[]).push({
      filename,
      request,
      ...metadata,
      framing: renderCamera(captureScene, request),
      source: 'local render broker (JPEG converted to PNG)',
    });
    await writeFile(path.join(output, 'metadata.json'), JSON.stringify(evidence, null, 2));
    console.log(path.join(output, filename));
  }
  if (materialStudy && (pageExceptions.length || browserDiagnostics.length))
    throw new Error(
      `Material study browser diagnostics: ${JSON.stringify({ pageExceptions, browserDiagnostics })}`,
    );
  async function saveCanvas(filename: string) {
    assertStablePage();
    const frame = await canvas.evaluate((element) => {
      const target = element as HTMLCanvasElement;
      return { png: target.toDataURL('image/png'), dataset: { ...target.dataset } };
    });
    await writeFile(path.join(output, filename), Buffer.from(frame.png.split(',')[1], 'base64'));
    return frame.dataset;
  }
  // Interactive Refined is deliberately optional: broker only supports raster modes.
  if (refined) {
    for (const view of ['exterior', 'interior'] as const) {
      await page
        .getByRole('button', {
          name: view === 'exterior' ? 'Explore' : 'Walk through',
          exact: true,
        })
        .click();
      await page.getByRole('button', { name: 'Daylight', exact: true }).click();
      await page.getByLabel('Render quality', { exact: true }).selectOption('live');
      await page.getByRole('button', { name: 'Reset camera', exact: true }).click();
      await page.waitForTimeout(800);
      await saveCanvas(`${view}-viewport-live.png`);
      await canvas.evaluate((element) => {
        const dataset = (element as HTMLCanvasElement).dataset;
        for (const key of Object.keys(dataset)) if (key.startsWith('render')) delete dataset[key];
      });
      await page.getByLabel('Render quality', { exact: true }).selectOption('refined');
      let reachedSamples = true;
      try {
        await page.waitForFunction(
          (target) => {
            const dataset = (document.querySelector('canvas') as HTMLCanvasElement | null)?.dataset;
            return (
              !!dataset?.renderError ||
              (dataset?.renderMode === 'realtime' && dataset?.renderStatus === 'ready') ||
              (!!dataset?.renderBuildMs && Number(dataset.renderSamples) >= target)
            );
          },
          refinedSamples,
          { timeout: refinedTimeout },
        );
      } catch {
        reachedSamples = false;
      }
      const filename = `${view}-viewport-refined.png`;
      const dataset = await saveCanvas(filename);
      reachedSamples =
        reachedSamples &&
        !dataset.renderError &&
        dataset.renderCompiling !== 'true' &&
        Number(dataset.renderSamples) >= refinedSamples;
      const renderOutcome = dataset.renderError
        ? 'raster-fallback'
        : dataset.renderMode === 'realtime'
          ? 'raster-presentation'
          : reachedSamples
            ? 'path-traced'
            : 'refinement-incomplete';
      const canvasBounds = await canvas.boundingBox();
      (evidence.captures as unknown[]).push({
        filename,
        view,
        source: 'interactive canvas framebuffer PNG',
        reachedSamples,
        renderOutcome,
        targetSamples: dataset.renderMode === 'realtime' ? null : refinedSamples,
        dataset,
        camera:
          view === 'interior'
            ? { position: [0, 1.7, 2], target: [0, 1.7, -5], fov: 43 }
            : renderCamera(
                scene,
                renderRequestSchema.parse({ view: 'exterior' }),
                canvasBounds ? canvasBounds.width / canvasBounds.height : 4 / 3,
              ),
        canvasBounds,
      });
      await writeFile(path.join(output, 'metadata.json'), JSON.stringify(evidence, null, 2));
      console.log(`${path.join(output, filename)} (${JSON.stringify(dataset)})`);
    }
  }
  if (performanceSmoke) {
    evidence.performanceSmoke = await runPerformanceSmoke(
      page,
      async (result) => {
        evidence.performanceSmoke = result;
        await writeFile(path.join(output, 'metadata.json'), JSON.stringify(evidence, null, 2));
      },
      performanceOrder === 'presentation-first' ? ['refined', 'live'] : ['live', 'refined'],
    );
    assertStablePage();
    await writeFile(path.join(output, 'metadata.json'), JSON.stringify(evidence, null, 2));
    console.log('Performance smoke recorded');
  }
  if (lifecycleSmoke) {
    const smoke: Record<string, unknown> = { steps: [], pageExceptions };
    evidence.lifecycleSmoke = smoke;
    const steps = smoke.steps as unknown[];
    async function measuredEdit(stage: string, action: () => Promise<unknown>) {
      await page.waitForTimeout(400);
      const before = await canvas.evaluate((element) => ({
        at: performance.now(),
        frames: Number((element as HTMLCanvasElement).dataset.renderFrames),
        shadows: Number((element as HTMLCanvasElement).dataset.renderShadowUpdates),
      }));
      await action();
      await page.waitForFunction(
        (previous) => {
          const target = document.querySelector('canvas');
          return (
            target?.dataset.renderStatus === 'ready' &&
            Number(target.dataset.renderFrames) > previous.frames &&
            Number(target.dataset.renderShadowUpdates) > previous.shadows
          );
        },
        before,
        { timeout: 10000, polling: 'raf' },
      );
      const after = await canvas.evaluate((element) => ({
        at: performance.now(),
        dataset: { ...(element as HTMLCanvasElement).dataset },
      }));
      steps.push({
        stage: `${stage}-edit-ready`,
        observedMilliseconds: after.at - before.at,
        before,
        after,
        definition:
          'Browser timestamp before Playwright action to observed ready frame plus cached-shadow refresh; includes automation and polling overhead, not GPU completion.',
      });
    }
    async function healthy(stage: string) {
      await page.waitForTimeout(400);
      assertStablePage();
      const result = await canvas.evaluate((element) => {
        const target = element as HTMLCanvasElement;
        const gl = target.getContext('webgl2') || target.getContext('webgl');
        if (!gl || gl.isContextLost()) throw new Error('Renderer context is lost');
        const pixel = new Uint8Array(4);
        gl.readPixels(
          Math.floor(target.width / 2),
          Math.floor(target.height / 2),
          1,
          1,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          pixel,
        );
        return {
          dimensions: [target.width, target.height],
          centerPixel: Array.from(pixel),
          dataset: { ...target.dataset },
        };
      });
      if (result.centerPixel[3] === 0) throw new Error(`${stage}: empty framebuffer`);
      steps.push({ stage, ...result });
      await saveCanvas(`smoke-${stage}.png`);
      return result;
    }
    await page.getByRole('button', { name: 'Explore', exact: true }).click();
    for (const quality of ['live', 'clay', 'wireframe'] as const) {
      await page.getByLabel('Render quality', { exact: true }).selectOption(quality);
      if ((await page.getByLabel('Render quality', { exact: true }).inputValue()) !== quality)
        throw new Error('Quality control did not switch');
      await healthy(quality);
    }
    await page.getByRole('button', { name: 'Floor plan', exact: true }).click();
    await page.getByRole('button', { name: 'Sofa in Living and kitchen', exact: true }).click();
    if ((await page.getByLabel('Selected furniture', { exact: true }).inputValue()) !== 'sofa')
      throw new Error('Plan furniture picking failed');
    steps.push({ stage: 'plan', selectedFurniture: 'sofa' });
    await page.getByRole('button', { name: 'Explore', exact: true }).click();
    const selectedRoomLabel = page.locator('.room-label');
    await selectedRoomLabel.waitFor({ state: 'visible' });
    if (!(await selectedRoomLabel.textContent())?.includes('Living and kitchen'))
      throw new Error('Selected room label missing after Plan to Explore');
    steps.push({ stage: 'selected-room-label', text: await selectedRoomLabel.textContent() });
    await page.getByLabel('Render quality', { exact: true }).selectOption('refined');
    await page.waitForTimeout(250);
    await page.getByLabel('Render quality', { exact: true }).selectOption('live');
    await healthy('refined-cancelled-to-live');
    await page.setViewportSize({ width: 1200, height: 850 });
    const resized = await healthy('resized');
    await measuredEdit('lighting', () =>
      page.getByRole('button', { name: 'Golden hour', exact: true }).click(),
    );
    const relit = await healthy('golden-hour');
    if (
      Number(resized.dataset.renderShadowUpdates) &&
      Number(relit.dataset.renderShadowUpdates) <= Number(resized.dataset.renderShadowUpdates)
    )
      throw new Error('Light change did not refresh cached shadows');
    await page.getByRole('button', { name: 'Daylight', exact: true }).click();
    await page.getByLabel('Selected house part', { exact: true }).selectOption('room');
    await measuredEdit('palette', () =>
      page
        .locator('label.field-label')
        .filter({ hasText: 'Room material' })
        .locator('select')
        .selectOption('limestone'),
    );
    await healthy('palette-edit');
    await page.getByLabel('Selected furniture', { exact: true }).selectOption('sofa');
    await page.getByLabel('Furniture x', { exact: true }).fill('-1');
    await measuredEdit('furniture', () =>
      page.getByRole('button', { name: 'Apply furniture', exact: true }).click(),
    );
    await healthy('furniture-edit');
    let updatedScene = scene;
    for (let attempt = 0; attempt < 30; attempt++) {
      const project = await (await fetch(`${base}/api/project`)).json();
      if (
        project.scene.rooms
          .find(
            (room: { id: string; furniture?: { id: string; x: number }[] }) => room.id === 'living',
          )
          ?.furniture?.find((item: { id: string; x: number }) => item.id === 'sofa')?.x === -1
      ) {
        updatedScene = sceneSchema.parse(project.scene);
        break;
      }
      await page.waitForTimeout(100);
    }
    if (sceneFingerprint(updatedScene) === sceneFingerprint(scene))
      throw new Error('Furniture edit did not persist changed geometry');
    steps.push({ stage: 'edited-project-saved', sceneHash: sceneFingerprint(updatedScene) });
    const contextLossSupported = await canvas.evaluate((element) => {
      const target = element as HTMLCanvasElement;
      const gl = target.getContext('webgl2') || target.getContext('webgl');
      const extension = gl?.getExtension('WEBGL_lose_context');
      if (!extension) return false;
      extension.loseContext();
      setTimeout(() => extension.restoreContext(), 2000);
      return true;
    });
    smoke.contextLossSupported = contextLossSupported;
    if (contextLossSupported) {
      await page.waitForFunction(
        () => {
          const target = document.querySelector('canvas');
          return (target?.getContext('webgl2') || target?.getContext('webgl'))?.isContextLost();
        },
        undefined,
        { timeout: 1000 },
      );
      steps.push({ stage: 'context-lost' });
      await page.waitForFunction(
        () => {
          const target = document.querySelector('canvas');
          const gl = target?.getContext('webgl2') || target?.getContext('webgl');
          return !!gl && !gl.isContextLost();
        },
        undefined,
        { timeout: 10000 },
      );
      await healthy('context-restored');
      await measuredEdit('post-restore-lighting', () =>
        page.getByRole('button', { name: 'Golden hour', exact: true }).click(),
      );
      await healthy('post-restore-relit');
      const response = await fetch(`${base}/__verification/render`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientId,
          scene: updatedScene,
          request: { view: 'interior', roomId: 'living', quality: 'live', light: 'day' },
        }),
        signal: AbortSignal.timeout(45000),
      });
      const result = await response.json();
      assertStablePage();
      if (!response.ok || !result.image || result.sceneHash !== sceneFingerprint(updatedScene))
        throw new Error(`Capture after context restore failed: ${JSON.stringify(result)}`);
      steps.push({
        stage: 'broker-after-restore',
        width: result.width,
        height: result.height,
        sceneHash: result.sceneHash,
      });
    }
    if (pageExceptions.length)
      throw new Error(`Lifecycle page exceptions: ${pageExceptions.join('; ')}`);
    if (browserDiagnostics.length)
      throw new Error(
        `Lifecycle browser diagnostics: ${browserDiagnostics.map((entry) => entry.message).join('; ')}`,
      );
    smoke.passed = true;
    console.log('Lifecycle smoke passed');
  }
  assertStablePage();
} catch (error) {
  evidence.error = error instanceof Error ? error.stack : String(error);
  throw error;
} finally {
  try {
    evidence.rendererSourceChangedDuringCapture =
      JSON.stringify(evidence.rendererSourceHashes) !==
      JSON.stringify(await rendererSourceHashes());
    await writeFile(path.join(output, 'metadata.json'), JSON.stringify(evidence, null, 2));
    await writeFile(path.join(output, 'diagnostics.log'), logs.join(''));
  } finally {
    await cleanup();
  }
}
