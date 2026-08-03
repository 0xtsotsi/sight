// Scans a project's Astro source for view-transition directives.
//
//   transition:name="hero"          → kind 'name',  value 'hero'
//   transition:animate="fade"       → kind 'animate', value 'fade'
//   style="view-transition-name: h" → kind 'vt-name', value 'h'
//   style="view-transition-name:h"  → same (no whitespace after the colon)
//
// Layouts (src/layouts/**) are scanned too, because a shared morph often
// lives on the layout that wraps every page — naming the layout's element
// 'hero' makes every page in the project participate in the morph without
// the page itself needing the directive. Pages are still the primary axis
// of the graph: the scanner groups everything by the file it was found in,
// then the renderer promotes files that only appear as the target of an
// edge (a layout with no matching page) into a node of their own.
//
// Read-only. The watcher in main.js reloads the scan on change.
//
// Skips: node_modules, dist, .astro, .git, anything dotfile-prefixed,
// files larger than 1 MB (a malformed project shouldn't wedge the scan).

const fs = require('fs');
const path = require('path');

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.astro', '.vscode']);
const MAX_BYTES = 1024 * 1024;

// Page → route from filesystem path. "src/pages/index.astro" → "/",
// "src/pages/blog/[slug].astro" → "/blog/:slug" (Astro's runtime form),
// "src/pages/blog/post.astro" → "/blog/post". A trailing "index" drops
// the file portion; a leading "src/pages" is stripped.
function relToRoute(rel) {
  if (!rel.startsWith('src/pages/')) return '';
  let p = rel.slice('src/pages/'.length).replace(/\.astro$/, '');
  if (p === 'index' || p === '') return '/';
  if (p.endsWith('/index')) p = p.slice(0, -'/index'.length);
  // [param] → :param for the route label; brackets in the URL would be
  // ugly in the panel.
  p = p.replace(/\[(\w+)\]/g, ':$1');
  return '/' + p;
}

// A `transition:foo` directive — the directive name is in group 1, the
// value (quoted or braced) in group 2. We only act on the two names Astro
// 5 documents: `name` and `animate`. `transition:persist` exists too but
// takes no string value to share, so it's outside this panel's scope.
//
// The braced form is matched in `parseBracedExpr` below: a simple
// `\{([^}]*)\}` would stop at the first `}`, but Astro authors write
// things like `transition:animate={fade({ duration: 200 })}` — a balanced
// capture is required.
const DIRECTIVE_HEAD_RE = /\btransition:(name|animate)\s*=\s*/g;

// `view-transition-name` inside a style attribute, with optional
// whitespace, terminating semicolon, !important, or end of declaration.
const VT_RE = /\bview-transition-name\s*:\s*([^;"'!]+)/gi;

// `transition:animate` may take a function reference: animate={fade({duration: 200})}
// The raw expression is returned; the panel renders it as-is and lets the
// user recognize their own animation by name. Unwrapping `{...}` to the
// function ident (`fade` from the example) is a future step.
function unwrapExpr(raw) {
  if (!raw) return '';
  const t = raw.trim();
  if (t.startsWith('{') && t.endsWith('}')) return t.slice(1, -1).trim();
  return t;
}

// Returns { transitions, pages } for the project. Pages are listed even if
// they have no transitions, so the graph still shows them as nodes.
function scanProject(projectPath) {
  const out = { transitions: [], pages: [] };
  if (!projectPath) return out;

  const seen = new Set();
  const walk = (dir, relBase) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(full, rel);
      } else if (entry.isFile() && /\.astro$/i.test(entry.name)) {
        if (seen.has(rel)) continue;
        seen.add(rel);
        processFile(full, rel, out);
      }
    }
  };

  // Pages are the primary axis; layouts can be the *target* of a name pair
  // (a layout defines the shared element, every page inherits it). The
  // scan still produces transitions for both, and the graph renderer
  // promotes any layout-only file into a node of its own.
  walkPages(projectPath, walk);
  walkLayouts(projectPath, walk);

  // Stable order: by (rel, line, col). The panel re-renders on every
  // update, and a stable list makes the diff readable.
  out.transitions.sort((a, b) => {
    return (
      (a.page?.rel || '').localeCompare(b.page?.rel || '') ||
      (a.line || 0) - (b.line || 0) ||
      (a.col || 0) - (b.col || 0)
    );
  });
  out.pages.sort((a, b) => a.route.localeCompare(b.route));
  return out;
}

function walkPages(projectPath, walk) {
  const pagesRoot = path.join(projectPath, 'src', 'pages');
  if (fs.existsSync(pagesRoot)) walk(pagesRoot, 'src/pages');
}

function walkLayouts(projectPath, walk) {
  const layoutsRoot = path.join(projectPath, 'src', 'layouts');
  if (fs.existsSync(layoutsRoot)) walk(layoutsRoot, 'src/layouts');
}

// After `transition:foo=` has matched at position `from`, read the value
// at `from`. Returns { value, consumed } where `value` is the unwrapped
// string (without the surrounding quotes/braces) and `consumed` is the
// number of characters the next match should start past — so the loop
// can advance past a `}` that's not the close of the original `{`.
function parseAttrValue(line, from) {
  if (from >= line.length) return null;
  const ch = line[from];
  if (ch === '"' || ch === "'") {
    const close = line.indexOf(ch, from + 1);
    if (close === -1) return null;
    return { value: line.slice(from + 1, close), consumed: close - from + 1 };
  }
  if (ch === '{') {
    // Balanced brace match, skipping over string/template literals.
    let depth = 1;
    let i = from + 1;
    while (i < line.length && depth > 0) {
      const c = line[i];
      if (c === '"' || c === "'" || c === '`') {
        const close = line.indexOf(c, i + 1);
        if (close === -1) return null;
        i = close + 1;
        continue;
      }
      if (c === '{') depth++;
      else if (c === '}') depth--;
      i++;
    }
    if (depth !== 0) return null;
    return { value: unwrapExpr(line.slice(from, i)), consumed: i - from };
  }
  // Bareword — only the first non-whitespace run, e.g. `transition:name=foo`.
  const m = /^[^\s>"'={}]+/.exec(line.slice(from));
  if (!m) return null;
  return { value: m[0], consumed: m[0].length };
}

function processFile(absPath, rel, out) {
  let source;
  try {
    const stat = fs.statSync(absPath);
    if (stat.size > MAX_BYTES) return; // skip — probably generated / wrong file
    source = fs.readFileSync(absPath, 'utf8');
  } catch {
    return;
  }

  // Pages register themselves even if no directive is found; layouts
  // register only when they actually carry a transition (a layout without
  // one is irrelevant to the panel and would just add noise to the page
  // list).
  const isPage = rel.startsWith('src/pages/');
  const route = isPage ? relToRoute(rel) : '';
  if (isPage) {
    out.pages.push({ rel, name: path.basename(rel), route });
  }

  // Per-line scan: lines are 1-based, columns are 1-based. We work line
  // by line so the column reported to the user lines up with what they'd
  // see in their editor (CodeMirror uses 1-based, 0-based numbers).
  const lines = source.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;

    // transition:name / transition:animate
    DIRECTIVE_HEAD_RE.lastIndex = 0;
    let m;
    while ((m = DIRECTIVE_HEAD_RE.exec(line)) !== null) {
      const kind = m[1] === 'name' ? 'name' : 'animate';
      const headEnd = m.index + m[0].length;
      const tail = parseAttrValue(line, headEnd);
      if (!tail) continue;
      DIRECTIVE_HEAD_RE.lastIndex = headEnd + tail.consumed;
      const raw = tail.value;
      if (!raw) continue;
      out.transitions.push({
        kind,
        value: raw,
        page: { rel, name: path.basename(rel), route },
        line: lineNo,
        col: m.index + 1,
      });
    }

    // view-transition-name (inside a style="..." attribute, typically)
    VT_RE.lastIndex = 0;
    while ((m = VT_RE.exec(line)) !== null) {
      const value = (m[1] || '').trim();
      if (!value) continue;
      out.transitions.push({
        kind: 'vt-name',
        value,
        page: { rel, name: path.basename(rel), route },
        line: lineNo,
        col: m.index + 1,
      });
    }
  }

}

module.exports = { scanProject, relToRoute, unwrapExpr };
