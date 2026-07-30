// Heuristic static analysis powering the loop "Data" suggestions: top-level
// frontmatter declarations and imports, ancestor loop variables, and — by
// reading object literals — the keys nested inside them, so `service`
// suggests `service.tags` without executing any code.

function skipString(code, i) {
  const q = code[i];
  i++;
  while (i < code.length && code[i] !== q) {
    if (code[i] === '\\') i++;
    i++;
  }
  return i;
}

// End index (exclusive) of an expression starting at `start`: stops at a
// top-level ';' or a newline not continued by a chained operator.
function scanValue(code, start) {
  let depth = 0;
  for (let i = start; i < code.length; i++) {
    const ch = code[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      i = skipString(code, i);
      continue;
    }
    if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) {
      depth--;
      if (depth < 0) return i;
    } else if (depth === 0 && ch === ';') return i;
    else if (depth === 0 && ch === '\n') {
      if (!/^\s*(\.|\)|\]|\}|,|\|\||&&|\?|:)/.test(code.slice(i))) return i;
    }
  }
  return code.length;
}

// Top-level const/let/var declarations: name -> value text.
export function parseDeclarations(code) {
  const out = new Map();
  const re = /(?:^|\n)\s*(?:export\s+)?(?:const|let|var)\s+([\w$]+)\s*=\s*/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    const start = m.index + m[0].length;
    const end = scanValue(code, start);
    out.set(m[1], code.slice(start, end).trim());
    re.lastIndex = end;
  }
  return out;
}

// The first '{…}' object inside an array literal (or the object itself).
export function firstObjectIn(text) {
  if (!text) return null;
  const t = text.trim();
  if (t.startsWith('{')) return t;
  if (!t.startsWith('[')) return null;
  let depth = 0;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      i = skipString(t, i);
      continue;
    }
    if (ch === '{' && depth === 1) {
      let d = 0;
      for (let j = i; j < t.length; j++) {
        const c = t[j];
        if (c === '"' || c === "'" || c === '`') {
          j = skipString(t, j);
          continue;
        }
        if (c === '{') d++;
        else if (c === '}') {
          d--;
          if (d === 0) return t.slice(i, j + 1);
        }
      }
      return null;
    }
    if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) depth--;
  }
  return null;
}

// Top-level entries of an object literal: [{key, value}]. Shorthand keys
// ({ name, url }) yield empty value text.
export function objectEntries(text) {
  if (!text) return [];
  const t = text.trim();
  if (!t.startsWith('{')) return [];
  const entries = [];
  let depth = 0;
  let i = 0;
  while (i < t.length) {
    const ch = t[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      i = skipString(t, i) + 1;
      continue;
    }
    if ('([{'.includes(ch)) {
      depth++;
      i++;
      continue;
    }
    if (')]}'.includes(ch)) {
      depth--;
      i++;
      continue;
    }
    if (depth === 1 && /[,{\s]/.test(t[i - 1] || '{')) {
      const m = t.slice(i).match(/^([\w$]+)\s*(:)?/);
      if (m && (m[2] || /^[\w$]+\s*[,}]/.test(t.slice(i)))) {
        if (!m[2]) {
          entries.push({ key: m[1], value: '' });
          i += m[1].length;
          continue;
        }
        const vs = i + m[0].length;
        let d = depth;
        let j = vs;
        while (j < t.length) {
          const c = t[j];
          if (c === '"' || c === "'" || c === '`') {
            j = skipString(t, j) + 1;
            continue;
          }
          if ('([{'.includes(c)) d++;
          else if (')]}'.includes(c)) {
            d--;
            if (d === 0) break;
          } else if (c === ',' && d === 1) break;
          j++;
        }
        entries.push({ key: m[1], value: t.slice(vs, j).trim() });
        i = j;
        continue;
      }
    }
    i++;
  }
  return entries;
}

function kindOf(value) {
  if (!value) return '';
  const t = value.trim();
  if (t.startsWith('[')) return 'list';
  if (t.startsWith('{')) return 'object';
  if (/^['"`]/.test(t)) return 'text';
  if (/^-?\d/.test(t)) return 'number';
  if (/^(true|false)$/.test(t)) return 'boolean';
  return '';
}

const MAP_HEAD_RE = /^([\s\S]+?)\.map\(\s*\(\s*([\w$]+)\s*(?:,\s*([\w$]+)\s*)?\)\s*=>\s*\($/;

// Follow a dotted path (['services'] or ['service','tags']) through value
// texts; stepping into an array uses its first object's shape.
function resolvePath(rootValue, parts) {
  let cur = rootValue;
  for (const part of parts) {
    const obj = cur && cur.trim().startsWith('[') ? firstObjectIn(cur) : cur;
    const entry = objectEntries(obj || '').find((e) => e.key === part);
    if (!entry) return null;
    cur = entry.value;
  }
  return cur;
}

// context: {frontmatter, imports: [{name}], ancestorHeads: [head, …]}
// query: the Data field's current text.
// Returns [{insert, label, hint}] — ONLY values that can actually be looped:
// known lists (including dotted paths like service.tags), plus names whose
// shape is unknown (imports, unresolvable loop items) which may be lists.
// Objects, strings, numbers, and index variables are never suggested.
export function dataSuggestions(context, query) {
  const decls = parseDeclarations(context.frontmatter || '');
  const out = [];
  const seen = new Set();
  const push = (insert, hint) => {
    if (!seen.has(insert)) {
      seen.add(insert);
      out.push({ insert, label: insert, hint });
    }
  };

  // Walk a known shape, collecting every dotted path that lands on a list.
  const addListPaths = (name, valueText, depth) => {
    const t = (valueText || '').trim();
    if (t.startsWith('[')) {
      push(name, 'list');
      return;
    }
    if (t.startsWith('{') && depth < 3) {
      for (const e of objectEntries(t)) {
        if (e.value) addListPaths(`${name}.${e.key}`, e.value, depth + 1);
      }
    }
  };

  for (const [name, value] of decls) addListPaths(name, value, 0);
  for (const imp of context.imports || []) {
    if (!decls.has(imp.name)) push(imp.name, 'import'); // shape unknown — may be a list
  }
  for (const head of context.ancestorHeads || []) {
    const m = String(head).trim().match(MAP_HEAD_RE);
    if (!m) continue;
    const dataExpr = m[1].trim();
    let shape = null;
    if (/^[\w$.]+$/.test(dataExpr)) {
      const [first, ...rest] = dataExpr.split('.');
      const rootVal = decls.get(first);
      const v = rootVal ? (rest.length ? resolvePath(rootVal, rest) : rootVal) : null;
      shape = v ? firstObjectIn(v) : null;
    }
    if (shape) addListPaths(m[2], shape, 0); // lists inside the item, e.g. service.tags
    else push(m[2], 'loop item'); // unknown shape — may itself be a list
    // index variables are numbers — never loopable, never suggested
  }

  const q = String(query || '').trim().toLowerCase();
  return out
    .filter((s) => !q || s.insert.toLowerCase().includes(q))
    .sort((a, b) => {
      const ap = a.insert.toLowerCase().startsWith(q) ? 0 : 1;
      const bp = b.insert.toLowerCase().startsWith(q) ? 0 : 1;
      return ap - bp || a.insert.length - b.insert.length;
    });
}
