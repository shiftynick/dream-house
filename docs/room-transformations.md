# Semantic room transformations

Three commands edit rectangular room partitions as one atomic design operation. They use the existing scene schema, storage, undo/redo and draft review. They are available through `commandSchema`, so the design agent and other callers use the same geometry engine.

| Command | Contract | Result |
| --- | --- | --- |
| `move_shared_wall` | `roomAId`, `roomBId`, `delta` | Positive meters expand A into B; negative meters expand B into A. The outside footprint stays fixed. |
| `split_room` | `roomId`, `axis`, `offset`, `newRoomId`, `newRoomName`, optional `newRoomKind`, optional `passage` | X divides west/east; Z divides north/south. The original ID retains the west/north part. Offset is relative to the original center. |
| `merge_rooms` | `roomAId`, `roomBId`, optional `name` | Keep A's ID and kind, remove B and their internal partition, and retain the rectangular union. |

`passage` takes a caller-supplied stable `id`, `kind` (`door` or `open`, default door), `width` (default 1.3 m), `height` (default 2.4 m), and optional world-coordinate `center` along the new wall. Omission creates a solid partition only when an alternate indoor route already connects both parts. Openings need 0.02 m clearance at each end. The resulting rooms must each remain 1.5–30 m wide and deep.

`inspectDesign.sharedWalls` returns both room IDs, side names, shared interval, normal axis and wall coordinate. `positiveDeltaDirection` is the named side of A pointing toward B. `fullWall` and `sameFloorAndHeight` identify geometric prerequisites, not a complete promise that furniture, finishes or requirements permit the edit.

## Preservation and supported cases

The current scope is enclosed rooms with flat roofs. A two-room operation requires identical floor elevations/heights and a complete common wall forming a rectangular union. Sloped roofs, partial/T-shaped partitions and affected stairs or linked landings are rejected with an actionable error. A new wall cannot cut through a fireplace hearth, furniture, rug or aperture.

Furniture retains IDs, dimensions, rotation and world position. Pieces are reassigned to whichever resulting room fully contains their conservative rotated bounds. Legacy generated layouts are materialized only as part of an accepted transformation. If reassignment would change an inherited furniture palette, the old palette becomes explicit. A merge with duplicate room-local furniture IDs is rejected instead of silently renaming or dropping a piece.

Explicit exterior apertures keep their stable IDs and world locations; their owning room may change. Apertures owned by untouched neighbors remain there and continue to mirror through the existing opening resolver. Semantic external connections retain their IDs, centers and dimensions while their endpoint room changes when needed. Internal connections disappear only when their partition is removed. A moved shared wall carries its own apertures normal to the wall. Legacy doors are converted to one explicit physical owner at their original location; blocked or differently sized legacy shared doors, whole-open opposite walls and outdoor edges must first be resolved explicitly so a transformation cannot invent a route, infill an untouched facade or narrow a neighboring route. Vertically disjoint neighbors are excluded from this check.

The renderer stores one finish and whole-wall style per room side. If combining exterior segments would flatten different finishes or solid/glass/open sections into one arbitrary style, the operation is rejected. Harmonize only the intended wall finish explicitly before retrying. Merged floors and roofs, and floors/roofs on both sides of a moved shared wall, must have matching effective palettes; a transferred strip cannot retain a separate finish in the current room schema. Separate outer end-wall finishes survive as surface overrides. This prevents a merge from silently erasing intentional material differences.

Groups containing a split room gain both resulting IDs. Merge groups replace B with A and remove duplicate membership. Other rooms and their fields remain untouched. Requirements and lock snapshots are never rewritten. A merge that would remove a room referenced by a typed requirement is rejected until that requirement is resolved explicitly. Confirmed locks, symmetry, connectivity and other validation errors caused by a transform roll back the batch. Existing indoor routes between surviving room identities must remain connected; an enclosed split also needs indoor access between both parts.

Removing B is still a room removal in the existing design diff. The normal consequential-change proposal policy applies; this engine does not bypass review or change persistence rules.

## Verification

`tests/room-transform.test.ts` covers all four shared-wall directions and both delta signs; anchored exterior bounds; stable world furniture poses; reassigned and mirrored openings; semantic connection endpoints; groups; untouched rooms and requirements; legacy materialization; explicit finish conflicts; cuts through furniture/rugs/apertures/fireplaces; stair, slope, footprint and dimension rejection; protected snapshots and symmetry; route preservation; whole-batch rollback; and serialized one-step undo/redo. These are deterministic synthetic geometry checks, not construction or building-code certification.
