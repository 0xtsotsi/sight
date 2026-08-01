// src/agent/schemas.js
//
// Zod schemas for the agent tools layer. Pure schemas, no side effects.
// Kept in their own file so they can be reused by the client (task 3)
// to validate args before forwarding to gg-agent and by the panel (task 4)
// to render parameter hints.
//
// Importing zod from the version gg-agent pulls in transitively keeps the
// renderer bundle small. If we ever need to ship a standalone build, swap
// to a static import.

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Snapshot — the per-call context the panel injects into every tool call.
// Tools must NOT depend on closure state; they read from the `ctx` argument
// their factory installs. This keeps the tool list serializable (required
// by some providers that ship tool defs over the wire).
// ---------------------------------------------------------------------------

export const snapshotSchema = z.object({
  projectPath: z.string().min(1),
  selectedNodeId: z.string().nullable().optional(),
  activePagePath: z.string().nullable().optional(),
});

// ---------------------------------------------------------------------------
// list_pages — enumerate pages under a directory (optional, defaults to root).
// ---------------------------------------------------------------------------

export const listPagesArgsSchema = z.object({
  dir: z.string().optional(),
});

// ---------------------------------------------------------------------------
// read_page — read a single page as the parsed model + raw source.
// ---------------------------------------------------------------------------

export const readPageArgsSchema = z.object({
  path: z.string().min(1),
});

// ---------------------------------------------------------------------------
// read_cms — read a single CMS JSON file.
// ---------------------------------------------------------------------------

export const readCmsArgsSchema = z.object({
  rel: z.string().min(1),
});

// ---------------------------------------------------------------------------
// scan_project — re-scan the project tree, returns the same shape as
// window.avb.scanProject: { pages, cms, assets, classes }.
// ---------------------------------------------------------------------------

export const scanProjectArgsSchema = z.object({});

// ---------------------------------------------------------------------------
// apply_page_diff — the ONLY write surface. Returns the diff for the UI to
// preview; never writes directly. The panel's Apply button calls
// window.avb.writePage with markSelfWrite:true so the fs-watcher doesn't
// bounce back as an external change.
//
// beforeJson and afterJson are full page models. We diff them in the client
// (task 3) so this tool just packages the comparison request.
// ---------------------------------------------------------------------------

export const applyPageDiffArgsSchema = z.object({
  path: z.string().min(1),
  beforeJson: z.unknown(),
  afterJson: z.unknown(),
  summary: z.string().min(1).max(280),
});
