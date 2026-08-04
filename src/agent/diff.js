// src/agent/diff.js
//
// Page-model diff: produces (a) an RFC 6902 JSON Patch and (b) a unified
// line-level diff that the AgentPanel can show in the "Show diff" toggle
// of the Diff card.
//
// The agent's apply_page_diff tool hands us { beforeJson, afterJson } —
// both full page models (the contract documented in systemPrompt.js).
// We never re-parse to .astro; that happens later if the user clicks
// Apply, in the same mutateModel path human edits use.
//
// Design notes:
//   - No deps. Hand-rolled RFC 6902 ops + a JSON Pointer encoder. Keeps
//     the renderer bundle small and avoids adding fast-json-patch / diff
//     mid-release-window.
//   - We use `add`/`remove`/`replace` ops only. `move` and `copy` collapse
//     to `add`+`remove` for clarity.
//   - Array changes emit one op per index shift, matching the natural
//     shape of the page-model tree. The renderer treats the patch as
//     documentation — the actual write is the full-model apply, not a
//     patch apply.
//   - The unified diff renders against a deterministic one-line-per-node
//     projection of the page model so the panel can show readable lines
//     instead of a wall of JSON.

const PATCH = Object.freeze({
  ADD: 'add',
  REMOVE: 'remove',
  REPLACE: 'replace',
});

// ---------------------------------------------------------------------------
// JSON Pointer encoder
//
// RFC 6901: '/' separates tokens, '~' → '~0', '/' → '~1'. Empty key is
// valid (yields a trailing slash). We don't percent-encode because the
// page-model shape never produces characters that conflict.
// ---------------------------------------------------------------------------

function encodePointer(parts) {
  if (!Array.isArray(parts) || parts.length === 0) return '';
  let out = '';
  for (const p of parts) {
    const token = String(p);
    out += '/' + token.replace(/~/g, '~0').replace(/\//g, '~1');
  }
  return out;
}

// Escape a single token per RFC 6901 ('~' → '~0', '/' → '~1'). Used to
// append a key/index to an existing pointer without re-adding a leading
// '/' that encodePointer would always insert.
function escapeToken(token) {
  return String(token).replace(/~/g, '~0').replace(/\//g, '~1');
}

function pointerJoin(prefix, key) {
  const token = escapeToken(key);
  if (prefix === '') return '/' + token;
  return prefix + '/' + token;
}

// ---------------------------------------------------------------------------
// Type helpers
// ---------------------------------------------------------------------------

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isPrimitive(v) {
  return v === null || (typeof v !== 'object' && typeof v !== 'function');
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  if (isObject(a)) {
    const ak = Object.keys(a).sort();
    const bk = Object.keys(b).sort();
    if (ak.length !== bk.length) return false;
    for (let i = 0; i < ak.length; i++) {
      if (ak[i] !== bk[i]) return false;
      if (!deepEqual(a[ak[i]], b[ak[i]])) return false;
    }
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// JSON Patch (RFC 6902) generation
//
// We walk the before/after trees in lockstep and emit a single op per
// mismatch. Arrays are diffed by index — that's what the model is shaped
// for. A lengthening array emits adds at the new tail; a shortening array
// emits removes from the old tail. Page-model nodes carry stable ids, so
// in practice the model rarely shifts indices.
// ---------------------------------------------------------------------------

export function computeJsonPatch(before, after) {
  const ops = [];
  walk(before, after, [], ops);
  return ops;
}

function walk(before, after, path, ops) {
  if (deepEqual(before, after)) return;
  const pointer = encodePointer(path);

  // Both undefined (impossible at root, but symmetric at any path): skip.
  if (before === undefined && after === undefined) return;
  if (before === null && after === null) return;

  // null and undefined both represent "absent" for diff purposes. If only
  // one side is absent, descend into the present side so we emit one op
  // per child rather than a single root replace.
  const beforeAbsent = before === undefined || before === null;
  const afterAbsent = after === undefined || after === null;
  if (beforeAbsent && !afterAbsent) {
    if (Array.isArray(after)) {
      for (let i = 0; i < after.length; i++) {
        walk(undefined, after[i], [...path, i], ops);
      }
      // Even for an empty array, emit a marker add at this path so the
      // diff isn't silently empty (a created-but-empty container still
      // counts as a change).
      if (after.length === 0) {
        ops.push({ op: PATCH.ADD, path: pointer, value: after });
      }
      return;
    }
    if (isObject(after)) {
      const keys = Object.keys(after);
      for (const k of keys) {
        walk(undefined, after[k], [...path, k], ops);
      }
      if (keys.length === 0) {
        ops.push({ op: PATCH.ADD, path: pointer, value: after });
      }
      return;
    }
    ops.push({ op: PATCH.ADD, path: pointer, value: after });
    return;
  }
  if (afterAbsent && !beforeAbsent) {
    if (Array.isArray(before)) {
      for (let i = before.length - 1; i >= 0; i--) {
        walk(before[i], undefined, [...path, i], ops);
      }
      return;
    }
    if (isObject(before)) {
      for (const k of Object.keys(before)) {
        walk(before[k], undefined, [...path, k], ops);
      }
      return;
    }
    ops.push({ op: PATCH.REMOVE, path: pointer });
    return;
  }

  // Type mismatch: replace wholesale.
  const bt = typeOf(before);
  const at = typeOf(after);
  if (bt !== at) {
    // null and undefined behave symmetrically here: treat as "absent".
    if (before === null && after === undefined) {
      ops.push({ op: PATCH.REMOVE, path: pointer });
      return;
    }
    if (before === undefined && after === null) {
      ops.push({ op: PATCH.ADD, path: pointer, value: null });
      return;
    }
    ops.push({ op: PATCH.REPLACE, path: pointer, value: after });
    return;
  }

  if (bt === 'array') {
    diffArrays(before, after, path, ops);
    return;
  }
  if (bt === 'object') {
    diffObjects(before, after, path, ops);
    return;
  }
  // primitive mismatch
  ops.push({ op: PATCH.REPLACE, path: pointer, value: after });
}

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'object') return 'object';
  return typeof v;
}

function diffArrays(before, after, path, ops) {
  const min = Math.min(before.length, after.length);
  for (let i = 0; i < min; i++) {
    walk(before[i], after[i], [...path, i], ops);
  }
  if (after.length > before.length) {
    for (let i = before.length; i < after.length; i++) {
      ops.push({ op: PATCH.ADD, path: pointerJoin(encodePointer(path), i), value: after[i] });
    }
  } else if (before.length > after.length) {
    // Remove from the tail backwards so earlier indices stay stable.
    for (let i = before.length - 1; i >= after.length; i--) {
      ops.push({ op: PATCH.REMOVE, path: pointerJoin(encodePointer(path), i) });
    }
  }
}

function diffObjects(before, after, path, ops) {
  const bKeys = Object.keys(before);
  const aKeys = Object.keys(after);
  const aSet = new Set(aKeys);
  const bSet = new Set(bKeys);

  for (const k of aKeys) {
    if (!bSet.has(k)) {
      ops.push({ op: PATCH.ADD, path: pointerJoin(encodePointer(path), k), value: after[k] });
    } else {
      walk(before[k], after[k], [...path, k], ops);
    }
  }
  for (const k of bKeys) {
    if (!aSet.has(k)) {
      ops.push({ op: PATCH.REMOVE, path: pointerJoin(encodePointer(path), k) });
    }
  }
}

// ---------------------------------------------------------------------------
// Unified-diff projection
//
// Page models nest deeply. We render a stable one-line-per-node projection
// (path: kind, id, name, prop-key=value) so the diff is scannable. This is
// what the panel's "Show diff" pre block displays — it's a *summary*, not
// a literal byte diff of two JSON serializations (those would scroll off
// the screen for any non-trivial page).
// ---------------------------------------------------------------------------

export function projectLines(node, path = [], out = []) {
  if (node === null || node === undefined) {
    out.push({ path: encodePointer(path), text: `${encodePointer(path)}: ${JSON.stringify(node)}` });
    return out;
  }
  if (isPrimitive(node)) {
    out.push({ path: encodePointer(path), text: `${encodePointer(path)} = ${JSON.stringify(node)}` });
    return out;
  }
  if (Array.isArray(node)) {
    if (path.length === 0) {
      out.push({ path: '', text: '<root> array' });
    }
    for (let i = 0; i < node.length; i++) {
      projectLines(node[i], [...path, i], out);
    }
    return out;
  }
  if (isObject(node)) {
    // Only emit a node descriptor for objects that look like page-model
    // nodes (have id/kind/name). Other nested objects (props, extraFrontmatter,
    // …) just recurse — they'd otherwise produce a noise line per nested map.
    const looksLikeNode =
      path.length > 0 &&
      (Object.prototype.hasOwnProperty.call(node, 'id') ||
        Object.prototype.hasOwnProperty.call(node, 'kind') ||
        Object.prototype.hasOwnProperty.call(node, 'name'));
    if (looksLikeNode) {
      const id = node.id ? ` id=${JSON.stringify(node.id)}` : '';
      const kind = node.kind ? ` kind=${node.kind}` : '';
      const name = node.name ? ` name=${node.name}` : '';
      out.push({ path: encodePointer(path), text: `<node${kind}${name}${id}>` });
    }
    const keys = Object.keys(node).sort();
    for (const k of keys) {
      // Skip id/kind/name on node-shaped objects — the descriptor above
      // already captured them and we'd otherwise emit noise lines like
      // /nodes/0/id = "n1".
      if (looksLikeNode && (k === 'id' || k === 'kind' || k === 'name')) continue;
      projectLines(node[k], [...path, k], out);
    }
    return out;
  }
  return out;
}

// Build a path → text map for either side.
function projectionMap(root) {
  const lines = projectLines(root);
  const m = new Map();
  for (const l of lines) m.set(l.path, l.text);
  return m;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * @param {*} before - full page model (or null/undefined for first edit)
 * @param {*} after  - full page model with the proposed edit
 * @returns {{unifiedDiff: string|null, jsonPatch: Array, summary: string}}
 */
export function computeDiff(before, after) {
  // Both sides empty: nothing to show.
  if ((before === undefined || before === null) && (after === undefined || after === null)) {
    return { unifiedDiff: null, jsonPatch: [], summary: 'no change' };
  }
  if (deepEqual(before, after)) {
    return { unifiedDiff: null, jsonPatch: [], summary: 'no change' };
  }

  const jsonPatch = computeJsonPatch(before, after);

  // Projection-based unified diff: union the path sets, render one block
  // per changed path with '-' and '+' lines.
  const a = projectionMap(before);
  const b = projectionMap(after);
  const allPaths = new Set([...a.keys(), ...b.keys()]);
  // Stable order: sort by path lexically.
  const sortedPaths = [...allPaths].sort((x, y) => {
    if (x === '' && y !== '') return -1;
    if (y === '' && x !== '') return 1;
    return x < y ? -1 : x > y ? 1 : 0;
  });

  const blocks = [];
  for (const p of sortedPaths) {
    const at = a.get(p);
    const bt = b.get(p);
    if (at === bt) continue;
    blocks.push(
      `@@ ${p || '<root>'} @@`,
      at !== undefined ? `- ${at}` : `- (absent)`,
      bt !== undefined ? `+ ${bt}` : `+ (absent)`,
    );
  }

  const unifiedDiff = blocks.length > 0 ? blocks.join('\n') : null;
  const adds = jsonPatch.filter((o) => o.op === PATCH.ADD).length;
  const removes = jsonPatch.filter((o) => o.op === PATCH.REMOVE).length;
  const replaces = jsonPatch.filter((o) => o.op === PATCH.REPLACE).length;
  const summary =
    `${adds} add${adds === 1 ? '' : 's'}, ` +
    `${removes} remove${removes === 1 ? '' : 's'}, ` +
    `${replaces} replace${replaces === 1 ? '' : 's'}`;

  return { unifiedDiff, jsonPatch, summary };
}

// ---------------------------------------------------------------------------
// Exports for tests
// ---------------------------------------------------------------------------

export const _internals = {
  encodePointer,
  deepEqual,
  projectLines,
  computeJsonPatch,
  PATCH,
};
