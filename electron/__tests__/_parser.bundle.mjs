var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});

// electron/astroParser.js
var fs = __require("fs");
var path = __require("path");
var IMPORT_RE = /import\s+(\w+)\s+from\s+['"]([^'"]+)['"];?/g;
var VOID_ELEMENTS = /* @__PURE__ */ new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr"
]);
var RAW_ELEMENTS = /* @__PURE__ */ new Set(["style", "script"]);
function emitDesignSystemTokens(name, tokens = {}) {
  if (!name || !/^[a-z0-9-]+$/.test(name)) return "";
  const safe = (v) => String(v).replace(/[\\\n\r;\{\}]/g, "");
  const lines = Object.entries(tokens).filter(([k, v]) => typeof k === "string" && /^--[a-z0-9-]+$/i.test(k)).map(([k, v]) => `  ${k}: ${safe(v)};`).join("\n");
  if (!lines) return "";
  return `<style>:root[data-design-system="${name}"] {
${lines}
}</style>`;
}
var BUILTIN_COMPONENTS = /* @__PURE__ */ new Set([
  "Image",
  // from 'astro:assets'
  "Picture"
  // from 'astro:assets'
]);
var RECOGNIZED_FRONTMATTER_OBJECTS = /* @__PURE__ */ new Set(["seo"]);
function hasRecognizedObjectKey(frontmatter, key) {
  return new RegExp(`(^|
)${key}s*:`).test(frontmatter);
}
var nextId = 1;
var makeId = () => `n${nextId++}`;
function parseAttrs(attrString) {
  const props = {};
  const re = /([\w@:.-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|\{((?:[^{}]|\{[^{}]*\})*)\}))?/g;
  let m;
  while ((m = re.exec(attrString)) !== null) {
    if (!m[0].trim()) continue;
    const name = m[1];
    if (m[2] !== void 0) props[name] = { type: "string", value: m[2] };
    else if (m[3] !== void 0) props[name] = { type: "string", value: m[3] };
    else if (m[4] !== void 0) props[name] = { type: "expr", value: m[4].trim() };
    else props[name] = { type: "bare" };
  }
  return props;
}
function serializeAttrs(props) {
  const parts = [];
  for (const [name, v] of Object.entries(props || {})) {
    if (v == null || v.type === "bare") {
      parts.push(name);
    } else if (v.type === "expr") {
      parts.push(`${name}={${v.value}}`);
    } else {
      parts.push(`${name}="${String(v.value).replace(/"/g, "&quot;")}"`);
    }
  }
  return parts.length ? " " + parts.join(" ") : "";
}
var TAG_RE = /<([A-Za-z][\w.-]*)((?:[^>"'{]|"[^"]*"|'[^']*'|\{(?:[^{}]|\{[^{}]*\})*\})*?)(\/?)>/y;
function findMatchingBrace(str, start) {
  let depth = 0;
  for (let i = start; i < str.length; i++) {
    const ch = str[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      i++;
      while (i < str.length && str[i] !== ch) {
        if (str[i] === "\\") i++;
        i++;
      }
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}
function findMatchingParen(str, start) {
  let depth = 0;
  for (let i = start; i < str.length; i++) {
    const ch = str[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      i++;
      while (i < str.length && str[i] !== ch) {
        if (str[i] === "\\") i++;
        i++;
      }
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}
function tryParseMap(exprText) {
  const inner = exprText.slice(1, -1);
  const arrow = inner.match(/^([\s\S]*?\.map\(\s*\(([^)]*)\)\s*=>\s*\()/);
  if (!arrow) return null;
  const headRaw = arrow[1];
  const openIdx = arrow[0].length - 1;
  const closeIdx = findMatchingParen(inner, openIdx);
  if (closeIdx === -1) return null;
  if (!/^\s*\)\s*$/.test(inner.slice(closeIdx + 1))) return null;
  const body = inner.slice(openIdx + 1, closeIdx);
  const parsed = parseTemplate(body);
  if (!parsed.clean) return null;
  return {
    id: makeId(),
    kind: "map",
    head: headRaw.replace(/\s+/g, " ").trim(),
    // e.g. "stats.map((stat) => ("
    children: parsed.nodes
  };
}
function parseTemplate(str) {
  const nodes = [];
  let pos = 0;
  while (pos < str.length) {
    const lt = str.indexOf("<", pos);
    const br = str.indexOf("{", pos);
    const next = lt === -1 ? br : br === -1 ? lt : Math.min(lt, br);
    const textEnd = next === -1 ? str.length : next;
    const text = str.slice(pos, textEnd);
    if (text.trim()) {
      const value = (/^\s/.test(text) ? " " : "") + collapseWhitespace(text) + (/\s$/.test(text) ? " " : "");
      nodes.push({ id: makeId(), kind: "text", value });
    }
    if (next === -1) break;
    if (next === br && (lt === -1 || br < lt)) {
      const close = findMatchingBrace(str, br);
      if (close === -1) return { nodes, clean: false };
      const exprText = str.slice(br, close + 1);
      const mapNode = tryParseMap(exprText);
      nodes.push(mapNode || { id: makeId(), kind: "expr", value: exprText });
      pos = close + 1;
      continue;
    }
    if (str.startsWith("<!--", lt)) {
      const end = str.indexOf("-->", lt + 4);
      if (end === -1) return { nodes, clean: false };
      nodes.push({ id: makeId(), kind: "comment", value: str.slice(lt + 4, end) });
      pos = end + 3;
      continue;
    }
    if (/^<!doctype/i.test(str.slice(lt))) {
      const end = str.indexOf(">", lt);
      if (end === -1) return { nodes, clean: false };
      nodes.push({ id: makeId(), kind: "raw-line", value: str.slice(lt, end + 1) });
      pos = end + 1;
      continue;
    }
    TAG_RE.lastIndex = lt;
    const m = TAG_RE.exec(str);
    if (!m) return { nodes, clean: false };
    const [full, name, attrs, selfClose] = m;
    if (/=\s*\{[^{}]*\{[^{}]*\{/.test(attrs)) return { nodes, clean: false };
    const isComponent = /^[A-Z]/.test(name);
    const kind = isComponent ? "component" : "element";
    const afterOpen = lt + full.length;
    if (selfClose === "/" || !isComponent && VOID_ELEMENTS.has(name.toLowerCase())) {
      nodes.push({ id: makeId(), kind, name, props: parseAttrs(attrs), children: null });
      pos = afterOpen;
      continue;
    }
    if (!isComponent && RAW_ELEMENTS.has(name.toLowerCase())) {
      const close = str.indexOf(`</${name}`, afterOpen);
      if (close === -1) return { nodes, clean: false };
      const closeEnd = str.indexOf(">", close);
      nodes.push({
        id: makeId(),
        kind: "raw",
        name,
        props: parseAttrs(attrs),
        inner: str.slice(afterOpen, close)
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
      children: innerResult.nodes
    });
    pos = str.indexOf(">", closeIdx) + 1;
  }
  return { nodes, clean: true };
}
function findMatchingClose(str, from, name) {
  const escName = escapeRe(name);
  let depth = 1;
  let i = from;
  while (i < str.length) {
    const lt = str.indexOf("<", i);
    if (lt === -1) return -1;
    const afterLt = str.charAt(lt + 1);
    if (afterLt === "!") {
      if (str.startsWith("<!--", lt)) {
        const end2 = str.indexOf("-->", lt + 4);
        if (end2 === -1) return -1;
        i = end2 + 3;
        continue;
      }
      const end = str.indexOf(">", lt);
      if (end === -1) return -1;
      i = end + 1;
      continue;
    }
    if (afterLt === "/") {
      const rest = str.slice(lt + 2, lt + 2 + escName.length);
      if (rest.toLowerCase() === escName.toLowerCase()) {
        const after = str.charAt(lt + 2 + escName.length);
        if (after === " " || after === "	" || after === "\n" || after === "\r" || after === ">") {
          depth--;
          if (depth === 0) return lt;
          const end2 = str.indexOf(">", lt);
          if (end2 === -1) return -1;
          i = end2 + 1;
          continue;
        }
      }
      const end = str.indexOf(">", lt);
      if (end === -1) return -1;
      i = end + 1;
      continue;
    }
    const nameMatch = /^([A-Za-z][\w.-]*)/.exec(str.slice(lt + 1));
    if (!nameMatch) {
      i = lt + 1;
      continue;
    }
    const tagName = nameMatch[1];
    const tagEnd = scanTagEnd(str, lt);
    if (tagEnd === -1) return -1;
    const selfClose = str.charAt(tagEnd - 1) === "/";
    if (tagName.toLowerCase() === escName.toLowerCase()) {
      if (!selfClose) depth++;
      if (depth === 0) return lt;
    }
    if (!selfClose && (tagName.toLowerCase() === "script" || tagName.toLowerCase() === "style")) {
      const close = str.toLowerCase().indexOf("</" + tagName.toLowerCase(), tagEnd + 1);
      if (close === -1) return -1;
      const closeEnd = str.indexOf(">", close);
      if (closeEnd === -1) return -1;
      i = closeEnd + 1;
      continue;
    }
    i = tagEnd + 1;
  }
  return -1;
}
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
    if (c === "{") {
      let d = 1;
      i++;
      while (i < str.length && d > 0) {
        if (str[i] === "{") d++;
        else if (str[i] === "}") d--;
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
    if (c === ">") return i;
    i++;
  }
  return -1;
}
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function collapseWhitespace(text) {
  return text.replace(/\s+/g, " ").trim();
}
function parsePage(source) {
  nextId = 1;
  const fm = source.match(/^---\r?\n(?:([\s\S]*?)\r?\n)?---\r?\n?/);
  const frontmatter = fm ? fm[1] || "" : "";
  const body = fm ? source.slice(fm[0].length) : source;
  const imports = [];
  let extraFrontmatter = frontmatter;
  let m;
  IMPORT_RE.lastIndex = 0;
  while ((m = IMPORT_RE.exec(frontmatter)) !== null) {
    imports.push({ name: m[1], path: m[2] });
    extraFrontmatter = extraFrontmatter.replace(m[0], "");
  }
  extraFrontmatter = extraFrontmatter.trim();
  const { nodes: topNodes, clean } = parseTemplate(body);
  if (!clean) {
    return {
      editable: false,
      reason: "Page contains markup the visual editor cannot represent (unclosed tags, fragments, or template expressions outside props)."
    };
  }
  const importsByName = Object.fromEntries(imports.map((i) => [i.name, i]));
  const significant = topNodes.filter((n) => n.kind !== "comment");
  let wrapper = null;
  if (significant.length === 1 && significant[0].kind === "component" && significant[0].children !== null) {
    wrapper = significant[0];
  } else if (significant.length > 1) {
    const layoutish = significant.filter(
      (n) => n.kind === "component" && n.children !== null && /layout/i.test(importsByName[n.name]?.path || "")
    );
    if (layoutish.length === 1) wrapper = layoutish[0];
  }
  if (wrapper) wrapper.id = "layout";
  const markDynamic = (list) => {
    for (const n of list) {
      if (n.kind === "component" && !importsByName[n.name] && !BUILTIN_COMPONENTS.has(n.name)) n.dynamicTag = true;
      if (Array.isArray(n.children)) markDynamic(n.children);
    }
  };
  markDynamic(topNodes);
  return { editable: true, model: { imports, extraFrontmatter, nodes: topNodes } };
}
function serializePage(model) {
  const lines = ["---"];
  for (const imp of model.imports) {
    lines.push(`import ${imp.name} from '${imp.path}';`);
  }
  if (model.extraFrontmatter) {
    lines.push("", model.extraFrontmatter);
  }
  lines.push("---");
  for (const node of model.nodes) serializeNode(node, "", lines);
  return lines.join("\n") + "\n";
}
var INLINE_TAGS = /* @__PURE__ */ new Set([
  "strong",
  "em",
  "b",
  "i",
  "sup",
  "sub",
  "code",
  "a",
  "span",
  "br",
  "small",
  "mark",
  "u",
  "s"
]);
function isSimpleExpr(n) {
  return n.kind === "expr" && /^\{[^{}]*\}$/.test(n.value) && !n.value.includes("<");
}
function isInlineRun(nodes) {
  return nodes.length > 0 && nodes.every(
    (n) => n.kind === "text" || isSimpleExpr(n) || n.kind === "element" && INLINE_TAGS.has(n.name.toLowerCase()) && (n.children === null || n.children.length === 0 || isInlineRun(n.children))
  );
}
function inlineString(nodes) {
  let out = "";
  for (const n of nodes) {
    if (n.kind === "text") out += n.value;
    else if (n.kind === "expr") out += n.value;
    else if (n.children === null || n.children.length === 0) {
      out += n.name === "br" ? "<br />" : `<${n.name}${serializeAttrs(n.props)} />`;
    } else {
      out += `<${n.name}${serializeAttrs(n.props)}>${inlineString(n.children)}</${n.name}>`;
    }
  }
  return out;
}
function serializeNode(node, indent, lines) {
  if (node.kind === "chunk-group") return;
  if (node.chunkFile || node.chunkAggregate) {
    lines.push(`${indent}<${node.name}${serializeAttrs(node.props)} />`);
    return;
  }
  switch (node.kind) {
    case "text":
      lines.push(indent + node.value);
      return;
    case "expr": {
      const exprLines = node.value.split("\n");
      lines.push(indent + exprLines[0]);
      for (let i = 1; i < exprLines.length; i++) lines.push(exprLines[i]);
      return;
    }
    case "map":
      lines.push(indent + "{");
      lines.push(indent + "  " + node.head);
      for (const child of node.children || []) serializeNode(child, indent + "    ", lines);
      lines.push(indent + "  ))");
      lines.push(indent + "}");
      return;
    case "comment":
      lines.push(`${indent}<!--${node.value}-->`);
      return;
    case "raw-line":
      lines.push(indent + node.value);
      return;
    case "raw": {
      lines.push(`${indent}<${node.name}${serializeAttrs(node.props)}>`);
      const inner = node.inner.replace(/^\r?\n/, "").replace(/\s+$/, "");
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
      if (node.children.length > 0 && isInlineRun(node.children)) {
        lines.push(`${indent}<${node.name}${attrs}>${inlineString(node.children).trim()}</${node.name}>`);
        return;
      }
      lines.push(`${indent}<${node.name}${attrs}>`);
      for (const child of node.children) serializeNode(child, indent + "  ", lines);
      lines.push(`${indent}</${node.name}>`);
    }
  }
}
function serializePageMarked(model) {
  const marks = chunkImportMarks(model);
  const lines = ["---"];
  for (const imp of model.imports) {
    const mark = /\.html\?raw$/i.test(imp.path) ? marks.get(imp.name) : null;
    const spec = mark ? `${imp.path}&avb=${mark.path}${mark.group ? "&avbg=1" : ""}` : imp.path;
    lines.push(`import ${imp.name} from '${spec}';`);
  }
  if (model.extraFrontmatter) {
    lines.push("", model.extraFrontmatter);
  }
  lines.push("---");
  model.nodes.forEach((node, i) => serializeNodeMarked(node, "", lines, String(i)));
  return lines.join("\n") + "\n";
}
function serializeNodeMarked(node, indent, lines, path2) {
  if (node.kind === "chunk-group") return;
  const slotVal = node.props?.slot;
  const slotAttr = slotVal && slotVal.type === "string" && slotVal.value ? ` slot="${slotVal.value}"` : "";
  lines.push(`${indent}<template${slotAttr} data-avb-s="${path2}"></template>`);
  if ((node.kind === "component" || node.kind === "element") && !node.chunkFile && !node.chunkAggregate && Array.isArray(node.children) && // Inline runs serialize as one line — markers between words would break
  // spacing (each marker's surrounding newlines render as a space).
  !(node.children.length > 0 && isInlineRun(node.children))) {
    const attrs = serializeAttrs(node.props);
    lines.push(`${indent}<${node.name}${attrs}>`);
    node.children.forEach(
      (child, i) => serializeNodeMarked(child, indent + "  ", lines, `${path2}.${i}`)
    );
    lines.push(`${indent}</${node.name}>`);
  } else if (node.kind === "map") {
    lines.push(indent + "{");
    lines.push(indent + "  " + node.head);
    (node.children || []).forEach(
      (child, i) => serializeNodeMarked(child, indent + "    ", lines, `${path2}.${i}`)
    );
    lines.push(indent + "  ))");
    lines.push(indent + "}");
  } else {
    serializeNode(node, indent, lines);
  }
  lines.push(`${indent}<template${slotAttr} data-avb-e="${path2}"></template>`);
}
function parsePropSchema(source) {
  const fm = source.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const frontmatter = fm ? fm[1] : "";
  const schema = /* @__PURE__ */ new Map();
  const aliases = /* @__PURE__ */ new Map();
  const aliasRe = /(?:export\s+)?type\s+(\w+)\s*=\s*([\s\S]*?);/g;
  let am;
  while ((am = aliasRe.exec(frontmatter)) !== null) {
    if (am[1] !== "Props") aliases.set(am[1], am[2].trim());
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
        default: void 0
      });
    }
  }
  const destructure = frontmatter.match(/(?:const|let)\s*\{([\s\S]*?)\}\s*=\s*Astro\.props/);
  if (destructure) {
    destructure[1] = destructure[1].replace(/\.\.\.\s*\w+/g, "").replace(/(\w+)\s*:\s*\w+/g, "$1");
    const entryRe = /(\w+)(?:\s*=\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\{[^{}]*\}|\[[^\][]*\]|[^,\n}]+))?/g;
    let m;
    while ((m = entryRe.exec(destructure[1])) !== null) {
      if (!m[1]) continue;
      const existing = schema.get(m[1]) || {
        name: m[1],
        type: "other",
        optional: true,
        default: void 0
      };
      if (m[2] !== void 0) {
        let def = m[2].trim();
        if (/^["'`]/.test(def)) {
          existing.default = def.slice(1, -1);
          if (existing.type === "other") existing.type = "string";
        } else if (/^(true|false)$/.test(def)) {
          existing.default = def === "true";
          if (existing.type === "other") existing.type = "boolean";
        } else if (/^-?\d+(\.\d+)?$/.test(def)) {
          existing.default = Number(def);
          if (existing.type === "other") existing.type = "number";
        } else {
          existing.default = def;
          existing.defaultExpr = true;
          if (existing.type === "other" && /^\{/.test(def)) existing.type = "attrs";
        }
        existing.optional = true;
      }
      schema.set(m[1], existing);
    }
  }
  return [...schema.values()];
}
function parseSlots(source) {
  const fm = source.match(/^---\r?\n(?:[\s\S]*?\r?\n)?---\r?\n?/);
  const body = fm ? source.slice(fm[0].length) : source;
  const found = /* @__PURE__ */ new Set();
  const re = /<slot\b((?:[^>"'{]|"[^"]*"|'[^']*'|\{[^}]*\})*?)\/?>/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    const nameMatch = m[1].match(/\bname\s*=\s*(?:"([^"]*)"|'([^']*)')/);
    found.add(nameMatch ? nameMatch[1] ?? nameMatch[2] : "default");
  }
  const named = [...found].filter((s) => s !== "default");
  return found.has("default") ? ["default", ...named] : named;
}
function parseTransitionsFromModel(model, source) {
  const out = [];
  if (!model || !Array.isArray(model.nodes)) return out;
  let lineStarts = null;
  const positionOf = (offset) => {
    if (lineStarts == null) {
      lineStarts = computeLineStarts(source != null ? source : serializePage(model));
    }
    return offsetToLineCol(lineStarts, offset);
  };
  for (const node of model.nodes) {
    walkNode(node, "", out, positionOf);
  }
  return out;
}
function walkNode(node, path2, out, positionOf) {
  if (!node) return;
  if (node.props) {
    for (const [name, v] of Object.entries(node.props)) {
      if (name === "transition:name" && v && (v.type === "string" || v.type === "expr")) {
        out.push({
          kind: "name",
          value: v.type === "string" ? v.value : v.value,
          page: { rel: "<model>" },
          // The model doesn't carry positions, so the caller can
          // re-derive them from the serialized source if needed.
          line: 0,
          col: 0,
          path: path2,
          meta: { expr: v.type === "expr" }
        });
      } else if (name === "transition:animate" && v && (v.type === "string" || v.type === "expr")) {
        out.push({
          kind: "animate",
          value: v.type === "string" ? v.value : v.value,
          page: { rel: "<model>" },
          line: 0,
          col: 0,
          path: path2,
          meta: { expr: v.type === "expr" }
        });
      }
    }
  }
  if (Array.isArray(node.children)) {
    node.children.forEach(
      (child, i) => walkNode(child, path2 ? path2 + "." + i : String(i), out, positionOf)
    );
  }
}
function computeLineStarts(source) {
  const starts = [0];
  for (let i = 0; i < source.length; i++) {
    if (source.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}
function offsetToLineCol(starts, offset) {
  let lo = 0, hi = starts.length - 1;
  while (lo < hi) {
    const mid = lo + hi + 1 >>> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, col: offset - starts[lo] + 1 };
}
function parseExtendsTag(source) {
  const fm = source.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const frontmatter = fm ? fm[1] : "";
  const m = frontmatter.match(
    /interface\s+Props\s+extends\s+(?:astroHTML\.JSX\.)?HTMLAttributes\s*<\s*['"](\w+)['"]\s*>/
  );
  return m ? m[1] : null;
}
function normalizeType(t) {
  const parts = t.split("|").map((s) => s.trim()).filter(Boolean);
  if (parts.length > 1) {
    const literals = parts.filter((p) => /^(['"`]).*\1$/.test(p));
    const rest = parts.filter((p) => !/^(['"`]).*\1$/.test(p));
    if (literals.length >= 2 && rest.every((p) => p === "undefined" || p === "null")) {
      return { type: "enum", options: literals.map((p) => p.slice(1, -1)) };
    }
  }
  if (/^string\b/.test(t)) return { type: "string" };
  if (/^number\b/.test(t)) return { type: "number" };
  if (/^boolean\b/.test(t)) return { type: "boolean" };
  if (/^(['"`]).*\1$/.test(t)) return { type: "string" };
  if (/^(HTMLAttributes\b|astroHTML\.|Record\s*<)/.test(t)) return { type: "attrs" };
  return { type: "other" };
}
function serializeNodes(nodes) {
  const lines = [];
  for (const node of nodes) serializeNode(node, "", lines);
  return lines.join("\n") + "\n";
}
function serializeNodeToJson(node) {
  if (node == null) return null;
  const out = { id: node.id, kind: node.kind };
  if (node.kind === "element" || node.kind === "component" || node.kind === "raw") {
    out.name = node.name;
    out.props = {};
    for (const k of Object.keys(node.props || {})) {
      const v = node.props[k];
      out.props[k] = v && typeof v === "object" && "value" in v ? v.value : v;
    }
    if (node.frontmatter) out.frontmatter = { ...node.frontmatter };
  }
  if (node.kind === "text" || node.kind === "expr" || node.kind === "comment" || node.kind === "raw-line") {
    out.value = node.value;
  }
  if (node.kind === "map") {
    out.head = node.head;
    out.children = (node.children || []).map(serializeNodeToJson);
  } else if (node.kind === "element" || node.kind === "component") {
    out.children = (node.children || []).map(serializeNodeToJson);
  }
  return out;
}
var chunkGroupId = 1;
function resolveChunks(model, pagePath) {
  const rawImports = /* @__PURE__ */ new Map();
  for (const imp of model.imports) {
    if (/\.html\?raw$/i.test(imp.path) && imp.path.startsWith(".")) {
      rawImports.set(
        imp.name,
        path.resolve(path.dirname(pagePath), imp.path.replace(/\?raw$/i, ""))
      );
    }
  }
  if (!rawImports.size) return;
  const aggregates = /* @__PURE__ */ new Map();
  const aggRe = /(?:const|let)\s+(\w+)\s*=\s*\[([^\]]*)\]\s*\.join\(/g;
  let am;
  while ((am = aggRe.exec(model.extraFrontmatter || "")) !== null) {
    const idents = am[2].split(",").map((s) => s.trim()).filter(Boolean);
    if (idents.length && idents.every((i) => /^\w+$/.test(i))) {
      aggregates.set(am[1], idents);
    }
  }
  const parseChunkFile = (filePath) => {
    try {
      const { nodes, clean } = parseTemplate(fs.readFileSync(filePath, "utf8"));
      return clean ? nodes : null;
    } catch {
      return null;
    }
  };
  const walk = (list) => {
    for (const node of list) {
      if (node.kind === "component" && node.props?.["set:html"]?.type === "expr" && node.children == null) {
        const ref = node.props["set:html"].value.trim();
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
                kind: "chunk-group",
                name: ident,
                chunkFile: file,
                children
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
function chunkImportMarks(model) {
  const marks = /* @__PURE__ */ new Map();
  const walk = (list, prefix) => {
    list.forEach((node, i) => {
      const p = prefix ? `${prefix}.${i}` : String(i);
      if (node.chunkFile) {
        const group = node.kind === "chunk-group";
        const ident = group ? node.name : node.props?.["set:html"]?.value?.trim();
        if (ident) marks.set(ident, { path: p, group });
      }
      if (Array.isArray(node.children)) walk(node.children, p);
    });
  };
  walk(model.nodes, "");
  return marks;
}
function markChunkHtml(source, prefix, group) {
  const { nodes, clean } = parseTemplate(source);
  if (!clean) return null;
  const lines = [];
  if (group) lines.push(`<template data-avb-s="${prefix}"></template>`);
  nodes.forEach((node, i) => serializeNodeMarked(node, "", lines, `${prefix}.${i}`));
  if (group) lines.push(`<template data-avb-e="${prefix}"></template>`);
  return lines.join("\n") + "\n";
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
  RECOGNIZED_FRONTMATTER_OBJECTS
};
export {
  emitDesignSystemTokens
};
