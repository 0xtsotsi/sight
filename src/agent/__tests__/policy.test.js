// src/agent/__tests__/policy.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EFFECT,
  annotationsFor,
  toolManifestEntry,
  listToolNames,
  needsApproval,
  hashArgsForApproval,
} from '../policy.js';

test('policy: annotations for READ are all safe hints', () => {
  const a = annotationsFor(EFFECT.READ);
  assert.equal(a.readOnlyHint, true);
  assert.equal(a.destructiveHint, false);
  assert.equal(a.idempotentHint, true);
  assert.equal(a.openWorldHint, false);
});

test('policy: annotations for EXTERNAL carry openWorldHint:true', () => {
  const a = annotationsFor(EFFECT.EXTERNAL);
  assert.equal(a.openWorldHint, true);
  assert.equal(a.readOnlyHint, false);
});

test('policy: annotations for DESTRUCTIVE carry destructiveHint:true and idempotentHint:false', () => {
  const a = annotationsFor(EFFECT.DESTRUCTIVE);
  assert.equal(a.destructiveHint, true);
  assert.equal(a.idempotentHint, false);
});

test('policy: tool manifest covers the existing 5 tools and the 4 media tools', () => {
  const names = listToolNames();
  for (const n of ['list_pages', 'read_page', 'read_cms', 'scan_project', 'apply_page_diff', 'generate_image', 'generate_video', 'generate_thumbnail', 'pull_brandkit']) {
    assert.ok(names.includes(n), 'missing tool: ' + n);
  }
});

test('policy: apply_page_diff is PROPOSE; media tools are EXTERNAL', () => {
  assert.equal(toolManifestEntry('apply_page_diff').effect, EFFECT.PROPOSE);
  assert.equal(toolManifestEntry('generate_image').effect, EFFECT.EXTERNAL);
  assert.equal(toolManifestEntry('pull_brandkit').effect, EFFECT.EXTERNAL);
});

test('policy: needsApproval returns required:false for READ and PROPOSE', () => {
  assert.equal(needsApproval('read_page', { path: '/p' }).required, false);
  assert.equal(needsApproval('apply_page_diff', { path: '/p' }).required, false);
});

test('policy: needsApproval requires approval for every EXTERNAL tool and never marks it rememberable', () => {
  const d = needsApproval('generate_image', { prompt: 'hi' });
  assert.equal(d.required, true);
  assert.equal(d.rememberable, false);
  assert.match(d.reason, /openWorldHint/i);
});

test('policy: needsApproval for a long media prompt escalates to high tier', () => {
  const d = needsApproval('generate_video', { prompt: 'a'.repeat(1500) });
  assert.equal(d.required, true);
  assert.equal(d.tier, 'high');
});

test('policy: needsApproval for an unknown tool returns required:true with a high tier', () => {
  const d = needsApproval('not_a_real_tool', {});
  assert.equal(d.required, true);
  assert.equal(d.tier, 'high');
});

test('policy: hashArgsForApproval is stable for the same args and differs for different args', () => {
  const a = hashArgsForApproval('generate_image', { prompt: 'hi' });
  const b = hashArgsForApproval('generate_image', { prompt: 'hi' });
  const c = hashArgsForApproval('generate_image', { prompt: 'hi!' });
  assert.equal(a, b);
  assert.notEqual(a, c);
});
