import { useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { furnitureCatalog, makeFurniture, roomFurniture } from '../shared/furniture';
import { inspectRoomFurniture } from '../shared/spatial';
import type { DesignCommand } from '../shared/design';
import type { Furniture, FurnitureKind, Room, Scene } from '../shared/model';

export function FurnitureControls({
  scene,
  room,
  selectedId,
  disabled,
  onSelect,
  onApply,
}: {
  scene: Scene;
  room: Room;
  selectedId?: string;
  disabled: boolean;
  onSelect: (id?: string) => void;
  onApply: (commands: DesignCommand[]) => boolean;
}) {
  const items = roomFurniture(room),
    selected = items.find((item) => item.id === selectedId);
  const [draft, setDraft] = useState<Furniture | undefined>(selected);
  const [kind, setKind] = useState<FurnitureKind>('armchair');
  const key = JSON.stringify(selected);
  useEffect(() => setDraft(selected ? { ...selected } : undefined), [key]);
  const issues = inspectRoomFurniture(scene, room);
  return (
    <section className="furniture-controls" aria-label="Furniture controls">
      <div className="section-title">
        <span>FURNITURE</span>
      </div>
      <label className="field-label">
        Piece
        <select
          aria-label="Selected furniture"
          disabled={disabled}
          value={selectedId || ''}
          onChange={(e) => onSelect(e.target.value || undefined)}
        >
          <option value="">Choose a piece</option>
          {items.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
      </label>
      <button
        className="primary small full"
        disabled={disabled || !items.length}
        onClick={() => onApply([{ type: 'arrange_furniture', roomIds: [room.id] }])}
      >
        Arrange existing furniture
      </button>
      {draft && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const { id, ...patch } = draft;
            onApply([{ type: 'update_furniture', roomId: room.id, furnitureId: id, patch }]);
          }}
        >
          <label className="field-label">
            Name
            <input
              aria-label="Furniture name"
              value={draft.name}
              maxLength={80}
              required
              disabled={disabled}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </label>
          <div className="field-grid">
            {(['x', 'z', 'rotation', 'width', 'depth', 'height'] as const).map((field) => (
              <label key={field} className="field-label">
                {field === 'x' ? 'East / west' : field === 'z' ? 'South / north' : field}
                <input
                  aria-label={`Furniture ${field}`}
                  type="number"
                  step="any"
                  required
                  disabled={disabled}
                  value={Number.isNaN(draft[field]) ? '' : draft[field]}
                  min={
                    field === 'rotation'
                      ? -360
                      : field === 'x' || field === 'z'
                        ? -40
                        : field === 'height'
                          ? 0.02
                          : 0.2
                  }
                  max={
                    field === 'rotation'
                      ? 360
                      : field === 'x' || field === 'z'
                        ? 40
                        : field === 'height'
                          ? 4
                          : 30
                  }
                  onChange={(e) => setDraft({ ...draft, [field]: e.target.valueAsNumber })}
                />
              </label>
            ))}
          </div>
          <p className="panel-note">
            Meters from room center. Rotation is in degrees; 0° faces south, 90° east.
          </p>
          <div className="furniture-actions">
            <button className="primary small" disabled={disabled}>
              Apply furniture
            </button>
            <button
              type="button"
              className="text-button danger"
              disabled={disabled}
              onClick={() => {
                if (
                  onApply([{ type: 'remove_furniture', roomId: room.id, furnitureIds: [draft.id] }])
                )
                  onSelect();
              }}
            >
              <Trash2 size={13} />
              Remove
            </button>
          </div>
        </form>
      )}
      <div className="furniture-add">
        <label className="field-label">
          Add piece
          <select
            aria-label="Furniture to add"
            disabled={disabled}
            value={kind}
            onChange={(e) => setKind(e.target.value as FurnitureKind)}
          >
            {Object.entries(furnitureCatalog).map(([id, item]) => (
              <option key={id} value={id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <button
          className="icon-button"
          aria-label="Add furniture"
          disabled={disabled || items.length >= 32}
          onClick={() => {
            const item = makeFurniture(kind, crypto.randomUUID());
            if (onApply([{ type: 'add_furniture', roomId: room.id, items: [item] }]))
              onSelect(item.id);
          }}
        >
          <Plus size={16} />
        </button>
      </div>
      {issues.length > 0 && (
        <details className="furniture-warnings">
          <summary>
            {issues.length} furniture clearance {issues.length === 1 ? 'note' : 'notes'}
          </summary>
          {issues.map((issue, index) => (
            <p key={index}>{issue.message}</p>
          ))}
        </details>
      )}
    </section>
  );
}
