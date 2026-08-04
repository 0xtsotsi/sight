// src/agent/diff.test.mjs
//
// Verifies computeDiff / computeJsonPatch / projectLines for the agent's
// apply_page_diff tool. The page model is a tree of nodes, so we cover:
//   - identity (no change)
//   - both null
//   - one side null
//   - prop change (replace)
//   - new node added
//   - node removed
//   - array length change
//   - deep nested change
//   - key rename (remove + add)
//   - JSON Pointer escaping for paths with / or ~
//   - jsonPatch ops are valid RFC 6902

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeDiff,
  computeJsonPatch,
  projectLines,
  _internals,
} from './diff.js';

const { encodePointer, deepEqual, PATCH } = _internals;

// ---------------------------------------------------------------------------
// Identities
// ---------------------------------------------------------------------------

test('identical models return no change', () => {
  const m = { imports: ['A'], nodes: [{ id: 'n1', kind: 'component', name: 'Hero' }] };
  const out = computeDiff(m, m);
  assert.equal(out.summary, 'no change');
  assert.equal(out.unifiedDiff, null);
  assert.deepEqual(out.jsonPatch, []);
});

test('both null returns no change', () => {
  const out = computeDiff(null, null);
  assert.equal(out.summary, 'no change');
  assert.equal(out.unifiedDiff, null);
});

test('both undefined returns no change', () => {
  const out = computeDiff(undefined, undefined);
  assert.equal(out.summary, 'no change');
});

test('first edit from null', () => {
  const out = computeDiff(null, { nodes: [] });
  assert.notEqual(out.summary, 'no change');
  assert.ok(out.jsonPatch.length >= 1);
  assert.equal(out.jsonPatch[0].op, PATCH.ADD);
  assert.equal(out.jsonPatch[0].path, '/nodes');
});

test('edit to null removes everything', () => {
  const out = computeDiff({ nodes: [{ id: 'n1' }] }, null);
  assert.notEqual(out.summary, 'no change');
  assert.ok(out.jsonPatch.some((o) => o.op === PATCH.REMOVE));
});

// ---------------------------------------------------------------------------
// Prop change (replace)
// ---------------------------------------------------------------------------

test('prop replace produces a single replace op', () => {
  const before = { nodes: [{ id: 'n1', props: { title: 'Hello' } }] };
  const after = { nodes: [{ id: 'n1', props: { title: 'World' } }] };
  const out = computeDiff(before, after);
  const replace = out.jsonPatch.find((o) => o.op === PATCH.REPLACE);
  assert.ok(replace, 'expected a replace op');
  assert.equal(replace.path, '/nodes/0/props/title');
  assert.equal(replace.value, 'World');
  assert.match(out.summary, /1 replace/);
  assert.ok(out.unifiedDiff, 'unifiedDiff should be present for changes');
  assert.match(out.unifiedDiff, /Hello/);
  assert.match(out.unifiedDiff, /World/);
});

// ---------------------------------------------------------------------------
// Add/remove nodes
// ---------------------------------------------------------------------------

test('adding a node produces an add op at the new index', () => {
  const before = { nodes: [{ id: 'a' }] };
  const after = { nodes: [{ id: 'a' }, { id: 'b' }] };
  const out = computeDiff(before, after);
  const add = out.jsonPatch.find((o) => o.op === PATCH.ADD && o.path === '/nodes/1');
  assert.ok(add, 'expected add at /nodes/1');
  assert.equal(add.value.id, 'b');
});

test('removing the last node removes from the tail', () => {
  const before = { nodes: [{ id: 'a' }, { id: 'b' }] };
  const after = { nodes: [{ id: 'a' }] };
  const out = computeDiff(before, after);
  const remove = out.jsonPatch.find((o) => o.op === PATCH.REMOVE);
  assert.ok(remove, 'expected a remove op');
  assert.equal(remove.path, '/nodes/1');
});

// ---------------------------------------------------------------------------
// Deep nested change
// ---------------------------------------------------------------------------

test('deep nested change emits the full path', () => {
  const before = { nodes: [{ id: 'n1', props: { items: [{ label: 'A' }, { label: 'B' }] } }] };
  const after = { nodes: [{ id: 'n1', props: { items: [{ label: 'A' }, { label: 'BB' }] } }] };
  const out = computeDiff(before, after);
  const replace = out.jsonPatch.find((o) => o.op === PATCH.REPLACE);
  assert.ok(replace);
  assert.equal(replace.path, '/nodes/0/props/items/1/label');
  assert.equal(replace.value, 'BB');
});

// ---------------------------------------------------------------------------
// Key rename (remove + add)
// ---------------------------------------------------------------------------

test('renaming a key emits remove + add', () => {
  const before = { props: { oldName: 1 } };
  const after = { props: { newName: 1 } };
  const out = computeDiff(before, after);
  const ops = new Set(out.jsonPatch.map((o) => o.op + ' ' + o.path));
  assert.ok(ops.has('remove /props/oldName'), 'expected remove /props/oldName');
  assert.ok(ops.has('add /props/newName'), 'expected add /props/newName');
});

// ---------------------------------------------------------------------------
// Type mismatch → replace
// ---------------------------------------------------------------------------

test('type mismatch (object vs array) is a single replace', () => {
  const out = computeDiff({ foo: { a: 1 } }, { foo: [1, 2] });
  const replace = out.jsonPatch.find((o) => o.op === PATCH.REPLACE && o.path === '/foo');
  assert.ok(replace, 'expected replace at /foo');
});

// ---------------------------------------------------------------------------
// JSON Pointer escaping (RFC 6901)
// ---------------------------------------------------------------------------

test('encodePointer escapes ~ and /', () => {
  assert.equal(encodePointer(['a~b']), '/a~0b');
  assert.equal(encodePointer(['a/b']), '/a~1b');
  // Per RFC 6901 each token is escaped independently; '/' is the separator.
  assert.equal(encodePointer(['a~', '/b']), '/a~0/~1b');
  assert.equal(encodePointer([]), '');
});

test('pointer escape survives in a real diff', () => {
  const before = { 'weird/key': { 'a~b': 1 } };
  const after = { 'weird/key': { 'a~b': 2 } };
  const out = computeDiff(before, after);
  const replace = out.jsonPatch.find((o) => o.op === PATCH.REPLACE);
  assert.equal(replace.path, '/weird~1key/a~0b');
});

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

test('projectLines walks the model and emits node descriptors', () => {
  const model = {
    nodes: [
      { id: 'n1', kind: 'component', name: 'Hero', props: { title: 'Hi' } },
      { id: 'n2', kind: 'component', name: 'Footer' },
    ],
  };
  const lines = projectLines(model);
  // We expect one descriptor per node-shaped object.
  const nodeDescriptors = lines.filter((l) => l.text.startsWith('<node'));
  assert.equal(nodeDescriptors.length, 2);
  // id=, kind=, name= all surface in the descriptor.
  const idLine = lines.find((l) => l.text.includes('id='));
  const kindLine = lines.find((l) => l.text.includes('kind=component'));
  assert.ok(idLine && kindLine);
  // props/title is a primitive line — path is /nodes/0/props/title.
  const titleLine = lines.find((l) => l.path === '/nodes/0/props/title');
  assert.ok(titleLine, 'expected a line for props/title');
  assert.match(titleLine.text, /title = "Hi"/);
});

// ---------------------------------------------------------------------------
// JSON Patch ops are valid RFC 6902
// ---------------------------------------------------------------------------

test('every op has op/path and add/replace has value', () => {
  const before = { a: 1, b: { c: [1, 2] } };
  const after = { a: 2, b: { c: [1, 2, 3] }, d: 'new' };
  const ops = computeJsonPatch(before, after);
  for (const o of ops) {
    assert.ok(['add', 'remove', 'replace', 'move', 'copy', 'test'].includes(o.op), 'op kind');
    assert.equal(typeof o.path, 'string');
    if (o.op === PATCH.ADD || o.op === PATCH.REPLACE) {
      assert.ok('value' in o, `${o.op} must have value`);
    }
    if (o.op === PATCH.REMOVE) {
      assert.ok(!('value' in o), 'remove must not carry value');
    }
  }
});

// ---------------------------------------------------------------------------
// Deep equality
// ---------------------------------------------------------------------------

test('deepEqual handles nested objects, arrays, and primitives', () => {
  assert.ok(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] }));
  assert.ok(!deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 3 }] }));
  assert.ok(deepEqual([1, 2, 3], [1, 2, 3]));
  assert.ok(!deepEqual([1, 2, 3], [1, 2, 4]));
  assert.ok(deepEqual(null, null));
  assert.ok(!deepEqual(null, undefined));
  assert.ok(deepEqual('x', 'x'));
  assert.ok(!deepEqual('x', 'y'));
});

// ---------------------------------------------------------------------------
// Summary wording
// ---------------------------------------------------------------------------

test('summary pluralises correctly', () => {
  const one = computeDiff({ a: 1 }, { a: 2 });
  assert.match(one.summary, /1 replace/);
  assert.equal(one.summary, '0 adds, 0 removes, 1 replace');
  const two = computeDiff({ a: 1 }, { b: 2 });
  assert.match(two.summary, /1 add/);
  assert.match(two.summary, /1 remove/);
  const many = computeDiff({ a: 1, b: 2 }, { a: 1, b: 2, c: 3, d: 4 });
  assert.match(many.summary, /2 adds/);
});
