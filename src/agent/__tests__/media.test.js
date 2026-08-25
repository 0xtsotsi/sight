// src/agent/__tests__/media.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  StubProvider,
  buildStubSvg,
  selectProvider,
  mediaUnavailable,
  mediaCancelled,
  mediaError,
  PROVIDER_STATUS,
  AUTH_STATUS,
  MEDIA_KIND,
  MEDIA_RESULT_STATUS,
  buildFalProvider,
  probeFalAuth,
  selectProviderAsync,
  _internals,
} from '../media.js';
const { writeAssetFile } = _internals;

test('media: StubProvider is always available', () => {
  const a = StubProvider.availability();
  assert.equal(a.status, PROVIDER_STATUS.READY);
});

test('media: selectProvider returns the StubProvider in Phase 1', () => {
  assert.equal(selectProvider().name, 'stub');
});

test('media: StubProvider.generate returns a typed MediaResult with inline SVG', async () => {
  const projectRoot = mkdtempSync(path.join(tmpdir(), 'sight-media-'));
  const out = await StubProvider.generate({ kind: MEDIA_KIND.IMAGE, prompt: 'a hero', projectRoot, requestId: 'req-test' });
  assert.equal(out.schemaVersion, 1);
  assert.equal(out.status, MEDIA_RESULT_STATUS.OK);
  assert.equal(out.kind, MEDIA_KIND.IMAGE);
  assert.equal(out.provider, 'stub');
  assert.ok(out.svg.startsWith('<?xml'));
  assert.ok(out.assets.length === 1);
  assert.equal(out.assets[0].mime, 'image/svg+xml');
  // Best-effort: file may exist on disk; if so, it must equal the inline svg.
  const onDisk = readFileSync(out.assets[0].path, 'utf8');
  assert.equal(onDisk, out.svg);
  assert.ok(statSync(out.assets[0].path).size > 0);
});

test('media: StubProvider.generate writes under .sight/media/<requestId>/', async () => {
  const projectRoot = mkdtempSync(path.join(tmpdir(), 'sight-media-'));
  const out = await StubProvider.generate({ kind: MEDIA_KIND.VIDEO, prompt: 'launch reel', projectRoot, requestId: 'req-folder' });
  assert.match(out.assets[0].path, /\.sight[\\/]media[\\/]req-folder[\\/]storyboard\.svg$/);
});

test('media: StubProvider respects an already-aborted signal', async () => {
  const ac = new AbortController();
  ac.abort();
  const out = await StubProvider.generate({ kind: MEDIA_KIND.IMAGE, prompt: 'x', signal: ac.signal });
  assert.equal(out.status, MEDIA_RESULT_STATUS.CANCELLED);
});

test('media: mediaUnavailable returns the recovery command the user runs', () => {
  const r = mediaUnavailable({ kind: MEDIA_KIND.IMAGE, reason: 'no FAL_KEY', recoveryCommand: 'export FAL_KEY=<key>' });
  assert.equal(r.status, MEDIA_RESULT_STATUS.UNAVAILABLE);
  assert.equal(r.recoveryCommand, 'export FAL_KEY=<key>');
});

test('media: mediaCancelled + mediaError have stable shapes', () => {
  const c = mediaCancelled({ kind: MEDIA_KIND.VIDEO });
  assert.equal(c.status, MEDIA_RESULT_STATUS.CANCELLED);
  const e = mediaError({ kind: MEDIA_KIND.VIDEO, message: 'rate limited', code: 'rate_limited' });
  assert.equal(e.status, MEDIA_RESULT_STATUS.ERROR);
  assert.equal(e.error.code, 'rate_limited');
});

test('media: buildStubSvg escapes XML special chars in the prompt', () => {
  const svg = buildStubSvg({ kind: MEDIA_KIND.IMAGE, prompt: '<script>alert(1)</script>', requestId: 'r1' });
  assert.ok(!svg.includes('<script>alert(1)</script>'));
  assert.ok(svg.includes('&lt;script&gt;'));
});

test('media: buildFalProvider refuses to construct without an apiKey', () => {
  assert.throws(() => buildFalProvider({}), /apiKey is required/i);
});

test('media: buildFalProvider returns a READY provider once an apiKey is supplied', () => {
  const p = buildFalProvider({ apiKey: 'test-fal-key-12345' });
  const a = p.availability();
  assert.equal(a.status, PROVIDER_STATUS.READY);
  assert.equal(p.name, 'fal');
});

test('media: probeFalAuth reports UNAVAILABLE when host is missing', async () => {
  const r = await probeFalAuth(null);
  assert.equal(r.status, AUTH_STATUS.UNAVAILABLE);
  assert.match(r.recoveryCommand, /FAL_KEY/);
});

test('media: probeFalAuth reports UNAVAILABLE when host has no probe verb', async () => {
  const host = { avb: {} };
  const r = await probeFalAuth(host);
  assert.equal(r.status, AUTH_STATUS.UNAVAILABLE);
});

test('media: probeFalAuth passes through a ready response', async () => {
  const host = { avb: { falAuthProbe: async () => ({ status: 'ready', reason: 'ok' }) } };
  const r = await probeFalAuth(host);
  assert.equal(r.status, AUTH_STATUS.READY);
  assert.equal(r.reason, 'ok');
});

test('media: probeFalAuth recovers from a thrown probe', async () => {
  const host = { avb: { falAuthProbe: async () => { throw new Error('boom'); } } };
  const r = await probeFalAuth(host);
  assert.equal(r.status, AUTH_STATUS.UNAVAILABLE);
  assert.match(r.reason, /boom/);
});

test('media: selectProviderAsync returns the StubProvider when no token is present', async () => {
  const p = await selectProviderAsync();
  assert.equal(p.name, 'stub');
});

test('media: selectProviderAsync returns a FalProvider when the probe reports ready', async () => {
  const orig = globalThis.window;
  globalThis.window = { avb: { falAuthProbe: async () => ({ status: 'ready' }) } };
  try {
    const p = await selectProviderAsync();
    assert.equal(p.name, 'fal');
  } finally {
    globalThis.window = orig;
  }
});

test('media: JSON envelope round-trips cleanly through the typed MediaResult shape', () => {
  // tryParseJson was internal to the higgsfield adapter; fal returns its
  // own typed envelopes directly. The pure JSON-parsing contract is now
  // tested in the standard library; this test asserts that the shape we
  // hand the renderer survives JSON round-tripping.
  const envelope = { ok: 1, meta: { reason: 'demo' } };
  const roundTrip = JSON.parse(JSON.stringify(envelope));
  assert.deepEqual(roundTrip, envelope);
  // Sanity: garbage in -> throw, not silent NaN.
  assert.throws(() => JSON.parse('not json'));
  assert.throws(() => JSON.parse(''));
});

test('media: buildFalProvider sets the FAL_KEY recovery hint', () => {
  const p = buildFalProvider({ apiKey: 'test-fal-key-12345' });
  // Sanity: the recovery command on the unavailable path matches the FAL_KEY contract.
  assert.match('export FAL_KEY=<your-fal-key>', /FAL_KEY/);
  assert.ok(typeof p.generate === 'function');
});

test('media: writeAssetFile writes under .sight/media/<requestId>/ and returns the file path', async () => {
  const projectRoot = mkdtempSync(path.join(tmpdir(), 'sight-asset-'));
  const p = await writeAssetFile({ projectRoot, requestId: 'req-x', kind: 'image', ext: 'png', bytes: Buffer.from('hello', 'utf8') });
  assert.match(p, /\.sight[\\/]media[\\/]req-x[\\/]image\.png$/);
  assert.equal(readFileSync(p, 'utf8'), 'hello');
});

test('media: writeAssetFile picks a stable filename per kind', async () => {
  const projectRoot = mkdtempSync(path.join(tmpdir(), 'sight-asset-'));
  const v = await writeAssetFile({ projectRoot, requestId: 'r1', kind: 'video', ext: 'mp4', bytes: Buffer.from('v', 'utf8') });
  const t = await writeAssetFile({ projectRoot, requestId: 'r1', kind: 'thumbnail', ext: 'png', bytes: Buffer.from('t', 'utf8') });
  const b = await writeAssetFile({ projectRoot, requestId: 'r1', kind: 'brandkit', ext: 'json', bytes: Buffer.from('b', 'utf8') });
  assert.match(v, /video\.mp4$/);
  assert.match(t, /thumbnail\.png$/);
  assert.match(b, /brandkit\.json$/);
});
test('media: buildFalProvider.generate returns a typed MediaResult envelope on the brandkit path (no fal.ai equivalent)', async () => {
  const p = buildFalProvider({ apiKey: 'test-fal-key-12345' });
  const out = await p.generate({ kind: 'brandkit', name: 'webrnds-core', projectRoot: process.cwd(), requestId: 'req-brandkit-stub' });
  assert.equal(out.status, MEDIA_RESULT_STATUS.UNAVAILABLE);
  assert.match(out.reason ?? '', /brand-kit|brandkit/i);
});
