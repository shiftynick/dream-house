import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { canonicalScene } from '../shared/draft.ts';
import type { Scene } from '../shared/model.ts';
import {
  renderRequestSchema,
  renderCamera,
  type RenderRequest,
  type RenderJob,
  type RenderCaptureResult,
} from '../shared/render.ts';

export function sceneFingerprint(scene: Scene) {
  return createHash('sha256').update(canonicalScene(scene)).digest('hex');
}
export const captureResultSchema = z.object({
  image: z
    .string()
    .max(1_000_000)
    .regex(/^data:image\/(jpeg|png);base64,[A-Za-z0-9+/=]+$/),
  width: z.number().int().min(64).max(1536),
  height: z.number().int().min(64).max(1536),
  camera: z.object({
    position: z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]),
    target: z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]),
  }),
  sceneHash: z.string().regex(/^[a-f0-9]{64}$/),
  view: z.enum(['exterior', 'interior', 'cutaway', 'plan']),
});
export class RenderUnavailable extends Error {
  constructor(
    message = 'The local renderer is unavailable. Keep this house open in Terrain to render its views.',
  ) {
    super(message);
    this.name = 'RenderUnavailable';
  }
}
/** A future headless renderer can implement this interface without changing agent tools. */
export type RenderProvider = (
  scene: Scene,
  request: RenderRequest,
  signal?: AbortSignal,
) => Promise<RenderCaptureResult>;

export function validateCapture(
  scene: Scene,
  request: RenderRequest,
  input: unknown,
): RenderCaptureResult {
  const capture = captureResultSchema.parse(input);
  const expected = renderCamera(scene, request);
  if (
    capture.sceneHash !== sceneFingerprint(scene) ||
    capture.view !== request.view ||
    ['position', 'target'].some((key) =>
      capture.camera[key as 'position'].some(
        (v, i) => Math.abs(v - expected[key as 'position'][i]) > 0.00001,
      ),
    )
  )
    throw new RenderUnavailable('The capture does not match the requested draft, view and camera.');
  return capture;
}
type Client = { lastSeen: number };
type Pending = {
  job: RenderJob;
  clientId: string;
  resolve: (result: RenderCaptureResult) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
};

/** In-memory transport bridge to a local browser's offscreen renderer. No images touch disk. */
export class RenderBroker {
  private clients = new Map<string, Client>();
  private pending = new Map<string, Pending>();
  private waiters = new Map<string, () => void>();
  constructor(
    private timeoutMs = 60_000,
    private now: () => number = Date.now,
  ) {}
  register() {
    this.prune();
    if (this.clients.size >= 16)
      throw new RenderUnavailable('Too many local render clients. Close unused Terrain tabs.');
    const clientId = randomUUID();
    this.clients.set(clientId, { lastSeen: this.now() });
    return { clientId };
  }
  available(clientId?: string) {
    this.prune();
    return !!clientId && this.clients.has(clientId);
  }
  disconnect(clientId: string) {
    this.clients.delete(clientId);
    this.waiters.get(clientId)?.();
    for (const pending of [...this.pending.values()])
      if (pending.clientId === clientId)
        this.fail(
          pending,
          new RenderUnavailable('The local render tab disconnected. The draft was not applied.'),
        );
  }
  poll(clientId: string) {
    this.prune();
    const client = this.clients.get(clientId);
    if (!client) throw new RenderUnavailable();
    client.lastSeen = this.now();
    return { job: [...this.pending.values()].find((p) => p.clientId === clientId)?.job || null };
  }
  /** Wait for a queue change instead of relying on throttled browser timers.
   * The bounded wait refreshes the client lease even while a capture is running. */
  async waitForJob(clientId: string, afterId?: string, signal?: AbortSignal, waitMs = 10_000) {
    signal?.throwIfAborted();
    const current = this.poll(clientId);
    if (current.job?.id !== afterId && (current.job || afterId)) return current;
    if (this.waiters.has(clientId))
      throw new RenderUnavailable('This renderer already has an active job wait.');
    return new Promise<{ job: RenderJob | null }>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (this.waiters.get(clientId) === wake) this.waiters.delete(clientId);
      };
      const wake = () => {
        cleanup();
        try {
          resolve(this.poll(clientId));
        } catch (error) {
          reject(error);
        }
      };
      const abort = () => {
        cleanup();
        reject(signal?.reason || new Error('Render wait cancelled.'));
      };
      const timer = setTimeout(wake, Math.min(10_000, Math.max(1, waitMs)));
      this.waiters.set(clientId, wake);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
  }
  provider(clientId: string): RenderProvider {
    return (scene, request, signal) => this.render(clientId, scene, request, signal);
  }
  async render(
    clientId: string,
    scene: Scene,
    input: RenderRequest,
    signal?: AbortSignal,
  ): Promise<RenderCaptureResult> {
    if (!this.available(clientId)) throw new RenderUnavailable();
    signal?.throwIfAborted();
    const request = renderRequestSchema.parse(input);
    if (request.roomId && !scene.rooms.some((room) => room.id === request.roomId))
      throw new RenderUnavailable(
        'The requested room is not in this draft. Inspect its room IDs first.',
      );
    if (this.pending.size >= 16)
      throw new RenderUnavailable(
        'The local render queue is full. Try again after the current captures finish.',
      );
    const job: RenderJob = {
      id: randomUUID(),
      scene: structuredClone(scene),
      sceneHash: sceneFingerprint(scene),
      request,
    };
    return new Promise((resolve, reject) => {
      const abort = () =>
        this.fail(pending, new RenderUnavailable('The render request was cancelled.'));
      const timer = setTimeout(
        () =>
          this.fail(
            pending,
            new RenderUnavailable(
              'The local render timed out. Check that the Terrain tab is open and hardware rendering is enabled.',
            ),
          ),
        this.timeoutMs,
      );
      const pending: Pending = {
        job,
        clientId,
        resolve,
        reject,
        cleanup: () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
        },
      };
      this.pending.set(job.id, pending);
      this.waiters.get(clientId)?.();
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
  }
  submit(jobId: string, clientId: string, result?: unknown, error?: string) {
    this.prune();
    const pending = this.pending.get(jobId);
    if (!pending || pending.clientId !== clientId)
      throw new RenderUnavailable('This capture expired or belongs to a different renderer.');
    if (error) {
      this.fail(pending, new RenderUnavailable(error.slice(0, 600)));
      return;
    }
    const capture = validateCapture(pending.job.scene, pending.job.request, result);
    this.pending.delete(jobId);
    this.waiters.get(clientId)?.();
    pending.cleanup();
    pending.resolve(capture);
  }
  private fail(pending: Pending, error: Error) {
    if (!this.pending.delete(pending.job.id)) return;
    this.waiters.get(pending.clientId)?.();
    pending.cleanup();
    pending.reject(error);
  }
  private prune() {
    for (const [id, client] of this.clients)
      if (client.lastSeen < this.now() - 15_000) this.disconnect(id);
  }
}
