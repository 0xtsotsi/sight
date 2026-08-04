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
import { mkdirSync, writeFileSync } from 'node:fs';

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

export function buildHiggsfieldProvider({ token, binary = 'higgsfield' } = {}) {
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('buildHiggsfieldProvider: token is required');
  }
  return Object.freeze({
    name: 'higgsfield',
    kind: 'remote',
    availability() {
      return token ? { status: PROVIDER_STATUS.READY, reason: 'higgsfield token present' } : { status: PROVIDER_STATUS.UNAVAILABLE, reason: 'no token', recoveryCommand: HIGGSFIELD_RECOVERY };
    },
    async generate(args = {}) {
      // Phase 1 stub: real implementation lives in Phase 4 alongside MCP.
      return mediaUnavailable({
        kind: args.kind,
        requestId: args.requestId,
        reason: 'HiggsfieldProvider is not yet implemented in Phase 1',
        recoveryCommand: HIGGSFIELD_RECOVERY,
      });
    },
    _binary: binary,
  });
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

export const _internals = { escapeXml, probeHiggsfieldAuth, AUTH_STATUS, selectProviderAsync };
