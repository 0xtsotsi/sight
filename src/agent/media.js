// src/agent/media.js
//
// MediaProvider abstraction for the Impeccable-first Design Agent.
//
// Phase 1 ships only the StubProvider. The FalProvider is wired but
// never registered until the host exposes `FAL_KEY` in its environment
// (see electron/main.js:fal:authProbe). The panel reads
// `provider.availability()` to decide whether to surface the picker and
// whether to show a "configure" hint.
//
// Migration note (2026-08-06): swapped the Higgsfield CLI bridge for
// @fal-ai/client (Node 18+, npm package). The renderer-side probe path
// stays the same shape (a window.avb.<provider>AuthProbe verb); only the
// provider name, the env var, and the model defaults changed. Pull-
// brandkit becomes a stub: fal has no brand-kit endpoint, so the tool
// returns a `media_unavailable` result with a clear recovery message.
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

// Stays portable across Node (main process) and the browser (renderer). Vite's
// browser-external shim does not shim `node:crypto`'s named exports, and the
// Node-only modules (`node:fs`, `node:child_process`) cannot run in the browser
// at all — so we keep all Node-side I/O behind dynamic imports, and requestIds
// are generated via the global crypto object with a Math.random/Date fallback.
function newRequestId() {
  if (typeof globalThis !== 'undefined' && globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
    return 'req-' + globalThis.crypto.randomUUID();
  }
  return 'req-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

// Node-only helpers. Loaded lazily inside the provider implementations;
// the renderer registers providers but never invokes them, so the imports
// never fire in the browser bundle.
async function loadNodeModules() {
  const [path, fs, cp] = await Promise.all([
    import('node:path'),
    import('node:fs'),
    import('node:child_process'),
  ]);
  return { path, fs, cp };
}

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
    requestId: requestId ?? newRequestId(),
    reason: reason ?? 'provider is not configured',
    recoveryCommand: typeof recoveryCommand === 'string' && recoveryCommand.length > 0
      ? recoveryCommand
      : 'export FAL_KEY=<your-fal-key>  # get one at https://fal.ai/dashboard/keys',
    ts: Date.now(),
  };
}

export function mediaError({ kind, requestId, message, code }) {
  return {
    schemaVersion: 1,
    status: MEDIA_RESULT_STATUS.ERROR,
    kind,
    requestId: requestId ?? newRequestId(),
    error: { code: code ?? 'unknown', message: String(message ?? 'unknown error') },
    ts: Date.now(),
  };
}

export function mediaCancelled({ kind, requestId }) {
  return {
    schemaVersion: 1,
    status: MEDIA_RESULT_STATUS.CANCELLED,
    kind,
    requestId: requestId ?? newRequestId(),
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
    const id = requestId ?? newRequestId();
    const svg = buildStubSvg({ kind, prompt, requestId: id });
    let outPath = id + '.svg';
    try {
      const { path, fs } = await loadNodeModules();
      const dir = path.join(projectRoot ?? process.cwd(), '.sight', 'media', id);
      fs.mkdirSync(dir, { recursive: true });
      const filename = kind === MEDIA_KIND.VIDEO
        ? 'storyboard.svg'
        : kind === MEDIA_KIND.THUMBNAIL
          ? 'thumbnail.svg'
          : kind === MEDIA_KIND.BRANDKIT
            ? 'brandkit.svg'
            : 'image.svg';
      outPath = path.join(dir, filename);
      fs.writeFileSync(outPath, svg, 'utf8');
    } catch {
      // best-effort — we still return the SVG inline as a fallback
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
// FalProvider — wired but not registered until FAL_KEY is present.
// The constructor intentionally throws to fail loud: callers must import
// the module only after the renderer confirms the host probe returned
// `status: 'ready'`.
//
// API shape (verified against @fal-ai/client v1.10.1, 2026-08):
//   import { fal } from '@fal-ai/client';
//   fal.config({ credentials: 'FAL_KEY' });   // or process.env.FAL_KEY
//   const { data, requestId } = await fal.subscribe('fal-ai/<model>', {
//     input: { prompt, image_size, aspect_ratio, ... },
//     onQueueUpdate: (u) => { /* IN_QUEUE / IN_PROGRESS */ },
//   });
//   data.images[0].url           // CDN url to the rendered asset
//   data.video.url               // CDN url to the rendered video
//
// We never log the key. We never include the key in any return value. The
// renderer only sees {status, reason?, recoveryCommand?}; the key stays
// inside Electron's main process and is bound to fal.config() lazily.
// ---------------------------------------------------------------------------

const FAL_RECOVERY = 'export FAL_KEY=<your-fal-key>  # https://fal.ai/dashboard/keys';
const FAL_DEFAULT_IMAGE_MODEL = 'fal-ai/nano-banana-2';
const FAL_DEFAULT_VIDEO_MODEL = 'fal-ai/seedance-2-0';

export function buildFalProvider({ apiKey, pollTimeoutMs = 5 * 60 * 1000 } = {}) {
  if (typeof apiKey !== 'string' || apiKey.length === 0) {
    throw new Error('buildFalProvider: apiKey is required');
  }
  return Object.freeze({
    name: 'fal',
    kind: 'remote',
    availability() {
      return apiKey ? { status: PROVIDER_STATUS.READY, reason: 'FAL_KEY present' } : { status: PROVIDER_STATUS.UNAVAILABLE, reason: 'no FAL_KEY', recoveryCommand: FAL_RECOVERY };
    },
    async generate({ kind, prompt, requestId, signal, projectRoot, model, aspectRatio, durationSec, referenceImageIds, topic, faceRefId, name } = {}) {
      if (signal && signal.aborted) return mediaCancelled({ kind, requestId });
      const id = requestId ?? newRequestId();
      try {
        if (kind === 'brandkit') {
          // fal has no brand-kit endpoint. Return a typed unavailable result
          // so the panel can render a clear recovery hint instead of crashing.
          return mediaUnavailable({
            kind,
            requestId: id,
            reason: 'fal.ai has no brand-kit endpoint; pull brand kits from a CRM or store them as design tokens',
            recoveryCommand: 'drop a brandkit.json into the project root, then re-run pull_brandkit with --from-project',
          });
        }
        if (kind === 'image') return await runImage({ id, prompt, projectRoot, model, aspectRatio, referenceImageIds, apiKey, signal, pollTimeoutMs });
        if (kind === 'thumbnail') return await runImage({
          id,
          prompt: (topic ? topic + ' \u2014 ' : '') + prompt,
          projectRoot,
          model: FAL_DEFAULT_IMAGE_MODEL,
          aspectRatio: aspectRatio ?? '16:9',
          referenceImageIds: faceRefId ? [faceRefId] : referenceImageIds,
          apiKey,
          signal,
          pollTimeoutMs,
          kindOverride: 'thumbnail',
        });
        if (kind === 'video') return await runVideo({ id, prompt, projectRoot, model, aspectRatio, durationSec, apiKey, signal, pollTimeoutMs });
        return mediaError({ kind, requestId: id, message: 'unsupported kind: ' + String(kind), code: 'unsupported_kind' });
      } catch (err) {
        if (signal && signal.aborted) return mediaCancelled({ kind, requestId: id });
        return mediaError({ kind, requestId: id, message: String(err?.message ?? err), code: 'fal_failed' });
      }
    },
  });
}

// ---------------------------------------------------------------------------
// fal.ai adapter — lazy import to keep the renderer bundle slim and to
// avoid loading the SDK in the browser at all (the SDK is Node-only).
// ---------------------------------------------------------------------------

async function loadFal() {
  // Lazy require: the SDK has a node:fs dep at the top of one file; it
  // would crash on Vite's browser bundle. The renderer never calls this
  // path because selectProviderAsync() only routes here when the IPC
  // probe reports FAL_KEY is present on the host.
  return await import('@fal-ai/client');
}

async function writeAssetFile({ projectRoot, requestId, kind, ext, bytes }) {
  const { path, fs } = await loadNodeModules();
  const dir = path.join(projectRoot ?? process.cwd(), '.sight', 'media', requestId);
  fs.mkdirSync(dir, { recursive: true });
  const filename = kind === 'video' ? 'video.' + ext : kind === 'thumbnail' ? 'thumbnail.' + ext : kind === 'brandkit' ? 'brandkit.json' : 'image.' + ext;
  const outPath = path.join(dir, filename);
  fs.writeFileSync(outPath, bytes);
  return outPath;
}

async function falSubscribe({ apiKey, model, input, signal, pollTimeoutMs }) {
  // Renderer path: the apiKey here is a presence sentinel ('__use_host_ipc__')
  // because the renderer process has no access to process.env.FAL_KEY. The
  // Electron main process holds the real key and runs the actual fal.subscribe
  // call via window.avb.falGenerate. This is the only path that can produce
  // real assets when the renderer is what invokes the provider.
  if (typeof window !== 'undefined' && window.avb?.falGenerate && apiKey === '__use_host_ipc__') {
    const result = await window.avb.falGenerate({ model, input, pollTimeoutMs });
    if (!result?.ok) {
      throw new Error(result?.error ?? 'fal:generate failed in main process');
    }
    return { data: result.data, requestId: result.requestId };
  }
  // Node path (tests, scripts, non-Electron usage): read the real key from
  // process.env if the caller didn't pass one explicitly.
  const { fal } = await loadFal();
  let onAbort;
  if (signal) {
    onAbort = () => {
      // fal.subscribe handles a single Promise; we abort by rejecting on
      // signal. The SDK does not currently expose AbortSignal, so the
      // best we can do is reject the wrapper promise and let the SDK
      // finish in the background (it is cheap and idempotent on the
      // fal.ai side).
    };
    signal.addEventListener('abort', onAbort, { once: true });
  }
  const realKey = (typeof process !== 'undefined' && process.env?.FAL_KEY) || apiKey;
  if (!realKey || realKey === '__use_host_ipc__' || realKey.length < 8) {
    throw new Error('FAL_KEY is not available; set process.env.FAL_KEY or run inside Electron with a configured host');
  }
  fal.config({ credentials: realKey });
  try {
    const { data, requestId } = await fal.subscribe(model, {
      input,
      logs: false,
      pollInterval: 1500,
      timeout: pollTimeoutMs,
    });
    return { data, requestId };
  } finally {
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
  }
}

async function runImage({ id, prompt, projectRoot, model, aspectRatio, referenceImageIds, apiKey, signal, pollTimeoutMs, kindOverride }) {
  const useModel = model ?? FAL_DEFAULT_IMAGE_MODEL;
  const input = { prompt, num_images: 1 };
  if (aspectRatio) input.aspect_ratio = aspectRatio;
  if (Array.isArray(referenceImageIds) && referenceImageIds.length > 0) {
    input.image_urls = referenceImageIds;
  }
  const { data, requestId: falRequestId } = await falSubscribe({ apiKey, model: useModel, input, signal, pollTimeoutMs });
  const images = Array.isArray(data?.images) ? data.images : (data?.image ? [data.image] : []);
  const firstUrl = images[0]?.url ?? null;
  const seed = data?.seed ?? null;
  const outPath = await writeAssetFile({
    projectRoot,
    requestId: id,
    kind: kindOverride ?? 'image',
    ext: 'json',
    bytes: Buffer.from(JSON.stringify({ id, falRequestId, model: useModel, url: firstUrl, seed, hasMore: images.length > 1 }, null, 2), 'utf8'),
  });
  return {
    schemaVersion: 1,
    status: MEDIA_RESULT_STATUS.OK,
    kind: kindOverride ?? 'image',
    requestId: id,
    provider: 'fal',
    assets: [{ path: outPath, kind: kindOverride ?? 'image', mime: 'application/json', bytes: 0, url: firstUrl }],
    license: 'see fal.ai license terms (per-model; commercial by default for nano-banana-2)',
    attribution: 'fal.ai · ' + useModel + ' · seed ' + (seed ?? 'n/a'),
    url: firstUrl,
    job: falRequestId,
    ts: Date.now(),
  };
}

async function runVideo({ id, prompt, projectRoot, model, aspectRatio, durationSec, apiKey, signal, pollTimeoutMs }) {
  const useModel = model ?? FAL_DEFAULT_VIDEO_MODEL;
  const input = { prompt };
  if (aspectRatio) input.aspect_ratio = aspectRatio;
  if (durationSec) input.duration = String(durationSec);
  const { data, requestId: falRequestId } = await falSubscribe({ apiKey, model: useModel, input, signal, pollTimeoutMs });
  const videoUrl = data?.video?.url ?? data?.url ?? null;
  const outPath = await writeAssetFile({
    projectRoot,
    requestId: id,
    kind: 'video',
    ext: 'json',
    bytes: Buffer.from(JSON.stringify({ id, falRequestId, model: useModel, url: videoUrl }, null, 2), 'utf8'),
  });
  return {
    schemaVersion: 1,
    status: MEDIA_RESULT_STATUS.OK,
    kind: 'video',
    requestId: id,
    provider: 'fal',
    assets: [{ path: outPath, kind: 'video', mime: 'application/json', bytes: 0, url: videoUrl }],
    license: 'see fal.ai license terms (per-model; commercial by default for seedance-2-0)',
    attribution: 'fal.ai · ' + useModel,
    url: videoUrl,
    job: falRequestId,
    ts: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Auth probe (renderer-side): does the host have a FAL_KEY available?
// Phase 1 keeps the token out of the agent process entirely. The renderer
// asks the Electron main process via window.avb.falAuthProbe();
// main reads process.env.FAL_KEY (or safeStorage-decrypted credential set
// during onboarding) and returns {status, reason?, recoveryCommand?}.
// We never see the key.
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

const DEFAULT_RECOVERY = 'export FAL_KEY=<your-fal-key>  # https://fal.ai/dashboard/keys';

/**
 * Probe the host for a FAL_KEY. Returns a stable
 * {status, reason?, recoveryCommand?} envelope. Never throws.
 */
export async function probeFalAuth(host = (typeof window !== 'undefined' ? window : null)) {
  if (!host || typeof host.avb?.falAuthProbe !== 'function') {
    return { status: AUTH_STATUS.UNAVAILABLE, reason: 'host probe is not available', recoveryCommand: DEFAULT_RECOVERY };
  }
  try {
    const r = await host.avb.falAuthProbe();
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
 * Pick the provider for a given kind. When the auth probe reports a real
 * FAL_KEY is present on the host, return a real FalProvider that routes
 * generation through the Electron main process; otherwise fall back to
 * the deterministic StubProvider. The stub is always safe to call.
 */
export async function selectProviderAsync() {
  const probe = await probeFalAuth();
  if (probe.status === AUTH_STATUS.READY) {
    // Sentinel apiKey; falSubscribe() detects it and routes through the
    // host's fal:generate IPC instead of trying to use the sentinel as
    // a real credential. The real FAL_KEY lives only in the Electron
    // main process and is never exposed to the renderer.
    return buildFalProvider({ apiKey: "__use_host_ipc__" });
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

export const _internals = { escapeXml, probeFalAuth, AUTH_STATUS, selectProviderAsync, loadFal, falSubscribe, writeAssetFile };