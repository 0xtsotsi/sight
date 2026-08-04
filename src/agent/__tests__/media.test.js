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
  buildHiggsfieldProvider,
  probeHiggsfieldAuth,
  selectProviderAsync,
} from '../media.js';

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
  const r = mediaUnavailable({ kind: MEDIA_KIND.IMAGE, reason: 'no token', recoveryCommand: 'higgsfield auth login' });
  assert.equal(r.status, MEDIA_RESULT_STATUS.UNAVAILABLE);
  assert.equal(r.recoveryCommand, 'higgsfield auth login');
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

test('media: buildHiggsfieldProvider refuses to construct without a token', () => {
  assert.throws(() => buildHiggsfieldProvider({}), /token is required/i);
});

test('media: buildHiggsfieldProvider returns a READY provider once a token is supplied', () => {
  const p = buildHiggsfieldProvider({ token: 'present' });
  const a = p.availability();
  assert.equal(a.status, PROVIDER_STATUS.READY);
});

test('media: probeHiggsfieldAuth reports UNAVAILABLE when host is missing', async () => {
  const r = await probeHiggsfieldAuth(null);
  assert.equal(r.status, AUTH_STATUS.UNAVAILABLE);
  assert.equal(r.recoveryCommand, 'higgsfield auth login');
});

test('media: probeHiggsfieldAuth reports UNAVAILABLE when host has no probe verb', async () => {
  const host = { avb: {} };
  const r = await probeHiggsfieldAuth(host);
  assert.equal(r.status, AUTH_STATUS.UNAVAILABLE);
});

test('media: probeHiggsfieldAuth passes through a ready response', async () => {
  const host = { avb: { higgsfieldAuthProbe: async () => ({ status: 'ready', reason: 'ok' }) } };
  const r = await probeHiggsfieldAuth(host);
  assert.equal(r.status, AUTH_STATUS.READY);
  assert.equal(r.reason, 'ok');
});

test('media: probeHiggsfieldAuth recovers from a thrown probe', async () => {
  const host = { avb: { higgsfieldAuthProbe: async () => { throw new Error('boom'); } } };
  const r = await probeHiggsfieldAuth(host);
  assert.equal(r.status, AUTH_STATUS.UNAVAILABLE);
  assert.match(r.reason, /boom/);
});

test('media: selectProviderAsync returns the StubProvider when no token is present', async () => {
  const p = await selectProviderAsync();
  assert.equal(p.name, 'stub');
});

test('media: selectProviderAsync returns a HiggsfieldProvider when the probe reports ready', async () => {
  const orig = globalThis.window;
  globalThis.window = { avb: { higgsfieldAuthProbe: async () => ({ status: 'ready' }) } };
  try {
    const p = await selectProviderAsync();
    assert.equal(p.name, 'higgsfield');
  } finally {
    globalThis.window = orig;
  }
});
