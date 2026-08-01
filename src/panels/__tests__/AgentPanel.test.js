// src/panels/__tests__/AgentPanel.test.js
//
// Structural smoke test for AgentPanel. Real component rendering needs
// vitest + @testing-library/react (task 8). For now we assert:
//   1. The file exists and is syntactically loadable as ESM.
//   2. It exports a React component as default.
//   3. It imports runAgentStream from the client module.
//   4. The CSS module file exists.
//
// node:test only — no test framework dep.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const panelPath = path.resolve('src/panels/AgentPanel.jsx');
const cssPath = path.resolve('src/panels/AgentPanel.module.css');
const clientPath = path.resolve('src/agent/client.js');

test('AgentPanel.jsx exists', async () => {
  const stat = await fs.stat(panelPath);
  assert.ok(stat.isFile());
});

test('AgentPanel.module.css exists', async () => {
  const stat = await fs.stat(cssPath);
  assert.ok(stat.isFile());
});

test('AgentPanel.jsx imports runAgentStream from src/agent/client.js', async () => {
  const src = await fs.readFile(panelPath, 'utf8');
  assert.match(src, /import\s*\{\s*runAgentStream\s*\}\s*from\s*['"]\.\.\/agent\/client\.js['"]/);
});

test('AgentPanel.jsx imports buildSystemPrompt (task 5)', async () => {
  const src = await fs.readFile(panelPath, 'utf8');
  assert.match(src, /import\s*\{\s*buildSystemPrompt\s*\}\s*from\s*['"]\.\.\/agent\/systemPrompt\.js['"]/);
  assert.match(src, /buildSystemPrompt\(snapshot\)/);
});

test('AgentPanel.jsx has the expected prop surface', async () => {
  const src = await fs.readFile(panelPath, 'utf8');
  // default export is a function component
  assert.match(src, /export\s+default\s+function\s+AgentPanel/);
  // Required props from App.jsx (task 5: onApplyDiff/onRejectDiff replace onApplyPage)
  for (const prop of ['project', 'pageModel', 'selectedNodeId', 'activePagePath', 'showToast', 'onApplyDiff', 'onRejectDiff']) {
    assert.ok(src.includes(prop), `expected prop "${prop}" in AgentPanel signature or destructure`);
  }
});

test('AgentPanel.jsx renders the missing-key banner copy', async () => {
  const src = await fs.readFile(panelPath, 'utf8');
  assert.match(src, /No provider key configured/i);
  assert.match(src, /~\/\.gg\/settings\.json/);
});

test('AgentPanel.jsx wires abort button to AbortController', async () => {
  const src = await fs.readFile(panelPath, 'utf8');
  assert.match(src, /AbortController/);
  assert.match(src, /\.abort\b/);
  assert.match(src, /handleAbort|abortRef/);
});

test('AgentPanel.jsx is wired into App.jsx as a right-tab render', async () => {
  const appSrc = await fs.readFile(path.resolve('src/App.jsx'), 'utf8');
  assert.match(appSrc, /import\s+AgentPanel\s+from\s+['"]\.\/panels\/AgentPanel\.jsx['"]/);
  // The Agent tab is added to the right-rail tab list
  assert.match(appSrc, /id:\s*'agent',\s*label:\s*'Agent'/);
  // A conditional render block exists for the agent tab
  assert.match(appSrc, /rightTab\s*===\s*'agent'/);
});

test('src/agent/client.js exists (panel depends on it)', async () => {
  const stat = await fs.stat(clientPath);
  assert.ok(stat.isFile());
});
