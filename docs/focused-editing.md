# Focused edits and preservation

Select a room, surface, furniture piece, or individual aperture and enable **Only selected part** beside the composer. The selection is snapshotted for that request. The server compares the candidate with its original draft baseline, including generated furniture and apertures in world coordinates. Extra changes require a disclosed proposal and explicit adoption, even if the model requests automatic application or omits its checklist.

Scope means the selected logical part: an entire room, one surface's finish, one furniture item, one aperture, or an anchored wall move. Moving a wall may stretch adjoining solid walls, but cannot silently move their doors/windows or the room's furniture. Closing the last selected aperture also normalizes its old door/open/glass fallback to solid so removal cannot recreate a phantom passage. Derived mirror faces belong to the same physical aperture.

API clients can supply `context.editScope` and/or `context.preservationChecks` for immutable checks. Available assertions are `unchanged_room` (optional property groups), `unchanged_surface`, `unchanged_furniture`, `unchanged_opening`, and `unchanged_except_selection`. `unchanged_surface` checks the effective palette only; use room geometry or aperture assertions for dimensions and location. Room checks also retain material/roof inheritance policy. Individual aperture assertions use `opening_item` with stable ID, side, presence and optional dimensions.

Natural-language preservation clauses are interpreted by the model and should appear as typed checks in its assessment. The immutable selection control does not depend on the model extracting that intent correctly. Preservation is per request; it does not add permanent locks to the design brief. Discarding a proposal leaves the saved scene and undo history unchanged.

Checks evaluate saved geometry and effective finishes. They do not certify construction feasibility or prove that a rendered view visibly contains the requested detail. Visual observations remain the model's judgments with capture provenance and limitations.
