// Pure per-key diff between two node shapes. Used by AiPanel to render a
// readable "what changed" summary next to Accept / Reject.
//
// Each entry is one of:
//   { kind: 'added',   path: 'props.class', before: undefined, after: '...' }
//   { kind: 'removed', path: 'props.class', before: '...',     after: undefined }
//   { kind: 'changed', path: 'props.class', before: '...',     after: '...' }
//   { kind: 'unchanged', path: 'props.class', before: '...',   after: '...' }  -- excluded from output by default
//   { kind: 'list-changed', path: 'children', sizeBefore, sizeAfter, added, removed } -- for arrays

const MAX_DEPTH = 5;

function deepEqual(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return a === b;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const k of ak) if (!deepEqual(a[k], b[k])) return false;
  return true;
}

function joinPath(prefix, key) {
  if (!prefix) return String(key);
  return `${prefix}.${key}`;
}

function flatString(value) {
  if (value == null) return String(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'object' && 'value' in value) return JSON.stringify(value.value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

// Recognize an AttrValue shape ({ type, value }) so that the diff surfaces
// changes at the attribute name rather than recursing into `.value`.
function isAttrValue(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v) && 'type' in v && 'value' in v;
}

function compareObjects(a, b, path, out, depth, isTop) {
  if (depth > MAX_DEPTH) {
    out.push({ kind: 'changed', path, before: flatString(a), after: flatString(b) });
    return;
  }
  const aKeys = a && typeof a === 'object' && !Array.isArray(a) ? Object.keys(a) : [];
  const bKeys = b && typeof b === 'object' && !Array.isArray(b) ? Object.keys(b) : [];
  const all = new Set([...aKeys, ...bKeys]);
  for (const k of all) {
    const av = a ? a[k] : undefined;
    const bv = b ? b[k] : undefined;
    if (isAttrValue(av) || isAttrValue(bv)) {
      // Compare as a primitive (string / number / boolean / expression).
      const avStr = isAttrValue(av) ? av.value : undefined;
      const bvStr = isAttrValue(bv) ? bv.value : undefined;
      if (avStr === bvStr) continue;
      const childPath = isTop ? String(k) : joinPath(path, k);
      out.push({
        kind: 'changed',
        path: childPath,
        before: flatString(avStr),
        after: flatString(bvStr),
      });
      continue;
    }
    // When this is the top-level call, the user-supplied `path` is the
    // section name (e.g. 'props'); child keys shouldn't be prefixed by it.
    const childPath = isTop ? String(k) : joinPath(path, k);
    compareAny(av, bv, childPath, out, depth + 1, false);
  }
}

function compareLists(a, b, path, out, depth, isTop) {
  if (!Array.isArray(a) || !Array.isArray(b)) {
    out.push({ kind: 'changed', path, before: flatString(a), after: flatString(b) });
    return;
  }
  if (a.length === b.length && a.every((v, i) => deepEqual(v, b[i]))) {
    return; // unchanged
  }
  out.push({
    kind: 'list-changed',
    path: isTop ? '' : path,
    sizeBefore: a.length,
    sizeAfter: b.length,
    added: Math.max(0, b.length - a.length),
    removed: Math.max(0, a.length - b.length),
  });
}

function compareAny(a, b, path, out, depth, isTop) {
  if (a === undefined && b === undefined) return;
  if (a === undefined) {
    out.push({ kind: 'added', path: isTop ? '' : path, before: undefined, after: flatString(b) });
    return;
  }
  if (b === undefined) {
    out.push({ kind: 'removed', path: isTop ? '' : path, before: flatString(a), after: undefined });
    return;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    compareLists(a, b, path, out, depth + 1, isTop);
    return;
  }
  if (typeof a === 'object' && typeof b === 'object' && a && b) {
    compareObjects(a, b, path, out, depth + 1, isTop);
    return;
  }
  if (deepEqual(a, b)) return;
  out.push({ kind: 'changed', path: isTop ? '' : path, before: flatString(a), after: flatString(b) });
}

// Compute a diff. Returns an array of entries. By default, unchanged
// entries are skipped (`includeUnchanged: false`). Set `topLevel` to limit
// what we compare — typically 'props' or 'frontmatter'.
//
//   diffNodes(original, patched, { topLevel: 'props' })
//
// `topLevel` may be:
//   - a string ('props' / 'frontmatter' / 'children')
//   - an array of strings
//   - omitted/null (diff the whole node, but skip id/kind/path)
export function diffNodes(original, patched, opts = {}) {
  const out = [];
  if (!original || !patched) {
    if (original || patched) {
      out.push({
        kind: 'changed',
        path: '',
        before: flatString(original),
        after: flatString(patched),
      });
    }
    return out;
  }
  let sections;
  if (Array.isArray(opts.topLevel)) sections = opts.topLevel;
  else if (opts.topLevel) sections = [opts.topLevel];
  else sections = ['frontmatter', 'props', 'children'];
  for (const section of sections) {
    compareAny(original[section], patched[section], section, out, 0, true);
  }
  return out;
}

// Convenience: summarize the diff into a one-line description used as a
// fallback when the panel hasn't rendered the structured diff yet.
export function summarizeDiff(entries) {
  if (!entries || entries.length === 0) return 'No changes';
  const counts = { added: 0, removed: 0, changed: 0, 'list-changed': 0 };
  for (const e of entries) {
    if (counts[e.kind] !== undefined) counts[e.kind]++;
  }
  const parts = [];
  if (counts.changed) parts.push(`${counts.changed} changed`);
  if (counts.added) parts.push(`${counts.added} added`);
  if (counts.removed) parts.push(`${counts.removed} removed`);
  if (counts['list-changed']) parts.push(`${counts['list-changed']} list${counts['list-changed'] > 1 ? 's' : ''} changed`);
  return parts.join(', ');
}