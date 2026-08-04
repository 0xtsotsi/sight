// ⌘K Command Palette — registry of every command the palette can surface.
//
// Pure module: no React, no Electron. Filtering is testable in plain Node, and
// the palette can be replaced/swapped without touching the entry definitions.
//
// Entry shape: { id, group, label, hint, keywords, perform, isAvailable }
//   - id:        stable string used as the cmdk value and the React key.
//   - group:     one of COMMAND_GROUPS — the order rendered in the palette.
//   - label:     primary text shown in the result row.
//   - hint:      short secondary line (keyboard hint or sublabel).
//   - keywords:  extra searchable strings (synonyms, tags) joined with `perform`
//                and `isAvailable` for filter matching.
//   - perform:   () => void — guarded, no-op safe to call any time.
//   - isAvailable: (ctx) => boolean — palette hides entries that return false.

export const COMMAND_GROUPS = ['Actions', 'Files', 'Nodes', 'AI', 'Deploy'];

// Pure helpers — exported so the test suite can exercise them directly.

const lc = (s) => (s == null ? '' : String(s)).toLowerCase();

/**
 * Score an entry against a query. Returns -1 for "no match", otherwise a
 * non-negative integer — lower is better. Empty query always matches with
 * score 0 so registry order is preserved on the initial open.
 *
 * Strategy (cheap, not true fuzzy):
 *   0  empty query       — keeps source order
 *   1  label startswith  — best
 *   2  label includes    — second-best
 *   3  word-boundary hit — third
 *   4  keyword/hint hit  — fallback
 */
export function scoreEntry(entry, q) {
  if (!q) return 0;
  const label = lc(entry.label);
  const hint = lc(entry.hint);
  const kw = lc(entry.keywords);
  if (label.startsWith(q)) return 1;
  // word-boundary: query appears at the start of a word inside label (not
  // mid-word like "phone" inside "smartphone"). Strictly better than the
  // blanket substring match below.
  if (new RegExp('(?:^|\\b)' + escapeRegex(q)).test(label)) return 2;
  if (label.includes(q)) return 3;
  if (kw && kw.includes(q)) return 4;
  if (hint && hint.includes(q)) return 5;
  return -1;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Filter a registry against a query string, dropping unavailable entries and
 * preserving score ties by registry order. Always returns a fresh array — never
 * mutates the input.
 */
export function filter(registry, query) {
  const q = lc(query.trim());
  const out = [];
  for (let i = 0; i < registry.length; i++) {
    const entry = registry[i];
    if (typeof entry.isAvailable === 'function' && !entry.isAvailable(entry._ctx || null)) continue;
    const score = scoreEntry(entry, q);
    if (score >= 0) out.push({ entry, score, index: i });
  }
  out.sort((a, b) => a.score - b.score || a.index - b.index);
  return out.map((r) => r.entry);
}

// Walk a model.nodes tree and yield each node in source order (depth-first).
export function walkNodes(nodes) {
  const out = [];
  const visit = (list) => {
    for (const n of list || []) {
      out.push(n);
      if (Array.isArray(n.children)) visit(n.children);
    }
  };
  visit(nodes);
  return out;
}

// A friendly label for a node kind — components carry their name, elements
// their tag, text/expr use a snippet. Frontmatter shows up as "Frontmatter".
export function describeNode(node) {
  if (!node) return '';
  if (node.id === 'frontmatter' || node.kind === 'frontmatter') return 'Frontmatter';
  if (node.kind === 'component') return `<${node.name || 'Component'}>`;
  if (node.kind === 'element') {
    const tag = node.tag || node.name || 'element';
    return `<${tag}>`;
  }
  if (node.kind === 'text') {
    const v = String(node.value || '').trim();
    return v ? `Text: ${v.length > 24 ? v.slice(0, 24) + '…' : v}` : 'Text';
  }
  if (node.kind === 'expr') {
    const v = String(node.value || '').trim();
    return v ? `{ ${v.length > 24 ? v.slice(0, 24) + '…' : v} }` : '{ … }';
  }
  if (node.kind === 'fragment') return 'Fragment';
  return node.kind || 'node';
}

/**
 * Build the full registry for the current app context. The caller passes in
 * everything the entries might need (project, page, model, selection, settings,
 * recents, callbacks) — the registry stays pure.
 *
 * @param {object} ctx
 * @param {object|null} ctx.project          the opened project (null on welcome)
 * @param {object|null} ctx.page             current page entry from the edit stack
 * @param {object|null} ctx.model            current editable model (pageState?.model)
 * @param {string|null} ctx.selection        currently selected node id
 * @param {object} ctx.settings              { device, inPreview, … }
 * @param {Array}  ctx.recents               list of recent projects
 * @param {object} ctx.actions               bound callbacks from App.jsx
 */
export function buildRegistry(ctx) {
  const {
    project,
    page,
    model,
    selection,
    settings = {},
    recents = [],
    actions = {},
  } = ctx || {};

  const entries = [];

  // ────────────────────────── Actions ──────────────────────────
  entries.push({
    id: 'action.toggle-preview',
    group: 'Actions',
    label: settings.inPreview ? 'Exit preview' : 'Toggle preview',
    hint: 'Open or close the live site preview',
    keywords: 'preview toggle site interactive',
    isAvailable: () => !!project,
    perform: () => actions.togglePreview && actions.togglePreview(),
  });

  entries.push({
    id: 'action.switch-device-desktop',
    group: 'Actions',
    label: 'Preview: Desktop',
    hint: 'Switch the preview viewport to desktop',
    keywords: 'device breakpoint viewport responsive',
    isAvailable: () => !!project,
    perform: () => actions.setDevice && actions.setDevice('desktop'),
  });

  entries.push({
    id: 'action.switch-device-tablet',
    group: 'Actions',
    label: 'Preview: Tablet',
    hint: 'Switch the preview viewport to tablet',
    keywords: 'device breakpoint viewport responsive ipad',
    isAvailable: () => !!project,
    perform: () => actions.setDevice && actions.setDevice('tablet'),
  });

  entries.push({
    id: 'action.switch-device-phone',
    group: 'Actions',
    label: 'Preview: Phone',
    hint: 'Switch the preview viewport to phone',
    keywords: 'device breakpoint viewport responsive mobile',
    isAvailable: () => !!project,
    perform: () => actions.setDevice && actions.setDevice('phone'),
  });

  entries.push({
    id: 'action.open-devtools',
    group: 'Actions',
    label: 'Open DevTools',
    hint: 'Open Chromium DevTools for the preview',
    keywords: 'devtools inspect console network',
    isAvailable: () => !!project && typeof actions.openDevTools === 'function',
    perform: () => actions.openDevTools && actions.openDevTools(),
  });

  entries.push({
    id: 'action.check-updates',
    group: 'Actions',
    label: 'Check for updates',
    hint: 'Ask electron-updater for a new release',
    keywords: 'update upgrade version release',
    isAvailable: () => typeof actions.checkForUpdates === 'function',
    perform: () => actions.checkForUpdates && actions.checkForUpdates(),
  });

  entries.push({
    id: 'action.open-settings',
    group: 'Actions',
    label: 'Open Settings',
    hint: 'Show the right-rail settings panel',
    keywords: 'settings preferences panel right tab',
    isAvailable: () => !!project && typeof actions.openSettings === 'function',
    perform: () => actions.openSettings && actions.openSettings(),
  });

  entries.push({
    id: 'action.refresh-preview',
    group: 'Actions',
    label: 'Refresh preview',
    hint: 'Reload the current preview route',
    keywords: 'refresh reload iframe',
    isAvailable: () => !!project && typeof actions.refreshPreview === 'function',
    perform: () => actions.refreshPreview && actions.refreshPreview(),
  });

  entries.push({
    id: 'action.undo',
    group: 'Actions',
    label: 'Undo',
    hint: '⌘Z — undo the last edit',
    keywords: 'undo history revert',
    isAvailable: () => !!project && typeof actions.undo === 'function',
    perform: () => actions.undo && actions.undo(),
  });

  entries.push({
    id: 'action.redo',
    group: 'Actions',
    label: 'Redo',
    hint: '⇧⌘Z — redo the last undone edit',
    keywords: 'redo history',
    isAvailable: () => !!project && typeof actions.redo === 'function',
    perform: () => actions.redo && actions.redo(),
  });

  entries.push({
    id: 'action.open-insert-palette',
    group: 'Actions',
    label: 'Insert element',
    hint: '⌘F / ⌘E — open the quick-insert palette',
    keywords: 'insert element add palette component',
    isAvailable: () => !!project && typeof actions.openInsertPalette === 'function',
    perform: () => actions.openInsertPalette && actions.openInsertPalette(),
  });

  entries.push({
    id: 'action.open-panel-pages',
    group: 'Actions',
    label: 'Show Pages panel',
    hint: 'Open the left-rail Pages list',
    keywords: 'panel pages navigator left rail',
    isAvailable: () => !!project && typeof actions.setLeftTab === 'function',
    perform: () => actions.setLeftTab && actions.setLeftTab('pages'),
  });

  entries.push({
    id: 'action.open-panel-navigator',
    group: 'Actions',
    label: 'Show Navigator',
    hint: 'Open the structure tree in the left rail',
    keywords: 'panel navigator structure tree left rail',
    isAvailable: () => !!project && typeof actions.setLeftTab === 'function',
    perform: () => actions.setLeftTab && actions.setLeftTab('navigator'),
  });

  entries.push({
    id: 'action.open-panel-components',
    group: 'Actions',
    label: 'Show Components palette',
    hint: 'Open the components palette in the left rail',
    keywords: 'panel components palette left rail insertable',
    isAvailable: () => !!project && typeof actions.setLeftTab === 'function',
    perform: () => actions.setLeftTab && actions.setLeftTab('components'),
  });

  entries.push({
    id: 'action.open-panel-assets',
    group: 'Actions',
    label: 'Show Assets panel',
    hint: 'Open the assets library in the left rail',
    keywords: 'panel assets library images left rail',
    isAvailable: () => !!project && typeof actions.setLeftTab === 'function',
    perform: () => actions.setLeftTab && actions.setLeftTab('assets'),
  });

  entries.push({
    id: 'action.open-panel-cms',
    group: 'Actions',
    label: 'Show CMS panel',
    hint: 'Open the CMS editor in the left rail',
    keywords: 'panel cms json data left rail content',
    isAvailable: () => !!project && typeof actions.setLeftTab === 'function',
    perform: () => actions.setLeftTab && actions.setLeftTab('cms'),
  });

  // ────────────────────────── Files ──────────────────────────
  // Every .astro the project scan surfaced — pages, layouts, components.
  const fileEntries = [];
  const seen = new Set();

  const addFile = (f, kind) => {
    if (!f || !f.path) return;
    if (seen.has(f.path)) return;
    seen.add(f.path);
    const name = f.name || f.path.split('/').pop();
    fileEntries.push({
      id: `file.${kind}.${f.path}`,
      group: 'Files',
      label: name,
      hint: f.path,
      keywords: `${f.path} ${kind}`,
      isAvailable: () => !!project,
      perform: () => actions.openFile && actions.openFile(f),
    });
  };

  if (project) {
    // scan shape varies slightly between callers — accept pages/components/layouts
    const scan = actions.scan || {};
    const pages = scan.pages || [];
    const components = scan.components || [];
    const layouts = scan.layouts || [];
    pages.forEach((p) => addFile(p, 'page'));
    components.forEach((c) => addFile(c, 'component'));
    layouts.forEach((l) => addFile(l, 'layout'));
  }

  // ────────────────────────── Recents (under Files) ──────────────────────────
  const recentEntries = (recents || []).slice(0, 8).map((r, i) => ({
    id: `recent.${i}.${r.path || r.name}`,
    group: 'Files',
    label: `Open recent: ${r.name || r.path}`,
    hint: r.path,
    keywords: 'recent project open',
    isAvailable: () => !!r.path && typeof actions.openRecent === 'function',
    perform: () => actions.openRecent && actions.openRecent(r.path),
  }));

  // ────────────────────────── Nodes ──────────────────────────
  const nodeEntries = [];
  if (project && model && model.nodes) {
    const nodes = walkNodes(model.nodes);
    for (const n of nodes) {
      const desc = describeNode(n);
      nodeEntries.push({
        id: `node.${n.id}`,
        group: 'Nodes',
        label: desc,
        hint: n.kind ? `kind: ${n.kind}` : '',
        keywords: `${n.kind || ''} ${n.name || n.tag || ''}`,
        isAvailable: () => !!project && !!model,
        perform: () => actions.jumpToNode && actions.jumpToNode(n.id),
      });
    }
    // Frontmatter shows up too, but only when the page is editable.
    if (page && page.kind === 'page' && typeof actions.jumpToNode === 'function') {
      nodeEntries.unshift({
        id: 'node.frontmatter',
        group: 'Nodes',
        label: 'Frontmatter',
        hint: 'page frontmatter',
        keywords: 'frontmatter yaml page meta',
        isAvailable: () => !!project && !!model,
        perform: () => actions.jumpToNode && actions.jumpToNode('frontmatter'),
      });
    }
  }

  // ────────────────────────── AI (Feature 8 placeholder) ──────────────────────────
  const aiEntries = [
    {
      id: 'ai.coming-soon',
      group: 'AI',
      label: 'AI inline-edit (coming soon)',
      hint: 'BYOK Anthropic / OpenAI / Ollama — Feature 8',
      keywords: 'ai anthropic openai ollama edit',
      isAvailable: () => false,
      perform: () => {},
    },
  ];

  // ────────────────────────── Deploy (Feature 10 placeholder) ──────────────────────────
  const deployEntries = [
    {
      id: 'deploy.coming-soon',
      group: 'Deploy',
      label: 'Deploy (coming soon)',
      hint: 'Vercel / Netlify / Cloudflare Pages — Feature 10',
      keywords: 'deploy vercel netlify cloudflare publish',
      isAvailable: () => false,
      perform: () => {},
    },
  ];

  // Stitch the final registry in canonical group order, preserving source order
  // within each group. The cmdk filter keeps the array order for ties.
  const ordered = [
    ...entries,
    ...fileEntries,
    ...recentEntries,
    ...nodeEntries,
    ...aiEntries,
    ...deployEntries,
  ];

  // Pin the current ctx onto each entry so isAvailable can see it without
  // callers rebuilding the registry every render.
  for (const e of ordered) e._ctx = { project, page, model, selection, settings, recents };
  return ordered;
}

// ---------------------------------------------------------------------------
// Slash menu (M2)
//
// The composer's `/` keystroke surfaces a picker of these commands. Each
// entry maps to a string that gets inserted at the caret (e.g. "/pick ")
// and an optional auto-submit. The list is intentionally small and stable —
// `getAgentSlashCommands` is exported so the test suite can verify the
// exact count of 11.
// ---------------------------------------------------------------------------

const SLASH_COMMANDS = [
  { id: 'edit', label: 'edit', hint: 'edit the current selection', insert: '/edit ' },
  { id: 'new', label: 'new', hint: 'create a new component', insert: '/new ' },
  { id: 'fix', label: 'fix', hint: 'fix the bug described below', insert: '/fix ' },
  { id: 'explain', label: 'explain', hint: 'explain how this works', insert: '/explain ' },
  { id: 'refactor', label: 'refactor', hint: 'refactor for clarity', insert: '/refactor ' },
  { id: 'style', label: 'style', hint: 'restyle with the design system', insert: '/style ' },
  { id: 'test', label: 'test', hint: 'write a test for this', insert: '/test ' },
  { id: 'docs', label: 'docs', hint: 'write documentation', insert: '/docs ' },
  { id: 'review', label: 'review', hint: 'review the diff', insert: '/review ' },
  { id: 'commit', label: 'commit', hint: 'commit pending changes', insert: '/commit ' },
  { id: 'undo', label: 'undo', hint: 'undo the last change', insert: '/undo' },
];

export function getAgentSlashCommands() {
  return SLASH_COMMANDS.map((c) => ({ ...c }));
}
