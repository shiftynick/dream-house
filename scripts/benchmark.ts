import { performance } from 'node:perf_hooks';
import { scenarios } from './scenarios.ts';
import { executeCommands, inspectDesign } from '../shared/design.ts';
import { sceneFingerprint } from '../server/render-service.ts';

function measure(run: () => unknown, iterations = 60) {
  for (let i = 0; i < 10; i++) run();
  const times = Array.from({ length: iterations }, () => {
    const start = performance.now();
    run();
    return performance.now() - start;
  }).sort((a, b) => a - b);
  return {
    medianMs: Number(times[Math.floor(times.length / 2)].toFixed(3)),
    p95Ms: Number(times[Math.floor(times.length * 0.95)].toFixed(3)),
  };
}
for (const [name, make] of Object.entries(scenarios)) {
  const scene = make();
  console.log(
    JSON.stringify({
      scenario: name,
      rooms: scene.rooms.length,
      inspection: measure(() => inspectDesign(scene)),
      localEdit: measure(() =>
        executeCommands(scene, [
          { type: 'set_material', roomIds: [scene.rooms[0].id], palette: 'chalk' },
        ]),
      ),
      fingerprint: measure(() => sceneFingerprint(scene)),
    }),
  );
}
