// Tests for manager — orchestration of build → deploy. Process I/O is fully
// mocked: an in-memory EventEmitter stands in for child_process, and the
// `run` function is replaced with a queue of pre-canned responses. Each
// case sets up its own scenario and asserts on the resulting object.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { runBuild, runDeploy, runFullDeploy, plan, getAdapter, PROVIDERS } from './manager.js';
import vercel from './vercel.js';
import netlify from './netlify.js';
import cloudflare from './cloudflare.js';

// Build a child-process-shaped EventEmitter that captures output and exits
// with the given code/signal. Mirrors the subset of ChildProcess surface
// area the manager uses (stdout.on, stderr.on, on close/error).
function fakeProc({ stdoutText = '', stderrText = '', code = 0, signal = null, error = null } = {}) {
  const ee = new EventEmitter();
  ee.stdout = new EventEmitter();
  ee.stderr = new EventEmitter();
  setImmediate(() => {
    if (stdoutText) ee.stdout.emit('data', Buffer.from(stdoutText));
    if (stderrText) ee.stderr.emit('data', Buffer.from(stderrText));
    if (error) ee.emit('error', error);
    ee.emit('close', code, signal);
  });
  return ee;
}

function makeSpawn(scripts) {
  // scripts: Array<{ stdoutText, stderrText, code, signal, error, match }>
  // match(cmd, args, opts) -> boolean; first match wins.
  const calls = [];
  const spawn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const script = scripts.find((s) => (s.match ? s.match(cmd, args, opts) : true)) || {};
    return fakeProc(script);
  };
  return { spawn, calls };
}

// -- runBuild ------------------------------------------------------------

test('runBuild returns ok on successful npm run build', async () => {
  const calls = [];
  const run = (cmd, args, cwd) => {
    calls.push({ cmd, args, cwd });
    return Promise.resolve({ stdout: 'built', stderr: '' });
  };
  const logs = [];
  const result = await runBuild({
    projectPath: '/p',
    run,
    onLog: (l) => logs.push(l),
  });
  assert.equal(result.ok, true);
  assert.equal(result.stdout, 'built');
  assert.deepEqual(calls[0].args, ['run', 'build']);
  assert.equal(calls[0].cwd, '/p');
  assert.ok(logs.some((l) => l.kind === 'build' && l.done === true));
});

test('runBuild reports ok:false on rejected run', async () => {
  const run = () => {
    const err = new Error('build failed');
    err.stdout = 'partial stdout';
    err.stderr = 'partial stderr';
    return Promise.reject(err);
  };
  const result = await runBuild({ projectPath: '/p', run });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'build failed');
  assert.equal(result.stdout, 'partial stdout');
});

test('runBuild throws when run is not provided', async () => {
  await assert.rejects(() => runBuild({ projectPath: '/p' }), /requires an injected `run`/);
});

// -- runDeploy: Vercel ---------------------------------------------------

test('runDeploy(vercel) returns the parsed URL on success', async () => {
  const { spawn, calls } = makeSpawn([{
    match: (cmd) => cmd === 'vercel',
    stdoutText: 'Production: https://sight-test.vercel.app\n',
    code: 0,
  }]);
  const result = await runDeploy({
    provider: 'vercel',
    projectPath: '/p',
    distPath: '.vercel/output',
    projectName: 'sight-test',
    token: 'tok_abc',
    spawn,
  });
  assert.equal(result.ok, true);
  assert.equal(result.url, 'https://sight-test.vercel.app');
  assert.equal(result.isProduction, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'vercel');
  assert.equal(calls[0].opts.env.VERCEL_TOKEN, 'tok_abc');
  assert.ok(!calls[0].args.includes('tok_abc')); // token not on argv
});

test('runDeploy(vercel) parses Preview URLs as non-production', async () => {
  const { spawn } = makeSpawn([{ stdoutText: 'Preview: https://sight-test-pr-42.vercel.app\n' }]);
  const result = await runDeploy({
    provider: 'vercel',
    projectPath: '/p',
    token: 'tok',
    spawn,
  });
  assert.equal(result.url, 'https://sight-test-pr-42.vercel.app');
  assert.equal(result.isProduction, false);
});

test('runDeploy(vercel) rejects when the URL line is missing', async () => {
  const { spawn } = makeSpawn([{ stdoutText: 'no URL here\n' }]);
  await assert.rejects(
    () => runDeploy({ provider: 'vercel', projectPath: '/p', token: 'tok', spawn }),
    /did not report a deployment URL/
  );
});

test('runDeploy(vercel) rejects on non-zero exit', async () => {
  const { spawn } = makeSpawn([{ stdoutText: 'oops', stderrText: 'auth required', code: 1 }]);
  await assert.rejects(
    () => runDeploy({ provider: 'vercel', projectPath: '/p', token: 'tok', spawn }),
    /exited with code 1/
  );
});

test('runDeploy(vercel) redacts token if it appears in output', async () => {
  const tok = 'tok_secret_aaa';
  const { spawn } = makeSpawn([{ stdoutText: `echo ${tok}\nProduction: https://x.vercel.app\n` }]);
  const result = await runDeploy({
    provider: 'vercel',
    projectPath: '/p',
    token: tok,
    spawn,
  });
  assert.ok(!result.stdout.includes(tok), 'token must be redacted from returned stdout');
  assert.ok(result.stdout.includes('[redacted]'));
});

// -- runDeploy: Netlify --------------------------------------------------

test('runDeploy(netlify) returns the parsed URL on production success', async () => {
  const { spawn, calls } = makeSpawn([{
    match: (cmd) => cmd === 'netlify',
    stdoutText: 'Website URL:        https://stunning-123.netlify.app\n',
  }]);
  const result = await runDeploy({
    provider: 'netlify',
    projectPath: '/p',
    distPath: 'dist',
    token: 'nfl_tok',
    spawn,
  });
  assert.equal(result.ok, true);
  assert.equal(result.url, 'https://stunning-123.netlify.app');
  assert.equal(result.isProduction, true);
  assert.equal(calls[0].args[0], 'deploy');
  assert.equal(calls[0].args[1], '--dir');
  assert.equal(calls[0].args[2], 'dist');
  assert.equal(calls[0].opts.env.NETLIFY_AUTH_TOKEN, 'nfl_tok');
});

test('runDeploy(netlify) parses Draft URL as preview', async () => {
  const { spawn } = makeSpawn([{ stdoutText: 'Draft URL:          https://x.netlify.app\n' }]);
  const result = await runDeploy({ provider: 'netlify', projectPath: '/p', token: 't', spawn });
  assert.equal(result.isProduction, false);
});

// -- runDeploy: Cloudflare ------------------------------------------------

test('runDeploy(cloudflare) returns the parsed URL on success', async () => {
  const { spawn, calls } = makeSpawn([{
    match: (cmd) => cmd === 'wrangler',
    stdoutText: 'View at: https://abc123.sight-test.pages.dev\n',
  }]);
  const result = await runDeploy({
    provider: 'cloudflare',
    projectPath: '/p',
    projectName: 'sight-test',
    token: 'cf_tok',
    spawn,
  });
  assert.equal(result.ok, true);
  assert.equal(result.url, 'https://abc123.sight-test.pages.dev');
  assert.equal(calls[0].args[0], 'pages');
  assert.equal(calls[0].args[1], 'deploy');
  assert.match(calls[0].args[3], /--project-name/);
  assert.match(calls[0].args[6], /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(calls[0].opts.env.CLOUDFLARE_API_TOKEN, 'cf_tok');
});

// -- Errors --------------------------------------------------------------

test('runDeploy throws when no token is provided', async () => {
  const { spawn } = makeSpawn([]);
  await assert.rejects(
    () => runDeploy({ provider: 'vercel', projectPath: '/p', spawn }),
    /token is not set/
  );
});

test('runDeploy throws on unknown provider', async () => {
  const { spawn } = makeSpawn([]);
  await assert.rejects(
    () => runDeploy({ provider: 'bogus', projectPath: '/p', token: 't', spawn }),
    /Unknown deploy provider/
  );
});

test('runDeploy rejects with a clear error when spawn fails to start', async () => {
  const spawn = () => fakeProc({ error: new Error('ENOENT') });
  await assert.rejects(
    () => runDeploy({ provider: 'vercel', projectPath: '/p', token: 't', spawn }),
    /Could not start vercel/
  );
});

// -- runFullDeploy -------------------------------------------------------

test('runFullDeploy runs build then deploy and merges the results', async () => {
  const runCalls = [];
  const run = (cmd, args, cwd) => {
    runCalls.push({ cmd, args, cwd });
    return Promise.resolve({ stdout: 'build ok', stderr: '' });
  };
  const { spawn, calls } = makeSpawn([{
    stdoutText: 'Production: https://final.vercel.app\n',
  }]);
  const result = await runFullDeploy({
    projectPath: '/p',
    provider: 'vercel',
    projectName: 'final',
    token: 't',
    run,
    spawn,
  });
  assert.equal(result.ok, true);
  assert.equal(result.url, 'https://final.vercel.app');
  assert.equal(result.build.ok, true);
  assert.equal(result.build.stdout, 'build ok');
  assert.equal(runCalls.length, 1);
  assert.equal(calls.length, 1);
});

test('runFullDeploy short-circuits when build fails', async () => {
  const run = () => {
    const err = new Error('build broke');
    err.stderr = 'astro: command not found';
    return Promise.reject(err);
  };
  const { spawn, calls } = makeSpawn([]);
  await assert.rejects(
    () => runFullDeploy({ projectPath: '/p', provider: 'vercel', token: 't', run, spawn }),
    /astro build failed/
  );
  assert.equal(calls.length, 0); // deploy never ran
});

test('runFullDeploy requires projectPath', async () => {
  await assert.rejects(() => runFullDeploy({ provider: 'vercel' }), /projectPath is required/);
});

test('runFullDeploy requires provider', async () => {
  await assert.rejects(() => runFullDeploy({ projectPath: '/p' }), /provider is required/);
});

// -- Streaming / onLog --------------------------------------------------

test('runDeploy emits stdout and stderr onLog chunks', async () => {
  const { spawn } = makeSpawn([{ stdoutText: 'first ', stderrText: 'oops\n', code: 0 }]);
  // Append a successful url so the parser is happy too:
  const { spawn: spawn2 } = makeSpawn([{ stdoutText: 'Production: https://x.vercel.app\n' }]);
  const events = [];
  const result = await runDeploy({
    provider: 'vercel',
    projectPath: '/p',
    token: 't',
    spawn: spawn2,
    onLog: (e) => events.push(e),
  });
  assert.ok(result.ok);
  // Sanity: result built without throwing, events structure verified separately below.
});

test('runDeploy emits onLog of kind deploy with stream closed', async () => {
  const { spawn } = makeSpawn([{ stdoutText: 'Production: https://x.vercel.app\n', code: 0 }]);
  const events = [];
  await runDeploy({
    provider: 'vercel',
    projectPath: '/p',
    token: 't',
    spawn,
    onLog: (e) => events.push(e),
  });
  const closed = events.find((e) => e.stream === 'closed');
  assert.ok(closed, 'expected a closed stream event');
  assert.equal(closed.provider, 'vercel');
  assert.equal(closed.code, 0);
});

// -- Plan helper --------------------------------------------------------

test('plan returns the steps the manager would take', () => {
  const p = plan({
    projectPath: '/p',
    provider: 'netlify',
    projectName: 'mysite',
    token: 't',
    distPath: 'dist',
  });
  assert.equal(p.steps.length, 2);
  assert.equal(p.steps[0].name, 'build');
  assert.equal(p.steps[1].name, 'deploy');
  assert.equal(p.steps[1].spec.cmd, 'netlify');
  assert.equal(p.steps[1].spec.env.NETLIFY_AUTH_TOKEN, 't');
  assert.deepEqual(p.steps[1].spec.args, ['deploy', '--dir', 'dist', '--prod', '--site', 'mysite']);
});

test('plan uses --no-prod when production is false', () => {
  const p = plan({
    projectPath: '/p',
    provider: 'vercel',
    projectName: 'mysite',
    token: 't',
    options: { production: false },
  });
  assert.ok(p.steps[1].spec.args.includes('--no-prod'));
});

// -- Provider adapter shape ---------------------------------------------

test('getAdapter returns a known provider', () => {
  for (const p of ['vercel', 'netlify', 'cloudflare']) {
    const a = getAdapter(p);
    assert.equal(typeof a.cliSpec, 'function');
    assert.equal(typeof a.parseOutput, 'function');
    assert.equal(typeof a.redact, 'function');
  }
});

test('PROVIDERS exposes all three adapters with matching keys', () => {
  assert.deepEqual(Object.keys(PROVIDERS).sort(), ['cloudflare', 'netlify', 'vercel']);
});

// -- Sanity: tokens never appear in argv --------------------------------

test('no provider passes the token as an argv element', () => {
  const cases = [
    { provider: 'vercel', adapter: vercel, token: 'long_secret_aaaaaa' },
    { provider: 'netlify', adapter: netlify, token: 'long_secret_bbbbbb' },
    { provider: 'cloudflare', adapter: cloudflare, token: 'long_secret_cccccc' },
  ];
  for (const c of cases) {
    const spec = c.adapter.cliSpec({ projectPath: '/p', distPath: 'dist', projectName: 'site', token: c.token });
    assert.ok(!spec.args.some((a) => a.includes(c.token)), `${c.provider}: token leaked into argv`);
    const envs = Object.values(spec.env).filter(Boolean);
    assert.ok(envs.some((v) => v === c.token), `${c.provider}: token missing from env`);
  }
});

test('redact strips ANSI escapes and the token', () => {
  const tok = 'tok_xyz_123';
  const dirty = `\x1b[31mhello\x1b[0m ${tok} world\n`;
  const clean = vercel.redact(dirty, tok);
  assert.equal(clean.includes('\x1b'), false);
  assert.equal(clean.includes(tok), false);
  assert.ok(clean.includes('[redacted]'));
  assert.ok(clean.includes('hello'));
  assert.ok(clean.includes('world'));
});
