import { BufferGeometry, BufferAttribute } from 'three';
import { MeshBVH, type BVHOptions } from 'three-mesh-bvh';

const scope = globalThis as unknown as {
  onmessage: (
    event: MessageEvent<{
      position: Float32Array;
      index: Uint32Array | Uint16Array | null;
      options: BVHOptions;
    }>,
  ) => void;
  postMessage: (message: unknown, transfer?: Transferable[]) => void;
};
scope.onmessage = ({ data }) => {
  try {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(data.position, 3));
    if (data.index) geometry.setIndex(new BufferAttribute(data.index, 1));
    const bvh = new MeshBVH(geometry, data.options);
    const serialized = MeshBVH.serialize(bvh, { cloneBuffers: false });
    const buffers = [...serialized.roots, serialized.index?.buffer].filter(
      (buffer): buffer is ArrayBuffer => buffer instanceof ArrayBuffer,
    );
    scope.postMessage({ serialized }, buffers);
    geometry.dispose();
  } catch (error) {
    scope.postMessage({ error: error instanceof Error ? error.message : 'BVH generation failed.' });
  }
};
