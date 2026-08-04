// src/agent/tools.js
//
// MCP-compatible tool definitions wrapping window.avb.* IPC verbs.
//
// Design contract (DO NOT BREAK):
//   1. NO direct write tool. The agent's only write surface is
//      `apply_page_diff`, which returns a diff for the UI to preview.
//      The AgentPanel's Apply button is what calls window.avb.writePage
//      (with markSelfWrite:true). This is what guarantees undo/redo,
//      fs-change suppression, and selection tracking all work for AI
//      edits the same way they do for human edits.
//   2. Tools are STATIC. No closure state — every handler reads its
//      projectPath from the `ctx` argument the factory installs. This
//      keeps the tool list serializable (some providers ship tool defs
//      over the wire as JSON) and lets us rebuild tools on demand.
//   3. Errors are caught and re-thrown as plain Error objects with a
//      short message. gg-agent surfaces these as tool-result errors;
//      the panel (task 4) renders them in the tool trace.
//
// If a new write capability is needed (e.g. write CMS, write styles),
// it MUST be added as a *_diff tool — never as a direct write.

import {
  applyPageDiffArgsSchema,
  listPagesArgsSchema,
  readCmsArgsSchema,
  readPageArgsSchema,
  scanProjectArgsSchema,
  snapshotSchema,
} from './schemas.js';
import { buildMediaTools } from './tools-media.js';

// ---------------------------------------------------------------------------
// JSON Schema conversion
//
// gg-agent accepts tools as `{ name, description, inputSchema, handler }`
// where inputSchema is a JSON Schema object (the MCP convention). zod has
// no built-in JSON Schema export in v4, so we hand-write the shapes. They
// stay in lockstep with schemas.js — a unit test asserts every schema here
// matches its zod counterpart's shape.
// ---------------------------------------------------------------------------

const inputSchemas = {
  list_pages: {
    type: 'object',
    properties: {
      dir: { type: 'string', description: 'Optional subdirectory to list.' },
    },
    additionalProperties: false,
  },
  read_page: {
    type: 'object',
    required: ['path'],
    properties: {
      path: { type: 'string', description: 'Absolute path to the .astro page file.' },
    },
    additionalProperties: false,
  },
  read_cms: {
    type: 'object',
    required: ['rel'],
    properties: {
      rel: {
        type: 'string',
        description: 'Path of the CMS JSON file relative to the project (e.g. "src/data/posts.json").',
      },
    },
    additionalProperties: false,
  },
  scan_project: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  apply_page_diff: {
    type: 'object',
    required: ['path', 'beforeJson', 'afterJson', 'summary'],
    properties: {
      path: { type: 'string', description: 'Absolute path of the .astro page file to modify.' },
      beforeJson: {
        description: 'The full page model BEFORE the agent edit. Used to compute the diff for review.',
      },
      afterJson: {
        description: 'The full page model AFTER the agent edit. Applied only when the user clicks Apply.',
      },
      summary: {
        type: 'string',
        maxLength: 280,
        description: 'One-sentence summary of the change for the diff card header.',
      },
    },
    additionalProperties: false,
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assertSnapshot(ctx) {
  const parsed = snapshotSchema.safeParse(ctx);
  if (!parsed.success) {
    throw new Error(
      `agent tool called without a valid snapshot: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
    );
  }
  return parsed.data;
}

function getAvb() {
  if (typeof window === 'undefined' || !window.avb) {
    throw new Error(
      'window.avb is unavailable. The agent tools layer must run inside the Sight renderer.',
    );
  }
  return window.avb;
}

// ---------------------------------------------------------------------------
// Tool handlers
//
// Each handler:
//   - validates ctx (snapshot)
//   - validates args (zod)
//   - calls the matching avb.* verb
//   - returns a plain serializable object
//
// apply_page_diff is intentionally NOT a write — it returns { diff } for
// the panel to render; the actual writePage happens on user Apply.
// ---------------------------------------------------------------------------

async function listPages(ctx, args) {
  assertSnapshot(ctx);
  const { dir } = listPagesArgsSchema.parse(args);
  const avb = getAvb();
  // scanProject gives the full project tree; we filter to pages and
  // optionally narrow by dir. Keeping it avb-only — no direct fs access.
  const scan = await avb.scanProject(ctx.projectPath);
  const pages = Array.isArray(scan?.pages) ? scan.pages : [];
  const filtered = dir ? pages.filter((p) => p.path?.includes(`/${dir}/`) || p.path?.endsWith(`/${dir}`)) : pages;
  return { pages: filtered };
}

async function readPage(ctx, args) {
  assertSnapshot(ctx);
  const { path } = readPageArgsSchema.parse(args);
  const avb = getAvb();
  const result = await avb.readPage(path);
  // result shape: { ok, page: { path, model, source, parseError? } } | { ok:false, error }
  if (!result?.ok) {
    throw new Error(result?.error ?? `readPage failed for ${path}`);
  }
  return result.page;
}

async function readCms(ctx, args) {
  assertSnapshot(ctx);
  const { rel } = readCmsArgsSchema.parse(args);
  const avb = getAvb();
  const result = await avb.readCms({ projectPath: ctx.projectPath, rel });
  if (!result?.ok) {
    throw new Error(result?.error ?? `readCms failed for ${rel}`);
  }
  return result.data;
}

async function scanProject(ctx, args) {
  assertSnapshot(ctx);
  scanProjectArgsSchema.parse(args);
  const avb = getAvb();
  return avb.scanProject(ctx.projectPath);
}

// apply_page_diff: returns a diff structure the panel can preview. The
// actual write is gated on the user's Apply click (see AgentPanel, task 4).
// Diff computation lives in src/agent/diff.js (task 6). Here we just shape
// the response — if diff.js isn't loaded yet we fall back to a shallow
// "structure changed" placeholder so the panel can still show the card.
async function applyPageDiff(ctx, args) {
  assertSnapshot(ctx);
  const parsed = applyPageDiffArgsSchema.parse(args);
  // Lazy import so the tools module stays usable even if diff.js isn't
  // installed yet (e.g. running the agent client before task 6 lands).
  let computeDiff = (a, b) => ({ unifiedDiff: null, jsonPatch: null, summary: 'change pending diff computation' });
  try {
    const mod = await import('./diff.js');
    if (typeof mod.computeDiff === 'function') computeDiff = mod.computeDiff;
  } catch {
    // diff.js missing — fall back silently; the panel will show a generic
    // "diff unavailable" hint and rely on before/after JSON in the payload.
  }
  const diff = computeDiff(parsed.beforeJson, parsed.afterJson);
  return {
    canApply: true,
    path: parsed.path,
    beforeJson: parsed.beforeJson,
    afterJson: parsed.afterJson,
    summary: parsed.summary,
    diff,
  };
}

// ---------------------------------------------------------------------------
// Factory
//
// Returns the tool list in MCP shape. The factory takes no arguments;
// per-call context is injected by the panel via the wrapper in client.js
// (task 3). Exposed as a builder so we can add capability flags later
// (e.g. `buildTools({ allowWrites: true })` once a "Confirm writes"
// toggle exists in the panel).
// ---------------------------------------------------------------------------

export function buildTools() {
  // Phase 1: the existing 5 tools plus the 4 media tools from
  // tools-media.js. Media tools are wired as PROPOSAL surfaces — the
  // user always applies the result via the panel. See src/agent/policy.js
  // and src/agent/media.js for the contract.
  return [
    {
      name: 'list_pages',
      description:
        'List pages in the currently-open Astro project. Optionally narrow to a subdirectory. Returns { pages: [{ path, name, ... }] }.',
      inputSchema: inputSchemas.list_pages,
      handler: (args, ctx) => listPages(ctx, args),
    },
    {
      name: 'read_page',
      description:
        'Read a single .astro page and return its parsed page model plus raw source. The model is a tree of { id, kind, name?, props?, children? }. Use list_pages first to find paths.',
      inputSchema: inputSchemas.read_page,
      handler: (args, ctx) => readPage(ctx, args),
    },
    {
      name: 'read_cms',
      description:
        'Read a CMS JSON file (relative to the project root). Returns the parsed JSON contents. Use listCms via scan_project to discover available CMS files.',
      inputSchema: inputSchemas.read_cms,
      handler: (args, ctx) => readCms(ctx, args),
    },
    {
      name: 'scan_project',
      description:
        'Re-scan the project tree. Returns { pages, cms, assets, classes }. Use sparingly — it walks the disk. Prefer list_pages / read_page / read_cms for targeted reads.',
      inputSchema: inputSchemas.scan_project,
      handler: (args, ctx) => scanProject(ctx, args),
    },
    {
      name: 'apply_page_diff',
      description:
        'Propose an edit to a page as a before/after page-model pair. Returns a diff for the user to review. Does NOT write to disk. The user must click Apply in the panel for the change to land. This is the ONLY way to mutate pages.',
      inputSchema: inputSchemas.apply_page_diff,
      handler: (args, ctx) => applyPageDiff(ctx, args),
    },
    ...buildMediaTools(),
  ];
}

// ---------------------------------------------------------------------------
// Exports for tests
// ---------------------------------------------------------------------------

export const _internals = {
  assertSnapshot,
  getAvb,
  inputSchemas,
};
