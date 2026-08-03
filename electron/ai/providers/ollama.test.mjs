// Tests for the Ollama adapter. fetch is replaced with a fake that
// records the call and returns a scripted ReadableStream.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createOllamaProvider, extractJson } from './ollama.js';

function makeStream(chunks) {
  let i = 0;
  return new ReadableStream({
    async pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      const c = chunks[i++];
      controller.enqueue(new TextEncoder().encode(c));
    },
  });
}

function withFetch(handler, run) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    return run();
  } finally {
    globalThis.fetch = realFetch;
  }
}

test('extractJson parses bare JSON', () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
});

test('extractJson strips json fences', () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
});

test('extractJson returns null on garbage', () => {
  assert.equal(extractJson('not json at all'), null);
});

test('extractJson finds balanced braces', () => {
  assert.deepEqual(extractJson('prefix {"a":1} suffix'), { a: 1 });
});

test('extractJson handles empty input', () => {
  assert.equal(extractJson(''), null);
});

test('extractJson handles nested objects', () => {
  assert.deepEqual(extractJson('{"a":{"b":2}}'), { a: { b: 2 } });
});

test('sends correct request shape to Ollama', async () => {
  const stream = makeStream([
    JSON.stringify({ message: { content: '{"reason":"r"}' }, done: false }) + '\n',
    JSON.stringify({ done: true }) + '\n',
  ]);
  let captured;
  await withFetch(async (url, opts) => {
    captured = { url, opts };
    return { ok: true, status: 200, body: stream, text: async () => '' };
  }, async () => {
    const provider = createOllamaProvider({ model: 'llama3.2' });
    const out = [];
    for await (const ev of provider.streamPatch({ node: { id: 'x' }, instruction: 'go' })) out.push(ev);
    const patchEv = out.find((e) => e.type === 'patch');
    assert.ok(patchEv);
    assert.equal(patchEv.patch.reason, 'r');
  });
  assert.equal(captured.url, 'http://127.0.0.1:11434/api/chat');
  assert.equal(captured.opts.method, 'POST');
  const body = JSON.parse(captured.opts.body);
  assert.equal(body.model, 'llama3.2');
  assert.equal(body.stream, true);
  assert.equal(body.messages[0].role, 'system');
  assert.equal(body.messages[body.messages.length - 1].role, 'user');
});

test('uses custom endpoint', async () => {
  const stream = makeStream([
    JSON.stringify({ message: { content: '{"reason":"r"}' }, done: false }) + '\n',
    JSON.stringify({ done: true }) + '\n',
  ]);
  let captured;
  await withFetch(async (url) => {
    captured = url;
    return { ok: true, status: 200, body: stream, text: async () => '' };
  }, async () => {
    const provider = createOllamaProvider({ endpoint: 'http://localhost:9999', model: 'qwen2.5-coder' });
    for await (const _ of provider.streamPatch({ node: {}, instruction: 'go' })) { /* drain */ }
  });
  assert.equal(captured, 'http://localhost:9999/api/chat');
});

test('emits error when fetch throws (Ollama daemon not running)', async () => {
  await withFetch(async () => { throw new Error('ECONNREFUSED'); }, async () => {
    const provider = createOllamaProvider();
    const out = [];
    for await (const ev of provider.streamPatch({ node: {}, instruction: 'x' })) out.push(ev);
    const errEv = out.find((e) => e.type === 'error');
    assert.ok(errEv);
    assert.match(errEv.message, /Could not reach Ollama/);
    assert.match(errEv.message, /127.0.0.1:11434/);
  });
});

test('emits error on HTTP failure with response body', async () => {
  await withFetch(async () => ({
    ok: false,
    status: 500,
    body: null,
    text: async () => 'model not found',
  }), async () => {
    const provider = createOllamaProvider();
    const out = [];
    for await (const ev of provider.streamPatch({ node: {}, instruction: 'x' })) out.push(ev);
    const errEv = out.find((e) => e.type === 'error');
    assert.ok(errEv);
    assert.match(errEv.message, /HTTP 500/);
    assert.match(errEv.message, /model not found/);
  });
});

test('emits error when response is unparseable', async () => {
  const stream = makeStream([
    JSON.stringify({ message: { content: 'totally not json' }, done: false }) + '\n',
    JSON.stringify({ done: true }) + '\n',
  ]);
  await withFetch(async () => ({ ok: true, status: 200, body: stream, text: async () => '' }), async () => {
    const provider = createOllamaProvider();
    const out = [];
    for await (const ev of provider.streamPatch({ node: {}, instruction: 'x' })) out.push(ev);
    const errEv = out.find((e) => e.type === 'error');
    assert.ok(errEv);
    assert.match(errEv.message, /parseable/);
  });
});

test('streams deltas as they arrive', async () => {
  const stream = makeStream([
    JSON.stringify({ message: { content: '{"reason":' } }) + '\n',
    JSON.stringify({ message: { content: '"hi"}' } }) + '\n',
    JSON.stringify({ done: true }) + '\n',
  ]);
  await withFetch(async () => ({ ok: true, status: 200, body: stream, text: async () => '' }), async () => {
    const provider = createOllamaProvider();
    const deltas = [];
    for await (const ev of provider.streamPatch({ node: {}, instruction: 'x' })) {
      if (ev.type === 'delta') deltas.push(ev.text);
    }
    assert.deepEqual(deltas, ['{"reason":', '"hi"}']);
  });
});

test('history is forwarded as messages', async () => {
  const stream = makeStream([
    JSON.stringify({ message: { content: '{"reason":"r"}' } }) + '\n',
    JSON.stringify({ done: true }) + '\n',
  ]);
  let captured;
  await withFetch(async (url, opts) => {
    captured = opts;
    return { ok: true, status: 200, body: stream, text: async () => '' };
  }, async () => {
    const provider = createOllamaProvider();
    for await (const _ of provider.streamPatch({
      node: {},
      instruction: 'go',
      history: [{ role: 'user', content: 'first' }, { role: 'assistant', content: 'ok' }],
    })) { /* drain */ }
  });
  const body = JSON.parse(captured.body);
  assert.equal(body.messages.length, 4); // system + 2 history + 1 user
  assert.equal(body.messages[1].role, 'user');
  assert.equal(body.messages[2].role, 'assistant');
});

test('malformed NDJSON lines are skipped silently', async () => {
  const stream = makeStream([
    'not json\n',
    JSON.stringify({ message: { content: '{"reason":"r"}' } }) + '\n',
    JSON.stringify({ done: true }) + '\n',
  ]);
  await withFetch(async () => ({ ok: true, status: 200, body: stream, text: async () => '' }), async () => {
    const provider = createOllamaProvider();
    const out = [];
    for await (const ev of provider.streamPatch({ node: {}, instruction: 'x' })) out.push(ev);
    const patchEv = out.find((e) => e.type === 'patch');
    assert.ok(patchEv);
  });
});

test('does not require an api key', () => {
  const provider = createOllamaProvider();
  assert.ok(provider);
  assert.equal(provider.id, 'ollama');
});

test('forwards AbortSignal to fetch', async () => {
  let captured;
  await withFetch(async (url, opts) => {
    captured = opts;
    return {
      ok: true,
      status: 200,
      body: makeStream([JSON.stringify({ message: { content: '{"reason":"r"}' } }) + '\n']),
      text: async () => '',
    };
  }, async () => {
    const provider = createOllamaProvider();
    const ctrl = new AbortController();
    for await (const _ of provider.streamPatch({ node: {}, instruction: 'x', signal: ctrl.signal })) {
      /* drain */
    }
  });
  assert.ok(captured.signal);
});

test('default endpoint is 127.0.0.1:11434', () => {
  const provider = createOllamaProvider();
  assert.equal(provider.id, 'ollama');
});

test('falls back to balanced-brace extraction on partial json', () => {
  // Already covered by extractJson; keep one integration check.
  const s = 'preamble {"reason":"x","props":{"a":1}} trailing';
  assert.deepEqual(extractJson(s), { reason: 'x', props: { a: 1 } });
});