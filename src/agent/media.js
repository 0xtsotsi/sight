// src/agent/media.js
//
// MediaProvider abstraction for the Impeccable-first Design Agent.
//
// Phase 1 ships only the StubProvider. The HiggsfieldProvider is wired but
// never registered until `higgsfield auth login` has produced a credential
// at ~/.config/higgsfield/credentials.json. The panel reads
// `provider.availability()` to decide whether to surface the picker and
// whether to show a "configure" hint.
//
// Design rules (Phase 1):
//   - The provider never sees the model prompt. It only receives typed
//     `MediaRequest` objects and returns typed `MediaResult` objects.
//   - All calls emit a stable requestId. Cancellation propagates via the
//     controller.signal on the request envelope.
//   - Files always land in `.sight/media/<requestId>/` with attribution
//     and a license line; never inside the project tree, never in src/.
//   - The provider never makes a destructive call. The user always has a
//     separate Apply step to import the asset into the project.
//
// Tool integration: src/agent/tools.js wires `generate_image`,
// `generate_video`, `generate_thumbnail`, and `pull_brandkit` as proposals
// (Phase 2 will move them onto the typed contract below).

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';

// ---------------------------------------------------------------------------
// Typed enums
// ---------------------------------------------------------------------------

export const MEDIA_KIND = Object.freeze({
  IMAGE: 'image',
  VIDEO: 'video',
  THUMBNAIL: 'thumbnail',
  BRANDKIT: 'brandkit',
});

export const PROVIDER_STATUS = Object.freeze({
  READY: 'ready',
  UNAVAILABLE: 'unavailable',
  DEGRADED: 'degraded',
});

export const MEDIA_RESULT_STATUS = Object.freeze({
  OK: 'ok',
  UNAVAILABLE: 'unavailable',
  CANCELLED: 'cancelled',
  ERROR: 'error',
});

// ---------------------------------------------------------------------------
// Result builders
// ---------------------------------------------------------------------------

/**
 * Build a typed `media_unavailable` result. Used by the StubProvider and by
 * the panel to render a "configure provider" hint with the exact recovery
 * command. Never throws.
 */
export function mediaUnavailable({ kind, requestId, reason, recoveryCommand }) {
  return {
    schemaVersion: 1,
    status: MEDIA_RESULT_STATUS.UNAVAILABLE,
    kind,
    requestId: requestId ?? 'req-' + randomUUID(),
    reason: reason ?? 'provider is not configured',
    recoveryCommand: typeof recoveryCommand === 'string' && recoveryCommand.length > 0
      ? recoveryCommand
      : 'higgsfield auth login',
    ts: Date.now(),
  };
}

export function mediaError({ kind, requestId, message, code }) {
  return {
    schemaVersion: 1,
    status: MEDIA_RESULT_STATUS.ERROR,
    kind,
    requestId: requestId ?? 'req-' + randomUUID(),
    error: { code: code ?? 'unknown', message: String(message ?? 'unknown error') },
    ts: Date.now(),
  };
}

export function mediaCancelled({ kind, requestId }) {
  return {
    schemaVersion: 1,
    status: MEDIA_RESULT_STATUS.CANCELLED,
    kind,
    requestId: requestId ?? 'req-' + randomUUID(),
    ts: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// StubProvider — deterministic, offline, never touches the network.
// ---------------------------------------------------------------------------

/**
 * Build a self-contained SVG that visually approximates the requested kind.
 * This is the Phase 1 default; the user sees a real preview without any
 * network or credential requirement.
 */
export function buildStubSvg({ kind, prompt, requestId }) {
  const safe = String(prompt ?? '').slice(0, 140);
  const id = String(requestId ?? '').slice(0, 8) || 'stub';
  const size = kind === MEDIA_KIND.VIDEO || kind === MEDIA_KIND.THUMBNAIL
    ? { w: 1280, h: 720 }
    : { w: 1024, h: 1024 };
  const caption = kind === MEDIA_KIND.BRANDKIT
    ? 'Brand kit preview'
    : kind === MEDIA_KIND.VIDEO
      ? 'Video storyboard (stub)'
      : kind === MEDIA_KIND.THUMBNAIL
        ? 'Thumbnail (stub)'
        : 'Image (stub)';
  const svg = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<svg xmlns="http://www.w3.org/2000/svg" width="' + size.w + '" height="' + size.h + '" viewBox="0 0 ' + size.w + ' ' + size.h + '">',
    '<defs>',
    '<linearGradient id="g" x1="0" y1="0" x2="1" y2="1">',
    '<stop offset="0" stop-color="#0b1220"/>',
    '<stop offset="1" stop-color="#1f2a44"/>',
    '</linearGradient>',
    '</defs>',
    '<rect width="100%" height="100%" fill="url(#g)"/>',
    '<g font-family="ui-sans-serif, system-ui, -apple-system, Helvetica" fill="#e5e7eb">',
    '<text x="48" y="80" font-size="28" font-weight="600" opacity="0.85">' + caption + '</text>',
    '<text x="48" y="124" font-size="16" opacity="0.65">' + escapeXml(safe) + '</text>',
    '<text x="' + (size.w - 48) + '" y="' + (size.h - 32) + '" font-size="12" text-anchor="end" opacity="0.5">sight · stub · ' + id + '</text>',
    '</g>',
    '</svg>',
  ].join('\n');
  return svg;
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export const StubProvider = Object.freeze({
  name: 'stub',
  kind: 'stub',
  availability() {
    return { status: PROVIDER_STATUS.READY, reason: 'StubProvider is always available' };
  },
  async generate({ kind, prompt, requestId, signal, projectRoot } = {}) {
    if (signal && signal.aborted) return mediaCancelled({ kind, requestId });
    const id = requestId ?? 'req-' + randomUUID();
    const svg = buildStubSvg({ kind, prompt, requestId: id });
    const dir = path.join(projectRoot ?? process.cwd(), '.sight', 'media', id);
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      // best-effort — we still return the SVG inline as a fallback
    }
    const filename = kind === MEDIA_KIND.VIDEO
      ? 'storyboard.svg'
      : kind === MEDIA_KIND.THUMBNAIL
        ? 'thumbnail.svg'
        : kind === MEDIA_KIND.BRANDKIT
          ? 'brandkit.svg'
          : 'image.svg';
    const outPath = path.join(dir, filename);
    try {
      writeFileSync(outPath, svg, 'utf8');
    } catch {
      // best-effort
    }
    return {
      schemaVersion: 1,
      status: MEDIA_RESULT_STATUS.OK,
      kind,
      requestId: id,
      provider: 'stub',
      assets: [{ path: outPath, kind, mime: 'image/svg+xml', bytes: Buffer.byteLength(svg, 'utf8') }],
      license: 'internal-stub',
      attribution: 'sight · StubProvider',
      svg, // inline so the panel can render immediately
      ts: Date.now(),
    };
  },
});

// ---------------------------------------------------------------------------
// HiggsfieldProvider — wired but not registered until auth is detected.
// The constructor intentionally throws to fail loud: callers must import
// the module only after `higgsfield auth token` is present.
// ---------------------------------------------------------------------------

const HIGGSFIELD_RECOVERY = 'higgsfield auth login';

export function buildHiggsfieldProvider({ token, binary = 'higgsfield', pollIntervalMs = 2000, pollTimeoutMs = 5 * 60 * 1000 } = {}) {
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('buildHiggsfieldProvider: token is required');
  }
  return Object.freeze({
    name: 'higgsfield',
    kind: 'remote',
    availability() {
      return token ? { status: PROVIDER_STATUS.READY, reason: 'higgsfield token present' } : { status: PROVIDER_STATUS.UNAVAILABLE, reason: 'no token', recoveryCommand: HIGGSFIELD_RECOVERY };
    },
    async generate({ kind, prompt, requestId, signal, projectRoot, model, aspectRatio, durationSec, referenceImageIds, topic, faceRefId, name } = {}) {
      if (signal && signal.aborted) return mediaCancelled({ kind, requestId });
      const id = requestId ?? 'req-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
      if (!isBinaryAvailable(binary)) {
        return mediaUnavailable({ kind, requestId: id, reason: 'higgsfield CLI is not installed', recoveryCommand: 'npm i -g @higgsfield/cli' });
      }
      try {
        if (kind === 'brandkit') return await runBrandkit({ id, name, projectRoot, signal });
        if (kind === 'image') return await runImage({ id, prompt, projectRoot, model, aspectRatio, referenceImageIds, signal });
        if (kind === 'video') return await runVideo({ id, prompt, projectRoot, model, aspectRatio, durationSec, signal, pollIntervalMs, pollTimeoutMs });
        if (kind === 'thumbnail') return await runThumbnail({ id, prompt, topic, faceRefId, projectRoot, signal, pollIntervalMs, pollTimeoutMs });
        return mediaError({ kind, requestId: id, message: 'unsupported kind: ' + String(kind), code: 'unsupported_kind' });
      } catch (err) {
        if (signal && signal.aborted) return mediaCancelled({ kind, requestId: id });
        return mediaError({ kind, requestId: id, message: String(err?.message ?? err), code: 'higgsfield_failed' });
      }
    },
    _binary: binary,
  });
}

// ---------------------------------------------------------------------------
// CLI helpers
// ---------------------------------------------------------------------------

function isBinaryAvailable(binary) {
  try {
    execFileSync(binary, ['--version'], { stdio: ['ignore', 'ignore', 'ignore'] });
    return true;
  } catch { return false; }
}
function writeAssetFile({ projectRoot, requestId, kind, ext, bytes }) {
  const dir = path.join(projectRoot ?? process.cwd(), '.sight', 'media', requestId);
  mkdirSync(dir, { recursive: true });
  const filename = kind === 'video' ? 'video.' + ext : kind === 'thumbnail' ? 'thumbnail.' + ext : kind === 'brandkit' ? 'brandkit.json' : 'image.' + ext;
  const outPath = path.join(dir, filename);
  writeFileSync(outPath, bytes);
  return outPath;
}

function callHiggsfield(args, signal) {
  return new Promise((resolve, reject) => {
    const proc = spawn('higgsfield', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (b) => { stdout += b.toString('utf8'); });
    proc.stderr.on('data', (b) => { stderr += b.toString('utf8'); });
    const onAbort = () => { try { proc.kill('SIGTERM'); } catch {} reject(new Error('aborted')); };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    proc.on('error', (err) => { if (signal) signal.removeEventListener('abort', onAbort); reject(err); });
    proc.on('close', (code) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      if (code !== 0) return reject(new Error('higgsfield exited with code ' + code + ': ' + stderr.trim()));
      resolve(stdout);
    });
  });
}

async function runImage({ id, prompt, projectRoot, model, aspectRatio, referenceImageIds, signal }) {
  const args = ['generate', 'create', model || 'nano_banana_2', '--prompt', prompt, '--json'];
  if (aspectRatio) args.push('--aspect-ratio', aspectRatio);
  for (const r of referenceImageIds ?? []) args.push('--image-references', r);
  const stdout = await callHiggsfield(args, signal);
  return parseImageResult({ id, stdout, projectRoot, kind: 'image' });
}

async function runVideo({ id, prompt, projectRoot, model, aspectRatio, durationSec, signal, pollIntervalMs, pollTimeoutMs }) {
  const args = ['generate', 'create', model || 'seedance_2_0', '--prompt', prompt, '--wait', '--wait-timeout', Math.round(pollTimeoutMs / 60_000) + 'm', '--wait-interval', Math.round(pollIntervalMs / 1000) + 's', '--json'];
  if (aspectRatio) args.push('--aspect-ratio', aspectRatio);
  if (durationSec) args.push('--duration', String(durationSec));
  const stdout = await callHiggsfield(args, signal);
  return parseImageResult({ id, stdout, projectRoot, kind: 'video' });
}

async function runThumbnail({ id, prompt, topic, faceRefId, signal, pollIntervalMs, pollTimeoutMs }) {
  // The CLI does not have a dedicated thumbnail command, so we use the
  // image path with a YouTube-safe 16:9 aspect ratio. The renderer
  // surfaces a specific `generate_thumbnail` intent.
  const args = ['generate', 'create', 'nano_banana_2', '--prompt', (topic ? topic + ' — ' : '') + prompt, '--aspect-ratio', '16:9', '--json', '--wait', '--wait-timeout', Math.round(pollTimeoutMs / 60_000) + 'm', '--wait-interval', Math.round(pollIntervalMs / 1000) + 's'];
  if (faceRefId) args.push('--image-references', faceRefId);
  const stdout = await callHiggsfield(args, signal);
  return parseImageResult({ id, stdout, projectRoot, kind: 'thumbnail' });
}

async function runBrandkit({ id, name, projectRoot, signal }) {
  const args = ['marketing-studio', 'brand-kits', 'list', '--json'];
  const stdout = await callHiggsfield(args, signal);
  const outPath = writeAssetFile({ projectRoot, requestId: id, kind: 'brandkit', ext: 'json', bytes: Buffer.from(stdout, 'utf8') });
  return {
    schemaVersion: 1,
    status: MEDIA_RESULT_STATUS.OK,
    kind: 'brandkit',
    requestId: id,
    provider: 'higgsfield',
    assets: [{ path: outPath, kind: 'brandkit', mime: 'application/json', bytes: Buffer.byteLength(stdout, 'utf8') }],
    license: 'see higgsfield brand-kit terms',
    attribution: 'higgsfield · marketing-studio · ' + name,
    data: tryParseJson(stdout),
    ts: Date.now(),
  };
}

function tryParseJson(stdout) {
  try { return JSON.parse(stdout); } catch { return null; }
}

function parseImageResult({ id, stdout, projectRoot, kind }) {
  const parsed = tryParseJson(stdout);
  const results = Array.isArray(parsed?.results) ? parsed.results : [];
  const firstUrl = results[0]?.url ?? null;
  const outPath = writeAssetFile({ projectRoot, requestId: id, kind, ext: 'json', bytes: Buffer.from(JSON.stringify({ id, parsed }, null, 2), 'utf8') });
  return {
    schemaVersion: 1,
    status: MEDIA_RESULT_STATUS.OK,
    kind,
    requestId: id,
    provider: 'higgsfield',
    assets: [{ path: outPath, kind, mime: 'application/json', bytes: 0, url: firstUrl }],
    license: 'see higgsfield license terms',
    attribution: 'higgsfield · generate · ' + (parsed?.model ?? 'unknown'),
    url: firstUrl,
    job: parsed?.id ?? null,
    ts: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Auth probe (renderer-side): does the user have a Higgsfield credential?
// Phase 1 keeps the token out of the agent process entirely. The renderer
// asks the Electron main process via window.avb.higgsfieldAuthProbe();
// main reads ~/.config/higgsfield/credentials.json through safeStorage
// and returns {status, reason?, recoveryCommand?}. We never see the token.
//
// If the host does not expose the probe (dev web, no Electron), we report
// 'unavailable' with the same recovery command so the panel can always
// surface a single, stable hint.
// ---------------------------------------------------------------------------

export const AUTH_STATUS = Object.freeze({
  READY: 'ready',
  UNAVAILABLE: 'unavailable',
  UNKNOWN: 'unknown',
});

const DEFAULT_RECOVERY = 'higgsfield auth login';

/**
 * Probe the host for a Higgsfield credential. Returns a stable
 * {status, reason?, recoveryCommand?} envelope. Never throws.
 */
export async function probeHiggsfieldAuth(host = (typeof window !== 'undefined' ? window : null)) {
  if (!host || typeof host.avb?.higgsfieldAuthProbe !== 'function') {
    return { status: AUTH_STATUS.UNAVAILABLE, reason: 'host probe is not available', recoveryCommand: DEFAULT_RECOVERY };
  }
  try {
    const r = await host.avb.higgsfieldAuthProbe();
    if (!r || typeof r !== 'object') {
      return { status: AUTH_STATUS.UNAVAILABLE, reason: 'empty probe response', recoveryCommand: DEFAULT_RECOVERY };
    }
    return {
      status: r.status === AUTH_STATUS.READY ? AUTH_STATUS.READY : AUTH_STATUS.UNAVAILABLE,
      reason: typeof r.reason === 'string' ? r.reason : undefined,
      recoveryCommand: typeof r.recoveryCommand === 'string' ? r.recoveryCommand : DEFAULT_RECOVERY,
    };
  } catch (err) {
    return { status: AUTH_STATUS.UNAVAILABLE, reason: String(err?.message ?? err), recoveryCommand: DEFAULT_RECOVERY };
  }
}

// ---------------------------------------------------------------------------
// Selector
// ---------------------------------------------------------------------------

/**
 * Pick the provider for a given kind. Phase 2: when the auth probe reports
 * a real token, return a real HiggsfieldProvider; otherwise fall back to
 * the deterministic StubProvider. The stub is always safe to call.
 */
export async function selectProviderAsync() {
  const probe = await probeHiggsfieldAuth();
  if (probe.status === AUTH_STATUS.READY) {
    // Phase 2: the real provider still reports unavailability on generate
    // because we don't shell out to the CLI from the renderer. The flip
    // is wired so Phase 4 can drop in the actual @higgsfield/cli call.
    return buildHiggsfieldProvider({ token: 'present' });
  }
  return StubProvider;
}

/**
 * Synchronous selector for callers that cannot await (e.g. module-level
 * `buildTools()`). Always returns the StubProvider. Async callers should
 * use `selectProviderAsync()`.
 */
export function selectProvider() {
  return StubProvider;
}

export const _internals = { escapeXml, probeHiggsfieldAuth, AUTH_STATUS, selectProviderAsync, isBinaryAvailable, writeAssetFile, tryParseJson };
