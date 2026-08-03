import test from 'node:test';
import assert from 'node:assert/strict';
import { diffNodes, summarizeDiff } from './diff.js';

test('detects a changed prop', () => {
  const before = { id: 'p', kind: 'element', name: 'h1', props: { class: 'old' }, children: [] };
  const after = { id: 'p', kind: 'element', name: 'h1', props: { class: 'new' }, children: [] };
  const d = diffNodes(before, after, { topLevel: 'props' });
  assert.equal(d.length, 1);
  assert.equal(d[0].kind, 'changed');
  assert.equal(d[0].path, 'class');
});

test('detects an added prop key', () => {
  const before = { id: 'p', kind: 'element', name: 'h1', props: {}, children: [] };
  const after = { id: 'p', kind: 'element', name: 'h1', props: { class: 'x' }, children: [] };
  const d = diffNodes(before, after, { topLevel: 'props' });
  assert.equal(d.length, 1);
  assert.equal(d[0].kind, 'added');
});

test('detects a removed prop key', () => {
  const before = { id: 'p', kind: 'element', name: 'h1', props: { class: 'x' }, children: [] };
  const after = { id: 'p', kind: 'element', name: 'h1', props: {}, children: [] };
  const d = diffNodes(before, after, { topLevel: 'props' });
  assert.equal(d.length, 1);
  assert.equal(d[0].kind, 'removed');
});

test('skips unchanged entries', () => {
  const before = { id: 'p', kind: 'element', name: 'h1', props: { class: 'x' }, children: [] };
  const after = { id: 'p', kind: 'element', name: 'h1', props: { class: 'x' }, children: [] };
  const d = diffNodes(before, after, { topLevel: 'props' });
  assert.equal(d.length, 0);
});

test('detects children list change with size diff', () => {
  const before = { id: 'p', kind: 'element', name: 'p', props: {}, children: [{ id: 't', kind: 'text', value: 'a' }] };
  const after = { id: 'p', kind: 'element', name: 'p', props: {}, children: [{ id: 't', kind: 'text', value: 'a' }, { id: 'u', kind: 'text', value: 'b' }] };
  const d = diffNodes(before, after, { topLevel: 'children' });
  assert.equal(d.length, 1);
  assert.equal(d[0].kind, 'list-changed');
  assert.equal(d[0].sizeBefore, 1);
  assert.equal(d[0].sizeAfter, 2);
  assert.equal(d[0].added, 1);
  assert.equal(d[0].removed, 0);
});

test('handles nested object changes', () => {
  const before = {
    id: 'p', kind: 'element', name: 'p',
    props: { style: { color: 'red' } },
    children: [],
  };
  const after = {
    id: 'p', kind: 'element', name: 'p',
    props: { style: { color: 'blue' } },
    children: [],
  };
  const d = diffNodes(before, after, { topLevel: 'props' });
  assert.equal(d.length, 1);
  assert.equal(d[0].path, 'style.color');
  assert.equal(d[0].kind, 'changed');
});

test('handles missing original or patched', () => {
  const d1 = diffNodes(null, { props: {} }, { topLevel: 'props' });
  assert.equal(d1.length, 1);
  const d2 = diffNodes({ props: {} }, null, { topLevel: 'props' });
  assert.equal(d2.length, 1);
  const d3 = diffNodes(null, null, { topLevel: 'props' });
  assert.equal(d3.length, 0);
});

test('multiple top-level sections', () => {
  const before = { id: 'p', kind: 'element', name: 'p', props: { class: 'x' }, children: [], frontmatter: { t: 'a' } };
  const after = { id: 'p', kind: 'element', name: 'p', props: { class: 'y' }, children: [], frontmatter: { t: 'b' } };
  const d = diffNodes(before, after, { topLevel: ['props', 'frontmatter'] });
  assert.equal(d.length, 2);
});

test('summarizeDiff handles empty', () => {
  assert.equal(summarizeDiff([]), 'No changes');
});

test('summarizeDiff counts kinds', () => {
  const d = [
    { kind: 'changed', path: 'a' },
    { kind: 'changed', path: 'b' },
    { kind: 'added', path: 'c' },
    { kind: 'removed', path: 'd' },
    { kind: 'list-changed', path: 'e' },
  ];
  assert.equal(summarizeDiff(d), '2 changed, 1 added, 1 removed, 1 list changed');
});

test('summarizeDiff pluralization', () => {
  const d = [
    { kind: 'list-changed', path: 'a' },
    { kind: 'list-changed', path: 'b' },
  ];
  assert.equal(summarizeDiff(d), '2 lists changed');
});

test('detects array length removal', () => {
  const before = { id: 'p', kind: 'element', name: 'p', props: {}, children: [{ id: 'a', kind: 'text', value: 'x' }, { id: 'b', kind: 'text', value: 'y' }] };
  const after = { id: 'p', kind: 'element', name: 'p', props: {}, children: [{ id: 'a', kind: 'text', value: 'x' }] };
  const d = diffNodes(before, after, { topLevel: 'children' });
  assert.equal(d.length, 1);
  assert.equal(d[0].kind, 'list-changed');
  assert.equal(d[0].removed, 1);
});

test('value-object diffs compare their value field', () => {
  // AttrValues are stored as { type, value }. The diff should compare the
  // primitive value.
  const before = { id: 'p', kind: 'element', name: 'a', props: { href: { type: 'string', value: '/old' } }, children: [] };
  const after = { id: 'p', kind: 'element', name: 'a', props: { href: { type: 'string', value: '/new' } }, children: [] };
  const d = diffNodes(before, after, { topLevel: 'props' });
  assert.equal(d.length, 1);
  assert.equal(d[0].path, 'href');
  assert.equal(d[0].kind, 'changed');
});

test('unchanged deep object produces no entries', () => {
  const before = { id: 'p', kind: 'element', name: 'p', props: { style: { color: 'red', background: 'blue' } }, children: [] };
  const after = { id: 'p', kind: 'element', name: 'p', props: { style: { color: 'red', background: 'blue' } }, children: [] };
  const d = diffNodes(before, after, { topLevel: 'props' });
  assert.equal(d.length, 0);
});

test('numeric value diff', () => {
  const before = { id: 'p', kind: 'element', name: 'input', props: { maxlength: { type: 'number', value: 5 } }, children: [] };
  const after = { id: 'p', kind: 'element', name: 'input', props: { maxlength: { type: 'number', value: 8 } }, children: [] };
  const d = diffNodes(before, after, { topLevel: 'props' });
  assert.equal(d.length, 1);
  assert.equal(d[0].kind, 'changed');
});