# Great Hall realism pilot

October 16, 2026. Pilot to move the Great Hall of "Grand lodge 3" toward photoreal archviz without leaving the realtime raster renderer. Each image in `great-room-pilot/` is BEFORE (left) and AFTER (right) from the same broker camera, 768 × 576, day light, Intel ARL GPU via Chromium hardware ANGLE.

| View                           | File                                                        |
| ------------------------------ | ----------------------------------------------------------- |
| Wide, from the southeast       | [wide-southeast.jpg](great-room-pilot/wide-southeast.jpg)   |
| Wide, from the northwest       | [wide-northwest.jpg](great-room-pilot/wide-northwest.jpg)   |
| Fireside seating, front        | [fireside-front.jpg](great-room-pilot/fireside-front.jpg)   |
| Fireside, from behind the sofa | [fireside-behind.jpg](great-room-pilot/fireside-behind.jpg) |
| Conversation group             | [conversation.jpg](great-room-pilot/conversation.jpg)       |

Reproduce with `npx tsx scripts/capture-great-room.ts --out .data/verification/great-room/<name>`. It copies the active saved house read-only into isolated scenario storage, so `.data/workspace.json` is never written. Full-size PNGs and metadata are in `.data/verification/great-room/{before,iter-1…iter-6}/`.

## What changed

- **Furniture models.** `public/assets/manifest.json` maps furniture kinds to GLBs: sofa → Poly Haven `sofa_02`, armchair → `modern_arm_chair_01`, coffee table → `modern_coffee_table_01`. `src/renderAssets.ts` loads them with GLTFLoader + Draco and fits each one to the saved width/height/depth. Optional stretch zones absorb the extra width, so arms and legs keep their native size, for example on a 3.6 m sofa built from a 1.8 m model. Other kinds, and any model that fails to load, keep the procedural geometry. Plan, picking and clearance logic are unchanged.
- **Upholstery follows the palette.** The Blender step converts a model's upholstery albedo into normalized grayscale detail, and the renderer tints it with the room or piece fabric palette. Optionally, saturated UV islands such as wooden legs are split off first so they keep their original material.
- **Photo PBR surfaces.** These come from CC0 Poly Haven sets: color, normal and AO/roughness/metal maps at physical scale. The floor uses laminate oak, the walls and ceiling vertical cedar boards, wood trim oak veneer, fabric rough linen, the rug wool herringbone, the chimney stacked stone, and the site aerial grass. Palette-tinted sets store a grayscale albedo, so each palette's average color is preserved. Procedural maps remain the fallback.
- **Backdrop.** The `alps_field` panorama is the daylight background only; lighting still comes from the calibrated sky model. When it is present, the stylized site trees are hidden.
- **Grounding and the fire.** Soft contact decals sit under furniture. The emissive sphere is replaced by logs, an ember bed, additive flame cards and a sooted firebox back.
- Captures wait (up to 20 s) for these assets, so broker images match the editor.

## Pipeline

```sh
npx tsx scripts/assets/fetch-sources.ts   # CC0 downloads into gitignored assets-src/ (md5-checked)
npx tsx scripts/assets/build-assets.ts    # Blender + ImageMagick → public/assets/ + manifest.json
```

`scripts/assets/sources.json` lists every source and its budget. Headless Blender (`scripts/assets/build_furniture.py`) joins the meshes and bakes their transforms. It orients the front to +Z with the origin at the bottom center, caps triangles (24k–30k) and textures (1024 px), prepares the upholstery, and exports Draco GLBs with JPEG textures. Committed assets total about 9.8 MB: three GLBs of 0.3–0.8 MB, 1–2 MB per texture set, and a 1.5 MB backdrop.

Later work (finish slots, window/door kits, starter catalog) is documented in [asset-library.md](asset-library.md).

## Verification

460 existing tests plus `tests/render-assets.test.ts` pass, along with the TypeScript check and the production build. The lifecycle smoke passes: modes, picking, edits, forced context loss/restore and a post-restore capture, with no browser warnings. In the performance smoke, Live and Presentation orbit/walk p95 stay at 16.7 ms, the same as `main` on the same GPU, and idle submits zero draws.

## Known gaps

- Lighting is still the single per-room SH field. Walls and ceiling show little falloff, and doorways into rooms that receive less light read nearly black. A Blender lightmap bake was not attempted: architecture is editable at runtime, so a bake would go stale after every edit unless baking became a per-design step.
- No modern sofa exists among CC0 libraries. `sofa_02` is a curved, tufted style, and a stretched long sofa shows wider tufting in the middle.
- Through the windows, the near terrain is still the site plane at a 15 m texture repeat.
