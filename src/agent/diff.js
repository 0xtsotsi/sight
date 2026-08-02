// src/agent/diff.js
//
// STUB. Real implementation (json-patch + unified diff via fast-json-patch)
// was task 6 and never landed. The dynamic import in tools.js has a safe
// fallback, but Vite's bundler still resolves the import at build time, so
// this stub exists to keep `npm run build` (and `dist:mac`) working.
//
// TODO(task 6): implement computeDiff with fast-json-patch and a real
// unified diff renderer. See docs/agent-side-panel.plan.md.

/**
 * @param {*} before
 * @param {*} after
 * @returns {{unifiedDiff: null, jsonPatch: null, summary: string}}
 */
export function computeDiff(before, after) {
  // Best-effort shallow comparison so the panel still shows *something* in
  // the diff card while task 6 isn't done.
  const beforeStr = JSON.stringify(before ?? null);
  const afterStr = JSON.stringify(after ?? null);
  return {
    unifiedDiff: null,
    jsonPatch: null,
    summary: beforeStr === afterStr ? 'no change' : 'change pending real diff (task 6)',
  };
}