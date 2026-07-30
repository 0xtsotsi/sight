import React, { useEffect, useMemo, useState } from 'react';
import { ElementImageIcon } from './Icons.jsx';
import AssetThumb from './AssetThumb.jsx';
import { requestAsset } from '../assetPick.js';

const kindLabel = { image: 'Image', video: 'Video', audio: 'Audio', asset: 'Asset' };

const fmtSize = (bytes) => {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};

const isExternal = (v) => /^(https?:)?\/\//.test(v) || v.startsWith('data:');

// src/poster editor: shows the chosen public/ asset (thumb, name, dimensions,
// size) with a picker, or a plain URL field for external assets.
// showModeToggle=false hides the Asset/URL switch for hosts that provide
// their own type control (the href link editor), where it would both
// duplicate that control and overlap it — the toggle is positioned to sit
// beside a field label, which those hosts don't have directly above.
export default function AssetField({
  value,
  onChange,
  mediaKind = 'asset',
  projectPath,
  showModeToggle = true,
  // 'asset' | 'url' — overrides the value-sniffing default. Used where the
  // host already decided the value names a project file.
  initialMode,
  // Label for the free-text mode; "URL" reads wrong for data-* attributes.
  plainLabel = 'URL',
}) {
  const current = value || '';
  const [mode, setMode] = useState(
    () => initialMode || (showModeToggle && current && isExternal(current) ? 'url' : 'asset')
  );
  const [entries, setEntries] = useState([]);
  const [dims, setDims] = useState(null);

  const refresh = React.useCallback(async () => {
    const { entries: list } = await window.avb.listAssets(projectPath);
    setEntries(list || []);
  }, [projectPath]);

  useEffect(() => {
    refresh();
    const off = window.avb.onAssetsChanged(refresh);
    return off;
  }, [refresh]);

  const rel = current.replace(/^\//, '');
  const entry = useMemo(
    () => entries.find((e) => !e.isDir && e.rel === rel) || null,
    [entries, rel]
  );

  useEffect(() => setDims(null), [current]);

  const label = kindLabel[mediaKind] || 'Asset';

  const toggle = showModeToggle && (
    <div className="af-mode">
      <button
        className={`af-mode-btn ${mode === 'asset' ? 'on' : ''}`}
        title={`Choose from public/`}
        onClick={() => setMode('asset')}
      >
        Asset
      </button>
      <button
        className={`af-mode-btn ${mode === 'url' ? 'on' : ''}`}
        title="Enter a plain value (external URL, expression, anything)"
        onClick={() => setMode('url')}
      >
        {plainLabel}
      </button>
    </div>
  );

  if (mode === 'url') {
    return (
      <div className="asset-field">
        {toggle}
        <input
          value={current}
          placeholder="https://…"
          spellCheck={false}
          onChange={(e) => onChange(e.target.value)}
        />
      </div>
    );
  }

  return (
    <div className="asset-field">
      {toggle}
      <div className="af-card">
        <div className="af-thumb">
          {entry ? (
            <AssetThumb file={entry} onImageLoad={setDims} />
          ) : (
            <ElementImageIcon size={18} />
          )}
        </div>
        <div className="af-meta">
          <div className="af-name" title={current}>
            {entry ? entry.name : current ? current : 'No asset selected'}
          </div>
          {dims && (
            <div className="af-sub">
              {dims.w} x {dims.h}px
            </div>
          )}
          {entry && <div className="af-sub">{fmtSize(entry.size)}</div>}
          {!entry && current && <div className="af-sub">not found in public/</div>}
        </div>
      </div>
      <button
        className="af-choose"
        onClick={() =>
          requestAsset({
            mediaKind,
            current: rel,
            onPick: (pickedRel) => onChange('/' + pickedRel, true),
          })
        }
      >
        Choose {label}…
      </button>
    </div>
  );
}
