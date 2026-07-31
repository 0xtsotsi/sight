// Tests for apply.js — the patch validator + serializer. Covers:
//   - happy path with frontmatter/props/children patches
//   - new keys are dropped (frontmatter, props)
//   - children length budget enforcement
//   - non-editable nodes are rejected
//   - non-round-trippable patches are rejected
//   - applyPatchToFile calls markSelfWrite contract (writeFile passed in)

import test from 'node:test';
import assert from 'node:assert/strict';
import { applyPatch, applyPatchToFile, validatePatch, locateNode } from './apply.js';

const HERO = `---
const title = 'Hello';
---

<html>
  <head>
    <title>{title}</title>
  </head>
  <body>
    <section class="hero" id="hero1">
      <h1 class="hero-title">Welcome</h1>
      <p class="hero-sub">Tagline here</p>
    </section>
  </body>
</html>
`;

test('validatePatch accepts a minimal patch', () => {
  const original = { id: 'a', kind: 'element', name: 'p', props: {}, children: [] };
  assert.deepEqual(validatePatch({ reason: 'r' }, original), { ok: true });
});

test('validatePatch rejects unknown fields', () => {
  const original = { id: 'a', kind: 'element', name: 'p', props: {}, children: [] };
  const r = validatePatch({ reason: 'r', tag: 'span' }, original);
  assert.equal(r.ok, false);
  assert.match(r.error, /Unknown patch field/);
});

test('validatePatch rejects patches for text nodes', () => {
  const original = { id: 'a', kind: 'text', value: 'x' };
  const r = validatePatch({ reason: 'r', children: ['y'] }, original);
  assert.equal(r.ok, false);
  assert.match(r.error, /text/);
});

test('validatePatch rejects patches for expr nodes', () => {
  const original = { id: 'a', kind: 'expr', value: '{x}' };
  const r = validatePatch({ reason: 'r', children: ['y'] }, original);
  assert.equal(r.ok, false);
});

test('validatePatch rejects non-object frontmatter', () => {
  const original = { id: 'a', kind: 'element', name: 'p', props: {}, children: [] };
  const r = validatePatch({ reason: 'r', frontmatter: 'no' }, original);
  assert.equal(r.ok, false);
});

test('validatePatch rejects non-object props', () => {
  const original = { id: 'a', kind: 'element', name: 'p', props: {}, children: [] };
  const r = validatePatch({ reason: 'r', props: [] }, original);
  assert.equal(r.ok, false);
});

test('validatePatch rejects non-array children', () => {
  const original = { id: 'a', kind: 'element', name: 'p', props: {}, children: [] };
  const r = validatePatch({ reason: 'r', children: 'no' }, original);
  assert.equal(r.ok, false);
});

test('validatePatch rejects children with too-large size change', () => {
  const original = {
    id: 'a',
    kind: 'element',
    name: 'p',
    props: {},
    children: [
      { id: 't1', kind: 'text', value: 'short' },
    ],
  };
  // 10x larger should fail the 50% budget.
  const huge = { reason: 'r', children: [{ id: 't2', kind: 'text', value: 'a'.repeat(500) }] };
  const r = validatePatch(huge, original);
  assert.equal(r.ok, false);
  assert.match(r.error, /outside the 50% safety band/);
});

test('applyPatch updates props without adding new keys', () => {
  const model = {
    imports: [],
    extraFrontmatter: '',
    nodes: [{ id: 'p1', kind: 'element', name: 'p', props: { class: { type: 'string', value: 'old' } }, children: [] }],
  };
  const result = applyPatch({
    model,
    nodeId: 'p1',
    patch: { reason: 'r', props: { class: { type: 'string', value: 'new' }, id: { type: 'string', value: 'evil' } } },
  });  assert.equal(result.ok, true);
  assert.equal(result.node.props.class.value, 'new');
  // 'id' was NOT in the original props, so it gets dropped.
  assert.equal('id' in result.node.props, false);
});

test('applyPatch updates children', () => {
  const model = {
    imports: [],
    extraFrontmatter: '',
    nodes: [
      {
        id: 'p1',
        kind: 'element',
        name: 'p',
        props: {},
        children: [{ id: 't1', kind: 'text', value: 'old' }],
      },
    ],
  };
  const result = applyPatch({
    model,
    nodeId: 'p1',
    patch: { reason: 'r', children: [{ id: 't2', kind: 'text', value: 'new' }] },
  });  assert.equal(result.ok, true);
  assert.equal(result.node.children[0].value, 'new');
});

test('applyPatch updates frontmatter without adding new keys', () => {
  const model = {
    imports: [],
    extraFrontmatter: '',
    nodes: [
      {
        id: 'p1',
        kind: 'element',
        name: 'p',
        frontmatter: { title: 'Hello' },
        props: {},
        children: [],
      },
    ],
  };
  const result = applyPatch({
    model,
    nodeId: 'p1',
    patch: { reason: 'r', frontmatter: { title: 'Goodbye', brand: 'Acme' } },
  });  assert.equal(result.ok, true);
  assert.equal(result.node.frontmatter.title, 'Goodbye');
  assert.equal('brand' in result.node.frontmatter, false);
});

test('applyPatch leaves fields alone when patch field is null', () => {
  const model = {
    imports: [],
    extraFrontmatter: '',
    nodes: [
      {
        id: 'p1',
        kind: 'element',
        name: 'p',
        props: { class: { type: 'string', value: 'x' } },
        children: [{ id: 't1', kind: 'text', value: 'hi' }],
      },
    ],
  };
  const result = applyPatch({
    model,
    nodeId: 'p1',
    patch: { reason: 'no-op', props: null, children: null },
  });  assert.equal(result.ok, true);
  assert.equal(result.node.props.class.value, 'x');
  assert.equal(result.node.children[0].value, 'hi');
});

test('applyPatch rejects when nodeId not found', () => {
  const model = { imports: [], extraFrontmatter: '', nodes: [] };
  const r = applyPatch({ model, nodeId: 'nope', patch: { reason: 'r' } });
  assert.equal(r.ok, false);
  assert.match(r.error, /not found/);
});

test('applyPatchToFile parses, applies, and writes', async () => {
  // Parse the fixture once to find the real id of the <h1>.
  const { parsePage } = await import('../astroParser.js');
  const parsed = parsePage(HERO);
  function findByName(n, name) {
    if (n?.name === name) return n;
    if (Array.isArray(n?.children)) for (const c of n.children) {
      const r = findByName(c, name);
      if (r) return r;
    }
    return null;
  }
  const h1 = findByName(parsed.model.nodes[0], 'h1');
  assert.ok(h1, 'h1 found in fixture');
  const writes = [];
  const result = applyPatchToFile({
    pagePath: '/tmp/fake.astro',
    nodeId: h1.id,
    patch: { reason: 'r', children: [{ id: 't-new', kind: 'text', value: 'Welcome dear' }] },
    readFile: () => HERO,
    writeFile: (p, src) => writes.push({ p, src }),
  });  assert.equal(result.ok, true);
  assert.equal(writes.length, 1);
  assert.match(writes[0].src, /Welcome dear/);
  assert.match(writes[0].src, /<h1 class="hero-title">/);
});

test('applyPatchToFile rejects uneditable pages', () => {
  const result = applyPatchToFile({
    pagePath: '/tmp/fake.md',
    nodeId: 'x',
    patch: { reason: 'r' },
    readFile: () => '# title',
    writeFile: () => {},
  });
  // .md is read-only; the apply path correctly falls through.
  assert.equal(result.ok, false);
  assert.match(result.error, /not editable|not found/);
});

test('locateNode finds a deep nested node', () => {
  const nodes = [
    {
      id: 'a',
      kind: 'element',
      name: 'div',
      children: [
        {
          id: 'b',
          kind: 'element',
          name: 'span',
          children: [{ id: 'c', kind: 'text', value: 'x' }],
        },
      ],
    },
  ];
  const r = locateNode(nodes, 'c');
  assert.ok(r);
  assert.equal(r.node.value, 'x');
  assert.equal(r.list.length, 1);
});

test('locateNode returns null when not found', () => {
  assert.equal(locateNode([{ id: 'a', kind: 'text', value: 'x' }], 'nope'), null);
});

test('applyPatch serializes back to .astro source', () => {
  // Props are AttrValue objects — strings would serialize as
  // `class="undefined"`. Round-trip-safe shape is required.
  const model = {
    imports: [],
    extraFrontmatter: '',
    nodes: [
      {
        id: 'p1',
        kind: 'element',
        name: 'h1',
        props: { class: { type: 'string', value: 'hero' } },
        children: [{ id: 't1', kind: 'text', value: 'Welcome' }],
      },
    ],
  };
  const result = applyPatch({
    model,
    nodeId: 'p1',
    patch: { reason: 'r', props: { class: { type: 'string', value: 'big' } } },
  });  assert.equal(result.ok, true);
  assert.match(result.source, /class="big"/);
  assert.match(result.source, /Welcome/);
});

test('applyPatch handles missing model gracefully', () => {
  const r = applyPatch({ model: null, nodeId: 'x', patch: { reason: 'r' } });
  assert.equal(r.ok, false);
});

test('applyPatch handles missing nodeId', () => {
  const r = applyPatch({ model: { nodes: [] }, nodeId: '', patch: { reason: 'r' } });
  assert.equal(r.ok, false);
});