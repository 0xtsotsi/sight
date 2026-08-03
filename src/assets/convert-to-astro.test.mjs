import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { convertToAstro, __test__ } from './convert-to-astro.js';

// image-size is a CommonJS package; pull it through createRequire so an ESM
// test runner can still exercise it.
const require = createRequire(import.meta.url);

const { IMPORT_NAME, rewritePageWithImage } = __test__;

// --- IMPORT_NAME ----------------------------------------------------

test('IMPORT_NAME strips extension and camelCases', () => {
  assert.equal(IMPORT_NAME('hero.jpg'), 'heroJpg');
  assert.equal(IMPORT_NAME('hero-image.png'), 'heroImagePng');
  assert.equal(IMPORT_NAME('my_photo.jpg'), 'myPhotoJpg');
  assert.equal(IMPORT_NAME('banner.gif'), 'bannerGif');
});

test('IMPORT_NAME leaves already-camelCase names that already end with a format suffix', () => {
  assert.equal(IMPORT_NAME('hero.jpg'), 'heroJpg');
  assert.equal(IMPORT_NAME('icon.svg'), 'iconSvg');
});

// --- rewritePageWithImage -------------------------------------------

test('rewritePageWithImage injects an import after the frontmatter', () => {
  const before = '---\nconst a = 1;\n---\n<img src="/img/hero.jpg" />\n';
  const after = rewritePageWithImage({
    pageSource: before,
    fileName: 'hero.jpg',
    publicRel: 'img/hero.jpg',
    importName: 'heroJpg',
  });
  assert.match(after, /import heroJpg from '\.\.\/assets\/hero\.jpg';/);
  assert.match(after, /src=\{heroJpg\}/);
});

test('rewritePageWithImage does not duplicate an existing import', () => {
  const before = `---
import heroJpg from '../assets/hero.jpg';
---
<img src="/img/hero.jpg" />
`;
  const after = rewritePageWithImage({
    pageSource: before,
    fileName: 'hero.jpg',
    publicRel: 'img/hero.jpg',
    importName: 'heroJpg',
  });
  const matches = after.match(/import heroJpg from/g) || [];
  assert.equal(matches.length, 1);
});

test('rewritePageWithImage handles a raw <img> without frontmatter', () => {
  const before = '<img src="/img/foo.png">\n';
  const after = rewritePageWithImage({
    pageSource: before,
    fileName: 'foo.png',
    publicRel: 'img/foo.png',
    importName: 'fooPng',
  });
  assert.match(after, /import fooPng from '\.\.\/assets\/foo\.png';/);
  assert.match(after, /src=\{fooPng\}/);
});

// --- convertToAstro orchestration -----------------------------------

test('convertToAstro calls moveToSrcAssets, writePage, then onFsChanged, in order', async () => {
  const calls = [];
  globalThis.window = {
    avb: {
      probeImage: async (args) => {
        calls.push(['probeImage', args]);
        return { width: 1024, height: 768, mime: 'image/jpeg' };
      },
      moveToSrcAssets: async (args) => {
        calls.push(['moveToSrcAssets', args]);
        return { ok: true, destRel: 'img/hero.jpg' };
      },
      writePage: async (args) => {
        calls.push(['writePage', args]);
      },
      readPage: async ({ pagePath }) => ({
        source: '---\n---\n<img src="/img/hero.jpg" />\n',
      }),
      listPages: async () => [{ path: 'src/pages/index.astro' }],
      onFsChanged: (data) => {
        calls.push(['onFsChanged', data]);
      },
    },
  };
  await convertToAstro({
    projectPath: '/proj',
    rel: 'img/hero.jpg',
    fileName: 'hero.jpg',
  });
  // Order: probe → move → list → read → write → onFsChanged.
  const order = calls.map((c) => c[0]);
  assert.deepEqual(order, [
    'probeImage',
    'moveToSrcAssets',
    'writePage',
    'onFsChanged',
  ]);
  // Sanity: probe was called once with the right args, before move.
  const probeIdx = order.indexOf('probeImage');
  const moveIdx = order.indexOf('moveToSrcAssets');
  assert.ok(probeIdx >= 0 && moveIdx >= 0);
  assert.ok(probeIdx < moveIdx, 'probeImage must run before moveToSrcAssets');
  assert.equal(calls[probeIdx][1].rel, 'img/hero.jpg');
  assert.equal(calls[probeIdx][1].projectPath, '/proj');
  assert.equal(calls[moveIdx][1].rel, 'img/hero.jpg');
  assert.equal(calls[moveIdx][1].projectPath, '/proj');
  // The fs-changed ping fires last.
  assert.equal(calls[order.length - 1][0], 'onFsChanged');
});

test('convertToAstro still moves the file even if no page references it', async () => {
  const calls = [];
  globalThis.window = {
    avb: {
      probeImage: async (args) => {
        calls.push(['probe', args]);
      },
      moveToSrcAssets: async (args) => {
        calls.push(['move', args]);
      },
      writePage: async () => {
        calls.push(['write']);
      },
      readPage: async () => ({ source: '---\n---\n<p>nothing here</p>\n' }),
      listPages: async () => [{ path: 'src/pages/index.astro' }],
      onFsChanged: () => {
        calls.push(['fs']);
      },
    },
  };
  await convertToAstro({
    projectPath: '/proj',
    rel: 'img/orphan.jpg',
    fileName: 'orphan.jpg',
  });
  // Move happened, no writePage (no refs), fs-changed fired.
  const names = calls.map((c) => c[0]);
  assert.ok(names.includes('move'));
  assert.ok(!names.includes('write'));
  assert.equal(names[names.length - 1], 'fs');
});

// --- Bug 1: probe must run BEFORE the move -----------------------

test('convertToAstro calls probeImage BEFORE moveToSrcAssets (probe-before-move ordering)', async () => {
  const calls = [];
  globalThis.window = {
    avb: {
      // The probe and the move are both mocked to push their own tag into
      // `calls`. The test asserts that the probe tag lands strictly before
      // the move tag — which is the property the old buggy implementation
      // violated by probing AFTER the move (against the now-missing public/
      // path).
      probeImage: async (args) => {
        calls.push('probeImage');
        return { width: 800, height: 600, mime: 'image/png' };
      },
      moveToSrcAssets: async (_args) => {
        calls.push('moveToSrcAssets');
        return { ok: true, destRel: 'img/hero.png' };
      },
      writePage: async () => {
        calls.push('writePage');
      },
      readPage: async () => ({ source: '<p>noop</p>' }),
      listPages: async () => [],
      onFsChanged: () => {
        calls.push('onFsChanged');
      },
    },
  };

  const result = await convertToAstro({
    projectPath: '/proj',
    rel: 'img/hero.png',
    fileName: 'hero.png',
  });

  const probeIdx = calls.indexOf('probeImage');
  const moveIdx = calls.indexOf('moveToSrcAssets');
  assert.notEqual(probeIdx, -1, 'probeImage must be called');
  assert.notEqual(moveIdx, -1, 'moveToSrcAssets must be called');
  assert.ok(
    probeIdx < moveIdx,
    `probeImage must be called BEFORE moveToSrcAssets; got call order: ${calls.join(', ')}`
  );
  // The move can come at any index after probe; the fs-changed ping must
  // still be the last call.
  assert.equal(calls[calls.length - 1], 'onFsChanged');
  // The dims returned from the probe are surfaced to the caller.
  assert.deepEqual(result.dims, { width: 800, height: 600, mime: 'image/png' });
});

// --- Bug 2: missing listPages must be handled gracefully --------

test('convertToAstro skips the page rewrite cleanly when listPages is not exposed', async () => {
  const calls = [];
  const originalLog = console.log;
  const logLines = [];
  console.log = (line) => logLines.push(line);
  try {
    globalThis.window = {
      avb: {
        probeImage: async () => {
          calls.push('probeImage');
          return { width: 100, height: 100, mime: 'image/jpeg' };
        },
        moveToSrcAssets: async () => {
          calls.push('moveToSrcAssets');
          return { ok: true };
        },
        // No listPages — the IPC method doesn't exist on this build.
        onFsChanged: () => {
          calls.push('onFsChanged');
        },
      },
    };

    const result = await convertToAstro({
      projectPath: '/proj',
      rel: 'img/foo.jpg',
      fileName: 'foo.jpg',
    });

    // Move still happened, fs-changed still fired, no exception thrown.
    const names = calls;
    assert.ok(names.includes('moveToSrcAssets'));
    assert.ok(names.includes('onFsChanged'));
    // Exactly one explanatory log line, so the skip is visible but not noisy.
    const skipLogs = logLines.filter((l) => l.includes('listPages not exposed'));
    assert.equal(skipLogs.length, 1, 'should log exactly one skip line');
    // Default dims still returned.
    assert.deepEqual(result.dims, { width: 100, height: 100, mime: 'image/jpeg' });
  } finally {
    console.log = originalLog;
  }
});

test('convertToAstro falls back to sensible dims when probeImage is missing', async () => {
  globalThis.window = {
    avb: {
      // No probeImage at all.
      moveToSrcAssets: async () => ({ ok: true }),
      onFsChanged: () => {},
    },
  };
  const result = await convertToAstro({
    projectPath: '/proj',
    rel: 'img/x.png',
    fileName: 'x.png',
  });
  assert.deepEqual(result.dims, { width: 1200, height: 800, mime: 'image/jpeg' });
});

test('convertToAstro falls back to sensible dims when probeImage throws', async () => {
  globalThis.window = {
    avb: {
      probeImage: async () => {
        throw new Error('decode failed');
      },
      moveToSrcAssets: async () => ({ ok: true }),
      onFsChanged: () => {},
    },
  };
  const result = await convertToAstro({
    projectPath: '/proj',
    rel: 'img/x.png',
    fileName: 'x.png',
  });
  assert.deepEqual(result.dims, { width: 1200, height: 800, mime: 'image/jpeg' });
});

// --- Bug: probe returning { error } (unsupported mime) --------------------
//
// The IPC handler now catches image-size's TypeError('unsupported file type')
// and returns { error: 'unsupported' } instead of letting the exception leak
// out. convertToAstro has to treat that shape as a missing probe, not as a
// successful probe whose dims are missing — otherwise `dims` would be
// `{ error: 'unsupported' }` and the props panel would have no defaults.
test('convertToAstro falls back to sensible dims when probeImage returns { error: "unsupported" }', async () => {
  const calls = [];
  globalThis.window = {
    avb: {
      probeImage: async () => ({ error: 'unsupported' }),
      moveToSrcAssets: async () => {
        calls.push('moveToSrcAssets');
        return { ok: true };
      },
      onFsChanged: () => {
        calls.push('onFsChanged');
      },
    },
  };
  const result = await convertToAstro({
    projectPath: '/proj',
    rel: 'img/lying.png',
    fileName: 'lying.png',
  });
  // Placeholder dims — a 4:3-ish jpeg — so the props panel has a sane start.
  assert.deepEqual(result.dims, { width: 1200, height: 800, mime: 'image/jpeg' });
  // The move still ran; the unsupported extension didn't stop the flow.
  assert.ok(calls.includes('moveToSrcAssets'));
});

// --- Bug: image-size TypeError on non-image buffer ------------------------
//
// The `assets:probeImage` handler in electron/main.js wraps `imageSize` in
// try/catch: a TypeError maps to { error: 'unsupported' }, anything else
// maps to { error: <message> }. We exercise the same mapping here against
// the real `image-size` package so the contract is documented in a test —
// if image-size's error type ever changes, this fails before any
// unsupported file can crash the renderer.
test('probeImage contract: image-size throws TypeError on a non-image buffer', () => {
  const imageSize = require('image-size');
  // ASCII text with a .png extension: image-size can't parse it.
  const buf = Buffer.from('this is not actually an image\n');
  let caught;
  try {
    imageSize.imageSize(buf);
  } catch (err) {
    caught = err;
  }
  assert.ok(caught, 'imageSize should throw on a non-image buffer');
  assert.ok(
    caught instanceof TypeError,
    `expected TypeError, got ${caught?.constructor?.name}: ${caught?.message}`
  );
});
