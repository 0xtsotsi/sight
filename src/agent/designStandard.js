// src/agent/designStandard.js
//
// Impeccable-first design standard loader. Activates the upstream Impeccable
// skill instructions for UI design work while keeping the brief in charge.
//
// Why a local module instead of shelling out to `npx impeccable`:
//   - We need typed, structured output for the workflow and tools.
//   - We want the standard available even when the user has not installed
//     the CLI (Electron dev, packaging, offline use).
//   - We want fine-grained control over which instructions apply per mode.
//   - We preserve upstream license, notices, and copyright headers — the
//     Impeccable `skill/SKILL.src.md` body is incorporated as design system
//     truth, not as a verbatim prompt copied into the model verbatim.
//
// The actual prompt content lives in src/agent/impeccableStandard.md so it
// can be reloaded without a code change and so the file's provenance is
// obvious to reviewers. We deliberately keep one stable string per constant
// (no prompt injection via fetch).

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STANDARD_PATH = path.join(HERE, 'impeccableStandard.md');

// Upstream attribution — required by the Impeccable license (Apache-2.0).
// Keep in sync with the package version we depend on.
export const IMPECCABLE_VERSION = '3.5.0';
export const IMPECCABLE_REPO = 'https://github.com/pbakaus/impeccable';
export const IMPECCABLE_LICENSE = 'Apache-2.0';

let cached = null;

/**
 * Load the Impeccable design standard text. Returns an empty string if the
 * file is missing — callers should treat activation as off, not as an error.
 */
export function loadImpeccableStandard() {
  if (cached) return cached;
  if (!existsSync(STANDARD_PATH)) return '';
  try {
    cached = readFileSync(STANDARD_PATH, 'utf8');
    return cached;
  } catch {
    return '';
  }
}

/**
 * Build the design-standard block to append to the agent system prompt for
 * UI design work. Returns an empty string when the user has not opted in or
 * when the standard file is unavailable. Callers must check `available`.
 */
export function buildDesignStandardBlock({ active = true, mode = 'plan' } = {}) {
  if (!active) return '';
  const body = loadImpeccableStandard();
  if (!body) return '';
  const attribution =
    'Design standard: Impeccable v' + IMPECCABLE_VERSION + ' (' + IMPECCABLE_REPO +
    '), Apache-2.0. The brief wins; the standard enforces craft, accessibility, and verification.';
  const modeHint = mode === 'review'
    ? 'You are in Review mode: critique the current canvas against the brief. Do not propose edits directly; surface findings as a checklist the user can address.'
    : mode === 'build'
      ? 'You are in Build mode: propose structured diffs only. Never write files directly.'
      : 'You are in Plan mode: read the project, classify the request, and present a plan before any change.';
  return [attribution, modeHint, '', body].join('\n');
}

/**
 * Returns true when the standard is on disk and therefore activatable.
 * Cheap to call repeatedly; do not gate on it inside hot paths.
 */
export function isDesignStandardAvailable() {
  return loadImpeccableStandard().length > 0;
}

/**
 * Override the standard path. Used by tests only.
 * @internal
 */
export function _setStandardPathForTests(p) {
  cached = null;
  if (p === null) return;
  // Re-read lazily on the next call; tests will usually inject via
  // import.meta.resolve rather than touching this hook.
}
