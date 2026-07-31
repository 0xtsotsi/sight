import React, { useState } from 'react';
import { ASTRO_IMAGE_DEFAULTS } from '../elementSchemas/astro-image.js';

const FORMAT_OPTIONS = ['avif', 'webp', 'png', 'jpg', 'jpeg', 'gif', 'svg'];

// Encode arbitrary JS values back into the prop shape the model expects.
// Arrays become expression literals; everything else is a string attr.
function encode(v, kind) {
  if (kind === 'array') return { type: 'expr', value: '[' + v.join(', ') + ']' };
  if (kind === 'number') return { type: 'expr', value: String(v) };
  return { type: 'string', value: String(v) };
}

// Read a prop value back to a raw string/array. Numbers / arrays are stored
// as {type:'expr', value}; strings as {type:'string', value}. Missing → default.
function readProp(value, fallback) {
  if (value == null) return fallback;
  if (value.type === 'string' || value.type === 'expr') return value.value;
  return fallback;
}

// Editor for widths: a comma-separated list of numbers. The raw string keeps
// the field flat and matches what Astro wants in the source.
function WidthsField({ value, defaultValue, onChange }) {
  const raw = readProp(value, defaultValue);
  const text = Array.isArray(raw) ? raw.join(', ') : String(raw);
  const [draft, setDraft] = useState(text);
  const [bad, setBad] = useState(false);

  const commit = (next) => {
    const nums = next.split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));
    if (nums.length === 0 || nums.some((n) => n <= 0)) {
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
  const raw = readProp(value, defaultValue);
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
  const raw = readProp(value, defaultValue);
  const n = Number(raw);
  const [draft, setDraft] = useState(Number.isFinite(n) ? n : defaultValue);
  const commit = (next) => {
    const num = Number(next);
    if (!Number.isFinite(num) || num < 1 || num > 100) return;
    onChange(encode(num, 'number'));
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

// Alt text is required for accessibility. The red border + "(empty —
// accessibility warning)" line below the field make the empty state
// impossible to miss in the props panel.
function AltField({ value, defaultValue, onChange }) {
  const raw = readProp(value, defaultValue);
  const v = raw ?? '';
  const empty = !v.trim();
  return (
    <div className="props-field">
      <label>
        <span className="prop-label">Alt</span>
      </label>
      <input
        value={v}
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

function TextField({ name, value, placeholder, onChange }) {
  const v = readProp(value, '');
  return (
    <div className="props-field">
      <label>
        <span className="prop-label">{name}</span>
      </label>
      <input
        value={v}
        spellCheck={false}
        placeholder={placeholder}
        onChange={(e) => onChange(encode(e.target.value, 'string'))}
      />
    </div>
  );
}

// Full props UI for an <Image> / <Picture> node. Hosts the bespoke fields
// that don't fit the generic PropField widget (widths list, formats
// multi-select, quality with a numeric range, the alt-text warning). The
// page-level fallback note lives at the bottom so the user sees it without
// scrolling.
export default function AstroImagePanel({ node, onChange }) {
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

      <TextField
        name="src"
        value={get('src')}
        placeholder="…"
        onChange={(v) => onChange('src', v)}
      />
      <AltField
        value={get('alt')}
        defaultValue={def('alt', '')}
        onChange={(v) => onChange('alt', v)}
      />
      <WidthsField
        value={get('widths')}
        defaultValue={def('widths')}
        onChange={(v) => onChange('widths', v)}
      />
      <TextField
        name="sizes"
        value={get('sizes')}
        placeholder={def('sizes')}
        onChange={(v) => onChange('sizes', v)}
      />
      <FormatsField
        value={get('formats')}
        defaultValue={def('formats')}
        onChange={(v) => onChange('formats', v)}
      />
      <QualityField
        value={get('quality')}
        defaultValue={def('quality')}
        onChange={(v) => onChange('quality', v)}
      />
      <TextField
        name="loading"
        value={get('loading')}
        placeholder={def('loading')}
        onChange={(v) => onChange('loading', v)}
      />
      <TextField
        name="decoding"
        value={get('decoding')}
        placeholder={def('decoding')}
        onChange={(v) => onChange('decoding', v)}
      />

      <div
        style={{
          fontSize: 11,
          color: 'var(--text-faint)',
          padding: '10px 12px 0',
          lineHeight: 1.5,
        }}
      >
        If your project doesn't use <code>astro:assets</code>, this renders
        as a raw <code>&lt;img&gt;</code> with a console warning.
      </div>
    </>
  );
}
