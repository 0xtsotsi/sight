// Pure data transforms for the Transitions panel.
//
// Inputs come from `electron/transitions/scanner.js`, which walks the project's
// `src/pages/**/*.astro` and `src/layouts/**/*.astro` and reports each
// transition directive it finds. This module is responsible for turning that
// flat list into the graph the panel renders, plus a few helpers the panel
// needs to pick "the last transition" and to format edges for the SVG.
//
// Everything here is pure: no DOM, no I/O, no electron. The tests in
// `graph.test.mjs` run with `node --test` and pin behavior from inputs to
// outputs so the SVG can change layout without risk.

// A `transition` row as the scanner returns it:
//   { kind: 'name' | 'animate' | 'vt-name',
//     value: string,                 // the directive's value
//     page: { rel, name, route },    // owning page
//     line: number,                  // 1-based line in the source file
//     col: number,                   // 1-based column
//   }
//
// A `page` row:
//   { rel, name, route }

// Build the graph.
//
// `pages` is the full list of pages the project scanned (even ones without
// transitions — they still appear as isolated nodes).
// `transitions` is the list of transition directives.
//
// Returns { nodes, edges } where:
//   nodes: [{ id, rel, name, route, transitionCount }]
//   edges: [{ from, to, name, occurrences: number }]
//
// An edge connects two pages that share at least one `transition:name`
// (or `view-transition-name`). Multiple shared names produce one edge per
// name — Astro's matching key is the name, so two pages sharing two names
// have two independent morph relations. `occurrences` is the count of
// distinct directive instances on each side summed.
export function buildTransitionGraph(pages, transitions) {
  const pageByRel = new Map();
  for (const p of pages || []) pageByRel.set(p.rel, p);

  // Per-page: how many of each name. One edge per name, weighted by how
  // many times each side used it.
  const nameByPage = new Map(); // rel -> Map(name -> count)
  const otherByPage = new Map(); // rel -> count of non-name directives

  for (const t of transitions || []) {
    const rel = t.page?.rel;
    if (!rel) continue;
    if (t.kind === 'name' || t.kind === 'vt-name') {
      let perPage = nameByPage.get(rel);
      if (!perPage) {
        perPage = new Map();
        nameByPage.set(rel, perPage);
      }
      perPage.set(t.value, (perPage.get(t.value) || 0) + 1);
    } else if (t.kind === 'animate') {
      otherByPage.set(rel, (otherByPage.get(rel) || 0) + 1);
    }
  }

  // Pair every page with every other page exactly once. Pairs are stored
  // under a sorted key so the same pair registered from either side maps
  // to the same slot.
  const edgeMap = new Map(); // key -> { from, to, name, occurrences: { a, b } }
  const sortedRels = [...nameByPage.keys()].sort();
  for (let i = 0; i < sortedRels.length; i++) {
    for (let j = i + 1; j < sortedRels.length; j++) {
      const a = sortedRels[i];
      const b = sortedRels[j];
      const aNames = nameByPage.get(a);
      const bNames = nameByPage.get(b);
      for (const [name, aCount] of aNames) {
        if (!bNames.has(name)) continue;
        const key = `${a}\u0000${b}\u0000${name}`;
        edgeMap.set(key, {
          from: a,
          to: b,
          name,
          occurrences: { a: aCount, b: bNames.get(name) },
        });
      }
    }
  }

  // Sort edges by (from, to, name) so the panel's list view is stable.
  const edges = [...edgeMap.values()].sort((x, y) => {
    return (
      x.from.localeCompare(y.from) ||
      x.to.localeCompare(y.to) ||
      x.name.localeCompare(y.name)
    );
  });

  // Build nodes: every page in the project, not just the ones that use
  // transitions — a project might have many pages that never appear in
  // any name pair, and dropping them would hide work in progress.
  const seenRels = new Set();
  const nodes = [];
  for (const t of transitions || []) {
    if (t.page?.rel && !seenRels.has(t.page.rel)) {
      seenRels.add(t.page.rel);
      const p = pageByRel.get(t.page.rel) || t.page;
      const names = nameByPage.get(p.rel) || new Map();
      nodes.push({
        id: p.rel,
        rel: p.rel,
        name: p.name,
        route: p.route,
        transitionCount: (names.size || 0) + (otherByPage.get(p.rel) || 0),
      });
    }
  }
  for (const p of pages || []) {
    if (seenRels.has(p.rel)) continue;
    seenRels.add(p.rel);
    nodes.push({ id: p.rel, rel: p.rel, name: p.name, route: p.route, transitionCount: 0 });
  }

  // Edges reference a node id we just built; if a transition came from a
  // page that's not in the scan's page list (e.g. a layout-only transition
  // with no page reference), promote it into a node so the graph stays
  // connected.
  const knownRels = new Set(nodes.map((n) => n.id));
  for (const e of edges) {
    for (const side of ['from', 'to']) {
      if (!knownRels.has(e[side])) {
        nodes.push({
          id: e[side],
          rel: e[side],
          name: basename(e[side]),
          route: routeForRel(e[side]),
          transitionCount: 0,
        });
        knownRels.add(e[side]);
      }
    }
  }

  // Route may be missing on synthetic nodes — re-sort by (route, rel) so
  // the panel's list view stays stable regardless of input order.
  nodes.sort((a, b) => {
    const r = (a.route || '').localeCompare(b.route || '');
    return r || a.rel.localeCompare(b.rel);
  });

  return { nodes, edges };
}

// Best-effort route for a rel: "src/pages/blog/post.astro" → "/blog/post".
// Layouts and other non-page files get a rel-based label rather than a
// bogus URL.
function routeForRel(rel) {
  if (!rel) return '';
  if (rel.startsWith('src/pages/')) {
    return '/' + rel.slice('src/pages/'.length).replace(/\.astro$/, '');
  }
  return '';
}

// Names shared between two specific pages (Astro matches by name — the
// same value on each side, e.g. `transition:name="hero"`). Returns an
// array of strings, sorted.
export function findSharedNames(a, b) {
  if (!a || !b) return [];
  const aSet = new Set();
  for (const t of a.transitions || []) {
    if (t.kind === 'name' || t.kind === 'vt-name') aSet.add(t.value);
  }
  const out = [];
  for (const t of b.transitions || []) {
    if ((t.kind === 'name' || t.kind === 'vt-name') && aSet.has(t.value)) {
      out.push(t.value);
    }
  }
  return [...new Set(out)].sort();
}

// Format an edge for the panel's list. Example:
//   "index.astro ⇄ about.astro — name: hero (1×/1×)"
// The arrows and ratio follow Astro's terminology: each side has its own
// count of directive instances, and a 1×/2× pairing still works (Astro
// matches by name, not by index).
export function formatEdge(edge) {
  if (!edge) return '';
  const a = basename(edge.from);
  const b = basename(edge.to);
  const occ =
    edge.occurrences && (edge.occurrences.a != null || edge.occurrences.b != null)
      ? ` (${edge.occurrences.a || 0}×/${edge.occurrences.b || 0}×)`
      : '';
  return `${a} ⇄ ${b} — name: ${edge.name}${occ}`;
}

// "Last transition" = the most recently authored one. The scanner reports
// each transition with its file and line; we sort by (line desc, col desc)
// inside the same file, then by file mtime (caller passes `fileMtimes`).
// Returns the transition row or null.
export function pickLastTransition(transitions, fileMtimes = {}) {
  if (!transitions || !transitions.length) return null;
  const sorted = [...transitions].sort((a, b) => {
    const ma = fileMtimes[a.page?.rel] || 0;
    const mb = fileMtimes[b.page?.rel] || 0;
    if (ma !== mb) return mb - ma;
    if ((a.line || 0) !== (b.line || 0)) return (b.line || 0) - (a.line || 0);
    return (b.col || 0) - (a.col || 0);
  });
  return sorted[0] || null;
}

// Simple basename for display: "src/pages/blog/post.astro" → "post.astro".
function basename(rel) {
  if (!rel) return '';
  const parts = String(rel).split('/');
  return parts[parts.length - 1] || rel;
}

// Layout a graph for the SVG. A small radial-ish layout that puts
// high-degree pages near the center. Not a force-directed sim — the panel
// re-renders on every selection, and a stable layout is more useful than
// one that wiggles.
//
// Returns { width, height, positions: Map(rel -> { x, y }) } in viewBox
// coordinates. The SVG scales to fit its container.
export function layoutGraph(graph, { width = 720, height = 480, padding = 60 } = {}) {
  const positions = new Map();
  const nodes = graph?.nodes || [];
  const edges = graph?.edges || [];
  if (!nodes.length) return { width, height, positions };

  const degree = new Map();
  for (const n of nodes) degree.set(n.id, 0);
  for (const e of edges) {
    degree.set(e.from, (degree.get(e.from) || 0) + 1);
    degree.set(e.to, (degree.get(e.to) || 0) + 1);
  }

  // Sort by degree desc, then route asc — the same input always gets the
  // same layout, no animation jitter when the user toggles a selection.
  const ordered = [...nodes].sort((a, b) => {
    const d = (degree.get(b.id) || 0) - (degree.get(a.id) || 0);
    return d || a.route.localeCompare(b.route);
  });

  // Spaced ring: the first node sits at the top, the rest circle clockwise.
  // Ring radius shrinks as nodes pile in so the layout never spills past
  // the viewBox.
  const cx = width / 2;
  const cy = height / 2;
  const minRadius = Math.min(width, height) / 2 - padding;
  const step = (Math.PI * 2) / Math.max(1, ordered.length);
  ordered.forEach((n, i) => {
    const angle = -Math.PI / 2 + i * step;
    positions.set(n.id, {
      x: cx + Math.cos(angle) * minRadius,
      y: cy + Math.sin(angle) * minRadius,
    });
  });

  return { width, height, positions };
}
