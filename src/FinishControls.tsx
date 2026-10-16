import {
  catalogMaterial,
  finishFits,
  finishOptions,
  finishSlotLabels,
} from '../shared/finishes';
import type { FinishSlot, Finishes } from '../shared/model';

/** One select per finish slot; a change applies at once, like the palette select.
 * Empty means "inherit": the room default for a piece, the model's own finish for
 * a room. Grayscale fabrics take the palette color, so they follow palette changes. */
export function FinishControls({
  label,
  slots,
  value,
  inherited,
  disabled,
  onChange,
}: {
  label: string;
  slots: FinishSlot[];
  value?: Finishes;
  /** Room defaults shown in a piece's "inherit" option. */
  inherited?: Finishes;
  disabled: boolean;
  onChange: (next: Finishes) => void;
}) {
  if (!slots.length) return null;
  return (
    <fieldset className="finish-controls" aria-label={label}>
      <legend>{label}</legend>
      <div className="field-grid">
        {slots.map((slot) => {
          const current = value?.[slot];
          const fallback = inherited?.[slot] && finishFits(slot, inherited[slot]!)
            ? catalogMaterial(inherited[slot])
            : undefined;
          const shown = catalogMaterial(current) ?? fallback;
          return (
            <label key={slot} className="field-label">
              <span className="finish-slot">
                <i
                  className="finish-swatch"
                  style={{ background: shown?.swatch ?? 'transparent' }}
                  title={shown ? `${shown.name}${shown.tinted ? ', palette colour' : ''}` : 'Model finish'}
                />
                {finishSlotLabels[slot]}
              </span>
              <select
                aria-label={`${label}: ${finishSlotLabels[slot]}`}
                disabled={disabled}
                value={current && finishFits(slot, current) ? current : ''}
                onChange={(event) => {
                  const next = { ...value };
                  if (event.target.value) next[slot] = event.target.value;
                  else delete next[slot];
                  onChange(next);
                }}
              >
                <option value="">
                  {inherited ? (fallback ? `Room: ${fallback.name}` : 'Room default') : 'Model finish'}
                </option>
                {finishOptions(slot).map((item) => (
                  <option key={item.id} value={item.id} title={item.attribution}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
