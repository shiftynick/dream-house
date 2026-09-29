function settle(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const channel = typeof MessageChannel === 'undefined' ? null : new MessageChannel();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      channel?.port1.close();
      channel?.port2.close();
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    };
    const abort = () => {
      cleanup();
      reject(signal.reason);
    };
    const finish = () => {
      cleanup();
      resolve();
    };
    signal.addEventListener('abort', abort, { once: true });
    if (channel) {
      channel.port1.onmessage = finish;
      channel.port2.postMessage(null);
    } else timer = setTimeout(finish, 0);
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
  // Tasks run after committed effects and avoid background timer clamping.
  // A second draw settles lazy environment and shadow-map resources.
  for (let pass = 0; pass < 2; pass++) {
    await settle(options.signal);
    options.signal.throwIfAborted();
    options.render();
  }
  options.signal.throwIfAborted();
  return options.capture();
}
