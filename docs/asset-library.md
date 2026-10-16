# Asset library: finishes, window/door kits and the starter catalog

October 16, 2026. Builds on the [Great Hall realism pilot](great-room-pilot.md). Everything ships prebuilt in `public/assets/` (36 MB). End users never need Blender; it is a developer-only build tool.

```sh
npx tsx scripts/assets/fetch-sources.ts   # CC0 downloads into gitignored assets-src/
npx tsx scripts/assets/build-assets.ts    # Blender + ImageMagick → public/assets/, manifest, shared/asset-catalog.json
```

`public/assets/manifest.json` drives loading in `src/renderAssets.ts`. `shared/asset-catalog.json` is the small bundled subset (IDs, names, slots, swatches, thumbnails, attribution) that the editor and the shared helpers in `shared/finishes.ts` use.

## Swappable finishes

- **Slots.** `build_furniture.py` names every model material after its finish slot: `upholstery`, `wood`, `metal`, `stone`, `rug`, `glass` or `other`. Slots come from explicit `slots` maps in `scripts/assets/sources.json`, name keywords, or splitting a shared texture atlas by UV island. `split` divides islands by saturation. `classify` matches each island's mean colour and height against `hue`, `sat`, `val`, `top` and `bottom` ranges; the heights are fractions of the piece's height. Each build writes `assets-src/previews/<id>-slots.png`, coloured by slot, so the splits can be checked. Procedural pieces map their part materials the same way: `fabric`/`seam` are upholstery, `wood` is wood, `chrome` is metal, `worktop` is stone, and `rug` is rug.
- **Real-world scale.** TEXCOORD_1 stores each face's box-projection axis. The renderer rebuilds meter-scale UVs from the fitted geometry, so finishes keep their true scale on stretched zones as well. Library grain always runs along the texture's v axis: `rotate90` turns sources whose grain runs the other way, and the normal map is rotated correctly to match.
- **Library.** 23 CC0 sets, loaded only when a piece uses them:
  - Fabrics: linen, velvet, bouclé, corduroy, herringbone wool, jute, plaid wool.
  - Leathers: cognac, espresso, and a palette-dyed leather.
  - Woods: oak, walnut, pale oak, teak, ebonised oak.
  - Metals from ambientCG: brushed steel, satin brass, blackened steel, copper.
  - Stones: white and black marble, travertine, polished concrete.
- **Data.** `furniture.finishes` sets a slot for one piece, and `room.furnitureFinishes` sets the room default. A catalog model can also carry a default finish per slot (`finishes` in `sources.json`). The precedence is piece, then room, then the model's default finish, then the model's own material. The piece panel's "inherit" option shows the room or model default. Unknown IDs, or IDs that don't fit the slot, fall back silently. The commands are `update_furniture` (patch `finishes`) and `update_room` (patch `furnitureFinishes`).
- **Tint.** Grayscale (`tinted`) finishes take the palette fabric or rug colour divided by the photo's mean, which is the same rule building surfaces use. Upholstery finishes keep the model's own normal and AO maps, so tufting and seams survive the swap.
- **UI.** The furniture panel shows a "Piece finishes" select per slot when a piece is selected, and "Room furniture finishes" otherwise. Changes apply immediately.
- **Building surfaces.** Each palette has its own exterior cladding: cedar boards, charred boards, limestone ashlar or lime stucco. Interior walls, floors, ceilings and trim keep their sets. Concrete and the box-profile metal roof are now photo sets. Roof edges use a plain flashing material. Every set has colour, normal and ARM (AO/roughness/metal) maps at physical scale.

## Window and door kits

`build_openings.py` authors five GLBs in Blender: casement bay, fixed bay, door frame, panelled leaf and glazed leaf. Each is built around a native opening and has true-size `edges` bands. `src/renderOpenings.ts` maps the bands rigidly and scales only the interior, which holds the glass and panels. Hardware moves as a whole.

- **Windows.** The bottom row is casement bays of at most 1.5 m, and upper rows are fixed bays when the window is taller than 2.4 m. The stool, the projecting sill with drip cap, and the exterior trim boards are placed once per opening.
- **Glass walls.** These use fixed bays of at most 1.8 m by 3.2 m.
- **Doors.**
  - Every door gets a frame with linings, stops, both casings and a threshold.
  - Exterior doors are closed glazed leaves: one leaf up to 1.25 m wide, a pair up to 2.5 m, and 1.1 m panels beyond that.
  - Interior doors have panelled leaves standing open 90° into the room that owns the connection. Interior doors wider than 2.5 m show no leaf, so they read as pocket doors.
- **Interior windows.** Windows between two indoor rooms are fixed glazing, drawn once by the owning room.
- **Fallback.** The procedural openings stay as the fallback while the kits load or if they fail.

## Starter catalog

There are 27 Poly Haven models (CC0), each recorded with its source, authors and licence in the manifest. Each has a 160 px Cycles thumbnail.

| Kind | Count | Models |
| --- | --- | --- |
| Sofa | 3 | tufted curved, camelback, painted wooden settle |
| Armchair | 3 | oak lounge, mid-century swivel, bergère |
| Coffee table | 4 | concrete/oak, inlaid block, round steel, industrial |
| Dining table | 3 | plank, round pedestal, small wooden |
| Chair | 3 | tufted leather, white painted, ladder-back |
| Bed | 2 | iron frame, carved four-post |
| Nightstand | 3 | open shelf, painted, carved |
| Wardrobe | 3 | carved cabinet, glazed hutch, tall shelf cabinet |
| Plant (new kind) | 3 | ficus, aloe, leafy plant |

- **Picker.** When a piece is selected, the panel shows its kind's models plus a "Built-in" parametric option. The choice is stored in `furniture.model`, and `'builtin'` forces the procedural piece.
- **Size.** Models with stretch zones (sofas, rectangular tables, beds) keep the saved size. Other models adopt their native size, and "Use model size" restores it.
- **Defaults.** A kind's default model renders wherever a piece has no `model`. The defaults are the oak lounge armchair, the concrete and oak coffee table and the tufted sofa (from the pilot), plus the plank dining table (with a natural-oak default finish) and the potted ficus. Chairs, nightstands, beds and wardrobes keep the built-in pieces: the catalog options are classic or rustic, and the one contemporary chair is a tufted Chesterfield that distorts at the saved chair size. Saved houses changed appearance where these kinds had no model.
- **Agent prompt.** The design agent's system prompt carries a generated FURNITURE MODELS AND FINISHES section (`furnitureLibraryPrompt()` in `shared/finishes.ts`). It lists model IDs per kind with style, DEFAULT, stretch or native size, slots and default finishes, and finish IDs per slot. `tests/agent-furniture-library.test.ts` checks it against `public/assets/manifest.json`.

## Evidence

`npx tsx scripts/capture-great-room.ts --out <dir> [--demo-finishes] [--demo-catalog] [--demo-slots]` adds exterior, entry-door, bedroom and kitchen cameras. The demo flags change only the isolated fixture copy; `--demo-slots` shows the settle and the mid-century chair with swapped finishes. Before/after pairs are in `.data/verification/assets-pass/pairs-step{1,1b,2,2b,3,3b}/`. The defaults and slot fixes are in `.data/verification/lighting-pass/pairs-step1/` and `pairs-step2/`, the latter with 8-angle slot renders.

`build-assets.ts --only <id>` rebuilds one model and refreshes the catalog metadata (name, style, default, finishes) of the others from `sources.json`.

## Known gaps

- Poly Haven has no modern beds, wardrobes, kitchen or bathroom fixtures. Those kinds have no catalog model, or only classic and rustic ones, and the built-in parametric pieces remain the modern option.
- Atlas splits are heuristic and checked by eye. The mid-century chair and settle splits were fixed with hue and height rules.
- Non-stretch default models are fitted to the saved envelope, so a piece saved at another size is distorted. The armchair default is 16 % wider and 12 % lower than native at the default armchair size.
- `update_furniture` replaces a piece's whole finish map, and `model` can be switched back to a kind's default only by naming the default's ID.
- The cognac leather has tufting baked into its texture, which looks wrong on smooth cushions.
