import type { Scene } from '../shared/model';

export function renderingBudget(renderer: string, width: number, height: number, dpr: number) {
  const integrated = /intel|swiftshader|llvmpipe|software/i.test(renderer);
  const maximumPixels = integrated ? 260_000 : 800_000;
  const scale = Math.min(
    integrated ? 0.7 : 1,
    Math.sqrt(maximumPixels / Math.max(1, width * height * dpr * dpr)),
  );
  return { scale, tiles: integrated ? 3 : 2, maximumPixels, maxSamples: 96 };
}

/** Conversation, requirements, names and selection never invalidate lighting. */
export function visualSceneKey(scene: Scene, cutaway: boolean, cutawaySides?: string[]) {
  return JSON.stringify({
    palette: scene.palette,
    roof: scene.roof,
    roofPitch: scene.roofPitch,
    roofDirection: scene.roofDirection,
    slope: scene.slope,
    rooms: scene.rooms.map(({ name: _name, ...room }) => room),
    stairs: scene.stairs,
    fireplace: scene.fireplace,
    connections: scene.design?.connections,
    stairLinks: scene.design?.stairLinks,
    cutaway,
    cutawaySides,
  });
}
