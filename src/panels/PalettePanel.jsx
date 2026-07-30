import React, { useEffect, useRef, useState } from 'react';
import { ElementComponentIcon, LayoutIcon } from '../ui/Icons.jsx';
import { setDrag, clearDrag } from '../dragState.js';

// PascalCase → spaced display name (ButtonArrow → Button Arrow).
const prettyName = (name) => name.replace(/([a-z0-9])([A-Z])/g, '$1 $2');

export default function PalettePanel({ components, devUrl, onInsert, onDragBegin }) {
  const [query, setQuery] = useState('');
  const [preview, setPreview] = useState(null); // {name, left, top}
  const hoverTimer = useRef(null);
  useEffect(() => () => clearTimeout(hoverTimer.current), []);

  const q = query.trim().toLowerCase();
  const list = components.filter(
    (c) => !q || c.name.toLowerCase().includes(q) || (c.folder || '').toLowerCase().includes(q)
  );

  // Grouped by the folder each file sits in, so layouts land under "layouts"
  // and component subfolders group under their own name. Anything at the
  // root of src/components has no folder and stays at the top, ungrouped.
  const groups = React.useMemo(() => {
    const byFolder = new Map();
    for (const c of list) {
      const key = c.folder || '';
      if (!byFolder.has(key)) byFolder.set(key, []);
      byFolder.get(key).push(c);
    }
    return [...byFolder.entries()].sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [components, q]);

  const schedulePreview = (comp) => (e) => {
    clearTimeout(hoverTimer.current);
    const rect = e.currentTarget.getBoundingClientRect();
    const left = rect.right + 10;
    const top = Math.max(8, Math.min(rect.top, window.innerHeight - 260));
    hoverTimer.current = setTimeout(() => setPreview({ name: comp.name, left, top }), 450);
  };

  const cancelPreview = () => {
    clearTimeout(hoverTimer.current);
    setPreview(null);
  };

  return (
    <div className="panel-section grow">
      <div className="panel-header">
        <h2>Components</h2>
      </div>

      <div style={{ padding: '0 12px 8px' }}>
        <input
          value={query}
          placeholder="Search components"
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <div className="panel-body" onMouseLeave={cancelPreview}>
        {groups.map(([folder, items]) => (
          <React.Fragment key={folder || '__root'}>
            {folder && <div className="palette-folder">{folder}</div>}
            {items.map((comp) => (
          <div
            key={comp.path}
            className="palette-item"
            draggable
            title="Drag into the Navigator, or double-click to add to the page"
            onMouseEnter={schedulePreview(comp)}
            onMouseLeave={cancelPreview}
            onDragStart={(e) => {
              cancelPreview();
              e.dataTransfer.setData('avb/component', comp.name);
              e.dataTransfer.effectAllowed = 'copy';
              // Components render unknown markup, so nothing blocks them —
              // recorded anyway so stale state can't linger between drags.
              setDrag({ kind: 'component', name: comp.name });
              // Switch the left panel to the Navigator so the component can
              // be dropped into the tree. Deferred so the browser captures
              // the drag before this row unmounts.
              if (onDragBegin) setTimeout(onDragBegin, 0);
            }}
            onDragEnd={clearDrag}
            onDoubleClick={() => onInsert(comp.name)}
          >
            <span className="icon">
              {comp.isLayout ? <LayoutIcon size={14} /> : <ElementComponentIcon size={14} />}
            </span>
            <span className="label">
              {prettyName(comp.name)}
              {comp.instances != null && (
                <div className="sub">
                  {comp.instances} instance{comp.instances === 1 ? '' : 's'}
                </div>
              )}
            </span>
          </div>
            ))}
          </React.Fragment>
        ))}
        {list.length === 0 && (
          <div className="props-empty">
            {components.length === 0 ? (
              <>
                No components found in <code>src/components</code>.
              </>
            ) : (
              <>No components match “{query.trim()}”.</>
            )}
          </div>
        )}
      </div>

      {preview && devUrl && (
        <div className="comp-preview" style={{ left: preview.left, top: preview.top }}>
          <div className="comp-preview-title">{prettyName(preview.name)}</div>
          <iframe
            src={`${devUrl}/__avb/preview?c=${encodeURIComponent(preview.name)}`}
            title={`${preview.name} preview`}
          />
        </div>
      )}
    </div>
  );
}
