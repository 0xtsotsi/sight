import React, { useLayoutEffect, useRef } from 'react';

// Textarea that grows and shrinks to fit its content. Height tracks the
// value on every change (and on width changes via ResizeObserver, since
// wrapping depends on width).
export default function AutoTextarea({ value, minRows = 2, style, ...props }) {
  const ref = useRef(null);

  const fit = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    // +2 accounts for the 1px top/bottom borders (border-box sizing).
    el.style.height = el.scrollHeight + 2 + 'px';
  };

  useLayoutEffect(fit, [value]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <textarea
      ref={ref}
      rows={minRows}
      value={value}
      style={{ overflow: 'hidden', resize: 'none', ...style }}
      {...props}
    />
  );
}
