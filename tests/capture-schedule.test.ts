import test from 'node:test';
import assert from 'node:assert/strict';
import { captureAfterRender } from '../src/captureSchedule';

test('an unpainted tab can finish a capture without any animation frames', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'requestAnimationFrame');
  Object.defineProperty(globalThis, 'requestAnimationFrame', {
    configurable: true,
    value: () => {
      throw new Error('Browser animation frames are suspended.');
    },
  });
  try {
    let hasDrawn = false;
    const result = await captureAfterRender({
      signal: new AbortController().signal,
      render: () => {
        hasDrawn = true;
      },
      capture: () => {
        assert.equal(hasDrawn, true);
        return 'actual rendered pixels';
      },
    });
    assert.equal(result, 'actual rendered pixels');
  } finally {
    if (original) Object.defineProperty(globalThis, 'requestAnimationFrame', original);
    else delete (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame;
  }
});

test('cancelling a capture stops pending work and never reads or returns stale pixels', async () => {
  const controller = new AbortController();
  let captured = false;
  const reason = new Error('The draft changed.');
  await assert.rejects(
    captureAfterRender({
      signal: controller.signal,
      render: () => controller.abort(reason),
      capture: () => {
        captured = true;
        return 'stale';
      },
    }),
    (error) => error === reason,
  );
  assert.equal(captured, false);
});

test('renderer/context failures terminate capture instead of returning an empty success', async () => {
  let captured = false;
  await assert.rejects(
    captureAfterRender({
      signal: new AbortController().signal,
      render: () => {
        throw new Error('WebGL context lost');
      },
      capture: () => {
        captured = true;
        return '';
      },
    }),
    /context lost/,
  );
  assert.equal(captured, false);
});
