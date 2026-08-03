// Tests for the Anthropic adapter. Uses dependency injection (a fake
// `client` is passed to createAnthropicProvider) so we never have to mock
// the real SDK require.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createAnthropicProvider, redactMessage } from './anthropic.js';

function makeFakeClient(events) {
  const fake = {
    lastStream: null,
    messages: {
      stream: async (params, opts) => {
        fake.lastStream = { params, opts };
        return {
          [Symbol.asyncIterator]: async function* () {
            for (const e of events) yield e;
          },
        };
      },
    },
  };
  return fake;
}

test('sends tool_choice with json schema and messages', async () => {
  const events = [
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'emit_patch' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"reason":"x"}' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_stop' },
  ];
  const client = makeFakeClient(events);
  const provider = createAnthropicProvider({ apiKey: 'sk-ant-test', model: 'claude-sonnet-4-5', client });
  const out = [];
  for await (const ev of provider.streamPatch({ node: { id: 'a', kind: 'element', name: 'p', props: { class: 'x' }, children: [] }, instruction: 'make it red' })) {
    out.push(ev);
  }
  const call = client.lastStream;
  assert.equal(call.params.model, 'claude-sonnet-4-5');
  assert.equal(call.params.tool_choice.type, 'tool');
  assert.equal(call.params.tool_choice.name, 'emit_patch');
  assert.equal(call.params.tools[0].name, 'emit_patch');
  assert.equal(call.params.tools[0].input_schema.type, 'object');
  assert.equal(call.params.messages.length, 1);
  assert.equal(call.params.messages[0].role, 'user');
  const patchEv = out.find((e) => e.type === 'patch');
  assert.ok(patchEv, 'patch event emitted');
  assert.deepEqual(patchEv.patch, { reason: 'x' });
});

test('streams text deltas as they arrive', async () => {
  const events = [
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello ' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'world' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 't1', name: 'emit_patch' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"reason":"d"}' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_stop' },
  ];
  const client = makeFakeClient(events);
  const provider = createAnthropicProvider({ apiKey: 'sk-ant-test', client });
  const deltas = [];
  for await (const ev of provider.streamPatch({ node: {}, instruction: 'x' })) {
    if (ev.type === 'delta') deltas.push(ev.text);
  }
  assert.deepEqual(deltas, ['hello ', 'world']);
});

test('rejects malformed JSON tool input with a clean error', async () => {
  const events = [
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'emit_patch' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 'not-json' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_stop' },
  ];
  const provider = createAnthropicProvider({ apiKey: 'sk-ant-test', client: makeFakeClient(events) });
  const out = [];
  for await (const ev of provider.streamPatch({ node: {}, instruction: 'x' })) out.push(ev);
  const errEv = out.find((e) => e.type === 'error');
  assert.ok(errEv);
  assert.match(errEv.message, /malformed JSON/);
});

test('rejects empty patch with a clean error', async () => {
  const provider = createAnthropicProvider({ apiKey: 'sk-ant-test', client: makeFakeClient([{ type: 'message_stop' }]) });
  const out = [];
  for await (const ev of provider.streamPatch({ node: {}, instruction: 'x' })) out.push(ev);
  const errEv = out.find((e) => e.type === 'error');
  assert.ok(errEv);
  assert.match(errEv.message, /did not return a structured patch/);
});

test('redacts sk-ant keys from error messages', () => {
  const redacted = redactMessage('auth failed: sk-ant-abcdef1234567890xyz and other text');
  assert.match(redacted, /\[REDACTED\]/);
  assert.doesNotMatch(redacted, /sk-ant-/);
});

test('redacts x-api-key header in error messages', () => {
  const redacted = redactMessage("Header 'x-api-key: sk-ant-deadbeef' rejected");
  assert.doesNotMatch(redacted, /sk-ant-deadbeef/);
});

test('throws on missing api key', () => {
  assert.throws(() => createAnthropicProvider({}), /Missing Anthropic API key/);
});

test('handles SDK thrown error gracefully', async () => {
  const client = {
    messages: { stream: async () => { throw new Error('connection refused'); } },
  };
  const provider = createAnthropicProvider({ apiKey: 'sk-ant-x', client });
  const out = [];
  for await (const ev of provider.streamPatch({ node: {}, instruction: 'x' })) out.push(ev);
  const errEv = out.find((e) => e.type === 'error');
  assert.ok(errEv);
  assert.match(errEv.message, /connection refused/);
});

test('handles iterator thrown error', async () => {
  const events = [
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'emit_patch' } },
  ];
  const client = {
    messages: {
      stream: async () => ({
        [Symbol.asyncIterator]: async function* () {
          yield events[0];
          throw new Error('stream broke');
        },
      }),
    },
  };
  const provider = createAnthropicProvider({ apiKey: 'sk-ant-x', client });
  const out = [];
  for await (const ev of provider.streamPatch({ node: {}, instruction: 'x' })) out.push(ev);
  const errEv = out.find((e) => e.type === 'error');
  assert.ok(errEv);
  assert.match(errEv.message, /stream broke/);
});

test('emits a terminal done event', async () => {
  const events = [
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'emit_patch' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"reason":"ok"}' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_stop' },
  ];
  const provider = createAnthropicProvider({ apiKey: 'sk-ant-x', client: makeFakeClient(events) });
  const out = [];
  for await (const ev of provider.streamPatch({ node: {}, instruction: 'x' })) out.push(ev);
  assert.equal(out[out.length - 1].type, 'done');
});

test('includes history turns before the latest user message', async () => {
  const events = [
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'emit_patch' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"reason":"r"}' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_stop' },
  ];
  const client = makeFakeClient(events);
  const provider = createAnthropicProvider({ apiKey: 'sk-ant-x', client });
  for await (const _ of provider.streamPatch({
    node: {},
    instruction: 'go',
    history: [{ role: 'user', content: 'first' }, { role: 'assistant', content: 'ok' }],
  })) { /* drain */ }
  assert.equal(client.lastStream.params.messages.length, 3);
  assert.equal(client.lastStream.params.messages[0].role, 'user');
  assert.equal(client.lastStream.params.messages[1].role, 'assistant');
  assert.equal(client.lastStream.params.messages[2].role, 'user');
});

test('passes model override through', async () => {
  const events = [
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'emit_patch' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"reason":"r"}' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_stop' },
  ];
  const client = makeFakeClient(events);
  const provider = createAnthropicProvider({ apiKey: 'sk-ant-x', model: 'claude-haiku-4-5', client });
  for await (const _ of provider.streamPatch({ node: {}, instruction: 'x' })) { /* drain */ }
  assert.equal(client.lastStream.params.model, 'claude-haiku-4-5');
});

test('uses default model when none provided', async () => {
  const events = [
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'emit_patch' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"reason":"r"}' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_stop' },
  ];
  const client = makeFakeClient(events);
  const provider = createAnthropicProvider({ apiKey: 'sk-ant-x', client });
  for await (const _ of provider.streamPatch({ node: {}, instruction: 'x' })) { /* drain */ }
  assert.match(client.lastStream.params.model, /^claude-/);
});

test('emits patch text alongside structured patch', async () => {
  const events = [
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'thinking...' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 't1', name: 'emit_patch' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"reason":"r"}' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_stop' },
  ];
  const provider = createAnthropicProvider({ apiKey: 'sk-ant-x', client: makeFakeClient(events) });
  const out = [];
  for await (const ev of provider.streamPatch({ node: {}, instruction: 'x' })) out.push(ev);
  const patchEv = out.find((e) => e.type === 'patch');
  assert.equal(patchEv.text, 'thinking...');
});

test('api key never appears in emitted events', async () => {
  const events = [
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'emit_patch' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"reason":"r"}' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_stop' },
  ];
  const provider = createAnthropicProvider({ apiKey: 'sk-ant-secret-test-1234567890', client: makeFakeClient(events) });
  const out = [];
  for await (const ev of provider.streamPatch({ node: {}, instruction: 'x' })) out.push(ev);
  const serialized = JSON.stringify(out);
  assert.doesNotMatch(serialized, /sk-ant-secret/);
});

test('forwards AbortSignal to SDK call', async () => {
  const events = [
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'emit_patch' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"reason":"r"}' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_stop' },
  ];
  const client = makeFakeClient(events);
  const provider = createAnthropicProvider({ apiKey: 'sk-ant-x', client });
  const ctrl = new AbortController();
  for await (const _ of provider.streamPatch({ node: {}, instruction: 'x', signal: ctrl.signal })) { /* drain */ }
  assert.equal(client.lastStream.opts.signal, ctrl.signal);
});

test('text-only response (no tool_use) is treated as missing patch', async () => {
  const events = [
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'I cannot do that' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_stop' },
  ];
  const provider = createAnthropicProvider({ apiKey: 'sk-ant-x', client: makeFakeClient(events) });
  const out = [];
  for await (const ev of provider.streamPatch({ node: {}, instruction: 'x' })) out.push(ev);
  const errEv = out.find((e) => e.type === 'error');
  assert.ok(errEv);
});

test('redacts authorization header', () => {
  const redacted = redactMessage("authorization: Bearer sk-ant-abcdef0123456789");
  assert.doesNotMatch(redacted, /sk-ant-abcdef/);
});

test('redactMessage is idempotent on plain messages', () => {
  const plain = 'Something went wrong on the server';
  assert.equal(redactMessage(plain), plain);
});

test('json parsing of multi-delta tool input', async () => {
  const events = [
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'emit_patch' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"reason":' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '"hi' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '"}' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_stop' },
  ];
  const provider = createAnthropicProvider({ apiKey: 'sk-ant-x', client: makeFakeClient(events) });
  const out = [];
  for await (const ev of provider.streamPatch({ node: {}, instruction: 'x' })) out.push(ev);
  const patchEv = out.find((e) => e.type === 'patch');
  assert.ok(patchEv);
  assert.equal(patchEv.patch.reason, 'hi');
});

test('uses default createClient when no client injected', () => {
  // We don't actually instantiate the SDK here; just confirm the error
  // path: no api key means the construction still validates.
  assert.throws(() => createAnthropicProvider({ apiKey: '' }), /Missing Anthropic API key/);
});