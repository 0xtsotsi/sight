import React, { useEffect, useRef, useState } from 'react';

// Rich inline-content editor for the props panel: a contentEditable field
// showing a node's inline children (text + <strong>/<em>/<sup>/… tags) with a
// floating bubble toolbar on text selection, Webflow-style. Emits plain node
// lists ({kind:'text'|'element'} without ids — the app assigns ids on write).

export const INLINE_TAGS = new Set([
  'strong', 'em', 'b', 'i', 'sup', 'sub', 'code', 'a', 'span', 'br',
  'small', 'mark', 'u', 's',
]);

// A simple interpolation like {index + 1}: single braces, no JSX inside —
// editable as literal text (Astro re-parses braces as an expression anyway).
export const isSimpleExpr = (n) =>
  n.kind === 'expr' && /^\{[^{}]*\}$/.test(n.value) && !n.value.includes('<');

// A node list is "inline only" when every node is text, a simple expression,
// or a known inline element (with string-only props) — the shapes this
// editor can round-trip.
export function isInlineOnly(children) {
  if (!Array.isArray(children) || children.length === 0) return false;
  return children.every((c) => {
    if (c.kind === 'text' || isSimpleExpr(c)) return true;
    if (c.kind !== 'element' || !INLINE_TAGS.has(String(c.name).toLowerCase())) return false;
    const propsOk = Object.values(c.props || {}).every(
      (v) => v == null || v.type === 'string' || v.type === 'bare'
    );
    if (!propsOk) return false;
    return c.children === null || c.children.length === 0 || isInlineOnly(c.children);
  });
}

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const clamp = (v, min, max) => Math.min(Math.max(v, min), max);

export function nodesToHtml(nodes) {
  let out = '';
  for (const n of nodes || []) {
    if (n.kind === 'text') {
      out += esc(n.value);
    } else if (n.kind === 'expr') {
      out += esc(n.value); // shown as literal {expr} text
    } else {
      const attrs = Object.entries(n.props || {})
        .map(([k, v]) =>
          v == null || v.type === 'bare' ? ` ${k}` : ` ${k}="${esc(v.value).replace(/"/g, '&quot;')}"`
        )
        .join('');
      out +=
        n.children === null || n.children.length === 0
          ? n.name === 'br'
            ? '<br>'
            : `<${n.name}${attrs}></${n.name}>`
          : `<${n.name}${attrs}>${nodesToHtml(n.children)}</${n.name}>`;
    }
  }
  return out;
}

function domToNodes(el) {
  const out = [];
  // Brace runs in typed text become expression nodes again — in an Astro
  // template braces are expressions either way, so this matches semantics.
  const pushText = (raw) => {
    const re = /\{[^{}]*\}/g;
    let last = 0;
    let m;
    while ((m = re.exec(raw)) !== null) {
      if (m.index > last) out.push({ kind: 'text', value: raw.slice(last, m.index) });
      out.push({ kind: 'expr', value: m[0] });
      last = m.index + m[0].length;
    }
    if (last < raw.length) out.push({ kind: 'text', value: raw.slice(last) });
  };
  el.childNodes.forEach((n) => {
    if (n.nodeType === 3) {
      if (n.textContent) pushText(n.textContent);
      return;
    }
    if (n.nodeType !== 1) return;
    let name = n.tagName.toLowerCase();
    if (name === 'b') name = 'strong';
    if (name === 'i') name = 'em';
    if (name === 'br') {
      out.push({ kind: 'element', name: 'br', props: {}, children: null });
      return;
    }
    if (!INLINE_TAGS.has(name)) {
      // Unknown wrapper (e.g. a pasted <div>) — keep its content, drop the tag.
      out.push(...domToNodes(n));
      return;
    }
    const props = {};
    for (const attr of ['href', 'class', 'target', 'rel']) {
      const v = n.getAttribute(attr);
      if (v != null && v !== '') props[attr] = { type: 'string', value: v };
    }
    out.push({ kind: 'element', name, props, children: domToNodes(n) });
  });
  return out;
}

export default function RichContent({ nodes, onChange }) {
  const hostRef = useRef(null);
  const bubbleRef = useRef(null);
  const focusedRef = useRef(false);
  const lastEmittedRef = useRef(null);
  const savedRangeRef = useRef(null);
  const [bubble, setBubble] = useState(null); // raw selection anchor {x, top, bottom}
  const [pos, setPos] = useState(null); // measured/clamped {left, top, below, arrowX}
  const [states, setStates] = useState({}); // {bold, italic, …} at the selection
  const [linkMode, setLinkMode] = useState(false);
  const [linkUrl, setLinkUrl] = useState('');

  const html = nodesToHtml(nodes);

  // Load / external updates — but never clobber the DOM mid-edit.
  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    if (!focusedRef.current && html !== lastEmittedRef.current) {
      el.innerHTML = html;
      lastEmittedRef.current = html;
    }
  }, [html]);

  const emit = () => {
    const el = hostRef.current;
    if (!el) return;
    lastEmittedRef.current = el.innerHTML;
    onChange(domToNodes(el));
  };

  // Formatting state at the current selection, for highlighting buttons.
  const readStates = () => {
    const el = hostRef.current;
    const sel = window.getSelection();
    const anchorEl =
      sel && sel.anchorNode
        ? sel.anchorNode.nodeType === 1
          ? sel.anchorNode
          : sel.anchorNode.parentElement
        : null;
    const inTag = (tag) => !!(anchorEl && el && el.contains(anchorEl) && anchorEl.closest(tag));
    let s = {};
    try {
      s = {
        bold: document.queryCommandState('bold'),
        italic: document.queryCommandState('italic'),
        superscript: document.queryCommandState('superscript'),
        subscript: document.queryCommandState('subscript'),
      };
    } catch {
      s = {};
    }
    s.code = inTag('code');
    s.link = inTag('a');
    return s;
  };

  // Selection bubble: track selections anchored inside the editor.
  useEffect(() => {
    const onSelChange = () => {
      if (linkMode) return; // keep the bubble while typing a URL
      const el = hostRef.current;
      const sel = window.getSelection();
      if (
        !el ||
        !sel ||
        sel.rangeCount === 0 ||
        sel.isCollapsed ||
        !el.contains(sel.anchorNode) ||
        !el.contains(sel.focusNode)
      ) {
        setBubble(null);
        return;
      }
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      if (!rect.width && !rect.height) {
        setBubble(null);
        return;
      }
      savedRangeRef.current = sel.getRangeAt(0).cloneRange();
      setBubble({ x: rect.left + rect.width / 2, top: rect.top, bottom: rect.bottom });
      setStates(readStates());
    };
    document.addEventListener('selectionchange', onSelChange);
    return () => document.removeEventListener('selectionchange', onSelChange);
  }, [linkMode]);

  // Measure the rendered bubble and keep it inside the window: clamp
  // horizontally, flip below the selection when it would hit the titlebar,
  // and keep the arrow pointing at the selection midpoint.
  React.useLayoutEffect(() => {
    const el = bubbleRef.current;
    if (!bubble || !el) {
      setPos(null);
      return;
    }
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const margin = 8;
    const left = clamp(bubble.x, margin + w / 2, window.innerWidth - margin - w / 2);
    const below = bubble.top - h - 10 < 48;
    const top = below ? bubble.bottom + 10 : bubble.top - 10;
    const arrowX = clamp(bubble.x - (left - w / 2), 12, w - 12);
    setPos({ left, top, below, arrowX });
  }, [bubble, linkMode]);

  const restoreSelection = () => {
    const r = savedRangeRef.current;
    if (!r) return;
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  };

  const exec = (command, value = null) => {
    hostRef.current?.focus();
    restoreSelection();
    document.execCommand(command, false, value);
    emit();
    setStates(readStates());
  };

  // No execCommand for <code> — wrap the selection manually.
  const wrapCode = () => {
    hostRef.current?.focus();
    restoreSelection();
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
    const range = sel.getRangeAt(0);
    const el = document.createElement('code');
    try {
      range.surroundContents(el);
    } catch {
      // Selection crosses element boundaries — extract and rewrap.
      el.appendChild(range.extractContents());
      range.insertNode(el);
    }
    sel.removeAllRanges();
    const r = document.createRange();
    r.selectNodeContents(el);
    sel.addRange(r);
    emit();
    setStates(readStates());
  };

  const applyLink = () => {
    const url = linkUrl.trim();
    setLinkMode(false);
    setLinkUrl('');
    if (!url) return;
    hostRef.current?.focus();
    restoreSelection();
    document.execCommand('createLink', false, url);
    emit();
    setStates(readStates());
  };

  // Buttons use onMouseDown+preventDefault so the text selection survives.
  const btn = (label, title, onAct, active) => (
    <button
      key={title}
      type="button"
      className={active ? 'on' : ''}
      title={title}
      onMouseDown={(e) => {
        e.preventDefault();
        onAct();
      }}
    >
      {label}
    </button>
  );

  return (
    <>
      <div
        ref={hostRef}
        className="rich-content"
        contentEditable
        suppressContentEditableWarning
        spellCheck={false}
        onFocus={() => (focusedRef.current = true)}
        onBlur={() => {
          focusedRef.current = false;
          setTimeout(() => setBubble((b) => (linkMode ? b : null)), 150);
        }}
        onInput={emit}
        onKeyDown={(e) => {
          // Keep formatting shortcuts local; Enter inserts <br> (inline field).
          if (e.key === 'Enter') {
            e.preventDefault();
            document.execCommand('insertHTML', false, '<br>');
            emit();
          }
        }}
      />
      {bubble && (
        <div
          ref={bubbleRef}
          className={`rich-bubble ${pos?.below ? 'below' : ''}`}
          style={{
            left: pos ? pos.left : bubble.x,
            top: pos ? pos.top : bubble.top - 10,
            visibility: pos ? 'visible' : 'hidden',
            '--arrow-x': pos ? `${pos.arrowX}px` : '50%',
          }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {linkMode ? (
            <input
              autoFocus
              className="rich-bubble-url"
              placeholder="https://…  (Enter to apply)"
              value={linkUrl}
              onChange={(e) => setLinkUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') applyLink();
                if (e.key === 'Escape') {
                  setLinkMode(false);
                  setLinkUrl('');
                }
              }}
            />
          ) : (
            <>
              {btn(<b>B</b>, 'Bold', () => exec('bold'), states.bold)}
              {btn(<i>I</i>, 'Italic', () => exec('italic'), states.italic)}
              {btn(
                <span>
                  X<sup>2</sup>
                </span>,
                'Superscript',
                () => exec('superscript'),
                states.superscript
              )}
              {btn(
                <span>
                  X<sub>2</sub>
                </span>,
                'Subscript',
                () => exec('subscript'),
                states.subscript
              )}
              {btn(<span className="mono">{'</>'}</span>, 'Code', wrapCode, states.code)}
              {btn('🔗', 'Link', () => setLinkMode(true), states.link)}
            </>
          )}
        </div>
      )}
    </>
  );
}
