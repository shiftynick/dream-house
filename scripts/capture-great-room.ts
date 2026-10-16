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
