#!/usr/bin/env node
// scripts/agent-smoke.cjs
//
// Live smoke test for the agent-credential IPC + the bundled gg-agent SDK.
//
// What this script does (the exact same path the Sight agent panel uses):
//   1. Calls getCredential() from electron/agentCredential.js — the same
//      bytes the IPC handler runs.
//   2. If a credential is found, imports @kenkaiiii/gg-agent and runs
//      agentLoop({ provider, model: 'MiniMax-M3', apiKey }) with a
//      one-token prompt.
//   3. Prints the resulting events so you can verify the round-trip.
//
// Run with:   npm run agent:test
// Bypass:     SIGHT_AGENT_TEST_FAKE=1 prints a synthetic success without
//             making any network calls (CI / offline).
//
// This is a manual verification script (not part of the node:test suite).
// It exists because the credential lookup depends on real files in $HOME
// and the API call requires a network — both are environment-dependent,
// so we keep them out of the unit-test path.

'use strict';

const path = require('path');

(async () => {
  const FAKE = process.env.SIGHT_AGENT_TEST_FAKE === '1';
  const here = path.resolve(__dirname, '..');
  const { getCredential } = require(path.join(here, 'electron', 'agentCredential.js'));

  console.log('=== Sight agent smoke test ===');
  console.log('cwd:', here);
  console.log('mode:', FAKE ? 'FAKE (no network)' : 'LIVE (real files + real API)');
  console.log();

  // Step 1 — credential lookup against real files.
  const result = getCredential();
  if (!result.ok) {
    console.error('FAIL: credential lookup failed:', result.error);
    console.error('Hint: run `ggcoder login` or set MINIMAX_API_KEY in ~/.gg/settings.json');
    process.exit(1);
  }
  const { provider, apiKey } = result.credential;
  console.log('PASS: credential lookup');
  console.log('  provider:', provider);
  console.log('  apiKey:   ', apiKey.slice(0, 8) + '… (len=' + apiKey.length + ')');
  console.log();

  if (FAKE) {
    console.log('PASS: fake smoke test (no live call made).');
    process.exit(0);
  }

  // Step 2 — fire the exact call the renderer's runAgentStream makes.
  const { agentLoop } = await import('@kenkaiiii/gg-agent');

  console.log('Calling agentLoop({ provider: ' + provider + ', model: MiniMax-M3 }) …');
  const stream = agentLoop(
    [{ role: 'user', content: [{ type: 'text', text: 'Reply with exactly: PONG' }] }],
    {
      provider,
      model: 'MiniMax-M3',
      apiKey,
      system: 'You are a smoke test. Reply exactly as instructed.',
      maxTurns: 1,
      maxTokens: 32,
      tools: [],
    },
  );

  let text = '';
  let done = false;
  let errorMsg = null;
  const start = Date.now();
  for await (const ev of stream) {
    if (ev.type === 'text_delta') {
      text += ev.text;
      process.stdout.write(ev.text);
    } else if (ev.type === 'agent_done') {
      done = true;
    } else if (ev.type === 'error') {
      errorMsg = ev.message || ev.error || 'unknown error';
    }
  }
  const elapsed = Date.now() - start;
  console.log();
  console.log();

  if (errorMsg) {
    console.error('FAIL: agentLoop emitted error:', errorMsg);
    process.exit(1);
  }
  if (!done) {
    console.error('FAIL: agentLoop did not emit agent_done');
    process.exit(1);
  }
  if (text.trim() !== 'PONG') {
    console.error('FAIL: expected "PONG", got:', JSON.stringify(text));
    process.exit(1);
  }
  console.log('PASS: live agentLoop round-trip (' + elapsed + 'ms)');
  console.log('  text:    ', JSON.stringify(text));
  console.log('  status:  ok');
  process.exit(0);
})().catch((err) => {
  console.error('FAIL: uncaught error:', err && err.stack ? err.stack : err);
  process.exit(1);
});
