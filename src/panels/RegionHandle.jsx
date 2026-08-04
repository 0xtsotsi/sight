// src/panels/RegionHandle.jsx
//
// 4px-wide drag handle for resizing the agent panel. Lives on the edge
// of the panel — left edge for right-docked panels, top edge for
// bottom-docked panels, etc.
//
// Resize is rAF-throttled so the parent re-renders at most once per
// frame. The handle optionally calls `onResize(delta)` while dragging
// and `onCommit(value)` on `mouseup` so the parent can persist a
// throttle-friendly width.

import React, { useCallback, useEffect, useRef, useState } from 'react';

export default function RegionHandle({
  edge,
  value,
  onResize,
  onCommit,
  min = 240,
  max = 1200,
}) {
  const [dragging, setDragging] = useState(false);
  const startPos = useRef(0);
  const startValue = useRef(0);
  const pending = useRef(null);
  const rafId = useRef(0);

  const flush = useCallback(() => {
    if (pending.current != null) {
      onResize?.(pending.current);
      pending.current = null;
    }
    rafId.current = 0;
  }, [onResize]);

  const onDown = useCallback((e) => {
    e.preventDefault();
    setDragging(true);
    startPos.current = edge === 'left' || edge === 'right' ? e.clientX : e.clientY;
    startValue.current = value;
  }, [edge, value]);

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e) => {
      const pos = edge === 'left' || edge === 'right' ? e.clientX : e.clientY;
      const delta = pos - startPos.current;
      // For left/right edges, dragging right expands the panel; for left,
      // dragging left expands. For top/bottom, drag direction depends.
      const sign = (edge === 'left' || edge === 'top') ? -1 : 1;
      const next = Math.max(min, Math.min(max, startValue.current + delta * sign));
      pending.current = next;
      if (!rafId.current) rafId.current = requestAnimationFrame(flush);
    };
    const onUp = () => {
      setDragging(false);
      flush();
      onCommit?.(pending.current != null ? pending.current : value);
      pending.current = null;
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [dragging, edge, flush, max, min, onCommit, value]);

  const style = {
    position: 'absolute',
    ...(edge === 'left' ? { left: 0, top: 0, bottom: 0, width: 4, cursor: 'ew-resize' } : {}),
    ...(edge === 'right' ? { right: 0, top: 0, bottom: 0, width: 4, cursor: 'ew-resize' } : {}),
    ...(edge === 'top' ? { top: 0, left: 0, right: 0, height: 4, cursor: 'ns-resize' } : {}),
    ...(edge === 'bottom' ? { bottom: 0, left: 0, right: 0, height: 4, cursor: 'ns-resize' } : {}),
    zIndex: 5,
  };

  return (
    <div
      role="separator"
      aria-orientation={edge === 'left' || edge === 'right' ? 'vertical' : 'horizontal'}
      aria-valuenow={value}
      style={style}
      onMouseDown={onDown}
      data-testid="region-handle"
    />
  );
}
