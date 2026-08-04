// src/agent/__tests__/skills.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateSkill,
  listSkills,
  getSkill,
  listSkillSummaries,
  loadUserSkill,
  unloadUserSkill,
  intersectWithHost,
  runSkill,
} from '../skills.js';

test('skills: bundled catalog contains the three Phase 5 seeds', () => {
  const all = listSkills();
  const names = all.map((s) => s.name);
  assert.ok(names.includes('impeccable-design-guardian'));
  assert.ok(names.includes('higgsfield-media-brief'));
  assert.ok(names.includes('background-task-runner'));
});

test('skills: validateSkill accepts a well-formed skill', () => {
  const v = validateSkill({
    schemaVersion: 1,
    name: 'my-skill',
    version: '1.0.0',
    license: 'MIT',
    description: 'A simple skill',
    instructions: 'Do the thing.',
    allowedTools: ['list_pages', 'read_page'],
  });
  assert.equal(v.ok, true);
  assert.equal(v.skill.name, 'my-skill');
});

test('skills: validateSkill rejects an empty instructions field', () => {
  const v = validateSkill({
    schemaVersion: 1,
    name: 'bad',
    version: '1.0.0',
    license: 'MIT',
    description: 'x',
    instructions: '',
    allowedTools: ['list_pages'],
  });
  assert.equal(v.ok, false);
  assert.ok(v.issues.length > 0);
});

test('skills: validateSkill rejects a name with uppercase or spaces', () => {
  const v = validateSkill({
    schemaVersion: 1,
    name: 'Bad Name',
    version: '1.0.0',
    license: 'MIT',
    description: 'x',
    instructions: 'do the thing',
    allowedTools: ['list_pages'],
  });
  assert.equal(v.ok, false);
});

test('skills: validateSkill rejects an unknown tool in allowedTools', () => {
  const v = validateSkill({
    schemaVersion: 1,
    name: 'unknown-tool-skill',
    version: '1.0.0',
    license: 'MIT',
    description: 'x',
    instructions: 'do the thing',
    allowedTools: ['list_pages', 'not_a_real_tool'],
  });
  assert.equal(v.ok, false);
});

test('skills: getSkill returns null for unknown name', () => {
  assert.equal(getSkill('nope'), null);
  assert.equal(getSkill(''), null);
  assert.equal(getSkill(null), null);
});

test('skills: listSkillSummaries strips instructions and reports tool count', () => {
  const summaries = listSkillSummaries();
  assert.ok(summaries.length >= 3);
  for (const s of summaries) {
    assert.equal(typeof s.instructions, 'undefined');
    assert.equal(typeof s.toolCount, 'number');
    assert.ok(s.toolCount > 0);
  }
});

test('skills: loadUserSkill + unloadUserSkill add and remove a user skill', () => {
  const before = listSkills().length;
  const loaded = loadUserSkill({
    schemaVersion: 1,
    name: 'test-user-skill',
    version: '0.1.0',
    license: 'MIT',
    description: 'unit test skill',
    instructions: 'do the thing',
    allowedTools: ['list_pages'],
  });
  assert.equal(loaded.ok, true);
  assert.equal(listSkills().length, before + 1);
  assert.equal(getSkill('test-user-skill').name, 'test-user-skill');
  assert.equal(unloadUserSkill('test-user-skill'), true);
  assert.equal(listSkills().length, before);
  // Idempotent removal
  assert.equal(unloadUserSkill('test-user-skill'), false);
  // Bundled skills cannot be removed
  assert.equal(unloadUserSkill('impeccable-design-guardian'), false);
});

test('skills: intersectWithHost drops unknown tools and keeps known ones', () => {
  // intersectWithHost takes any object with an allowedTools array and
  // does the host-intersection itself — it is the right layer for
  // filtering when the skill may contain tools the host does not know.
  const skill = {
    schemaVersion: 1,
    name: 'mix-skill',
    version: '1.0.0',
    license: 'MIT',
    description: 'x',
    instructions: 'do the thing',
    allowedTools: ['list_pages', 'not_a_real_tool', 'read_page'],
  };
  const r = intersectWithHost(skill);
  assert.deepEqual(r.allowed, ['list_pages', 'read_page']);
  assert.deepEqual(r.dropped, ['not_a_real_tool']);
});

test('skills: runSkill returns a typed block with attribution and allowedTools', () => {
  const r = runSkill('impeccable-design-guardian');
  assert.equal(r.ok, true);
  assert.match(r.block, /skill: impeccable-design-guardian v1\.0\.0 \(Apache-2\.0\)/);
  assert.match(r.block, /effective allowed tools: \[/);
  assert.ok(Array.isArray(r.allowedTools));
  assert.ok(r.allowedTools.length > 0);
});

test('skills: runSkill refuses model invocation when modelInvocable is false', () => {
  const r = runSkill('higgsfield-media-brief', { modelInvoked: true });
  assert.equal(r.ok, false);
  assert.match(r.reason, /not model-invocable/);
});

test('skills: runSkill refuses user invocation when userInvocable is false', () => {
  // Build a private skill with userInvocable:false
  loadUserSkill({
    schemaVersion: 1,
    name: 'agents-only',
    version: '0.1.0',
    license: 'MIT',
    description: 'agents only',
    instructions: 'do the thing',
    allowedTools: ['list_pages'],
    userInvocable: false,
  });
  const r = runSkill('agents-only', { userInvoked: true });
  assert.equal(r.ok, false);
  assert.match(r.reason, /not user-invocable/);
  unloadUserSkill('agents-only');
});

test('skills: runSkill refuses an unknown skill', () => {
  const r = runSkill('nope');
  assert.equal(r.ok, false);
  assert.match(r.reason, /unknown skill/);
});
