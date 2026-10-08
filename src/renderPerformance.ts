import type { Scene } from '../shared/model';

/** Bound both display and contact work on large/high-DPI windows. */
export function rasterBudget(
  renderer: string,
  width: number,
  height: number,
  deviceDpr: number,
  presentation = false,
) {
  const integrated = /intel|swiftshader|llvmpipe|software/i.test(renderer);
  const maximumPixels = presentation
    ? integrated
      ? 2_000_000
      : 3_200_000
    : integrated
      ? 1_200_000
      : 2_000_000;
  const dpr = Math.min(
    Math.max(0.5, deviceDpr),
    presentation ? 2 : 1.5,
    Math.sqrt(maximumPixels / Math.max(1, width * height)),
  );
  return { dpr, maximumPixels, aoPixels: presentation ? 1_000_000 : 600_000 };
}

/** First paint is fully shaded. Motion temporarily omits contact processing. */
export class RenderActivity {
  private previous: number[] = [];
  private lastMove = -Infinity;
  observe(matrix: number[], now: number) {
    const changed =
      this.previous.length > 0 &&
      matrix.some((value, i) => Math.abs(value - this.previous[i]) > 1e-6);
    this.previous = matrix;
    if (changed) this.lastMove = now;
    return changed;
  }
  moving(now: number) {
    return now - this.lastMove < 120;
  }
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
