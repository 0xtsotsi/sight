// src/agent/policy.js
//
// Centralized policy: which tools exist, their effect class, their MCP-style
// annotations, and the `needsApproval(args, context)` decision used by
// every tool before execution.
//
// Phase 1 covers the existing tools plus the new media tools. Phase 2 will
// extend it with worktree, skill, and review tools.

import { MEDIA_KIND } from './media.js';

// ---------------------------------------------------------------------------
// Effect classes
// ---------------------------------------------------------------------------

export const EFFECT = Object.freeze({
  READ: 'read', // no mutation
  PROPOSE: 'propose', // returns a diff or asset the user must apply
  WRITE: 'write', // mutates durable state
  DESTRUCTIVE: 'destructive', // irreversible or hard-to-reverse
  EXTERNAL: 'external', // touches the network or an outside system
});

// ---------------------------------------------------------------------------
// MCP-style annotations — hints only; host enforcement is in this file.
// ---------------------------------------------------------------------------

/**
 * The four-hint set in one place so the addendum's requirement holds:
 *   - readOnlyHint:    the tool never mutates any durable state
 *   - destructiveHint: the tool may delete or hard-reverse state
 *   - idempotentHint:  repeated calls with the same input are no-ops
 *   - openWorldHint:   the tool reaches outside the host (network, web)
 */
export function annotationsFor(effect) {
  switch (effect) {
    case EFFECT.READ:
      return { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
    case EFFECT.PROPOSE:
      return { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
    case EFFECT.WRITE:
      return { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
    case EFFECT.DESTRUCTIVE:
      return { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
    case EFFECT.EXTERNAL:
      return { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
    default:
      return { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
  }
}

// ---------------------------------------------------------------------------
// Tool manifest — single source of truth
// ---------------------------------------------------------------------------

const TOOL_MANIFEST = Object.freeze({
  list_pages: { effect: EFFECT.READ, schemaVersion: 1 },
  read_page: { effect: EFFECT.READ, schemaVersion: 1 },
  read_cms: { effect: EFFECT.READ, schemaVersion: 1 },
  scan_project: { effect: EFFECT.READ, schemaVersion: 1 },
  apply_page_diff: { effect: EFFECT.PROPOSE, schemaVersion: 1 },
  generate_image: { effect: EFFECT.EXTERNAL, schemaVersion: 1, kind: MEDIA_KIND.IMAGE },
  generate_video: { effect: EFFECT.EXTERNAL, schemaVersion: 1, kind: MEDIA_KIND.VIDEO },
  generate_thumbnail: { effect: EFFECT.EXTERNAL, schemaVersion: 1, kind: MEDIA_KIND.THUMBNAIL },
  pull_brandkit: { effect: EFFECT.EXTERNAL, schemaVersion: 1, kind: MEDIA_KIND.BRANDKIT },
});

export function toolManifestEntry(name) {
  return TOOL_MANIFEST[name] ?? null;
}

export function listToolNames() {
  return Object.keys(TOOL_MANIFEST);
}

// ---------------------------------------------------------------------------
// Approval decision
// ---------------------------------------------------------------------------

/**
 * Compute whether a tool call needs user approval. Phase 1 policy:
 *   - READ: never approve
 *   - PROPOSE: never approve at the tool level; the user reviews the diff
 *     card. (Approval at this layer is reserved for destructive variants.)
 *   - WRITE: always approve
 *   - DESTRUCTIVE: always approve, with a higher-risk tier
 *   - EXTERNAL: always approve, with a reminder of the open-world hint
 *
 * Callers must pass the normalized tool name and the validated args object.
 * The context is opaque for now; Phase 2 will fold in workflow, scope, and
 * credential state.
 *
 * Returns:
 *   { required: boolean, tier?: 'low'|'medium'|'high', reason?: string,
 *     rememberable: boolean, expiryMs?: number }
 */
export function needsApproval(toolName, args, context = {}) {
  const entry = toolManifestEntry(toolName);
  if (!entry) {
    return { required: true, tier: 'high', reason: 'unknown tool: ' + String(toolName), rememberable: false };
  }
  switch (entry.effect) {
    case EFFECT.READ:
      return { required: false, rememberable: false };
    case EFFECT.PROPOSE:
      return { required: false, rememberable: false };
    case EFFECT.WRITE:
      return { required: true, tier: 'medium', reason: 'mutates durable state', rememberable: true, expiryMs: 5 * 60 * 1000 };
    case EFFECT.DESTRUCTIVE:
      return { required: true, tier: 'high', reason: 'destructive action', rememberable: true, expiryMs: 15 * 60 * 1000 };
    case EFFECT.EXTERNAL: {
      const prompt = (args && typeof args.prompt === 'string') ? args.prompt : '';
      const tier = prompt.length > 1000 ? 'high' : 'medium';
      return {
        required: true,
        tier,
        reason: 'touches the network; openWorldHint:true',
        rememberable: false, // never auto-apply media — the user must always review the asset
      };
    }
    default:
      return { required: true, tier: 'high', reason: 'no policy for effect: ' + entry.effect, rememberable: false };
  }
}

// ---------------------------------------------------------------------------
// Hash the validated arguments for resumable approval persistence. The hash
// is stable for the same JSON-serializable args; callers must use the
// exact validated object the tool receives.
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto';

export function hashArgsForApproval(toolName, args) {
  const h = createHash('sha256');
  h.update(String(toolName));
  h.update('|');
  h.update(JSON.stringify(args ?? null));
  return h.digest('hex');
}
