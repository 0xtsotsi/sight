// src/agent/__tests__/tools-media.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildMediaTools } from '../tools-media.js';
import { MEDIA_KIND } from '../media.js';

const CTX = (extra = {}) => ({
  projectPath: mkdtempSync(path.join(tmpdir(), 'sight-tool-')),
  selectedNodeId: null,
  activePagePath: null,
  ...extra,
});

test('tools-media: factory exposes 4 tools with the right names', () => {
  const tools = buildMediaTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['generate_image', 'generate_thumbnail', 'generate_video', 'pull_brandkit'].sort());
});

test('tools-media: every tool inputSchema is a closed object schema', () => {
  const tools = buildMediaTools();
  for (const t of tools) {
    assert.equal(t.inputSchema.type, 'object');
    assert.equal(t.inputSchema.additionalProperties, false);
  }
});

test('tools-media: generate_image returns an approval_required envelope on first call', async () => {
  const [tool] = buildMediaTools().filter((t) => t.name === 'generate_image');
  const r = await tool.handler({ prompt: 'a hero image' }, CTX());
  assert.equal(r.schemaVersion, 1);
  assert.equal(r.status, 'approval_required');
  assert.equal(r.tool, 'generate_image');
  assert.equal(r.decision.required, true);
  assert.equal(r.decision.rememberable, false);
  assert.ok(r.approvalHash);
  assert.ok(r.requestId);
});

test('tools-media: generate_video returns an approval_required envelope', async () => {
  const [tool] = buildMediaTools().filter((t) => t.name === 'generate_video');
  const r = await tool.handler({ prompt: 'launch reel' }, CTX());
  assert.equal(r.status, 'approval_required');
  assert.equal(r.tool, 'generate_video');
});

test('tools-media: generate_thumbnail requires topic', async () => {
  const [tool] = buildMediaTools().filter((t) => t.name === 'generate_thumbnail');
  await assert.rejects(() => tool.handler({ prompt: 'a cover' }, CTX()), /topic/i);
});

test('tools-media: pull_brandkit returns an approval_required envelope', async () => {
  const [tool] = buildMediaTools().filter((t) => t.name === 'pull_brandkit');
  const r = await tool.handler({ name: 'Acme Co' }, CTX());
  assert.equal(r.status, 'approval_required');
  assert.equal(r.tool, 'pull_brandkit');
});

test('tools-media: missing projectPath in ctx throws via zod snapshot', async () => {
  const [tool] = buildMediaTools().filter((t) => t.name === 'generate_image');
  await assert.rejects(() => tool.handler({ prompt: 'x' }, { selectedNodeId: 's' }), /projectPath/i);
});
