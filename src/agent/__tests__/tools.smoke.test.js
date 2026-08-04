// src/agent/__tests__/tools.smoke.test.js
//
// Self-contained smoke test for the agent tools layer. Uses Node's built-in
// `node:test` runner (Node ≥ 18) so it runs without any test framework
// dependency. Task 8 (tests + CI) will wire this into `npm test` and the
// GitHub Actions workflow.
//
// What it asserts:
//   1. Every tool calls the expected avb.* verb with the expected payload.
//   2. apply_page_diff NEVER writes — it returns a diff instead.
//   3. Invalid snapshot (missing projectPath) throws.
//   4. Invalid args (zod) throw.
//
// Stub strategy: we replace `globalThis.window.avb` with a recording stub
// before importing tools.js. The module's `getAvb` reads window at call
// time, so the stub works as long as we set it before each test.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// We need to import AFTER setting up the window stub. Each test does its
// own setup so they're isolated.

async function loadToolsWith(stub) {
  // Fresh stub every load — make sure no test sees another's recording.
  globalThis.window = { avb: stub };
  // Bust module cache so tools.js re-runs its module-level code.
  const mod = await import(`../tools.js?cache=${Math.random()}`);
  return mod;
}

const CTX = { projectPath: '/proj/site', selectedNodeId: 'c42', activePagePath: '/proj/site/src/pages/index.astro' };

function recordingStub(impl = {}) {
  const calls = [];
  const stub = {
    scanProject: async (p) => { calls.push(['scanProject', p]); return impl.scanProject ?? { pages: [], cms: [], assets: [], classes: [] }; },
    readPage: async (path) => { calls.push(['readPage', path]); return impl.readPage ?? { ok: true, page: { path, model: { nodes: [] }, source: '<!--x-->' } }; },
    readCms: async ({ projectPath, rel }) => { calls.push(['readCms', projectPath, rel]); return impl.readCms ?? { ok: true, data: { items: [] } }; },
    // writePage intentionally absent — the tools layer must never call it.
  };
  stub._calls = calls;
  return stub;
}

// ---------------------------------------------------------------------------

test('list_pages calls scanProject and filters by dir', async () => {
  const stub = recordingStub({
    scanProject: {
      pages: [
        { path: '/proj/site/src/pages/index.astro' },
        { path: '/proj/site/src/pages/blog/post-1.astro' },
      ],
    },
  });
  const { buildTools } = await loadToolsWith(stub);
  const [tool] = buildTools().filter((t) => t.name === 'list_pages');
  const result = await tool.handler({ dir: 'blog' }, CTX);
  assert.deepEqual(stub._calls[0], ['scanProject', '/proj/site']);
  assert.equal(result.pages.length, 1);
  assert.ok(result.pages[0].path.includes('/blog/'));
});

test('read_page forwards path verbatim to avb.readPage', async () => {
  const stub = recordingStub();
  const { buildTools } = await loadToolsWith(stub);
  const [tool] = buildTools().filter((t) => t.name === 'read_page');
  const page = await tool.handler({ path: '/proj/site/src/pages/about.astro' }, CTX);
  assert.deepEqual(stub._calls[0], ['readPage', '/proj/site/src/pages/about.astro']);
  assert.equal(page.path, '/proj/site/src/pages/about.astro');
  assert.ok(Array.isArray(page.model.nodes));
});

test('read_cms uses projectPath from ctx, not args', async () => {
  const stub = recordingStub();
  const { buildTools } = await loadToolsWith(stub);
  const [tool] = buildTools().filter((t) => t.name === 'read_cms');
  await tool.handler({ rel: 'src/data/posts.json' }, CTX);
  assert.deepEqual(stub._calls[0], ['readCms', '/proj/site', 'src/data/posts.json']);
});

test('apply_page_diff returns a diff and NEVER calls writePage', async () => {
  const stub = recordingStub();
  const { buildTools } = await loadToolsWith(stub);
  const [tool] = buildTools().filter((t) => t.name === 'apply_page_diff');
  const result = await tool.handler(
    {
      path: '/proj/site/src/pages/index.astro',
      beforeJson: { nodes: [] },
      afterJson: { nodes: [{ id: 'c1', kind: 'p' }] },
      summary: 'add a paragraph',
    },
    CTX,
  );
  // Critical: writePage must NOT have been called by the tool.
  assert.equal(stub._calls.length, 0, 'apply_page_diff must not call any avb.* verb');
  assert.equal(result.canApply, true);
  assert.equal(result.path, '/proj/site/src/pages/index.astro');
  assert.equal(result.summary, 'add a paragraph');
  // diff field exists, whatever its shape (real compute lands in task 6).
  assert.ok('diff' in result);
});

test('missing projectPath in ctx throws', async () => {
  const stub = recordingStub();
  const { buildTools } = await loadToolsWith(stub);
  const [tool] = buildTools().filter((t) => t.name === 'list_pages');
  await assert.rejects(() => tool.handler({}, { selectedNodeId: 'x' }), /snapshot/i);
});

test('invalid args (missing required path) throw via zod', async () => {
  const stub = recordingStub();
  const { buildTools } = await loadToolsWith(stub);
  const [tool] = buildTools().filter((t) => t.name === 'read_page');
  await assert.rejects(() => tool.handler({}, CTX), /path/i);
});

test('tools layer exposes the 5 base tools plus the 4 media tools and no direct write tool', async () => {
  const stub = recordingStub();
  const { buildTools } = await loadToolsWith(stub);
  const names = buildTools().map((t) => t.name);
  for (const n of ['list_pages', 'read_page', 'read_cms', 'scan_project', 'apply_page_diff', 'generate_image', 'generate_video', 'generate_thumbnail', 'pull_brandkit']) {
    assert.ok(names.includes(n), 'missing tool: ' + n);
  }
  // No tool name contains "write" except apply_page_diff (which doesn't write).
  for (const n of names) {
    if (n === 'apply_page_diff') continue;
    assert.ok(!n.includes('write'), `forbidden direct-write tool: ${n}`);
  }
});
