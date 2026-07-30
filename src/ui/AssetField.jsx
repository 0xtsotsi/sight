import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  FolderIcon,
  ChevronRightIcon,
  UploadCloudIcon,
  ElementImageIcon,
} from './Icons.jsx';
import AssetThumb from './AssetThumb.jsx';

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|svg|ico|bmp)$/i;
const VIDEO_EXT = /\.(mp4|webm|mov|m4v|ogv|ogg)$/i;
const AUDIO_EXT = /\.(mp3|wav|m4a|aac|flac|oga)$/i;

const kindLabel = { image: 'Image', video: 'Video', audio: 'Audio', asset: 'Asset' };
const kindMatches = (kind, name) => {
  if (kind === 'image') return IMAGE_EXT.test(name);
  if (kind === 'video') return VIDEO_EXT.test(name);
  if (kind === 'audio') return AUDIO_EXT.test(name);
  return true;
};

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
  const [pickerOpen, setPickerOpen] = useState(false);
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
      <button className="af-choose" onClick={() => setPickerOpen(true)}>
        Choose {label}…
      </button>

      {pickerOpen && (
        <AssetPicker
          entries={entries}
          mediaKind={mediaKind}
          current={rel}
          projectPath={projectPath}
          onRefresh={refresh}
          onPick={(pickedRel) => {
            setPickerOpen(false);
            onChange('/' + pickedRel, true);
          }}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>
  );
}

// Modal asset browser over public/, filtered to the media kind.
function AssetPicker({ entries, mediaKind, current, projectPath, onRefresh, onPick, onClose }) {
  const [cwd, setCwd] = useState(() => {
    // Start in the current asset's folder.
    if (current && current.includes('/')) {
      const dir = current.slice(0, current.lastIndexOf('/'));
      if (entries.some((e) => e.isDir && e.rel === dir)) return dir;
    }
    return '';
  });
  const ref = useRef(null);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const folders = entries.filter((e) => e.isDir && e.parent === cwd);
  const files = entries.filter(
    (e) => !e.isDir && e.parent === cwd && kindMatches(mediaKind, e.name)
  );

  const crumbs = [{ rel: '', label: 'public' }];
  if (cwd) {
    const parts = cwd.split('/');
    parts.forEach((part, i) =>
      crumbs.push({ rel: parts.slice(0, i + 1).join('/'), label: part })
    );
  }

  return (
    <div className="insert-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="asset-picker" ref={ref}>
        <div className="asset-picker-head">
          <div className="asset-crumbs" style={{ padding: 0, flex: 1 }}>
            {crumbs.map((c, i) => (
              <React.Fragment key={c.rel}>
                {i > 0 && (
                  <span className="crumb-sep">
                    <ChevronRightIcon size={9} />
                  </span>
                )}
                <span
                  className={`crumb ${i === crumbs.length - 1 ? 'last' : ''}`}
                  onClick={() => setCwd(c.rel)}
                >
                  {c.label}
                </span>
              </React.Fragment>
            ))}
          </div>
          <button
            className="ghost"
            title="Upload"
            onClick={async () => {
              await window.avb.pickUploadAssets({ projectPath, destRel: cwd });
              onRefresh();
            }}
          >
            <UploadCloudIcon size={14} />
          </button>
        </div>

        <div className="asset-picker-body">
          {folders.map((folder) => (
            <div key={folder.rel} className="asset-tile folder" onClick={() => setCwd(folder.rel)}>
              <div className="asset-thumb">
                <FolderIcon size={20} />
              </div>
              <div className="asset-name">{folder.name}</div>
            </div>
          ))}
          {files.map((file) => (
            <div
              key={file.rel}
              className={`asset-tile ${file.rel === current ? 'selected' : ''}`}
              onClick={() => onPick(file.rel)}
              title={`/${file.rel}`}
            >
              <AssetThumb file={file} />
              <div className="asset-name">{file.name}</div>
            </div>
          ))}
          {folders.length === 0 && files.length === 0 && (
            <div className="props-empty" style={{ gridColumn: '1 / -1' }}>
              No matching assets in this folder.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
