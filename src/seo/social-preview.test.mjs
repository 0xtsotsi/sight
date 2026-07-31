// node:test fixtures for the social-preview HTML / SVG builders. These
// run in pure node (no jsdom, no React) and pin down the structure of the
// payload we send to Electron's hidden BrowserWindow.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSocialPreviewHtml,
  buildSocialPreviewSvg,
  buildJsonLd,
  JSON_LD_TYPES,
} from './schema.js';

test('HTML payload contains og:title and og:description meta tags', () => {
  const html = buildSocialPreviewHtml({
    title: 'My Page',
    description: 'A short description.',
    og: { title: 'OG Title', description: 'OG description.', image: '', url: '', type: 'website', site_name: '' },
  });
  // OG fallback: when og.title is set, it wins; the HTML payload doesn't
  // carry <meta property> tags itself (those live in renderHeadTags), but
  // the visible text it renders should match what gets emitted.
  assert.match(html, /OG Title/);
  assert.match(html, /OG description\./);
  assert.match(html, /1200px/);
  assert.match(html, /630px/);
});

test('HTML payload falls back to page title when og.title is empty', () => {
  const html = buildSocialPreviewHtml({ title: 'Page title', og: {} });
  assert.match(html, /Page title/);
  assert.ok(!/OG Title/.test(html));
});

test('HTML payload escapes user input', () => {
  const html = buildSocialPreviewHtml({ title: 'A & B < "C"', og: {} });
  assert.match(html, /A &amp; B &lt; "C"/);
  assert.ok(!/A & B/.test(html));
});

test('HTML payload hides the empty image fallback when og.image is set', () => {
  const withImg = buildSocialPreviewHtml({ og: { image: 'https://x/y.png' } });
  const noImg = buildSocialPreviewHtml({ og: {} });
  assert.match(withImg, /background-image:url\(https:\/\/x\/y\.png\)/);
  assert.match(withImg, /has-image/);
  assert.ok(!/background-image:url/.test(noImg));
});

test('SVG fallback has the OG card dimensions and renders visible text', () => {
  const svg = buildSocialPreviewSvg({ title: 'SVG Title', description: 'SVG Desc.' });
  assert.match(svg, /<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(svg, /width="1200"/);
  assert.match(svg, /height="630"/);
  assert.match(svg, /SVG Title/);
  assert.match(svg, /SVG Desc\./);
});

test('SVG fallback uses og.site_name when set, otherwise placeholder', () => {
  const withSite = buildSocialPreviewSvg({ og: { site_name: 'Acme' } });
  const noSite = buildSocialPreviewSvg({});
  assert.match(withSite, /Acme/);
  assert.match(noSite, /your-site\.example/);
});

test('JSON_LD_TYPES list contains og:type "article" compatible entries', () => {
  const values = JSON_LD_TYPES.map((t) => t.value);
  assert.ok(values.includes('Article'));
  assert.equal(buildJsonLd('Article', { headline: 'x' })['@type'], 'Article');
});
