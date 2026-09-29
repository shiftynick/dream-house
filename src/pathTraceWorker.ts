import { MeshBVH, type BVHOptions, type SerializedBVH } from 'three-mesh-bvh';
import type { BufferGeometry } from 'three';

/** Vite-owned worker URL is emitted locally in both development and production. */
export class PathTraceWorker {
  private worker = new Worker(new URL('./bvh.worker.ts', import.meta.url), { type: 'module' });
  private reject: ((error: Error) => void) | null = null;
  generate(geometry: BufferGeometry, options: BVHOptions = {}): Promise<MeshBVH> {
    if (this.reject) return Promise.reject(new Error('A render build is already in progress.'));
    // Copies keep raster geometry available while the worker owns its buffers.
    const position = new Float32Array(geometry.getAttribute('position').array);
    const index = geometry.index ? new Uint32Array(geometry.index.array) : null;
    const { onProgress: _progress, ...serializableOptions } = options;
    return new Promise((resolve, reject) => {
      this.reject = reject;
      this.worker.onerror = (event) => {
        this.reject = null;
        reject(new Error(event.message || 'Render worker failed.'));
      };
      this.worker.onmessage = ({
        data,
      }: MessageEvent<{ serialized: SerializedBVH; error?: string }>) => {
        this.reject = null;
        if (data.error) reject(new Error(data.error));
        else resolve(MeshBVH.deserialize(data.serialized, geometry, { setIndex: true }));
      };
      this.worker.postMessage(
        { position, index, options: serializableOptions },
        index ? [position.buffer, index.buffer] : [position.buffer],
      );
    });
  }
  dispose() {
    this.worker.terminate();
    this.reject?.(new Error('Render preparation cancelled.'));
    this.reject = null;
  }
}
