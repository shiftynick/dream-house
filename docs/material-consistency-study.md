# Architectural material consistency

The renderer anchors adjoining wall and roof textures to world coordinates. Explicit surface and room palette overrides remain authoritative; matching material IDs do not erase intentional differences in palette or room lighting.

The previous projection restarted texture phase at every room center. Unequal adjoining rooms could therefore show misaligned cedar boards and metal roof seams despite sharing one palette. Roof UVs also selected their two axes independently: an east/west slope between 45° and 60° could map both coordinates to world Z, collapsing the texture into a line. Ordinary east/west roofs placed metal seams across the slope.

Wall bodies, opening fragments and roof caps now share a physical world anchor. Roof faces use the slope axis explicitly, maintain meters along the pitched surface, and run seams downhill. Flat roofs use a consistent world X/Z basis. The correction changes UV attributes only; room shapes, face groups, picking, saved materials and material texture recipes are unchanged.

## Reproduce the image study

```sh
npm run capture:render -- --material-study --gpu hardware --port 5188 --out /tmp/terrain-material-study/current
```

Use the same GPU setting and a fresh output directory for each comparison. This focused option uses five synthetic views: unequal adjoining flat roofs, their cedar wall with windows, adjoining 20° single-pitch roofs, and adjoining 46° east/55° west roofs. It cannot be combined with other study or smoke flags. No furniture, private project data or model calls are involved.

The existing capture harness owns a separate scenario server and browser, rejects occupied/production ports, blocks nonlocal browser requests, and cleans up its processes. Each image has a matching `.scene.json`. `metadata.json` records the exact request, scene hash, camera, renderer source hashes, actual GPU and browser diagnostics. Captures use the real local render broker at 768 × 576; JPEG output is decoded to PNG. They establish visual continuity at that resolution, not a physical illumination reference or performance benchmark.

For a historical comparison, create a tracked-files-only archive of commit `b2eed23546b5163dbecabcf3cccd0e6dfa016990`, link its `node_modules` to the installed dependencies, and copy only the current capture harness and material-study fixtures into its `scripts/` directory. In that private archive's Vite configuration, allow its own root and the real shared `node_modules` directory through `server.fs.allow`, so UI font assets can load. Run the same command there with a distinct port and output. The baseline renderer remains historical; metadata identifies the shared current capture script separately. Never copy `.env`, `.data` or a personal house into the baseline archive.

## October 8, 2026 evidence

Five baseline/current pairs are retained locally in `.data/verification/material-consistency-study/{baseline,current}/`. Requests, exact scene fingerprints, camera positions/targets and framing match for every pair. Both runs used Chromium **152.0.7977.82** and **ANGLE Intel Mesa Graphics ARL, OpenGL ES 3.2**. Renderer source remained stable during each run; browser warnings/errors and page exceptions were absent. The renderer source differences are `SceneView.tsx`, `renderMeshes.ts` and `architecturalFinish.ts`; the current app also contains the independent visual-review UI change in `App.tsx`.

The paired images show a common metal seam phase across adjoining roof panels and consistent cedar texture coordinates across room boundaries. At 768 × 576 these changes are restrained; the steep-roof correction is better established by the nondegenerate UV and physical-scale checks than by the mostly uniform metal color. Existing dark strips at wall corners/shared wall ends and shadowed foundation edges remain in both versions. This work does not change those geometric/shading details or equalize intentionally different room finishes.

| Fixture | Compared geometries | Triangles | Material groups |
| --- | ---: | ---: | ---: |
| Flat roof / wall views | 18 | 360 | 32 |
| 20° single-pitch roof | 24 | 416 | 38 |
| 46° east roof | 18 | 200 | 26 |
| 55° west roof | 18 | 200 | 26 |

`topology-audit.json` records the CPU comparison against the historical renderer. Positions, normals, indices and material groups are identical for all compared roof, soffit, wall and cap meshes; only UV attributes differ. These are the affected architectural meshes, not whole-scene GPU draw totals. No performance timing claim is made.

The first archive run is retained as `baseline-font403/` and is **invalid acceptance evidence**: its shared dependency symlink triggered three Vite font-resource 403 errors. The strict diagnostic check rejected it. After correcting only the private archive's filesystem allow list, both clean runs completed and their owned browser/server processes closed. No production server, project or Vite configuration was changed.

## Regression checks

`tests/render-material-consistency.test.ts` checks nondegenerate projection, physical scale and seam direction for gable/single-pitch roofs in all four directions at 1°, 20°, 44°, 46°, 55° and 60°. It compares shared UV coordinates across unequal adjoining flat/sloped roof rooms and across wall bodies, raised openings and roof caps. Existing capture tests cover palette precedence; existing geometry and furniture tests protect dimensions, face groups, picking and batching.

All four new regression tests fail against `b2eed23` and pass after the correction. The focused rendering run passes 31 tests and TypeScript checking. Independent source review additionally covered 720 roof style/direction/pitch combinations through 60° without degenerate roof UVs.
