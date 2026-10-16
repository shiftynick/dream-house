import { useEffect, useMemo } from 'react';
import * as THREE from 'three';

/** A static fire: charred logs, an ember bed and crossed additive flame cards
 * inside the firebox. Static so demand rendering and captures stay settled. */
function flameTexture() {
  const width = 64,
    height = 128,
    canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d')!;
  const image = context.createImageData(width, height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const u = (x + 0.5) / width - 0.5,
        v = 1 - (y + 0.5) / height;
      // Teardrop: wide at the base, tapering to a point, with a slight lick.
      const half = 0.42 * Math.pow(Math.max(0, 1 - v), 0.85) * (1 - 0.65 * Math.exp(-v * 9));
      const lick = 0.05 * Math.sin(v * 9 + u * 3);
      const d = half > 0 ? Math.abs(u - lick * v) / half : 2;
      const body = Math.max(0, 1 - d * d) * Math.min(1, v * 6) * Math.pow(1 - v, 0.6);
      const core = Math.pow(body, 2.2);
      const i = (y * width + x) * 4;
      image.data[i] = Math.round(255 * Math.min(1, body * 1.2));
      image.data[i + 1] = Math.round(255 * Math.min(1, body * 0.55 + core * 0.45));
      image.data[i + 2] = Math.round(255 * core * 0.35);
      image.data[i + 3] = 255;
    }
  context.putImageData(image, 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

const logs: { position: [number, number, number]; rotation: [number, number, number] }[] = [
  { position: [-0.08, 0.76, 0.02], rotation: [0, 0.25, Math.PI / 2] },
  { position: [0.1, 0.76, -0.1], rotation: [0, -0.35, Math.PI / 2] },
  { position: [0.0, 0.87, -0.04], rotation: [0.15, 0.05, Math.PI / 2] },
];
const flames: { x: number; z: number; scale: number; yaw: number }[] = [
  { x: -0.12, z: 0.0, scale: 0.55, yaw: 0.2 },
  { x: 0.1, z: -0.05, scale: 0.68, yaw: -0.5 },
  { x: 0.02, z: 0.04, scale: 0.42, yaw: 1.2 },
  { x: -0.22, z: -0.08, scale: 0.36, yaw: 0.9 },
  { x: 0.24, z: -0.02, scale: 0.34, yaw: -1.1 },
];

export function Hearth() {
  const resources = useMemo(() => {
    const flame = new THREE.MeshBasicMaterial({
      map: flameTexture(),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
      color: new THREE.Color(1.6, 1.25, 1),
    });
    const wood = new THREE.MeshStandardMaterial({ color: '#2b1d14', roughness: 0.95 });
    const ember = new THREE.MeshStandardMaterial({
      color: '#1a0f0a',
      emissive: '#ff5a14',
      emissiveIntensity: 1.6,
      roughness: 1,
    });
    const soot = new THREE.MeshStandardMaterial({ color: '#17130f', roughness: 1 });
    const log = new THREE.CylinderGeometry(0.075, 0.085, 0.72, 10);
    const plane = new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0);
    return { flame, wood, ember, soot, log, plane };
  }, []);
  useEffect(
    () => () => {
      resources.flame.map?.dispose();
      Object.values(resources).forEach((resource) => resource.dispose());
    },
    [resources],
  );
  return (
    <group>
      {/* Sooted firebox back and an ember bed on the grate. */}
      <mesh position={[0, 0.98, -0.5]} material={resources.soot}>
        <boxGeometry args={[1.25, 1.2, 0.1]} />
      </mesh>
      <mesh position={[0, 0.705, -0.04]} rotation={[-Math.PI / 2, 0, 0]} material={resources.ember}>
        <planeGeometry args={[0.8, 0.4]} />
      </mesh>
      {logs.map((log, index) => (
        <mesh
          key={index}
          position={log.position}
          rotation={log.rotation}
          geometry={resources.log}
          material={resources.wood}
          castShadow
        />
      ))}
      {flames.flatMap((flame, index) =>
        [0, Math.PI / 2].map((turn) => (
          <mesh
            key={`${index}-${turn}`}
            position={[flame.x, 0.72, flame.z]}
            rotation={[0, flame.yaw + turn, 0]}
            scale={[flame.scale * 0.55, flame.scale, 1]}
            geometry={resources.plane}
            material={resources.flame}
            raycast={() => null}
            renderOrder={2}
          />
        )),
      )}
      <pointLight
        position={[0, 1.0, 0.45]}
        intensity={10}
        color="#ff9a45"
        distance={9}
        decay={1.6}
      />
    </group>
  );
}
