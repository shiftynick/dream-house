import { BUILTIN_MODEL, chooseModelPatch, modelsForKind, pieceModel } from '../shared/finishes';
import type { Furniture } from '../shared/model';

/** Catalog models for the selected piece's kind, as thumbnails rendered by the
 * asset pipeline. "Built-in" is the procedural piece. Stretchable models keep the
 * piece's saved size; others adopt their native size ("Use model size" restores it). */
export function ModelPicker({
  item,
  disabled,
  onChange,
}: {
  item: Furniture;
  disabled: boolean;
  onChange: (patch: Partial<Furniture>) => void;
}) {
  const models = modelsForKind(item.kind);
  if (!models.length) return null;
  const current = pieceModel(item);
  const currentId = current?.id ?? BUILTIN_MODEL;
  const native = current && [current.size[0], current.size[2], current.size[1]].map(
    (value) => Math.round(value * 100) / 100,
  );
  const matches =
    !native ||
    (Math.abs(native[0] - item.width) < 0.005 &&
      Math.abs(native[1] - item.depth) < 0.005 &&
      Math.abs(native[2] - item.height) < 0.005);
  return (
    <fieldset className="model-picker" aria-label="Piece model">
      <legend>Model</legend>
      <div className="model-grid" role="radiogroup" aria-label="Catalog model">
        <button
          type="button"
          role="radio"
          aria-checked={currentId === BUILTIN_MODEL}
          className={currentId === BUILTIN_MODEL ? 'selected' : ''}
          disabled={disabled}
          title="Built-in parametric piece"
          onClick={() => onChange({ model: BUILTIN_MODEL })}
        >
          <span className="model-builtin">Built-in</span>
          <span className="model-name">Parametric</span>
        </button>
        {models.map((model) => (
          <button
            key={model.id}
            type="button"
            role="radio"
            aria-checked={currentId === model.id}
            className={currentId === model.id ? 'selected' : ''}
            disabled={disabled}
            title={`${model.name ?? model.id}${model.style ? ` · ${model.style}` : ''}\n${model.attribution}`}
            onClick={() => onChange(chooseModelPatch(item, model.id))}
          >
            {model.thumbnail && <img src={model.thumbnail} alt="" loading="lazy" />}
            <span className="model-name">{model.name ?? model.id}</span>
          </button>
        ))}
      </div>
      {current && (
        <p className="panel-note model-credit">
          {current.attribution}
          {!matches && native && (
            <>
              {' '}
              <button
                type="button"
                className="text-button"
                disabled={disabled}
                onClick={() => onChange({ width: native[0], depth: native[1], height: native[2] })}
              >
                Use model size ({native.join(' × ')} m)
              </button>
            </>
          )}
        </p>
      )}
    </fieldset>
  );
}
