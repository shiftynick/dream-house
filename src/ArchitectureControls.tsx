import { useEffect, useRef, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { effectiveRoof } from '../shared/architecture';
import { roomOpenings, type DesignCommand } from '../shared/design';
import type { Room, Scene, Side, WallOpening } from '../shared/model';

type Apply = (commands: DesignCommand[]) => boolean;
const sides: Side[] = ['north', 'south', 'east', 'west'];
const roofNames = { flat: 'Flat', pitched: 'Gable', 'single-pitch': 'Single pitch' } as const;

export function roofControlState(scene: Scene, room?: Room) {
  if (room) {
    const roof = effectiveRoof(scene, room);
    return {
      ...roof,
      legacy: false,
      mixed: false,
      pitch: roof.pitch as number | null,
    };
  }
  const legacy =
    scene.roof === 'pitched' && scene.roofPitch === undefined && scene.roofDirection === undefined;
  const pitches = legacy
    ? scene.rooms
        .filter(
          (candidate) => !candidate.roof && !['courtyard', 'terrace'].includes(candidate.kind),
        )
        .map((candidate) => effectiveRoof(scene, candidate).pitch)
    : [];
  const mixed = pitches.some((pitch) => Math.abs(pitch - pitches[0]) > 0.000001);
  return {
    style: scene.roof,
    pitch: legacy ? (pitches.length && !mixed ? pitches[0] : null) : (scene.roofPitch ?? 20),
    direction: legacy ? ('east' as const) : (scene.roofDirection ?? 'north'),
    legacy,
    mixed,
  };
}

export function RoofControls({
  scene,
  room,
  disabled,
  onApply,
}: {
  scene: Scene;
  room?: Room;
  disabled: boolean;
  onApply: Apply;
}) {
  const current = roofControlState(scene, room);
  const [style, setStyle] = useState(current.style);
  const [pitch, setPitch] = useState(current.pitch);
  const [direction, setDirection] = useState<Side>(current.direction);
  useEffect(() => {
    setStyle(current.style);
    setPitch(current.pitch);
    setDirection(current.direction);
  }, [current.style, current.pitch, current.direction, room?.id]);
  const changed =
    style !== current.style || pitch !== current.pitch || direction !== current.direction;
  return (
    <form
      className="architecture-controls"
      onSubmit={(event) => {
        event.preventDefault();
        if (disabled || !changed || (style !== 'flat' && pitch === null)) return;
        onApply([
          {
            type: 'set_roof',
            ...(room ? { roomIds: [room.id] } : {}),
            style,
            ...(style === 'flat' ? {} : { pitch: pitch! }),
            direction,
          },
        ]);
      }}
    >
      <div className="section-title">
        <span>{room ? 'ROOM ROOF' : 'HOUSE ROOF DEFAULT'}</span>
      </div>
      <label className="field-label">
        Roof shape
        <select
          aria-label={room ? 'Room roof shape' : 'House roof shape'}
          disabled={disabled}
          value={style}
          onChange={(e) => setStyle(e.target.value as typeof style)}
        >
          {Object.entries(roofNames).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      {style !== 'flat' && (
        <div className="dimensions">
          <label className="field-label">
            Pitch
            <div className="unit-input">
              <input
                aria-label={room ? 'Room roof pitch' : 'House roof pitch'}
                disabled={disabled}
                type="number"
                min="1"
                max="60"
                step="any"
                required
                placeholder={current.mixed ? 'Varies by room' : 'Choose pitch'}
                value={pitch === null ? '' : Math.round(pitch * 100) / 100}
                onChange={(e) => setPitch(e.target.value === '' ? null : Number(e.target.value))}
              />
              <span>°</span>
            </div>
          </label>
          <label className="field-label">
            {style === 'single-pitch' ? 'High edge' : 'Slope axis'}
            <select
              aria-label={room ? 'Room roof direction' : 'House roof direction'}
              disabled={disabled}
              value={direction}
              onChange={(e) => setDirection(e.target.value as Side)}
            >
              {sides.map((side) => (
                <option key={side} value={side}>
                  {side}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
      <p className="panel-note">
        {room
          ? 'Room height sets the lowest eave. Roof pitch adds height above it.'
          : current.legacy
            ? current.mixed || current.pitch === null
              ? 'Existing gable pitches follow each room’s width. Enter a pitch to set one house default; room overrides stay unchanged.'
              : 'Existing gables use the pitch shown and an east–west slope. Applying a change sets a shared house default; room overrides stay unchanged.'
            : 'Rooms with their own roof settings keep those overrides.'}
      </p>
      <div className="control-actions">
        <button
          className="text-button"
          disabled={disabled || !changed || (style !== 'flat' && pitch === null)}
          type="submit"
        >
          Apply roof
        </button>
        {room?.roof && (
          <button
            className="text-button"
            disabled={disabled}
            type="button"
            onClick={() => onApply([{ type: 'reset_roof', roomIds: [room.id] }])}
          >
            Use house default
          </button>
        )}
      </div>
    </form>
  );
}

type Entry = Omit<WallOpening, 'side'>;
export function openingControlEntries(
  scene: Scene,
  room: Room,
  side: Side,
  legacyId: string,
): Entry[] {
  const resolved = roomOpenings(scene, room.id, side);
  if (resolved.length)
    return resolved
      .filter((o) => o.source === 'explicit')
      .map(({ source: _source, sourceRoomId: _owner, ...entry }) => entry);
  if (room[side] === 'solid') return [];
  const span = side === 'north' || side === 'south' ? room.width : room.depth;
  return [
    {
      id: legacyId,
      kind: room[side] === 'glass' ? 'window' : room[side],
      offset: 0,
      width: room[side] === 'door' ? Math.min(1.3, span) : span,
      height: room[side] === 'door' ? Math.min(2.4, room.height) : room.height,
      sill: 0,
    },
  ];
}

export function availableOpeningSpace(span: number, openings: Pick<Entry, 'offset' | 'width'>[]) {
  const occupied = openings
    .map((o) => [o.offset - o.width / 2 - 0.15, o.offset + o.width / 2 + 0.15])
    .sort((a, b) => a[0] - b[0]);
  let cursor = -span / 2 + 0.15;
  let best = [cursor, cursor];
  for (const [start, end] of [...occupied, [span / 2 - 0.15, span / 2]]) {
    if (start - cursor > best[1] - best[0]) best = [cursor, start];
    cursor = Math.max(cursor, end);
  }
  if (best[1] - best[0] < 0.3) return null;
  return {
    width: Math.floor(Math.min(1.8, best[1] - best[0]) * 100) / 100,
    offset: Math.round((best[0] + best[1]) * 50) / 100,
  };
}

export function OpeningControls({
  scene,
  room,
  selectedSide,
  disabled,
  onApply,
}: {
  scene: Scene;
  room: Room;
  selectedSide?: Side;
  disabled: boolean;
  onApply: Apply;
}) {
  const [side, setSide] = useState<Side>(selectedSide ?? 'south');
  const legacyIds = useRef<Partial<Record<Side, string>>>({});
  legacyIds.current[side] ??= crypto.randomUUID();
  const source = JSON.stringify(openingControlEntries(scene, room, side, legacyIds.current[side]));
  const [draft, setDraft] = useState<Entry[]>(() => JSON.parse(source));
  useEffect(() => {
    if (selectedSide) setSide(selectedSide);
  }, [selectedSide, room.id]);
  useEffect(() => {
    setDraft(JSON.parse(source));
  }, [source, room.id, side]);
  const passages = roomOpenings(scene, room.id, side).filter((o) => o.source === 'connection');
  const span = side === 'north' || side === 'south' ? room.width : room.depth;
  const changed = JSON.stringify(draft) !== source;
  const available = availableOpeningSpace(span, [...draft, ...passages]);
  const patch = (id: string, values: Partial<Entry>) =>
    setDraft((items) => items.map((item) => (item.id === id ? { ...item, ...values } : item)));
  const add = () => {
    if (!available || disabled) return;
    setDraft([
      ...draft,
      {
        id: crypto.randomUUID(),
        kind: 'window',
        ...available,
        height: 1.5,
        sill: 0.7,
      },
    ]);
  };
  return (
    <form
      className="architecture-controls"
      onSubmit={(event) => {
        event.preventDefault();
        if (disabled || !changed) return;
        onApply([{ type: 'set_wall_openings', roomId: room.id, side, openings: draft }]);
      }}
    >
      <div className="section-title">
        <span>WINDOWS & DOORS</span>
      </div>
      <label className="field-label">
        Wall
        <select
          aria-label="Openings wall"
          disabled={disabled}
          value={side}
          onChange={(e) => setSide(e.target.value as Side)}
        >
          {sides.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
      </label>
      <p className="panel-note">
        Offsets are measured from the wall center toward{' '}
        {side === 'north' || side === 'south' ? 'east' : 'south'}. Dimensions are in meters.
      </p>
      {passages.map((o) => (
        <p className="opening-passage" key={o.id}>
          Connected passage · {o.width} × {o.height} m at {o.offset} m
        </p>
      ))}
      {draft.map((opening, index) => (
        <div className="opening-editor" key={opening.id}>
          <div className="opening-heading">
            <label className="field-label">
              Opening {index + 1}
              <select
                aria-label={`Opening ${index + 1} type`}
                disabled={disabled}
                value={opening.kind}
                onChange={(e) =>
                  patch(opening.id, {
                    kind: e.target.value as Entry['kind'],
                    ...(e.target.value === 'window'
                      ? {}
                      : {
                          sill: opening.kind === 'window' ? 0 : opening.sill,
                          width: Math.max(0.75, opening.width),
                          height: Math.max(2.1, opening.height),
                        }),
                  })
                }
              >
                <option value="window">Window</option>
                <option value="door">Door</option>
                <option value="open">Open passage</option>
              </select>
            </label>
            <button
              type="button"
              className="tiny-button"
              aria-label={`Remove opening ${index + 1}`}
              disabled={disabled}
              onClick={() => setDraft(draft.filter((o) => o.id !== opening.id))}
            >
              <Trash2 size={14} />
            </button>
          </div>
          <div className="dimensions">
            {(['offset', 'width', 'height', 'sill'] as const).map((field) => (
              <label key={field} className="field-label">
                {field === 'sill' ? 'Sill height' : field}
                <input
                  aria-label={`Opening ${index + 1} ${field}`}
                  type="number"
                  disabled={disabled || (field === 'sill' && opening.kind !== 'window')}
                  min={
                    field === 'offset'
                      ? -span / 2
                      : field === 'sill'
                        ? 0
                        : opening.kind === 'window'
                          ? 0.2
                          : field === 'width'
                            ? 0.75
                            : 2
                  }
                  max={field === 'offset' ? span / 2 : field === 'width' ? span : 10}
                  step="any"
                  value={opening[field]}
                  onChange={(e) => patch(opening.id, { [field]: Number(e.target.value) })}
                />
              </label>
            ))}
          </div>
        </div>
      ))}
      <div className="control-actions">
        <button
          type="button"
          className="text-button"
          disabled={disabled || draft.length >= 32 || !available}
          onClick={add}
        >
          <Plus size={13} /> Add opening
        </button>
        <button type="submit" className="text-button" disabled={disabled || !changed}>
          Apply openings
        </button>
      </div>
      {!available && (
        <p className="panel-note">
          No free wall space for another opening. Resize or remove an existing opening first.
        </p>
      )}
    </form>
  );
}
