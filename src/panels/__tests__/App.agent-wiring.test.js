// src/panels/__tests__/App.agent-wiring.test.js
//
// Asserts that App.jsx wires AgentPanel's onApplyDiff through the same
// mutateModel path that human edits use. We can't run App.jsx (it would
// need a full renderer + electron mock), so this is a structural test
// against the JSX source.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const appPath = path.resolve('src/App.jsx');

test('App.jsx exists', async () => {
  const stat = await fs.stat(appPath);
  assert.ok(stat.isFile());
});

test('App.jsx onApplyDiff dispatches through mutateModel (reducer path)', async () => {
  const src = await fs.readFile(appPath, 'utf8');
  // The onApplyDiff prop is wired and calls mutateModel with the new model.
  // Look for the onApplyDiff arrow function and assert it mentions mutateModel.
  const match = src.match(/onApplyDiff=\{?\s*\(([^)]+)\)\s*=>\s*\{([\s\S]*?)\}\s*\}/);
  assert.ok(match, 'expected onApplyDiff prop wiring in App.jsx');
  assert.match(match[2], /mutateModel/, 'onApplyDiff must call mutateModel for undo/redo');
  // The model passed in must be diff.afterJson (so the reducer applies the new state).
  assert.match(match[2], /diff\.afterJson/);
  // Save must be immediate (no debounce on agent edits).
  assert.match(match[2], /mutateModel\(.+,\s*true/);
});

test('App.jsx onApplyDiff sets selection to first added node', async () => {
  const src = await fs.readFile(appPath, 'utf8');
  // Should call setSelectedId with the diff's first added node id.
  assert.match(src, /setSelectedId\(firstAdded\.id\)/);
});

test('App.jsx onApplyDiff validates the diff targets the active page', async () => {
  const src = await fs.readFile(appPath, 'utf8');
  assert.match(src, /diff\.path\s*!==\s*currentPage\.path/);
});
