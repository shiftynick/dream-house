# Precise plan and opening edits

In Floor plan, drag a furniture symbol to preview its position. Select it and drag the round handle to rotate it. Movement uses 0.01 m increments and rotation uses 1° increments; Shift snaps to 0.1 m or 15°. Arrow keys move a selected piece 0.1 m, or 0.01 m with Shift. The rotation handle supports left/right arrows in 5° steps. Numeric furniture controls remain available.

Pointer movement changes only an ephemeral preview. A successful release sends one `update_furniture` command through the existing validated editor path, producing one history entry. A click without movement, Escape, pointer cancellation, lost capture, window blur, selection change, changed scene or disabled editing discards the preview. A piece that would extend beyond its room, including its rotated bounds, shows an invalid outline and produces an actionable error on release without saving. Merely selecting or cancelling a legacy generated piece never materializes its layout. A successful edit materializes it through the existing engine.

Furniture editing is disabled while a proposal, alternative, saved comparison, running model turn or persistence conflict owns the viewport. SVG pointer coordinates are derived from the full screen matrix, so responsive scaling and letterboxing do not alter saved meter coordinates.

## Individual openings

Click a window, door or passage symbol in Floor plan, click its glazing/frame in 3D, or use the inspector's Selected opening dropdown. The selection carries the visible room, wall side and stable `openingId`. It can address an aperture from either side of a shared wall. Invalid/stale IDs and simultaneous furniture/opening selection are rejected.

The focused inspector changes only the selected ID. `update_opening` accepts `{roomId, side, openingId, patch}` with optional kind, offset, width, height and sill. Offset and sill use the selected room's coordinates. For mirrored explicit apertures, the engine converts those coordinates back to the physical owner; it never copies the aperture into both rooms. For semantic connections, it updates the existing connection's world center and dimensions. Connection IDs, siblings, materials and whole-wall flags remain unchanged by updates. A connected passage must stay a floor-level door or open passage; an open passage derives its height from the connected rooms.

`remove_opening` accepts `{roomId, side, openingId}` and removes just that physical aperture or semantic connection. When its last resolved opening disappears, affected owner/mirror wall flags `door`, `open` or `glass` become `solid`; otherwise the legacy fallback would regenerate a doorway or whole glazed wall. Siblings and unrelated wall flags remain untouched. Invalid geometry, protected opening snapshots, newly broken routes and other edit-validation failures reject the operation atomically. In particular, deleting the only passage between rooms does not silently disconnect them.

Updates cannot make a mirrored receiver with a legacy `door`, `open` or `glass` wall gain its first or lose its last resolved aperture: that would also change unrelated wall geometry by switching its whole-wall fallback. Such updates reject atomically with `opening_mirror_transition`. Keep the aperture on the same shared wall, or explicitly configure the affected receiver as solid with individual openings first. Solid receivers and receiver faces retaining another aperture support these moves without changing their wall flags.

Whole-wall opening controls remain available when no individual opening is selected, including legacy whole-wall glazing/doors that do not yet have a persisted opening ID. Precise selection does not automatically materialize these implicit features.

## Verification

`tests/precise-editing.test.ts` covers explicit siblings, mirrored ownership and split-level coordinate conversion, semantic edits/removals, last-aperture fallback closure, stale/invalid/locked edits, route preservation, semantic open height from a taller room, selection validity, full SVG coordinate inversion, hundreds of preview updates yielding one history entry, consumed/cancelled/no-op gestures, rejected out-of-bounds releases, legacy materialization, yaw/snapping and accessible controls. Browser checks separately exercise real pointer capture and selection cancellation; no model or rendering provider is needed for these deterministic tests.
