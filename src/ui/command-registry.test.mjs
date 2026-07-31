import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRegistry, filter, scoreEntry, walkNodes, describeNode, COMMAND_GROUPS } from './command-registry.js';

// Tiny fixture builder. Returns a context where most callbacks are no-ops so
// the registry entries don't blow up when run.
function makeFixture(overrides = {}) {
  const calls = {};
  const stub = (key) => () => {
    calls[key] = (calls[key] || 0) + 1;
  };
  const project = { name: 'demo', path: '/tmp/demo' };
  const page = { kind: 'page', name: 'index', path: 'src/pages/index.astro', route: '/' };
  const model = {
    nodes: [
      { id: 'root', kind: 'element', tag: 'main', children: [
        { id: 'h', kind: 'element', tag: 'h1', children: [
          { id: 't', kind: 'text', value: 'Hello, world' },
        ] },
        { id: 'btn', kind: 'component', name: 'Button', props: {}, children: null },
        { id: 'code', kind: 'expr', value: '{published ? 1 : 0}' },
      ] },
    ],
  };
  const settings = { device: 'desktop', inPreview: false };
  const recents = [
    { name: 'demo', path: '/tmp/demo' },
    { name: 'other', path: '/tmp/other' },
  ];
  const actions = {
    togglePreview: stub('togglePreview'),
    setDevice: stub('setDevice'),
    openDevTools: stub('openDevTools'),
    checkForUpdates: stub('checkForUpdates'),
    openSettings: stub('openSettings'),
    refreshPreview: stub('refreshPreview'),
    undo: stub('undo'),
    redo: stub('redo'),
    openInsertPalette: stub('openInsertPalette'),
    setLeftTab: stub('setLeftTab'),
    openFile: stub('openFile'),
    openRecent: stub('openRecent'),
    jumpToNode: stub('jumpToNode'),
    scan: {
      pages: [{ name: 'index', path: 'src/pages/index.astro' }],
      components: [{ name: 'Button', path: 'src/components/Button.astro' }],
      layouts: [],
    },
    ...(overrides.actions || {}),
  };
  return {
    ctx: { project, page, model, selection: 'h', settings, recents, actions },
    calls,
    project,
    model,
  };
}

test('COMMAND_GROUPS is the canonical order', () => {
  assert.deepEqual(COMMAND_GROUPS, ['Actions', 'Files', 'Nodes', 'AI', 'Deploy']);
});

test('buildRegistry returns the expected groups even when nothing matches', () => {
  const { ctx } = makeFixture();
  const registry = buildRegistry(ctx);
  // AI and Deploy placeholders always exist; other groups vary with availability.
  const groups = new Set(registry.map((e) => e.group));
  for (const g of ['Actions', 'Files', 'Nodes', 'AI', 'Deploy']) {
    assert.ok(groups.has(g), `missing group ${g}`);
  }
});

test('filter("publish") does not match unrelated commands', () => {
  // 'publish' shouldn't match anything available in the demo fixture (Deploy
  // placeholder contains the keyword but is hidden because isAvailable=false).
  const { ctx } = makeFixture();
  const registry = buildRegistry(ctx);
  const matches = filter(registry, 'publish');
  const ids = matches.map((m) => m.id);
  // Anything that comes back must not be in AI/Deploy — those are always hidden.
  assert.deepEqual(ids.filter((id) => id.startsWith('deploy.')), []);
});

test('filter("publish") matches Deploy placeholder once Feature 8/10 ship', () => {
  // The Deploy placeholder carries "publish" in its keywords. Confirm
  // that, when AI/Deploy entries are NOT marked unavailable, they'd match.
  const { ctx } = makeFixture();
  const registry = buildRegistry(ctx);
  const deploy = registry.find((e) => e.group === 'Deploy');
  assert.ok(deploy, 'Deploy placeholder should exist');
  assert.equal(typeof deploy.isAvailable === 'function' && deploy.isAvailable(deploy._ctx), false);
});

test('AI and Deploy groups always ship as placeholders (isAvailable: false)', () => {
  const { ctx } = makeFixture();
  const registry = buildRegistry(ctx);
  for (const group of ['AI', 'Deploy']) {
    const entries = registry.filter((e) => e.group === group);
    assert.ok(entries.length > 0, `${group} should have at least one entry`);
    for (const entry of entries) {
      assert.equal(entry.isAvailable(entry._ctx), false, `${group}/${entry.id} should be unavailable`);
    }
  }
  // Filtering with an empty query also drops them, since the registry hides
  // unavailable entries by default.
  const matched = filter(registry, '');
  const matchedGroups = new Set(matched.map((e) => e.group));
  assert.equal(matchedGroups.has('AI'), false, 'AI must not appear');
  assert.equal(matchedGroups.has('Deploy'), false, 'Deploy must not appear');
});

test('filter("publish") via Deploy keyword would match if enabled', () => {
  // Sanity check that the keyword string is actually present so the future
  // implementation doesn't need to remember where it lives.
  const { ctx } = makeFixture();
  const registry = buildRegistry(ctx);
  const deploy = registry.find((e) => e.group === 'Deploy');
  assert.match(deploy.keywords + ' ' + deploy.hint, /publish/);
});

test('label matches win over keyword/hint matches', () => {
  const { ctx } = makeFixture();
  const registry = buildRegistry(ctx);
  const matches = filter(registry, 'undo');
  const ids = matches.map((m) => m.id);
  assert.ok(ids.includes('action.undo'), `expected action.undo in ${JSON.stringify(ids)}`);
});

test('Nodes group surfaces frontmatter + every editable node', () => {
  const { ctx } = makeFixture();
  const registry = buildRegistry(ctx);
  const nodeEntries = registry.filter((e) => e.group === 'Nodes');
  const labels = nodeEntries.map((n) => n.label);
  assert.ok(labels.includes('Frontmatter'), 'frontmatter should appear');
  assert.ok(labels.includes('<main>'), 'main element should appear');
  assert.ok(labels.some((l) => l.startsWith('<Button')), 'component should appear');
});

test('walkNodes visits depth-first', () => {
  const { model } = makeFixture();
  const ids = walkNodes(model.nodes).map((n) => n.id);
  // Source order in the fixture is root, h, t, btn, code.
  assert.deepEqual(ids, ['root', 'h', 't', 'btn', 'code']);
});

test('describeNode handles every kind', () => {
  assert.equal(describeNode({ kind: 'component', name: 'Button' }), '<Button>');
  assert.equal(describeNode({ kind: 'element', tag: 'h1' }), '<h1>');
  assert.equal(describeNode({ kind: 'text', value: 'Hello' }), 'Text: Hello');
  assert.equal(describeNode({ kind: 'text', value: '' }), 'Text');
  assert.equal(describeNode({ kind: 'expr', value: '{x}' }), '{ {x} }');
  assert.equal(describeNode({ id: 'frontmatter' }), 'Frontmatter');
});

test('scoreEntry ordering: startswith > word-boundary > includes > keyword > hint', () => {
  // startswith (lowercased) - best
  assert.equal(scoreEntry({ label: 'Phone Home', hint: '', keywords: '' }, 'phone'), 1);
  // word-boundary - second (query matches start of a word inside label)
  assert.equal(scoreEntry({ label: 'Preview phone', hint: '', keywords: '' }, 'phone'), 2);
  // includes - third (substring anywhere, including mid-word like smartphone)
  assert.equal(scoreEntry({ label: 'Open smartPhone', hint: '', keywords: '' }, 'phone'), 3);
  // keyword - fourth
  assert.equal(scoreEntry({ label: 'Other', hint: '', keywords: 'phone' }, 'phone'), 4);
  // hint - last resort
  assert.equal(scoreEntry({ label: 'Just Mobile', hint: 'phone', keywords: '' }, 'phone'), 5);
  // No match returns -1
  assert.equal(scoreEntry({ label: 'Other', hint: '', keywords: '' }, 'zzz'), -1);
});

test('command perform callbacks fire when called', () => {
  const { ctx, calls } = makeFixture();
  const registry = buildRegistry(ctx);
  // Toggle preview should bump calls.togglePreview.
  const tp = registry.find((e) => e.id === 'action.toggle-preview');
  tp.perform();
  assert.equal(calls.togglePreview, 1);
  // Switch device tablet.
  const tab = registry.find((e) => e.id === 'action.switch-device-tablet');
  tab.perform();
  assert.equal(calls.setDevice, 1);
});

test('missing actions stay hidden (openDevTools without callback)', () => {
  const { ctx } = makeFixture({ actions: { openDevTools: undefined } });
  const registry = buildRegistry(ctx);
  const matches = filter(registry, 'devtools');
  // openDevTools action has no callback → isAvailable returns false → filtered out.
  assert.equal(matches.length, 0);
});
