import React, { useEffect, useRef, useState } from 'react';
import { cleanError } from '../App.jsx';
import { BranchIcon, CheckIcon, ExternalIcon } from '../ui/Icons.jsx';

// owner/repo out of any GitHub remote form (https or ssh), for display.
const repoSlug = (url) => {
  const m = String(url || '').match(/github\.com[:/]+([^/]+\/[^/]+?)(?:\.git)?$/i);
  return m ? m[1] : url;
};
const webUrl = (url) => {
  const slug = repoSlug(url);
  return slug && slug !== url ? `https://github.com/${slug}` : url;
};

// Branch/status chip in the title bar. Opens a dropdown with branch
// switching, branch creation, commit + push, and GitHub publishing.
export default function GitChip({ project, showToast, flushSave }) {
  const [info, setInfo] = useState(null);
  const [open, setOpen] = useState(false);
  const [commitMsg, setCommitMsg] = useState('');
  const [newBranch, setNewBranch] = useState('');
  // Label of the action in flight, or null. Doubles as the busy flag so the
  // chip itself can say what it's doing while the dropdown is closed.
  const [busy, setBusy] = useState(null);
  const working = busy !== null;
  const [showPublish, setShowPublish] = useState(false);
  const wrapRef = useRef(null);

  const refresh = async () => {
    const result = await window.avb.gitInfo(project.path);
    setInfo(result);
    return result;
  };

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 15000);
    return () => clearInterval(t);
  }, [project.path]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onDown = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  const act = async (fn, successMsg, label = 'Working…') => {
    setBusy(label);
    try {
      await flushSave();
      await fn();
      await refresh();
      if (successMsg) showToast(successMsg, 'success');
    } catch (err) {
      showToast(cleanError(err), 'error');
    }
    setBusy(null);
  };

  // Publishing is driven from the modal so it can show each step and keep the
  // form (and any error) in place instead of closing on a fire-and-forget.
  const publish = async ({ repoName, isPrivate, onStep }) => {
    setBusy('Publishing…');
    try {
      await flushSave();
      const state = await refresh();
      if (state.dirty || state.branch === '(no commits yet)') {
        onStep('Committing changes…');
        await window.avb.gitCommit({
          projectPath: project.path,
          message: 'Initial commit from Stacki',
        });
      }
      onStep('Creating repository and pushing…');
      const res = await window.avb.gitPublish({
        projectPath: project.path,
        repoName,
        isPrivate,
      });
      await refresh();
      return res?.url || null;
    } finally {
      setBusy(null);
    }
  };

  if (!info) return null;

  if (!info.isRepo) {
    return (
      <button
        className="git-chip"
        disabled={working}
        onClick={() =>
          act(
            () => window.avb.gitInit(project.path),
            'Initialized git repository',
            'Initializing…'
          )
        }
      >
        {working ? <span className="mini-spinner" /> : <BranchIcon size={12} />}
        {working ? busy : 'Initialize Git'}
      </button>
    );
  }

  const commit = () => {
    const message = commitMsg.trim() || 'Update from Stacki';
    setCommitMsg('');
    act(
      () => window.avb.gitCommit({ projectPath: project.path, message }),
      'Changes committed',
      'Committing…'
    );
  };

  // Three distinct states, because "0 commits ahead" and "never pushed" mean
  // very different things — see hasUpstream in git:info.
  const pushLabel = !info.hasUpstream
    ? `Push ${info.branch} to origin`
    : info.ahead > 0
      ? `Push ${info.ahead} commit${info.ahead === 1 ? '' : 's'}`
      : 'Everything pushed';
  const canPush = info.hasUpstream ? info.ahead > 0 : true;

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <button
        className={`git-chip ${working ? 'busy' : ''}`}
        onClick={() => {
          setOpen((o) => !o);
          refresh();
        }}
      >
        {working ? (
          <>
            <span className="mini-spinner" />
            {busy}
          </>
        ) : (
          <>
            <BranchIcon size={12} />
            <span className={`dot ${info.dirty ? 'dirty' : ''}`} />
            {info.branch}
            {info.ahead > 0 && <span style={{ color: 'var(--text-faint)' }}>↑{info.ahead}</span>}
          </>
        )}
      </button>

      {open && (
        <div className="dropdown">
          <h3>Branches</h3>
          {info.branches.map((b) => (
            <div
              key={b}
              className={`list-item ${b === info.branch ? 'active' : ''}`}
              onClick={() =>
                b !== info.branch &&
                act(
                  () => window.avb.gitCheckout({ projectPath: project.path, branch: b }),
                  `Switched to ${b}`,
                  'Switching…'
                )
              }
            >
              <span className="icon" style={{ width: 14 }}>
                {b === info.branch ? <CheckIcon size={12} /> : null}
              </span>
              <span className="label">{b}</span>
            </div>
          ))}
          <div className="dropdown-row">
            <input
              placeholder="new-branch-name"
              value={newBranch}
              onChange={(e) => setNewBranch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && newBranch.trim()) {
                  const name = newBranch.trim();
                  setNewBranch('');
                  act(
                    () =>
                      window.avb.gitCheckout({
                        projectPath: project.path,
                        branch: name,
                        create: true,
                      }),
                    `Created branch ${name}`,
                    'Creating branch…'
                  );
                }
              }}
            />
          </div>

          <div className="divider" />
          <h3>Commit</h3>
          <div className="dropdown-row" style={{ flexDirection: 'column', gap: 6 }}>
            <input
              placeholder="Commit message"
              value={commitMsg}
              onChange={(e) => setCommitMsg(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && info.dirty && !working) commit();
              }}
            />
            <button disabled={working || !info.dirty} onClick={commit}>
              {info.dirty ? 'Commit all changes' : 'Nothing to commit'}
            </button>
          </div>

          <div className="divider" />
          <h3>GitHub</h3>
          <div className="dropdown-row" style={{ flexDirection: 'column', gap: 6 }}>
            {info.remote ? (
              <>
                <button
                  className="repo-link"
                  title={`Open ${repoSlug(info.remote)} on GitHub`}
                  onClick={() => window.avb.openExternal(webUrl(info.remote))}
                >
                  <span className="repo-slug">{repoSlug(info.remote)}</span>
                  <ExternalIcon size={11} />
                </button>
                <button
                  className="primary"
                  disabled={working || !canPush}
                  onClick={() =>
                    act(
                      () =>
                        window.avb.gitPush({ projectPath: project.path, branch: info.branch }),
                      `Pushed ${info.branch} to origin`,
                      'Pushing…'
                    )
                  }
                >
                  {pushLabel}
                </button>
                {info.dirty && (
                  <div className="hint-text">
                    You have uncommitted changes — commit them first to include them.
                  </div>
                )}
              </>
            ) : (
              <>
                <div className="hint-text">
                  This project isn’t on GitHub yet.
                </div>
                <button
                  className="primary"
                  disabled={working}
                  onClick={() => {
                    setOpen(false);
                    setShowPublish(true);
                  }}
                >
                  Publish to GitHub…
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {showPublish && (
        <PublishModal
          defaultName={project.name}
          branch={info.branch}
          onClose={() => setShowPublish(false)}
          onPublish={publish}
          openExternal={(u) => window.avb.openExternal(u)}
        />
      )}
    </div>
  );
}

function PublishModal({ defaultName, branch, onClose, onPublish, openExternal }) {
  const [name, setName] = useState(
    defaultName.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '')
  );
  const [isPrivate, setIsPrivate] = useState(true);
  const [gh, setGh] = useState(null); // null = still checking
  const [phase, setPhase] = useState('form'); // form | publishing | done
  const [step, setStep] = useState('');
  const [error, setError] = useState(null);
  const [url, setUrl] = useState(null);

  // Preflight, so a missing or logged-out gh is visible before the user
  // bothers filling anything in.
  useEffect(() => {
    let alive = true;
    window.avb
      .ghStatus()
      .then((s) => alive && setGh(s))
      .catch(() => alive && setGh({ installed: false, authed: false }));
    return () => {
      alive = false;
    };
  }, []);

  const publishing = phase === 'publishing';
  const ready = gh?.installed && gh?.authed;

  const go = async () => {
    setError(null);
    setPhase('publishing');
    setStep('Preparing…');
    try {
      const result = await onPublish({
        repoName: name.trim(),
        isPrivate,
        onStep: setStep,
      });
      setUrl(result);
      setPhase('done');
    } catch (err) {
      setError(cleanError(err));
      setPhase('form'); // keep the form filled in so it can be retried
    }
  };

  return (
    <div
      className="modal-overlay"
      onMouseDown={(e) => e.target === e.currentTarget && !publishing && onClose()}
    >
      <div className="modal">
        <div className="modal-header">
          {phase === 'done' ? 'Published to GitHub' : 'Publish to GitHub'}
        </div>

        {phase === 'done' ? (
          <>
            <div className="modal-body">
              <div className="publish-done">
                <CheckIcon size={14} />
                <span>
                  {name} is on GitHub and <strong>{branch}</strong> has been pushed.
                </span>
              </div>
              {url && (
                <button className="repo-link" onClick={() => openExternal(url)}>
                  <span className="repo-slug">{repoSlug(url)}</span>
                  <ExternalIcon size={11} />
                </button>
              )}
            </div>
            <div className="modal-footer">
              <button className="primary" onClick={onClose}>
                Done
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="modal-body">
              <div>
                <label>Repository name</label>
                <input
                  autoFocus
                  value={name}
                  disabled={publishing}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && name.trim() && ready && !publishing) go();
                  }}
                />
              </div>

              <label className="check-row">
                <input
                  type="checkbox"
                  checked={isPrivate}
                  disabled={publishing}
                  onChange={(e) => setIsPrivate(e.target.checked)}
                />
                Private repository
              </label>

              {gh === null && <div className="hint-text">Checking GitHub CLI…</div>}

              {gh && !gh.installed && (
                <div className="error-text">
                  GitHub CLI (gh) isn’t installed. Install it from cli.github.com, then run
                  {' '}<code>gh auth login</code>.
                </div>
              )}
              {gh?.installed && !gh.authed && (
                <div className="error-text">
                  GitHub CLI isn’t signed in. Run <code>gh auth login</code> in a terminal,
                  then reopen this dialog.
                </div>
              )}
              {ready && !publishing && !error && (
                <div className="hint-text">
                  Commits any pending changes, creates the repo as{' '}
                  {isPrivate ? 'private' : 'public'}, and pushes <strong>{branch}</strong>
                  {gh.user ? ` to ${gh.user}` : ''}.
                </div>
              )}

              {publishing && (
                <div className="publish-progress">
                  <span className="mini-spinner" />
                  <span>{step}</span>
                </div>
              )}

              {error && <div className="error-text">{error}</div>}
            </div>

            <div className="modal-footer">
              <button onClick={onClose} disabled={publishing}>
                Cancel
              </button>
              <button
                className="primary"
                disabled={!name.trim() || !ready || publishing}
                onClick={go}
              >
                {publishing ? 'Publishing…' : error ? 'Try again' : 'Publish'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
