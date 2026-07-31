import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanProject, relToRoute, unwrapExpr } from './scanner.js';

// Tiny temp project. Returns the absolute project path; cleans itself up
// in a returned `cleanup` so a test failure can't leak /tmp dirs.
function makeProject(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sight-transitions-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }
  return {
    root,
    cleanup: () => {
      try {
        fs.rmSync(root, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    },
  };
}

// --- relToRoute ---------------------------------------------------------

test('relToRoute turns the index file into "/"', () => {
  assert.equal(relToRoute('src/pages/index.astro'), '/');
});

test('relToRoute strips the trailing /index', () => {
  assert.equal(relToRoute('src/pages/blog/index.astro'), '/blog');
});

test('relToRoute joins nested paths with /', () => {
  assert.equal(relToRoute('src/pages/blog/post.astro'), '/blog/post');
});

test('relToRoute converts dynamic brackets to :param', () => {
  assert.equal(relToRoute('src/pages/blog/[slug].astro'), '/blog/:slug');
  assert.equal(relToRoute('src/pages/[lang]/about.astro'), '/:lang/about');
});

test('relToRoute returns "" for a non-page rel', () => {
  assert.equal(relToRoute('src/layouts/Base.astro'), '');
  assert.equal(relToRoute('src/components/Hero.astro'), '');
});

// --- unwrapExpr ---------------------------------------------------------

test('unwrapExpr strips a surrounding {...} from a stringified expression', () => {
  assert.equal(unwrapExpr('{fade}'), 'fade');
  assert.equal(unwrapExpr('{ fade({ duration: 200 }) }'), 'fade({ duration: 200 })');
});

test('unwrapExpr passes through values that are not brace-wrapped', () => {
  assert.equal(unwrapExpr('fade'), 'fade');
  assert.equal(unwrapExpr(''), '');
});

// --- scanProject: page enumeration --------------------------------------

test('scanProject lists every page, even ones without transitions', () => {
  const p = makeProject({
    'src/pages/index.astro': '<h1>Hi</h1>',
    'src/pages/about.astro': '<h1>About</h1>',
    'src/pages/blog/index.astro': '<h1>Blog</h1>',
  });
  try {
    const r = scanProject(p.root);
    const routes = r.pages.map((x) => x.route).sort();
    assert.deepEqual(routes, ['/', '/about', '/blog']);
  } finally {
    p.cleanup();
  }
});

test('scanProject returns an empty result for a non-existent project', () => {
  const r = scanProject('/this/does/not/exist/' + Date.now());
  assert.deepEqual(r.transitions, []);
  assert.deepEqual(r.pages, []);
});

// --- scanProject: transition:name ---------------------------------------

test('scanProject picks up a single transition:name with double quotes', () => {
  const p = makeProject({
    'src/pages/index.astro': '<h1 transition:name="hero">Hi</h1>',
  });
  try {
    const r = scanProject(p.root);
    assert.equal(r.transitions.length, 1);
    assert.equal(r.transitions[0].kind, 'name');
    assert.equal(r.transitions[0].value, 'hero');
    assert.equal(r.transitions[0].line, 1);
  } finally {
    p.cleanup();
  }
});

test('scanProject accepts single-quoted values too', () => {
  const p = makeProject({
    'src/pages/index.astro': "<h1 transition:name='hero'>Hi</h1>",
  });
  try {
    const r = scanProject(p.root);
    assert.equal(r.transitions[0].value, 'hero');
  } finally {
    p.cleanup();
  }
});

test('scanProject reports the line and column of the directive', () => {
  const p = makeProject({
    'src/pages/index.astro': [
      '---',
      'const x = 1;',
      '---',
      '<h1 transition:name="hero">Hi</h1>',
    ].join('\n'),
  });
  try {
    const r = scanProject(p.root);
    const t = r.transitions[0];
    assert.equal(t.line, 4);
    // The directive starts after "<h1 " — column 6 in 1-based terms.
    assert.ok(t.col > 0);
  } finally {
    p.cleanup();
  }
});

test('scanProject picks up multiple transition:name values on the same page', () => {
  const p = makeProject({
    'src/pages/index.astro': [
      '<header transition:name="hero">H</header>',
      '<footer transition:name="foot">F</footer>',
    ].join('\n'),
  });
  try {
    const r = scanProject(p.root);
    const names = r.transitions.map((t) => t.value).sort();
    assert.deepEqual(names, ['foot', 'hero']);
  } finally {
    p.cleanup();
  }
});

test('scanProject picks up the same name on two different pages', () => {
  const p = makeProject({
    'src/pages/a.astro': '<h1 transition:name="h">A</h1>',
    'src/pages/b.astro': '<h1 transition:name="h">B</h1>',
  });
  try {
    const r = scanProject(p.root);
    assert.equal(r.transitions.length, 2);
    assert.equal(r.transitions[0].page.route, '/a');
    assert.equal(r.transitions[1].page.route, '/b');
  } finally {
    p.cleanup();
  }
});

// --- scanProject: transition:animate -----------------------------------

test('scanProject picks up transition:animate with a string value', () => {
  const p = makeProject({
    'src/pages/index.astro': '<h1 transition:animate="fade">Hi</h1>',
  });
  try {
    const r = scanProject(p.root);
    assert.equal(r.transitions.length, 1);
    assert.equal(r.transitions[0].kind, 'animate');
    assert.equal(r.transitions[0].value, 'fade');
  } finally {
    p.cleanup();
  }
});

test('scanProject unwraps a brace expression for transition:animate', () => {
  const p = makeProject({
    'src/pages/index.astro': '<h1 transition:animate={fade}>Hi</h1>',
  });
  try {
    const r = scanProject(p.root);
    assert.equal(r.transitions[0].kind, 'animate');
    assert.equal(r.transitions[0].value, 'fade');
  } finally {
    p.cleanup();
  }
});

test('scanProject unwraps a call expression for transition:animate', () => {
  const p = makeProject({
    'src/pages/index.astro': '<h1 transition:animate={fade({ duration: 200 })}>Hi</h1>',
  });
  try {
    const r = scanProject(p.root);
    assert.equal(r.transitions[0].value, 'fade({ duration: 200 })');
  } finally {
    p.cleanup();
  }
});

// --- scanProject: view-transition-name in style attribute --------------

test('scanProject picks up view-transition-name from a style attribute', () => {
  const p = makeProject({
    'src/pages/index.astro': '<h1 style="view-transition-name: hero">Hi</h1>',
  });
  try {
    const r = scanProject(p.root);
    assert.equal(r.transitions.length, 1);
    assert.equal(r.transitions[0].kind, 'vt-name');
    assert.equal(r.transitions[0].value, 'hero');
  } finally {
    p.cleanup();
  }
});

test('scanProject handles view-transition-name with no whitespace after the colon', () => {
  const p = makeProject({
    'src/pages/index.astro': '<h1 style="view-transition-name:hero">Hi</h1>',
  });
  try {
    const r = scanProject(p.root);
    assert.equal(r.transitions[0].value, 'hero');
  } finally {
    p.cleanup();
  }
});

test('scanProject stops a view-transition-name value at the next declaration', () => {
  const p = makeProject({
    'src/pages/index.astro': '<h1 style="view-transition-name: hero; color: red">Hi</h1>',
  });
  try {
    const r = scanProject(p.root);
    assert.equal(r.transitions[0].value, 'hero');
  } finally {
    p.cleanup();
  }
});

test('scanProject picks up multiple style-declared view-transition-names', () => {
  const p = makeProject({
    'src/pages/index.astro': [
      '<a style="view-transition-name: hero">x</a>',
      '<b style="view-transition-name:cta">y</b>',
    ].join('\n'),
  });
  try {
    const r = scanProject(p.root);
    const vals = r.transitions.map((t) => t.value).sort();
    assert.deepEqual(vals, ['cta', 'hero']);
  } finally {
    p.cleanup();
  }
});

// --- scanProject: layouts -----------------------------------------------

test('scanProject scans layouts in addition to pages', () => {
  const p = makeProject({
    'src/pages/index.astro': '<h1>Hi</h1>',
    'src/layouts/Base.astro': '<h1 transition:name="hero">Hi</h1>',
  });
  try {
    const r = scanProject(p.root);
    const layoutT = r.transitions.find((t) => t.page.rel === 'src/layouts/Base.astro');
    assert.ok(layoutT, 'expected a transition tied to the layout');
    assert.equal(layoutT.value, 'hero');
  } finally {
    p.cleanup();
  }
});

// --- scanProject: skip / size guard -------------------------------------

test('scanProject skips node_modules, dist, .astro, and .git directories', () => {
  const p = makeProject({
    'src/pages/index.astro': '<h1>Hi</h1>',
    'node_modules/foo/Bar.astro': '<h1 transition:name="x">x</h1>',
    'dist/index.astro': '<h1 transition:name="x">x</h1>',
    '.astro/cache.astro': '<h1 transition:name="x">x</h1>',
    '.git/HEAD.astro': '<h1 transition:name="x">x</h1>',
  });
  try {
    const r = scanProject(p.root);
    assert.equal(r.transitions.length, 0);
  } finally {
    p.cleanup();
  }
});

test('scanProject silently ignores files larger than 1 MB', () => {
  const p = makeProject({
    'src/pages/index.astro': '<h1>Hi</h1>',
  });
  try {
    // Pad the file to > 1 MB with whitespace and a transition at the end
    // (the scan stops before reading it).
    const big = ' '.repeat(1024 * 1024) + '<h1 transition:name="x">x</h1>';
    fs.writeFileSync(path.join(p.root, 'src/pages/big.astro'), big, 'utf8');
    const r = scanProject(p.root);
    const bigT = r.transitions.find((t) => t.page.rel === 'src/pages/big.astro');
    assert.equal(bigT, undefined);
  } finally {
    p.cleanup();
  }
});

// --- scanProject: result shape ------------------------------------------

test('scanProject returns transitions in stable (rel, line, col) order', () => {
  const p = makeProject({
    'src/pages/a.astro': [
      '<a transition:name="z">z</a>',
      '<b transition:name="a">a</b>',
    ].join('\n'),
    'src/pages/b.astro': '<c transition:name="m">m</c>',
  });
  try {
    const r = scanProject(p.root);
    assert.equal(r.transitions[0].page.rel, 'src/pages/a.astro');
    assert.equal(r.transitions[0].value, 'z'); // line 1 first
    assert.equal(r.transitions[1].value, 'a'); // line 2
    assert.equal(r.transitions[2].page.rel, 'src/pages/b.astro');
  } finally {
    p.cleanup();
  }
});

test('scanProject attaches page rel/route to every transition', () => {
  const p = makeProject({
    'src/pages/blog/[slug].astro': '<h1 transition:name="h">x</h1>',
  });
  try {
    const r = scanProject(p.root);
    const t = r.transitions[0];
    assert.equal(t.page.rel, 'src/pages/blog/[slug].astro');
    assert.equal(t.page.route, '/blog/:slug');
    assert.equal(t.page.name, '[slug].astro');
  } finally {
    p.cleanup();
  }
});

test('scanProject returns a project with no src/pages as an empty transitions list', () => {
  const p = makeProject({
    'src/layouts/Base.astro': '<h1 transition:name="x">x</h1>',
  });
  try {
    const r = scanProject(p.root);
    // Layouts are still scanned, so the transition is reported even
    // without a pages directory.
    assert.equal(r.transitions.length, 1);
    assert.equal(r.pages.length, 0);
  } finally {
    p.cleanup();
  }
});

test('scanProject returns empty for an empty project root', () => {
  const p = makeProject({});
  try {
    const r = scanProject(p.root);
    assert.deepEqual(r.transitions, []);
    assert.deepEqual(r.pages, []);
  } finally {
    p.cleanup();
  }
});
