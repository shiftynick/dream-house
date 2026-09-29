import {
  executeCommands,
  validateDesignChange,
  inspectDesign,
  type DesignIssue,
} from './design.ts';
import { validateScene, type Scene } from './model.ts';
import { roomFurniture } from './furniture.ts';

export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .filter((k) => object[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(object[k])}`)
    .join(',')}}`;
}

export function canonicalScene(scene: Scene): string {
  const design = scene.design;
  return canonical({
    ...scene,
    design: design && Object.values(design).some((items) => items.length) ? design : undefined,
  });
}

export function describeChanges(before: Scene, after: Scene): string[] {
  const changes: string[] = [];
  if (before.name !== after.name) changes.push(`Named the house “${after.name}”.`);
  if (before.palette !== after.palette)
    changes.push(`Changed the house palette to ${after.palette}.`);
  if (before.roof !== after.roof) changes.push(`Changed the roof to ${after.roof}.`);
  if (before.roofPitch !== after.roofPitch || before.roofDirection !== after.roofDirection)
    changes.push(`Updated the house roof pitch and direction.`);
  if (before.slope !== after.slope)
    changes.push(`Changed the site slope to ${Math.round(after.slope * 100)}%.`);
  for (const room of after.rooms) {
    const old = before.rooms.find((r) => r.id === room.id);
    if (!old) {
      changes.push(`Added ${room.name}.`);
      continue;
    }
    if (old.name !== room.name) changes.push(`Renamed ${old.name} to ${room.name}.`);
    if (old.kind !== room.kind) changes.push(`Changed ${room.name} to a ${room.kind} space.`);
    if (old.x !== room.x || old.z !== room.z || old.elevation !== room.elevation)
      changes.push(`Moved ${room.name}.`);
    if (old.width !== room.width || old.depth !== room.depth || old.height !== room.height)
      changes.push(`Resized ${room.name} to ${room.width} × ${room.depth} × ${room.height} m.`);
    if (
      ['north', 'south', 'east', 'west'].some(
        (side) => old[side as 'north'] !== room[side as 'north'],
      )
    )
      changes.push(`Updated the walls and openings of ${room.name}.`);
    if (old.palette !== room.palette) changes.push(`Changed the materials of ${room.name}.`);
    if (canonical(roomFurniture(old)) !== canonical(roomFurniture(room)))
      changes.push(`Updated the furniture in ${room.name}.`);
    if (canonical(old.roof) !== canonical(room.roof))
      changes.push(
        room.roof
          ? `Updated the roof of ${room.name}.`
          : `Restored the house roof default for ${room.name}.`,
      );
    if (canonical(old.wallOpenings || []) !== canonical(room.wallOpenings || []))
      changes.push(`Updated the positioned windows and doors of ${room.name}.`);
    for (const surface of ['north', 'south', 'east', 'west', 'floor', 'roof'] as const) {
      if (old.surfacePalettes?.[surface] !== room.surfacePalettes?.[surface])
        changes.push(
          `Changed the ${surface}${['floor', 'roof'].includes(surface) ? '' : ' wall'} materials of ${room.name}.`,
        );
    }
  }
  for (const room of before.rooms)
    if (!after.rooms.some((r) => r.id === room.id)) changes.push(`Removed ${room.name}.`);
  if (canonical(before.stairs) !== canonical(after.stairs)) changes.push('Updated the stairs.');
  if (canonical(before.fireplace) !== canonical(after.fireplace))
    changes.push('Updated the fireplace.');
  if (canonical(before.design?.connections || []) !== canonical(after.design?.connections || []))
    changes.push('Updated the shared doorways and room connections.');
  if (canonical(before.design?.groups || []) !== canonical(after.design?.groups || []))
    changes.push('Updated the room groups.');
  if (canonical(before.design?.requirements || []) !== canonical(after.design?.requirements || []))
    changes.push('Updated the design brief and requirements.');
  if (canonical(before.design?.stairLinks || []) !== canonical(after.design?.stairLinks || []))
    changes.push('Updated the floor connections.');
  return changes;
}

export function requiresConfirmation(before: Scene, after: Scene): boolean {
  if (before.rooms.some((r) => !after.rooms.some((n) => n.id === r.id))) return true;
  for (const requirement of before.design?.requirements || []) {
    if (requirement.source === 'preference') continue;
    const next = after.design?.requirements.find((r) => r.id === requirement.id);
    if (canonical(requirement) !== canonical(next)) return true;
  }
  if (!before.rooms.length) return false;
  const beforeArea = before.rooms.reduce((sum, r) => sum + r.width * r.depth, 0);
  const afterArea = after.rooms.reduce((sum, r) => sum + r.width * r.depth, 0);
  return Math.abs(afterArea - beforeArea) > beforeArea * 0.35;
}

/** Pure editing session. It knows nothing about models, HTTP, storage, or MCP. */
export class DesignDraft {
  readonly original: Scene;
  private working: Scene;
  private lastErrors: DesignIssue[] = [];
  private validPreview: Scene | null = null;
  constructor(scene: Scene) {
    this.original = structuredClone(validateScene(scene));
    this.working = structuredClone(this.original);
  }
  get scene(): Scene {
    return structuredClone(this.working);
  }
  get changed(): boolean {
    return canonicalScene(this.original) !== canonicalScene(this.working);
  }
  get issues(): DesignIssue[] {
    return [...validateDesignChange(this.original, this.working), ...this.lastErrors];
  }
  get changes(): string[] {
    return describeChanges(this.original, this.working);
  }
  get preview(): Scene | null {
    return this.validPreview ? structuredClone(this.validPreview) : null;
  }
  get needsConfirmation(): boolean {
    return requiresConfirmation(this.original, this.working);
  }
  inspect() {
    const furnitureChanges = this.working.rooms.flatMap((room) => {
      const previous = this.original.rooms.find((item) => item.id === room.id);
      const before = previous ? roomFurniture(previous) : [],
        after = roomFurniture(room);
      const added = after
        .filter((item) => !before.some((old) => old.id === item.id))
        .map((item) => item.id);
      const removed = before
        .filter((item) => !after.some((next) => next.id === item.id))
        .map((item) => item.id);
      const changed = after
        .filter((item) => {
          const old = before.find((old) => old.id === item.id);
          return old && canonical(old) !== canonical(item);
        })
        .map((item) => item.id);
      return added.length || removed.length || changed.length
        ? [{ roomId: room.id, added, removed, changed }]
        : [];
    });
    return { ...inspectDesign(this.working), issues: this.issues, furnitureChanges };
  }
  /** Record a rejected mutation whose arguments could not reach the command engine. */
  recordFailure(issues: DesignIssue[]) {
    this.lastErrors = structuredClone(issues.filter((issue) => issue.severity === 'error'));
  }
  apply(operations: unknown) {
    const result = executeCommands(this.working, operations);
    if (result.applied) {
      // Out-of-bounds coordinates are valid scratch state, not a valid commit.
      // Keeping them here lets the next tool call repair the actual failed draft.
      this.working = structuredClone(result.scene);
      this.lastErrors = [];
    } else {
      this.lastErrors = result.issues.filter((i) => i.severity === 'error');
    }
    const issues = this.issues;
    if (!issues.some((i) => i.severity === 'error') && this.changed) this.validPreview = this.scene;
    return { applied: result.applied, issues, changes: this.changes, scene: this.scene };
  }
  reset() {
    this.working = structuredClone(this.original);
    this.lastErrors = [];
    this.validPreview = null;
  }
}
