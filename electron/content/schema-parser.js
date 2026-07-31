// Parses an Astro content collection schema file (src/content.config.ts or
// src/content/config.ts) into a normalized form-spec consumable by the React
// form generator. The schema source is TypeScript, so we hand it to the
// TypeScript compiler to transpile it to plain JS, then we try to execute the
// result in a sandbox built from `zod` and a couple of stubs. The expression
// table (`defineCollection({ schema: ({ image }) => z.object({...}) })`) is
// what we care about — anything else we just ignore. If anything goes wrong
// (a syntax error, a runtime exception, a missing import), we fall back to a
// single "raw JSON textarea" field so the editor still loads.

const ts = require('typescript');
const path = require('path');
const fs = require('fs');

// An Astro image() helper: treat it as a passthrough for the form's sake.
// The real resolution happens at Astro build time; all the UI needs is a
// stable type tag so it can pick an asset picker.
function imageHelper() {
  const fn = function image() {
    return { __type: 'zod-schema', __kind: 'image', _def: {} };
  };
  fn._isImageHelper = true;
  return fn;
}

// A reference to another collection. We don't know the target's entries
// without a second lookup, so the UI gets a dropdown populated from
// content:list at render time.
function referenceHelper(name) {
  return { __type: 'zod-schema', __kind: 'reference', _def: { name } };
}

// Stubs for the Astro helpers the schema source is allowed to import. None
// of these are evaluated — the schema source is expected to be self-contained
// (the user is editing their own file), but if it imports something we don't
// recognize, we substitute a no-op so the import doesn't throw.
const stubModule = {
  image: imageHelper(),
  reference: referenceHelper,
};

// `defineCollection({ schema })` returns a wrapper. We mirror that shape so
// the call site looks the same as in real Astro code, and so the extract
// step can find the `.schema` field as expected. A `__isCollection` flag
// lets the extractor recognise a defineCollection result that has no
// `schema` field at all (the user wrote `defineCollection({ type: 'content' })`)
// and emit an empty record instead of dropping the collection silently.
function defineCollection(opts) {
  return { type: 'content', schema: opts.schema, __isCollection: true, ...opts };
}

// All the zod methods we recognize. Each one receives the inner state of
// the schema-defining call (e.g. `{ name: z.string() }`) and returns a tag
// the React side understands. The result is mirrored under the
// `__type: 'zod-schema'` umbrella so we can tell a real schema from a plain
// object on the rare occasion we'd want to.
// Wraps a tagged schema node so chaining `.optional()`, `.nullable()`, etc.
// still works the way the real zod API does. Every chain call returns a
// new proxy carrying the same `__type` umbrella so the walker can still
// recognize it.
function makeChain(node) {
  const wrap = (n) => makeChain({ ...node, ...n });
  return new Proxy(node, {
    get(target, prop) {
      if (prop === '__type' || prop === '__kind') return target[prop];
      if (prop in target) return target[prop];
      if (prop === 'optional') return () => wrap({ __kind: 'optional', inner: target });
      if (prop === 'nullable') return () => wrap({ __kind: 'nullable', inner: target });
      if (prop === 'default') return (v) => wrap({ __kind: 'default', inner: target, value: v });
      if (prop === 'array') return (item) => wrap({ __kind: 'array', item });
      if (prop === 'object') return (shape) => wrap({ __kind: 'object', shape: shape || {} });
      if (prop === 'enum') return (values) => wrap({ __kind: 'enum', values: Array.from(values || []) });
      if (prop === 'union') return (...opts) => wrap({ __kind: 'union', options: opts });
      if (prop === 'literal') return (v) => wrap({ __kind: 'literal', value: v });
      if (prop === 'then') return undefined; // promise interop, harmless
      // Anything else — return a no-op tag and bake it into the chain so
      // the walker still sees the original kind.
      return () => wrap({ ...target });
    },
  });
}

function tag(kind, payload) {
  const node = { __type: 'zod-schema', __kind: kind };
  if (kind === 'object') node.shape = payload || {};
  else if (kind === 'array') node.item = payload;
  else if (kind === 'enum') node.values = Array.isArray(payload) ? payload : Array.from(payload || []);
  else if (kind === 'union') node.options = Array.isArray(payload) ? payload : Array.from(payload || []);
  else if (kind === 'literal') node.value = payload;
  else if (kind === 'optional' || kind === 'nullable' || kind === 'default') node.inner = payload;
  else if (kind === 'reference') node.name = typeof payload === 'string' ? payload : String(payload);
  return makeChain(node);
}

// The bare `z` namespace. Each property is a factory that returns a
// chainable tagged node.
const zodStub = new Proxy(
  {},
  {
    get(_target, prop) {
      if (prop === 'string') return () => tag('string');
      if (prop === 'number') return () => tag('number');
      if (prop === 'boolean') return () => tag('boolean');
      if (prop === 'date') return () => tag('date');
      if (prop === 'any') return () => tag('any');
      if (prop === 'unknown') return () => tag('unknown');
      if (prop === 'object') return (shape) => tag('object', shape);
      if (prop === 'array') return (item) => tag('array', item);
      if (prop === 'enum') return (values) => tag('enum', values);
      if (prop === 'union') return (...opts) => tag('union', opts);
      if (prop === 'literal') return (value) => tag('literal', value);
      if (prop === 'optional') return (inner) => tag('optional', inner);
      if (prop === 'nullable') return (inner) => tag('nullable', inner);
      if (prop === 'default') return (inner) => tag('default', inner);
      if (prop === 'image') return () => tag('image');
      if (prop === 'reference') return (name) => tag('reference', name);
      // Unknown — leave a placeholder. Won't fail the parse, just yields a
      // raw field in the form.
      return () => tag('unknown');
    },
  }
);

// Transpile the source so we can evaluate it. We intentionally discard the
// type system — we only need the runtime behavior.
function transpile(source) {
  return ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
    reportDiagnostics: false,
  }).outputText;
}

// Run a transpiled schema source string and return the actual collection
// definitions. The sandbox wires up `zod`, the helper stubs, and a CommonJS
// `require` shim that only resolves the stub paths.
function evaluateSchema(transpiled) {
  const sandboxRequire = (id) => {
    if (id === 'astro:content' || id === 'astro/collections') {
      return {
        image: imageHelper(),
        reference: referenceHelper,
        z: zodStub,
        defineCollection,
      };
    }
    // Some projects pull zod directly: `import { z } from 'zod'`.
    if (id === 'zod') return { z: zodStub };
    // Otherwise try Node's normal resolver — most schemas won't import
    // anything else, but if they do, we let it surface.
    return require(id);
  };
  const module = { exports: {} };
  // Wrap so `module.exports` lands somewhere; matching CommonJS conventions.
  // The user's source uses ESM (import/export), but the transpiler
  // converted those to `require`/`module.exports`. We re-host that.
  const fn = new Function(
    'require',
    'module',
    'exports',
    '__dirname',
    '__filename',
    transpiled
  );
  fn(sandboxRequire, module, module.exports, '/__schema', '/__schema.ts');
  return module.exports;
}

// Extract a collection object from whatever the schema source exported. We
// accept `defineCollection({ schema: ... })`, an object that already looks
// like a collection, or a `{ foo: defineCollection(...), bar: ... }` map.
function extractCollections(exp) {
  const out = [];
  if (!exp) return out;
  const visit = (value, nameHint) => {
    if (!value) return;
    // A `defineCollection(...)` result, with or without a `.schema` field.
    // Routes the schema through the same call-it-if-function handling as the
    // branches below, so a missing-schema stub still produces an empty record
    // instead of being dropped silently.
    if (value.__isCollection) {
      let schema = value.schema;
      if (typeof schema === 'function') {
        try {
          schema = schema(passToSchema(schema));
        } catch (err) {
          out.push({
            name: nameHint || value.name || 'default',
            error: String(err.message || err),
          });
          return;
        }
      }
      out.push({ name: nameHint || value.name || 'default', schema });
      return;
    }
    // `defineCollection({ schema })` returns a wrapper object with a
    // `.schema` field and the collection's storage type. We only care
    // about the schema.
    if (value.schema && typeof value.schema === 'function') {
      try {
        const args = passToSchema(value.schema);
        const schema = value.schema(args);
        out.push({
          name: nameHint || value.name || 'default',
          schema,
        });
      } catch (err) {
        out.push({ name: nameHint || 'default', error: String(err.message || err) });
      }
      return;
    }
    if (value.schema && typeof value.schema === 'object') {
      out.push({ name: nameHint || value.name || 'default', schema: value.schema });
      return;
    }
    // A bare zod schema (rare, but `export const foo = z.object({...})` is
    // a valid pattern).
    if (value.__type === 'zod-schema') {
      out.push({ name: nameHint || 'default', schema: value });
      return;
    }
    // A bare map of `{ name: defineCollection(...) }`. Heuristic: every
    // value is either an object with a `.schema` field or could be one.
    if (typeof value === 'object' && !Array.isArray(value)) {
      let recursed = false;
      for (const [k, v] of Object.entries(value)) {
        if (v && typeof v === 'object' && (v.schema || v.__type === 'zod-schema' || v.__isCollection)) {
          visit(v, k);
          recursed = true;
        }
      }
      if (recursed) return;
    }
  };
  for (const [key, val] of Object.entries(exp)) {
    if (key === 'default' || key === '__esModule') continue;
    visit(val, key);
  }
  if (exp.default && typeof exp.default === 'object') {
    visit(exp.default, exp.default.name || 'default');
  }
  return out;
}

// `schema` callbacks get a content-helpers bag. We pass our stubs so any
// `image()`/`reference()` calls inside the body resolve to the placeholder
// types the walker already knows about.
function passToSchema(schemaFn) {
  // The function may take 0 or 1 argument; pass an object with both `image`
  // and `reference` available whether the destructure uses them or not.
  return { image: imageHelper(), reference: referenceHelper };
}

// Walk the parsed schema and produce a frontend-friendly form spec.
function normalize(schema) {
  if (!schema || typeof schema !== 'object') {
    return { type: 'unknown', label: 'value', required: false };
  }
  const inner = (n) => (n && n.__type === 'zod-schema' ? n : { __type: 'zod-schema', __kind: 'unknown' });
  let node = inner(schema);
  let required = true;
  // Unwrap optional / nullable / default layered wrappers. They may nest
  // (e.g. `z.optional(z.default(...))`), so keep peeling until we hit a
  // match-worthy kind.
  while (node.__kind === 'optional' || node.__kind === 'nullable' || node.__kind === 'default') {
    if (node.__kind === 'optional') required = false;
    node = inner(node.inner);
  }
  const kind = node.__kind;
  if (kind === 'string')
    return { type: 'string', required };
  if (kind === 'number')
    return { type: 'number', required };
  if (kind === 'boolean')
    return { type: 'boolean', required };
  if (kind === 'date')
    return { type: 'date', required };
  if (kind === 'image')
    return { type: 'image', required };
  if (kind === 'reference') {
    return { type: 'reference', required, ref: node.name };
  }
  if (kind === 'enum') {
    const values = Array.isArray(node.values)
      ? node.values.map((v) => (typeof v === 'string' ? v : String(v)))
      : [];
    return { type: 'enum', required, options: values };
  }
  if (kind === 'literal') {
    return { type: 'literal', required, value: node.value };
  }
  if (kind === 'array') {
    const itemSpec = node.item ? normalize(node.item) : { type: 'string' };
    return { type: 'array', required, items: itemSpec };
  }
  if (kind === 'union') {
    const opts = (node.options || []).map((o) => normalize(o));
    return { type: 'union', required, options: opts };
  }
  if (kind === 'object') {
    const fields = {};
    for (const [key, val] of Object.entries(node.shape || {})) {
      fields[key] = normalize(val);
    }
    return { type: 'object', required, fields };
  }
  // Anything we don't recognize — for example a custom zod refinement — the
  // form renders as a raw text field. Better than dropping the field.
  return { type: 'unknown', required };
}

// Parse a single schema file's contents. Throws on file-read errors so the
// caller can decide whether to fall back to a no-config result.
function parseSchemaFile(absPath) {
  const source = fs.readFileSync(absPath, 'utf8');
  const transpiled = transpile(source);
  const exports = evaluateSchema(transpiled);
  const collections = extractCollections(exports);
  return collections.map((c) => {
    if (c.error) {
      return { name: c.name, fields: {}, error: c.error };
    }
    const spec = normalize(c.schema);
    return {
      name: c.name,
      fields: (spec && spec.fields) || {},
      error: null,
    };
  });
}

// Public entry point used by the IPC handler. Tries the Astro 5 location
// first, then the Astro 4 location, then reports no config.
function parseProjectSchema(projectPath) {
  const candidates = [
    path.join(projectPath, 'src', 'content.config.ts'),
    path.join(projectPath, 'src', 'content.config.js'),
    path.join(projectPath, 'src', 'content', 'config.ts'),
    path.join(projectPath, 'src', 'content', 'config.js'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      try {
        const collections = parseSchemaFile(p);
        return { configPath: p, collections };
      } catch (err) {
        return {
          configPath: p,
          collections: [],
          error: String(err.message || err),
        };
      }
    }
  }
  return { configPath: null, collections: [] };
}

module.exports = {
  parseSchemaFile,
  parseProjectSchema,
  normalize,
  // Internal helpers exported for the test suite.
  __test: {
    transpile,
    evaluateSchema,
    extractCollections,
  },
};
