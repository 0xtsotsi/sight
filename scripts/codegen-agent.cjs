#!/usr/bin/env node
// scripts/codegen-agent.cjs
//
// Scaffold a new agent-side tool following the existing conventions in
// src/agent/. Generates:
//   1. A zod schema entry in src/agent/schemas.js
//   2. A JSON Schema entry in src/agent/tools.js
//   3. A handler entry in src/agent/tools.js buildTools()
//   4. A smoke test stub in src/agent/__tests__/tools.smoke.test.js
//
// Usage:
//   npm run codegen:agent -- <tool-name> "<short description>"
//   npm run codegen:agent -- read_style "Read a CSS style block by selector"
//
// Interactive mode (no args):
//   npm run codegen:agent -- --interactive
//   npm run codegen:agent                # same, when stdin is a TTY
//
// Conventions enforced (matches the existing code):
//   - Tool names use snake_case (matches the MCP convention).
//   - Args are validated via zod (schemas.js) and a parallel JSON Schema
//     (tools.js). The smoke test asserts both stay in sync.
//   - Handlers read projectPath from the injected `ctx` — never closure.
//   - Write-capability tools are flagged at scaffold time and emit a
//     warning if the user picks a non-`_diff` suffix for a write verb.

'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const here = path.resolve(__dirname, '..');
const schemasFile = path.join(here, 'src', 'agent', 'schemas.js');
const toolsFile = path.join(here, 'src', 'agent', 'tools.js');
const testFile = path.join(here, 'src', 'agent', '__tests__', 'tools.smoke.test.js');

function die(msg) {
  console.error('error:', msg);
  console.error('Usage: npm run codegen:agent -- <tool_name_snake_case> "<description>"');
  console.error('       npm run codegen:agent -- --interactive');
  process.exit(1);
}

async function prompt(rl, question, defaultValue) {
  return new Promise((resolve) => {
    const q = defaultValue
      ? `${question} [${defaultValue}]: `
      : `${question}: `;
    rl.question(q, (answer) => {
      const v = (answer || '').trim();
      resolve(v || defaultValue || '');
    });
  });
}

async function promptArgs() {
  // Decide if we should enter the REPL: explicit --interactive flag, OR
  // no args + a TTY stdin. CI runs (no TTY, no args) fail loudly instead
  // of hanging on a read.
  const interactive = process.argv.includes('--interactive') || process.argv.includes('-i');
  if (process.argv[2] && process.argv[3]) {
    return { toolName: process.argv[2], toolDesc: process.argv[3] };
  }
  if (!interactive && !(process.stdin.isTTY && !process.argv[2])) {
    die('missing args (use --interactive to enter the REPL)');
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log('');
    console.log('=== Sight agent-tool scaffold (interactive) ===');
    console.log('Press Ctrl-C to abort at any time.');
    console.log('');
    console.log('Naming rules:');
    console.log('  - snake_case starting with a lowercase letter');
    console.log('  - Write tools MUST end in _diff (see src/agent/tools.js)');
    console.log('');

    let name = '';
    while (!name) {
      const candidate = await prompt(rl, 'Tool name (snake_case)');
      if (!/^[a-z][a-z0-9_]*$/.test(candidate)) {
        console.log('  ✗ invalid name. Examples: read_style, apply_style_diff, list_assets');
        continue;
      }
      name = candidate;
    }

    let desc = '';
    while (desc.length < 8 || desc.length > 200) {
      desc = await prompt(rl, 'Short description (8–200 chars)');
      if (desc.length < 8 || desc.length > 200) {
        console.log(`  ✗ must be 8–200 chars, got: ${desc.length}`);
        desc = '';
      }
    }

    return { toolName: name, toolDesc: desc };
  } finally {
    rl.close();
  }
}

(async () => {
  const { toolName, toolDesc } = await promptArgs();

  if (!toolName || !toolDesc) die('missing args');
  if (!/^[a-z][a-z0-9_]*$/.test(toolName)) {
    die(`tool name must be snake_case starting with a letter, got: ${toolName}`);
  }
  if (toolDesc.length < 8 || toolDesc.length > 200) {
    die(`description must be 8–200 chars, got: ${toolDesc.length}`);
  }

const camelName = toolName.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
const argsSchemaName = camelName + 'ArgsSchema';
const writey = /(?:^|_)(write|create|delete|update|remove|drop|set|put|patch)(?:_|$)/i.test(toolName);
const isDiff = toolName.endsWith('_diff');
if (writey && !isDiff) {
  console.warn(
    '⚠️  Warning: tool name suggests a write capability but does not end in `_diff`.',
  );
  console.warn('   Convention: ALL write tools must end in _diff (see src/agent/tools.js).');
  console.warn('   Press Ctrl-C if you want to fix the name, otherwise the scaffold will proceed.');
}

// ---------------------------------------------------------------------------
// Read existing files
// ---------------------------------------------------------------------------
const schemasSrc = fs.readFileSync(schemasFile, 'utf8');
const toolsSrc = fs.readFileSync(toolsFile, 'utf8');
const testSrc = fs.readFileSync(testFile, 'utf8');

if (toolsSrc.includes(`'${toolName}'`)) {
  die(`tool '${toolName}' is already defined in tools.js`);
}
if (schemasSrc.includes(`export const ${argsSchemaName}`)) {
  die(`${argsSchemaName} is already exported from schemas.js`);
}

// ---------------------------------------------------------------------------
// 1. Append zod schema to schemas.js
// ---------------------------------------------------------------------------
const schemaBlock = `

// ---------------------------------------------------------------------------
// ${toolName} — ${toolDesc}
// ---------------------------------------------------------------------------

export const ${argsSchemaName} = z.object({
  // TODO: replace with the actual args this tool needs.
  // Example:
  //   path: z.string().min(1),
  //   options: z.object({ recursive: z.boolean().optional() }).optional(),
});
`;
const newSchemas = schemasSrc + schemaBlock;

// ---------------------------------------------------------------------------
// 2. Append JSON Schema + handler to tools.js
// ---------------------------------------------------------------------------
const jsonSchemaBlock = `  ${toolName}: {
    type: 'object',
    properties: {
      // TODO: mirror the zod fields above in JSON Schema form.
    },
    additionalProperties: false,
  },
`;
const newTools = toolsSrc.replace(
  /(\s*const inputSchemas = \{)([\s\S]*?)(^\};)/m,
  (match, open, inner, close) => {
    if (inner.includes(`  ${toolName}:`)) {
      die(`inputSchemas already contains ${toolName}`);
    }
    return open + inner + '\n' + jsonSchemaBlock + close;
  },
);

// Append handler entry in buildTools(). We add a TODO that links to the
// matching scaffolded test.
const handlerBlock = `    ${toolName}: {
      description: ${JSON.stringify(toolDesc)},
      inputSchema: inputSchemas.${toolName},
      handler: async (args, ctx) => {
        // TODO: implement against window.avb.* verbs. Read ctx.projectPath
        // for the workspace; never depend on closure state.
        const args0 = ${argsSchemaName}.parse(args ?? {});
        const avb = globalThis.window?.avb;
        if (!avb) throw new Error('avb bridge unavailable');
        throw new Error('${toolName} not implemented yet');
      },
    },
`;
const newTools2 = newTools.replace(
  /(\s*return tools;\s*$)/m,
  (match) => '\n' + handlerBlock + '\n' + match,
);

// ---------------------------------------------------------------------------
// 3. Append a stub test
// ---------------------------------------------------------------------------
const testBlock = `

test('${toolName}: handler not-implemented error is surfaced', async () => {
  globalThis.window = { avb: {
    // TODO: stub the avb.* verbs this tool calls. Empty stub for now.
  } };
  const mod = await import(\`../tools.js?cache=\${Math.random()}\`);
  const tools = mod.buildTools({ projectPath: '/tmp/none' });
  const tool = tools.${toolName};
  assert.ok(tool, 'tool should be registered');
  assert.equal(tool.description, ${JSON.stringify(toolDesc)});
  await assert.rejects(
    () => tool.handler({}, { projectPath: '/tmp/none' }),
    /not implemented/,
  );
});
`;
const newTestSrc = testSrc + testBlock;

// ---------------------------------------------------------------------------
// Write everything
// ---------------------------------------------------------------------------
fs.writeFileSync(schemasFile, newSchemas, 'utf8');
fs.writeFileSync(toolsFile, newTools2, 'utf8');
fs.writeFileSync(testFile, newTestSrc, 'utf8');

console.log('✓ Scaffolded agent tool: ' + toolName);
console.log('  - src/agent/schemas.js    (+ ' + argsSchemaName + ')');
console.log('  - src/agent/tools.js       (+ inputSchemas entry + handler stub)');
console.log('  - src/agent/__tests__/tools.smoke.test.js (+ stub test)');
console.log('');
console.log('Next steps:');
console.log('  1. Fill in the zod schema in src/agent/schemas.js');
console.log('  2. Mirror it in src/agent/tools.js inputSchemas');
console.log('  3. Implement the handler in src/agent/tools.js');
console.log('  4. Run: npm test');
console.log('  5. Verify end-to-end: npm run agent:test');
})().catch((err) => {
  console.error('FAIL: uncaught error:', err && err.stack ? err.stack : err);
  process.exit(1);
});
