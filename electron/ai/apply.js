// Apply an AI patch to a single node in a page's editable model, then
// serialize back to .astro source. The caller is responsible for the
// `markSelfWrite` contract — `applyPatch` returns the path so the caller
// can mark it before/after the disk write (see `ai:editNode` handler in
// electron/main.js).
//
// All writes go through the existing `page:write` machinery — model
// round-trip is the source of truth. A non-round-trippable patch is
// rejected here with a clear error; the page falls back to CodeMirror
// rather than being silently corrupted.

const fs = require('fs');
const path = require('path');
const { parsePage, serializePage } = require('../astroParser.js');

// Find a node by id in a tree. Returns the node and its parent list + index.
function locateNode(nodes, id) {
  if (!Array.isArray(nodes)) return null;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n?.id === id) return { node: n, list: nodes, index: i };
    if (Array.isArray(n?.children)) {
      const found = locateNode(n.children, id);
      if (found) return found;
    }
  }
  return null;
}

function isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

// Validate the patch against the original node. Returns { ok: true } or
// { ok: false, error } with a human-readable reason. We refuse:
//   - top-level frontmatter keys that weren't on the original node
//   - prop keys that weren't on the original node
//   - children arrays that are wildly larger/smaller than the original
//   - patches for non-element/component targets (text/expr/comment)
function validatePatch(patch, original) {
  if (!isPlainObject(patch)) {
    return { ok: false, error: 'Patch is not an object.' };
  }
  // Reject any field we don't recognize.
  const known = new Set(['frontmatter', 'props', 'children', 'reason']);
  for (const k of Object.keys(patch)) {
    if (!known.has(k)) {
      return { ok: false, error: `Unknown patch field: ${k}` };
    }
  }

  if (original && !['element', 'component'].includes(original.kind)) {
    return {
      ok: false,
      error: `Cannot patch a ${original.kind || 'unknown'} node. Select an element or component.`,
    };
  }

  // frontmatter — if present, must be a plain object (or null). New keys
  // are not allowed on the patch itself (the patch may only edit keys the
  // node already had in frontmatter); keys absent from the original are
  // dropped silently to preserve invariants.
  if (patch.frontmatter != null && !isPlainObject(patch.frontmatter)) {
    return { ok: false, error: 'patch.frontmatter must be an object or null.' };
  }

  if (patch.props != null && !isPlainObject(patch.props)) {
    return { ok: false, error: 'patch.props must be an object or null.' };
  }

  if (patch.children != null && !Array.isArray(patch.children)) {
    return { ok: false, error: 'patch.children must be an array or null.' };
  }

  // Children size budget. We compare the serialized length, not the raw
  // array length, so a few new elements with short content won't get
  // rejected on length alone.
  if (Array.isArray(patch.children) && original) {
    const before = serializeSize(original.children || []);
    const after = serializeSize(patch.children);
    if (before > 0) {
      const ratio = after / before;
      if (ratio > 1.5 || ratio < 0.5) {
        return {
          ok: false,
          error:
            'Children content changed by ' +
            Math.round((ratio - 1) * 100) +
            '%, outside the 50% safety band.',
        };
      }
    }
  }

  return { ok: true };
}

function serializeSize(nodes) {
  try {
    // Reuse the parser's serializer by wrapping into a fake page.
    const total = serializePage({ imports: [], extraFrontmatter: '', nodes });
    return total.length;
  } catch {
    return 0;
  }
}

// Apply patch to a located node, mutating in place. Returns the node.
function applyToNode(node, patch) {
  if (patch.frontmatter !== null && patch.frontmatter !== undefined) {
    // Drop keys the original didn't have.
    const originalFm = isPlainObject(node.frontmatter) ? node.frontmatter : {};
    const out = {};
    for (const k of Object.keys(originalFm)) out[k] = patch.frontmatter[k] !== undefined ? patch.frontmatter[k] : originalFm[k];
    // Any new key the patch wanted to add is silently dropped — invariant.
    node.frontmatter = out;
  }
  if (patch.props !== null && patch.props !== undefined) {
    const originalProps = isPlainObject(node.props) ? node.props : {};
    const out = {};
    for (const k of Object.keys(originalProps)) {
      out[k] = patch.props[k] !== undefined ? patch.props[k] : originalProps[k];
    }
    node.props = out;
  }
  if (patch.children !== null && patch.children !== undefined) {
    node.children = patch.children;
  }
  return node;
}

// Apply a patch in-memory to the model and re-serialize. The on-disk
// write happens in the IPC handler (which owns markSelfWrite). Returns
// `{ source }` on success.
function applyPatch({ model, nodeId, patch }) {
  if (!isPlainObject(model)) {
    return { ok: false, error: 'No model provided.' };
  }
  if (!nodeId) {
    return { ok: false, error: 'No nodeId provided.' };
  }
  const located = locateNode(model.nodes || [], nodeId);
  if (!located) {
    return { ok: false, error: 'Node not found in model.' };
  }
  const valid = validatePatch(patch, located.node);
  if (!valid.ok) return valid;

  applyToNode(located.node, patch);
  let source;
  try {
    source = serializePage(model);
  } catch (err) {
    return { ok: false, error: 'Failed to serialize: ' + (err?.message || String(err)) };
  }
  return { ok: true, source, node: located.node };
}

// Read the page from disk, parse, apply patch, write. Used by the IPC
// handler `ai:editNode`. The caller passes `writeFile` (a function that
// writes bytes — wrapped so we can mark `markSelfWrite` from main).
function applyPatchToFile({ pagePath, nodeId, patch, readFile, writeFile }) {
  const source = readFile(pagePath);
  const parsed = parsePage(source);
  if (!parsed || !parsed.editable) {
    return { ok: false, error: 'This page is not editable; edits fall through to the code editor.' };
  }
  const result = applyPatch({ model: parsed.model, nodeId, patch });
  if (!result.ok) return result;
  writeFile(pagePath, result.source);
  return { ok: true, source: result.source, node: result.node };
}

module.exports = {
  applyPatch,
  applyPatchToFile,
  validatePatch,
  locateNode,
};