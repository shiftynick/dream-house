import { useEffect, useRef, useState, type PointerEvent } from 'react';
import type { Furniture, Room, Scene } from '../shared/model';
import type { DesignCommand } from '../shared/design';
import { FurniturePlanGesture, furniturePlanError, planPoint } from './planFurnitureGesture';

export function PlanFurniture({
  scene,
  room,
  item,
  selected,
  disabled,
  onSelect,
  onApply,
  onError,
}: {
  scene: Scene;
  room: Room;
  item: Furniture;
  selected: boolean;
  disabled?: boolean;
  onSelect?: () => void;
  onApply?: (commands: DesignCommand[]) => boolean;
  onError?: (message: string) => void;
}) {
  const gesture = useRef(new FurniturePlanGesture());
  const pointer = useRef<number | null>(null);
  const [preview, setPreview] = useState<Furniture | null>(null);
  const shown = preview ?? item;
  const editable = !!onApply && !disabled;
  const cancel = () => {
    gesture.current.cancel();
    pointer.current = null;
    setPreview(null);
  };
  useEffect(() => {
    cancel();
  }, [scene, disabled]);
  useEffect(() => {
    if (!selected) cancel();
  }, [selected]);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && gesture.current.running) {
        event.preventDefault();
        cancel();
      }
    };
    window.addEventListener('keydown', escape);
    window.addEventListener('blur', cancel);
    return () => {
      window.removeEventListener('keydown', escape);
      window.removeEventListener('blur', cancel);
      gesture.current.cancel();
    };
  }, []);
  const coordinate = (event: PointerEvent<SVGElement>) => {
    const matrix = event.currentTarget.ownerSVGElement?.getScreenCTM();
    return matrix ? planPoint(event.clientX, event.clientY, matrix) : null;
  };
  const start = (event: PointerEvent<SVGElement>, mode: 'move' | 'rotate') => {
    event.stopPropagation();
    onSelect?.();
    if (!editable || event.button !== 0 || pointer.current !== null) return;
    const point = coordinate(event);
    if (!point) return;
    event.preventDefault();
    gesture.current.begin(room, item, point, mode);
    pointer.current = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const move = (event: PointerEvent<SVGElement>) => {
    if (pointer.current !== event.pointerId) return;
    event.stopPropagation();
    const point = coordinate(event);
    if (point) setPreview(gesture.current.update(point, event.shiftKey));
  };
  const finish = (event: PointerEvent<SVGElement>) => {
    if (pointer.current !== event.pointerId) return;
    event.stopPropagation();
    if (!selected || !editable) {
      cancel();
      return;
    }
    const point = coordinate(event);
    if (point) gesture.current.update(point, event.shiftKey);
    const result = gesture.current.finish();
    pointer.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    setPreview(null);
    if (result.error) onError?.(result.error);
    else if (result.command && editable) onApply?.([result.command]);
  };
  const keyboardEdit = (patch: Partial<Furniture>) => {
    const next = { ...item, ...patch },
      error = furniturePlanError(room, next);
    if (error) onError?.(error);
    else onApply?.([{ type: 'update_furniture', roomId: room.id, furnitureId: item.id, patch }]);
  };
  return (
    <g
      data-furniture-id={item.id}
      data-furniture-kind={item.kind}
      data-furniture-preview={preview ? 'true' : undefined}
      transform={`translate(${room.x + shown.x} ${room.z + shown.z}) rotate(${-shown.rotation})`}
      role={onSelect ? 'button' : undefined}
      tabIndex={onSelect ? 0 : undefined}
      aria-label={`${item.name} in ${room.name}`}
      style={{ cursor: editable ? 'grab' : 'pointer', touchAction: editable ? 'none' : undefined }}
      onClick={(event) => {
        event.stopPropagation();
        onSelect?.();
      }}
      onPointerDown={(event) => start(event, 'move')}
      onPointerMove={move}
      onPointerUp={finish}
      onPointerCancel={(event) => {
        if (pointer.current === event.pointerId) cancel();
      }}
      onLostPointerCapture={(event) => {
        if (pointer.current === event.pointerId) cancel();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          event.stopPropagation();
          onSelect?.();
        }
        if (
          !editable ||
          !selected ||
          !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)
        )
          return;
        event.preventDefault();
        event.stopPropagation();
        const step = event.shiftKey ? 0.01 : 0.1;
        keyboardEdit(
          event.key === 'ArrowLeft'
            ? { x: item.x - step }
            : event.key === 'ArrowRight'
              ? { x: item.x + step }
              : event.key === 'ArrowUp'
                ? { z: item.z - step }
                : { z: item.z + step },
        );
      }}
    >
      <title>{`${item.name} · ${item.width} × ${item.depth} m${editable ? ' · drag to move' : ''}`}</title>
      <rect
        x={-shown.width / 2}
        y={-shown.depth / 2}
        width={shown.width}
        height={shown.depth}
        rx={Math.min(0.08, shown.width * 0.1)}
        fill={shown.kind === 'rug' ? '#ded2b9' : '#f3eee4'}
        fillOpacity={shown.kind === 'rug' ? 0.28 : 0.92}
        stroke={
          preview && furniturePlanError(room, preview)
            ? '#b33b36'
            : selected
              ? '#b87f45'
              : '#7e897f'
        }
        strokeWidth={selected ? 0.08 : 0.035}
        strokeDasharray={shown.kind === 'rug' ? '.12 .08' : undefined}
      />
      {['sofa', 'armchair', 'chair', 'bed'].includes(shown.kind) && (
        <rect
          pointerEvents="none"
          x={-shown.width * 0.44}
          y={-shown.depth * 0.44}
          width={shown.width * 0.88}
          height={shown.depth * 0.2}
          fill="#c3c6ba"
        />
      )}
      {shown.kind !== 'rug' && (
        <path
          pointerEvents="none"
          d={`M 0 ${shown.depth * 0.2} l -.12 -.12 m .12 .12 l .12 -.12`}
          fill="none"
          stroke="#7e897f"
          strokeWidth=".035"
        />
      )}
      {selected && editable && (
        <g
          role="button"
          tabIndex={0}
          aria-label={`Rotate ${item.name}`}
          style={{ cursor: 'crosshair', touchAction: 'none' }}
          onClick={(event) => event.stopPropagation()}
          onPointerDown={(event) => start(event, 'rotate')}
          onPointerMove={move}
          onPointerUp={finish}
          onPointerCancel={cancel}
          onLostPointerCapture={(event) => {
            if (pointer.current === event.pointerId) cancel();
          }}
          onKeyDown={(event) => {
            if (['ArrowLeft', 'ArrowRight'].includes(event.key)) {
              event.preventDefault();
              event.stopPropagation();
              keyboardEdit({
                rotation:
                  ((((item.rotation + (event.key === 'ArrowRight' ? 5 : -5) + 180) % 360) + 360) %
                    360) -
                  180,
              });
            }
          }}
        >
          <title>Drag to rotate. Shift snaps to 15°. Left/right arrows rotate 5°.</title>
          <line
            x1={0}
            x2={0}
            y1={-shown.depth / 2}
            y2={-shown.depth / 2 - 0.45}
            stroke="#b87f45"
            strokeWidth={0.04}
            pointerEvents="none"
          />
          <circle cx={0} cy={-shown.depth / 2 - 0.45} r={0.28} fill="transparent" />
          <circle
            cx={0}
            cy={-shown.depth / 2 - 0.45}
            r={0.13}
            fill="#fff6e6"
            stroke="#b87f45"
            strokeWidth={0.04}
          />
        </g>
      )}
    </g>
  );
}
