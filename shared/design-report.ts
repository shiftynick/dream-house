import { effectiveSurfacePalettes, surfaces } from './design.ts';
import { effectiveRoof } from './architecture.ts';
import { palettes, type Scene } from './model.ts';
import { outdoor } from './geometry.ts';

export const reportAreaNote =
  'Areas are modeled room internal rectangles (width × depth), not surveyed, buildable or net usable areas. Outdoor spaces are listed separately. Overlaps are not deducted.';
export const reportConceptNote = 'Concept design · meters · not construction documents';
export const reportNumber = (value: number) => Number(value.toFixed(2)).toString();
export function reportFilename(name: string): string {
  return (
    name
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 70) || 'terrain-house'
  );
}
export function escapeReportText(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!,
  );
}
export function buildDesignReport(scene: Scene) {
  const rooms = [...scene.rooms].sort(
    (a, b) => a.elevation - b.elevation || a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
  );
  const levels: number[] = [];
  for (const room of rooms)
    if (!levels.some((level) => Math.abs(level - room.elevation) < 0.01))
      levels.push(room.elevation);
  const schedule = rooms.map((room) => ({
    id: room.id,
    name: room.name,
    kind: room.kind,
    elevation: room.elevation,
    width: room.width,
    depth: room.depth,
    area: room.width * room.depth,
    outdoor: outdoor(room),
  }));
  const materials = rooms.flatMap((room) => {
    const effective = effectiveSurfacePalettes(scene, room);
    const roof = effectiveRoof(scene, room);
    return (outdoor(room) ? (['floor'] as const) : surfaces).map((surface) => ({
      roomId: room.id,
      room: room.name,
      elevation: room.elevation,
      surface,
      palette: effective[surface],
      paletteName: palettes[effective[surface]].name,
      source:
        room.surfacePalettes?.[surface] !== undefined
          ? 'Surface override'
          : room.palette !== undefined
            ? 'Room palette'
            : 'House default',
      roof:
        surface === 'roof'
          ? `${roof.style}${roof.style === 'flat' ? '' : ` · ${reportNumber(roof.pitch)}° · ${roof.direction}`}`
          : '',
    }));
  });
  return {
    name: scene.name,
    levels,
    schedule,
    materials,
    indoorArea: schedule.filter((room) => !room.outdoor).reduce((sum, room) => sum + room.area, 0),
    outdoorArea: schedule.filter((room) => room.outdoor).reduce((sum, room) => sum + room.area, 0),
  };
}
export type DesignReportData = ReturnType<typeof buildDesignReport>;
/** Quote every field, and neutralize spreadsheet formula prefixes in user-controlled text. */
function csv(rows: (string | number)[][]): string {
  return (
    '\uFEFF' +
    rows
      .map((row) =>
        row
          .map((value) => {
            let text = String(value);
            if (typeof value === 'string' && /^[\s]*[=+@-]/.test(text)) text = "'" + text;
            return `"${text.replace(/"/g, '""')}"`;
          })
          .join(','),
      )
      .join('\r\n') +
    '\r\n'
  );
}
export function roomScheduleCsv(report: DesignReportData): string {
  return csv([
    [
      'Room ID',
      'Room',
      'Use',
      'Elevation (m)',
      'Width (m)',
      'Depth (m)',
      'Modeled rectangle area (m²)',
      'Indoor / outdoor',
    ],
    ...report.schedule.map((room) => [
      room.id,
      room.name,
      room.kind,
      room.elevation,
      room.width,
      room.depth,
      Number(room.area.toFixed(2)),
      room.outdoor ? 'Outdoor' : 'Indoor',
    ]),
    ['Area definition', reportAreaNote],
  ]);
}
export function materialSummaryCsv(report: DesignReportData): string {
  return csv([
    [
      'Room ID',
      'Room',
      'Elevation (m)',
      'Surface',
      'Palette ID',
      'Palette name',
      'Inheritance',
      'Roof configuration',
    ],
    ...report.materials.map((material) => [
      material.roomId,
      material.room,
      material.elevation,
      material.surface,
      material.palette,
      material.paletteName,
      material.source,
      material.roof,
    ]),
    [
      'Palette note',
      'Palette names identify coordinated finishes, not literal substances on every face. This summary excludes furniture.',
    ],
  ]);
}
