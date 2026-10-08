import { useEffect, useState } from 'react';
import { roomOpenings } from '../shared/openings';
import type { DesignCommand } from '../shared/design';
import type { Room, Scene, Side, WallOpening } from '../shared/model';

type Fields = Pick<WallOpening, 'kind' | 'offset' | 'width' | 'height' | 'sill'>;
export function selectedOpeningPatch(
  original: Fields,
  draft: Fields,
  semantic: boolean,
): Partial<Fields> {
  const patch: Partial<Fields> = Object.fromEntries(
    Object.entries(draft).filter(([key, value]) => original[key as keyof Fields] !== value),
  );
  if (semantic && draft.kind === 'open') delete patch.height;
  return patch;
}
export function SelectedOpeningControls({
  scene,
  room,
  selectedId,
  selectedSide,
  disabled,
  onSelect,
  onApply,
}: {
  scene: Scene;
  room: Room;
  selectedId?: string;
  selectedSide?: Side;
  disabled: boolean;
  onSelect: (side: Side, openingId?: string) => void;
  onApply: (commands: DesignCommand[]) => boolean;
}) {
  const entries = (['north', 'south', 'east', 'west'] as const).flatMap((side) =>
    roomOpenings(scene, room.id, side).map((opening) => ({ ...opening, side })),
  );
  const selected = entries.find(
    (opening) => opening.id === selectedId && opening.side === selectedSide,
  );
  const fields = (opening: NonNullable<typeof selected>): Fields => ({
    kind: opening.kind,
    offset: opening.offset,
    width: opening.width,
    height: opening.height,
    sill: opening.sill,
  });
  const source = selected ? JSON.stringify(fields(selected)) : '';
  const [draft, setDraft] = useState<Fields | null>(selected ? fields(selected) : null);
  useEffect(() => {
    setDraft(source ? JSON.parse(source) : null);
  }, [source, room.id, selectedId, selectedSide]);
  if (!entries.length) return null;
  return (
    <section className="architecture-controls" aria-label="Individual opening controls">
      <div className="section-title">
        <span>SELECTED OPENING</span>
      </div>
      <label className="field-label">
        Window or door
        <select
          aria-label="Selected opening"
          disabled={disabled}
          value={selectedId ?? ''}
          onChange={(event) => {
            const next = entries.find((opening) => opening.id === event.target.value);
            if (next) onSelect(next.side, next.id);
            else onSelect(selectedSide ?? 'south');
          }}
        >
          <option value="">All openings on this wall</option>
          {entries.map((opening) => (
            <option key={`${opening.side}-${opening.id}`} value={opening.id}>
              {opening.side} {opening.kind === 'open' ? 'passage' : opening.kind} · {opening.offset}{' '}
              m · {opening.id}
            </option>
          ))}
        </select>
      </label>
      {selected && draft && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (disabled) return;
            const original = fields(selected);
            const patch = selectedOpeningPatch(original, draft, selected.source === 'connection');
            if (Object.keys(patch).length)
              onApply([
                {
                  type: 'update_opening',
                  roomId: room.id,
                  side: selected.side,
                  openingId: selected.id,
                  patch,
                },
              ]);
          }}
        >
          <label className="field-label">
            Type
            <select
              aria-label="Selected opening type"
              disabled={disabled}
              value={draft.kind}
              onChange={(event) => {
                const kind = event.target.value as Fields['kind'];
                setDraft({
                  ...draft,
                  kind,
                  ...(kind === 'window'
                    ? {}
                    : {
                        sill: 0,
                        width: Math.max(selected.source === 'connection' ? 0.8 : 0.75, draft.width),
                        height: Math.max(2, draft.height),
                      }),
                  ...(kind === 'open' && selected.source === 'connection'
                    ? { height: room.height }
                    : {}),
                });
              }}
            >
              {selected.source !== 'connection' && <option value="window">Window</option>}
              <option value="door">Door</option>
              <option value="open">Open passage</option>
            </select>
          </label>
          <div className="dimensions">
            {(['offset', 'width', 'height', 'sill'] as const).map((field) => (
              <label key={field} className="field-label">
                {field === 'sill' ? 'Sill height' : field}
                <input
                  aria-label={`Selected opening ${field}`}
                  type="number"
                  step="0.01"
                  required
                  value={Number.isNaN(draft[field]) ? '' : draft[field]}
                  disabled={
                    disabled ||
                    (field === 'sill' && draft.kind !== 'window') ||
                    (field === 'height' &&
                      draft.kind === 'open' &&
                      selected.source === 'connection')
                  }
                  min={
                    field === 'offset'
                      ? -30
                      : field === 'sill'
                        ? 0
                        : field === 'height' && draft.kind !== 'window'
                          ? 2
                          : 0.2
                  }
                  max={field === 'offset' || field === 'width' ? 30 : 10}
                  onChange={(event) => setDraft({ ...draft, [field]: event.target.valueAsNumber })}
                />
              </label>
            ))}
          </div>
          <p className="panel-note">
            Meters from this room’s wall center toward{' '}
            {['north', 'south'].includes(selected.side) ? 'east' : 'south'}.{' '}
            {selected.source === 'connection'
              ? 'This is a shared passage; both faces update together.'
              : selected.sourceRoomId !== room.id
                ? 'This opening is owned by the neighboring room; both faces update together.'
                : 'Only this opening changes.'}
          </p>
          <div className="control-actions">
            <button
              className="primary small"
              type="submit"
              disabled={disabled || JSON.stringify(draft) === source}
            >
              Apply selected opening
            </button>
            <button
              className="text-button danger"
              type="button"
              disabled={disabled}
              onClick={() => {
                if (
                  onApply([
                    {
                      type: 'remove_opening',
                      roomId: room.id,
                      side: selected.side,
                      openingId: selected.id,
                    },
                  ])
                )
                  onSelect(selected.side);
              }}
            >
              Remove selected opening
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
