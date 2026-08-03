// Parses .astro pages into an editable tree model and serializes the model
// back to clean .astro source.
//
// Node kinds:
//   component — <Hero .../> or <Section>...</Section> (capitalized)
//   element   — <div>, <img/>, any lowercase tag
//   text      — text content between tags (may contain {expressions})
//   comment   — <!-- ... -->
//   raw       — <style>/<script> blocks whose inner content is kept verbatim
//
// children: null = self-closing, [] = paired-but-empty, [nodes] otherwise.
//
// Pages whose template can't be represented (stray '<', unclosed tags,
// fragments) are reported as not editable so the UI falls back to code view.

const fs = require('fs');
const path = require('path');

const IMPORT_RE = /import\s+(\w+)\s+from\s+['"]([^'"]+)['"];?/g;
const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);
const RAW_ELEMENTS = new Set(['style', 'script']);

// Built-in components that come from a virtual import (no .astro file on disk)
// and so never appear in the page's IMPORT_RE matches. Treating them as
// components instead of dynamic tags is what lets the props panel show their
// schema; treating them as dynamic tags would strip the schema and the user
// would only see the raw attribute fields.
const BUILTIN_COMPONENTS = new Set([
  'Image', // from 'astro:assets'
  'Picture', // from 'astro:assets'
]);

// Top-level frontmatter keys the SEO/AEO panel writes via .sight/seo.json.
// The panel's canonical store is .sight/seo.json (see electron/main.js
// readSeoMeta / writeSeoMeta), but when a page needs the data inside its
// own frontmatter (e.g. so the layout reads it via `Astro.props.seo`), the
// parser preserves `seo:` as part of `extraFrontmatter`. Recognition here
// is what keeps the page editable instead of falling through to CodeMirror.
//
// { seo: { type: 'object' } }
const RECOGNIZED_FRONTMATTER_OBJECTS = new Set(['seo']);

// Returns true if the frontmatter text references a key the panel owns.
// The parser already preserves arbitrary frontmatter verbatim, so this is
// advisory — it lets the main-process writer know it can re-emit the same
// block without disturbing anything.
function hasRecognizedObjectKey(frontmatter, key) {
  return new RegExp(`(^|\n)${key}\s*:`).test(frontmatter);
}

let nextId = 1;
const makeId = () => `n${nextId++}`;

// ---------------------------------------------------------------------------
// Attribute (prop) parsing
// ---------------------------------------------------------------------------

// Values: {type:'string', value} | {type:'expr', value} | {type:'bare'}
// Expression values may contain one level of nested braces (attrs={{ a: 1 }}).
function parseAttrs(attrString) {
  const props = {};
  const re = /([\w@:.-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|\{((?:[^{}]|\{[^{}]*\})*)\}))?/g;
  let m;
  while ((m = re.exec(attrString)) !== null) {
    if (!m[0].trim()) continue;
    const name = m[1];
    if (m[2] !== undefined) props[name] = { type: 'string', value: m[2] };
    else if (m[3] !== undefined) props[name] = { type: 'string', value: m[3] };
    else if (m[4] !== undefined) props[name] = { type: 'expr', value: m[4].trim() };
    else props[name] = { type: 'bare' };
  }
  return props;
}

function serializeAttrs(props) {
  const parts = [];
  for (const [name, v] of Object.entries(props || {})) {
    if (v == null || v.type === 'bare') {
      parts.push(name);
    } else if (v.type === 'expr') {
      parts.push(`${name}={${v.value}}`);
    } else {
      parts.push(`${name}="${String(v.value).replace(/"/g, '&quot;')}"`);
    }
  }
  return parts.length ? ' ' + parts.join(' ') : '';
}

// ---------------------------------------------------------------------------
// Template parsing
// ---------------------------------------------------------------------------

const TAG_RE = /<([A-Za-z][\w.-]*)((?:[^>"'{]|"[^"]*"|'[^']*'|\{(?:[^{}]|\{[^{}]*\})*\})*?)(\/?)>/y;

// Finds the index of the '}' matching the '{' at `start`, skipping string
// and template literals so quotes/braces inside them don't confuse counting.
function findMatchingBrace(str, start) {
  let depth = 0;
  for (let i = start; i < str.length; i++) {
    const ch = str[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      i++;
      while (i < str.length && str[i] !== ch) {
        if (str[i] === '\\') i++;
        i++;
      }
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// Finds the index of the ')' matching the '(' at `start`, skipping strings.
function findMatchingParen(str, start) {
  let depth = 0;
  for (let i = start; i < str.length; i++) {
    const ch = str[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      i++;
      while (i < str.length && str[i] !== ch) {
        if (str[i] === '\\') i++;
        i++;
      }
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// Recognizes {items.map((item) => ( <JSX/> ))} and turns it into a 'map'
// node whose JSX body is a parsed child tree (editable in the navigator).
// Returns null when the expression doesn't fit the pattern.
function tryParseMap(exprText) {
  const inner = exprText.slice(1, -1); // strip the outer { }
  const arrow = inner.match(/^([\s\S]*?\.map\(\s*\(([^)]*)\)\s*=>\s*\()/);
  if (!arrow) return null;
  const headRaw = arrow[1];
  const openIdx = arrow[0].length - 1; // the arrow-body '('
  const closeIdx = findMatchingParen(inner, openIdx);
  if (closeIdx === -1) return null;
  // After the body must come only the .map() close paren.
  if (!/^\s*\)\s*$/.test(inner.slice(closeIdx + 1))) return null;
  const body = inner.slice(openIdx + 1, closeIdx);
  const parsed = parseTemplate(body);
  if (!parsed.clean) return null;
  return {
    id: makeId(),
    kind: 'map',
    head: headRaw.replace(/\s+/g, ' ').trim(), // e.g. "stats.map((stat) => ("
    children: parsed.nodes,
  };
}

// Parses a template string into a node tree.
// Returns {nodes, clean}; clean=false means unrepresentable content was found.
function parseTemplate(str) {
  const nodes = [];
  let pos = 0;

  while (pos < str.length) {
    const lt = str.indexOf('<', pos);
    const br = str.indexOf('{', pos);
    const next =
      lt === -1 ? br : br === -1 ? lt : Math.min(lt, br);

    // Trailing / inter-tag text. Boundary whitespace collapses to a single
    // space rather than vanishing — "people <strong>" must keep its space
    // (HTML renders a newline+indent boundary as one space too).
    const textEnd = next === -1 ? str.length : next;
    const text = str.slice(pos, textEnd);
    if (text.trim()) {
      const value =
        (/^\s/.test(text) ? ' ' : '') +
        collapseWhitespace(text) +
        (/\s$/.test(text) ? ' ' : '');
      nodes.push({ id: makeId(), kind: 'text', value });
    }
    if (next === -1) break;

    // {expression} — a recognized .map() becomes a structural loop node;
    // anything else is kept verbatim as an opaque node (may contain JSX).
    if (next === br && (lt === -1 || br < lt)) {
      const close = findMatchingBrace(str, br);
      if (close === -1) return { nodes, clean: false };
      const exprText = str.slice(br, close + 1);
      const mapNode = tryParseMap(exprText);
      nodes.push(mapNode || { id: makeId(), kind: 'expr', value: exprText });
      pos = close + 1;
      continue;
    }

    // Comment
    if (str.startsWith('<!--', lt)) {
      const end = str.indexOf('-->', lt + 4);
      if (end === -1) return { nodes, clean: false };
      nodes.push({ id: makeId(), kind: 'comment', value: str.slice(lt + 4, end) });
      pos = end + 3;
      continue;
    }

    // Doctype
    if (/^<!doctype/i.test(str.slice(lt))) {
      const end = str.indexOf('>', lt);
      if (end === -1) return { nodes, clean: false };
      nodes.push({ id: makeId(), kind: 'raw-line', value: str.slice(lt, end + 1) });
      pos = end + 1;
      continue;
    }

    TAG_RE.lastIndex = lt;
    const m = TAG_RE.exec(str);
    if (!m) return { nodes, clean: false }; // stray '<' or fragment <>

    const [full, name, attrs, selfClose] = m;
    // One level of nested braces in an attribute ({{ a: 1 }}) is supported;
    // anything deeper would be corrupted by the attr parser — bail to code
    // view instead.
    if (/=\s*\{[^{}]*\{[^{}]*\{/.test(attrs)) return { nodes, clean: false };
    const isComponent = /^[A-Z]/.test(name);
    const kind = isComponent ? 'component' : 'element';
    const afterOpen = lt + full.length;

    if (selfClose === '/' || (!isComponent && VOID_ELEMENTS.has(name.toLowerCase()))) {
      nodes.push({ id: makeId(), kind, name, props: parseAttrs(attrs), children: null });
      pos = afterOpen;
      continue;
    }

    // <style>/<script>: capture inner verbatim, no parsing.
    if (!isComponent && RAW_ELEMENTS.has(name.toLowerCase())) {
      const close = str.indexOf(`</${name}`, afterOpen);
      if (close === -1) return { nodes, clean: false };
      const closeEnd = str.indexOf('>', close);
      nodes.push({
        id: makeId(),
        kind: 'raw',
        name,
        props: parseAttrs(attrs),
        inner: str.slice(afterOpen, close),
      });
      pos = closeEnd + 1;
      continue;
    }

    const closeIdx = findMatchingClose(str, afterOpen, name);
    if (closeIdx === -1) return { nodes, clean: false };
    const innerResult = parseTemplate(str.slice(afterOpen, closeIdx));
    if (!innerResult.clean) return { nodes, clean: false };
    nodes.push({
      id: makeId(),
      kind,
      name,
      props: parseAttrs(attrs),
      children: innerResult.nodes,
    });
    // The close tag may contain whitespace: </Name >
    pos = str.indexOf('>', closeIdx) + 1;
  }

  return { nodes, clean: true };
}

// Index of the close tag matching an already-consumed open tag, handling
// nested same-name tags.
function findMatchingClose(str, from, name) {
  // The previous regex-based approach used the `g` flag, which scans
  // forward from `from` and could match a *later* <name opening tag inside
  // the same block — throwing the depth counter off and returning -1 for
  // valid pages with nested <div>s (e.g. index.astro with 8 levels of
  // div nesting). We walk character by character instead, recognizing tag-
  // like sequences only when they correspond to `name` and are not inside
  // an attribute string or template expression. Crucially, when we see a
  // `<` that isn't a tag for `name`, we skip past the *entire* tag (not
  // just one character), so we never accidentally count a substring.
  const escName = escapeRe(name);
  let depth = 1;
  let i = from;
  while (i < str.length) {
    // Find the next '<'
    const lt = str.indexOf('<', i);
    if (lt === -1) return -1;
    // What kind of tag is at < ?
    const afterLt = str.charAt(lt + 1);
    if (afterLt === '!') {
      // Comment <!-- ... --> or doctype <! ... >. Skip both.
      if (str.startsWith('<!--', lt)) {
        const end = str.indexOf('-->', lt + 4);
        if (end === -1) return -1;
        i = end + 3;
        continue;
      }
      const end = str.indexOf('>', lt);
      if (end === -1) return -1;
      i = end + 1;
      continue;
    }
    if (afterLt === '/') {
      // Closing tag </name ...> or </other>
      const rest = str.slice(lt + 2, lt + 2 + escName.length);
      // Compare names case-insensitively (HTML convention).
      if (rest.toLowerCase() === escName.toLowerCase()) {
        // Confirm with whitespace or > after the name.
        const after = str.charAt(lt + 2 + escName.length);
        if (after === ' ' || after === '\t' || after === '\n' || after === '\r' || after === '>') {
          depth--;
          if (depth === 0) return lt;
          const end = str.indexOf('>', lt);
          if (end === -1) return -1;
          i = end + 1;
          continue;
        }
      }
      // Some other close tag. Skip past it.
      const end = str.indexOf('>', lt);
      if (end === -1) return -1;
      i = end + 1;
      continue;
    }
    // Opening tag for some name. Get the tag name.
    const nameMatch = /^([A-Za-z][\w.-]*)/.exec(str.slice(lt + 1));
    if (!nameMatch) {
      // Stray '<' — not a tag. Skip one char and keep going.
      i = lt + 1;
      continue;
    }
    const tagName = nameMatch[1];
    // Find the end of this tag, respecting attribute strings and {} exprs.
    const tagEnd = scanTagEnd(str, lt);
    if (tagEnd === -1) return -1;
    const selfClose = str.charAt(tagEnd - 1) === '/';
    if (tagName.toLowerCase() === escName.toLowerCase()) {
      if (!selfClose) depth++;
      if (depth === 0) return lt; // unreachable but safe
    }
    // For raw elements (script, style), skip their entire content.
    if (!selfClose && (tagName.toLowerCase() === 'script' || tagName.toLowerCase() === 'style')) {
      const close = str.toLowerCase().indexOf('</' + tagName.toLowerCase(), tagEnd + 1);
      if (close === -1) return -1;
      const closeEnd = str.indexOf('>', close);
      if (closeEnd === -1) return -1;
      i = closeEnd + 1;
      continue;
    }
    i = tagEnd + 1;
  }
  return -1;
}

// Scan forward from `start` (which must be '<') to find the `>` that ends
// the tag, skipping over attribute strings ("..." / '...') and one level
// of {} template expressions. Returns the index of `>`, or -1 if unclosed.
function scanTagEnd(str, start) {
  let i = start + 1;
  while (i < str.length) {
    const c = str[i];
    if (c === '"' || c === "'") {
      const close = str.indexOf(c, i + 1);
      if (close === -1) return -1;
      i = close + 1;
      continue;
    }
    if (c === '{') {
      // Skip one level of {} (with one level of nested {} inside).
      let d = 1;
      i++;
      while (i < str.length && d > 0) {
        if (str[i] === '{') d++;
        else if (str[i] === '}') d--;
        else if (str[i] === '"' || str[i] === "'") {
          const close = str.indexOf(str[i], i + 1);
          if (close === -1) return -1;
          i = close;
        }
        i++;
      }
      if (d !== 0) return -1;
      continue;
    }
    if (c === '>') return i;
    i++;
  }
  return -1;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function collapseWhitespace(text) {
  return text.replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Page parse / serialize
// ---------------------------------------------------------------------------

// Returns {editable: true, model} or {editable: false, reason}.
// model = {imports, extraFrontmatter, nodes: tree}. The page's layout wrapper
// (if any) stays in the tree as a regular node with the well-known id
// 'layout', so nodes can live before/after it at the top level.
function parsePage(source) {
  // Reset the id counter so calls are deterministic — the previous
  // nextId value may have been bumped by a prior parsePage invocation,
  // which produced different ids on every call and broke anything that
  // captured a node id and then re-parsed the same source to look it up.
  nextId = 1;
  const fm = source.match(/^---\r?\n(?:([\s\S]*?)\r?\n)?---\r?\n?/);
  const frontmatter = fm ? fm[1] || '' : '';
  const body = fm ? source.slice(fm[0].length) : source;

  const imports = [];
  let extraFrontmatter = frontmatter;
  let m;
  IMPORT_RE.lastIndex = 0;
  while ((m = IMPORT_RE.exec(frontmatter)) !== null) {
    imports.push({ name: m[1], path: m[2] });
    extraFrontmatter = extraFrontmatter.replace(m[0], '');
  }
  extraFrontmatter = extraFrontmatter.trim();

  const { nodes: topNodes, clean } = parseTemplate(body);
  if (!clean) {
    return {
      editable: false,
      reason: 'Page contains markup the visual editor cannot represent (unclosed tags, fragments, or template expressions outside props).',
    };
  }

  const importsByName = Object.fromEntries(imports.map((i) => [i.name, i]));

  // Layout detection: a single top-level component wrapping the whole page,
  // or — when siblings live outside it — exactly one top-level component
  // whose import path mentions "layout". The wrapper keeps its place in the
  // tree; it's just tagged with the well-known id 'layout'.
  const significant = topNodes.filter((n) => n.kind !== 'comment');
  let wrapper = null;
  if (
    significant.length === 1 &&
    significant[0].kind === 'component' &&
    significant[0].children !== null
  ) {
    wrapper = significant[0];
  } else if (significant.length > 1) {
    const layoutish = significant.filter(
      (n) =>
        n.kind === 'component' &&
        n.children !== null &&
        /layout/i.test(importsByName[n.name]?.path || '')
    );
    if (layoutish.length === 1) wrapper = layoutish[0];
  }
  if (wrapper) wrapper.id = 'layout';

  // A capitalized tag that isn't imported is a dynamic tag, not a component:
  // `const Tag = tag` then `<Tag>` is how an Astro component renders a
  // caller-chosen element. Flag those so the UI treats them as elements —
  // they have no file to open and no props of their own.
  const markDynamic = (list) => {
    for (const n of list) {
      if (n.kind === 'component' && !importsByName[n.name] && !BUILTIN_COMPONENTS.has(n.name)) n.dynamicTag = true;
      if (Array.isArray(n.children)) markDynamic(n.children);
    }
  };
  markDynamic(topNodes);

  return { editable: true, model: { imports, extraFrontmatter, nodes: topNodes } };
}

function serializePage(model) {
  const lines = ['---'];
  for (const imp of model.imports) {
    lines.push(`import ${imp.name} from '${imp.path}';`);
  }
  if (model.extraFrontmatter) {
    lines.push('', model.extraFrontmatter);
  }
  lines.push('---');

  for (const node of model.nodes) serializeNode(node, '', lines);
  return lines.join('\n') + '\n';
}

// Inline runs (text + simple tags like <strong>/<em>) serialize on a single
// line so the exact spacing between words and tags survives the round trip.
const INLINE_TAGS = new Set([
  'strong', 'em', 'b', 'i', 'sup', 'sub', 'code', 'a', 'span', 'br',
  'small', 'mark', 'u', 's',
]);

// Simple {expr} interpolations (single braces, no JSX) count as inline.
function isSimpleExpr(n) {
  return n.kind === 'expr' && /^\{[^{}]*\}$/.test(n.value) && !n.value.includes('<');
}

function isInlineRun(nodes) {
  return (
    nodes.length > 0 &&
    nodes.every(
      (n) =>
        n.kind === 'text' ||
        isSimpleExpr(n) ||
        (n.kind === 'element' &&
          INLINE_TAGS.has(n.name.toLowerCase()) &&
          (n.children === null || n.children.length === 0 || isInlineRun(n.children)))
    )
  );
}

function inlineString(nodes) {
  let out = '';
  for (const n of nodes) {
    if (n.kind === 'text') out += n.value;
    else if (n.kind === 'expr') out += n.value;
    else if (n.children === null || n.children.length === 0) {
      out += n.name === 'br' ? '<br />' : `<${n.name}${serializeAttrs(n.props)} />`;
    } else {
      out += `<${n.name}${serializeAttrs(n.props)}>${inlineString(n.children)}</${n.name}>`;
    }
  }
  return out;
}

function serializeNode(node, indent, lines) {
  // Chunk containers: children live in external .html files (set:html),
  // never in the page — emit the component self-closing, skip the subtree.
  if (node.kind === 'chunk-group') return; // synthetic, not in page source
  if (node.chunkFile || node.chunkAggregate) {
    lines.push(`${indent}<${node.name}${serializeAttrs(node.props)} />`);
    return;
  }
  switch (node.kind) {
    case 'text':
      lines.push(indent + node.value);
      return;
    case 'expr': {
      // Verbatim, multi-line safe: only the first line gets the tree indent
      // (subsequent lines carry their original indentation).
      const exprLines = node.value.split('\n');
      lines.push(indent + exprLines[0]);
      for (let i = 1; i < exprLines.length; i++) lines.push(exprLines[i]);
      return;
    }
    case 'map':
      lines.push(indent + '{');
      lines.push(indent + '  ' + node.head);
      for (const child of node.children || []) serializeNode(child, indent + '    ', lines);
      lines.push(indent + '  ))');
      lines.push(indent + '}');
      return;
    case 'comment':
      lines.push(`${indent}<!--${node.value}-->`);
      return;
    case 'raw-line':
      lines.push(indent + node.value);
      return;
    case 'raw': {
      lines.push(`${indent}<${node.name}${serializeAttrs(node.props)}>`);
      // Keep raw inner verbatim (trim outer blank lines only).
      const inner = node.inner.replace(/^\r?\n/, '').replace(/\s+$/, '');
      if (inner) lines.push(inner);
      lines.push(`${indent}</${node.name}>`);
      return;
    }
    default: {
      const attrs = serializeAttrs(node.props);
      if (node.children === null) {
        lines.push(`${indent}<${node.name}${attrs} />`);
        return;
      }
      // Inline runs stay on one line: <p>We're <strong>Acme</strong>.</p>
      if (node.children.length > 0 && isInlineRun(node.children)) {
        lines.push(`${indent}<${node.name}${attrs}>${inlineString(node.children).trim()}</${node.name}>`);
        return;
      }
      lines.push(`${indent}<${node.name}${attrs}>`);
      for (const child of node.children) serializeNode(child, indent + '  ', lines);
      lines.push(`${indent}</${node.name}>`);
    }
  }
}

// Dev-preview variant used by the marker Vite plugin: wraps every node in
// <template data-avb-s/e="path"> boundary markers (path = index trail, e.g.
// "0.2.1") so the preview iframe can map rendered DOM back to model nodes.
// The preview strips the markers from the DOM right after recording them, so
// they never affect structural CSS selectors (:first-child, :nth-child, …).
// Children of {…map} loops render once per item and are left unmarked.
// Chunk subtrees can't be marked here — they render from an imported HTML
// string, not from page markup — so the ?raw import carries the Fragment's
// path and the dev plugin marks the chunk module itself. Passing it through
// the id (rather than a side map) also keys Vite's cache: move the Fragment
// and the chunk module's id changes with it.
function serializePageMarked(model) {
  const marks = chunkImportMarks(model);
  const lines = ['---'];
  for (const imp of model.imports) {
    const mark = /\.html\?raw$/i.test(imp.path) ? marks.get(imp.name) : null;
    const spec = mark
      ? `${imp.path}&avb=${mark.path}${mark.group ? '&avbg=1' : ''}`
      : imp.path;
    lines.push(`import ${imp.name} from '${spec}';`);
  }
  if (model.extraFrontmatter) {
    lines.push('', model.extraFrontmatter);
  }
  lines.push('---');
  model.nodes.forEach((node, i) => serializeNodeMarked(node, '', lines, String(i)));
  return lines.join('\n') + '\n';
}

function serializeNodeMarked(node, indent, lines, path) {
  if (node.kind === 'chunk-group') return; // synthetic, not in page source
  // A slotted node's markers must go into the same named slot, or they'd
  // land in the default slot while the node renders elsewhere.
  const slotVal = node.props?.slot;
  const slotAttr =
    slotVal && slotVal.type === 'string' && slotVal.value ? ` slot="${slotVal.value}"` : '';
  lines.push(`${indent}<template${slotAttr} data-avb-s="${path}"></template>`);
  if (
    (node.kind === 'component' || node.kind === 'element') &&
    !node.chunkFile &&
    !node.chunkAggregate &&
    Array.isArray(node.children) &&
    // Inline runs serialize as one line — markers between words would break
    // spacing (each marker's surrounding newlines render as a space).
    !(node.children.length > 0 && isInlineRun(node.children))
  ) {
    const attrs = serializeAttrs(node.props);
    lines.push(`${indent}<${node.name}${attrs}>`);
    node.children.forEach((child, i) =>
      serializeNodeMarked(child, indent + '  ', lines, `${path}.${i}`)
    );
    lines.push(`${indent}</${node.name}>`);
  } else if (node.kind === 'map') {
    // Loop children render once per item, so their marker pairs repeat in
    // the DOM — the collector unions every instance into one region.
    lines.push(indent + '{');
    lines.push(indent + '  ' + node.head);
    (node.children || []).forEach((child, i) =>
      serializeNodeMarked(child, indent + '    ', lines, `${path}.${i}`)
    );
    lines.push(indent + '  ))');
    lines.push(indent + '}');
  } else {
    serializeNode(node, indent, lines);
  }
  lines.push(`${indent}<template${slotAttr} data-avb-e="${path}"></template>`);
}

// ---------------------------------------------------------------------------
// Component prop schema extraction
// ---------------------------------------------------------------------------

// Returns [{name, type: 'string'|'number'|'boolean'|'other', optional, default}]
function parsePropSchema(source) {
  const fm = source.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const frontmatter = fm ? fm[1] : '';
  const schema = new Map();

  // Collect local type aliases (type HeadingTag = "h1" | "h2" | ...) so
  // props referencing them resolve to their union options.
  const aliases = new Map();
  const aliasRe = /(?:export\s+)?type\s+(\w+)\s*=\s*([\s\S]*?);/g;
  let am;
  while ((am = aliasRe.exec(frontmatter)) !== null) {
    if (am[1] !== 'Props') aliases.set(am[1], am[2].trim());
  }

  const iface = frontmatter.match(/(?:export\s+)?(?:interface|type)\s+Props\s*(?:extends\s+[^{]+)?(?:=\s*)?\{([\s\S]*?)\n\}/);
  if (iface) {
    const entryRe = /^\s*(\w+)(\?)?\s*:\s*([^;\n]+?)[;,]?\s*$/gm;
    let m;
    while ((m = entryRe.exec(iface[1])) !== null) {
      let typeStr = m[3].trim();
      if (aliases.has(typeStr)) typeStr = aliases.get(typeStr);
      const { type, options } = normalizeType(typeStr);
      schema.set(m[1], {
        name: m[1],
        type,
        options,
        optional: !!m[2],
        default: undefined,
      });
    }
  }

  const destructure = frontmatter.match(/(?:const|let)\s*\{([\s\S]*?)\}\s*=\s*Astro\.props/);
  if (destructure) {
    // Rest params (...rest) aren't real props, and renames (class: className)
    // should register under the real prop name only.
    destructure[1] = destructure[1]
      .replace(/\.\.\.\s*\w+/g, '')
      .replace(/(\w+)\s*:\s*\w+/g, '$1');
    // Defaults can be quoted strings, shallow object/array literals ({} or
    // { a: 1 }), or plain expressions — the literal alternatives come first
    // so `= {}` isn't truncated at the closing brace.
    const entryRe =
      /(\w+)(?:\s*=\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\{[^{}]*\}|\[[^\][]*\]|[^,\n}]+))?/g;
    let m;
    while ((m = entryRe.exec(destructure[1])) !== null) {
      if (!m[1]) continue;
      const existing = schema.get(m[1]) || {
        name: m[1],
        type: 'other',
        optional: true,
        default: undefined,
      };
      if (m[2] !== undefined) {
        let def = m[2].trim();
        if (/^["'`]/.test(def)) {
          existing.default = def.slice(1, -1);
          if (existing.type === 'other') existing.type = 'string';
        } else if (/^(true|false)$/.test(def)) {
          existing.default = def === 'true';
          if (existing.type === 'other') existing.type = 'boolean';
        } else if (/^-?\d+(\.\d+)?$/.test(def)) {
          existing.default = Number(def);
          if (existing.type === 'other') existing.type = 'number';
        } else {
          // Not a literal — an identifier or expression (e.g. SITE_TITLE).
          // Flag it so the scanner can try resolving it to a real value.
          existing.default = def;
          existing.defaultExpr = true;
          // An object-literal default marks an attributes-object prop.
          if (existing.type === 'other' && /^\{/.test(def)) existing.type = 'attrs';
        }
        existing.optional = true;
      }
      schema.set(m[1], existing);
    }
  }

  return [...schema.values()];
}

// Slot names a component's template exposes: 'default' for <slot>/<slot />,
// plus any <slot name="x">. Default first, then named in appearance order.
function parseSlots(source) {
  const fm = source.match(/^---\r?\n(?:[\s\S]*?\r?\n)?---\r?\n?/);
  const body = fm ? source.slice(fm[0].length) : source;
  const found = new Set();
  const re = /<slot\b((?:[^>"'{]|"[^"]*"|'[^']*'|\{[^}]*\})*?)\/?>/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    const nameMatch = m[1].match(/\bname\s*=\s*(?:"([^"]*)"|'([^']*)')/);
    found.add(nameMatch ? nameMatch[1] ?? nameMatch[2] : 'default');
  }
  const named = [...found].filter((s) => s !== 'default');
  return found.has('default') ? ['default', ...named] : named;
}

// ---------------------------------------------------------------------------
// Transition directive recognition
//
// The Transitions panel can also read transitions off a parsed model rather
// than rescanning the raw source — handy for inline hover cards or for any
// future feature that doesn't want to round-trip to the file scanner. The
// shape returned matches the scanner's: each row is
//   { kind, value, page, line, col }.
// `page` here is a synthetic `{ rel: '<model>' }` — the caller can replace it
// with a real page descriptor since models don't carry a file path. `line`
// and `col` are 1-based start positions in the serialized source, so a future
// "open at location" feature can jump straight to the directive.
//
// We only act on `transition:name` and `transition:animate` — the two Astro
// 5 directives that participate in a morph. `transition:persist` doesn't
// carry a value to share and is out of scope for the panel.
// ---------------------------------------------------------------------------

// Recursively walks a parsed model and returns the same {kind, value, …}
// shape the scanner produces. Recursion uses the same `path` the marker
// serializer does, so line numbers from `serializePage(model)` match the
// one the user reads in the editor.
function parseTransitionsFromModel(model, source) {
  const out = [];
  if (!model || !Array.isArray(model.nodes)) return out;
  // Compute line starts lazily — only if we need them. A model with no
  // transitions returns the empty list without paying for the serialization.
  let lineStarts = null;
  const positionOf = (offset) => {
    if (lineStarts == null) {
      lineStarts = computeLineStarts(source != null ? source : serializePage(model));
    }
    return offsetToLineCol(lineStarts, offset);
  };
  for (const node of model.nodes) {
    walkNode(node, '', out, positionOf);
  }
  return out;
}

function walkNode(node, path, out, positionOf) {
  if (!node) return;
  if (node.props) {
    for (const [name, v] of Object.entries(node.props)) {
      if (name === 'transition:name' && v && (v.type === 'string' || v.type === 'expr')) {
        out.push({
          kind: 'name',
          value: v.type === 'string' ? v.value : v.value,
          page: { rel: '<model>' },
          // The model doesn't carry positions, so the caller can
          // re-derive them from the serialized source if needed.
          line: 0,
          col: 0,
          path: path,
          meta: { expr: v.type === 'expr' },
        });
      } else if (name === 'transition:animate' && v && (v.type === 'string' || v.type === 'expr')) {
        out.push({
          kind: 'animate',
          value: v.type === 'string' ? v.value : v.value,
          page: { rel: '<model>' },
          line: 0,
          col: 0,
          path: path,
          meta: { expr: v.type === 'expr' },
        });
      }
    }
  }
  if (Array.isArray(node.children)) {
    node.children.forEach((child, i) =>
      walkNode(child, path ? path + '.' + i : String(i), out, positionOf)
    );
  }
}

function computeLineStarts(source) {
  const starts = [0];
  for (let i = 0; i < source.length; i++) {
    if (source.charCodeAt(i) === 10 /* \n */) starts.push(i + 1);
  }
  return starts;
}

function offsetToLineCol(starts, offset) {
  // Binary search for the line.
  let lo = 0, hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, col: offset - starts[lo] + 1 };
}

// Extracts the tag from `interface Props extends HTMLAttributes<"button">`
// so the UI can offer that element's built-in attributes (type, disabled, …).
function parseExtendsTag(source) {
  const fm = source.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const frontmatter = fm ? fm[1] : '';
  const m = frontmatter.match(
    /interface\s+Props\s+extends\s+(?:astroHTML\.JSX\.)?HTMLAttributes\s*<\s*['"](\w+)['"]\s*>/
  );
  return m ? m[1] : null;
}

function normalizeType(t) {
  // Union of string literals ('primary' | 'secondary') → enum with options.
  const parts = t.split('|').map((s) => s.trim()).filter(Boolean);
  if (parts.length > 1) {
    const literals = parts.filter((p) => /^(['"`]).*\1$/.test(p));
    const rest = parts.filter((p) => !/^(['"`]).*\1$/.test(p));
    if (literals.length >= 2 && rest.every((p) => p === 'undefined' || p === 'null')) {
      return { type: 'enum', options: literals.map((p) => p.slice(1, -1)) };
    }
  }
  if (/^string\b/.test(t)) return { type: 'string' };
  if (/^number\b/.test(t)) return { type: 'number' };
  if (/^boolean\b/.test(t)) return { type: 'boolean' };
  if (/^(['"`]).*\1$/.test(t)) return { type: 'string' };
  // Objects of attributes (HTMLAttributes<"div">, Record<string, …>) edit
  // as name/value rows.
  if (/^(HTMLAttributes\b|astroHTML\.|Record\s*<)/.test(t)) return { type: 'attrs' };
  return { type: 'other' };
}

// Serializes a plain node list (used for standalone HTML chunk files).
function serializeNodes(nodes) {
  const lines = [];
  for (const node of nodes) serializeNode(node, '', lines);
  return lines.join('\n') + '\n';
}



// Serialize a node (and its subtree) to a plain JSON object suitable for
// sending to an AI model. AttrValues are flattened to primitive strings so
// the model sees a stable JSON shape, and chunk-file children (which are
// stored in external .html files, not the model) are omitted. Used by the
// AI inline-edit feature to give the model structured context.
function serializeNodeToJson(node) {
  if (node == null) return null;
  const out = { id: node.id, kind: node.kind };
  if (node.kind === 'element' || node.kind === 'component' || node.kind === 'raw') {
    out.name = node.name;
    out.props = {};
    for (const k of Object.keys(node.props || {})) {
      const v = node.props[k];
      out.props[k] = v && typeof v === 'object' && 'value' in v ? v.value : v;
    }
    if (node.frontmatter) out.frontmatter = { ...node.frontmatter };
  }
  if (node.kind === 'text' || node.kind === 'expr' || node.kind === 'comment' || node.kind === 'raw-line') {
    out.value = node.value;
  }
  if (node.kind === 'map') {
    out.head = node.head;
    out.children = (node.children || []).map(serializeNodeToJson);
  } else if (node.kind === 'element' || node.kind === 'component') {
    out.children = (node.children || []).map(serializeNodeToJson);
  }
  return out;
}

// ---------------------------------------------------------------------------
// HTML chunks
// ---------------------------------------------------------------------------
// Pages built as <Fragment set:html={x} /> where x is an import of
// "chunks/foo.html?raw" (or a joined array of them). The chunk files' markup
// is parsed into the Fragment's children so it's editable in the navigator;
// edits are written back to the chunk file, never the page.

let chunkGroupId = 1;

function resolveChunks(model, pagePath) {
  // ident -> absolute chunk file path
  const rawImports = new Map();
  for (const imp of model.imports) {
    if (/\.html\?raw$/i.test(imp.path) && imp.path.startsWith('.')) {
      rawImports.set(
        imp.name,
        path.resolve(path.dirname(pagePath), imp.path.replace(/\?raw$/i, ''))
      );
    }
  }
  if (!rawImports.size) return;

  // const main = [a, b, c].join("") aggregations in the frontmatter.
  const aggregates = new Map();
  const aggRe = /(?:const|let)\s+(\w+)\s*=\s*\[([^\]]*)\]\s*\.join\(/g;
  let am;
  while ((am = aggRe.exec(model.extraFrontmatter || '')) !== null) {
    const idents = am[2].split(',').map((s) => s.trim()).filter(Boolean);
    if (idents.length && idents.every((i) => /^\w+$/.test(i))) {
      aggregates.set(am[1], idents);
    }
  }

  const parseChunkFile = (filePath) => {
    try {
      const { nodes, clean } = parseTemplate(fs.readFileSync(filePath, 'utf8'));
      return clean ? nodes : null;
    } catch {
      return null;
    }
  };

  const walk = (list) => {
    for (const node of list) {
      if (
        node.kind === 'component' &&
        node.props?.['set:html']?.type === 'expr' &&
        node.children == null
      ) {
        const ref = node.props['set:html'].value.trim();
        if (rawImports.has(ref)) {
          const file = rawImports.get(ref);
          const children = parseChunkFile(file);
          if (children) {
            node.chunkFile = file;
            node.children = children;
          }
          continue;
        }
        if (aggregates.has(ref)) {
          const groups = [];
          for (const ident of aggregates.get(ref)) {
            if (!rawImports.has(ident)) continue;
            const file = rawImports.get(ident);
            const children = parseChunkFile(file);
            if (children) {
              groups.push({
                id: `chunk${chunkGroupId++}`,
                kind: 'chunk-group',
                name: ident,
                chunkFile: file,
                children,
              });
            }
          }
          if (groups.length) {
            node.children = groups;
            node.chunkAggregate = true;
          }
          continue;
        }
      }
      if (Array.isArray(node.children)) walk(node.children);
    }
  };
  walk(model.nodes);
}

// Marker path each chunk import's content occupies in the tree, keyed by the
// import's identifier: the Fragment's own path for a lone chunk, the
// chunk-group's path for each member of a joined aggregate. Requires a model
// that's been through resolveChunks.
function chunkImportMarks(model) {
  const marks = new Map();
  const walk = (list, prefix) => {
    list.forEach((node, i) => {
      const p = prefix ? `${prefix}.${i}` : String(i);
      if (node.chunkFile) {
        const group = node.kind === 'chunk-group';
        const ident = group ? node.name : node.props?.['set:html']?.value?.trim();
        if (ident) marks.set(ident, { path: p, group });
      }
      if (Array.isArray(node.children)) walk(node.children, p);
    });
  };
  walk(model.nodes, '');
  return marks;
}

// Dev-preview only: the chunk's markup with the same boundary markers the
// page serializer emits, numbered from the Fragment's (or group's) path so
// chunk nodes address identically to the app's tree. A group also gets a
// marker pair of its own — nothing in the page wraps it. Returns null when
// the chunk isn't representable, so the caller can serve it unmarked.
function markChunkHtml(source, prefix, group) {
  const { nodes, clean } = parseTemplate(source);
  if (!clean) return null;
  const lines = [];
  if (group) lines.push(`<template data-avb-s="${prefix}"></template>`);
  nodes.forEach((node, i) => serializeNodeMarked(node, '', lines, `${prefix}.${i}`));
  if (group) lines.push(`<template data-avb-e="${prefix}"></template>`);
  return lines.join('\n') + '\n';
}

module.exports = {
  parsePage,
  serializePage,
  serializePageMarked,
  parseTemplate,
  serializeNodes,
  resolveChunks,
  markChunkHtml,
  parsePropSchema,
  parseExtendsTag,
  parseSlots,
  parseAttrs,
  serializeAttrs,
  serializeNodeToJson,

  parseTransitionsFromModel,

  hasRecognizedObjectKey,
  RECOGNIZED_FRONTMATTER_OBJECTS,
};
