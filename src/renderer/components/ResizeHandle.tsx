import { useRef, useState, type PointerEvent } from 'react';

interface Props {
  value: number;
  onChange: (next: number) => void;
  min: number;
  max: number;
  edge: 'left' | 'right';
}

export function ResizeHandle({ value, onChange, min, max, edge }: Props) {
  const [dragging, setDragging] = useState(false);
  const startRef = useRef({ x: 0, w: 0 });

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(true);
    document.body.classList.add('resizing');
    startRef.current = { x: e.clientX, w: value };

    const move = (ev: globalThis.PointerEvent) => {
      const dx = ev.clientX - startRef.current.x;
      const next =
        edge === 'left' ? startRef.current.w + dx : startRef.current.w - dx;
      onChange(Math.max(min, Math.min(max, next)));
    };
    const up = () => {
      setDragging(false);
      document.body.classList.remove('resizing');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <div
      className={'resize-handle' + (dragging ? ' dragging' : '')}
      onPointerDown={onPointerDown}
      role="separator"
      aria-orientation="vertical"
    />
  );
}
