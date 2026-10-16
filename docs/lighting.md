# Interior lighting

October 16, 2026. Interior lighting is computed at runtime in the browser. Nothing is baked or saved with a design, so it follows every edit, and end users never need Blender. The code is in `src/roomProbes.ts`, with exposure and tone mapping in `src/renderLighting.ts`. It replaces the per-room CPU daylight map (`src/roomDaylight.ts`, now removed) described in [the interior study](interior-study.md).

Each image in `lighting/` is BEFORE (left, the renderer after the asset pass) and AFTER (right), from the same broker camera:

| View | File |
| --- | --- |
| Great Hall, from the southeast | [wide-southeast.jpg](lighting/wide-southeast.jpg) |
| Great Hall, from the northwest (gallery doorway) | [wide-northwest.jpg](lighting/wide-northwest.jpg) |
| Fireplace, from behind the sofa | [fireside-behind.jpg](lighting/fireside-behind.jpg) |
| Primary suite | [suite-windows.jpg](lighting/suite-windows.jpg) |
| Kitchen and dining | [kitchen-dining.jpg](lighting/kitchen-dining.jpg) |
| Exterior, from the northwest | [exterior-northwest.jpg](lighting/exterior-northwest.jpg) |

Full-size PNGs for all ten cameras are in `.data/verification/lighting-pass/`: `step1-after/` (before), `step4-iter1…3/` and `step4-final/` (after), plus `pairs-*/`.

## How it works

- **Window light.** For every room, the sky is integrated through the room's real exterior openings, using Lambert's polygon formula for a rectangle. The part of an opening above a surface's height shows the procedural sky, and the part below shows the ground. A GPU pass evaluates this on a 0.5 m grid inside the room (at most 32 points per axis) for the six axis normals. The grid is stored as an ambient cube in a half-float 3D texture. Fragments read it with three filtered fetches. This gives the falloff missing before: the floor near a window is brighter than the far wall, and window walls and high gables are darker.
- **Bounce light.** A 32 px cube capture of the actual scene is taken at each room's probe, which sits at the room centre at up to 1.4 m height. These captures include the furniture, sun patches and the fire. The sky and site are masked, so window light is not counted twice. Each capture is projected onto SH9 and the captures are iterated three times, so light also travels between rooms.
- **Doorway portals.** An opening into another enclosed room is a portal. Its radiance is what the neighbour's probe saw looking away from this room. The window-light volume adds the change between that portal's light at each grid point and what this room's own probe already captured. Light therefore spills through doorways and falls off with distance.
- **Reflections.** A 128 px cube capture per room (unmasked) is prefiltered by Three's PMREM. It is box-projected onto the room volume, so glossy floors and tables reflect the actual windows and walls in place. Rough lobes fade back to the unprojected lookup.
- **Edge occlusion.** Bounce light, and half of the window light, darken within 0.6 m of a room's walls, floor and ceiling, down to 45 %. The existing settled-view SSAO pass and furniture contact decals still provide contact shading.
- **Outdoor-facing faces.** Wall ends at building corners and floor-slab edges use the interior material. A face that points out through the nearby room boundary, when no other enclosed room is behind it, takes sky light instead.
- **Fire.** The fire's point light now casts a 512 px shadow (soft, radius 8), so its glow stays indoors. It sits just in front of the firebox opening, at intensity 13.

## Exposure and tone mapping

- **Tone mapping** is Khronos PBR Neutral, with a calibration of 0.9 × the previous exposure. ACES Filmic's toe crushed dim neighbouring rooms to black. AgX, tried in rounds 1 and 2, greyed the cedar and the fire glow.
- **Room exposure** comes from the mean luminance the room's bounce probe saw: `3.2 × (0.048 / L)^0.6`, clamped to 1.6–4.5. Dim rooms open up only partly. Exposure blends across about a metre either side of a doorway, and outdoors stays at 1.05 (× 0.9).
- **Local exposure** works like a real-estate exposure blend. A dimmer room seen from the camera's room keeps 70 % (in log terms) of its own higher exposure. The gain fades out within 0.5–3 m of the openings the rooms share, so thresholds have no seam. It never darkens a brighter room, and it is off when the camera is outdoors. Captures always record physical radiance.

## When it runs

- The interactive view spends up to 6 ms per frame on captures after a load, an edit, a light change or asset loading. Window light appears in the first frame, and bounce light settles over about a second. After an edit, a new probe set starts from each room's last known bounce light.
- Agent image captures run all pending captures before drawing.
- Converged bounce light is cached per visual scene key, light and asset version. Further image captures of the same scene only redo the reflection captures.
- After a WebGL context loss, every probe target is released while the lost context still owns it, and is recreated after the restore.

## Cost

These figures are from the Intel ARL GPU via Chromium hardware ANGLE. The machine was shared with other workloads, so treat individual numbers as ±1–2 ms.

- **Frame time.** Live and Presentation orbit/walk p95 stay at 16.7–16.8 ms (vsync), and idle submits zero draws. This is from `npm run capture:render -- --gpu hardware --performance-smoke --lifecycle-smoke --refined`, with evidence in `.data/verification/lighting-pass/perf-final/`. The lifecycle smoke passes, including the forced context loss and restore, with no browser warnings.
- **Scene pass.** This is the Grand lodge's synchronous draw time without SSAO, using `capture-great-room --gpu-bench` (best-of-five medians, three runs interleaved with the previous commit).

  | View | Before | After |
  | --- | --- | --- |
  | Great Hall, from the southeast | 9.2 ms | 10.7 ms |
  | Great Hall, from the northwest | 10.1 ms | 11.4 ms |
  | Kitchen and dining | 9.6 ms | 10.6 ms |
  | Primary suite | 8.7 ms | 8.6 ms |
  | Exterior, from the south | 8.8 ms | 9.6 ms |

  An exact per-fragment version of the window term cost about 8 ms in the hall, which is why it moved into the volume.
- **Captures.** One full probe run on the lodge (10 rooms, 30 bounce and 10 reflection captures) takes 0.4–1.4 s warm. Half of that is the synchronous readback of the small bounce cubes. A fresh canvas first compiles every room's shaders (about 3.5 s), so the first agent capture of a session takes 7–11 s (2.8–4.5 s before). Later captures take 1.2–1.6 s each (0.8–1.0 s before).
- **Memory.** Per room, there is a 128 px half-float reflection cube plus its PMREM, and an irradiance volume of up to 32³ × 6 half-float texels (about 1 MB for the Great Hall).

## Not built: a path-traced photo mode

A browser path tracer such as three-gpu-pathtracer was evaluated and not built. This app shipped one before and retired it. On the same Intel GPU it needed about 35 s of cold shader setup before the first sample, and many seconds per handful of samples ([verification](verification.md), [rendering decision](browser-rendering-approach.md)). An archviz-clean still would need hundreds of samples plus a denoiser, and it would not reuse this runtime lighting. The cost is minutes per image on the target hardware, for a gain the raster probes now partly cover.

## Known gaps

- Dim rooms seen through a doorway are readable but still the darkest part of the frame. An example is the 14 m Guest Wing Gallery seen from the hall, which is lit by one far window and the hall opening.
- Bounce light is one SH probe per room, so its variation across a room comes only from the window and portal volume and the edge occlusion. Furniture does not occlude window light, and there is no screen-space GI.
- The window volume treats every exterior opening as unobstructed sky; it ignores overhangs, neighbouring wings and terrain.
- Rooms lit mostly by blue skylight, such as the upper gallery seen through the hall's centre opening, read violet on the red cedar next to the sunlit hall. There is no white-balance step, and this was not tuned further.
- The first image capture in a fresh browser session pays for shader compilation.
