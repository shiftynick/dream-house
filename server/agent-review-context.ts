import { canonical, type DesignDraft } from '../shared/draft.ts';
import type { inspectDesignQuality } from '../shared/design-quality.ts';

/** Read-only review projection. Editing restores the complete inspector payload. */
export function projectReviewInspection(inspection: ReturnType<DesignDraft['inspect']>) {
  const { furnitureCatalog: _catalog, ...review } = inspection;
  const topIssues = new Set(inspection.issues.map(canonical));
  const duplicateSpatialIssues = inspection.spatial.issues.every((issue) =>
    topIssues.has(canonical(issue)),
  );
  return {
    ...review,
    spatial: duplicateSpatialIssues
      ? { ...inspection.spatial, issues: undefined }
      : inspection.spatial,
    reviewProjection:
      'Editing furniture catalog and duplicate spatial issues are omitted. All geometry, effective openings/materials, furniture bounds/clearance assumptions, graph and unique issues remain. resume_editing restores the full editing snapshot.',
  };
}

/** Omit placement suggestions, retaining actual openings and exposed wall geometry. */
export function projectReviewQuality(quality: ReturnType<typeof inspectDesignQuality>) {
  return {
    ...quality,
    rooms: quality.rooms.map((room) => ({
      ...room,
      walls: room.walls.map(({ availableWindowRectangles: _available, ...wall }) => wall),
    })),
    reviewProjection:
      'New-window placement suggestions are omitted during review; exposed wall rectangles and actual window counts, sizes, areas and materials remain. resume_editing restores placement slots.',
  };
}
