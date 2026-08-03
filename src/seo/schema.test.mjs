// node:test fixtures for the JSON-LD builders in schema.js. These exercise
// each of the seven supported types plus the AEO list, and pin down the
// shape (no extra fields, no empty strings, stable @context/@type).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  emptySeoHead,
  normalizeSeoHead,
  buildJsonLd,
  buildAeoSchema,
  renderHeadTags,
  JSON_LD_TYPES,
} from './schema.js';

test('emptySeoHead has the canonical shape', () => {
  const e = emptySeoHead();
  assert.equal(e.title, '');
  assert.equal(e.jsonLdType, 'none');
  assert.deepEqual(e.hreflang, []);
  assert.deepEqual(e.robots, []);
  assert.equal(e.aeo.answer, '');
  assert.deepEqual(e.aeo.qa, []);
  assert.equal(e.twitter.card, 'summary');
  assert.equal(e.og.type, 'website');
});

test('normalizeSeoHead falls back to defaults for bad input', () => {
  const a = normalizeSeoHead(null);
  const b = normalizeSeoHead({ title: 42, robots: ['noindex', null, '   '] });
  const c = normalizeSeoHead({ twitter: { card: 'foo' }, og: { type: 'made-up' } });
  assert.equal(a.title, '');
  assert.equal(b.title, '42');
  assert.deepEqual(b.robots, ['noindex']);
  assert.equal(c.twitter.card, 'summary');
  assert.equal(c.og.type, 'website');
});

test('JSON_LD_TYPES lists all seven supported types plus none', () => {
  const values = JSON_LD_TYPES.map((t) => t.value);
  assert.ok(values.includes('none'));
  for (const t of ['Article', 'Product', 'FAQPage', 'BreadcrumbList', 'Organization', 'Person', 'WebSite']) {
    assert.ok(values.includes(t), `${t} missing from JSON_LD_TYPES`);
  }
});

test('buildJsonLd returns null for none and unknown types', () => {
  assert.equal(buildJsonLd('none', {}), null);
  assert.equal(buildJsonLd('Bogus', {}), null);
  assert.equal(buildJsonLd('', {}), null);
});

test('Article emits only filled fields and keeps schema.org context', () => {
  const out = buildJsonLd('Article', { headline: 'Hi', image: 'https://x/y.png' });
  assert.equal(out['@context'], 'https://schema.org');
  assert.equal(out['@type'], 'Article');
  assert.equal(out.headline, 'Hi');
  assert.equal(out.image, 'https://x/y.png');
  assert.ok(!('description' in out));
  assert.ok(!('author' in out));
  // author, when present, must be a Person node.
  const withAuthor = buildJsonLd('Article', { author: 'Ada' });
  assert.deepEqual(withAuthor.author, { '@type': 'Person', name: 'Ada' });
});

test('Product wraps price + currency in an Offer', () => {
  const out = buildJsonLd('Product', {
    name: 'Mug',
    price: '12.00',
    priceCurrency: 'USD',
    availability: 'https://schema.org/InStock',
  });
  assert.equal(out.name, 'Mug');
  assert.equal(out.offers['@type'], 'Offer');
  assert.equal(out.offers.price, '12.00');
  assert.equal(out.offers.priceCurrency, 'USD');
  assert.equal(out.offers.availability, 'https://schema.org/InStock');
});

test('FAQPage drops empty Q&A pairs', () => {
  const out = buildJsonLd('FAQPage', {
    items: [
      { question: 'A?', answer: 'Yes.' },
      { question: 'B?', answer: '' },
      { question: '', answer: 'C?' },
      null,
    ],
  });
  assert.equal(out['@type'], 'FAQPage');
  assert.equal(out.mainEntity.length, 1);
  assert.equal(out.mainEntity[0].name, 'A?');
  assert.equal(out.mainEntity[0].acceptedAnswer.text, 'Yes.');
});

test('BreadcrumbList numbers items and drops empties', () => {
  const out = buildJsonLd('BreadcrumbList', {
    items: [
      { name: 'Home', url: '/' },
      { name: 'Blog', url: '/blog' },
      { name: '', url: '' },
    ],
  });
  assert.equal(out['@type'], 'BreadcrumbList');
  assert.equal(out.itemListElement.length, 2);
  assert.equal(out.itemListElement[0].position, 1);
  assert.equal(out.itemListElement[1].position, 2);
});

test('Organization accepts newline-separated sameAs as an array', () => {
  const out = buildJsonLd('Organization', {
    name: 'Acme',
    sameAs: 'https://twitter.com/acme\nhttps://github.com/acme',
  });
  assert.deepEqual(out.sameAs, ['https://twitter.com/acme', 'https://github.com/acme']);
});

test('Person includes only filled fields', () => {
  const out = buildJsonLd('Person', { name: 'Ada', jobTitle: 'Engineer' });
  assert.equal(out['@type'], 'Person');
  assert.equal(out.name, 'Ada');
  assert.equal(out.jobTitle, 'Engineer');
  assert.ok(!('image' in out));
});

test('WebSite wraps a potentialAction when provided', () => {
  const out = buildJsonLd('WebSite', {
    name: 'Docs',
    potentialAction: 'https://docs.example.com/search?q={search_term_string}',
  });
  assert.equal(out.potentialAction['@type'], 'SearchAction');
  assert.equal(out.potentialAction.target, 'https://docs.example.com/search?q={search_term_string}');
});

test('buildAeoSchema puts the one-liner answer first, then Q&A pairs', () => {
  const aeo = buildAeoSchema({
    answer: 'A summary.',
    qa: [
      { question: 'Q1?', answer: 'A1.' },
      { question: '', answer: 'skip' },
      { question: 'Q2?', answer: 'A2.' },
    ],
  });
  assert.equal(aeo['@context'], 'https://schema.org');
  assert.equal(aeo['@type'], 'ItemList');
  assert.equal(aeo.itemListElement.length, 3);
  assert.equal(aeo.itemListElement[0].position, 1);
  assert.equal(aeo.itemListElement[0].item['@type'], 'Answer');
  assert.equal(aeo.itemListElement[1].position, 2);
  assert.equal(aeo.itemListElement[1].item['@type'], 'Question');
  assert.equal(aeo.itemListElement[1].item.name, 'Q1?');
  assert.equal(aeo.itemListElement[2].position, 3);
});

test('buildAeoSchema returns empty list when nothing is set', () => {
  const aeo = buildAeoSchema(null);
  assert.deepEqual(aeo.itemListElement, []);
});

test('renderHeadTags emits a full meta block for a populated head', () => {
  const html = renderHeadTags({
    title: 'My Page',
    description: 'A short description.',
    canonical: 'https://example.com/page',
    og: {
      title: 'OG Title',
      description: 'OG description.',
      image: 'https://example.com/og.png',
      url: 'https://example.com/page',
      type: 'article',
      site_name: 'Example',
    },
    twitter: {
      card: 'summary_large_image',
      title: 'Twitter Title',
      description: 'Twitter description.',
      image: 'https://example.com/tw.png',
    },
    jsonLdType: 'Article',
    jsonLd: { headline: 'Headline' },
    hreflang: [
      { locale: 'en', url: 'https://example.com/en/page' },
      { locale: 'fr', url: 'https://example.com/fr/page' },
    ],
    robots: ['noindex', 'nofollow'],
    favicon: '/favicon.ico',
    aeo: { answer: 'Quick.', qa: [] },
  });
  assert.match(html, /<title>My Page<\/title>/);
  assert.match(html, /<meta name="description" content="A short description\." \/>/);
  assert.match(html, /<link rel="canonical" href="https:\/\/example\.com\/page" \/>/);
  assert.match(html, /<link rel="icon" href="\/favicon\.ico" \/>/);
  assert.match(html, /<meta property="og:title" content="OG Title" \/>/);
  assert.match(html, /<meta property="og:type" content="article" \/>/);
  assert.match(html, /<meta name="twitter:card" content="summary_large_image" \/>/);
  assert.match(html, /<link rel="alternate" hreflang="en" href="https:\/\/example\.com\/en\/page" \/>/);
  assert.match(html, /<meta name="robots" content="noindex, nofollow" \/>/);
  assert.match(html, /<script type="application\/ld\+json">/);
});

test('renderHeadTags skips empty fields entirely', () => {
  const html = renderHeadTags({});
  assert.ok(!html.includes('<title>'));
  assert.ok(!html.includes('name="description"'));
  assert.ok(!html.includes('og:title'));
  assert.ok(!html.includes('application/ld+json'));
});

test('renderHeadTags HTML-escapes user input', () => {
  const html = renderHeadTags({ title: 'A & B < "C"' });
  assert.match(html, /<title>A &amp; B &lt; "C"<\/title>/);
});

test('renderHeadTags emits charset and viewport meta tags by default', () => {
  const html = renderHeadTags({ title: 'X' });
  assert.match(html, /<meta charset="utf-8" \/>/);
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1" \/>/);
});

test('renderHeadTags honors user-overridden charset and viewport', () => {
  const html = renderHeadTags({
    title: 'X',
    charset: 'iso-8859-1',
    viewport: 'width=320',
  });
  assert.match(html, /<meta charset="iso-8859-1" \/>/);
  assert.match(html, /<meta name="viewport" content="width=320" \/>/);
});

test('renderHeadTags escapes </script> in JSON-LD payload so it cannot break out of the <script> tag', () => {
  const html = renderHeadTags({
    title: 'X',
    jsonLdType: 'Article',
    jsonLd: { headline: '</script><img src=x onerror=alert(1)>' },
  });
  // The <script> tag must close on the literal `</script>` the renderer emitted,
  // not on the user-supplied one. JSON.parse still tolerates `\/` because that's
  // a valid JSON escape for `/`.
  const scriptMatch = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  assert.ok(scriptMatch, 'JSON-LD script tag should be present');
  const body = scriptMatch[1];
  assert.ok(!body.includes('</script>'), 'JSON-LD body must not contain a literal `</script>`');
  assert.ok(body.includes('<\\/script>'), 'JSON-LD body should escape `<` as `\\/`');
  // The escaped JSON must still parse to the original payload.
  const parsed = JSON.parse(body);
  assert.equal(parsed.headline, '</script><img src=x onerror=alert(1)>');
});

test('renderHeadTags escapes </script> in AEO payload the same way', () => {
  const html = renderHeadTags({
    title: 'X',
    aeo: { answer: '</script><svg onload=alert(1)>', qa: [] },
  });
  const scripts = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  assert.ok(scripts.length >= 1);
  const aeoScript = scripts[scripts.length - 1];
  assert.ok(!aeoScript[1].includes('</script>'), 'AEO body must not contain `</script>`');
  const parsed = JSON.parse(aeoScript[1]);
  assert.equal(parsed.itemListElement[0].item.text, '</script><svg onload=alert(1)>');
});

test('renderHeadTags escapes U+2028 and U+2029 in JSON-LD payloads', () => {
  const html = renderHeadTags({
    title: 'X',
    jsonLdType: 'Article',
    jsonLd: { headline: 'line one line two line three' },
  });
  const m = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  assert.ok(m);
  // U+2028 / U+2029 are valid JSON but are illegal line terminators in JS, so
  // a <script> tag parsed as JS would break out of a string literal. We always
  // escape them so the renderer is safe whichever way the browser interprets
  // the body.
  assert.ok(!m[1].includes(' '), 'U+2028 must be escaped in JSON-LD body');
  assert.ok(!m[1].includes(' '), 'U+2029 must be escaped in JSON-LD body');
  const parsed = JSON.parse(m[1]);
  assert.equal(parsed.headline, 'line one line two line three');
});
