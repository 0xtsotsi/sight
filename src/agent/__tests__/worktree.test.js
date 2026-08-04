// src/agent/__tests__/worktree.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  makeTaskId,
  makeWorktreePath,
  makeBranchName,
  readRegistry,
  writeRegistry,
  openBackgroundTask,
  getTask,
  listTasks,
  finalizeTask,
  WorktreeError,
  currentBranch,
  currentHeadSha,
  isClean,
  dirtyFiles,
  createWorktree,
  removeWorktree,
  listWorktrees,
  pruneStaleEntries,
} from '../worktree.js';

function initTempRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), 'sight-wt-'));
  execFileSync('git', ['init', '-b', 'main', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'sight@test.local'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Sight Test'], { cwd: dir });
  writeFileSync(path.join(dir, 'README.md'), 'sight worktree test\n');
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'init', '-q'], { cwd: dir });
  return dir;
}

test('worktree: makeTaskId / makeWorktreePath / makeBranchName are stable and well-formed', () => {
  const id = makeTaskId();
  assert.match(id, /^task-[0-9a-f-]+$/);
  const p = makeWorktreePath('/proj', id);
  assert.equal(p, path.join('/proj', '.sight/worktrees', id));
  const b = makeBranchName(id);
  assert.equal(b, 'sight/agent/' + id);
});

test('worktree: readRegistry on a fresh project returns an empty registry', () => {
  const dir = initTempRepo();
  const reg = readRegistry(dir);
  assert.equal(reg.schemaVersion, 1);
  assert.deepEqual(reg.tasks, []);
});

test('worktree: writeRegistry round-trips the data', () => {
  const dir = initTempRepo();
  writeRegistry(dir, { schemaVersion: 1, tasks: [{ taskId: 't1' }] });
  const reg = readRegistry(dir);
  assert.equal(reg.tasks.length, 1);
  assert.equal(reg.tasks[0].taskId, 't1');
});

test('worktree: currentBranch and currentHeadSha return the active ref', () => {
  const dir = initTempRepo();
  assert.equal(currentBranch(dir), 'main');
  assert.match(currentHeadSha(dir), /^[0-9a-f]{40}$/);
});

test('worktree: isClean returns true on a fresh repo; dirtyFiles lists uncommitted changes', () => {
  const dir = initTempRepo();
  assert.equal(isClean(dir), true);
  writeFileSync(path.join(dir, 'new.txt'), 'x');
  const dirty = dirtyFiles(dir);
  assert.ok(dirty.includes('new.txt'));
  assert.equal(isClean(dir), false);
});

test('worktree: createWorktree + removeWorktree round-trip via git', () => {
  const dir = initTempRepo();
  const head = currentHeadSha(dir);
  const taskId = makeTaskId();
  const { worktreePath, branch } = createWorktree({ projectRoot: dir, taskId, baseSha: head });
  assert.equal(branch, 'sight/agent/' + taskId);
  assert.ok(existsSync(worktreePath));
  assert.ok(existsSync(path.join(worktreePath, 'README.md')));
  const live = listWorktrees(dir);
  // macOS resolves /var/folders to /private/var/folders; compare by suffix.
  const tail = path.basename(worktreePath);
  assert.ok(live.some((w) => w.path === worktreePath || w.path.endsWith('/' + tail)), 'expected ' + worktreePath + ' in ' + JSON.stringify(live.map(w => w.path)));
  removeWorktree({ projectRoot: dir, worktreePath });
  assert.equal(existsSync(worktreePath), false);
});

test('worktree: openBackgroundTask registers the task and creates a real worktree', () => {
  const dir = initTempRepo();
  const task = openBackgroundTask({ projectRoot: dir, brief: 'redesign hero' });
  assert.match(task.taskId, /^task-/);
  assert.equal(task.branch, 'sight/agent/' + task.taskId);
  assert.equal(task.status, 'open');
  assert.deepEqual(task.dirtyFilesAtOpen, []);
  assert.ok(existsSync(task.worktreePath));
  const listed = listTasks(dir);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].taskId, task.taskId);
  assert.equal(getTask(dir, task.taskId).taskId, task.taskId);
});

test('worktree: openBackgroundTask throws WorktreeError on a bad project', () => {
  assert.throws(() => openBackgroundTask({ projectRoot: '', brief: 'x' }), WorktreeError);
  assert.throws(() => openBackgroundTask({ projectRoot: '/no/such/path', brief: 'x' }), WorktreeError);
  assert.throws(() => openBackgroundTask({ projectRoot: mkdtempSync(path.join(tmpdir(), 'sight-wt-bad-')), brief: '' }), /brief is required/);
});

test('worktree: pruneStaleEntries drops registry rows whose worktrees are gone', () => {
  const dir = initTempRepo();
  const task = openBackgroundTask({ projectRoot: dir, brief: 'x' });
  // Simulate a crash: yank the worktree without finalize.
  removeWorktree({ projectRoot: dir, worktreePath: task.worktreePath, force: true });
  execFileSync('git', ['branch', '-D', task.branch], { cwd: dir });
  const before = readRegistry(dir);
  assert.equal(before.tasks.length, 1);
  const result = pruneStaleEntries(dir);
  assert.equal(result.removed, 1);
  assert.equal(readRegistry(dir).tasks.length, 0);
});

test('worktree: finalizeTask(discard) removes the worktree and the registry row', () => {
  const dir = initTempRepo();
  const task = openBackgroundTask({ projectRoot: dir, brief: 'x' });
  const out = finalizeTask({ projectRoot: dir, taskId: task.taskId, action: 'discard' });
  assert.equal(out.ok, true);
  assert.equal(out.removed, true);
  assert.equal(readRegistry(dir).tasks.length, 0);
  assert.equal(existsSync(task.worktreePath), false);
});

test('worktree: finalizeTask(keep) marks the task as kept but does not touch the worktree', () => {
  const dir = initTempRepo();
  const task = openBackgroundTask({ projectRoot: dir, brief: 'x' });
  const out = finalizeTask({ projectRoot: dir, taskId: task.taskId, action: 'keep' });
  assert.equal(out.ok, true);
  assert.equal(getTask(dir, task.taskId).status, 'kept');
  assert.equal(existsSync(task.worktreePath), true);
});

test('worktree: finalizeTask(merge) fast-forwards the user branch and marks the task merged', () => {
  const dir = initTempRepo();
  const task = openBackgroundTask({ projectRoot: dir, brief: 'x' });
  // Make a real commit inside the worktree.
  writeFileSync(path.join(task.worktreePath, 'feature.txt'), 'hello\n');
  execFileSync('git', ['add', '-A'], { cwd: task.worktreePath });
  execFileSync('git', ['commit', '-m', 'add feature', '-q'], { cwd: task.worktreePath });
  const out = finalizeTask({ projectRoot: dir, taskId: task.taskId, action: 'merge' });
  assert.equal(out.ok, true);
  assert.equal(out.mergedInto, 'main');
  assert.equal(getTask(dir, task.taskId).status, 'merged');
  // The file is now on the user branch.
  assert.ok(existsSync(path.join(dir, 'feature.txt')));
});

test('worktree: finalizeTask with an unknown task throws WorktreeError', () => {
  const dir = initTempRepo();
  assert.throws(() => finalizeTask({ projectRoot: dir, taskId: 'nope', action: 'discard' }), /no such task/);
});

test('worktree: finalizeTask with a bad action throws WorktreeError', () => {
  const dir = initTempRepo();
  const task = openBackgroundTask({ projectRoot: dir, brief: 'x' });
  assert.throws(() => finalizeTask({ projectRoot: dir, taskId: task.taskId, action: 'bogus' }), /action must be/);
});

test('worktree: pruneStaleEntries matches worktrees across /var vs /private/var on macOS', () => {
  const dir = initTempRepo();
  const task = openBackgroundTask({ projectRoot: dir, brief: 'x' });
  // Force-remove without finalize (simulates a crash).
  removeWorktree({ projectRoot: dir, worktreePath: task.worktreePath, force: true });
  execFileSync('git', ['branch', '-D', task.branch], { cwd: dir });
  // The registry still has the row; the path is unresolved. pruneStaleEntries
  // must walk the path through realpath and fall back to basename match.
  const result = pruneStaleEntries(dir);
  assert.equal(result.removed, 1);
  assert.equal(readRegistry(dir).tasks.length, 0);
});

test('worktree: pruneStaleEntries is a no-op when nothing changed', () => {
  const dir = initTempRepo();
  const task = openBackgroundTask({ projectRoot: dir, brief: 'x' });
  const result = pruneStaleEntries(dir);
  assert.equal(result.removed, 0);
  assert.equal(readRegistry(dir).tasks.length, 1);
  // cleanup
  finalizeTask({ projectRoot: dir, taskId: task.taskId, action: 'discard' });
});
