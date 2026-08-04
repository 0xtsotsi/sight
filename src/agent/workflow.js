// src/agent/workflow.js
//
// Phase 1 workflow for the Impeccable-first Design Agent.
//
// Responsibilities:
//   - Track a single in-flight design task with a stable workflow id.
//   - Run the six-step workflow: Understand, Shape, Build, Inspect, Polish,
//     Finish. Plus the optional `Live` separate-review step at the end.
//   - Surface the visual-direction choice as a typed event the panel can
//     render as a 2–4 card picker.
//   - Keep every step resumable and auditable: each step emits an event
//     with `{ workflowId, step, status, payload }`.
//
// Constraints (intentional for Phase 1):
//   - No background worktrees, no MCP transport, no auto-apply, no imported
//     scripts. The workflow prepares proposals; the user applies them.
//   - The workflow is pure JS: it does not import Electron, the renderer,
//     or the agent client. The panel wires events from `runAgentStream` to
//     the workflow state via the small adapter the panel itself owns.
//
// This file is the single source of truth for workflow state. Tests in
// `src/agent/__tests__/workflow.test.js` enforce the step order, the
// visual-direction gate, the `Live` step placement, and the typed result
// shapes the panel renders.

import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// Step enum — keep in lockstep with the plan.
// ---------------------------------------------------------------------------

export const STEP = Object.freeze({
  UNDERSTAND: 'understand',
  SHAPE: 'shape',
  BUILD: 'build',
  INSPECT: 'inspect',
  POLISH: 'polish',
  FINISH: 'finish',
  LIVE: 'live',
});

const STEP_ORDER = [STEP.UNDERSTAND, STEP.SHAPE, STEP.BUILD, STEP.INSPECT, STEP.POLISH, STEP.FINISH];

// ---------------------------------------------------------------------------
// Status enum
// ---------------------------------------------------------------------------

export const STEP_STATUS = Object.freeze({
  PENDING: 'pending',
  ACTIVE: 'active',
  AWAITING: 'awaiting', // waiting on the user (e.g. visual-direction choice)
  DONE: 'done',
  SKIPPED: 'skipped',
  ERROR: 'error',
});

// ---------------------------------------------------------------------------
// Intent enum — exposed for the panel and the system prompt.
// ---------------------------------------------------------------------------

export const INTENT = Object.freeze({
  PERSUADE: 'persuade',
  OPERATE: 'operate',
  READ: 'read',
  EXPERIENCE: 'experience',
});

// ---------------------------------------------------------------------------
// Classification enum
// ---------------------------------------------------------------------------

export const CLASSIFICATION = Object.freeze({
  REFINE: 'refine',
  EXTEND: 'extend',
  REDESIGN: 'redesign',
});

// ---------------------------------------------------------------------------
// Visual direction choice — a typed event the panel renders as cards.
// ---------------------------------------------------------------------------

export const VISUAL_DIRECTION_STATUS = Object.freeze({
  PROPOSED: 'proposed',
  CHOSEN: 'chosen',
  SKIPPED: 'skipped',
  VARIANTS: 'variants',
});

/**
 * Build a visual-direction proposal. The agent returns 2–4 directions; the
 * panel renders each as a card with a one-line summary plus longer prose.
 *
 * @param {Object} args
 * @param {string} args.workflowId
 * @param {Array<{id:string,title:string,summary:string,prose:string}>} args.directions
 * @returns {{type:'visual_direction', workflowId:string, status:'proposed', directions:Array}}
 */
export function proposeVisualDirections({ workflowId, directions }) {
  if (!workflowId) throw new Error('proposeVisualDirections: workflowId is required');
  if (!Array.isArray(directions) || directions.length < 1) {
    throw new Error('proposeVisualDirections: at least one direction is required');
  }
  if (directions.length > 4) {
    throw new Error('proposeVisualDirections: at most 4 directions are allowed');
  }
  for (const d of directions) {
    if (!d || typeof d !== 'object') throw new Error('proposeVisualDirections: invalid direction');
    if (typeof d.id !== 'string' || !d.id) throw new Error('proposeVisualDirections: direction.id is required');
    if (typeof d.title !== 'string' || !d.title) throw new Error('proposeVisualDirections: direction.title is required');
    if (typeof d.summary !== 'string' || d.summary.length === 0) throw new Error('proposeVisualDirections: direction.summary is required');
    if (d.summary.length > 200) throw new Error('proposeVisualDirections: direction.summary must be <= 200 chars');
    if (typeof d.prose !== 'string') throw new Error('proposeVisualDirections: direction.prose must be a string');
    if (d.prose.length > 1200) throw new Error('proposeVisualDirections: direction.prose must be <= 1200 chars');
  }
  return {
    type: 'visual_direction',
    workflowId,
    status: VISUAL_DIRECTION_STATUS.PROPOSED,
    directions: directions.map((d) => ({ id: d.id, title: d.title, summary: d.summary, prose: d.prose })),
    ts: Date.now(),
  };
}

/**
 * Record the user's choice from a visual-direction proposal. Returns the
 * event the panel surfaces; the caller still has to apply the chosen
 * direction to subsequent steps.
 */
export function chooseVisualDirection({ workflowId, directionId, variant = false }) {
  if (!workflowId) throw new Error('chooseVisualDirection: workflowId is required');
  if (!directionId) throw new Error('chooseVisualDirection: directionId is required');
  return {
    type: 'visual_direction',
    workflowId,
    status: variant ? VISUAL_DIRECTION_STATUS.VARIANTS : VISUAL_DIRECTION_STATUS.CHOSEN,
    directionId,
    ts: Date.now(),
  };
}

export function skipVisualDirection({ workflowId }) {
  return { type: 'visual_direction', workflowId, status: VISUAL_DIRECTION_STATUS.SKIPPED, ts: Date.now() };
}

// ---------------------------------------------------------------------------
// Workflow state
// ---------------------------------------------------------------------------

/**
 * Create a fresh workflow. Steps start in `pending`. Returns a workflow
 * object the agent / panel can advance by calling `transition()`.
 */
export function createWorkflow({ taskId, brief } = {}) {
  const workflowId = 'wf-' + randomUUID();
  const steps = STEP_ORDER.map((name) => ({ name, status: STEP_STATUS.PENDING, enteredAt: null, exitedAt: null }));
  return {
    schemaVersion: 1,
    workflowId,
    taskId: taskId ?? workflowId,
    brief: typeof brief === 'string' ? brief : '',
    createdAt: Date.now(),
    steps,
    currentIndex: 0,
    visualDirection: null, // { status, directionId? } once chosen
    live: null, // null | { runId, status, result }
  };
}

/**
 * Advance the workflow to the next step. The caller is responsible for
 * emitting the panel-facing event and for actually doing the work.
 *
 * Throws if the workflow is already at the end. Use `isAtEnd` to gate.
 */
export function transition(workflow) {
  if (!workflow || typeof workflow !== 'object') throw new Error('transition: workflow is required');
  if (workflow.currentIndex >= workflow.steps.length) {
    throw new Error('transition: workflow is already at the end');
  }
  const current = workflow.steps[workflow.currentIndex];
  if (current.status === STEP_STATUS.ACTIVE) {
    throw new Error('transition: cannot transition an active step; finish it first');
  }
  current.status = STEP_STATUS.ACTIVE;
  current.enteredAt = Date.now();
  return current;
}

export function completeStep(workflow, payload = null) {
  if (!workflow) throw new Error('completeStep: workflow is required');
  if (workflow.currentIndex >= workflow.steps.length) {
    throw new Error('completeStep: workflow is already at the end');
  }
  const current = workflow.steps[workflow.currentIndex];
  if (current.status !== STEP_STATUS.ACTIVE && current.status !== STEP_STATUS.AWAITING) {
    throw new Error('completeStep: step is not active');
  }
  current.status = STEP_STATUS.DONE;
  current.exitedAt = Date.now();
  if (payload !== null) current.payload = payload;
  workflow.currentIndex += 1;
  return current;
}

export function awaitStep(workflow, reason) {
  if (!workflow) throw new Error('awaitStep: workflow is required');
  const current = workflow.steps[workflow.currentIndex];
  if (current.status !== STEP_STATUS.ACTIVE) {
    throw new Error('awaitStep: step is not active');
  }
  current.status = STEP_STATUS.AWAITING;
  current.awaitReason = typeof reason === 'string' ? reason : 'awaiting user';
  return current;
}

export function skipStep(workflow, reason) {
  if (!workflow) throw new Error('skipStep: workflow is required');
  if (workflow.currentIndex >= workflow.steps.length) return null;
  const current = workflow.steps[workflow.currentIndex];
  current.status = STEP_STATUS.SKIPPED;
  current.exitedAt = Date.now();
  if (reason) current.skipReason = reason;
  workflow.currentIndex += 1;
  return current;
}

export function isAtEnd(workflow) {
  return workflow.currentIndex >= workflow.steps.length;
}

export function currentStep(workflow) {
  if (workflow.currentIndex >= workflow.steps.length) return null;
  return workflow.steps[workflow.currentIndex];
}

/**
 * Whether a visual-direction proposal is required for the current task.
 * The rule (kept in lockstep with the plan): required for `redesign` and
 * `new` surfaces; optional for `extend`; not required for `refine`.
 */
export function shouldProposeVisualDirections({ classification, surface = 'existing' }) {
  if (classification === CLASSIFICATION.REDESIGN) return true;
  if (surface === 'new') return true;
  return false;
}

/**
 * Validate a workflow. Used by tests and the audit hook. Returns an array
 * of issue strings; an empty array means the workflow is well-formed.
 */
export function validateWorkflow(workflow) {
  const issues = [];
  if (!workflow || typeof workflow !== 'object') {
    issues.push('workflow is required');
    return issues;
  }
  if (workflow.schemaVersion !== 1) issues.push('schemaVersion must be 1');
  if (typeof workflow.workflowId !== 'string' || !workflow.workflowId) issues.push('workflowId is required');
  if (!Array.isArray(workflow.steps) || workflow.steps.length !== STEP_ORDER.length) {
    issues.push('steps must be a 6-element array');
  } else {
    for (let i = 0; i < STEP_ORDER.length; i += 1) {
      if (workflow.steps[i].name !== STEP_ORDER[i]) {
        issues.push('step ' + i + ' must be ' + STEP_ORDER[i]);
      }
    }
  }
  if (workflow.visualDirection && !['chosen', 'skipped', 'variants'].includes(workflow.visualDirection.status)) {
    issues.push('visualDirection.status must be chosen, skipped, or variants');
  }
  return issues;
}

/**
 * Mark a Live separate-review run as completed. Used at the end of
 * Finish to record the reviewer outcome. The `result` argument is spread
 * onto the workflow's `live` envelope so callers can stamp any fields
 * they like (verdict, notes, score, etc.) and read them back directly.
 */
export function recordLiveResult(workflow, result) {
  if (!workflow) throw new Error('recordLiveResult: workflow is required');
  if (workflow.live && workflow.live.status === 'done') {
    throw new Error('recordLiveResult: live review is already done');
  }
  const payload = result && typeof result === 'object' ? result : {};
  workflow.live = {
    runId: 'live-' + randomUUID(),
    status: 'done',
    ...payload,
    completedAt: Date.now(),
  };
  return workflow.live;
}

export const _internals = { STEP_ORDER };
