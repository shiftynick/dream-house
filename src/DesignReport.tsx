import { useMemo, useState } from 'react';
import { Download, Printer } from 'lucide-react';
import {
  buildDesignReport,
  materialSummaryCsv,
  reportAreaNote,
  reportFilename,
  reportNumber,
  roomScheduleCsv,
} from '../shared/design-report';
import type { Scene } from '../shared/model';
import { designReportPrintHtml, floorPlanSheetSvg } from './designReportSheets';
import './designReport.css';

function downloadReport(content: string, filename: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export default function DesignReport({ scene, onClose }: { scene: Scene; onClose?: () => void }) {
  const report = useMemo(() => buildDesignReport(scene), [scene]);
  const sheets = useMemo(
    () =>
      report.levels.map((elevation) => ({ elevation, svg: floorPlanSheetSvg(scene, elevation) })),
    [scene, report],
  );
  const [error, setError] = useState('');
  const basename = reportFilename(scene.name);
  const print = () => {
    const printWindow = window.open('', '_blank');
    if (!printWindow) {
      setError('Allow this browser to open the report window, then try Print / save PDF again.');
      return;
    }
    setError('');
    printWindow.opener = null;
    printWindow.document.open();
    printWindow.document.write(designReportPrintHtml(scene, report));
    printWindow.document.close();
    printWindow.focus();
    printWindow.print();
  };
  return (
    <section className="design-report" aria-label="Shareable design report">
      <p className="panel-note">
        Export floor-plan sheets, room areas and effective architectural materials. Use your
        browser’s Save as PDF destination to save the complete printed report.
      </p>
      <div className="design-report-actions">
        <button className="primary small" onClick={print}>
          <Printer size={15} /> Print / save PDF
        </button>
        <button
          className="text-button"
          onClick={() =>
            downloadReport(
              roomScheduleCsv(report),
              `${basename}-room-areas.csv`,
              'text/csv;charset=utf-8',
            )
          }
        >
          <Download size={15} /> Room areas CSV
        </button>
        <button
          className="text-button"
          onClick={() =>
            downloadReport(
              materialSummaryCsv(report),
              `${basename}-materials.csv`,
              'text/csv;charset=utf-8',
            )
          }
        >
          <Download size={15} /> Materials CSV
        </button>
      </div>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      {!sheets.length && <p>No rooms yet. Add rooms to create floor-plan sheets.</p>}
      {sheets.map((sheet) => (
        <article className="design-report-sheet" key={sheet.elevation}>
          <div className="design-report-sheet-heading">
            <h3>Elevation {reportNumber(sheet.elevation)} m</h3>
            <button
              className="text-button"
              onClick={() =>
                downloadReport(
                  sheet.svg,
                  `${basename}-floor-${reportFilename(String(sheet.elevation))}${sheet.elevation < 0 ? '-below-zero' : ''}m.svg`,
                  'image/svg+xml;charset=utf-8',
                )
              }
            >
              <Download size={15} /> Download SVG sheet
            </button>
          </div>
          <img
            src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(sheet.svg)}`}
            alt={`Floor plan of ${scene.name} at elevation ${reportNumber(sheet.elevation)} meters`}
          />
        </article>
      ))}
      <h3>Room area schedule</h3>
      <p className="panel-note">{reportAreaNote}</p>
      <div className="design-report-table">
        <table>
          <thead>
            <tr>
              <th>Room</th>
              <th>Use</th>
              <th>Elevation (m)</th>
              <th>Width × depth (m)</th>
              <th>Area (m²)</th>
              <th>Category</th>
            </tr>
          </thead>
          <tbody>
            {report.schedule.map((room) => (
              <tr key={room.id}>
                <td>{room.name}</td>
                <td>{room.kind}</td>
                <td>{reportNumber(room.elevation)}</td>
                <td>
                  {reportNumber(room.width)} × {reportNumber(room.depth)}
                </td>
                <td>{reportNumber(room.area)}</td>
                <td>{room.outdoor ? 'Outdoor' : 'Indoor'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p>
        Indoor rectangles: {reportNumber(report.indoorArea)} m² · outdoor rectangles:{' '}
        {reportNumber(report.outdoorArea)} m²
      </p>
      <details className="design-report-materials">
        <summary>Effective material summary · {report.materials.length} surfaces</summary>
        <p className="panel-note">
          Palette names identify coordinated finishes, not literal substances on every face.
          Furniture is excluded.
        </p>
        <div className="design-report-table">
          <table>
            <thead>
              <tr>
                <th>Room</th>
                <th>Surface</th>
                <th>Palette</th>
                <th>Inheritance</th>
                <th>Roof configuration</th>
              </tr>
            </thead>
            <tbody>
              {report.materials.map((material) => (
                <tr key={`${material.roomId}-${material.surface}`}>
                  <td>{material.room}</td>
                  <td>{material.surface}</td>
                  <td>{material.paletteName}</td>
                  <td>{material.source}</td>
                  <td>{material.roof}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
      {onClose && (
        <div className="design-report-actions">
          <button className="text-button" onClick={onClose}>
            Close report
          </button>
        </div>
      )}
    </section>
  );
}
