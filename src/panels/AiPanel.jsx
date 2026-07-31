// AI inline-edit drawer. The user types an instruction, the panel streams a
// patch from a BYOK provider (Anthropic / OpenAI / Ollama), validates it
// against the original AST, and offers Accept / Reject. The renderer never
// sees API keys — main owns storage and only returns success/error.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { elementIcon } from '../ui/Icons.jsx';
import { diffNodes, summarizeDiff } from '../ai/diff.js';

const DEFAULT_MODELS = {
  anthropic: 'claude-sonnet-4-5',
  openai: 'gpt-4o-mini',
  ollama: 'llama3.2',
};

export default function AiPanel({
  open,
  onClose,
  selectedNode,
  selectedId,
  project,
  pagePath,
  showToast,
  onApplied,
}) {
  const [providers, setProviders] = useState([]);
  const [provider, setProvider] = useState('anthropic');
  const [model, setModel] = useState(DEFAULT_MODELS.anthropic);
  const [instruction, setInstruction] = useState('');
  const [busy, setBusy] = useState(false);
  const [patch, setPatch] = useState(null); // parsed patch object (after validation)
  const [error, setError] = useState(null);
  const [hasKey, setHasKey] = useState(false);
  const [draftPatchText, setDraftPatchText] = useState(''); // accumulated JSON text from stream
  const taRef = useRef(null);

  // Pull provider list + key status on mount and whenever the provider changes.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      try {
        const list = await window.avb.aiProviders();
        if (cancelled) return;
        setProviders(list);
        const prov = list.find((p) => p.id === provider);
        if (prov) setModel((m) => m || DEFAULT_MODELS[provider] || '');
        const ok = await window.avb.aiHasKey(provider);
        if (!cancelled) setHasKey(!!ok);
      } catch {
        /* renderer stays in a usable state without the list */
      }
    })();
    return () => { cancelled = true; };
  }, [open, provider]);

  // Subscribe to streamed patch chunks. The handler in main pushes to
  // 'ai:stream' with { text } per delta and { patch, error } at the end.
  useEffect(() => {
    if (!open) return;
    const off = window.avb.onAiStream((data) => {
      if (!data) return;
      if (data.type === 'delta' && typeof data.text === 'string') {
        setDraftPatchText((prev) => prev + data.text);
      } else if (data.type === 'done') {
        setBusy(false);
        if (data.patch) setPatch(data.patch);
        if (data.error) setError(data.error);
      }
    });
    return off;
  }, [open]);

  const reset = useCallback(() => {
    setPatch(null);
    setError(null);
    setDraftPatchText('');
    setInstruction('');
    setBusy(false);
  }, []);

  const close = useCallback(() => {
    reset();
    onClose && onClose();
  }, [onClose, reset]);

  const generate = useCallback(async () => {
    if (!selectedNode || !selectedId) {
      setError('Select a node on the canvas first.');
      return;
    }
    if (!instruction.trim()) {
      setError('Type an instruction for the model.');
      return;
    }
    setError(null);
    setPatch(null);
    setDraftPatchText('');
    setBusy(true);
    try {
      const result = await window.avb.aiEditNode({
        projectPath: project?.path,
        pagePath,
        nodeId: selectedId,
        instruction,
        model,
        provider,
      });
      if (!result || !result.ok) {
        setBusy(false);
        setError(result?.error || 'The provider returned no patch.');
        return;
      }
      setPatch(result.patch || null);
      // Summary text shown below the diff button.
    } catch (err) {
      setBusy(false);
      setError(err?.message || String(err));
    } finally {
      setBusy(false);
    }
  }, [selectedNode, selectedId, instruction, project, pagePath, model, provider]);

  const accept = useCallback(() => {
    if (!patch) return;
    // The IPC handler already wrote the file via markSelfWrite + page:write
    // — we just need to refresh the canvas and close.
    showToast && showToast({ msg: 'AI edits applied.', kind: 'ok' });
    onApplied && onApplied();
    close();
  }, [patch, close, onApplied, showToast]);

  const reject = useCallback(() => {
    setPatch(null);
    setDraftPatchText('');
    setError(null);
  }, []);

  // Diff preview against the live node so the user sees what's changing.
  const diffEntries = useMemo(() => {
    if (!patch || !selectedNode) return [];
    // Build a synthetic "patched" node copy the same way applyToNode does.
    const patched = JSON.parse(JSON.stringify(selectedNode));
    if (patch.props) {
      patched.props = patched.props || {};
      for (const k of Object.keys(patch.props)) {
        if (patched.props[k] !== undefined) {
          const v = patch.props[k];
          patched.props[k] = v && typeof v === 'object' && 'value' in v ? v : { type: 'string', value: String(v) };
        }
      }
    }
    if (patch.children) patched.children = patch.children;
    if (patch.frontmatter) {
      patched.frontmatter = patched.frontmatter || {};
      for (const k of Object.keys(patch.frontmatter)) {
        if (patched.frontmatter[k] !== undefined) patched.frontmatter[k] = patch.frontmatter[k];
      }
    }
    return diffNodes(selectedNode, patched, { topLevel: ['props', 'children', 'frontmatter'] });
  }, [patch, selectedNode]);

  const nodeLabel = useMemo(() => {
    if (!selectedNode) return 'nothing selected';
    if (selectedNode.kind === 'element' || selectedNode.kind === 'component' || selectedNode.kind === 'raw') {
      return selectedNode.name;
    }
    return selectedNode.kind;
  }, [selectedNode]);

  if (!open) return null;

  return (
    <div className="ai-panel" role="dialog" aria-label="AI inline-edit">
      <div className="ai-panel-header">
        <span className="ai-panel-title">
          <span aria-hidden>✨</span> Edit selected: <strong>{nodeLabel}</strong>
        </span>
        <button className="ghost" onClick={close} aria-label="Close AI panel">×</button>
      </div>
      <div className="ai-panel-body">
        <div className="ai-panel-field">
          <label>Provider</label>
          <select value={provider} onChange={(e) => setProvider(e.target.value)} disabled={busy}>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}{p.requiresKey ? (hasKey ? ' · ✓' : ' · no key') : ''}
              </option>
            ))}
            {providers.length === 0 && <option value="anthropic">Anthropic Claude</option>}
          </select>
        </div>
        <div className="ai-panel-field">
          <label>Model</label>
          <input
            type="text"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="claude-sonnet-4-5"
            disabled={busy}
          />
        </div>
        <div className="ai-panel-field">
          <label>Instruction</label>
          <textarea
            ref={taRef}
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            rows={3}
            placeholder='e.g. "Make the heading bigger and bolder"'
            disabled={busy}
          />
        </div>
        <div className="ai-panel-actions">
          <button className="primary" onClick={generate} disabled={busy || !instruction.trim()}>
            {busy ? 'Generating…' : 'Generate'}
          </button>
          {patch && (
            <>
              <button className="primary" onClick={accept} disabled={busy}>Accept</button>
              <button onClick={reject} disabled={busy}>Reject</button>
            </>
          )}
        </div>
        {error && <div className="ai-panel-error">{error}</div>}
        {draftPatchText && (
          <div className="ai-panel-stream">
            <label>Model output</label>
            <pre>{draftPatchText}</pre>
          </div>
        )}
        {patch && (
          <div className="ai-panel-diff">
            <label>Changes</label>
            <div className="ai-panel-diff-summary">{summarizeDiff(diffEntries)}</div>
            <ul>
              {diffEntries.slice(0, 12).map((e, i) => (
                <li key={i} className={`ai-diff-${e.kind}`}>
                  <code>{e.path || '(root)'}</code>: {e.kind}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
