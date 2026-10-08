import * as THREE from 'three';
import { SSAOPass } from 'three/examples/jsm/postprocessing/SSAOPass.js';

/** Small-scale contact occlusion shared by interactive views and agent images.
 * Own the targets with the canvas that uses them. */
export class RasterRenderer {
  private pass: SSAOPass;
  private width = 0;
  private height = 0;
  private broken = false;
  constructor(
    private renderer: THREE.WebGLRenderer,
    private scene: THREE.Scene,
    private camera: THREE.Camera,
  ) {
    this.pass = new SSAOPass(scene, camera, 1, 1, 12);
    this.pass.renderToScreen = true;
    this.pass.kernelRadius = 0.45;
    this.pass.minDistance = 0.001;
    this.pass.maxDistance = 0.08;
    // Stable low-discrepancy samples keep captures reproducible across canvases.
    this.pass.kernel.forEach((sample, index) => {
      const phi = index * 2.399963229728653;
      const z = (index + 0.5) / this.pass.kernel.length;
      const radius = Math.sqrt(1 - z * z);
      sample
        .set(Math.cos(phi) * radius, Math.sin(phi) * radius, z)
        .multiplyScalar(0.1 + 0.9 * z * z);
    });
    const noise = this.pass.noiseTexture.image.data as Float32Array;
    for (let i = 0; i < noise.length; i++) noise[i] = Math.sin(i * 2.399963229728653);
    this.pass.noiseTexture.needsUpdate = true;
    // Restrained occlusion, avoiding the dark halos of full-strength SSAO.
    this.pass.ssaoMaterial.fragmentShader = this.pass.ssaoMaterial.fragmentShader.replace(
      'gl_FragColor = vec4( vec3( 1.0 - occlusion ), 1.0 );',
      'gl_FragColor = vec4( vec3( 1.0 - 0.55 * occlusion ), 1.0 );',
    );
  }
  render(occlusion = true, maximumPixels = 600_000) {
    const { renderer, scene, camera, pass } = this;
    renderer.setRenderTarget(null);
    renderer.render(scene, camera);
    if (!occlusion || this.broken) return false;
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    const scale = Math.min(1, Math.sqrt(maximumPixels / (size.x * size.y)));
    const width = Math.max(1, Math.round(size.x * scale)),
      height = Math.max(1, Math.round(size.y * scale));
    if (width !== this.width || height !== this.height) {
      pass.setSize(width, height);
      this.width = width;
      this.height = height;
    }
    pass.ssaoMaterial.uniforms.cameraProjectionMatrix.value.copy(camera.projectionMatrix);
    pass.ssaoMaterial.uniforms.cameraInverseProjectionMatrix.value.copy(
      camera.projectionMatrixInverse,
    );
    const perspective = camera as THREE.PerspectiveCamera;
    const depthRange = perspective.far - perspective.near;
    pass.ssaoMaterial.uniforms.cameraNear.value = perspective.near;
    pass.ssaoMaterial.uniforms.cameraFar.value = perspective.far;
    pass.minDistance = 0.008 / depthRange;
    pass.maxDistance = 0.65 / depthRange;
    const hidden: THREE.Object3D[] = [];
    const shadowUpdate = renderer.shadowMap.autoUpdate;
    const override = scene.overrideMaterial;
    const autoClear = renderer.autoClear;
    const clearColor = renderer.getClearColor(new THREE.Color());
    const clearAlpha = renderer.getClearAlpha();
    scene.traverse((object) => {
      if (object.visible && (object instanceof THREE.Line || object instanceof THREE.Points)) {
        hidden.push(object);
        object.visible = false;
      }
      if (!(object instanceof THREE.Mesh) || !object.visible) return;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      if (
        materials.every(
          (material) => material.transparent || (material as THREE.MeshBasicMaterial).wireframe,
        )
      ) {
        hidden.push(object);
        object.visible = false;
      }
    });
    renderer.shadowMap.autoUpdate = false;
    try {
      pass.render(renderer, null!, null!, 0, false);
    } catch (error) {
      this.broken = true;
      console.warn('Contact shading unavailable; using the live surface render.', error);
    } finally {
      hidden.forEach((object) => {
        object.visible = true;
      });
      renderer.shadowMap.autoUpdate = shadowUpdate;
      renderer.autoClear = autoClear;
      renderer.setClearColor(clearColor, clearAlpha);
      scene.overrideMaterial = override;
      renderer.setRenderTarget(null);
    }
    if (this.broken) renderer.render(scene, camera);
    return !this.broken;
  }
  dispose() {
    this.pass.dispose();
    // These two allocations are not released by SSAOPass.dispose in Three r180.
    this.pass.ssaoMaterial.dispose();
    this.pass.noiseTexture.dispose();
  }
}
