function settle(delay: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, delay);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

/** Capture has its own bounded rendering schedule. It must not depend on rAF:
 * Chromium can stop painting an offscreen tab while its network/timers still run. */
export async function captureAfterRender<T>(options: {
  signal: AbortSignal;
  render: () => void;
  capture: () => T;
}): Promise<T> {
  // The first timer runs after the committed scene's effects installed lighting.
  // A second draw settles lazy material/environment and shadow-map resources.
  for (const delay of [0, 25]) {
    await settle(delay, options.signal);
    options.signal.throwIfAborted();
    options.render();
  }
  options.signal.throwIfAborted();
  return options.capture();
}
