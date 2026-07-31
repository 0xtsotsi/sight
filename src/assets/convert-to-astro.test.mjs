import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convertToAstro, __test__ } from './convert-to-astro.js';

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
  // Order: move → list → read → write → onFsChanged.
  const order = calls.map((c) => c[0]);
  assert.deepEqual(order, [
    'moveToSrcAssets',
    'writePage',
    'onFsChanged',
  ]);
  // Sanity: move was called once with the right args.
  assert.equal(calls[0][1].rel, 'img/hero.jpg');
  assert.equal(calls[0][1].projectPath, '/proj');
  // The fs-changed ping fires last.
  assert.equal(calls[2][0], 'onFsChanged');
});

test('convertToAstro still moves the file even if no page references it', async () => {
  const calls = [];
  globalThis.window = {
    avb: {
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
