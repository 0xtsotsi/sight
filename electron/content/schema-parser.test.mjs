// Tests for the schema parser. The parser walks two layers: a TypeScript
// transpile + a JS evaluation pass, then a normalize pass that produces
// the form-spec format. Most of these exercises target `normalize` directly
// by feeding it a stub schema object, matching the shape the transpile
// step produces. We also cover the full pipeline via a few end-to-end
// `parseSchemaFile` cases that write a source string to a temp file.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseSchemaFile, parseProjectSchema, normalize, __test } =
  require('./schema-parser.js');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Build a tagged schema node by hand. The walker only inspects the
// `__type`/`__kind` umbrella, so we can skip the parser's stub factory
// entirely here.
const T = {
  string: () => ({ __type: 'zod-schema', __kind: 'string' }),
  number: () => ({ __type: 'zod-schema', __kind: 'number' }),
  boolean: () => ({ __type: 'zod-schema', __kind: 'boolean' }),
  date: () => ({ __type: 'zod-schema', __kind: 'date' }),
  image: () => ({ __type: 'zod-schema', __kind: 'image' }),
  ref: (name) => ({ __type: 'zod-schema', __kind: 'reference', name }),
  enum: (values) => ({ __type: 'zod-schema', __kind: 'enum', values }),
  literal: (value) => ({ __type: 'zod-schema', __kind: 'literal', value }),
  array: (item) => ({ __type: 'zod-schema', __kind: 'array', item }),
  union: (...opts) => ({ __type: 'zod-schema', __kind: 'union', options: opts }),
  object: (shape) => ({ __type: 'zod-schema', __kind: 'object', shape }),
  optional: (inner) => ({ __type: 'zod-schema', __kind: 'optional', inner }),
  nullable: (inner) => ({ __type: 'zod-schema', __kind: 'nullable', inner }),
  default: (inner) => ({ __type: 'zod-schema', __kind: 'default', inner }),
};

test('z.string() → string', () => {
  assert.deepEqual(normalize(T.string()), { type: 'string', required: true });
});

test('z.number() → number', () => {
  assert.deepEqual(normalize(T.number()), { type: 'number', required: true });
});

test('z.boolean() → boolean', () => {
  assert.deepEqual(normalize(T.boolean()), { type: 'boolean', required: true });
});

test('z.date() → date', () => {
  assert.deepEqual(normalize(T.date()), { type: 'date', required: true });
});

test('z.string().optional() → string not required', () => {
  assert.deepEqual(normalize(T.optional(T.string())), { type: 'string', required: false });
});

test('z.optional() should not swallow non-object nodes', () => {
  // Optional wraps an array — the inner type still has to come through.
  const out = normalize(T.optional(T.array(T.string())));
  assert.equal(out.type, 'array');
  assert.equal(out.required, false);
  assert.deepEqual(out.items, { type: 'string', required: true });
});

test('z.string().nullable() peels nullable but stays required', () => {
  const out = normalize(T.nullable(T.string()));
  assert.equal(out.type, 'string');
  assert.equal(out.required, true);
});

test('z.string().default("x") peels default', () => {
  const out = normalize(T.default(T.string()));
  assert.equal(out.type, 'string');
  assert.equal(out.required, true);
});

test('z.enum(["a","b","c"]) → enum with options', () => {
  const out = normalize(T.enum(['a', 'b', 'c']));
  assert.equal(out.type, 'enum');
  assert.deepEqual(out.options, ['a', 'b', 'c']);
  assert.equal(out.required, true);
});

test('z.literal("draft") → literal with value', () => {
  const out = normalize(T.literal('draft'));
  assert.equal(out.type, 'literal');
  assert.equal(out.value, 'draft');
});

test('z.array(z.string()) → array of string', () => {
  const out = normalize(T.array(T.string()));
  assert.equal(out.type, 'array');
  assert.deepEqual(out.items, { type: 'string', required: true });
});

test('z.array(z.object({...})) → array of object', () => {
  const out = normalize(T.array(T.object({ title: T.string() })));
  assert.equal(out.type, 'array');
  assert.equal(out.items.type, 'object');
  assert.deepEqual(out.items.fields, {
    title: { type: 'string', required: true },
  });
});

test('z.union(z.string(), z.number()) → union with options', () => {
  const out = normalize(T.union(T.string(), T.number()));
  assert.equal(out.type, 'union');
  assert.equal(out.options.length, 2);
  assert.equal(out.options[0].type, 'string');
  assert.equal(out.options[1].type, 'number');
});

test('z.object({...}) → object with fields', () => {
  const out = normalize(
    T.object({
      title: T.string(),
      count: T.number(),
      draft: T.boolean(),
    })
  );
  assert.equal(out.type, 'object');
  assert.equal(out.fields.title.type, 'string');
  assert.equal(out.fields.count.type, 'number');
  assert.equal(out.fields.draft.type, 'boolean');
  assert.equal(out.required, true);
});

test('image() helper → image', () => {
  assert.deepEqual(normalize(T.image()), { type: 'image', required: true });
});

test('reference("authors") → reference with ref name', () => {
  const out = normalize(T.ref('authors'));
  assert.equal(out.type, 'reference');
  assert.equal(out.ref, 'authors');
  assert.equal(out.required, true);
});

test('nested object normalizes recursively', () => {
  const out = normalize(
    T.object({
      meta: T.object({
        title: T.string(),
        tags: T.array(T.string()),
      }),
    })
  );
  assert.equal(out.fields.meta.type, 'object');
  assert.equal(out.fields.meta.fields.title.type, 'string');
  assert.equal(out.fields.meta.fields.tags.type, 'array');
  assert.equal(out.fields.meta.fields.tags.items.type, 'string');
});

test('optional object field still required by default but not flagged', () => {
  const out = normalize(
    T.object({
      author: T.optional(T.string()),
    })
  );
  assert.equal(out.fields.author.type, 'string');
  assert.equal(out.fields.author.required, false);
});

test('nullable nested → required stays true', () => {
  const out = normalize(
    T.object({
      slug: T.nullable(T.string()),
    })
  );
  assert.equal(out.fields.slug.required, true);
});

test('default-wrapped string', () => {
  const out = normalize(T.default(T.string()));
  assert.equal(out.type, 'string');
});

test('empty object → fields {}', () => {
  const out = normalize(T.object({}));
  assert.equal(out.type, 'object');
  assert.deepEqual(out.fields, {});
});

test('optional array of nullable union', () => {
  const out = normalize(T.optional(T.array(T.nullable(T.union(T.string(), T.number())))));
  assert.equal(out.type, 'array');
  assert.equal(out.required, false);
  assert.equal(out.items.type, 'union');
  assert.equal(out.items.required, true);
  assert.equal(out.items.options.length, 2);
});

test('unknown input → unknown type', () => {
  assert.equal(normalize(null).type, 'unknown');
  assert.equal(normalize(undefined).type, 'unknown');
  assert.equal(normalize({ __type: 'zod-schema', __kind: 'totally-made-up' }).type, 'unknown');
});

test('non-schema input → unknown type', () => {
  assert.equal(normalize(42).type, 'unknown');
  assert.equal(normalize('hello').type, 'unknown');
});

// ----- Full pipeline exercises -----

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-parser-'));
const writeSchema = (name, body) => {
  const dir = path.join(tmpDir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'content.config.ts'), body);
  return dir;
};

test('parseSchemaFile: full Astro 5 collection', () => {
  const dir = writeSchema(
    'blog',
    `import { defineCollection, z } from 'astro:content';
const blog = defineCollection({
  type: 'content',
  schema: z.object({
    title: z.string(),
    draft: z.boolean(),
    tags: z.array(z.string()),
    category: z.enum(['news', 'guide']),
    author: z.string().optional(),
  }),
});
export const collections = { blog };`
  );
  const [result] = parseSchemaFile(path.join(dir, 'content.config.ts'));
  assert.equal(result.name, 'blog');
  assert.equal(result.fields.title.type, 'string');
  assert.equal(result.fields.draft.type, 'boolean');
  assert.equal(result.fields.tags.type, 'array');
  assert.equal(result.fields.tags.items.type, 'string');
  assert.equal(result.fields.category.type, 'enum');
  assert.deepEqual(result.fields.category.options, ['news', 'guide']);
  assert.equal(result.fields.author.type, 'string');
  assert.equal(result.fields.author.required, false);
});

test('parseSchemaFile: function-form schema with image + reference', () => {
  const dir = writeSchema(
    'posts',
    `import { defineCollection, z } from 'astro:content';
const posts = defineCollection({
  schema: ({ image }) => z.object({
    hero: image(),
    author: z.reference('authors'),
    published: z.date(),
  }),
});
export const collections = { posts };`
  );
  const [result] = parseSchemaFile(path.join(dir, 'content.config.ts'));
  assert.equal(result.fields.hero.type, 'image');
  assert.equal(result.fields.author.type, 'reference');
  assert.equal(result.fields.author.ref, 'authors');
  assert.equal(result.fields.published.type, 'date');
});

test('parseSchemaFile: legacy defineCollection({ schema: ({image}) => z.object(...) })', () => {
  const dir = writeSchema(
    'legacy',
    `import { defineCollection, z } from 'astro:content';
const legacy = defineCollection({
  schema: ({ image }) => z.object({
    title: z.string(),
  }),
});
export const collections = { legacy };`
  );
  const [result] = parseSchemaFile(path.join(dir, 'content.config.ts'));
  assert.equal(result.fields.title.type, 'string');
});

test('parseSchemaFile: zod direct import', () => {
  const dir = writeSchema(
    'zod',
    `import { z } from 'zod';
export const collections = {
  notes: {
    schema: z.object({
      body: z.string(),
      pinned: z.boolean().default(false),
    }),
  },
};`
  );
  const [result] = parseSchemaFile(path.join(dir, 'content.config.ts'));
  assert.equal(result.fields.body.type, 'string');
  assert.equal(result.fields.pinned.type, 'boolean');
});

test('parseSchemaFile: union with optional', () => {
  const dir = writeSchema(
    'union',
    `import { defineCollection, z } from 'astro:content';
const union = defineCollection({
  schema: z.object({
    layout: z.union(z.literal('wide'), z.literal('narrow')).optional(),
  }),
});
export const collections = { union };`
  );
  const [result] = parseSchemaFile(path.join(dir, 'content.config.ts'));
  // The outer wrapper is optional -> not required; inner is a union of literals.
  assert.equal(result.fields.layout.required, false);
  assert.equal(result.fields.layout.type, 'union');
  assert.equal(result.fields.layout.options.length, 2);
  assert.equal(result.fields.layout.options[0].type, 'literal');
  assert.equal(result.fields.layout.options[1].type, 'literal');
});

test('parseSchemaFile: missing schema call → empty fields', () => {
  const dir = writeSchema(
    'broken',
    `import { defineCollection } from 'astro:content';
export const collections = {
  broken: defineCollection({ type: 'content' }),
};`
  );
  const [result] = parseSchemaFile(path.join(dir, 'content.config.ts'));
  // With no schema, we get an empty fields object — the form will treat it
  // as a raw JSON textarea.
  assert.equal(result.fields ? Object.keys(result.fields).length : 0, 0);
});

test('parseSchemaFile: nested array of objects', () => {
  const dir = writeSchema(
    'nested',
    `import { defineCollection, z } from 'astro:content';
const nested = defineCollection({
  schema: z.object({
    sections: z.array(z.object({
      heading: z.string(),
      items: z.array(z.string()),
    })),
  }),
});
export const collections = { nested };`
  );
  const [result] = parseSchemaFile(path.join(dir, 'content.config.ts'));
  const sections = result.fields.sections;
  assert.equal(sections.type, 'array');
  assert.equal(sections.items.type, 'object');
  assert.equal(sections.items.fields.heading.type, 'string');
  assert.equal(sections.items.fields.items.type, 'array');
});

test('parseSchemaFile: multiple collections', () => {
  const dir = writeSchema(
    'multi',
    `import { defineCollection, z } from 'astro:content';
const a = defineCollection({ schema: z.object({ x: z.string() }) });
const b = defineCollection({ schema: z.object({ y: z.number() }) });
export const collections = { a, b };`
  );
  const results = parseSchemaFile(path.join(dir, 'content.config.ts'));
  assert.equal(results.length, 2);
  const names = results.map((r) => r.name).sort();
  assert.deepEqual(names, ['a', 'b']);
});

test('parseSchemaFile: default export', () => {
  const dir = writeSchema(
    'default',
    `import { defineCollection, z } from 'astro:content';
export default defineCollection({
  schema: z.object({ title: z.string() }),
});`
  );
  const [result] = parseSchemaFile(path.join(dir, 'content.config.ts'));
  assert.equal(result.fields.title.type, 'string');
});

test('parseProjectSchema: finds Astro 5 content.config.ts', () => {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'sight-project-'));
  fs.mkdirSync(path.join(projectPath, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(projectPath, 'src', 'content.config.ts'),
    `import { defineCollection, z } from 'astro:content';
export const collections = {
  posts: defineCollection({ schema: z.object({ title: z.string() }) }),
};`
  );
  const result = parseProjectSchema(projectPath);
  assert.equal(result.configPath, path.join(projectPath, 'src', 'content.config.ts'));
  assert.equal(result.collections.length, 1);
  assert.equal(result.collections[0].name, 'posts');
});

test('parseProjectSchema: falls back to src/content/config.ts', () => {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'sight-project-4-'));
  fs.mkdirSync(path.join(projectPath, 'src', 'content'), { recursive: true });
  fs.writeFileSync(
    path.join(projectPath, 'src', 'content', 'config.ts'),
    `import { defineCollection, z } from 'astro:content';
export const collections = {
  legacy: defineCollection({ schema: z.object({ legacy: z.boolean() }) }),
};`
  );
  const result = parseProjectSchema(projectPath);
  assert.equal(result.configPath, path.join(projectPath, 'src', 'content', 'config.ts'));
  assert.equal(result.collections[0].fields.legacy.type, 'boolean');
});

test('parseProjectSchema: no config → empty', () => {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'sight-project-empty-'));
  const result = parseProjectSchema(projectPath);
  assert.equal(result.configPath, null);
  assert.deepEqual(result.collections, []);
});

test('parseSchemaFile: handles broken file gracefully', () => {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'sight-project-broken-'));
  fs.mkdirSync(path.join(projectPath, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(projectPath, 'src', 'content.config.ts'),
    'this is not typescript at all >>>'
  );
  const result = parseProjectSchema(projectPath);
  assert.equal(result.error, result.error); // property exists; non-null
  assert.ok(result.error);
});

test('__test.transpile: returns plain JS', () => {
  const out = __test.transpile(`const x: number = 1;`);
  assert.ok(!out.includes(': number'));
  assert.ok(out.includes('const x'));
});

test('normalize: array of literal', () => {
  const out = normalize(T.array(T.literal('red')));
  assert.equal(out.type, 'array');
  assert.equal(out.items.type, 'literal');
  assert.equal(out.items.value, 'red');
});

test('normalize: enum inside object', () => {
  const out = normalize(
    T.object({
      status: T.enum(['draft', 'published']),
    })
  );
  assert.equal(out.fields.status.options.length, 2);
});

test('normalize: union of objects', () => {
  const out = normalize(
    T.union(
      T.object({ kind: T.literal('text'), body: T.string() }),
      T.object({ kind: T.literal('image'), src: T.string() })
    )
  );
  assert.equal(out.type, 'union');
  assert.equal(out.options.length, 2);
  assert.equal(out.options[0].type, 'object');
  assert.equal(out.options[0].fields.body.type, 'string');
});
