// electron/__tests__/design-systems.test.js
//
// M8 verification: the design-system token block emitter produces a
// scoped CSS block from a preset name + tokens. We import the exported
// `emitDesignSystemTokens` function and assert its shape.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// The parser is a CommonJS module. Asset that doesn't matter for these
// tests — we extract just the emitDesignSystemTokens function through a
// dynamic ESM wrapper that runs the file as CJS. To keep this test fast
// and isolated, we test the emitter logic standalone by sourcing the
// parser's source and evaluating just the function definition with
// `node:vm`. This avoids the ESM/CJS bridge issues that come from
// importing the full parser (which requires Node-only modules).
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const parserSrc = fs.readFileSync(path.resolve('electron/astroParser.js'), 'utf8');
// Pull out the emitDesignSystemTokens function and a small shim so we
// can run it without the parser's larger dependencies. The function is
// declared as `function emitDesignSystemTokens` (CommonJS-style) so we
// match `function ` not `export function `.
const match = parserSrc.match(/(?:^|\n)function emitDesignSystemTokens[\s\S]+?\n\}\s*$/m);
if (!match) throw new Error('Could not extract emitDesignSystemTokens from astroParser.js');
const code = `module.exports = { emitDesignSystemTokens: ${match[0]} };`;
const sandbox = { module: { exports: {} } };
const ctx = vm.createContext(sandbox);
vm.runInContext(code, ctx);
const { emitDesignSystemTokens } = sandbox.module.exports;

test('M8-1: parser emits `:root[data-design-system="name"]` block', async () => {
  const out = emitDesignSystemTokens('high-contrast', { '--text': '#fff', '--bg': '#000', '--accent': '#ffcb05' });
  assert.match(out, /<style>:root\[data-design-system="high-contrast"\]/);
  assert.match(out, /  --text: #fff;/);
  assert.match(out, /  --bg: #000;/);
  assert.match(out, /  --accent: #ffcb05;/);
  assert.match(out, /<\/style>/);
});

test('M8-2: rejects invalid names and tokens', async () => {
  assert.equal(emitDesignSystemTokens('foo bar', { '--text': '#000' }), '', 'invalid name rejected');
  assert.equal(emitDesignSystemTokens('default', { 'no-leading-dash': 'red' }), '', 'invalid key rejected');
  assert.equal(emitDesignSystemTokens('default', {}), '', 'empty tokens rejected');
  // Sanitize css injection attempts.
  const out = emitDesignSystemTokens('safe', { '--bg': 'red; } body { display: none' });
  assert.match(out, /  --bg: red  body  display: none;/);
  assert.equal(out.indexOf('} body'), -1, 'semicolons/braces stripped');
});
