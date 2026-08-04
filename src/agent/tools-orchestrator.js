// src/agent/tools-orchestrator.js
//
// Phase 3 tools that talk to the Electron main process via window.avb.*
// IPC verbs. None of these touch the user's project directly — they all
// route through the orchestrator (worktree) or the evidence capture
// handler. The agent never sees raw git commands.
//
// Tools exposed here:
//   - capture_evidence    (READ-ish; returns a MediaResult-shaped envelope)
//   - open_background_task        (WRITE; needs approval)
//   - finalize_background_task    (DESTRUCTIVE-ish; needs approval)
//   - list_background_tasks       (READ)
//   - run_live_review             (READ; calls the model in a fresh context)
//
// All tools validate ctx (snapshot) and args (zod) and return typed
// results. Approval gating uses the same needsApproval() as the rest of
// the agent.

import { z } from 'zod';
import { snapshotSchema } from './schemas.js';
import { needsApproval, hashArgsForApproval } from './policy.js';
import { MEDIA_RESULT_STATUS } from './media.js';

// ---------------------------------------------------------------------------
// Arg schemas
// ---------------------------------------------------------------------------

const captureEvidenceArgsSchema = z.object({
  url: z.string().url(),
  width: z.number().int().min(64).max(3840).optional(),
  height: z.number().int().min(64).max(3840).optional(),
  kind: z.enum(['before', 'after', 'review']).default('review'),
  label: z.string().min(1).max(200).optional(),
});

const openBackgroundTaskArgsSchema = z.object({
  brief: z.string().min(1).max(2000),
  includeDirtyFiles: z.boolean().default(false),
});

const finalizeBackgroundTaskArgsSchema = z.object({
  taskId: z.string().min(1),
  action: z.enum(['discard', 'merge', 'keep']),
});

const listBackgroundTasksArgsSchema = z.object({});

const runLiveReviewArgsSchema = z.object({
  brief: z.string().min(1).max(2000),
  diffSummary: z.string().min(1).max(2000),
  evidencePaths: z.array(z.string()).default([]),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildRequestId() {
  return 'req-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function assertSnapshot(ctx) {
  return snapshotSchema.parse(ctx);
}

function gateForApproval(toolName, args, ctx) {
  // When the call comes from the MCP server, the MCP layer has already
  // gated on its own policy and remembered the approval. We trust the
  // orchestrator context flag rather than re-approving here.
  if (ctx && ctx.__mcpTrusted === true) {
    return { approved: true, decision: { required: false }, hash: hashArgsForApproval(toolName, args) };
  }
  const decision = needsApproval(toolName, args, ctx);
  if (!decision.required) return { approved: true, decision, hash: hashArgsForApproval(toolName, args) };
  return { approved: false, decision, hash: hashArgsForApproval(toolName, args) };
}

function approvalRequired(tool, decision, hash) {
  return {
    schemaVersion: 1,
    status: 'approval_required',
    tool,
    decision,
    approvalHash: hash,
    requestId: buildRequestId(),
  };
}

function getHost() {
  if (typeof window === 'undefined' || !window.avb) {
    throw new Error('tools-orchestrator: window.avb is unavailable; not running in the Sight renderer');
  }
  return window.avb;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function captureEvidence(ctx, args) {
  assertSnapshot(ctx);
  const parsed = captureEvidenceArgsSchema.parse(args);
  const decision = gateForApproval('capture_evidence', parsed, ctx);
  if (!decision.approved) return approvalRequired('capture_evidence', decision.decision, decision.hash);
  const host = getHost();
  if (typeof host.agentCaptureEvidence !== 'function') {
    return {
      schemaVersion: 1,
      status: MEDIA_RESULT_STATUS.UNAVAILABLE,
      kind: 'image',
      requestId: buildRequestId(),
      reason: 'agent:captureEvidence is not available on this host',
      recoveryCommand: 'rebuild Sight and restart',
    };
  }
  const r = await host.agentCaptureEvidence({ projectPath: ctx.projectPath, ...parsed });
  if (!r || !r.ok) {
    return {
      schemaVersion: 1,
      status: MEDIA_RESULT_STATUS.ERROR,
      kind: 'image',
      requestId: buildRequestId(),
      error: { code: r?.code ?? 'capture_failed', message: r?.error ?? 'capture failed' },
    };
  }
  return {
    schemaVersion: 1,
    status: MEDIA_RESULT_STATUS.OK,
    kind: 'image',
    requestId: buildRequestId(),
    provider: 'evidence',
    assets: [{ path: r.path, kind: 'image', mime: 'image/png', bytes: r.bytes }],
    license: 'internal-evidence',
    attribution: 'sight · agent:captureEvidence',
    dataUrl: r.dataUrl,
    width: r.width,
    height: r.height,
    label: parsed.label ?? r.kind,
  };
}

async function openBackgroundTask(ctx, args) {
  assertSnapshot(ctx);
  const parsed = openBackgroundTaskArgsSchema.parse(args);
  const decision = gateForApproval('open_background_task', parsed, ctx);
  if (!decision.approved) return approvalRequired('open_background_task', decision.decision, decision.hash);
  const host = getHost();
  if (typeof host.agentOpenBackgroundTask !== 'function') {
    return { schemaVersion: 1, status: 'error', tool: 'open_background_task', error: { code: 'no_verb', message: 'agentOpenBackgroundTask is not available' } };
  }
  const r = await host.agentOpenBackgroundTask({ projectRoot: ctx.projectPath, brief: parsed.brief, includeDirtyFiles: parsed.includeDirtyFiles });
  if (!r || !r.ok) {
    return { schemaVersion: 1, status: 'error', tool: 'open_background_task', error: { code: r?.code ?? 'open_failed', message: r?.error ?? 'open failed' } };
  }
  return { schemaVersion: 1, status: 'ok', tool: 'open_background_task', task: r.task };
}

async function finalizeBackgroundTask(ctx, args) {
  assertSnapshot(ctx);
  const parsed = finalizeBackgroundTaskArgsSchema.parse(args);
  const decision = gateForApproval('finalize_background_task', parsed, ctx);
  if (!decision.approved) return approvalRequired('finalize_background_task', decision.decision, decision.hash);
  const host = getHost();
  if (typeof host.agentFinalizeTask !== 'function') {
    return { schemaVersion: 1, status: 'error', tool: 'finalize_background_task', error: { code: 'no_verb', message: 'agentFinalizeTask is not available' } };
  }
  const r = await host.agentFinalizeTask({ projectRoot: ctx.projectPath, taskId: parsed.taskId, action: parsed.action });
  if (!r || !r.ok) {
    return { schemaVersion: 1, status: 'error', tool: 'finalize_background_task', error: { code: r?.code ?? 'finalize_failed', message: r?.error ?? 'finalize failed' } };
  }
  return { schemaVersion: 1, status: 'ok', tool: 'finalize_background_task', ...r };
}

async function listBackgroundTasks(ctx, args) {
  assertSnapshot(ctx);
  listBackgroundTasksArgsSchema.parse(args);
  const host = getHost();
  if (typeof host.agentListBackgroundTasks !== 'function') {
    return { schemaVersion: 1, status: 'ok', tool: 'list_background_tasks', tasks: [] };
  }
  const r = await host.agentListBackgroundTasks({ projectRoot: ctx.projectPath });
  return { schemaVersion: 1, status: 'ok', tool: 'list_background_tasks', tasks: r?.tasks ?? [] };
}

async function runLiveReview(ctx, args) {
  assertSnapshot(ctx);
  const parsed = runLiveReviewArgsSchema.parse(args);
  // run_live_review is a READ tool (no mutation, just a separate-context
  // pass over the diff and the evidence). It does NOT call the model
  // from here — it returns a structured envelope the orchestrator can
  // hand to a fresh gg-agent call. Keeping it out of the agent's hot
  // path means the agent cannot self-grade.
  return {
    schemaVersion: 1,
    status: 'review_requested',
    tool: 'run_live_review',
    requestId: buildRequestId(),
    brief: parsed.brief,
    diffSummary: parsed.diffSummary,
    evidencePaths: parsed.evidencePaths,
    // The actual reviewer call is a separate gg-agent invocation with a
    // fresh context, not visible to the original agent run.
    reviewer: 'separate-context',
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

function jsonSchema(zodSchema) {
  return { type: 'object', additionalProperties: false };
}

export function buildOrchestratorTools() {
  return [
    {
      name: 'capture_evidence',
      description: 'Capture a screenshot of the live preview at the given size. Returns an evidence envelope with a data URL and on-disk PNG. Never mutates the project.',
      inputSchema: jsonSchema(captureEvidenceArgsSchema),
      handler: (args, ctx) => captureEvidence(ctx, args),
    },
    {
      name: 'open_background_task',
      description: 'Open a background agent task on an isolated worktree. The orchestrator creates the worktree; the agent never sees raw git commands. Returns the task envelope.',
      inputSchema: jsonSchema(openBackgroundTaskArgsSchema),
      handler: (args, ctx) => openBackgroundTask(ctx, args),
    },
    {
      name: 'finalize_background_task',
      description: 'Finalize a background task — discard, merge, or keep. The orchestrator runs the git operation; the agent never sees raw git commands.',
      inputSchema: jsonSchema(finalizeBackgroundTaskArgsSchema),
      handler: (args, ctx) => finalizeBackgroundTask(ctx, args),
    },
    {
      name: 'list_background_tasks',
      description: 'List background tasks for the current project. Read-only.',
      inputSchema: jsonSchema(listBackgroundTasksArgsSchema),
      handler: (args, ctx) => listBackgroundTasks(ctx, args),
    },
    {
      name: 'run_live_review',
      description: 'Request a separate-context Live review of the current diff against the brief and any captured evidence. The reviewer is a fresh model call, not the builder.',
      inputSchema: jsonSchema(runLiveReviewArgsSchema),
      handler: (args, ctx) => runLiveReview(ctx, args),
    },
  ];
}

export const _internals = { captureEvidence, openBackgroundTask, finalizeBackgroundTask, listBackgroundTasks, runLiveReview };
