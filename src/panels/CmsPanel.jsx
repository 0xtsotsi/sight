import React, { useCallback, useEffect, useState } from 'react';
import { CmsIcon, PlusIcon, ChevronRightIcon, GearIcon } from '../ui/Icons.jsx';
import { collectionOf } from '../cmsSchema.js';

// Left-rail panel: every .json file under src/ listed as a collection.
// Picking one opens the editor over the canvas (see CmsView).
export default function CmsPanel({
  project,
  selectedRel,
  refreshKey,
  onSelect,
  onOpenSettings,
  showToast,
}) {
  const [files, setFiles] = useState([]);
  const [creating, setCreating] = useState(false);

  const refresh = useCallback(async () => {
    const { files: list } = await window.avb.listCms(project.path);
    setFiles(list || []);
  }, [project.path]);

  // refreshKey bumps when the editor saves — our own writes don't come back
  // through the watcher, so the item counts would otherwise go stale.
  useEffect(() => {
    refresh();
    return window.avb.onCmsChanged(refresh);
  }, [refresh, refreshKey]);

  const act = async (fn) => {
    try {
      return await fn();
    } catch (err) {
      showToast(
        String(err?.message || err).replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, ''),
        'error'
      );
    }
  };

  const collections = files.map(collectionOf);

  // Group by folder so src/data and src/content read as separate sections.
  const groups = [];
  for (const c of collections) {
    const dir = c.dir || '';
    let group = groups.find((g) => g.dir === dir);
    if (!group) groups.push((group = { dir, items: [] }));
    group.items.push(c);
  }

  const create = async (name) => {
    setCreating(false);
    if (!name.trim()) return;
    const res = await act(() => window.avb.createCms({ projectPath: project.path, name }));
    await refresh(); // don't wait on the watcher to show what we just made
    if (res?.rel) onSelect(res.rel);
  };

  return (
    <div className="panel-section grow">
      <div className="panel-header">
        <h2>CMS Collections</h2>
        <button className="ghost" title="New collection" onClick={() => setCreating(true)}>
          <PlusIcon size={14} />
        </button>
      </div>

      <div className="panel-body">
        {creating && (
          <div className="cms-collection">
            <CmsIcon size={14} />
            <input
              autoFocus
              placeholder="Collection name"
              onBlur={(e) => create(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur();
                if (e.key === 'Escape') {
                  e.currentTarget.value = '';
                  e.currentTarget.blur();
                }
              }}
            />
          </div>
        )}

        {groups.map((group) => (
          <div key={group.dir} className="cms-group">
            {groups.length > 1 && <div className="cms-group-label">src/{group.dir || ''}</div>}
            {group.items.map((c) => (
              <div
                key={c.rel}
                className={`cms-collection ${selectedRel === c.rel ? 'on' : ''} ${c.error ? 'broken' : ''}`}
                onClick={() => onSelect(c.rel)}
                title={c.error ? `src/${c.rel} — ${c.error}` : `src/${c.rel}`}
              >
                <CmsIcon size={14} />
                <span className="cms-collection-name">{c.label}</span>
                <span className="cms-collection-count">
                  {c.error
                    ? 'unreadable'
                    : c.single || c.items.length === 1
                      ? '1 item'
                      : `${c.items.length} items`}
                </span>
                <button
                  className="ghost row-action"
                  title="Collection settings"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (!c.error) onOpenSettings(c.rel);
                  }}
                  disabled={!!c.error}
                >
                  <GearIcon size={13} />
                </button>
                <span className="cms-collection-chevron">
                  <ChevronRightIcon size={10} />
                </span>
              </div>
            ))}
          </div>
        ))}

        {collections.length === 0 && !creating && (
          <div className="props-empty">
            No JSON data found in <code>src/</code>.
            <div style={{ marginTop: 10 }}>
              <button className="primary" onClick={() => setCreating(true)}>
                New collection
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
