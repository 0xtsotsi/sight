// Settings tab for AI inline-edit. Lists each BYOK provider, lets the user
// paste / replace / clear an API key. The key is sent to main once and never
// returned to the renderer — only a "configured / not configured" status is
// shown. Ollama is local and never needs a key.

import React, { useCallback, useEffect, useState } from 'react';

const KEY_PLACEHOLDER = '••••••••';

export default function SettingsAi({ showToast }) {
  const [providers, setProviders] = useState([]);
  const [status, setStatus] = useState({}); // providerId -> bool
  const [editing, setEditing] = useState(null); // providerId currently being edited
  const [draft, setDraft] = useState('');

  const refresh = useCallback(async () => {
    try {
      const list = await window.avb.aiProviders();
      setProviders(list);
      const s = {};
      for (const p of list) s[p.id] = await window.avb.aiHasKey(p.id);
      setStatus(s);
    } catch (err) {
      showToast && showToast({ msg: 'Could not load AI providers: ' + (err?.message || err), kind: 'err' });
    }
  }, [showToast]);

  useEffect(() => { refresh(); }, [refresh]);

  const startEdit = (id) => { setEditing(id); setDraft(''); };
  const cancelEdit = () => { setEditing(null); setDraft(''); };

  const save = useCallback(async (id) => {
    if (!draft.trim()) return;
    const result = await window.avb.aiSetKey(id, draft.trim());
    setEditing(null);
    setDraft('');
    if (result && result.ok) {
      setStatus((s) => ({ ...s, [id]: true }));
      showToast && showToast({ msg: 'API key saved.', kind: 'ok' });
    } else {
      showToast && showToast({ msg: 'Could not save key: ' + (result?.error || 'unknown'), kind: 'err' });
    }
  }, [draft, showToast]);

  const clear = useCallback(async (id) => {
    await window.avb.aiClearKey(id);
    setStatus((s) => ({ ...s, [id]: false }));
    showToast && showToast({ msg: 'API key removed.', kind: 'ok' });
  }, [showToast]);

  return (
    <div className="ai-settings">
      <div className="panel-header">
        <h2>AI providers</h2>
      </div>
      <div className="ai-settings-intro">
        Bring your own key. Keys are stored encrypted in your OS keychain via
        Electron <code>safeStorage</code> and never leave this app — Sight has
        no proxy, no telemetry, and no SaaS in the middle.
      </div>
      <div className="ai-settings-list">
        {providers.map((p) => {
          const configured = !!status[p.id];
          const isEditing = editing === p.id;
          return (
            <div key={p.id} className="ai-settings-row">
              <div className="ai-settings-meta">
                <div className="ai-settings-label">{p.label}</div>
                <div className="ai-settings-endpoint">{p.endpoint}</div>
                <div className={`ai-settings-status ${configured ? 'on' : 'off'}`}>
                  {configured ? 'Configured' : p.requiresKey ? 'Not configured' : 'No key required'}
                </div>
              </div>
              {!p.requiresKey ? null : isEditing ? (
                <div className="ai-settings-edit">
                  <input
                    type="password"
                    autoFocus
                    placeholder={KEY_PLACEHOLDER}
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') save(p.id);
                      else if (e.key === 'Escape') cancelEdit();
                    }}
                  />
                  <button className="primary" onClick={() => save(p.id)} disabled={!draft.trim()}>Save</button>
                  <button onClick={cancelEdit}>Cancel</button>
                </div>
              ) : (
                <div className="ai-settings-buttons">
                  {configured ? (
                    <>
                      <button onClick={() => startEdit(p.id)}>Replace key</button>
                      <button className="danger" onClick={() => clear(p.id)}>Remove key</button>
                    </>
                  ) : (
                    <button className="primary" onClick={() => startEdit(p.id)}>Add key</button>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {providers.length === 0 && (
          <div className="ai-settings-empty">Loading providers…</div>
        )}
      </div>
    </div>
  );
}
