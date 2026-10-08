import test from 'node:test';
import assert from 'node:assert/strict';
import { projectReviewInspection, projectReviewQuality } from '../server/agent-review-context.ts';
import { DesignDraft } from '../shared/draft.ts';
import { composeHouseRecipe } from '../shared/design-recipes.ts';
import { inspectDesignQuality } from '../shared/design-quality.ts';

const recipe = composeHouseRecipe({ recipe: 'grand-lodge' }, 'Build a usable grand lodge.');
const inspection = new DesignDraft(recipe.scene).inspect();
const quality = inspectDesignQuality(recipe.scene);

test('review projection removes only editing catalog/placement suggestions and exact duplicated issues', () => {
  const originalInspection = JSON.stringify(inspection);
  const originalQuality = JSON.stringify(quality);
  const projected = projectReviewInspection(inspection);
  assert.equal('furnitureCatalog' in projected, false);
  assert.equal(projected.spatial.issues, undefined);
  for (const [key, value] of Object.entries(inspection)) {
    if (['furnitureCatalog', 'spatial'].includes(key)) continue;
    assert.deepEqual((projected as any)[key], value, key);
  }
  assert.deepEqual(projected.spatial.furniture, inspection.spatial.furniture);
  assert.deepEqual(projected.spatial.assumptions, inspection.spatial.assumptions);
  const projectedQuality = projectReviewQuality(quality);
  projectedQuality.rooms.forEach((room, index) =>
    room.walls.forEach((wall, wallIndex) => {
      assert.equal('availableWindowRectangles' in wall, false);
      const { availableWindowRectangles: _available, ...facts } =
        quality.rooms[index].walls[wallIndex];
      assert.deepEqual(wall, facts);
    }),
  );
  assert.deepEqual(projectedQuality.features, quality.features);
  assert.deepEqual(projectedQuality.limitations, quality.limitations);
  assert.equal(JSON.stringify(inspection), originalInspection);
  assert.equal(JSON.stringify(quality), originalQuality);
  assert.ok(JSON.stringify(projected).length < originalInspection.length);
  assert.ok(JSON.stringify(projectedQuality).length < originalQuality.length);
});

test('nonduplicated spatial issues survive the review projection', () => {
  const unique = {
    code: 'unique-spatial-fact',
    severity: 'warning' as const,
    message: 'A distinct bounded clearance concern.',
    objectIds: ['arrival'],
  };
  const modified = {
    ...inspection,
    spatial: { ...inspection.spatial, issues: [...inspection.spatial.issues, unique] },
  };
  assert.deepEqual(projectReviewInspection(modified).spatial.issues, modified.spatial.issues);
});
