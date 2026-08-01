// src/agent/__tests__/systemPrompt.test.js
//
// Smoke tests for buildSystemPrompt. Asserts that:
//   1. Project path is always present.
//   2. Active page path appears when supplied.
//   3. Selected node id appears when supplied.
//   4. Full pageModel is serialized (as JSON in a code block) when supplied.
//   5. The "diff-only write contract" is always emphasized.
//   6. The function handles empty/null input without throwing.
//   7. extra context (CMS snapshot etc.) is appended when passed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemPrompt } from '../systemPrompt.js';

test('buildSystemPrompt: minimal snapshot includes project path', () => {
  const out = buildSystemPrompt({ projectPath: '/proj/site' });
  assert.match(out, /You are the AI agent inside Sight/);
  assert.match(out, /Project: \/proj\/site/);
});

test('buildSystemPrompt: includes active page path when supplied', () => {
  const out = buildSystemPrompt({
    projectPath: '/proj/site',
    activePagePath: '/proj/site/src/pages/index.astro',
  });
  assert.match(out, /Active page: \/proj\/site\/src\/pages\/index\.astro/);
});

test('buildSystemPrompt: includes selected node id when supplied', () => {
  const out = buildSystemPrompt({
    projectPath: '/proj/site',
    selectedNodeId: 'c42',
  });
  assert.match(out, /Selected node id: c42/);
});

test('buildSystemPrompt: serializes pageModel as JSON in a code block', () => {
  const out = buildSystemPrompt({
    projectPath: '/proj/site',
    pageModel: { nodes: [{ id: 'a', kind: 'p' }] },
  });
  assert.match(out, /Current page model \(JSON\):/);
  assert.match(out, /```json/);
  assert.match(out, /"id": "a"/);
});

test('buildSystemPrompt: emphasizes diff-only write contract', () => {
  const out = buildSystemPrompt({ projectPath: '/proj/site' });
  assert.match(out, /apply_page_diff/);
  assert.match(out, /ONLY way to change a page/);
  assert.match(out, /Never call any direct write tool/i);
});

test('buildSystemPrompt: tolerates empty / null snapshot', () => {
  // Should not throw, should include "(none)" for project path
  const a = buildSystemPrompt(null);
  assert.match(a, /Project: \(none\)/);
  const b = buildSystemPrompt({});
  assert.match(b, /Project: \(none\)/);
});

test('buildSystemPrompt: appends extra text when supplied', () => {
  const out = buildSystemPrompt(
    { projectPath: '/proj/site' },
    'CMS snapshot: {"posts":[]}'
  );
  assert.match(out, /CMS snapshot: \{"posts":\[\]\}/);
});
