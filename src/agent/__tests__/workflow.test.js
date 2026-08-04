// src/agent/__tests__/workflow.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createWorkflow,
  transition,
  completeStep,
  awaitStep,
  skipStep,
  isAtEnd,
  currentStep,
  proposeVisualDirections,
  chooseVisualDirection,
  skipVisualDirection,
  shouldProposeVisualDirections,
  validateWorkflow,
  recordLiveResult,
  STEP,
  STEP_STATUS,
  INTENT,
  CLASSIFICATION,
  VISUAL_DIRECTION_STATUS,
} from '../workflow.js';

test('workflow: fresh workflow has 6 pending steps in the plan order', () => {
  const w = createWorkflow({ taskId: 't1', brief: 'redesign the landing' });
  assert.equal(w.schemaVersion, 1);
  assert.equal(w.steps.length, 6);
  assert.deepEqual(w.steps.map((s) => s.name), [
    STEP.UNDERSTAND, STEP.SHAPE, STEP.BUILD, STEP.INSPECT, STEP.POLISH, STEP.FINISH,
  ]);
  for (const s of w.steps) assert.equal(s.status, STEP_STATUS.PENDING);
});

test('workflow: transition() activates the current step and sets enteredAt', () => {
  const w = createWorkflow({ brief: 'x' });
  const step = transition(w);
  assert.equal(step.name, STEP.UNDERSTAND);
  assert.equal(w.steps[0].status, STEP_STATUS.ACTIVE);
  assert.ok(w.steps[0].enteredAt);
});

test('workflow: completeStep() advances and marks DONE', () => {
  const w = createWorkflow({ brief: 'x' });
  transition(w);
  const done = completeStep(w, { note: 'ok' });
  assert.equal(done.status, STEP_STATUS.DONE);
  assert.equal(w.currentIndex, 1);
  assert.equal(currentStep(w).name, STEP.SHAPE);
});

test('workflow: awaitStep() puts the current step in AWAITING without advancing', () => {
  const w = createWorkflow({ brief: 'x' });
  transition(w);
  const s = awaitStep(w, 'waiting on user');
  assert.equal(s.status, STEP_STATUS.AWAITING);
  assert.equal(w.currentIndex, 0);
});

test('workflow: cannot transition twice on the same step', () => {
  const w = createWorkflow({ brief: 'x' });
  transition(w);
  assert.throws(() => transition(w), /cannot transition an active step/i);
});

test('workflow: cannot transition past the end', () => {
  const w = createWorkflow({ brief: 'x' });
  for (let i = 0; i < 6; i += 1) { transition(w); completeStep(w); }
  assert.ok(isAtEnd(w));
  assert.throws(() => transition(w), /already at the end/i);
});

test('workflow: skipStep() advances and marks SKIPPED with a reason', () => {
  const w = createWorkflow({ brief: 'x' });
  transition(w);
  const s = skipStep(w, 'not needed for a refine');
  assert.equal(s.status, STEP_STATUS.SKIPPED);
  assert.equal(w.currentIndex, 1);
});

test('workflow: visual-direction choice requires 2-4 directions and rejects more', () => {
  assert.throws(() => proposeVisualDirections({ workflowId: 'w1', directions: [] }), /at least one direction/i);
  assert.throws(() => proposeVisualDirections({ workflowId: 'w1', directions: new Array(5).fill(0).map((_, i) => ({ id: 'd' + i, title: 't', summary: 's' })) }), /at most 4 directions/i);
  const ev = proposeVisualDirections({
    workflowId: 'w1',
    directions: [
      { id: 'a', title: 'Editorial', summary: 'Type-driven magazine layout', prose: 'A long-form prose description.' },
      { id: 'b', title: 'Studio', summary: 'Minimal product showcase', prose: 'Quiet palette and big product shots.' },
    ],
  });
  assert.equal(ev.type, 'visual_direction');
  assert.equal(ev.status, VISUAL_DIRECTION_STATUS.PROPOSED);
  assert.equal(ev.directions.length, 2);
});

test('workflow: chooseVisualDirection returns a CHOSEN event; variant=true yields VARIANTS', () => {
  const chosen = chooseVisualDirection({ workflowId: 'w1', directionId: 'a' });
  assert.equal(chosen.status, VISUAL_DIRECTION_STATUS.CHOSEN);
  const variants = chooseVisualDirection({ workflowId: 'w1', directionId: 'a', variant: true });
  assert.equal(variants.status, VISUAL_DIRECTION_STATUS.VARIANTS);
});

test('workflow: skipVisualDirection returns a SKIPPED event', () => {
  const ev = skipVisualDirection({ workflowId: 'w1' });
  assert.equal(ev.status, VISUAL_DIRECTION_STATUS.SKIPPED);
});

test('workflow: shouldProposeVisualDirections enforces the plan rule', () => {
  assert.equal(shouldProposeVisualDirections({ classification: CLASSIFICATION.REDESIGN }), true);
  assert.equal(shouldProposeVisualDirections({ classification: CLASSIFICATION.REFINE, surface: 'existing' }), false);
  assert.equal(shouldProposeVisualDirections({ classification: CLASSIFICATION.EXTEND, surface: 'existing' }), false);
  assert.equal(shouldProposeVisualDirections({ classification: CLASSIFICATION.REFINE, surface: 'new' }), true);
});

test('workflow: validateWorkflow flags a malformed step list', () => {
  const w = createWorkflow({ brief: 'x' });
  w.steps = [];
  const issues = validateWorkflow(w);
  assert.ok(issues.length > 0);
});

test('workflow: validateWorkflow accepts a freshly created workflow', () => {
  const w = createWorkflow({ brief: 'x' });
  assert.deepEqual(validateWorkflow(w), []);
});

test('workflow: validateWorkflow accepts a workflow whose visual direction is variants', () => {
  const w = createWorkflow({ brief: 'x' });
  w.visualDirection = { status: 'variants', directionId: 'a' };
  assert.deepEqual(validateWorkflow(w), []);
});

test('workflow: validateWorkflow flags an unknown visualDirection.status', () => {
  const w = createWorkflow({ brief: 'x' });
  w.visualDirection = { status: 'weird' };
  const issues = validateWorkflow(w);
  assert.ok(issues.length > 0);
});

test('workflow: recordLiveResult stamps a final live review outcome', () => {
  const w = createWorkflow({ brief: 'x' });
  for (let i = 0; i < 6; i += 1) { transition(w); completeStep(w); }
  const live = recordLiveResult(w, { verdict: 'pass', notes: 'no critical issues' });
  assert.equal(live.status, 'done');
  assert.ok(live.runId.startsWith('live-'));
  assert.equal(w.live.verdict, 'pass');
});

test('workflow: cannot double-record live result', () => {
  const w = createWorkflow({ brief: 'x' });
  for (let i = 0; i < 6; i += 1) { transition(w); completeStep(w); }
  recordLiveResult(w, { verdict: 'pass' });
  assert.throws(() => recordLiveResult(w, { verdict: 'fail' }), /already done/i);
});

test('workflow: enums are frozen and stable', () => {
  assert.equal(STEP.UNDERSTAND, 'understand');
  assert.equal(STEP.LIVE, 'live');
  assert.equal(STEP_STATUS.PENDING, 'pending');
  assert.equal(INTENT.PERSUADE, 'persuade');
  assert.equal(CLASSIFICATION.REDESIGN, 'redesign');
  assert.equal(VISUAL_DIRECTION_STATUS.PROPOSED, 'proposed');
});
