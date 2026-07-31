// Tests for the OpenAI adapter. Uses dependency injection: pass a fake
// `client` to createOpenAIProvider so we never have to mock require.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createOpenAIProvider, redactMessage } from './openai.js';

function makeFakeClient(events, opts = {}) {
  const fake = {
    opts: opts.fakeOpts,
    lastStream: null,
    lastParams: null,
    responses: {
      stream: async (params, signal) => {
        fake.lastStream = { signal };
        fake.lastParams = params;
        if (opts.throwOnStream) throw new Error(opts.throwOnStream);
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

test('passes json_schema structured output format', async () => {
  const events = [
    { type: 'response.output_text.delta', delta: '{"reason":"r"}' },
    { type: 'response.completed' },
  ];
  const client = makeFakeClient(events);
  const provider = createOpenAIProvider({ apiKey: 'sk-test', client });
  for await (const _ of provider.streamPatch({ node: {}, instruction: 'x' })) { /* drain */ }
  const p = client.lastParams;
  assert.equal(p.text.format.type, 'json_schema');
  assert.equal(p.text.format.strict, true);
  assert.equal(p.text.format.name, 'ai_patch');
  assert.equal(p.text.format.schema.type, 'object');
});

test('reassembles text deltas', async () => {
  const events = [
    { type: 'response.output_text.delta', delta: '{"reason":' },
    { type: 'response.output_text.delta', delta: '"split"}' },
    { type: 'response.completed' },
  ];
  const provider = createOpenAIProvider({ apiKey: 'sk-test', client: makeFakeClient(events) });
  const out = [];
  for await (const ev of provider.streamPatch({ node: {}, instruction: 'x' })) out.push(ev);
  const patchEv = out.find((e) => e.type === 'patch');
  assert.ok(patchEv);
  assert.equal(patchEv.patch.reason, 'split');
});

test('malformed JSON becomes a clean error', async () => {
  const events = [
    { type: 'response.output_text.delta', delta: 'this is not json' },
    { type: 'response.completed' },
  ];
  const provider = createOpenAIProvider({ apiKey: 'sk-test', client: makeFakeClient(events) });
  const out = [];
  for await (const ev of provider.streamPatch({ node: {}, instruction: 'x' })) out.push(ev);
  const errEv = out.find((e) => e.type === 'error');
  assert.ok(errEv);
  assert.match(errEv.message, /malformed JSON/);
});

test('network errors surface as a clean error', async () => {
  const provider = createOpenAIProvider({
    apiKey: 'sk-test',
    client: makeFakeClient([], { throwOnStream: 'connect ECONNREFUSED' }),
  });
  const out = [];
  for await (const ev of provider.streamPatch({ node: {}, instruction: 'x' })) out.push(ev);
  const errEv = out.find((e) => e.type === 'error');
  assert.ok(errEv);
  assert.match(errEv.message, /ECONNREFUSED/);
});

test('empty stream becomes "did not return a structured patch"', async () => {
  const provider = createOpenAIProvider({
    apiKey: 'sk-test',
    client: makeFakeClient([{ type: 'response.completed' }]),
  });
  const out = [];
  for await (const ev of provider.streamPatch({ node: {}, instruction: 'x' })) out.push(ev);
  const errEv = out.find((e) => e.type === 'error');
  assert.ok(errEv);
  assert.match(errEv.message, /did not return a structured patch/);
});

test('response.error event becomes error event', async () => {
  const events = [{ type: 'response.error', message: 'rate limit exceeded' }];
  const provider = createOpenAIProvider({ apiKey: 'sk-test', client: makeFakeClient(events) });
  const out = [];
  for await (const ev of provider.streamPatch({ node: {}, instruction: 'x' })) out.push(ev);
  const errEv = out.find((e) => e.type === 'error');
  assert.ok(errEv);
  assert.match(errEv.message, /rate limit/);
});

test('response.failed event surfaces underlying error', async () => {
  const events = [
    { type: 'response.failed', response: { error: { message: 'context too long' } } },
  ];
  const provider = createOpenAIProvider({ apiKey: 'sk-test', client: makeFakeClient(events) });
  const out = [];
  for await (const ev of provider.streamPatch({ node: {}, instruction: 'x' })) out.push(ev);
  const errEv = out.find((e) => e.type === 'error');
  assert.ok(errEv);
  assert.match(errEv.message, /context too long/);
});

test('throws on missing api key', () => {
  assert.throws(() => createOpenAIProvider({}), /Missing OpenAI API key/);
});

test('redacts sk- keys', () => {
  const r = redactMessage('bad token: sk-abc123def456ghi789jkl012mno');
  assert.match(r, /\[REDACTED\]/);
  assert.doesNotMatch(r, /sk-abc123def456/);
});

test('redacts Authorization Bearer', () => {
  const r = redactMessage("Authorization: Bearer sk-abc123def456ghi789");
  assert.doesNotMatch(r, /sk-abc123/);
});

test('passes model override', async () => {
  const events = [{ type: 'response.output_text.delta', delta: '{"reason":"r"}' }];
  const client = makeFakeClient(events);
  const provider = createOpenAIProvider({ apiKey: 'sk-test', model: 'gpt-4o-mini', client });
  for await (const _ of provider.streamPatch({ node: {}, instruction: 'x' })) { /* drain */ }
  assert.equal(client.lastParams.model, 'gpt-4o-mini');
});

test('passes baseURL override through createClient', async () => {
  const events = [{ type: 'response.output_text.delta', delta: '{"reason":"r"}' }];
  let captured;
  const provider = createOpenAIProvider({
    apiKey: 'sk-test',
    baseURL: 'https://my-proxy.example.com/v1',
    _createClient: (apiKey, baseURL) => {
      captured = { apiKey, baseURL };
      return makeFakeClient(events);
    },
  });
  for await (const _ of provider.streamPatch({ node: {}, instruction: 'x' })) { /* drain */ }
  assert.equal(captured.baseURL, 'https://my-proxy.example.com/v1');
  assert.equal(captured.apiKey, 'sk-test');
});

test('includes history before latest user message', async () => {
  const events = [{ type: 'response.output_text.delta', delta: '{"reason":"r"}' }];
  const client = makeFakeClient(events);
  const provider = createOpenAIProvider({ apiKey: 'sk-test', client });
  for await (const _ of provider.streamPatch({
    node: {},
    instruction: 'go',
    history: [{ role: 'user', content: 'first' }, { role: 'assistant', content: 'ok' }],
  })) { /* drain */ }
  assert.equal(client.lastParams.input.length, 3);
  assert.equal(client.lastParams.input[0].role, 'user');
  assert.equal(client.lastParams.input[1].role, 'assistant');
  assert.equal(client.lastParams.input[2].role, 'user');
});

test('emits terminal done event', async () => {
  const events = [{ type: 'response.output_text.delta', delta: '{"reason":"r"}' }];
  const provider = createOpenAIProvider({ apiKey: 'sk-test', client: makeFakeClient(events) });
  const out = [];
  for await (const ev of provider.streamPatch({ node: {}, instruction: 'x' })) out.push(ev);
  assert.equal(out[out.length - 1].type, 'done');
});

test('api key never appears in any emitted event', async () => {
  const events = [{ type: 'response.output_text.delta', delta: '{"reason":"r"}' }];
  const provider = createOpenAIProvider({
    apiKey: 'sk-test-secret-1234567890abcdef',
    client: makeFakeClient(events),
  });
  const out = [];
  for await (const ev of provider.streamPatch({ node: {}, instruction: 'x' })) out.push(ev);
  const json = JSON.stringify(out);
  assert.doesNotMatch(json, /sk-test-secret/);
});

test('forwards AbortSignal', async () => {
  const events = [{ type: 'response.output_text.delta', delta: '{"reason":"r"}' }];
  const client = makeFakeClient(events);
  const provider = createOpenAIProvider({ apiKey: 'sk-test', client });
  const ctrl = new AbortController();
  for await (const _ of provider.streamPatch({ node: {}, instruction: 'x', signal: ctrl.signal })) { /* drain */ }
  assert.equal(client.lastStream.signal.signal, ctrl.signal);
});

test('redactMessage plain text is idempotent', () => {
  assert.equal(redactMessage('hi there'), 'hi there');
});

test('api_key header redaction', () => {
  const r = redactMessage("api_key=sk-abc123def456ghi789jkl012mno");
  assert.doesNotMatch(r, /sk-abc123/);
});

test('history with invalid entries is skipped', async () => {
  const events = [{ type: 'response.output_text.delta', delta: '{"reason":"r"}' }];
  const client = makeFakeClient(events);
  const provider = createOpenAIProvider({ apiKey: 'sk-test', client });
  for await (const _ of provider.streamPatch({
    node: {},
    instruction: 'go',
    history: [null, {}, { role: 'user' }, { role: 'invalid', content: 'x' }],
  })) { /* drain */ }
  // Only the "go" user message remains — all invalid entries are skipped.
  assert.equal(client.lastParams.input.length, 1);
});

test('patch event includes text', async () => {
  const events = [{ type: 'response.output_text.delta', delta: '{"reason":"r"}' }];
  const provider = createOpenAIProvider({ apiKey: 'sk-test', client: makeFakeClient(events) });
  const out = [];
  for await (const ev of provider.streamPatch({ node: {}, instruction: 'x' })) out.push(ev);
  const patchEv = out.find((e) => e.type === 'patch');
  assert.equal(patchEv.text, '{"reason":"r"}');
});

test('history assistant role is preserved as assistant', async () => {
  const events = [{ type: 'response.output_text.delta', delta: '{"reason":"r"}' }];
  const client = makeFakeClient(events);
  const provider = createOpenAIProvider({ apiKey: 'sk-test', client });
  for await (const _ of provider.streamPatch({
    node: {},
    instruction: 'go',
    history: [{ role: 'system', content: 'be brief' }, { role: 'user', content: 'hi' }],
  })) { /* drain */ }
  // system gets coerced to user (the documented behavior).
  assert.equal(client.lastParams.input[0].role, 'user');
  assert.equal(client.lastParams.input[1].role, 'user');
});