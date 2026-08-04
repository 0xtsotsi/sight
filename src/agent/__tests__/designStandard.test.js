// src/agent/__tests__/designStandard.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDesignStandardBlock,
  isDesignStandardAvailable,
  IMPECCABLE_VERSION,
  IMPECCABLE_LICENSE,
  IMPECCABLE_REPO,
} from '../designStandard.js';

test('design standard: file is on disk and activatable', () => {
  assert.equal(isDesignStandardAvailable(), true);
});

test('design standard: block always carries attribution + license', () => {
  const block = buildDesignStandardBlock({ active: true, mode: 'plan' });
  assert.match(block, /Impeccable v/);
  assert.match(block, /Apache-2\.0/);
  assert.ok(block.includes(IMPECCABLE_REPO));
});

test('design standard: version constant matches the upstream pinned version', () => {
  assert.equal(IMPECCABLE_VERSION, '3.5.0');
  assert.equal(IMPECCABLE_LICENSE, 'Apache-2.0');
  assert.match(IMPECCABLE_REPO, /^https:\/\/github\.com\/pbakaus\/impeccable$/);
});

test('design standard: block includes the governing rule "the brief wins"', () => {
  const block = buildDesignStandardBlock({ active: true, mode: 'plan' });
  assert.match(block, /the brief wins/i);
});

test('design standard: block mentions Live and Surface intent', () => {
  const block = buildDesignStandardBlock({ active: true, mode: 'plan' });
  assert.match(block, /\*\*Live\*\*/);
  assert.match(block, /Persuade/);
  assert.match(block, /Operate/);
  assert.match(block, /Read/);
  assert.match(block, /Experience/);
});

test('design standard: mode=review emits the review-specific hint', () => {
  const block = buildDesignStandardBlock({ active: true, mode: 'review' });
  assert.match(block, /Review mode/i);
  assert.match(block, /do not propose edits/i);
});

test('design standard: mode=build emits the diff-only hint', () => {
  const block = buildDesignStandardBlock({ active: true, mode: 'build' });
  assert.match(block, /Build mode/i);
  assert.match(block, /propose structured diffs only/i);
});

test('design standard: inactive returns empty block', () => {
  const block = buildDesignStandardBlock({ active: false, mode: 'plan' });
  assert.equal(block, '');
});

test('designStandard: block mentions active skills when provided', () => {
  const block = buildDesignStandardBlock({ active: true, mode: 'plan', activeSkills: [
    { name: 'higgsfield-media-brief', version: '1.0.0', license: 'Apache-2.0', description: 'media drafter', userInvocable: true, modelInvocable: false },
  ] });
  assert.match(block, /Active skills:/);
  assert.match(block, /higgsfield-media-brief/);
  assert.match(block, /user-only/);
});

test('designStandard: block is empty when inactive even with skills', () => {
  const block = buildDesignStandardBlock({ active: false, mode: 'plan', activeSkills: [{ name: 'x', version: '1', license: 'MIT', description: 'd', userInvocable: true, modelInvocable: true }] });
  assert.equal(block, '');
});
