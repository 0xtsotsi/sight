import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChevronDownIcon, CheckIcon } from './Icons.jsx';

// Custom dropdown that replaces native <select>. Options: [{value, label}].
//
// Live preview: hovering (or arrow-keying) an option applies it immediately
// via onChange so the page preview updates in real time. Closing the menu
// without picking reverts to the value that was committed when it opened.
//
// The popup renders position:fixed so it can escape scrolling panels, flips
// upward when there's no room below, and closes on outside click, Escape,
// or any scroll outside the popup.
export default function Dropdown({ value, options, onChange, className, placeholder }) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const [pos, setPos] = useState(null); // {left, top, bottom, width}
  const triggerRef = useRef(null);
  const popupRef = useRef(null);
  const committedRef = useRef(value); // value when the popup opened
  const previewedRef = useRef(null); // last live-previewed value, or null

  const selected = options.find((o) => o.value === value);
  const selectedIndex = options.findIndex((o) => o.value === value);

  const openPopup = () => {
    committedRef.current = value;
    previewedRef.current = null;
    setHighlight(selectedIndex);
    setOpen(true);
  };

  // Close, reverting any live preview back to the committed value.
  const closeAndRevert = () => {
    setOpen(false);
    if (previewedRef.current !== null && previewedRef.current !== committedRef.current) {
      onChange(committedRef.current);
    }
    previewedRef.current = null;
  };

  const previewOption = (i) => {
    setHighlight(i);
    const o = options[i];
    if (!o) return;
    const applied = previewedRef.current ?? committedRef.current;
    if (o.value !== applied) {
      previewedRef.current = o.value;
      onChange(o.value);
    }
  };

  const pick = (option) => {
    committedRef.current = option.value;
    previewedRef.current = null;
    setOpen(false);
    onChange(option.value);
    triggerRef.current?.focus();
  };

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const maxHeight = 260;
    const spaceBelow = window.innerHeight - rect.bottom;
    const up = spaceBelow < Math.min(maxHeight, options.length * 30 + 12) && rect.top > spaceBelow;
    setPos({
      left: rect.left,
      width: rect.width,
      top: up ? undefined : rect.bottom + 4,
      bottom: up ? window.innerHeight - rect.top + 4 : undefined,
    });
  }, [open, options.length]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (
        popupRef.current && !popupRef.current.contains(e.target) &&
        triggerRef.current && !triggerRef.current.contains(e.target)
      ) {
        closeAndRevert();
      }
    };
    const onScroll = (e) => {
      if (popupRef.current && popupRef.current.contains(e.target)) return;
      closeAndRevert();
    };
    const onResize = () => closeAndRevert();
    document.addEventListener('mousedown', onDown);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the highlighted option in view while navigating with arrows.
  useEffect(() => {
    if (!open || highlight < 0 || !popupRef.current) return;
    const el = popupRef.current.children[highlight];
    if (el) el.scrollIntoView({ block: 'nearest' });
  }, [open, highlight]);

  const onKeyDown = (e) => {
    if (!open) {
      if (['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(e.key)) {
        e.preventDefault();
        openPopup();
      }
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      closeAndRevert();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      previewOption(Math.min(highlight + 1, options.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      previewOption(Math.max(highlight - 1, 0));
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (highlight >= 0 && options[highlight]) pick(options[highlight]);
    } else if (e.key === 'Tab') {
      closeAndRevert();
    }
  };

  return (
    <>
      <button
        type="button"
        ref={triggerRef}
        className={`dd-trigger ${className || ''}`}
        onClick={() => (open ? closeAndRevert() : openPopup())}
        onKeyDown={onKeyDown}
      >
        <span className={`dd-label ${selected && !selected.dim ? '' : 'dim'}`}>
          {selected ? selected.label : placeholder || ''}
        </span>
        <span className="dd-chevron">
          <ChevronDownIcon size={11} />
        </span>
      </button>

      {open && pos && (
        <div
          ref={popupRef}
          className="dd-popup"
          style={{
            left: pos.left,
            top: pos.top,
            bottom: pos.bottom,
            width: pos.width,
          }}
        >
          {options.map((o, i) => (
            <div
              key={`${o.value}-${i}`}
              className={`dd-option ${i === highlight ? 'highlight' : ''} ${o.value === committedRef.current && open ? 'selected' : ''} ${o.dim ? 'dim' : ''}`}
              onMouseEnter={() => previewOption(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(o)}
            >
              <span className="dd-check">
                {o.value === committedRef.current ? <CheckIcon size={11} /> : null}
              </span>
              <span className="dd-option-label">{o.label}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
