// src/agent/mcp.js
//
// Phase 4: minimal Model Context Protocol (MCP) transport for Sight's
// tool manifest. The same `buildTools()` output that the in-app agent
// uses is exposed over stdio so external agents (Claude Code, Cursor,
// Codex, etc.) can call Sight's tools while the user is at the desk.
//
// Wire format: MCP stdio transport (JSON-RPC 2.0 over new-line-delimited
// JSON on stdin/stdout). The server supports:
//   - initialize              (returns server info + capabilities)
//   - tools/list              (returns the tool catalog with the same
//                              MCP annotations the internal pipeline uses)
//   - tools/call              (executes a tool with the right ctx, gated
//                              by needsApproval)
//
// Approval is enforced on the host side: every tool call is run through
// `needsApproval(tool, args, ctx)` and tools that require approval
// return a structured "approval_required" envelope — the calling agent
// is expected to surface that to the human. The server never bypasses
// the policy layer.
//
// The transport is a plain Node `process.stdin`/`process.stdout` loop
// so it can be launched via `node src/agent/mcp.js` (or wrapped in
// `npx skills add` style skill runners).

import { randomUUID } from 'node:crypto';
import readline from 'node:readline';
import { buildTools } from './tools.js';
import { toolManifestEntry, listToolNames, needsApproval, hashArgsForApproval } from './policy.js';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Server identity
// ---------------------------------------------------------------------------

const SERVER_INFO = Object.freeze({
  name: 'sight-tools',
  version: '0.1.0',
});

const SERVER_CAPABILITIES = Object.freeze({
  tools: { listChanged: false },
});

// ---------------------------------------------------------------------------
// JSON-RPC plumbing
// ---------------------------------------------------------------------------

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}
function rpcError(id, code, message, data) {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}

// ---------------------------------------------------------------------------
// Host shim — the renderer-side tools expect window.avb. The MCP
// server is not running in the renderer, so we install a no-op shim
// that responds "no verb" for every method. Tools that do not need the
// host (list_pages, read_page, read_cms, scan_project, apply_page_diff,
// and the model-only parts of run_live_review) work as in the panel.
// Tools that need the host return a structured "unavailable" result so
// the calling agent can surface the reason instead of crashing.
// ---------------------------------------------------------------------------

function ensureHostShim() {
  if (typeof globalThis.window === 'undefined') {
    globalThis.window = {};
  }
  if (!globalThis.window.avb) {
    const shim = new Proxy({}, {
      get: () => async () => ({ ok: false, error: 'no verb: this tool requires the Sight renderer' }),
    });
    globalThis.window.avb = shim;
  }
}

// ---------------------------------------------------------------------------
// Snapshot reconstruction — MCP tools run without a React context, so
// the panel/host must pass the snapshot on the call. The host may
// stash it under a single setSnapshot() call before invoking tools.
// ---------------------------------------------------------------------------

let currentSnapshot = null;
let currentApprovals = new Map(); // toolName|argsHash -> 'remembered'

export function setSnapshot(snapshot) {
  currentSnapshot = snapshot;
}

export function rememberApproval(toolName, argsHash) {
  currentApprovals.set(toolName + '|' + argsHash, true);
}

// ---------------------------------------------------------------------------
// Annotation + schema builders
// ---------------------------------------------------------------------------

function annotationsForTool(name) {
  const entry = toolManifestEntry(name);
  if (!entry) return undefined;
  switch (entry.effect) {
    case 'read':    return { readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: false };
    case 'propose': return { readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: false };
    case 'write':   return { readOnlyHint: false, destructiveHint: false, idempotentHint: true,  openWorldHint: false };
    case 'destructive': return { readOnlyHint: false, destructiveHint: true,  idempotentHint: false, openWorldHint: false };
    case 'external': return { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
    default:        return undefined;
  }
}

function schemaForTool(name) {
  // All our tools ship a closed-object zod schema. We hand back a
  // minimal JSON Schema — sufficient for MCP clients to display the
  // tool and the panel to gate the call.
  return { type: 'object', additionalProperties: false };
}

// ---------------------------------------------------------------------------
// tools/list
// ---------------------------------------------------------------------------

function handleListTools(id) {
  const tools = buildTools().map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: schemaForTool(t.name),
    annotations: annotationsForTool(t.name) ?? undefined,
  }));
  return rpcResult(id, { tools });
}

// ---------------------------------------------------------------------------
// tools/call
// ---------------------------------------------------------------------------

async function handleCallTool(id, params) {
  if (!params || typeof params !== 'object') {
    return rpcError(id, -32602, 'invalid params: expected {name, arguments}');
  }
  const { name, arguments: args } = params;
  if (typeof name !== 'string' || !name) {
    return rpcError(id, -32602, 'invalid params: name is required');
  }
  const entry = toolManifestEntry(name);
  if (!entry) {
    return rpcError(id, -32602, 'unknown tool: ' + name, { available: listToolNames() });
  }
  const decision = needsApproval(name, args ?? {}, currentSnapshot ?? {});
  const argsHash = hashArgsForApproval(name, args ?? {});
  if (decision.required && !currentApprovals.get(name + '|' + argsHash)) {
    return rpcResult(id, {
      content: [{ type: 'text', text: 'approval_required' }],
      structuredContent: {
        status: 'approval_required',
        tool: name,
        decision,
        approvalHash: argsHash,
      },
      isError: false,
    });
  }
  // Look up the actual handler from buildTools() so the same code path
  // runs in the MCP server and in the in-app agent.
  const tool = buildTools().find((t) => t.name === name);
  if (!tool) {
    return rpcError(id, -32602, 'tool not registered: ' + name);
  }
  // Tag the ctx so tools-orchestrator.js knows to skip its own
  // approval gate — the MCP layer is the authoritative gate for
  // external agents.
  const ctx = { ...(currentSnapshot ?? {}), __mcpTrusted: true };
  try {
    const result = await tool.handler(args ?? {}, ctx);
    return rpcResult(id, {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      structuredContent: result,
    });
  } catch (err) {
    return rpcResult(id, {
      content: [{ type: 'text', text: 'tool error: ' + String(err?.message ?? err) }],
      isError: true,
    });
  }
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export async function dispatch(req) {
  ensureHostShim();
  if (!req || typeof req !== 'object' || req.jsonrpc !== '2.0' || typeof req.method !== 'string') {
    return rpcError(req?.id ?? null, -32600, 'invalid request');
  }
  const { id, method, params } = req;
  switch (method) {
    case 'initialize':
      return rpcResult(id, {
        protocolVersion: '2025-11-25',
        serverInfo: SERVER_INFO,
        capabilities: SERVER_CAPABILITIES,
      });
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return handleListTools(id);
    case 'tools/call':
      return await handleCallTool(id, params);
    default:
      return rpcError(id, -32601, 'method not found: ' + method);
  }
}

// ---------------------------------------------------------------------------
// Stdio loop
// ---------------------------------------------------------------------------

export async function startMcpStdioServer({ stdin = process.stdin, stdout = process.stdout, stderr = process.stderr } = {}) {
  ensureHostShim();
  const rl = readline.createInterface({ input: stdin, crlfDelay: Infinity });
  rl.on('line', async (line) => {
    if (!line.trim()) return;
    let req;
    try { req = JSON.parse(line); }
    catch { stdout.write(JSON.stringify(rpcError(null, -32700, 'parse error')) + '\n'); return; }
    try {
      const res = await dispatch(req);
      if (res !== null) stdout.write(JSON.stringify(res) + '\n');
    } catch (err) {
      stderr.write('mcp: dispatch error: ' + (err?.message ?? err) + '\n');
      stdout.write(JSON.stringify(rpcError(req?.id ?? null, -32603, 'internal error', String(err?.message ?? err))) + '\n');
    }
  });
  return rl;
}

// ---------------------------------------------------------------------------
// CLI entry point: `node src/agent/mcp.js`
// ---------------------------------------------------------------------------

function isCliInvocation() {
  // Detect direct CLI launch (vs. import from another module).
  if (!process.argv[1]) return false;
  const entry = process.argv[1].replace(/\\/g, '/');
  return entry.endsWith('/src/agent/mcp.js') || entry.endsWith('/mcp.js');
}

if (isCliInvocation()) {
  // Bootstrap a snapshot from argv if the caller passed one. The
  // caller can also set it programmatically via setSnapshot() before
  // importing the transport.
  startMcpStdioServer().catch((err) => {
    process.stderr.write('mcp: failed to start: ' + (err?.message ?? err) + '\n');
    process.exit(1);
  });
}

export const _internals = { dispatch, handleListTools, handleCallTool, setSnapshot, rememberApproval };
