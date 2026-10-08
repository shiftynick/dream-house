# Shareable design reports

Open **Design report** to review and export the current saved/editable scene. The report does not call a model, upload images, change the scene, or materialize legacy furniture.

- **Download SVG sheet** saves one standalone landscape floor-plan sheet for each modeled room elevation. Sheets include names, dimensions in meters, room rectangle areas, schematic furniture, walls/windows/doors, stairs, a north arrow and a meter reference bar. Preserve the reference bar when resizing or printing; the sheet does not promise a fixed paper scale.
- **Room areas CSV** saves a deterministic room schedule, including elevation, width, depth and area. Indoor and outdoor spaces are identified separately. Areas are modeled room internal rectangles (`width × depth`), not surveyed, buildable or net usable areas; overlaps are not deducted.
- **Materials CSV** lists the effective palette on each room's north/south/east/west walls, floor and roof. It identifies house inheritance, room palettes and surface overrides, and records effective roof configuration. Palette names identify coordinated finishes, not literal substances on every face. Furniture materials are excluded; outdoor spaces list only their floor.
- **Print / save PDF** opens a separate report window and your browser's print dialog. Choose **Save as PDF** to save all sheets, the room schedule and the material summary. Reports use landscape A4 pages with repeated table headers. If the browser blocks the window, allow it for this local app and retry. The report window remains available after closing the print dialog.

These outputs are concept-design references, not construction documents. Openings are schematic and do not assume door swing directions. The wall section is one meter above each room's floor; windows above that section remain marked. Stair footprints appear on modeled levels between their base and top elevations, with arrows pointing up. A room's name remains in the area schedule even if its plan label becomes small in a large scene.

## Implementation and checks

`shared/design-report.ts` builds nonmutating ordered schedules, effective materials, escaped text and bounded safe filenames. CSV fields are quoted and formula-like user text is neutralized. `src/designReportSheets.ts` creates escaped SVG and report HTML, reusing existing pure `wallAxis`/`wallPanels`, resolved openings, legacy opening control entries, furniture identities and stair footprints. It imports no graphics context or cloud provider.

`src/DesignReport.tsx` accepts `{ scene, onClose? }` and imports its own stylesheet. Integration should show it inside the existing wide modal and keep exports tied to the scene currently being reported. `tests/design-report.test.ts` covers units/area categories, elevation ordering, inheritance/override preservation, nonmutation, injection escaping, CSV quoting, window offsets, legacy and connected openings, stair yaw/levels, empty houses and filenames.
