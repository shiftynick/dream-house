import { Component, Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRoot, extend, useThree } from '@react-three/fiber';
import { RasterRenderer } from './rasterRenderer';
import { interiorExposure } from './renderLighting';
import { captureAfterRender } from './captureSchedule';
import * as THREE from 'three';
import { Architecture, Environment, FloorPlanSvg, Site } from './SceneView';
import {
  renderCamera,
  renderFloor,
  type RenderCaptureResult,
  type RenderJob,
} from '../shared/render';

const WIDTH = 768;
const HEIGHT = 576;
const noSelection = () => {};
type Props = {
  job: RenderJob;
  onComplete: (result: RenderCaptureResult) => void;
  onError: (message: string) => void;
};

class CaptureBoundary extends Component<
  { children: ReactNode; onError: (message: string) => void },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    this.props.onError(
      'The local 3D capture could not start. Check browser hardware acceleration.',
    );
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

function CaptureFrames({
  job,
  complete,
  fail,
}: {
  job: RenderJob;
  complete: Props['onComplete'];
  fail: Props['onError'];
}) {
  const { gl, scene, camera } = useThree();
  useEffect(() => {
    const controller = new AbortController();
    const raster = new RasterRenderer(gl, scene, camera);
    const previousShadowUpdates = gl.shadowMap.autoUpdate;
    gl.shadowMap.autoUpdate = false;
    gl.shadowMap.needsUpdate = true;
    const lost = (event: Event) => {
      event.preventDefault();
      controller.abort();
      fail('The local render context was lost while capturing the house.');
    };
    gl.domElement.addEventListener('webglcontextlost', lost);
    void captureAfterRender({
      signal: controller.signal,
      render: () => {
        if (gl.getContext().isContextLost())
          throw new Error('The local render context is unavailable.');
        scene.updateMatrixWorld(true);
        camera.updateMatrixWorld(true);
        gl.toneMappingExposure = interiorExposure(job.scene, camera.position);
        raster.render(job.request.quality !== 'wireframe');
      },
      capture: () => {
        const context = gl.getContext();
        if (context.isContextLost() || gl.info.render.calls === 0)
          throw new Error('The local renderer did not draw the house.');
        const pixels = new Uint8Array(WIDTH * HEIGHT * 4);
        context.readPixels(0, 0, WIDTH, HEIGHT, context.RGBA, context.UNSIGNED_BYTE, pixels);
        let opaque = false;
        for (let index = 3; index < pixels.length; index += 4)
          if (pixels[index] !== 0) {
            opaque = true;
            break;
          }
        if (!opaque) throw new Error('The local renderer returned an empty image.');
        const image = gl.domElement.toDataURL('image/jpeg', 0.88);
        if (!image.startsWith('data:image/jpeg;base64,') || image.length < 1000)
          throw new Error('The local renderer returned an empty image.');
        const framing = renderCamera(job.scene, job.request);
        return {
          image,
          width: WIDTH,
          height: HEIGHT,
          camera: { position: framing.position, target: framing.target },
          sceneHash: job.sceneHash,
          view: job.request.view,
        };
      },
    })
      .then((result) => {
        if (!controller.signal.aborted) complete(result);
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          fail(error instanceof Error ? error.message : 'The local image capture failed.');
      });
    return () => {
      controller.abort();
      gl.domElement.removeEventListener('webglcontextlost', lost);
      raster.dispose();
      gl.shadowMap.autoUpdate = previousShadowUpdates;
    };
  }, [job, gl, scene, camera, complete, fail]);
  return null;
}

/** Explicit size avoids Canvas/useMeasure's ResizeObserver gate, which can also
 * wait for a browser paint. A fresh canvas per effect owns and releases its root. */
function OffscreenScene({
  job,
  complete,
  fail,
}: {
  job: RenderJob;
  complete: Props['onComplete'];
  fail: Props['onError'];
}) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!host.current) return;
    let cancelled = false;
    const framing = renderCamera(job.scene, job.request);
    const canvas = document.createElement('canvas');
    canvas.width = WIDTH;
    canvas.height = HEIGHT;
    canvas.style.width = `${WIDTH}px`;
    canvas.style.height = `${HEIGHT}px`;
    host.current.appendChild(canvas);
    extend({
      Group: THREE.Group,
      Mesh: THREE.Mesh,
      BoxGeometry: THREE.BoxGeometry,
      PlaneGeometry: THREE.PlaneGeometry,
      CylinderGeometry: THREE.CylinderGeometry,
      IcosahedronGeometry: THREE.IcosahedronGeometry,
      SphereGeometry: THREE.SphereGeometry,
      MeshBasicMaterial: THREE.MeshBasicMaterial,
      MeshStandardMaterial: THREE.MeshStandardMaterial,
      GridHelper: THREE.GridHelper,
      AmbientLight: THREE.AmbientLight,
      HemisphereLight: THREE.HemisphereLight,
      DirectionalLight: THREE.DirectionalLight,
      PointLight: THREE.PointLight,
    });
    const root = createRoot(canvas);
    void root
      .configure({
        size: { width: WIDTH, height: HEIGHT, top: 0, left: 0 },
        frameloop: 'never',
        shadows: true,
        dpr: 1,
        camera: {
          position: framing.position,
          fov: framing.fov,
          near: job.request.view === 'interior' ? 0.04 : 0.1,
          far: 1500,
        },
        gl: {
          antialias: true,
          preserveDrawingBuffer: true,
          powerPreference: 'high-performance',
          toneMapping: THREE.ACESFilmicToneMapping,
        },
        onCreated: ({ camera }) => {
          camera.lookAt(...framing.target);
          camera.updateMatrixWorld(true);
        },
      })
      .then(() => {
        if (cancelled) return;
        root.render(
          <CaptureBoundary onError={fail}>
            <Suspense fallback={null}>
              <Environment light={job.request.light} house={job.scene} />
              <Site house={job.scene} quality={job.request.quality} />
              <Architecture
                house={job.scene}
                light={job.request.light}
                quality={job.request.quality}
                cutaway={job.request.view === 'cutaway'}
                cutawaySides={[
                  job.request.angle.startsWith('south') ? 'south' : 'north',
                  job.request.angle.endsWith('east') ? 'east' : 'west',
                ]}
                selected={null}
                onSelect={noSelection}
              />
              <CaptureFrames job={job} complete={complete} fail={fail} />
            </Suspense>
          </CaptureBoundary>,
        );
      })
      .catch((error) => {
        if (!cancelled)
          fail(error instanceof Error ? error.message : 'The local renderer could not initialize.');
      });
    return () => {
      cancelled = true;
      // This is a separate React root: unmount after the parent commit finishes.
      queueMicrotask(() => {
        root.unmount();
        canvas.remove();
      });
    };
  }, [job, complete, fail]);
  return <div ref={host} style={{ width: WIDTH, height: HEIGHT }} />;
}

async function capturePlan(job: RenderJob): Promise<RenderCaptureResult> {
  const level = renderFloor(job.scene, job.request);
  const svg = renderToStaticMarkup(
    <FloorPlanSvg
      house={job.scene}
      selected={null}
      onSelect={noSelection}
      level={level}
      quality={job.request.quality}
    />,
  ).replace('<svg ', `<svg width="${WIDTH - 32}" height="${HEIGHT - 48}" `);
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('The local floor plan could not be rasterized.'));
      image.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = WIDTH;
    canvas.height = HEIGHT;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('A local drawing context is unavailable.');
    context.fillStyle = '#f3f2eb';
    context.fillRect(0, 0, WIDTH, HEIGHT);
    context.fillStyle = '#384d43';
    context.font = '15px sans-serif';
    context.fillText(`Floor plan · elevation ${level.toFixed(1)} m · dimensions in meters`, 18, 22);
    context.drawImage(image, 16, 32, WIDTH - 32, HEIGHT - 48);
    const camera = renderCamera(job.scene, job.request);
    return {
      image: canvas.toDataURL('image/png'),
      width: WIDTH,
      height: HEIGHT,
      camera: { position: camera.position, target: camera.target },
      sceneHash: job.sceneHash,
      view: 'plan',
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function CaptureTask({ job, onComplete, onError }: Props) {
  const [done, setDone] = useState(false);
  const callbacks = useRef({ onComplete, onError });
  callbacks.current = { onComplete, onError };
  const active = useRef(true);
  const delivered = useRef(false);
  const complete = useRef((result: RenderCaptureResult) => {
    if (!active.current || delivered.current) return;
    delivered.current = true;
    setDone(true);
    callbacks.current.onComplete(result);
  }).current;
  const fail = useRef((message: string) => {
    if (!active.current || delivered.current) return;
    delivered.current = true;
    setDone(true);
    callbacks.current.onError(message);
  }).current;
  let framing: ReturnType<typeof renderCamera> | undefined;
  let framingError: string | undefined;
  try {
    framing = renderCamera(job.scene, job.request);
  } catch (error) {
    framingError = error instanceof Error ? error.message : 'This view cannot be rendered.';
  }
  useEffect(() => {
    active.current = true;
    let cancelled = false;
    const timeout = window.setTimeout(
      () => fail('The local render timed out. Keep the design tab open and try again.'),
      30_000,
    );
    if (framingError) fail(framingError);
    else if (job.request.view === 'plan')
      capturePlan(job)
        .then((result) => {
          if (!cancelled) complete(result);
        })
        .catch((error) => {
          if (!cancelled)
            fail(error instanceof Error ? error.message : 'The local floor plan failed.');
        });
    return () => {
      cancelled = true;
      active.current = false;
      clearTimeout(timeout);
    };
  }, [job, framingError, complete, fail]);
  if (done || !framing || job.request.view === 'plan') return null;
  return (
    <div
      aria-hidden="true"
      data-render-capture={job.id}
      style={{
        position: 'fixed',
        left: -10000,
        top: 0,
        width: WIDTH,
        height: HEIGHT,
        pointerEvents: 'none',
        overflow: 'hidden',
      }}
    >
      <CaptureBoundary onError={fail}>
        <OffscreenScene job={job} complete={complete} fail={fail} />
      </CaptureBoundary>
    </div>
  );
}

/** Dedicated canvas and camera: capturing a draft never moves the visible view. */
export default function RenderCapture(props: Props) {
  return <CaptureTask key={props.job.id} {...props} />;
}
