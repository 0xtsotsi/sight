// src/agent/__tests__/tools-orchestrator.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildOrchestratorTools } from '../tools-orchestrator.js';

const CTX = (extra = {}) => ({
  projectPath: mkdtempSync(path.join(tmpdir(), 'sight-orch-')),
  selectedNodeId: null,
  activePagePath: null,
  ...extra,
});

function setHost(stub) {
  globalThis.window = { avb: stub };
  return () => { delete globalThis.window; };
}

test('orchestrator: factory exposes 5 tools with the right names', () => {
  const tools = buildOrchestratorTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    'capture_evidence',
    'finalize_background_task',
    'list_background_tasks',
    'open_background_task',
    'run_live_review',
  ].sort());
});

test('orchestrator: every tool inputSchema is a closed object schema', () => {
  const tools = buildOrchestratorTools();
  for (const t of tools) {
    assert.equal(t.inputSchema.type, 'object');
    assert.equal(t.inputSchema.additionalProperties, false);
  }
});

test('orchestrator: capture_evidence is PROPOSE and never needs approval; returns an unavailable envelope when the IPC verb is missing', async () => {
  const restore = setHost({});
  try {
    const [tool] = buildOrchestratorTools().filter((t) => t.name === 'capture_evidence');
    const r = await tool.handler({ url: 'https://example.com', kind: 'before' }, CTX());
    assert.equal(r.status, 'unavailable');
    assert.equal(r.reason, 'agent:captureEvidence is not available on this host');
  } finally { restore(); }
});

test('orchestrator: capture_evidence returns an ok envelope with a dataUrl when the IPC verb succeeds', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
  const restore = setHost({ agentCaptureEvidence: async () => ({ ok: true, kind: 'before', path: '/tmp/x.png', width: 320, height: 200, bytes: png.length, dataUrl: 'data:image/png;base64,' + png.toString('base64') }) });
  try {
    const [tool] = buildOrchestratorTools().filter((t) => t.name === 'capture_evidence');
    const r = await tool.handler({ url: 'https://example.com', kind: 'before' }, CTX());
    assert.equal(r.status, 'ok');
    assert.equal(r.kind, 'image');
    assert.match(r.dataUrl, /^data:image\/png;base64,/);
  } finally { restore(); }
});

test('orchestrator: open_background_task returns an approval_required envelope', async () => {
  const restore = setHost({});
  try {
    const [tool] = buildOrchestratorTools().filter((t) => t.name === 'open_background_task');
    const r = await tool.handler({ brief: 'redesign hero' }, CTX());
    assert.equal(r.status, 'approval_required');
    assert.equal(r.tool, 'open_background_task');
  } finally { restore(); }
});

test('orchestrator: finalize_background_task returns an approval_required envelope', async () => {
  const restore = setHost({});
  try {
    const [tool] = buildOrchestratorTools().filter((t) => t.name === 'finalize_background_task');
    const r = await tool.handler({ taskId: 'task-1', action: 'discard' }, CTX());
    assert.equal(r.status, 'approval_required');
  } finally { restore(); }
});

test('orchestrator: list_background_tasks is read-only and never requires approval', async () => {
  const restore = setHost({ agentListBackgroundTasks: async () => ({ ok: true, tasks: [] }) });
  try {
    const [tool] = buildOrchestratorTools().filter((t) => t.name === 'list_background_tasks');
    const r = await tool.handler({}, CTX());
    assert.equal(r.status, 'ok');
    assert.deepEqual(r.tasks, []);
  } finally { restore(); }
});

test('orchestrator: run_live_review is read-only and returns a review_requested envelope', async () => {
  const restore = setHost({});
  try {
    const [tool] = buildOrchestratorTools().filter((t) => t.name === 'run_live_review');
    const r = await tool.handler({ brief: 'a hero redesign', diffSummary: 'add 3 sections' }, CTX());
    assert.equal(r.status, 'review_requested');
    assert.equal(r.reviewer, 'separate-context');
  } finally { restore(); }
});

test('orchestrator: capture_evidence returns an unavailable envelope when the IPC verb is missing (alias)', async () => {
  // Already covered by the test above. Kept for symmetry with the other
  // tools that need approval.
  const restore = setHost({});
  try {
    const [tool] = buildOrchestratorTools().filter((t) => t.name === 'capture_evidence');
    const r = await tool.handler({ url: 'https://example.com' }, CTX());
    assert.equal(r.status, 'unavailable');
  } finally { restore(); }
});
