import React, { useCallback, useEffect, useMemo, useState } from 'react';

// Minimal Astro content collections editor: lists collections + entries,
// reads .md/.mdx from `src/content/<name>/`, edits frontmatter as raw JSON
// in a textarea (the schema-aware FormFromSchema + the MdxEditor (CodeMirror)
// both ship in a follow-up). All file I/O is funneled through the
// `avb` preload bridge, which routes to `content:*` IPC handlers.

// Frontmatter fence — built at runtime so the \\r?\\n escapes don't sit
// inside a literal that's adjacent to JSX (vite/esbuild rejects those).
const FM_RE = new RegExp('^---\\r?\\n([\\s\\S]*?)\\r?\\n---\\r?\\n?');

function parseFrontmatterText(text) {
  const m = FM_RE.exec(text || '');
  if (!m) return { fm: '', body: text || '' };
  return { fm: m[1], body: (text || '').slice(m[0].length) };
}

function joinSource(fmText, body) {
  const trimmed = (fmText || '').trim();
  if (!trimmed) return body || '';
  return `---${trimmed}---${body || ''}`;
}

function tryParseJson(s) {
  try { return { ok: true, value: JSON.parse(s) }; } catch { return { ok: false }; }
}

export default function ContentPanel({ project, showToast }) {
  const [tree, setTree] = useState([]); // [{ name, entries: [{ rel, name }] }]
  const [selected, setSelected] = useState(null); // { collection, entry }
  const [frontmatter, setFrontmatter] = useState('');
  const [body, setBody] = useState('');
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [usage, setUsage] = useState([]);

  const reload = useCallback(async () => {
    if (!project) return;
    setLoading(true); setError(null);
    try {
      const res = await window.avb.listContent(project);
      setTree(res.collections || []);
    } catch (err) { setError(String(err.message || err)); }
    finally { setLoading(false); }
  }, [project]);

  useEffect(() => { reload(); }, [reload]);

  const openEntry = useCallback(async (collection, entry) => {
    if (!project) return;
    setSelected({ collection: collection.name, entry });
    setDirty(false); setUsage([]);
    try {
      const res = await window.avb.readContent({ projectPath: project, rel: entry.rel });
      const fm = res.frontmatter || {};
      setFrontmatter(Object.keys(fm).length ? JSON.stringify(fm, null, 2) : '');
      setBody(res.body || '');
      const usageRes = await window.avb.contentUsage({ projectPath: project, rel: entry.rel });
      setUsage((usageRes && usageRes.references) || []);
    } catch (err) { showToast && showToast('Read failed: ' + (err.message || err), 'error'); }
  }, [project, showToast]);

  const save = useCallback(async () => {
    if (!project || !selected) return;
    // Reject invalid frontmatter early — saves with a malformed JSON block
    // would clobber the file on disk.
    const trimmed = frontmatter.trim();
    let parsed = {};
    if (trimmed) {
      const r = tryParseJson(trimmed);
      if (!r.ok) { showToast && showToast('Frontmatter must be valid JSON.', 'error'); return; }
      parsed = r.value;
    }
    try {
      await window.avb.writeContent({
        projectPath: project,
        rel: selected.entry.rel,
        frontmatter: parsed,
        body,
      });
      setDirty(false);
      showToast && showToast('Saved', 'success');
      reload();
    } catch (err) { showToast && showToast('Save failed: ' + (err.message || err), 'error'); }
  }, [project, selected, frontmatter, body, showToast, reload]);

  const entries = useMemo(() => {
    if (!selected) return [];
    const c = tree.find((c) => c.name === selected.collection);
    return c ? c.entries : [];
  }, [tree, selected]);

  return (
    <div className="content-panel">
      <div className="content-panel__head">
        <h3>Content</h3>
        <button className="ghost" onClick={reload} disabled={!project || loading}>Refresh</button>
      </div>

      {!project && <div className="content-panel__empty">Open a project to edit content.</div>}
      {error && <div className="content-panel__error">{error}</div>}

      {project && (
        <div className="content-panel__split">
          <div className="content-panel__collections">
            {tree.length === 0 && !loading && (
              <div className="content-panel__hint">
                No collections found. Add an <code>src/content.config.ts</code> or
                create <code>src/content/&lt;name&gt;/*.md</code> files.
              </div>
            )}
            {tree.map((c) => (
              <div key={c.name} className="content-panel__collection">
                <div className="content-panel__collection-name">{c.name}</div>
                {c.entries.length === 0 && <div className="content-panel__hint">No entries</div>}
                {c.entries.map((e) => (
                  <button
                    key={e.rel}
                    className={'content-panel__entry' + (selected && selected.entry.rel === e.rel ? ' is-selected' : '')}
                    onClick={() => openEntry(c, e)}
                  >
                    {e.name}
                  </button>
                ))}
              </div>
            ))}
          </div>

          <div className="content-panel__editor">
            {selected ? (
              <>
                <div className="content-panel__path">{selected.entry.rel}</div>
                {entries.length > 1 && (
                  <select
                    value={selected.entry.rel}
                    onChange={(ev) => {
                      const next = entries.find((x) => x.rel === ev.target.value);
                      if (next) openEntry(tree.find((c) => c.name === selected.collection), next);
                    }}
                  >
                    {entries.map((e) => <option key={e.rel} value={e.rel}>{e.name}</option>)}
                  </select>
                )}
                <label className="content-panel__label">Frontmatter (JSON)</label>
                <textarea
                  className="content-panel__fm"
                  rows={6}
                  value={frontmatter}
                  onChange={(ev) => { setFrontmatter(ev.target.value); setDirty(true); }}
                />
                <label className="content-panel__label">Body</label>
                <textarea
                  className="content-panel__body"
                  rows={14}
                  value={body}
                  onChange={(ev) => { setBody(ev.target.value); setDirty(true); }}
                />
                <div className="content-panel__actions">
                  <button className="primary" onClick={save} disabled={!dirty}>Save</button>
                  {usage.length > 0 && (
                    <span className="content-panel__usage">
                      Used in: {usage.map((u) => u.file).join(', ')}
                    </span>
                  )}
                </div>
              </>
            ) : (
              <div className="content-panel__empty">Select an entry to edit.</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
