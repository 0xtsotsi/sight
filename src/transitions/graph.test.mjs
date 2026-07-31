import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTransitionGraph,
  findSharedNames,
  formatEdge,
  pickLastTransition,
  layoutGraph,
} from './graph.js';

const page = (rel, route) => ({ rel, name: rel.split('/').pop(), route });

// --- buildTransitionGraph -----------------------------------------------

test('buildTransitionGraph returns empty graph for empty inputs', () => {
  const g = buildTransitionGraph([], []);
  assert.deepEqual(g.nodes, []);
  assert.deepEqual(g.edges, []);
});

test('buildTransitionGraph produces a node per page, even with no transitions', () => {
  const pages = [page('src/pages/index.astro', '/'), page('src/pages/about.astro', '/about')];
  const g = buildTransitionGraph(pages, []);
  assert.equal(g.nodes.length, 2);
  assert.equal(g.nodes[0].route, '/');
  assert.equal(g.nodes[0].transitionCount, 0);
  assert.equal(g.nodes[1].transitionCount, 0);
});

test('buildTransitionGraph emits no edges when no transition:name is shared', () => {
  const pages = [page('src/pages/index.astro', '/'), page('src/pages/about.astro', '/about')];
  const ts = [
    { kind: 'name', value: 'hero', page: pages[0], line: 1, col: 1 },
    { kind: 'name', value: 'about-title', page: pages[1], line: 1, col: 1 },
  ];
  const g = buildTransitionGraph(pages, ts);
  assert.equal(g.nodes.length, 2);
  assert.equal(g.edges.length, 0);
});

test('buildTransitionGraph emits one edge per shared transition:name', () => {
  const pages = [page('src/pages/index.astro', '/'), page('src/pages/about.astro', '/about')];
  const ts = [
    { kind: 'name', value: 'hero', page: pages[0], line: 1, col: 1 },
    { kind: 'name', value: 'hero', page: pages[1], line: 1, col: 1 },
    { kind: 'name', value: 'cta', page: pages[0], line: 2, col: 1 },
    { kind: 'name', value: 'cta', page: pages[1], line: 2, col: 1 },
  ];
  const g = buildTransitionGraph(pages, ts);
  assert.equal(g.edges.length, 2);
  assert.ok(g.edges.find((e) => e.name === 'hero'));
  assert.ok(g.edges.find((e) => e.name === 'cta'));
});

test('buildTransitionGraph counts occurrences per side', () => {
  const pages = [page('src/pages/a.astro', '/a'), page('src/pages/b.astro', '/b')];
  const ts = [
    { kind: 'name', value: 'h', page: pages[0], line: 1, col: 1 },
    { kind: 'name', value: 'h', page: pages[0], line: 2, col: 1 },
    { kind: 'name', value: 'h', page: pages[1], line: 1, col: 1 },
  ];
  const g = buildTransitionGraph(pages, ts);
  assert.equal(g.edges.length, 1);
  assert.deepEqual(g.edges[0].occurrences, { a: 2, b: 1 });
});

test('buildTransitionGraph matches transition:name and view-transition-name', () => {
  const pages = [page('src/pages/a.astro', '/a'), page('src/pages/b.astro', '/b')];
  const ts = [
    { kind: 'name', value: 'h', page: pages[0], line: 1, col: 1 },
    { kind: 'vt-name', value: 'h', page: pages[1], line: 1, col: 1 },
  ];
  const g = buildTransitionGraph(pages, ts);
  assert.equal(g.edges.length, 1);
  assert.equal(g.edges[0].name, 'h');
});

test('buildTransitionGraph does not link pages via transition:animate alone', () => {
  const pages = [page('src/pages/a.astro', '/a'), page('src/pages/b.astro', '/b')];
  const ts = [
    { kind: 'animate', value: 'fade', page: pages[0], line: 1, col: 1 },
    { kind: 'animate', value: 'fade', page: pages[1], line: 1, col: 1 },
  ];
  const g = buildTransitionGraph(pages, ts);
  assert.equal(g.edges.length, 0);
});

test('buildTransitionGraph transitionCount includes names and animates', () => {
  const pages = [page('src/pages/a.astro', '/a')];
  const ts = [
    { kind: 'name', value: 'h', page: pages[0], line: 1, col: 1 },
    { kind: 'name', value: 'h2', page: pages[0], line: 2, col: 1 },
    { kind: 'animate', value: 'slide', page: pages[0], line: 3, col: 1 },
  ];
  const g = buildTransitionGraph(pages, ts);
  assert.equal(g.nodes[0].transitionCount, 3);
});

test('buildTransitionGraph promotes a transition-only page into a node', () => {
  // A layout-level transition with no corresponding page in the scan: the
  // graph still has to show that file so the user can see where the name
  // comes from.
  const pages = [page('src/pages/a.astro', '/a')];
  const ts = [
    { kind: 'name', value: 'h', page: pages[0], line: 1, col: 1 },
    { kind: 'name', value: 'h', page: { rel: 'src/layouts/Base.astro' }, line: 1, col: 1 },
  ];
  const g = buildTransitionGraph(pages, ts);
  const ids = g.nodes.map((n) => n.id);
  assert.ok(ids.includes('src/layouts/Base.astro'));
  assert.equal(g.edges.length, 1);
});

test('buildTransitionGraph edges are sorted for stable rendering', () => {
  const pages = [
    page('src/pages/b.astro', '/b'),
    page('src/pages/a.astro', '/a'),
  ];
  const ts = [
    { kind: 'name', value: 'z', page: pages[0], line: 1, col: 1 },
    { kind: 'name', value: 'z', page: pages[1], line: 1, col: 1 },
    { kind: 'name', value: 'a', page: pages[0], line: 2, col: 1 },
    { kind: 'name', value: 'a', page: pages[1], line: 2, col: 1 },
  ];
  const g = buildTransitionGraph(pages, ts);
  assert.equal(g.edges[0].name, 'a');
  assert.equal(g.edges[1].name, 'z');
});

test('buildTransitionGraph nodes are sorted by route', () => {
  const pages = [
    page('src/pages/b.astro', '/b'),
    page('src/pages/a.astro', '/a'),
    page('src/pages/index.astro', '/'),
  ];
  const g = buildTransitionGraph(pages, []);
  assert.equal(g.nodes[0].route, '/');
  assert.equal(g.nodes[1].route, '/a');
  assert.equal(g.nodes[2].route, '/b');
});

test('buildTransitionGraph ignores transitions whose page is missing', () => {
  const pages = [];
  const ts = [{ kind: 'name', value: 'h', page: { rel: 'src/pages/gone.astro' }, line: 1, col: 1 }];
  const g = buildTransitionGraph(pages, ts);
  // The orphan transition still produces a node (so it's not silently dropped),
  // but the page list stays empty.
  assert.equal(g.nodes.length, 1);
  assert.equal(g.nodes[0].id, 'src/pages/gone.astro');
});

// --- findSharedNames ----------------------------------------------------

test('findSharedNames returns the intersection, sorted', () => {
  const a = { transitions: [
    { kind: 'name', value: 'hero' },
    { kind: 'name', value: 'cta' },
    { kind: 'animate', value: 'fade' }, // not a name — must be ignored
  ] };
  const b = { transitions: [
    { kind: 'name', value: 'cta' },
    { kind: 'name', value: 'hero' },
    { kind: 'name', value: 'footer' },
  ] };
  assert.deepEqual(findSharedNames(a, b), ['cta', 'hero']);
});

test('findSharedNames treats transition:name and view-transition-name as the same set', () => {
  const a = { transitions: [{ kind: 'name', value: 'h' }] };
  const b = { transitions: [{ kind: 'vt-name', value: 'h' }] };
  assert.deepEqual(findSharedNames(a, b), ['h']);
});

test('findSharedNames returns [] when nothing matches', () => {
  const a = { transitions: [{ kind: 'name', value: 'x' }] };
  const b = { transitions: [{ kind: 'name', value: 'y' }] };
  assert.deepEqual(findSharedNames(a, b), []);
});

test('findSharedNames deduplicates repeated values on either side', () => {
  const a = { transitions: [
    { kind: 'name', value: 'h' },
    { kind: 'name', value: 'h' },
  ] };
  const b = { transitions: [
    { kind: 'name', value: 'h' },
    { kind: 'name', value: 'h' },
  ] };
  assert.deepEqual(findSharedNames(a, b), ['h']);
});

// --- formatEdge ---------------------------------------------------------

test('formatEdge shows the basenames and the shared name', () => {
  const edge = {
    from: 'src/pages/index.astro',
    to: 'src/pages/about.astro',
    name: 'hero',
    occurrences: { a: 1, b: 1 },
  };
  assert.equal(formatEdge(edge), 'index.astro ⇄ about.astro — name: hero (1×/1×)');
});

test('formatEdge omits the ratio when occurrences are missing', () => {
  const edge = { from: 'a.astro', to: 'b.astro', name: 'x' };
  assert.equal(formatEdge(edge), 'a.astro ⇄ b.astro — name: x');
});

test('formatEdge returns an empty string for a falsy edge', () => {
  assert.equal(formatEdge(null), '');
  assert.equal(formatEdge(undefined), '');
});

// --- pickLastTransition -------------------------------------------------

test('pickLastTransition prefers the file with the most recent mtime', () => {
  const t1 = { kind: 'name', value: 'h', page: { rel: 'a.astro' }, line: 100, col: 1 };
  const t2 = { kind: 'name', value: 'h', page: { rel: 'b.astro' }, line: 1, col: 1 };
  const mtimes = { 'a.astro': 100, 'b.astro': 200 };
  assert.equal(pickLastTransition([t1, t2], mtimes), t2);
});

test('pickLastTransition falls back to line number when mtimes tie', () => {
  const t1 = { kind: 'name', value: 'h', page: { rel: 'a.astro' }, line: 1, col: 1 };
  const t2 = { kind: 'name', value: 'h', page: { rel: 'a.astro' }, line: 5, col: 1 };
  assert.equal(pickLastTransition([t1, t2], { 'a.astro': 100 }), t2);
});

test('pickLastTransition returns null for an empty list', () => {
  assert.equal(pickLastTransition([], {}), null);
  assert.equal(pickLastTransition(null, {}), null);
});

// --- layoutGraph --------------------------------------------------------

test('layoutGraph places every node inside the viewBox', () => {
  const pages = [
    page('src/pages/a.astro', '/a'),
    page('src/pages/b.astro', '/b'),
    page('src/pages/c.astro', '/c'),
  ];
  const ts = [
    { kind: 'name', value: 'h', page: pages[0], line: 1, col: 1 },
    { kind: 'name', value: 'h', page: pages[1], line: 1, col: 1 },
    { kind: 'name', value: 'h', page: pages[2], line: 1, col: 1 },
  ];
  const g = buildTransitionGraph(pages, ts);
  const laid = layoutGraph(g, { width: 400, height: 300, padding: 30 });
  for (const n of g.nodes) {
    const p = laid.positions.get(n.id);
    assert.ok(p.x >= 0 && p.x <= 400, `${n.id} x out of range: ${p.x}`);
    assert.ok(p.y >= 0 && p.y <= 300, `${n.id} y out of range: ${p.y}`);
  }
});

test('layoutGraph is deterministic for the same input', () => {
  const pages = [
    page('src/pages/b.astro', '/b'),
    page('src/pages/a.astro', '/a'),
  ];
  const ts = [
    { kind: 'name', value: 'h', page: pages[0], line: 1, col: 1 },
    { kind: 'name', value: 'h', page: pages[1], line: 1, col: 1 },
  ];
  const g = buildTransitionGraph(pages, ts);
  const a = layoutGraph(g, { width: 400, height: 300 });
  const b = layoutGraph(g, { width: 400, height: 300 });
  for (const n of g.nodes) {
    assert.deepEqual(a.positions.get(n.id), b.positions.get(n.id));
  }
});

test('layoutGraph returns an empty positions map when the graph is empty', () => {
  const laid = layoutGraph({ nodes: [], edges: [] });
  assert.equal(laid.positions.size, 0);
});
