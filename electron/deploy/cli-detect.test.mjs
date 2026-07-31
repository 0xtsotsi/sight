// Tests for cli-detect. All process calls are mocked — no shell, no real
// `which`. Pure: each case constructs an explicit input, asserts on output.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { detectCli, detectCliSync, PROVIDERS } from './cli-detect.js';

test('PROVIDERS lists the three deploy providers in stable order', () => {
  assert.deepEqual(PROVIDERS, ['vercel', 'netlify', 'wrangler']);
});

test('detectCliSync marks providers present when execSync resolves', () => {
  const execSync = (cmd) => {
    if (cmd === 'vercel' || cmd === 'wrangler') return 'v1.0.0\n';
    const err = new Error('not found');
    err.code = 'ENOENT';
    throw err;
  };
  const result = detectCliSync({ execSync });
  assert.equal(result.vercel, true);
  assert.equal(result.wrangler, true);
  assert.equal(result.netlify, false);
});

test('detectCliSync returns all-false when no execSync is provided', () => {
  const result = detectCliSync({});
  assert.deepEqual(result, { vercel: false, netlify: false, wrangler: false });
});

test('detectCliSync tolerates one provider throwing', () => {
  let count = 0;
  const execSync = (cmd) => {
    count++;
    if (cmd === 'netlify') throw new Error('not found');
    return '1';
  };
  const result = detectCliSync({ execSync });
  assert.equal(result.vercel, true);
  assert.equal(result.wrangler, true);
  assert.equal(result.netlify, false);
  assert.equal(count, 3);
});

test('detectCliSync with custom provider list scopes the output', () => {
  const execSync = () => '1';
  const result = detectCliSync({ providers: ['vercel'], execSync });
  assert.deepEqual(Object.keys(result), ['vercel']);
  assert.equal(result.vercel, true);
});

test('detectCli parses ON: lines from a successful shell script', async () => {
  const fakeExec = (cmd, args, opts, cb) => {
    cb(null, 'ON:vercel\nOFF:netlify\nON:wrangler\n', '');
  };
  const result = await detectCli({ providers: ['vercel', 'netlify', 'wrangler'], exec: fakeExec });
  assert.deepEqual(result, { vercel: true, netlify: false, wrangler: true });
});

test('detectCli returns all-false on shell error', async () => {
  const fakeExec = (cmd, args, opts, cb) => cb(new Error('boom'), '', '');
  const result = await detectCli({ providers: PROVIDERS, exec: fakeExec });
  assert.deepEqual(result, { vercel: false, netlify: false, wrangler: false });
});

test('detectCli handles CR/LF mixed line endings', async () => {
  const fakeExec = (cmd, args, opts, cb) => cb(null, 'ON:vercel\r\nOFF:netlify\r\nON:wrangler\r\n', '');
  const result = await detectCli({ providers: PROVIDERS, exec: fakeExec });
  assert.equal(result.vercel, true);
  assert.equal(result.wrangler, true);
  assert.equal(result.netlify, false);
});

test('detectCli ignores lines that are not provider results', async () => {
  const fakeExec = (cmd, args, opts, cb) => cb(null, 'warning: something\nON:vercel\n', '');
  const result = await detectCli({ providers: PROVIDERS, exec: fakeExec });
  assert.equal(result.vercel, true);
  assert.equal(result.netlify, false);
  assert.equal(result.wrangler, false);
});

test('detectCli treats unknown names in output as false', async () => {
  const fakeExec = (cmd, args, opts, cb) => cb(null, 'ON:nope\nON:vercel\n', '');
  const result = await detectCli({ providers: PROVIDERS, exec: fakeExec });
  assert.equal(result.vercel, true);
  assert.equal(result.netlify, false);
  assert.equal(result.wrangler, false);
});

test('detectCli passes shell as the first argument to exec', async () => {
  let received = null;
  const fakeExec = (cmd, args, opts, cb) => {
    received = { cmd, args, opts };
    cb(null, 'ON:vercel\n', '');
  };
  await detectCli({ shell: '/bin/bash', providers: ['vercel'], exec: fakeExec });
  assert.equal(received.cmd, '/bin/bash');
  assert.deepEqual(received.args[0], '-c');
  assert.ok(typeof received.args[1] === 'string' && received.args[1].includes('vercel'));
});

test('detectCli uses the providers list in the script body', async () => {
  let scriptText = '';
  const fakeExec = (cmd, args, opts, cb) => {
    scriptText = args[1];
    cb(null, '', '');
  };
  await detectCli({ providers: ['vercel', 'netlify'], exec: fakeExec });
  assert.match(scriptText, /vercel/);
  assert.match(scriptText, /netlify/);
  assert.doesNotMatch(scriptText, /wrangler/);
});
