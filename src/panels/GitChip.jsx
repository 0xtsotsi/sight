import React, { useEffect, useRef, useState } from 'react';
import { cleanError } from '../App.jsx';
import { BranchIcon, CheckIcon } from '../ui/Icons.jsx';

// Branch/status chip in the title bar. Opens a dropdown with branch
// switching, branch creation, commit + push, and GitHub publishing.
export default function GitChip({ project, showToast, flushSave }) {
  const [info, setInfo] = useState(null);
  const [open, setOpen] = useState(false);
  const [commitMsg, setCommitMsg] = useState('');
  const [newBranch, setNewBranch] = useState('');
  const [working, setWorking] = useState(false);
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

  const act = async (fn, successMsg) => {
    setWorking(true);
    try {
      await flushSave();
      await fn();
      await refresh();
      if (successMsg) showToast(successMsg, 'success');
    } catch (err) {
      showToast(cleanError(err), 'error');
    }
    setWorking(false);
  };

  if (!info) return null;

  if (!info.isRepo) {
    return (
      <button
        className="git-chip"
        disabled={working}
        onClick={() =>
          act(() => window.avb.gitInit(project.path), 'Initialized git repository')
        }
      >
        Initialize Git
      </button>
    );
  }

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <button className="git-chip" onClick={() => setOpen((o) => !o) || refresh()}>
        <BranchIcon size={12} />
        <span className={`dot ${info.dirty ? 'dirty' : ''}`} />
        {info.branch}
        {info.ahead > 0 && <span style={{ color: 'var(--text-faint)' }}>↑{info.ahead}</span>}
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
                  `Switched to ${b}`
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
                  act(
                    () =>
                      window.avb.gitCheckout({
                        projectPath: project.path,
                        branch: newBranch.trim(),
                        create: true,
                      }),
                    `Created branch ${newBranch.trim()}`
                  );
                  setNewBranch('');
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
            />
            <button
              disabled={working || !info.dirty}
              onClick={() =>
                act(
                  () =>
                    window.avb.gitCommit({
                      projectPath: project.path,
                      message: commitMsg.trim() || 'Update from Stacki',
                    }),
                  'Changes committed'
                ) && setCommitMsg('')
              }
            >
              {info.dirty ? 'Commit all changes' : 'Nothing to commit'}
            </button>
          </div>

          <div className="divider" />
          <h3>GitHub</h3>
          <div className="dropdown-row" style={{ flexDirection: 'column', gap: 6 }}>
            {info.remote ? (
              <>
                <div style={{ fontSize: 11, color: 'var(--text-faint)', wordBreak: 'break-all' }}>
                  {info.remote}
                </div>
                <button
                  className="primary"
                  disabled={working}
                  onClick={() =>
                    act(
                      () =>
                        window.avb.gitPush({ projectPath: project.path, branch: info.branch }),
                      `Pushed ${info.branch} to origin`
                    )
                  }
                >
                  {working ? 'Working…' : `Push ${info.branch}`}
                </button>
              </>
            ) : (
              <button className="primary" disabled={working} onClick={() => setShowPublish(true)}>
                Publish to GitHub…
              </button>
            )}
          </div>
        </div>
      )}

      {showPublish && (
        <PublishModal
          defaultName={project.name}
          onClose={() => setShowPublish(false)}
          onPublish={(repoName, isPrivate) => {
            setShowPublish(false);
            act(async () => {
              const gitState = await refresh();
              if (gitState.dirty || gitState.branch === '(no commits yet)') {
                await window.avb.gitCommit({
                  projectPath: project.path,
                  message: 'Initial commit from Stacki',
                });
              }
              await window.avb.gitPublish({ projectPath: project.path, repoName, isPrivate });
            }, 'Published to GitHub');
          }}
        />
      )}
    </div>
  );
}

function PublishModal({ defaultName, onClose, onPublish }) {
  const [name, setName] = useState(
    defaultName.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '')
  );
  const [isPrivate, setIsPrivate] = useState(true);

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-header">Publish to GitHub</div>
        <div className="modal-body">
          <div>
            <label>Repository name</label>
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              id="pub-private"
              type="checkbox"
              checked={isPrivate}
              onChange={(e) => setIsPrivate(e.target.checked)}
            />
            <label htmlFor="pub-private" style={{ margin: 0 }}>
              Private repository
            </label>
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>
            Uses the GitHub CLI (gh). Commits any pending changes, creates the repo, and
            pushes the current branch.
          </div>
        </div>
        <div className="modal-footer">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!name.trim()} onClick={() => onPublish(name.trim(), isPrivate)}>
            Publish
          </button>
        </div>
      </div>
    </div>
  );
}
