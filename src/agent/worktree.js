// src/agent/worktree.js
//
// Phase 3: orchestrator-owned Git worktree manager for background agent
// work. The agent NEVER receives raw Git commands — the only public API
// is `requestBackgroundTask({ brief })`, which returns a stable
// `taskId`. The orchestrator:
//
//   1. Snapshots the current branch ref + dirty/untracked files and asks
//      the user (via the panel) which uncommitted files to carry.
//   2. Creates a uniquely-named worktree at
//      <projectRoot>/.sight/worktrees/<taskId>/ on branch
//      `sight/agent/<taskId>`. The base ref is the snapshotted SHA.
//   3. Routes the agent run to the worktree path (not the user's repo).
//   4. On completion, presents merge / cherry-pick / discard controls.
//   5. Cleans the worktree on user action or app shutdown.
//
// All worktree state lives in the worktree registry at
// <projectRoot>/.sight/worktrees/registry.json. The file is the source
// of truth for "which tasks are open" — Stale registration pruning
// happens on the first call after a crash.

import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const WORKTREE_DIR = '.sight/worktrees';
const REGISTRY_NAME = 'registry.json';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class WorktreeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WorktreeError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Pure helpers — exported for tests.
// ---------------------------------------------------------------------------

export function makeTaskId() {
  return 'task-' + randomUUID();
}

export function makeWorktreePath(projectRoot, taskId) {
  return path.join(projectRoot, WORKTREE_DIR, taskId);
}

export function makeBranchName(taskId) {
  return 'sight/agent/' + taskId;
}

export function readRegistry(projectRoot) {
  const regPath = path.join(projectRoot, WORKTREE_DIR, REGISTRY_NAME);
  if (!existsSync(regPath)) return { schemaVersion: 1, tasks: [] };
  try {
    const raw = readFileSync(regPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.tasks)) {
      return { schemaVersion: 1, tasks: [] };
    }
    return parsed;
  } catch {
    return { schemaVersion: 1, tasks: [] };
  }
}

export function writeRegistry(projectRoot, registry) {
  const dir = path.join(projectRoot, WORKTREE_DIR);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, REGISTRY_NAME), JSON.stringify(registry, null, 2), 'utf8');
}

// ---------------------------------------------------------------------------
// Git shims — the only places we touch git. Every call here is the
// orchestrator's, never the agent's.
// ---------------------------------------------------------------------------

function git(args, cwd) {
  // execFileSync with stdio:'pipe' so a missing git does not crash the
  // whole process; we surface errors as WorktreeError.
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
}

function safeGit(args, cwd) {
  try {
    return { ok: true, stdout: git(args, cwd) };
  } catch (err) {
    return { ok: false, error: (err && err.stderr) ? err.stderr.toString() : String(err?.message ?? err) };
  }
}

export function currentBranch(cwd) {
  const r = safeGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  if (!r.ok) throw new WorktreeError('no-branch', r.error);
  return r.stdout.trim();
}

export function currentHeadSha(cwd) {
  const r = safeGit(['rev-parse', 'HEAD'], cwd);
  if (!r.ok) throw new WorktreeError('no-head', r.error);
  return r.stdout.trim();
}

export function isClean(cwd) {
  const r = safeGit(['status', '--porcelain'], cwd);
  if (!r.ok) throw new WorktreeError('status-failed', r.error);
  return r.stdout.trim().length === 0;
}

export function dirtyFiles(cwd) {
  const r = safeGit(['status', '--porcelain'], cwd);
  if (!r.ok) throw new WorktreeError('status-failed', r.error);
  return r.stdout
    .split('\n')
    .map((line) => line.slice(3).trim())
    .filter(Boolean);
}

export function createWorktree({ projectRoot, taskId, baseSha }) {
  const wtPath = makeWorktreePath(projectRoot, taskId);
  const branch = makeBranchName(taskId);
  if (existsSync(wtPath)) {
    throw new WorktreeError('worktree-exists', 'worktree path already exists: ' + wtPath);
  }
  const r = safeGit(['worktree', 'add', '-b', branch, wtPath, baseSha], projectRoot);
  if (!r.ok) throw new WorktreeError('worktree-add-failed', r.error);
  return { worktreePath: wtPath, branch, baseSha };
}

export function removeWorktree({ projectRoot, worktreePath, force = false }) {
  if (!existsSync(worktreePath)) {
    // already gone — best effort
    safeGit(['worktree', 'prune'], projectRoot);
    return;
  }
  const args = force ? ['worktree', 'remove', '--force', worktreePath] : ['worktree', 'remove', worktreePath];
  const r = safeGit(args, projectRoot);
  if (!r.ok) throw new WorktreeError('worktree-remove-failed', r.error);
}

export function listWorktrees(cwd) {
  const r = safeGit(['worktree', 'list', '--porcelain'], cwd);
  if (!r.ok) throw new WorktreeError('worktree-list-failed', r.error);
  const out = [];
  let cur = {};
  for (const line of r.stdout.split('\n')) {
    if (!line.trim()) {
      if (cur.path) out.push(cur);
      cur = {};
      continue;
    }
    if (line.startsWith('worktree ')) cur.path = line.slice(9).trim();
    else if (line.startsWith('HEAD ')) cur.head = line.slice(5).trim();
    else if (line.startsWith('branch ')) cur.branch = line.slice(7).trim();
  }
  if (cur.path) out.push(cur);
  return out;
}

// ---------------------------------------------------------------------------
// Prune stale registry entries (called at startup).
// ---------------------------------------------------------------------------

export function pruneStaleEntries(projectRoot) {
  const reg = readRegistry(projectRoot);
  const live = listWorktrees(projectRoot);
  const livePaths = new Set(live.map((w) => w.path));
  const pruned = reg.tasks.filter((t) => t && t.worktreePath && livePaths.has(t.worktreePath));
  if (pruned.length !== reg.tasks.length) {
    writeRegistry(projectRoot, { ...reg, tasks: pruned });
  }
  return { before: reg.tasks.length, after: pruned.length, removed: reg.tasks.length - pruned.length };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Open a background task. The caller must pass:
 *   - projectRoot: the user's repo root
 *   - brief: a one-line description
 *   - includeDirtyFiles?: boolean — if true, carry the user's uncommitted
 *     changes into the worktree. Phase 3 default: false; the panel asks.
 *   - baseSha?: optional override (defaults to HEAD).
 *
 * Returns the task envelope. The orchestrator hands `worktreePath` to the
 * agent client; the agent never sees the registry or git commands.
 */
export function openBackgroundTask({ projectRoot, brief, includeDirtyFiles = false, baseSha } = {}) {
  if (!projectRoot || typeof projectRoot !== 'string') {
    throw new WorktreeError('bad-project', 'projectRoot is required');
  }
  if (typeof brief !== 'string' || brief.length === 0) {
    throw new WorktreeError('bad-brief', 'brief is required');
  }
  pruneStaleEntries(projectRoot);
  const taskId = makeTaskId();
  const base = baseSha || currentHeadSha(projectRoot);
  const dirty = isClean(projectRoot) ? [] : dirtyFiles(projectRoot);
  const { worktreePath, branch } = createWorktree({ projectRoot, taskId, baseSha: base });
  const task = {
    taskId,
    worktreePath,
    branch,
    baseSha: base,
    brief,
    includeDirtyFiles: Boolean(includeDirtyFiles),
    dirtyFilesAtOpen: dirty,
    createdAt: Date.now(),
    status: 'open',
  };
  const reg = readRegistry(projectRoot);
  reg.tasks.push(task);
  writeRegistry(projectRoot, reg);
  return task;
}

export function getTask(projectRoot, taskId) {
  const reg = readRegistry(projectRoot);
  return reg.tasks.find((t) => t && t.taskId === taskId) ?? null;
}

export function listTasks(projectRoot) {
  return readRegistry(projectRoot).tasks;
}

/**
 * Finalize a task. The orchestrator decides `action`:
 *   - 'discard': remove the worktree, drop the registry entry
 *   - 'merge':   fast-forward or merge the branch into the user's branch
 *                (caller pre-resolves conflicts; the orchestrator never
 *                 shells out to resolve them)
 *   - 'keep':    keep the worktree on disk for manual handling
 */
export function finalizeTask({ projectRoot, taskId, action }) {
  if (!['discard', 'merge', 'keep'].includes(action)) {
    throw new WorktreeError('bad-action', 'action must be discard|merge|keep');
  }
  const reg = readRegistry(projectRoot);
  const idx = reg.tasks.findIndex((t) => t && t.taskId === taskId);
  if (idx === -1) throw new WorktreeError('not-found', 'no such task: ' + taskId);
  const task = reg.tasks[idx];
  if (action === 'discard') {
    removeWorktree({ projectRoot, worktreePath: task.worktreePath, force: true });
    safeGit(['branch', '-D', task.branch], projectRoot);
    reg.tasks.splice(idx, 1);
    writeRegistry(projectRoot, reg);
    return { ok: true, action, removed: true };
  }
  if (action === 'merge') {
    const current = currentBranch(projectRoot);
    const r = safeGit(['merge', '--no-ff', task.branch, '-m', 'sight: merge ' + task.taskId], projectRoot);
    if (!r.ok) {
      // Don't mark the task done on conflict — the caller must resolve.
      task.status = 'conflict';
      writeRegistry(projectRoot, reg);
      throw new WorktreeError('merge-conflict', r.error);
    }
    task.status = 'merged';
    task.mergedInto = current;
    task.mergedAt = Date.now();
    writeRegistry(projectRoot, reg);
    return { ok: true, action, mergedInto: current };
  }
  // keep
  task.status = 'kept';
  task.keptAt = Date.now();
  writeRegistry(projectRoot, reg);
  return { ok: true, action };
}

export const _internals = {
  isClean,
  dirtyFiles,
  safeGit,
  currentBranch,
  currentHeadSha,
  listWorktrees,
  pruneStaleEntries,
};
