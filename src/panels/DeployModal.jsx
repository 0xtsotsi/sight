import React, { useEffect, useRef, useState } from 'react';
import { cleanError } from '../App.jsx';
import { CheckIcon, CloseIcon, ExternalIcon, RocketIcon } from '../ui/Icons.jsx';

// One-click deploy modal. Runs `npm run build` and then the chosen provider's
// CLI, streaming output through the IPC `deploy:progress` channel. Tokens
// are held in main's safeStorage — the modal either has a token (use it) or
// it shows a paste field and pushes it to main, never reading it back.
export default function DeployModal({ project, branch, onClose }) {
  const [provider, setProvider] = useState('vercel');
  const [branchName, setBranchName] = useState(branch || 'main');
  const [status, setStatus] = useState(null); // null = initial probe
  const [hasToken, setHasToken] = useState({ vercel: false, netlify: false, cloudflare: false });
  const [cli, setCli] = useState({ vercel: false, netlify: false, cloudflare: false });
  const [safeStorageAvailable, setSafeStorageAvailable] = useState(true);
  const [tokenInput, setTokenInput] = useState('');
  const [phase, setPhase] = useState('idle'); // idle | building | deploying | done | error
  const [step, setStep] = useState('');
  const [error, setError] = useState(null);
  const [logs, setLogs] = useState([]); // streamed text lines
  const [result, setResult] = useState(null); // { url, isProduction, message }
  const [busy, setBusy] = useState(false);
  const logRef = useRef(null);

  // Probe CLI + token presence + safeStorage availability at mount, so the
  // form can gray itself out before the user picks anything.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const s = await window.avb.deployStatus();
        if (!alive) return;
        setCli(s.cli || { vercel: false, netlify: false, cloudflare: false });
        setHasToken(s.hasToken || { vercel: false, netlify: false, cloudflare: false });
        setSafeStorageAvailable(!!s.safeStorageAvailable);
        setStatus(s);
      } catch (err) {
        if (!alive) return;
        setError(cleanError(err));
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Stream deploy:progress into the log buffer. Cap at ~400 lines so a chatty
  // CLI doesn't grow the DOM unboundedly.
  useEffect(() => {
    const off = window.avb.onDeployProgress((entry) => {
      setLogs((prev) => {
        const next = prev.concat(formatLog(entry));
        return next.length > 400 ? next.slice(next.length - 400) : next;
      });
      if (entry?.kind === 'build' && entry.stream === 'closed') {
        setPhase((p) => (p === 'building' ? 'idle' : p));
      }
      if (entry?.kind === 'deploy' && entry.stream === 'system') {
        setStep(entry.text);
      }
      if (entry?.kind === 'deploy' && entry.stream === 'closed' && !entry.ok) {
        setPhase('error');
      }
    });
    return off;
  }, []);

  // Auto-scroll the log tail.
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs]);

  const cliOk = !!cli[provider];
  const tokenOk = !!hasToken[provider];
  const canStart =
    !busy && cliOk && tokenOk && safeStorageAvailable && (phase === 'idle' || phase === 'done' || phase === 'error');

  const saveToken = async () => {
    setError(null);
    try {
      await window.avb.deploySetToken({ provider, token: tokenInput });
      setTokenInput('');
      setHasToken((h) => ({ ...h, [provider]: true }));
    } catch (err) {
      setError(cleanError(err));
    }
  };

  const clearToken = async () => {
    setError(null);
    try {
      await window.avb.deployClearToken({ provider });
      setHasToken((h) => ({ ...h, [provider]: false }));
    } catch (err) {
      setError(cleanError(err));
    }
  };

  const start = async () => {
    setError(null);
    setResult(null);
    setLogs([]);
    setBusy(true);
    setPhase('building');
    setStep('Building…');
    try {
      const build = await window.avb.deployBuild({ projectPath: project.path });
      if (!build.ok) {
        setPhase('error');
        setError(build.error || 'Build failed.');
        setBusy(false);
        return;
      }
      setPhase('deploying');
      setStep(`Deploying to ${providerLabel(provider)}…`);
      const res = await window.avb.deployStart({
        projectPath: project.path,
        provider,
        branch: branchName,
      });
      setResult(res);
      setPhase('done');
    } catch (err) {
      setPhase('error');
      setError(cleanError(err));
    } finally {
      setBusy(false);
    }
  };

  const copyUrl = () => {
    if (result?.url) navigator.clipboard?.writeText(result.url).catch(() => {});
  };

  return (
    <div
      className="modal-overlay"
      onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}
    >
      <div className="modal deploy-modal">
        <div className="modal-header">
          <RocketIcon size={14} /> Deploy to {providerLabel(provider)}
        </div>

        <div className="modal-body">
          <div>
            <label>Provider</label>
            <div className="deploy-provider-row">
              {(['vercel', 'netlify', 'cloudflare']).map((p) => (
                <button
                  key={p}
                  className={`deploy-pill ${provider === p ? 'on' : ''}`}
                  onClick={() => setProvider(p)}
                  disabled={busy}
                  title={providerLabel(p)}
                >
                  {providerLabel(p)}
                  {!cli[p] && <span className="deploy-pill-warn">CLI missing</span>}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label>Branch</label>
            <input
              value={branchName}
              onChange={(e) => setBranchName(e.target.value)}
              disabled={busy}
              placeholder="main"
            />
            <div className="hint-text">
              Informational only — the provider CLI deploys whatever is currently checked out.
            </div>
          </div>

          {!safeStorageAvailable && (
            <div className="error-text">
              The OS keychain isn’t available, so tokens can’t be encrypted at rest. Install
              the keychain (macOS Keychain / Windows DPAPI / Linux Secret Service) and
              restart Sight to enable deploys.
            </div>
          )}

          {safeStorageAvailable && !tokenOk && (
            <div className="deploy-token">
              <label>{providerLabel(provider)} token</label>
              <div className="dropdown-row">
                <input
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={`Paste your ${providerLabel(provider)} API token`}
                  value={tokenInput}
                  onChange={(e) => setTokenInput(e.target.value)}
                  disabled={busy}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && tokenInput.trim()) saveToken();
                  }}
                />
                <button className="primary" disabled={busy || !tokenInput.trim()} onClick={saveToken}>
                  Save
                </button>
              </div>
              <div className="hint-text">
                Stored encrypted via the OS keychain. The token is never returned to the
                renderer — once saved, Sight only knows “a token is configured.”
              </div>
            </div>
          )}

          {tokenOk && (
            <div className="deploy-token-ok">
              <CheckIcon size={12} /> Token configured
              <button className="ghost" disabled={busy} onClick={clearToken} title="Forget token">
                Clear
              </button>
            </div>
          )}

          {!cliOk && (
            <div className="error-text">
              The {providerLabel(provider)} CLI isn’t installed. Install{' '}
              <code>{provider === 'cloudflare' ? 'wrangler' : provider}</code>{' '}
              (<code>npm i -g {provider === 'cloudflare' ? 'wrangler' : `@${provider}/cli`}</code>)
              and make sure it’s on your PATH, then reopen this dialog.
            </div>
          )}

          {(busy || phase === 'done') && (
            <div className="publish-progress">
              {busy && <span className="mini-spinner" />}
              <span>{step}</span>
            </div>
          )}

          {phase === 'done' && result?.url && (
            <button className="repo-link" onClick={() => window.avb.openExternal(result.url)}>
              <span className="repo-slug">{result.url}</span>
              <ExternalIcon size={11} />
            </button>
          )}

          {logs.length > 0 && (
            <div ref={logRef} className="deploy-log">
              {logs.map((line, i) => (
                <div key={i} className={`deploy-log-line ${line.kind}`}>
                  {line.text}
                </div>
              ))}
            </div>
          )}

          {error && <div className="error-text">{error}</div>}
        </div>

        <div className="modal-footer">
          {phase === 'done' && result?.url ? (
            <>
              <button onClick={copyUrl}>Copy URL</button>
              <button className="primary" onClick={() => window.avb.openExternal(result.url)}>
                Open
              </button>
              <button onClick={onClose}>Close</button>
            </>
          ) : (
            <>
              <button onClick={onClose} disabled={busy}>
                Cancel
              </button>
              <button className="primary" disabled={!canStart} onClick={start}>
                {busy ? 'Working…' : `Deploy to ${providerLabel(provider)}`}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function providerLabel(p) {
  if (p === 'vercel') return 'Vercel';
  if (p === 'netlify') return 'Netlify';
  if (p === 'cloudflare') return 'Cloudflare';
  return p;
}

// Each progress entry from main becomes one or more log lines. We keep
// build output in its own channel so the user can tell them apart at a
// glance (build stdout vs deploy stderr etc.).
function formatLog(entry) {
  if (!entry) return [];
  const out = [];
  if (entry.kind === 'build') {
    const tag = entry.stream === 'closed' ? (entry.ok ? 'build ✓' : 'build ✗') : 'build';
    if (entry.stream === 'closed') {
      out.push({ kind: 'system', text: `[${tag}] build finished` });
    } else if (entry.text) {
      // Split on newlines so very long build banners don't blow up one row.
      const lines = String(entry.text).split(/\r?\n/).filter(Boolean);
      for (const l of lines) out.push({ kind: 'build', text: l });
    }
  } else if (entry.kind === 'deploy') {
    if (entry.stream === 'system') {
      out.push({ kind: 'system', text: entry.text || '' });
    } else if (entry.stream === 'closed') {
      out.push({
        kind: 'system',
        text: entry.ok ? `[deploy ✓] ${entry.url || ''}` : `[deploy ✗] ${entry.error || 'failed'}`,
      });
    } else if (entry.text) {
      const lines = String(entry.text).split(/\r?\n/).filter(Boolean);
      for (const l of lines) out.push({ kind: `deploy-${entry.stream}`, text: l });
    }
  } else if (entry.text) {
    out.push({ kind: 'system', text: String(entry.text) });
  }
  return out;
}
