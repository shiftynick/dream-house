import {
  buildDesignReport,
  escapeReportText as esc,
  reportAreaNote,
  reportConceptNote,
  reportNumber as n,
  type DesignReportData,
} from '../shared/design-report';
import { roomOpenings } from '../shared/openings';
import { bounds, outdoor, sides } from '../shared/geometry';
import { roomFurniture } from '../shared/furniture';
import { stairPlanFootprint } from '../shared/spatial';
import type { Scene } from '../shared/model';
import { wallAxis, wallPanels } from './renderGeometry';
import { openingControlEntries } from './ArchitectureControls';

/** Standalone landscape sheet. Its meter scale bar stays valid when the SVG is resized. */
export function floorPlanSheetSvg(scene: Scene, elevation: number): string {
  const rooms = scene.rooms.filter((room) => Math.abs(room.elevation - elevation) < 0.01);
  const stairs = scene.stairs.filter(
    (stair) =>
      elevation >= stair.elevation - 0.01 && elevation <= stair.elevation + stair.rise + 0.01,
  );
  const rectangles = [
    ...rooms.map((room) => {
      const b = bounds(room);
      return { minX: b.west, minZ: b.north, maxX: b.east, maxZ: b.south };
    }),
    ...stairs.map((stair) => stairPlanFootprint(stair)),
  ];
  const minX = rectangles.length ? Math.min(...rectangles.map((r) => r.minX)) : -5;
  const minZ = rectangles.length ? Math.min(...rectangles.map((r) => r.minZ)) : -5;
  const maxX = rectangles.length ? Math.max(...rectangles.map((r) => r.maxX)) : 5;
  const maxZ = rectangles.length ? Math.max(...rectangles.map((r) => r.maxZ)) : 5;
  const scale = Math.min(980 / Math.max(1, maxX - minX), 530 / Math.max(1, maxZ - minZ));
  const left = 560 - ((maxX - minX) * scale) / 2;
  const top = 370 - ((maxZ - minZ) * scale) / 2;
  const x = (value: number) => left + (value - minX) * scale;
  const y = (value: number) => top + (value - minZ) * scale;
  const line = (x1: number, y1: number, x2: number, y2: number, attributes = '') =>
    `<line x1="${n(x(x1))}" y1="${n(y(y1))}" x2="${n(x(x2))}" y2="${n(y(y2))}" ${attributes}/>`;
  const shapes: string[] = [];
  for (const room of rooms) {
    const b = bounds(room);
    shapes.push(
      `<g><title>${esc(room.name)} · ${n(room.width)} × ${n(room.depth)} m</title><rect x="${n(x(b.west))}" y="${n(y(b.north))}" width="${n(room.width * scale)}" height="${n(room.depth * scale)}" fill="${outdoor(room) ? '#eef3e9' : '#f5f5f1'}" stroke="${outdoor(room) ? '#71816b' : 'none'}" stroke-dasharray="5 3"/>`,
    );
    for (const item of roomFurniture(room)) {
      shapes.push(
        `<g transform="translate(${n(x(room.x + item.x))} ${n(y(room.z + item.z))}) rotate(${-item.rotation})"><rect x="${n((-item.width * scale) / 2)}" y="${n((-item.depth * scale) / 2)}" width="${n(item.width * scale)}" height="${n(item.depth * scale)}" fill="none" stroke="#a3aaa1" stroke-width="0.8"${item.kind === 'rug' ? ' stroke-dasharray="3 3"' : ''}/></g>`,
      );
    }
    shapes.push('</g>');
  }
  // Use the same one-meter plan wall section as the interactive plan, including
  // legacy walls and mirrored semantic passages; floor outlines own their walls.
  for (const room of rooms.filter((room) => !outdoor(room)))
    for (const side of sides) {
      const axis = wallAxis(room, side);
      for (const panel of wallPanels(scene, room, side, false).filter(
        (panel) => panel.bottom < 1 && panel.bottom + panel.height > 1,
      )) {
        const a = axis.center + panel.offset - panel.width / 2;
        const b = a + panel.width;
        shapes.push(
          line(
            axis.horizontal ? a : axis.boundary,
            axis.horizontal ? axis.boundary : a,
            axis.horizontal ? b : axis.boundary,
            axis.horizontal ? axis.boundary : b,
            'stroke="#25382d" stroke-width="3"',
          ),
        );
      }
      const resolvedOpenings = roomOpenings(scene, room.id, side);
      const openings = resolvedOpenings.length
        ? resolvedOpenings
        : openingControlEntries(scene, room, side, 'report-legacy-opening');
      for (const opening of openings.filter(
        (opening) => opening.kind === 'window' || opening.sill < 1,
      )) {
        const a = axis.center + opening.offset - opening.width / 2;
        const b = a + opening.width;
        const points = [
          axis.horizontal ? a : axis.boundary,
          axis.horizontal ? axis.boundary : a,
          axis.horizontal ? b : axis.boundary,
          axis.horizontal ? axis.boundary : b,
        ];
        const title = `${opening.kind} · ${n(opening.width)} × ${n(opening.height)} m`;
        shapes.push(
          `<g><title>${esc(title)}</title>${line(points[0], points[1], points[2], points[3], opening.kind === 'window' ? 'stroke="#3f7c9a" stroke-width="2"' : 'stroke="#b88638" stroke-width="1.5" stroke-dasharray="4 3"')}</g>`,
        );
      }
    }
  for (const stair of stairs) {
    const steps = Math.max(2, Math.ceil(stair.rise / 0.18));
    shapes.push(
      `<g transform="translate(${n(x(stair.x))} ${n(y(stair.z))}) rotate(${-stair.rotation})"><title>Stair · ${n(stair.width)} m wide · ${n(stair.rise)} m rise</title><rect x="${n((-stair.width * scale) / 2)}" y="${n((-stair.run * scale) / 2)}" width="${n(stair.width * scale)}" height="${n(stair.run * scale)}" fill="#fff" stroke="#536459" stroke-width="1"/>`,
    );
    for (let index = 1; index < steps; index++)
      shapes.push(
        `<line x1="${n((-stair.width * scale) / 2)}" x2="${n((stair.width * scale) / 2)}" y1="${n((-stair.run / 2 + (stair.run * index) / steps) * scale)}" y2="${n((-stair.run / 2 + (stair.run * index) / steps) * scale)}" stroke="#9ca69f" stroke-width="0.8"/>`,
      );
    shapes.push(
      `<path d="M 0 ${n(-stair.run * scale * 0.35)} V ${n(stair.run * scale * 0.35)} l -5 -8 m 5 8 l 5 -8" fill="none" stroke="#25382d" stroke-width="1.5"/></g>`,
    );
  }
  // Labels are above geometry and fitted to room width; full names remain in title/schedule.
  for (const room of rooms) {
    const font = Math.min(
      16,
      Math.max(7, (room.width * scale) / Math.max(6, room.name.length * 0.58)),
    );
    const dimensions = `${n(room.width)} × ${n(room.depth)} m · ${n(room.width * room.depth)} m²`;
    const dimensionFont = Math.min(
      12,
      font,
      (room.width * scale) / Math.max(6, dimensions.length * 0.58),
    );
    shapes.push(
      `<text x="${n(x(room.x))}" y="${n(y(room.z) - 7)}" text-anchor="middle" font-size="${n(font)}" font-weight="600" paint-order="stroke" stroke="#fff" stroke-width="3">${esc(room.name)}</text><text x="${n(x(room.x))}" y="${n(y(room.z) + 13)}" text-anchor="middle" font-size="${n(dimensionFont)}" paint-order="stroke" stroke="#fff" stroke-width="3">${dimensions}</text>`,
    );
  }
  const bar = [1, 2, 5, 10, 20].filter((value) => value * scale <= 220).at(-1) ?? 1;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1120" height="790" viewBox="0 0 1120 790" role="img" aria-label="${esc(scene.name)} floor plan at ${n(elevation)} meters" font-family="Arial, sans-serif" fill="#25382d"><rect width="1120" height="790" fill="#fff"/><text x="40" y="40" font-size="24" font-weight="600">${esc(scene.name)}</text><text x="40" y="67" font-size="14">Floor plan · elevation ${n(elevation)} m · ${reportConceptNote}</text>${shapes.join('')}<path d="M 1060 110 V 82 l -6 10 m 6 -10 l 6 10" stroke="#25382d" fill="none" stroke-width="2"/><text x="1060" y="75" text-anchor="middle" font-size="14">N</text><path d="M 40 695 v 7 h ${n(bar * scale)} v -7" stroke="#25382d" stroke-width="2" fill="none"/><text x="40" y="725" font-size="13">${bar} m reference · use the bar when resizing</text><text x="400" y="704" font-size="13">Blue: window · dashed amber: door / passage · arrows: stair up</text><text x="40" y="752" font-size="12">Room areas: modeled internal rectangles. Outdoor areas separate. Openings shown schematically; no door swings assumed.</text><text x="40" y="773" font-size="12">Furniture outlines are schematic. Floor plan is a horizontal section at 1 m; windows above this section remain marked.</text></svg>`;
}

export function designReportPrintHtml(
  scene: Scene,
  report: DesignReportData = buildDesignReport(scene),
): string {
  const table = (headers: string[], rows: string[][]) =>
    `<table><thead><tr>${headers.map((header) => `<th>${esc(header)}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${esc(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(scene.name)} · Design report</title><style>@page{size:A4 landscape;margin:12mm}body{font:12px Arial,sans-serif;color:#25382d;margin:0}h1{font-size:23px}h2{font-size:19px}p{line-height:1.5}.sheet{break-after:page}.sheet svg{width:100%;height:auto;max-height:180mm}.schedule{break-before:page}table{width:100%;border-collapse:collapse}th,td{text-align:left;border-bottom:1px solid #ddd;padding:7px 5px;overflow-wrap:anywhere}th{background:#f1f3ef}thead{display:table-header-group}tr{break-inside:avoid}.note{color:#58685e}.materials{break-before:page}</style></head><body>${report.levels.map((level) => `<section class="sheet">${floorPlanSheetSvg(scene, level)}</section>`).join('')}<section class="schedule"><h1>${esc(scene.name)} · Room area schedule</h1><p>${reportConceptNote}</p><p class="note">${reportAreaNote}</p>${table(
    ['Room', 'Use', 'Elevation (m)', 'Width × depth (m)', 'Area (m²)', 'Category'],
    report.schedule.map((room) => [
      room.name,
      room.kind,
      n(room.elevation),
      `${n(room.width)} × ${n(room.depth)}`,
      n(room.area),
      room.outdoor ? 'Outdoor' : 'Indoor',
    ]),
  )}<p>Indoor rectangles: ${n(report.indoorArea)} m² · outdoor rectangles: ${n(report.outdoorArea)} m²</p></section><section class="materials"><h2>Effective material summary</h2><p class="note">Coordinated palette IDs, with inheritance shown. Palette names are not literal substances on every face. Furniture is excluded.</p>${table(
    ['Room', 'Elevation (m)', 'Surface', 'Palette', 'Inheritance', 'Roof configuration'],
    report.materials.map((material) => [
      material.room,
      n(material.elevation),
      material.surface,
      material.paletteName,
      material.source,
      material.roof,
    ]),
  )}</section></body></html>`;
}
