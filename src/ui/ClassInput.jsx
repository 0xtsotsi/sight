import React, { useLayoutEffect, useRef, useState } from 'react';

// Token editor for class-list props: each class renders as a tag, a text
// caret can sit between any two tags (click a tag to place the caret after
// it, Backspace removes the tag before the caret), and typing filters a
// suggestion list of every class used across the project.
export default function ClassInput({ value, suggestions = [], onChange }) {
  const tokens = String(value || '').trim().split(/\s+/).filter(Boolean);
  const [caret, setCaret] = useState(tokens.length);
  const [draft, setDraft] = useState('');
  const [focused, setFocused] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [popupPos, setPopupPos] = useState(null);
  const wrapRef = useRef(null);
  const inputRef = useRef(null);

  const at = Math.min(caret, tokens.length);

  const commit = (next) => {
    const str = next.join(' ');
    onChange(str, true);
  };

  const addToken = (text) => {
    const t = text.trim();
    setDraft('');
    if (!t) return;
    if (tokens.includes(t)) {
      setCaret(tokens.indexOf(t) + 1);
      return;
    }
    const next = [...tokens];
    next.splice(at, 0, t); // insert at the caret
    setCaret(at + 1);
    commit(next);
  };

  const removeAt = (i) => {
    if (i < 0 || i >= tokens.length) return;
    const next = tokens.filter((_, j) => j !== i);
    setCaret(Math.max(0, i));
    commit(next);
  };

  const query = draft.trim().toLowerCase();
  const matches = query
    ? suggestions
        .filter((s) => s.toLowerCase().includes(query) && !tokens.includes(s))
        .sort((a, b) => {
          // Prefix matches first, then shortest.
          const ap = a.toLowerCase().startsWith(query) ? 0 : 1;
          const bp = b.toLowerCase().startsWith(query) ? 0 : 1;
          return ap - bp || a.length - b.length;
        })
        .slice(0, 12)
    : [];

  useLayoutEffect(() => {
    if (!focused || !matches.length || !wrapRef.current) {
      setPopupPos(null);
      return;
    }
    const r = wrapRef.current.getBoundingClientRect();
    setPopupPos({ left: r.left, top: r.bottom + 4, width: r.width });
  }, [focused, matches.length, draft]); // eslint-disable-line react-hooks/exhaustive-deps

  const onKeyDown = (e) => {
    if (e.key === 'Backspace' && !draft) {
      e.preventDefault();
      removeAt(at - 1);
    } else if (e.key === 'Delete' && !draft) {
      e.preventDefault();
      removeAt(at);
    } else if (e.key === 'ArrowLeft' && !draft) {
      e.preventDefault();
      setCaret(Math.max(0, at - 1));
    } else if (e.key === 'ArrowRight' && !draft) {
      e.preventDefault();
      setCaret(Math.min(tokens.length, at + 1));
    } else if (e.key === 'ArrowDown' && matches.length) {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, matches.length - 1));
    } else if (e.key === 'ArrowUp' && matches.length) {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (matches.length) addToken(matches[Math.min(highlight, matches.length - 1)]);
      else addToken(draft);
    } else if (e.key === ' ') {
      e.preventDefault();
      addToken(draft);
    } else if (e.key === 'Tab' && draft) {
      e.preventDefault();
      addToken(matches.length ? matches[Math.min(highlight, matches.length - 1)] : draft);
    } else if (e.key === 'Escape') {
      setDraft('');
      inputRef.current?.blur();
    }
  };

  // While empty the input is just a caret-width sliver, with negative
  // margins swallowing the flex gap on either side so tags don't spread
  // apart around the cursor.
  const emptyAmongTags = !draft && tokens.length > 0;
  const inputEl = (
    <input
      key="caret"
      ref={inputRef}
      className={`class-input-field ${emptyAmongTags ? 'empty' : ''}`}
      value={draft}
      style={draft ? { width: `${draft.length + 1}ch` } : undefined}
      spellCheck={false}
      onChange={(e) => {
        setDraft(e.target.value);
        setHighlight(0);
      }}
      onKeyDown={onKeyDown}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false);
        if (draft.trim()) addToken(draft);
      }}
    />
  );

  const items = [];
  tokens.forEach((t, i) => {
    if (i === at) items.push(inputEl);
    items.push(
      <span
        key={`${t}-${i}`}
        className="class-tag"
        title="Click to place the caret after this class"
        onMouseDown={(e) => {
          // preventDefault keeps the inline input from blurring.
          e.preventDefault();
          e.stopPropagation();
          setCaret(i + 1);
          inputRef.current?.focus();
        }}
      >
        {t}
      </span>
    );
  });
  if (at >= tokens.length) items.push(inputEl);

  return (
    <>
      <div
        ref={wrapRef}
        className={`class-input ${focused ? 'focused' : ''}`}
        onMouseDown={(e) => {
          if (e.target === wrapRef.current) {
            e.preventDefault();
            setCaret(tokens.length);
            inputRef.current?.focus();
          }
        }}
      >
        {items}
      </div>
      {popupPos && (
        <div
          className="dd-popup class-suggest"
          style={{ left: popupPos.left, top: popupPos.top, width: popupPos.width }}
        >
          {matches.map((s, i) => (
            <div
              key={s}
              className={`dd-option ${i === highlight ? 'highlight' : ''}`}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setHighlight(i)}
              onClick={() => addToken(s)}
            >
              <span className="dd-option-label">{s}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
