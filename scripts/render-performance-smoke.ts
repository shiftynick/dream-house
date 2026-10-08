import type { BrowserContext, Page } from 'playwright-core';

/** Count actual WebGL draw submissions on each canvas, without gl.finish or
 * altering render scheduling. Browser rAF cadence is measured separately. */
export async function installPerformanceProbe(context: BrowserContext) {
  // tsx preserves nested callback names with this harmless helper when serializing.
  await context.addInitScript('globalThis.__name = (target) => target');
  await context.addInitScript(() => {
    const counters = new WeakMap<HTMLCanvasElement, number>();
    (
      window as unknown as { terrainDrawCount: (canvas: HTMLCanvasElement) => number }
    ).terrainDrawCount = (canvas) => counters.get(canvas) || 0;
    for (const prototype of [WebGLRenderingContext.prototype, WebGL2RenderingContext.prototype]) {
      for (const name of [
        'drawArrays',
        'drawElements',
        'drawArraysInstanced',
        'drawElementsInstanced',
      ]) {
        if (!Object.prototype.hasOwnProperty.call(prototype, name)) continue;
        const record = prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
        const draw = record[name];
        if (!draw) continue;
        record[name] = function (this: WebGLRenderingContext, ...args: unknown[]) {
          if (this.canvas instanceof HTMLCanvasElement)
            counters.set(this.canvas, (counters.get(this.canvas) || 0) + 1);
          return draw.apply(this, args);
        };
      }
    }
  });
}

export async function runPerformanceSmoke(
  page: Page,
  onProgress?: (result: unknown) => Promise<void>,
) {
  const phases: unknown[] = [];
  const durationMs = 3000;
  const canvas = page.locator('canvas').first();
  await page.evaluate(async () => {
    const resource = performance
      .getEntriesByType('resource')
      .find((entry) => entry.name.includes('/@react-three_fiber.js'));
    const fiber = await import(resource?.name || '/node_modules/.vite/deps/@react-three_fiber.js');
    (window as unknown as { terrainCamera: () => unknown }).terrainCamera = () => {
      const state = fiber._roots.get(document.querySelector('canvas'))?.store.getState();
      if (!state) throw new Error('Cannot inspect active R3F camera');
      return {
        position: state.camera.position.toArray(),
        quaternion: state.camera.quaternion.toArray(),
        lastRendererDrawCalls: state.gl.info.render.calls,
        frameloop: state.frameloop,
      };
    };
  });
  async function releasePointer() {
    await page.evaluate(() => document.exitPointerLock());
    await page.waitForFunction(() => !document.pointerLockElement);
  }
  async function cameraSnapshot() {
    return await page.evaluate(() =>
      (
        window as unknown as { terrainCamera: () => { position: number[]; quaternion: number[] } }
      ).terrainCamera(),
    );
  }

  async function measure(
    name: string,
    orbit = false,
    initialCamera?: Awaited<ReturnType<typeof cameraSnapshot>>,
  ) {
    const cameraBefore = initialCamera || (await cameraSnapshot());
    const result = await page.evaluate(
      async ({ durationMs, orbit, initialPosition }) => {
        const canvas = document.querySelector('canvas')!;
        const count = (
          window as unknown as { terrainDrawCount: (canvas: HTMLCanvasElement) => number }
        ).terrainDrawCount;
        const bounds = canvas.getBoundingClientRect();
        const began = performance.now();
        const initial = count(canvas);
        const datasetBefore = { ...canvas.dataset };
        const camera = (window as unknown as { terrainCamera: () => { position: number[] } })
          .terrainCamera;
        let previousPosition = initialPosition,
          maxCameraStep = 0,
          cameraMotionFrames = 0,
          pointerLockedFrames = 0;
        const rafIntervals: number[] = [],
          drawIntervals: number[] = [];
        let previous = began,
          previousDraw = began,
          previousCount = initial,
          rafs = 0,
          renderedFrames = 0;
        return await new Promise<Record<string, unknown>>((resolve) => {
          function frame(now: number) {
            const position = camera().position;
            const step = Math.hypot(
              ...position.map((value, index) => value - previousPosition[index]),
            );
            maxCameraStep = Math.max(maxCameraStep, step);
            if (step > 0.0001) cameraMotionFrames++;
            if (document.pointerLockElement === canvas) pointerLockedFrames++;
            previousPosition = position;
            rafs++;
            if (rafs > 1) rafIntervals.push(now - previous);
            previous = now;
            const currentCount = count(canvas);
            if (currentCount > previousCount) {
              renderedFrames++;
              if (renderedFrames > 1) drawIntervals.push(now - previousDraw);
              previousDraw = now;
            }
            previousCount = currentCount;
            if (orbit)
              canvas.dispatchEvent(
                new PointerEvent('pointermove', {
                  pointerId: 1,
                  pointerType: 'mouse',
                  buttons: 1,
                  clientX: bounds.x + bounds.width / 2 + Math.sin((now - began) / 400) * 80,
                  clientY: bounds.y + bounds.height / 2 + Math.cos((now - began) / 500) * 35,
                  bubbles: true,
                }),
              );
            if (now - began < durationMs) requestAnimationFrame(frame);
            else {
              const quantile = (values: number[], q: number) => {
                const sorted = [...values].sort((a, b) => a - b);
                return sorted.length ? sorted[Math.floor((sorted.length - 1) * q)] : null;
              };
              resolve({
                elapsedMs: now - began,
                maxCameraStep,
                cameraMotionFrames,
                pointerLockedFrames,
                rafs,
                renderedFrames,
                drawCalls: count(canvas) - initial,
                browserFrameIntervalMs: {
                  p50: quantile(rafIntervals, 0.5),
                  p95: quantile(rafIntervals, 0.95),
                },
                submittedDrawFrameIntervalMs: {
                  p50: quantile(drawIntervals, 0.5),
                  p95: quantile(drawIntervals, 0.95),
                },
                datasetBefore,
                dataset: { ...canvas.dataset },
                canvasSize: [canvas.width, canvas.height],
              });
            }
          }
          requestAnimationFrame(frame);
        });
      },
      { durationMs, orbit, initialPosition: cameraBefore.position },
    );
    await page.waitForTimeout(300);
    const cameraAfter = await cameraSnapshot();
    const distance = Math.hypot(
      ...cameraAfter.position.map((value, index) => value - cameraBefore.position[index]),
    );
    const rotationChange = Math.hypot(
      ...cameraAfter.quaternion.map((value, index) => value - cameraBefore.quaternion[index]),
    );
    phases.push({ name, ...result, cameraBefore, cameraAfter, distance, rotationChange });
    if (name.includes('active') && distance < 0.01 && rotationChange < 0.001)
      throw new Error(`${name}: input did not move camera`);
    if (name.includes('walk') && Number(result.maxCameraStep) > 1)
      throw new Error(`${name}: unexpected camera teleport`);
    await onProgress?.({ durationMs, phases });
  }
  const quality = page.getByLabel('Render quality', { exact: true });
  const available = await quality
    .locator('option')
    .evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value));
  for (const mode of ['live', 'refined'].filter((mode) => available.includes(mode))) {
    await releasePointer();
    await page.getByRole('button', { name: 'Explore', exact: true }).click();
    await quality.selectOption(mode);
    await page.getByRole('button', { name: 'Reset camera', exact: true }).click();
    if (mode === 'refined') {
      try {
        await page.waitForFunction(
          () =>
            document.querySelector('canvas')?.dataset.renderMode === 'realtime' ||
            Number(document.querySelector('canvas')?.dataset.renderSamples) >= 1 ||
            !!document.querySelector('canvas')?.dataset.renderError,
          undefined,
          { timeout: 60000 },
        );
      } catch {
        phases.push({ name: 'refined-startup', reachedSample: false });
      }
    }
    await page.waitForTimeout(2000);
    await measure(`${mode}-idle`);
    const bounds = await canvas.boundingBox();
    if (!bounds) throw new Error('Missing canvas bounds');
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await page.mouse.down();
    try {
      await measure(`${mode}-active-orbit`, true);
    } finally {
      await page.mouse.up();
    }
    await page.getByRole('button', { name: 'Walk through', exact: true }).click();
    await page.waitForTimeout(2000);
    await canvas.click();
    await page.waitForFunction(
      () => document.pointerLockElement === document.querySelector('canvas'),
      undefined,
      { timeout: 5000 },
    );
    await page.waitForTimeout(300);
    await page.waitForFunction(
      () => document.pointerLockElement === document.querySelector('canvas'),
    );
    const beforeWalking = await cameraSnapshot();
    await page.keyboard.down('w');
    try {
      await measure(`${mode}-active-walk`, false, beforeWalking);
    } finally {
      await page.keyboard.up('w');
      await page.keyboard.press('Escape');
      await releasePointer();
    }
  }
  await releasePointer();
  await quality.selectOption('live');
  await page.getByRole('button', { name: 'Explore', exact: true }).click();
  await page.getByRole('button', { name: 'Reset camera', exact: true }).click();
  return {
    durationMs,
    phases,
    interpretation:
      'Browser rAF intervals and WebGL draw submission cadence on the actual browser GPU. These are not completed GPU timings or guaranteed display FPS; monitoring adds one lightweight rAF callback. Idle monitoring itself runs rAF but does not force application draws.',
  };
}
