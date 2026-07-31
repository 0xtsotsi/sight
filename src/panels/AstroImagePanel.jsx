import React, { useState } from 'react';
import { ASTRO_IMAGE_DEFAULTS } from '../elementSchemas/astro-image.js';

const FORMAT_OPTIONS = ['avif', 'webp', 'png', 'jpg', 'jpeg', 'gif', 'svg'];

// Decode a prop value back to a JS value. Numbers / arrays are stored as
// {type:'expr', value}; strings as {type:'string', value}. Missing → default.
function decode(value, fallback) {
  if (value == null) return fallback;
  if (value.type === 'string') return value.value;
  if (value.type === 'expr') return value.value;
  if (value.type === 'bare') return true;
  return fallback;
}

// Encode arbitrary JS values back into the prop shape the model expects.
// Arrays/object literals become expressions; everything else is a string.
function encode(v, kind) {
  if (kind === 'string') return { type: 'string', value: String(v) };
  if (kind === 'number') return { type: 'expr', value: String(v) };
  if (kind === 'array') return { type: 'expr', value: serializeArray(v) };
  if (kind === 'raw') return { type: 'expr', value: String(v) };
  return { type: 'string', value: String(v) };
}

// [400, 800, 1200] → '[400, 800, 1200]'
function serializeArray(arr) {
  return '[' + arr.join(', ') + ']';
}

// Editor for widths: a comma-separated list of numbers. Editing each as raw
// digits keeps the field flat, and the visible string matches what Astro
// wants in the source.
function WidthsField({ value, defaultValue, onChange }) {
  const raw = value ?? defaultValue;
  const text = Array.isArray(raw) ? raw.join(', ') : serializeArray(raw);
  const [draft, setDraft] = useState(text);
  const [bad, setBad] = useState(false);

  const commit = (next) => {
    const cleaned = next.split(',').map((s) => s.trim()).filter(Boolean);
    const nums = cleaned.map((s) => Number(s));
    if (nums.length === 0 || nums.some((n) => !Number.isFinite(n) || n <= 0)) {
      setBad(true);
      return;
    }
    setBad(false);
    onChange(encode(nums, 'array'));
  };

  return (
    <div className="props-field">
      <label>
        <span className="prop-label">Widths</span>
      </label>
      <input
        value={draft}
        spellCheck={false}
        placeholder="400, 800, 1200, 1600"
        style={bad ? { borderColor: 'var(--red)' } : undefined}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => commit(draft)}
        onKeyDown={(e) => e.key === 'Enter' && (commit(draft), e.currentTarget.blur())}
      />
      <div style={{ fontSize: 11, color: 'var(--text-faint)', marginTop: 4, lineHeight: 1.4 }}>
        Resolutions generated for the srcset. Browser picks the smallest one it
        can still use.
      </div>
    </div>
  );
}

// Multi-select rendered as a row of toggles. Click to toggle, no popup.
function FormatsField({ value, defaultValue, onChange }) {
  const raw = value ?? defaultValue;
  const list = Array.isArray(raw) ? raw : ['avif', 'webp'];
  const toggle = (fmt) => {
    const next = list.includes(fmt) ? list.filter((f) => f !== fmt) : [...list, fmt];
    if (next.length === 0) return; // Astro requires at least one
    onChange(encode(next, 'array'));
  };
  return (
    <div className="props-field">
      <label>
        <span className="prop-label">Formats</span>
      </label>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {FORMAT_OPTIONS.map((fmt) => {
          const on = list.includes(fmt);
          return (
            <button
              key={fmt}
              type="button"
              className={`pill ${on ? 'on' : ''}`}
              onClick={() => toggle(fmt)}
              style={{
                padding: '2px 8px',
                fontSize: 11,
                border: '1px solid var(--border)',
                borderRadius: 999,
                background: on ? 'var(--accent)' : 'transparent',
                color: on ? 'var(--accent-fg)' : 'inherit',
                cursor: 'pointer',
              }}
            >
              {fmt}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function QualityField({ value, defaultValue, onChange }) {
  const raw = value?.type === 'expr' ? value.value : value?.value;
  const n = raw != null ? Number(raw) : defaultValue;
  const [draft, setDraft] = useState(Number.isFinite(n) ? n : defaultValue);
  const commit = (next) => {
    if (!Number.isFinite(Number(next)) || Number(next) < 1 || Number(next) > 100) return;
    onChange(encode(Number(next), 'number'));
  };
  return (
    <div className="props-field">
      <label>
        <span className="prop-label">Quality</span>
      </label>
      <input
        type="number"
        min={1}
        max={100}
        step={1}
        value={draft}
        onChange={(e) => setDraft(Number(e.target.value))}
        onBlur={() => commit(draft)}
        onKeyDown={(e) => e.key === 'Enter' && (commit(draft), e.currentTarget.blur())}
      />
    </div>
  );
}

// Alt text is technically required for accessibility. The warning + border
// make it impossible to forget — the props panel can render the empty state
// red so the user knows the preview page would fail an audit.
function AltField({ value, defaultValue, onChange }) {
  const raw = value?.type === 'expr' ? value.value : value?.value;
  const v = raw ?? defaultValue ?? '';
  const empty = !v.trim();
  return (
    <div className="props-field">
      <label>
        <span className={`prop-label${empty ? ' set' : ''}`}>
          Alt
        </span>
      </label>
      <input
        value={v}
        spellCheck={true}
        placeholder="Describe the image for screen readers"
        style={empty ? { borderColor: 'var(--red)' } : undefined}
        onChange={(e) => onChange(encode(e.target.value, 'string'))}
      />
      {empty && (
        <div style={{ fontSize: 11, color: 'var(--red)', marginTop: 4, lineHeight: 1.4 }}>
          (empty — accessibility warning)
        </div>
      )}
    </div>
  );
}

function SimpleField({ name, value, defaultValue, onChange, placeholder, long }) {
  const raw = value?.type === 'expr' ? value.value : value?.value;
  const v = raw ?? defaultValue ?? '';
  return (
    <div className="props-field">
      <label>
        <span className="prop-label">{name}</span>
      </label>
      <input
        value={v}
        spellCheck={false}
        placeholder={placeholder}
        onChange={(e) => onChange(encode(e.target.value, name === 'src' ? 'string' : 'string'))}
      />
    </div>
  );
}

// Full props UI for an <Image> / <Picture> node. Hosts the fields that don't
// fit the generic PropField widget (widths list, formats multi-select,
// quality with a numeric range, the alt-text warning). The page-level
// fallback note lives at the bottom so the user sees it without scrolling.
export default function AstroImagePanel({ node, schema, onChange }) {
  const set = (name, v) => onChange(name, v);
  const get = (name) => node.props?.[name];
  const def = (name, fallback) => ASTRO_IMAGE_DEFAULTS[name] ?? fallback;

  return (
    <>
      <div
        style={{
          fontSize: 11,
          color: 'var(--text-faint)',
          padding: '6px 12px 10px',
          borderBottom: '1px solid var(--border)',
          lineHeight: 1.5,
        }}
      >
        <strong style={{ color: 'var(--text)' }}>{node.name}</strong> from{' '}
        <code>astro:assets</code> — auto-generates the import and a
        responsive <code>srcset</code> with AVIF/WebP variants.
      </div>

      <SimpleField
        name="src"
        value={get('src')}
        onChange={(v) => set('src', v)}
        placeholder="…"
      />
      <AltField
        value={get('alt')}
        defaultValue={def('alt', '')}
        onChange={(v) => set('alt', v)}
      />
      <WidthsField
        value={get('widths')}
        defaultValue={def('widths')}
        onChange={(v) => set('widths', v)}
      />
      <SimpleField
        name="sizes"
        value={get('sizes')}
        placeholder={def('sizes')}
        onChange={(v) => set('sizes', v)}
      />
      <FormatsField
        value={get('formats')}
        defaultValue={def('formats')}
        onChange={(v) => set('formats', v)}
      />
      <QualityField
        value={get('quality')}
        defaultValue={def('quality')}
        onChange={(v) => set('quality', v)}
      />
      <SimpleField
        name="loading"
        value={get('loading')}
        placeholder={def('loading')}
        onChange={(v) => set('loading', v)}
      />
      <SimpleField
        name="decoding"
        value={get('decoding')}
        placeholder={def('decoding')}
        onChange={(v) => set('decoding', v)}
      />

      <div
        style={{
          fontSize: 11,
          color: 'var(--text-faint)',
          padding: '10px 12px 0',
          lineHeight: 1.5,
        }}
      >
        If your project doesn't use <code>astro:assets</code>, this renders as
        a raw <code>&lt;img&gt;</code> with a console warning.
      </div>
    </>
  );
}
