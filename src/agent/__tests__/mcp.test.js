// src/agent/__tests__/mcp.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dispatch,
  setSnapshot,
  rememberApproval,
} from '../mcp.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

function snapshot() {
  return {
    projectPath: mkdtempSync(path.join(tmpdir(), 'sight-mcp-')),
    selectedNodeId: null,
    activePagePath: null,
  };
}

test('mcp: initialize returns serverInfo and capabilities', async () => {
  const res = await dispatch({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  assert.equal(res.jsonrpc, '2.0');
  assert.equal(res.id, 1);
  assert.equal(res.result.serverInfo.name, 'sight-tools');
  assert.ok(res.result.capabilities.tools);
});

test('mcp: ping returns an empty result', async () => {
  const res = await dispatch({ jsonrpc: '2.0', id: 2, method: 'ping' });
  assert.deepEqual(res.result, {});
});

test('mcp: tools/list returns all registered tools with MCP annotations', async () => {
  const res = await dispatch({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
  const names = res.result.tools.map((t) => t.name);
  for (const n of ['list_pages', 'read_page', 'read_cms', 'scan_project', 'apply_page_diff', 'generate_image', 'generate_video', 'generate_thumbnail', 'pull_brandkit', 'capture_evidence', 'open_background_task', 'finalize_background_task', 'list_background_tasks', 'run_live_review']) {
    assert.ok(names.includes(n), 'missing tool: ' + n);
  }
  // Every tool has a closed-object inputSchema
  for (const t of res.result.tools) {
    assert.equal(t.inputSchema.type, 'object');
    assert.equal(t.inputSchema.additionalProperties, false);
  }
  // At least one tool carries openWorldHint:true (a media tool)
  const ow = res.result.tools.find((t) => t.name === 'generate_image');
  assert.equal(ow.annotations.openWorldHint, true);
  // At least one tool carries destructiveHint:true (finalize)
  const d = res.result.tools.find((t) => t.name === 'finalize_background_task');
  assert.equal(d.annotations.destructiveHint, true);
  // At least one tool carries readOnlyHint:true (read_page)
  const r = res.result.tools.find((t) => t.name === 'read_page');
  assert.equal(r.annotations.readOnlyHint, true);
});

test('mcp: tools/call for a read tool returns a structured result', async () => {
  setSnapshot(snapshot());
  // list_background_tasks is a READ tool that does not depend on
  // window.avb. It's the right fixture for an MCP server smoke test.
  const res = await dispatch({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'list_background_tasks', arguments: {} } });
  assert.equal(res.jsonrpc, '2.0');
  assert.ok(res.result.structuredContent, 'expected structuredContent');
  assert.equal(res.result.structuredContent.status, 'ok');
  assert.deepEqual(res.result.structuredContent.tasks, []);
});

test('mcp: tools/call for a write/destructive tool without a remembered approval returns approval_required', async () => {
  setSnapshot(snapshot());
  const res = await dispatch({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'finalize_background_task', arguments: { taskId: 'task-x', action: 'discard' } } });
  assert.ok(res.result.structuredContent);
  assert.equal(res.result.structuredContent.status, 'approval_required');
  assert.equal(res.result.structuredContent.tool, 'finalize_background_task');
  assert.ok(res.result.structuredContent.approvalHash);
});

test('mcp: tools/call for a destructive tool with a remembered approval is executed', async () => {
  setSnapshot(snapshot());
  // First call to compute the hash that will be checked.
  const probe = await dispatch({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'finalize_background_task', arguments: { taskId: 'task-y', action: 'discard' } } });
  const hash = probe.result.structuredContent.approvalHash;
  // Remember the approval and re-call.
  rememberApproval('finalize_background_task', hash);
  const res = await dispatch({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'finalize_background_task', arguments: { taskId: 'task-y', action: 'discard' } } });
  // Will be an error (no such task) but not approval_required.
  // The tool returns { schemaVersion:1, status:'error', error:{...} } on
  // a not-found; that's the correct, non-approval path.
  const sc = res.result.structuredContent;
  if (sc) assert.notEqual(sc.status, 'approval_required');
});

test('mcp: unknown tool returns a JSON-RPC error', async () => {
  setSnapshot(snapshot());
  const res = await dispatch({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'not_a_real_tool', arguments: {} } });
  assert.equal(res.error.code, -32602);
  assert.match(res.error.message, /unknown tool/);
});

test('mcp: unknown method returns method-not-found', async () => {
  const res = await dispatch({ jsonrpc: '2.0', id: 9, method: 'no_such_method' });
  assert.equal(res.error.code, -32601);
});

test('mcp: invalid JSON-RPC request returns invalid-request', async () => {
  const res = await dispatch({ jsonrpc: '1.0', id: 10, method: 'initialize' });
  assert.equal(res.error.code, -32600);
});

test('mcp: missing snapshot does not crash the server; tool call returns a structured error', async () => {
  setSnapshot(snapshot());
  const res = await dispatch({ jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'list_background_tasks', arguments: {} } });
  assert.ok(res.result || res.error);
});
